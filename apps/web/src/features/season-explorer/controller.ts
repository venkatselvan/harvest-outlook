import { ApiError, type RuntimeMode } from "../../lib/api";
import { getCropEvidence } from "../../lib/catalogue-api";
import * as planApi from "../../lib/plan-api";
import { newEntryId } from "../photo-region/http";
import { normalizedUrl, type MediaInfo } from "../photo-region/types";
import type { EvidenceCitation } from "../comparison/types";
import { clampDate, dateToPos, indexTimeline, indexWater, posToDate, recordAt, addDaysIso, dateToDap, todayInKolkata, type TimelineIndex, type WaterIndex } from "./model";
import { outputsOf, type PlanOutputs, type PlanTaskOutput, type PlanView, type Scenario, type TimelineDay, type VisualsView } from "../../lib/plan-api";

/** Network surface of the explorer. Injected so tests can count calls; defaults to the real client. */
export interface SeasonApi {
  getPlan: typeof planApi.getPlan;
  getTimeline: typeof planApi.getTimeline;
  getVisuals: typeof planApi.getVisuals;
  getJob: typeof planApi.getJob;
  listFarmMedia: typeof planApi.listFarmMedia;
  startVisuals: typeof planApi.startVisuals;
  getCropEvidence: (cropId: string) => Promise<EvidenceCitation[]>;
}
export const realSeasonApi: SeasonApi = {
  getPlan: planApi.getPlan,
  getTimeline: planApi.getTimeline,
  getVisuals: planApi.getVisuals,
  getJob: planApi.getJob,
  listFarmMedia: planApi.listFarmMedia,
  startVisuals: planApi.startVisuals,
  getCropEvidence: (id) => getCropEvidence(id),
};

export interface HistoryItem {
  planId: string;
  createdAt: string;
  summary: PlanOutputs["change_summary"] | null;
}

export interface GenerateState {
  status: "idle" | "working" | "done" | "error";
  message: string | null;
  /** Server-given reason the stages are schematic (for example synthetic_mode). */
  reasons: string[];
}

export interface SeasonState {
  status: "idle" | "loading" | "ready" | "error";
  error: { code: string; message: string } | null;
  mode: RuntimeMode | null;
  warnings: string[];
  plan: PlanView | null;
  outputs: PlanOutputs;
  plantingDate: string | null;
  tasksById: ReadonlyMap<string, PlanTaskOutput>;
  stageNames: ReadonlyMap<string, string>;
  scenario: Scenario;
  scenarioLoading: boolean;
  timelines: Partial<Record<Scenario, TimelineIndex>>;
  waterIndex: Partial<Record<Scenario, WaterIndex>>;
  selectedDate: string | null;
  today: string;
  visuals: VisualsView | null;
  media: MediaInfo | null;
  generate: GenerateState;
  history: { status: "idle" | "loading" | "ready" | "error"; items: HistoryItem[] };
  citations: { status: "idle" | "loading" | "ready" | "error"; byId: ReadonlyMap<string, EvidenceCitation> };
}

export const SCHEMATIC_REASON_TEXT: Record<string, string> = {
  synthetic_mode: "Synthetic mode: no image provider is called, so simple labelled schematic drawings are shown instead of generated pictures.",
  replay_mode: "Replay mode: no image provider is called, so simple labelled schematic drawings are shown.",
  provider_unavailable: "The image provider is not available right now, so labelled schematic drawings are shown. Try again later.",
  no_brief: "No illustration brief exists for this stage, so a labelled schematic drawing is shown.",
};

const emptyState = (today: string, scenario: Scenario): SeasonState => ({
  status: "idle",
  error: null,
  mode: null,
  warnings: [],
  plan: null,
  outputs: {},
  plantingDate: null,
  tasksById: new Map(),
  stageNames: new Map(),
  scenario,
  scenarioLoading: false,
  timelines: {},
  waterIndex: {},
  selectedDate: null,
  today,
  visuals: null,
  media: null,
  generate: { status: "idle", message: null, reasons: [] },
  history: { status: "idle", items: [] },
  citations: { status: "idle", byId: new Map() },
});

const errInfo = (e: unknown): { code: string; message: string } =>
  e instanceof ApiError ? { code: e.code, message: e.message } : { code: "unexpected", message: "Something unexpected went wrong." };

export interface ControllerOptions {
  api?: SeasonApi;
  now?: () => Date;
  scenario?: Scenario;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
}

