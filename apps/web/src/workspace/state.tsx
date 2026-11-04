import {
  CurrentMandiQuotes as currentMandiQuotesSchema,
  type CurrentMandiQuotes,
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
  /** 2026-11-03: the field the crop grows on; absent = a farm-wide cycle (FIELDS_MULTICROP_SOIL_SPEC.md 2.1). */
  fieldId?: string;
  /** 2026-11-03: the companion crop of an intercrop. */
  companion?: {
    systemId?: string;
    cropId: string;
    cropName?: string;
    productId?: string;
    productName?: string;
    rowRatio: string;
  };
}
/** A named field inside the farm boundary (contracts `FarmField`). */
export interface Field {
  id: string;
  name: string;
  boundary: Boundary;
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
  /** Round 3 (ROUND3_SPEC.md section 8): sole crop, green manure or intercrop; the companion of an intercrop season. */
  kind?: "crop" | "green_manure" | "intercrop";
  establishmentMethod?: string;
  companion?: {
    systemId?: string;
    cropId: string;
    cropName?: string;
    productId?: string;
    productName?: string;
    rowRatio: string;
  };
  /** 2026-11-03: the field this season is planned for; absent = the whole farm. */
  fieldId?: string;
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
  /** 2026-11-03: fields inside the farm in drawn order; older servers omit it (read as none). */
  fields?: Field[];
  /** 2026-11-03: the farmer's farm-wide field check interval in days (3 to 30); absent = the default. */
  checkIntervalDays?: number;
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
  // A failed Solid resource throws when read; keep shared chrome mounted so its error/retry UI can render.
  const farm = () => farms.error ? undefined : farms()?.find((f) => f.id === selected()) ?? farms()?.[0];
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
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("ho.compare.")) sessionStorage.removeItem(key);
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
        | "boundary"
        | "previousHarvest"
        | "cycles"
        | "rotationPlans"
        | "fields"
        | "checkIntervalDays"
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
            // `fields` is sent only when the patch carries it: an omitted list leaves the stored fields unchanged.
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
