import {
  CurrentMandiQuotes as currentMandiQuotesSchema,
  type CurrentMandiQuotes,
} from "@harvest/contracts";
import {
  PlanningReview as planningReviewSchema,
  type PlanningReview,
} from "@harvest/contracts";
import { getOwnerScope } from "../features/offline/scope";
import {
  createContext,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { apiRequest, jsonInit } from "../features/photo-region/http";
import type { Farm } from "../routes/farm/types";
import { listCrops } from "../lib/catalogue-api";
import type { PriceReference } from "../features/comparison/types";
export type Boundary = { type: "Polygon"; coordinates: number[][][] };
export interface Cycle {
  id: string;
  cropId: string;
  cropName?: string;
  sowingDate: string;
  establishmentDate?: string;
  establishmentMethod?: string;
  productId?: string;
  productName?: string;
  stage: "sowed" | "growing" | "flowering" | "harvested";
  harvestDate?: string;
  notes?: string;
}
export interface Rotation {
  id: string;
  year: number;
  season: string;
  cropId: string;
  cropName?: string;
  productId?: string;
  productName?: string;
  plannedSowingDate?: string;
  plannedHarvestDate?: string;
  notes?: string;
}
export interface Workspace {
  farmId: string;
  version: number;
  updatedAt: string | null;
  boundary: Boundary | null;
  previousHarvest:
    | { status: "none" | "unknown" }
    | {
        status: "known";
        cropId: string;
        cropName?: string;
        harvestDate: string;
      };
  cycles: Cycle[];
  rotationPlans: Rotation[];
}
export interface Monitor {
  checkedAt: string;
  weather: {
    status: string;
    reason: string | null;
    issuedAt: string | null;
    attribution: string;
    point: { lat: number; lon: number } | null;
    days: {
      date: string;
      rainMm: number | null;
      tMinC: number | null;
      tMaxC: number | null;
      et0Mm: number | null;
    }[];
  };
  market: {
    status: string;
    reason: string | null;
    products: { productId: string; reference: PriceReference }[];
  };
  meta: { status: string; reason: string | null; automatic: boolean };
}
export type GeoFarm = Farm & {
  location: Farm["location"] & { lat?: number | null; lon?: number | null };
};
function model() {
  const [sessionEpoch, setSessionEpoch] = createSignal(0);
  const [farms, { refetch: refreshFarms, mutate: setFarms }] = createResource(
    sessionEpoch,
    async (epoch) => {
      const data = (await apiRequest<{ farms: GeoFarm[] }>("/api/v1/farms"))
        .data!.farms;
      return epoch === sessionEpoch() ? data : [];
    },
  );
  const [selected, setSelected] = createSignal(
    (() => {
      try {
        return localStorage.getItem("ho.selectedFarm") ?? "";
      } catch {
        return "";
      }
    })(),
  );
  const farm = () => farms()?.find((f) => f.id === selected()) ?? farms()?.[0];
  const [workspace, { refetch: refreshWorkspace, mutate: setWorkspace }] =
    createResource(
      () => farm()?.id,
      async (id) => {
        const epoch = sessionEpoch();
        const next = (
          await apiRequest<Workspace>(`/api/v1/farms/${id}/workspace`)
        ).data!;
        return epoch === sessionEpoch() && farm()?.id === id ? next : undefined;
      },
    );
  const [monitor, { refetch: refreshMonitor, mutate: setMonitor }] =
    createResource(
      () => farm()?.id,
      async (id) => {
        const epoch = sessionEpoch();
        const next = (
          await apiRequest<Monitor>(`/api/v1/farms/${id}/monitoring`)
        ).data!;
        return epoch === sessionEpoch() && farm()?.id === id ? next : undefined;
      },
    );
  let quoteRequest = 0;
  const ensuredQuoteContexts = new Set<string>();
  const [marketSnapshot, { mutate: setMarketSnapshot }] = createResource(
    () => farm()?.id,
    async (
      id,
    ): Promise<{ farmId: string; quotes: CurrentMandiQuotes } | undefined> => {
      const epoch = sessionEpoch();
      const request = quoteRequest;
      const data = (
        await apiRequest<CurrentMandiQuotes>(
          `/api/v1/farms/${id}/market-quotes`,
        )
      ).data;
      const parsed = currentMandiQuotesSchema.safeParse(data);
      if (epoch !== sessionEpoch() || farm()?.id !== id) return undefined;
      if (request !== quoteRequest)
        return !marketSnapshot.error && marketSnapshot.latest?.farmId === id
          ? marketSnapshot.latest
          : undefined;
      return parsed.success ? { farmId: id, quotes: parsed.data } : undefined;
    },
  );
  const [quoteBusyFarm, setQuoteBusyFarm] = createSignal<string | null>(null);
  const [quoteRequestError, setQuoteRequestError] = createSignal("");
  const currentMarket = () =>
    !marketSnapshot.error && marketSnapshot()?.farmId === farm()?.id
      ? marketSnapshot()?.quotes
      : undefined;
  const currentMarketBusy = () => quoteBusyFarm() === farm()?.id;
  const currentMarketError = () =>
    quoteRequestError() || (marketSnapshot.error as Error | undefined)?.message;
  async function refreshCurrentMarket(productIds?: string[]) {
    const target = farm()?.id;
    const epoch = sessionEpoch();
    if (!target) return;
    const request = ++quoteRequest;
    setQuoteBusyFarm(target);
    setQuoteRequestError("");
    try {
      const data = (
        await apiRequest<CurrentMandiQuotes>(
          `/api/v1/farms/${target}/market-quotes`,
          jsonInit("POST", {
            ...(productIds?.length
              ? { productIds: productIds.slice(0, 3) }
              : {}),
          }),
        )
      ).data;
      const parsed = currentMandiQuotesSchema.safeParse(data);
      if (!parsed.success)
        throw new Error(
          "The mandi service did not return a valid quote response.",
        );
      if (
        request === quoteRequest &&
        epoch === sessionEpoch() &&
        farm()?.id === target
      )
        setMarketSnapshot({ farmId: target, quotes: parsed.data });
    } catch (error) {
      if (
        request === quoteRequest &&
        epoch === sessionEpoch() &&
        farm()?.id === target
      )
        setQuoteRequestError((error as Error).message);
      throw error;
    } finally {
      if (request === quoteRequest) setQuoteBusyFarm(null);
    }
  }
  async function ensureCurrentMarket(productIds?: string[]) {
    const target = farm()?.id;
    if (!target) return;
    const key = JSON.stringify({
      target,
      epoch: sessionEpoch(),
      products: productIds ? [...productIds].sort() : null,
      review: planningReview()?.reviewId,
      recommended: planningReview()?.comparisonShortlist.map(
        (p) => p.productId,
      ),
      workspace: workspace()?.version,
    });
    if (ensuredQuoteContexts.has(key)) return;
    ensuredQuoteContexts.add(key);
    try {
      await refreshCurrentMarket(productIds);
    } catch {
      /* The explicit quote error remains visible and can be retried. */
    }
  }
  createEffect(onMarketFarm);
  function onMarketFarm() {
    farm()?.id;
    setQuoteRequestError("");
  }
  const [crops] = createResource(() => listCrops());
  const setupStorageKey = () => `ho.planningSetup.${getOwnerScope()}`;
  const [deferredPlanning, setDeferredPlanning] = createSignal<Set<string>>(
    (() => {
      try {
        const ids = JSON.parse(localStorage.getItem(setupStorageKey()) ?? "[]");
        return new Set<string>(
          Array.isArray(ids)
            ? ids.filter((id: unknown) => typeof id === "string")
            : [],
        );
      } catch {
        return new Set<string>();
      }
    })(),
  );
  createEffect(() => {
    try {
      localStorage.setItem(
        setupStorageKey(),
        JSON.stringify([...deferredPlanning()]),
      );
    } catch {}
  });
  const ensuredPlanningContexts = new Set<string>();
  const planningSetupPending = () =>
    !!farm()?.id && deferredPlanning().has(farm()!.id);
  const reviewContextKey = (f: GeoFarm, w: Workspace, epoch: number) =>
    JSON.stringify({
      farmId: f.id,
      epoch,
      location: f.location,
      facts: Object.fromEntries(
        Object.entries(f.facts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, fact]) => [
            key,
            {
              value: fact.value,
              unit: fact.unit,
              basis: fact.basis,
              confirmed: fact.confirmed,
            },
          ]),
      ),
      boundary: w.boundary,
      previousHarvest: w.previousHarvest,
      cycles: w.cycles,
      rotationPlans: w.rotationPlans,
    });
  const planningKey = () => {
    const f = farm();
    const w = workspace();
    if (
      !f ||
      workspace.loading ||
      !w ||
      w.farmId !== f.id ||
      planningSetupPending()
    )
      return false;
    return reviewContextKey(f, w, sessionEpoch());
  };
  async function readReview(farmId: string, method: "GET" | "POST" = "GET") {
    const data = (
      await apiRequest<PlanningReview>(
        `/api/v1/farms/${farmId}/planning-review`,
        method === "POST" ? jsonInit("POST", {}) : undefined,
      )
    ).data!;
    const parsed = planningReviewSchema.safeParse(data);
    if (!parsed.success)
      throw new Error(
        "Evara's planning review is not available from the server yet.",
      );
    return parsed.data;
  }
  const [planningState, { refetch: refetchPlanning, mutate: mutatePlanning }] =
    createResource(planningKey, async (key) => {
      const target = farm()!.id;
      const epoch = sessionEpoch();
      let review = await readReview(target);
      if (
        epoch !== sessionEpoch() ||
        farm()?.id !== target ||
        planningKey() !== key
      )
        return undefined;
      if (!ensuredPlanningContexts.has(key)) {
        ensuredPlanningContexts.add(key);
        if (
          review.stale ||
          !["ready", "partial", "pending", "running"].includes(review.status)
        )
          review = await readReview(target, "POST");
      }
      return epoch === sessionEpoch() &&
        farm()?.id === target &&
        planningKey() === key
        ? { farmId: target, key, review }
        : undefined;
    });
  const planningReview = () =>
    !planningState.error &&
    planningState()?.farmId === farm()?.id &&
    planningState()?.key === planningKey()
      ? planningState()?.review
      : undefined;
  const planningLoading = () => planningState.loading;
  const planningError = () => planningState.error as Error | undefined;
  createEffect(() => {
    const review = planningReview();
    if (review && ["pending", "running"].includes(review.status)) {
      const timer = setTimeout(() => void refetchPlanning(), 1200);
      onCleanup(() => clearTimeout(timer));
    }
  });
  const deferPlanningReview = (id: string) =>
    setDeferredPlanning((current) => new Set([...current, id]));
  const finishFarmSetup = (id: string) =>
    setDeferredPlanning((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  async function refreshPlanningReview() {
    const target = farm()?.id;
    const epoch = sessionEpoch();
    const key = planningKey();
    if (!target || !key || planningSetupPending()) return;
    const review = await readReview(target, "POST");
    if (
      epoch === sessionEpoch() &&
      farm()?.id === target &&
      planningKey() === key
    )
      mutatePlanning({ farmId: target, key, review });
  }
  const [applyingPlanningFarm, setApplyingPlanningFarm] = createSignal<
    string | null
  >(null);
  const applyingPlanning = () =>
    !!farm()?.id && applyingPlanningFarm() === farm()?.id;
  async function applyPlanningReview(proposalIds: string[]) {
    const target = farm()?.id;
    const epoch = sessionEpoch();
    const w = workspace();
    const review = planningReview();
    if (
      !target ||
      workspace.loading ||
      planningLoading() ||
      !w ||
      w.farmId !== target ||
      !review?.reviewId ||
      review.stale
    )
      throw new Error(
        "Wait for this farm's review and saved seasons to finish loading.",
      );
    if (applyingPlanning() || saving())
      throw new Error("Please wait for the current save to finish.");
    setApplyingPlanningFarm(target);
    try {
      const result = (
        await apiRequest<{ workspace: Workspace; review: PlanningReview }>(
          `/api/v1/farms/${target}/planning-review/apply`,
          jsonInit("POST", {
            reviewId: review.reviewId,
            proposalIds,
            expectedWorkspaceVersion: w.version,
          }),
        )
      ).data!;
      if (
        epoch === sessionEpoch() &&
        farm()?.id === target &&
        result.workspace.farmId === target
      ) {
        ensuredPlanningContexts.add(
          reviewContextKey(farm()!, result.workspace, epoch),
        );
        setWorkspace(result.workspace);
        mutatePlanning({
          farmId: target,
          key: reviewContextKey(farm()!, result.workspace, epoch),
          review: result.review,
        });
        void refreshFarms();
        setNotice(
          "Selected proposals added to your rotation. Your existing seasons are kept.",
        );
      }
      return result;
    } finally {
      if (epoch === sessionEpoch() && farm()?.id === target)
        setApplyingPlanningFarm(null);
    }
  }
  interface CompareSelection {
    productIds: string[];
    date: string;
    manualProducts: boolean;
    manualDate: boolean;
  }
  const compareStorageKey = (id: string) =>
    `ho.compare.${getOwnerScope()}.${id}`;
  function loadCompareSelection(id: string): CompareSelection | null {
    try {
      const data = JSON.parse(
        sessionStorage.getItem(compareStorageKey(id)) ?? "null",
      );
      return data &&
        Array.isArray(data.productIds) &&
        typeof data.date === "string"
        ? data
        : null;
    } catch {
      return null;
    }
  }
  function rememberCompareSelection(id: string, value: CompareSelection) {
    try {
      sessionStorage.setItem(compareStorageKey(id), JSON.stringify(value));
    } catch {}
  }

  const [savingFarm, setSavingFarm] = createSignal<string | null>(null);
  const saving = () => !!farm()?.id && savingFarm() === farm()?.id;
  let saveRequest = 0;
  const [notice, setNotice] = createSignal("");
  createEffect(() => {
    if (farm())
      try {
        localStorage.setItem("ho.selectedFarm", farm()!.id);
      } catch {}
  });
  const selectFarm = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem("ho.selectedFarm", id);
    } catch {}
  };
  const sessionEnded = () => {
    ++saveRequest;
    setSessionEpoch((epoch) => epoch + 1);
    setFarms([]);
    setSelected("");
    setWorkspace(undefined);
    setMonitor(undefined);
    ++quoteRequest;
    setMarketSnapshot(undefined);
    setQuoteBusyFarm(null);
    setQuoteRequestError("");
    ensuredQuoteContexts.clear();
    setSavingFarm(null);
    setDeferredPlanning(new Set<string>());
    ensuredPlanningContexts.clear();
    mutatePlanning(undefined);
    setApplyingPlanningFarm(null);
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("ho.compare.")) sessionStorage.removeItem(key);
      for (const key of Object.keys(localStorage))
        if (key.startsWith("ho.planningSetup.")) localStorage.removeItem(key);
    } catch {}
    setNotice("");
    try {
      localStorage.removeItem("ho.selectedFarm");
    } catch {}
  };
  window.addEventListener("ho:session-ended", sessionEnded);
  onCleanup(() => window.removeEventListener("ho:session-ended", sessionEnded));
  async function saveWorkspace(
    patch: Partial<
      Pick<
        Workspace,
        "boundary" | "previousHarvest" | "cycles" | "rotationPlans"
      >
    >,
  ) {
    const target = farm()?.id;
    const w = workspace();
    const epoch = sessionEpoch();
    if (!target || workspace.loading || !w || w.farmId !== target)
      throw new Error("Farm details are still loading. Please try again.");
    if (saving())
      throw new Error("Please wait for the current save to finish.");
    const request = ++saveRequest;
    setSavingFarm(target);
    try {
      const next = (
        await apiRequest<Workspace>(
          `/api/v1/farms/${target}/workspace`,
          jsonInit("PUT", {
            expectedVersion: w.version,
            boundary: w.boundary,
            previousHarvest: w.previousHarvest,
            cycles: w.cycles,
            rotationPlans: w.rotationPlans,
            ...patch,
          }),
        )
      ).data!;
      if (
        epoch === sessionEpoch() &&
        farm()?.id === target &&
        request === saveRequest &&
        next.farmId === target
      ) {
        setWorkspace(next);
        void refreshFarms();
      }
      return next;
    } finally {
      if (request === saveRequest) setSavingFarm(null);
    }
  }
  const cropName = (id: string) =>
    crops()?.find((c) => c.cropId === id)?.name ?? id.replace(/_/g, " ");
  return {
    farms,
    refreshFarms,
    setFarms,
    selected,
    selectFarm,
    farm,
    workspace,
    refreshWorkspace,
    monitor,
    refreshMonitor,
    crops,
    currentMarket,
    currentMarketBusy,
    currentMarketError,
    refreshCurrentMarket,
    ensureCurrentMarket,
    cropName,
    saveWorkspace,
    saving,
    notice,
    setNotice,
    sessionEpoch,
    planningReview,
    planningLoading,
    planningError,
    planningSetupPending,
    refreshPlanningReview,
    applyPlanningReview,
    applyingPlanning,
    deferPlanningReview,
    finishFarmSetup,
    loadCompareSelection,
    rememberCompareSelection,
  };
}
type Model = ReturnType<typeof model>;
const Context = createContext<Model>();
export function WorkspaceProvider(props: ParentProps) {
  const state = model();
  return <Context.Provider value={state}>{props.children}</Context.Provider>;
}
export function useWorkspace() {
  const c = useContext(Context);
  if (!c) throw new Error("Workspace provider missing");
  return c;
}
export function dateLabel(date: string) {
  return new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function boundaryArea(boundary: Boundary | null) {
  if (!boundary) return 0;
  const r = boundary.coordinates[0]!;
  let area = 0;
  for (let i = 0; i < r.length - 1; i++) {
    const a = r[i]!,
      b = r[i + 1]!;
    area +=
      (((b[0]! - a[0]!) * Math.PI) / 180) *
      (2 +
        Math.sin((a[1]! * Math.PI) / 180) +
        Math.sin((b[1]! * Math.PI) / 180));
  }
  return Math.abs((area * 6378137 * 6378137) / 2) / 10000;
}