/**
 * Framework-free controller for the plan screen. State changes go through `set`, which notifies subscribers (the Solid
 * view wraps this in a signal). `select` and `selectDap` are purely local: no network, no image work.
 */
export class SeasonController {
  private state: SeasonState;
  private readonly api: SeasonApi;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly maxPolls: number;
  private listeners = new Set<(s: SeasonState) => void>();
  private disposed = false;

  constructor(readonly planId: string, o: ControllerOptions = {}) {
    this.api = o.api ?? realSeasonApi;
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollMs = o.pollMs ?? 1000;
    this.maxPolls = o.maxPolls ?? 90;
    this.state = emptyState(todayInKolkata(this.now()), o.scenario ?? "early");
  }

  get snapshot(): SeasonState {
    return this.state;
  }
  subscribe(fn: (s: SeasonState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
  private set(patch: Partial<SeasonState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  // ---- derived, O(1) per call
  get index(): TimelineIndex | null {
    return this.state.timelines[this.state.scenario] ?? null;
  }
  get record(): TimelineDay | null {
    const ix = this.index;
    const d = this.state.selectedDate;
    return ix && d ? recordAt(ix, d) : null;
  }
  get waterIdx(): WaterIndex | null {
    return this.state.waterIndex[this.state.scenario] ?? null;
  }

  // ---- loading (plan + one timeline + visuals; none of these run again on slider movement)
  async load(): Promise<void> {
    this.set({ status: "loading", error: null });
    try {
      const [plan, tl] = await Promise.all([this.api.getPlan(this.planId), this.api.getTimeline(this.planId, this.state.scenario)]);
      const outputs = outputsOf(plan.data);
      const plantingDate = outputs.stage_windows?.plantingDate ?? null;
      if (!plantingDate) throw new ApiError("plan_incomplete", "This plan has no stage windows, so a season timeline cannot be shown.", 0);
      const ix = indexTimeline(tl.data, plantingDate);
      const today = todayInKolkata(this.now());
      const water = outputs.water?.byTiming[this.state.scenario]?.runs;
      this.set({
        status: "ready",
        mode: plan.mode,
        warnings: [...plan.warnings, ...tl.warnings],
        plan: plan.data,
        outputs,
        plantingDate,
        tasksById: new Map((outputs.tasks?.tasks ?? []).map((t) => [t.task.id, t])),
        stageNames: new Map((outputs.stage_windows?.stages ?? []).map((s) => [s.stageId, s.name])),
        timelines: { [this.state.scenario]: ix },
        waterIndex: { [this.state.scenario]: indexWater(water) },
        today,
        selectedDate: today >= ix.from && today <= ix.to ? today : ix.from,
      });
    } catch (e) {
      this.set({ status: "error", error: errInfo(e) });
      return;
    }
    // Visuals and the base photo are best-effort: their failure never blocks the plan.
    await Promise.all([this.refreshVisuals(), this.loadMedia()]);
  }

  async loadMedia(): Promise<void> {
    const plan = this.state.plan;
    if (!plan) return;
    try {
      const media = await this.api.listFarmMedia(plan.snapshot.farmId);
      this.set({ media: media.find((m) => m.region) ?? media[0] ?? null });
    } catch {
      this.set({ media: null });
    }
  }

  async refreshVisuals(): Promise<VisualsView | null> {
    try {
      const v = await this.api.getVisuals(this.planId);
      this.set({ visuals: v.data });
      return v.data;
    } catch {
      return null;
    }
  }

  // ---- selection (local only)
  select(date: string): void {
    const ix = this.index;
    if (!ix) return;
    const d = clampDate(ix, date);
    if (d !== this.state.selectedDate) this.set({ selectedDate: d });
  }
  selectDap(dap: number): void {
    if (this.state.plantingDate) this.select(addDaysIso(this.state.plantingDate, dap));
  }
  selectPos(pos: number): void {
    const ix = this.index;
    if (ix) this.select(posToDate(ix, pos));
  }
  step(days: number): void {
    const ix = this.index;
    const d = this.state.selectedDate;
    if (ix && d) this.select(posToDate(ix, dateToPos(ix, d) + days));
  }
  get dap(): number | null {
    return this.state.plantingDate && this.state.selectedDate ? dateToDap(this.state.plantingDate, this.state.selectedDate) : null;
  }

  /** Scenario switch: the other timeline is fetched once on first use, then switched locally. */
  async setScenario(s: Scenario): Promise<void> {
    if (s === this.state.scenario) return;
    if (!this.state.timelines[s]) {
      this.set({ scenarioLoading: true });
      try {
        const tl = await this.api.getTimeline(this.planId, s);
        const ix = indexTimeline(tl.data, this.state.plantingDate!);
        this.set({
          timelines: { ...this.state.timelines, [s]: ix },
          waterIndex: { ...this.state.waterIndex, [s]: indexWater(this.state.outputs.water?.byTiming[s]?.runs) },
        });
      } catch (e) {
        this.set({ scenarioLoading: false, error: errInfo(e) });
        return;
      }
    }
    const ix = this.state.timelines[s]!;
    this.set({ scenario: s, scenarioLoading: false, selectedDate: this.state.selectedDate ? clampDate(ix, this.state.selectedDate) : ix.from });
  }

  // ---- illustrations
  async generateIllustrations(): Promise<void> {
    const media = this.state.media;
    if (!media || !media.region) {
      this.set({ generate: { status: "error", message: "Add a farm photo and confirm the planting region on the farm page first.", reasons: [] } });
      return;
    }
    this.set({ generate: { status: "working", message: "Requesting illustrations…", reasons: [] } });
    try {
      const start = await this.api.startVisuals(this.planId, media.id, media.region.version, newEntryId("visuals"));
      const jobId = start.data.jobId;
      if (jobId) {
        let state = start.data.state;
        for (let n = 0; n < this.maxPolls && state !== "succeeded" && state !== "failed" && state !== "cancelled"; n++) {
          this.set({ generate: { status: "working", message: `Illustrations are being prepared (${state})…`, reasons: [] } });
          await this.sleep(this.pollMs);
          if (this.disposed) return;
          state = (await this.api.getJob(jobId)).data.state;
        }
        if (state === "failed" || state === "cancelled") {
          await this.refreshVisuals();
          this.set({ generate: { status: "error", message: "Illustrations could not be generated. Your plan, tasks and economics are unaffected; schematic drawings are shown.", reasons: [] } });
          return;
        }
        if (state !== "succeeded") {
          this.set({ generate: { status: "error", message: "Illustrations are taking longer than expected. Check again in a moment.", reasons: [] } });
          return;
        }
      }
      const v = await this.refreshVisuals();
      const reasons = [...new Set((v?.stages ?? []).filter((s) => s.state !== "ready").map((s) => s.asset?.reason).filter((r): r is string => !!r))];
      const anySchematic = (v?.stages ?? []).some((s) => s.state !== "ready");
      this.set({
        generate: {
          status: "done",
          message: anySchematic ? "Schematic drawings are shown for stages without a generated image." : "Illustrations are ready. They are illustrative, not predictions.",
          reasons,
        },
      });
    } catch (e) {
      this.set({ generate: { status: "error", message: `Could not request illustrations: ${errInfo(e).message}`, reasons: [] } });
    }
  }

  // ---- lazy panels
  async loadHistory(): Promise<void> {
    if (this.state.history.status === "loading" || this.state.history.status === "ready") return;
    this.set({ history: { status: "loading", items: [] } });
    try {
      const items: HistoryItem[] = [];
      let id: string | null = this.planId;
      let view = this.state.plan;
      for (let n = 0; n < 12 && id; n++) {
        if (!view || view.snapshot.id !== id) view = (await this.api.getPlan(id)).data;
        items.push({ planId: view.snapshot.id, createdAt: view.snapshot.createdAt, summary: outputsOf(view).change_summary ?? null });
        id = view.snapshot.parentId;
      }
      this.set({ history: { status: "ready", items } });
    } catch {
      this.set({ history: { status: "error", items: [] } });
    }
  }

  async loadCitations(): Promise<void> {
    const plan = this.state.plan;
    if (!plan || this.state.citations.status === "loading" || this.state.citations.status === "ready") return;
    this.set({ citations: { status: "loading", byId: new Map() } });
    try {
      const ev = await this.api.getCropEvidence(plan.snapshot.cropId);
      this.set({ citations: { status: "ready", byId: new Map(ev.map((e) => [e.id, e])) } });
    } catch {
      this.set({ citations: { status: "error", byId: new Map() } });
    }
  }
}
