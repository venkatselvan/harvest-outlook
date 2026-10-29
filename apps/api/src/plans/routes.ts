import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { Assumption, Id, IsoDateTime, NamedInput, PlanSnapshot, Sha256Hex, StageDefinition, VersionRef } from "@harvest/contracts";
import type { Config } from "../config";
import { envelope } from "../envelope";
import { envelopeSchema, uuidParam } from "../routes/schemas/common";
import { parseIdempotencyKey } from "../services/idempotency";
import type { PlanService } from "./engine";
import { regionDate } from "./weather";
import type { IdempotencyHook } from "./sources";
import { OUTPUT_KINDS, PlanChange, PlanParameters, TimelineQuery } from "./types";

export interface PlanRouteDeps {
  config: Config;
  service: PlanService;
  /** Returns the authenticated owner id from the session cookie (T04: `requireAuth(req).ownerId`). Never read from the body. */
  resolveOwner: (req: FastifyRequest) => string | Promise<string>;
  /** Optional auth/CSRF guard for this plugin's routes (T04: `privateRouteGuard(config, pool)`). */
  onRequest?: onRequestHookHandler;
  /** Idempotency storage for POST /plans (T04: `{ run: (o, e) => runIdempotent(pool, o, e) }`). Without it the key is validated but not stored. */
  idempotency?: IdempotencyHook;
}

export const CreatePlanBody = z
  .object({
    farmId: z.uuid(),
    cropId: Id,
    productId: Id,
    confirmedInputs: z.array(NamedInput).max(100),
    assumptions: z.array(Assumption).max(100).default([]),
    ruleVersions: z.array(VersionRef).max(200).default([]),
    stageDefinitions: z.array(StageDefinition).min(1).max(100),
    parameters: PlanParameters,
    /** Required in replay mode. Defaults to `<mode>:unpinned:<date>` otherwise until the data pipeline exposes snapshots. */
    sourceSnapshotId: Id.optional(),
    /** Replay only. */
    decisionCutoff: IsoDateTime.optional(),
  })
  .strict();

export const RevisePlanBody = z
  .object({ expectedParentContentHash: Sha256Hex, changes: z.array(PlanChange).min(1).max(20) })
  .strict();

const outputRef = z.object({
  id: z.string(),
  kind: z.enum(OUTPUT_KINDS),
  planId: z.string(),
  methodVersion: z.string().nullable(),
  contentHash: z.string(),
  output: z.unknown(),
});
export const PlanViewSchema = z.object({
  snapshot: PlanSnapshot,
  outputs: z.array(outputRef),
  lineage: z.object({ parentId: z.string().nullable(), childIds: z.array(z.string()) }),
  deduplicated: z.boolean(),
});

const nullableNum = z.number().nullable();
export const TimelineDaySchema = z.object({
  calendarDate: z.string(),
  daysAfterPlanting: z.number().int(),
  markers: z.object({ planting: z.boolean(), asOf: z.boolean(), past: z.boolean() }),
  expectedStage: z
    .object({
      stageId: z.string(),
      occurrence: z.number().int(),
      window: z.object({ start: z.string(), end: z.string() }),
      inferred: z.literal(true),
      basis: z.enum(["calendar_estimate", "observed_stage_override"]),
      possibleStageIds: z.array(z.string()),
    })
    .nullable(),
  tasks: z.object({
    due: z.array(z.string()),
    overdue: z.array(z.string()),
    done: z.array(z.string()),
    conditionFlags: z.array(
      z.object({ taskId: z.string(), rainMm: z.number(), weatherState: z.enum(["observed", "forecast"]), thresholdMm: z.number(), thresholdAssumptionId: z.string() }),
    ),
  }),
  weather: z.object({
    state: z.enum(["observed", "forecast", "scenario", "unavailable"]),
    values: z.object({ rainMm: nullableNum, et0Mm: nullableNum, tMaxC: nullableNum, tMinC: nullableNum }).nullable(),
    issuedAt: z.string().nullable(),
    horizonDays: nullableNum,
    assumptionId: z.string().nullable(),
    sourceId: z.string().nullable(),
    missingReason: z.string().nullable(),
  }),
  water: z.object({ state: z.enum(["derived", "scenario", "unavailable"]), outputId: z.string().nullable(), missingReason: z.string().nullable() }),
  outlook: z.object({
    state: z.enum(["forecast", "farmer_reported", "unavailable"]),
    harvestPeriodId: z.string().nullable(),
    artifactId: z.string().nullable(),
    issuedAt: z.string().nullable(),
    missingReason: z.string().nullable(),
  }),
  visual: z.object({ assetId: z.string().nullable(), state: z.enum(["observed_photo", "illustrative", "schematic", "none"]) }),
  evidenceRefs: z.array(z.string()),
});
export const TimelineViewSchema = z.object({
  planId: z.string(),
  planContentHash: z.string(),
  scenarioId: z.enum(["early", "late"]),
  dataVersion: z.string(),
  asOfDate: z.string(),
  cached: z.boolean(),
  range: z.object({ from: z.string(), to: z.string() }),
  days: z.array(TimelineDaySchema),
});

