import type { PoolClient } from "pg";
import type { Config } from "../config";
import { withTransaction, type Pool } from "../db/pool";
import { ApiError } from "./errors";
import { estimateCost, fromMicro, loadPriceTable, toMicro, type CostEstimate, type PriceTable, type UsageEstimateInput } from "./pricing";

export type BudgetLimit = "session" | "owner_day" | "global";

export interface ReserveInput {
  ownerId: string | null;
  sessionId: string | null;
  provider: string;
  model: string;
  /** Worst-case USD for the call; 0 for speech (tracked in units, not USD). */
  estimate: number;
  requestId?: string;
  jobId?: string;
}

export interface BudgetSummary {
  currency: "USD";
  devAllocationUsd: number;
  remainingDevUsd: number;
  demoReserveUsd: number;
  exhausted: boolean;
}

interface StateRow {
  total_usd: string;
  dev_allocation_usd: string;
  demo_reserve_usd: string;
  reserved_usd: string;
  settled_usd: string;
}

export class Budget {
  readonly prices: PriceTable;
  constructor(
    private readonly pool: Pool,
    private readonly limits: { totalUsd: number; devAllocationUsd: number; demoReserveUsd: number; perSessionUsd: number; perOwnerDayUsd: number },
    prices?: PriceTable,
  ) {
    this.prices = prices ?? loadPriceTable();
  }

  static fromConfig(pool: Pool, c: Config): Budget {
    return new Budget(
      pool,
      {
        totalUsd: c.BUDGET_TOTAL_USD,
        devAllocationUsd: c.BUDGET_DEV_ALLOCATION_USD,
        demoReserveUsd: c.BUDGET_DEMO_RESERVE_USD,
        perSessionUsd: c.BUDGET_PER_SESSION_USD,
        perOwnerDayUsd: c.BUDGET_PER_OWNER_DAY_USD,
      },
      loadPriceTable(c.PRICE_TABLE_JSON),
    );
  }

  /**
   * Config is the source of truth for limits: seeds the row when empty and re-syncs the limit
   * columns on every start, never touching reserved/settled counters. There is no public endpoint.
   */
  async init(): Promise<void> {
    await this.pool.query(
      `INSERT INTO budget_state (id, total_usd, dev_allocation_usd, demo_reserve_usd) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET total_usd = EXCLUDED.total_usd,
         dev_allocation_usd = EXCLUDED.dev_allocation_usd, demo_reserve_usd = EXCLUDED.demo_reserve_usd`,
      [this.limits.totalUsd, this.limits.devAllocationUsd, this.limits.demoReserveUsd],
    );
  }

  estimate(provider: string, model: string, usage: UsageEstimateInput): CostEstimate {
    return estimateCost(this.prices, provider, model, usage);
  }

  private async lockState(c: PoolClient): Promise<StateRow> {
    const q = () => c.query<StateRow>("SELECT * FROM budget_state WHERE id = 1 FOR UPDATE");
    let r = await q();
    if (!r.rows[0]) {
      await c.query(
        "INSERT INTO budget_state (id, total_usd, dev_allocation_usd, demo_reserve_usd) VALUES (1,$1,$2,$3) ON CONFLICT (id) DO NOTHING",
        [this.limits.totalUsd, this.limits.devAllocationUsd, this.limits.demoReserveUsd],
      );
      r = await q();
    }
    return r.rows[0]!;
  }

  /**
   * Atomic reservation. The budget_state row lock serialises all reservations, so concurrent
   * callers cannot jointly exceed any limit.
   */
  async reserve(input: ReserveInput): Promise<{ reservationId: string; estimateUsd: number }> {
    if (!Number.isFinite(input.estimate) || input.estimate < 0) throw new ApiError(500, "invalid_estimate", "Estimate must be a non-negative number");
    const est = toMicro(input.estimate);
    return withTransaction(this.pool, async (c) => {
      const st = await this.lockState(c);
      if (input.sessionId) {
        const r = await c.query<{ s: string }>(`SELECT ${SPEND_SQL} AS s FROM usage_reservations WHERE session_id = $1`, [input.sessionId]);
        if (toMicro(r.rows[0]!.s) + est > toMicro(this.limits.perSessionUsd)) throw this.exceeded("session");
      }
      if (input.ownerId) {
        const r = await c.query<{ s: string }>(
          `SELECT ${SPEND_SQL} AS s FROM usage_reservations
           WHERE owner_id = $1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
          [input.ownerId],
        );
        if (toMicro(r.rows[0]!.s) + est > toMicro(this.limits.perOwnerDayUsd)) throw this.exceeded("owner_day");
      }
      if (toMicro(st.reserved_usd) + toMicro(st.settled_usd) + est > toMicro(st.dev_allocation_usd)) throw this.exceeded("global");
      const ins = await c.query<{ id: string }>(
        `INSERT INTO usage_reservations (owner_id, session_id, job_id, request_id, provider, model, estimated_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.ownerId, input.sessionId, input.jobId ?? null, input.requestId ?? null, input.provider, input.model, fromMicro(est)],
      );
      await c.query("UPDATE budget_state SET reserved_usd = reserved_usd + $1::numeric WHERE id = 1", [fromMicro(est)]);
      return { reservationId: ins.rows[0]!.id, estimateUsd: est / 1_000_000 };
    });
  }

  private exceeded(limit: BudgetLimit): ApiError {
    const label = { session: "per-session", owner_day: "per-owner daily", global: "global development" }[limit];
    return new ApiError(429, "budget_exceeded", `The ${label} spending limit would be exceeded`, { limit });
  }

  private async load(c: PoolClient, id: string) {
    const r = await c.query<{ id: string; owner_id: string | null; provider: string; model: string | null; request_id: string | null; estimated_usd: string; state: string }>(
      "SELECT id, owner_id, provider, model, request_id, estimated_usd, state FROM usage_reservations WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!r.rows[0]) throw new ApiError(404, "reservation_not_found", "Reservation not found");
    return r.rows[0];
  }

  /** Moves the estimate from reserved to settled at the actual cost and writes the ledger row. */
  async settle(
    reservationId: string,
    actualUsd: number,
    providerRequestId: string | null,
    usage: unknown = {},
    costBasis: "estimated" | "billed" = "estimated",
  ): Promise<void> {
    if (!Number.isFinite(actualUsd) || actualUsd < 0) throw new ApiError(500, "invalid_actual", "Actual cost must be a non-negative number");
    await withTransaction(this.pool, async (c) => {
      await this.lockState(c); // lock order: budget_state, then reservation
      const r = await this.load(c, reservationId);
      if (r.state === "settled") return;
      if (r.state === "released") throw new ApiError(409, "reservation_state_conflict", "Reservation already released");
      const actual = fromMicro(toMicro(actualUsd));
      await c.query(
        "UPDATE usage_reservations SET state='settled', settled_usd=$2, provider_request_id=$3 WHERE id=$1",
        [reservationId, actual, providerRequestId],
      );
      await c.query("UPDATE budget_state SET reserved_usd = reserved_usd - $1::numeric, settled_usd = settled_usd + $2::numeric WHERE id = 1", [
        r.estimated_usd,
        actual,
      ]);
      await c.query(
        `INSERT INTO usage_ledger (owner_id, reservation_id, request_id, provider_request_id, provider, model, estimated_usd, settled_usd, cost_basis, usage)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [r.owner_id, reservationId, r.request_id, providerRequestId, r.provider, r.model, r.estimated_usd, actual, costBasis, JSON.stringify(usage ?? {})],
      );
    });
  }

  /** Provider call failed definitively with no charge: give the estimate back. */
  async release(reservationId: string): Promise<void> {
    await withTransaction(this.pool, async (c) => {
      await this.lockState(c);
      const r = await this.load(c, reservationId);
      if (r.state === "released") return;
      if (r.state === "settled") throw new ApiError(409, "reservation_state_conflict", "Reservation already settled");
      await c.query("UPDATE usage_reservations SET state='released' WHERE id=$1", [reservationId]);
      await c.query("UPDATE budget_state SET reserved_usd = reserved_usd - $1::numeric WHERE id = 1", [r.estimated_usd]);
    });
  }

  /** Provider outcome unknown: keep the estimate reserved until it can be checked. */
  async markUncertain(reservationId: string): Promise<void> {
    await withTransaction(this.pool, async (c) => {
      await this.lockState(c);
      const r = await this.load(c, reservationId);
      if (r.state === "uncertain") return;
      if (r.state !== "reserved") throw new ApiError(409, "reservation_state_conflict", `Reservation is ${r.state}`);
      await c.query("UPDATE usage_reservations SET state='uncertain' WHERE id=$1", [reservationId]);
    });
  }

  async summary(): Promise<BudgetSummary | null> {
    const r = await this.pool.query<StateRow>("SELECT * FROM budget_state WHERE id = 1");
    const s = r.rows[0];
    if (!s) return null;
    const dev = toMicro(s.dev_allocation_usd);
    const remaining = Math.max(0, dev - toMicro(s.reserved_usd) - toMicro(s.settled_usd));
    return {
      currency: "USD",
      devAllocationUsd: dev / 1_000_000,
      remainingDevUsd: remaining / 1_000_000,
      demoReserveUsd: toMicro(s.demo_reserve_usd) / 1_000_000,
      exhausted: remaining === 0,
    };
  }
}

/** Spend counted against per-session/per-owner limits: settled actual, else the live estimate. */
const SPEND_SQL = `COALESCE(SUM(CASE state WHEN 'settled' THEN COALESCE(settled_usd, estimated_usd) WHEN 'released' THEN 0 ELSE estimated_usd END), 0)`;