/** Registers the plan routes in their own encapsulated context. Not wired into server.ts here. */
export async function registerPlanRoutes(app: FastifyInstance, deps: PlanRouteDeps): Promise<void> {
  await app.register(async (scope) => {
    if (deps.onRequest) scope.addHook("onRequest", deps.onRequest);
    const r = scope.withTypeProvider<ZodTypeProvider>();
    const mode = deps.config.RUNTIME_MODE;

    r.post(
      "/api/v1/plans",
      {
        schema: {
          tags: ["plans"],
          description:
            "Creates an immutable plan snapshot and its computed outputs. Mode is server-derived; ownerId comes from the session. Identical inputs return the existing snapshot. Supports Idempotency-Key.",
          body: CreatePlanBody,
          response: { 201: envelopeSchema(PlanViewSchema), 200: envelopeSchema(PlanViewSchema) },
        },
      },
      async (req, reply) => {
        const ownerId = await deps.resolveOwner(req);
        const key = parseIdempotencyKey(req.headers["idempotency-key"]);
        const exec = async () => {
          const b = req.body;
          const view = await deps.service.createPlan({
            ownerId,
            mode,
            farmId: b.farmId,
            cropId: b.cropId,
            productId: b.productId,
            confirmedInputs: b.confirmedInputs,
            assumptions: b.assumptions,
            ruleVersions: b.ruleVersions,
            stageDefinitions: b.stageDefinitions,
            parameters: b.parameters,
            sourceSnapshotId: b.sourceSnapshotId ?? `${mode}:unpinned:${regionDate(new Date())}`,
            decisionCutoff: b.decisionCutoff ?? null,
          });
          return { status: view.deduplicated ? 200 : 201, body: envelope(req.id, mode, view, view.deduplicated ? ["deduplicated_existing_plan"] : []) };
        };
        const out = deps.idempotency ? await deps.idempotency.run({ ownerId, key, route: "POST /api/v1/plans", hashInput: req.body }, exec) : { ...(await exec()), replay: false };
        if (out.replay) reply.header("idempotent-replay", "true");
        return reply.code(out.status as 201).send(out.body as never);
      },
    );

    r.get(
      "/api/v1/plans/:id",
      {
        schema: {
          tags: ["plans"],
          description: "Owner-scoped saved snapshot with all supporting outputs. Other owners' plans are 404.",
          params: uuidParam,
          response: { 200: envelopeSchema(PlanViewSchema) },
        },
      },
      async (req) => envelope(req.id, mode, await deps.service.getPlan(await deps.resolveOwner(req), req.params.id)),
    );

    r.post(
      "/api/v1/plans/:id/revisions",
      {
        schema: {
          tags: ["plans"],
          description:
            "Creates a revision from typed, user-confirmed changes. expectedParentContentHash must match the plan and the plan must be the latest version (409 version_conflict otherwise). The old plan and outputs stay readable.",
          params: uuidParam,
          body: RevisePlanBody,
          response: { 201: envelopeSchema(PlanViewSchema), 200: envelopeSchema(PlanViewSchema) },
        },
      },
      async (req, reply) => {
        const view = await deps.service.revisePlan({
          ownerId: await deps.resolveOwner(req),
          planId: req.params.id,
          expectedParentContentHash: req.body.expectedParentContentHash,
          changes: req.body.changes,
        });
        return reply.code(view.deduplicated ? 200 : 201).send(envelope(req.id, mode, view, view.deduplicated ? ["deduplicated_existing_plan"] : []) as never);
      },
    );

    r.get(
      "/api/v1/plans/:id/timeline",
      {
        schema: {
          tags: ["plans"],
          description:
            "Date-indexed stages, tasks, weather horizon, water, outlook and visual map. Computed once per (plan, scenario, data version) and cached; from/to slice the cached season.",
          params: uuidParam,
          querystring: TimelineQuery,
          response: { 200: envelopeSchema(TimelineViewSchema) },
        },
      },
      async (req) => envelope(req.id, mode, await deps.service.getTimeline(await deps.resolveOwner(req), req.params.id, req.query)),
    );
  });
}
