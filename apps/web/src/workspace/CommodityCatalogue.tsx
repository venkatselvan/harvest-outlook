import {
  CommodityCatalogue as catalogueSchema,
  ResearchedCropProfile as profileSchema,
  type PricedCommodity,
  type ResearchedCropProfile,
} from "@harvest/contracts";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { apiRequest } from "../features/photo-region/http";
import type { CompareItem } from "../features/comparison/types";
import { PageHeading } from "./FarmPage";
import { useWorkspace, dateLabel, today } from "./state";
import { Icon } from "./icons";
import { loadYearPlan } from "./year/yearPlanApi";
import { loadCropFit, pollCropFit } from "./farm/cropFitApi";
import { farmCropRows, type LibraryRow } from "./farm/cropFitLibrary";
import { CropsForYourFarm } from "./farm/CropFitCrops";
import { CHOOSE_FIELD_TO_RANK, cropFitTarget } from "./farm/cropFitTarget";
import { tabField } from "./farmTabs";
const NON_CROP = new Set([
  "livestock",
  "aquaculture",
  "animal_product",
  "non_crop",
  "fish",
  "wood",
]);
const groupName = (group: string) =>
  (
    ({
      crop: "Crop",
      crop_product: "Crop product",
      processed_crop_product: "Processed crop product",
      crop_group: "Crop group",
      identity_pending: "Identity needs review",
      livestock: "Livestock",
      aquaculture: "Aquaculture",
      animal_product: "Animal product",
      fungus_group: "Cultivated fungi",
    }) as Record<string, string>
  )[group] ?? group.replace(/_/g, " ");
const safePlantIdentity = (entry: PricedCommodity) =>
  ["crop", "crop_product"].includes(entry.grouping) &&
  !!entry.cropId &&
  !!entry.productId;
const profileLabel = (entry: PricedCommodity) =>
  entry.profileStatus === "researched"
    ? "Profile available"
    : entry.profileStatus === "not_applicable"
      ? "Not a plant profile"
      : "Profile gaps";
type Ecology = NonNullable<ResearchedCropProfile["ecocrop"]>;
const ecologicalRange = (
  low: number | null | undefined,
  high: number | null | undefined,
  unit = "",
) =>
  low === null || low === undefined
    ? high === null || high === undefined
      ? "Not reported"
      : `Lower limit unreported · ${high}${unit} upper`
    : high === null || high === undefined
      ? `${low}${unit} lower · upper limit unreported`
      : `${low}–${high}${unit}`;
function ecologicalRows(p: Ecology["parameters"]) {
  return [
    {
      name: "Temperature",
      preferred: ecologicalRange(
        p.temperatureC.optimalMin,
        p.temperatureC.optimalMax,
        " °C",
      ),
      outer: ecologicalRange(
        p.temperatureC.absoluteMin,
        p.temperatureC.absoluteMax,
        " °C",
      ),
    },
    {
      name: "Annual rainfall",
      preferred: ecologicalRange(
        p.annualRainfallMm.optimalMin,
        p.annualRainfallMm.optimalMax,
        " mm / year",
      ),
      outer: ecologicalRange(
        p.annualRainfallMm.absoluteMin,
        p.annualRainfallMm.absoluteMax,
        " mm / year",
      ),
    },
    {
      name: "Soil pH · method unspecified",
      preferred: ecologicalRange(p.soilPh.optimalMin, p.soilPh.optimalMax),
      outer: ecologicalRange(p.soilPh.absoluteMin, p.soilPh.absoluteMax),
    },
    ...(
      ["soilTexture", "soilDepth", "soilSalinity", "soilDrainage"] as const
    ).map((key) => ({
      name: {
        soilTexture: "Soil texture",
        soilDepth: "Soil depth",
        soilSalinity: "Salinity category · extract unspecified",
        soilDrainage: "Soil drainage",
      }[key],
      preferred: p[key].optimal ?? "Not reported",
      outer: p[key].absolute ?? "Not reported",
    })),
  ];
}
function regionalValue(value: unknown): string {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) return value.map(regionalValue).join(" – ");
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${regionalValue(v)}`)
      .join("; ");
  return "Not reported";
}
function regionalScope(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return record.scope &&
    typeof record.scope === "object" &&
    !Array.isArray(record.scope)
    ? (record.scope as Record<string, unknown>)
    : {};
}
export function CommodityCataloguePage() {
  const s = useWorkspace();
  const navigate = useNavigate();
  function compare(entry: PricedCommodity) {
    const id = s.farm()?.id;
    if (!id || !entry.productId) return;
    const saved = s.loadCompareSelection(id);
    s.rememberCompareSelection(id, {
      productIds: [entry.productId],
      date: saved?.date ?? today(),
      manualProducts: true,
      manualDate: saved?.manualDate ?? false,
    });
    navigate("/explore");
  }
  return (
    <div class="workspace-page commodity-catalogue-page">
      <PageHeading
        eyebrow="MARKET IDENTITIES · SOURCE-BACKED CROP REFERENCES"
        title="Know what you’re growing."
        description="Start with the crops that suit your farm, then browse every priced commodity name returned by AGMARKNET and inspect its identity, market evidence and available crop references."
      >
        <A class="btn secondary" href="/explore">
          Compare local requirements
          <Icon name="arrow" size={16} />
        </A>
      </PageHeading>
      <CommodityBrowser full onCompareEntry={s.farm() ? compare : undefined} />
    </div>
  );
}
export function CommodityBrowser(props: {
  items?: CompareItem[];
  selected?: string[];
  onToggle?: (item: CompareItem) => void;
  full?: boolean;
  onCompareEntry?: ((entry: PricedCommodity) => void) | undefined;
}) {
  const [filter, setFilter] = createSignal("");
  const [group, setGroup] = createSignal("crops");
  const [profile, setProfile] = createSignal<PricedCommodity | null>(null);
  const [more, setMore] = createSignal<PricedCommodity[]>([]);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [moreError, setMoreError] = createSignal("");
  /** Default view is "Crops for your farm" (ROUND3_SPEC.md 5.1); the whole catalogue sits behind a button. */
  const [view, setView] = createSignal<"farm" | "catalogue">("farm");
  const ws = useWorkspace();
  let disposed = false;
  const lazy = new AbortController();
  onCleanup(() => {
    disposed = true;
    lazy.abort();
  });
  // The year plan and crop fit chips load lazily from the existing endpoints and never block or fail the page: a pending,
  // stale-free-or-not review that is not ready, or any error, simply leaves those chips off.
  // On a farm with fields both are per field (each request can enqueue a Meta job): the selected field, else the first field
  // with a current crop; with none to choose the calls are skipped and the page says so.
  const target = createMemo(
    () => cropFitTarget(ws.farm()?.id, ws.workspace(), tabField()),
    undefined,
    { equals: (a, b) => a.status === b.status && (a.status !== "rank" || (b.status === "rank" && a.fieldId === b.fieldId)) },
  );
  const rankKey = () => {
    const now = target();
    const farmId = ws.farm()?.id;
    return now.status === "rank" && farmId ? `${farmId}|${now.fieldId ?? ""}` : false;
  };
  const needsField = () => target().status === "choose";
  const [planIds] = createResource(
    rankKey,
    async (key): Promise<ReadonlySet<string> | undefined> => {
      const [farmId = "", field = ""] = key.split("|");
      try {
        const plan = await loadYearPlan(farmId, { signal: lazy.signal, fieldId: field || null });
        if (plan.status !== "ready" && plan.status !== "partial") return undefined;
        const ids = new Set<string>();
        for (const option of plan.options)
          for (const slot of option.slots) {
            if (slot.fixed) continue;
            ids.add(slot.cropId);
            if (slot.companion) ids.add(slot.companion.cropId);
          }
        return ids;
      } catch {
        return undefined;
      }
    },
  );
  const [fitRanks] = createResource(
    rankKey,
    async (key): Promise<ReadonlyMap<string, number> | undefined> => {
      const [farmId = "", field = ""] = key.split("|");
      const fieldId = field || null;
      try {
        let review = await loadCropFit(farmId, null, { signal: lazy.signal, fieldId });
        if (review.status === "pending" || review.status === "running") review = await pollCropFit(farmId, null, review, { signal: lazy.signal, maxPolls: 20, fieldId });
        if (review.status !== "ready") return undefined;
        const ranks = new Map<string, number>();
        for (const c of review.candidates) if (c.rank < (ranks.get(c.cropId) ?? Infinity)) ranks.set(c.cropId, c.rank);
        return ranks;
      } catch {
        return undefined;
      }
    },
  );
  const farmRows = () => {
    const w = ws.workspace();
    const farmId = ws.farm()?.id;
    const own = !!farmId && w?.farmId === farmId;
    return farmCropRows({
      cycles: own ? w!.cycles : undefined,
      rotationPlans: own ? w!.rotationPlans : undefined,
      previousHarvest: own ? w!.previousHarvest : undefined,
      planCropIds: farmId ? planIds() : undefined,
      fitRanks: farmId ? fitRanks() : undefined,
      nameOf: ws.cropName,
    });
  };
  const shownFarmRows = () => {
    const q = filter().trim().toLowerCase();
    return farmRows().filter((row) => !q || `${row.name} ${row.cropId}`.toLowerCase().includes(q));
  };
  const entryFor = (row: LibraryRow) => {
    const matches = entries().filter((entry) => safePlantIdentity(entry) && entry.cropId === row.cropId);
    return matches.find((entry) => entry.productId === row.productIds[0]) ?? matches[0];
  };
  const itemFor = (row: LibraryRow) => {
    const items = props.items?.filter((item) => item.cropId === row.cropId) ?? [];
    return items.find((item) => row.productIds.includes(item.productId)) ?? items[0];
  };
  const catalogueTotal = () => data()?.total ?? data()?.snapshot?.commodityCount;
  const [catalogue, { refetch: reload }] = createResource(async () => {
    const parsed = catalogueSchema.safeParse(
      (await apiRequest("/api/v1/commodities?limit=300&offset=0")).data,
    );
    if (!parsed.success)
      throw new Error("The market-wide inventory could not be read.");
    return parsed.data;
  });
  const data = () => (!catalogue.error ? catalogue() : undefined);
  const entries = () => [...(data()?.items ?? []), ...more()];
  const cropCount = () =>
    entries().filter((entry) => !NON_CROP.has(entry.grouping)).length;
  const groups = () =>
    [...new Set(entries().map((entry) => entry.grouping))].sort((a, b) =>
      groupName(a).localeCompare(groupName(b)),
    );
  const shown = () =>
    entries().filter(
      (entry) =>
        (group() === "all" ||
          (group() === "crops" && !NON_CROP.has(entry.grouping)) ||
          entry.grouping === group()) &&
        `${entry.sourceCommodity} ${entry.botanicalName ?? ""}`
          .toLowerCase()
          .includes(filter().trim().toLowerCase()),
    );
  const fallback = () =>
    props.items?.filter((item) =>
      `${item.cropName} ${item.productName}`
        .toLowerCase()
        .includes(filter().trim().toLowerCase()),
    ) ?? [];
  const compareItem = (entry: PricedCommodity) =>
    safePlantIdentity(entry)
      ? props.items?.find((item) => item.productId === entry.productId)
      : undefined;
  async function loadMore() {
    if (!data() || loadingMore()) return;
    setLoadingMore(true);
    setMoreError("");
    try {
      const parsed = catalogueSchema.parse(
        (
          await apiRequest(
            `/api/v1/commodities?limit=300&offset=${entries().length}`,
          )
        ).data,
      );
      if (!disposed)
        setMore((current) => [
          ...current,
          ...parsed.items.filter(
            (entry) =>
              !entries().some((old) => old.commodityId === entry.commodityId),
          ),
        ]);
    } catch (e) {
      if (!disposed) setMoreError((e as Error).message);
    } finally {
      if (!disposed) setLoadingMore(false);
    }
  }
  return (
    <section
      class={`crop-browser commodity-browser ${props.full ? "full" : ""}`}
      aria-label="Market-wide commodity catalogue"
    >
      <div class="section-heading">
        <h2>
          {view() === "farm"
            ? "Crops for your farm"
            : props.full
              ? "The market-wide catalogue"
              : "Crop catalogue"}
        </h2>
        <span class="count-pill">
          {view() === "farm"
            ? shownFarmRows().length
            : data()
              ? shown().length
              : (props.items?.length ?? "—")}
        </span>
      </div>
      <Show when={view() === "farm"}>
        <p class="section-description">
          The crops this app can plan for your field, the green manures, and
          any crop recorded on your farm.
          <Show when={!ws.farm()}> Add a farm to see what is growing and planned.</Show>
        </p>
        <Show when={needsField()}>
          <p class="section-description" role="status" data-testid="catalogue-choose-field">
            {CHOOSE_FIELD_TO_RANK}
          </p>
        </Show>
      </Show>
      <input
        class="crop-search"
        aria-label="Search crops"
        placeholder={
          view() === "farm"
            ? "Find a crop for your farm…"
            : "Find a commodity or botanical name…"
        }
        value={filter()}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      <Show when={view() === "farm"}>
        <CropsForYourFarm
          rows={shownFarmRows()}
          entryFor={entryFor}
          compareItem={props.onToggle ? itemFor : undefined}
          selected={props.selected}
          onToggle={props.onToggle}
          onProfile={setProfile}
        />
        <button
          class="btn secondary full-width"
          onClick={() => setView("catalogue")}
        >
          Browse the full catalogue
          {catalogueTotal() !== undefined
            ? ` (${catalogueTotal()} entries)`
            : ""}
        </button>
      </Show>
      <Show when={view() === "catalogue"}>
        <button class="text-button" onClick={() => setView("farm")}>
          Back to crops for your farm
        </button>
      <Show when={data()}>
        <label class="commodity-group-label">
          Browse
          <select
            aria-label="Commodity group"
            value={group()}
            onChange={(e) => setGroup(e.currentTarget.value)}
          >
            <option value="crops">Crop commodities ({cropCount()})</option>
            <option value="all">
              All market commodities ({data()?.total})
            </option>
            <For each={groups()}>
              {(name) => <option value={name}>{groupName(name)}</option>}
            </For>
          </select>
        </label>
        <p class="commodity-inventory-count">
          {shown().length} shown ·{" "}
          {data()?.snapshot?.commodityCount ?? data()?.total} exact source names
          in this snapshot
        </p>
        <div class="commodity-snapshot-note">
          <span class="status-dot" />
          <p>
            Saved source snapshot · retrieved{" "}
            {data()?.snapshot
              ? new Date(data()!.snapshot!.checkedAt).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "date unknown"}
            .{" "}
            <Show when={props.full}>
              <span>
                {data()?.snapshot?.complete
                  ? "Returned provider pages were traversed."
                  : "Snapshot coverage is incomplete."}{" "}
                This is not the full historical AGMARKNET universe.
              </span>
            </Show>
          </p>
        </div>
      </Show>
      <Show when={catalogue.loading}>
        <p class="small-empty" role="status">
          Loading the actual market inventory…
        </p>
      </Show>
      <Show when={catalogue.error}>
        <div class="commodity-inventory-error" role="status">
          <p>
            {(catalogue.error as Error).message} Local screening choices remain
            available below.
          </p>
          <button
            class="text-button"
            onClick={() => {
              setMore([]);
              void reload();
            }}
          >
            Reload saved inventory
          </button>
        </div>
      </Show>
      <Show
        when={data()}
        fallback={
          <For each={fallback()}>
            {(item) => (
              <button
                class={`crop-option ${props.selected?.includes(item.productId) ? "selected" : ""}`}
                onClick={() => props.onToggle?.(item)}
              >
                <span class="crop-mini-icon">
                  <Icon name="leaf" />
                </span>
                <span>
                  <strong>{item.cropName}</strong>
                  <small>{item.productName}</small>
                  <em class="unknown">Local screening entry</em>
                </span>
                <span class="crop-checkbox">
                  <Show when={props.selected?.includes(item.productId)}>
                    <Icon name="check" size={14} />
                  </Show>
                </span>
              </button>
            )}
          </For>
        }
      >
        <div class="commodity-inventory-list">
          <For each={shown()}>
            {(entry) => (
              <article
                class={`commodity-inventory-row ${entry.productId && props.selected?.includes(entry.productId) ? "selected" : ""}`}
              >
                <button
                  class={`crop-option ${entry.productId && props.selected?.includes(entry.productId) ? "selected" : ""}`}
                  onClick={() => {
                    const item = compareItem(entry);
                    if (item && props.onToggle) props.onToggle(item);
                    else setProfile(entry);
                  }}
                >
                  <span class="crop-mini-icon">
                    <Icon
                      name={NON_CROP.has(entry.grouping) ? "grid" : "leaf"}
                    />
                  </span>
                  <span>
                    <strong>{entry.sourceCommodity}</strong>
                    <small>{groupName(entry.grouping)}</small>
                    <em
                      class={
                        entry.profileStatus === "researched"
                          ? "requires_review"
                          : "unknown"
                      }
                    >
                      {profileLabel(entry)}
                    </em>
                  </span>
                  <Show when={compareItem(entry) && props.onToggle}>
                    <span class="crop-checkbox">
                      <Show
                        when={
                          entry.productId &&
                          props.selected?.includes(entry.productId)
                        }
                      >
                        <Icon name="check" size={14} />
                      </Show>
                    </span>
                  </Show>
                </button>
                <button
                  class="commodity-profile-button"
                  aria-label={`Open ${entry.sourceCommodity} profile`}
                  onClick={() => setProfile(entry)}
                >
                  Profile
                  <Icon name="arrow" size={12} />
                </button>
              </article>
            )}
          </For>
          <Show when={!shown().length}>
            <p class="small-empty">
              No source names match this search and category.
            </p>
          </Show>
        </div>
        <Show when={entries().length < (data()?.total ?? 0)}>
          <button
            class="btn secondary full-width"
            disabled={loadingMore()}
            onClick={() => void loadMore()}
          >
            {loadingMore() ? "Loading…" : "Load more stored entries"}
          </button>
        </Show>
        <Show when={moreError()}>
          <p class="inline-error" role="status">
            {moreError()}
          </p>
        </Show>
        <div class="commodity-browser-footnote">
          <p>
            Identity, profile coverage and local screening are different. A
            price alone does not make a commodity plantable or suitable for this
            farm.
          </p>
          <Show when={data()?.snapshot}>
            <a
              href={data()!.snapshot!.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              AGMARKNET source ↗
            </a>
          </Show>
          <A href="/catalogue">
            Open full catalogue
            <Icon name="arrow" size={13} />
          </A>
        </div>
      </Show>
      </Show>
      <Show when={profile()}>
        {(entry) => (
          <CommodityProfile
            entry={entry()}
            snapshot={data()?.snapshot ?? null}
            canCompare={!!props.onCompareEntry || !!compareItem(entry())}
            onCompare={() => {
              const item = compareItem(entry());
              if (item && props.onToggle) props.onToggle(item);
              else if (safePlantIdentity(entry()))
                props.onCompareEntry?.(entry());
              setProfile(null);
            }}
            onClose={() => setProfile(null)}
          />
        )}
      </Show>
    </section>
  );
}
function CommodityProfile(props: {
  entry: PricedCommodity;
  snapshot: {
    checkedAt: string;
    sourceUrl: string;
    limitations: string[];
  } | null;
  canCompare: boolean;
  onCompare: () => void;
  onClose: () => void;
}) {
  const [profile] = createResource(
    () => props.entry.profileId || false,
    async (id) =>
      profileSchema.parse(
        (
          await apiRequest(
            `/api/v1/commodity-profiles/${encodeURIComponent(id)}`,
          )
        ).data,
      ),
  );
  const data = () =>
    !profile.error && profile()?.profileId === props.entry.profileId
      ? profile()
      : undefined;
  const eco = () => data()?.ecocrop;
  const identityEvidence = () =>
    Array.isArray(data()?.identityEvidence)
      ? (data()!.identityEvidence as unknown[]).filter(
          (record): record is Record<string, unknown> =>
            !!record && typeof record === "object" && !Array.isArray(record),
        )
      : [];
  const variants = () => {
    const raw = data()?.ecocropVariants;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Record<string, unknown>;
      const reference = profileSchema.shape.ecocrop
        .unwrap()
        .safeParse(candidate.reference);
      return reference.success
        ? [
            {
              botanicalName:
                typeof candidate.botanicalName === "string"
                  ? candidate.botanicalName
                  : reference.data.sourceScientificName,
              applicability:
                typeof candidate.applicability === "string"
                  ? candidate.applicability
                  : "Species identity must be confirmed before matching.",
              reference: reference.data,
            },
          ]
        : [];
    });
  };

  const parameters = () => eco()?.parameters;
  const envelope = (
    low: number | null | undefined,
    high: number | null | undefined,
    unit = "",
  ) =>
    low === null || low === undefined
      ? high === null || high === undefined
        ? "Not reported"
        : `Lower limit unreported · ${high}${unit} upper`
      : high === null || high === undefined
        ? `${low}${unit} lower · upper limit unreported`
        : `${low}–${high}${unit}`;
  const rows = () => {
    const p = parameters();
    return p
      ? [
          {
            name: "Temperature",
            preferred: envelope(
              p.temperatureC.optimalMin,
              p.temperatureC.optimalMax,
              " °C",
            ),
            outer: envelope(
              p.temperatureC.absoluteMin,
              p.temperatureC.absoluteMax,
              " °C",
            ),
          },
          {
            name: "Annual rainfall",
            preferred: envelope(
              p.annualRainfallMm.optimalMin,
              p.annualRainfallMm.optimalMax,
              " mm / year",
            ),
            outer: envelope(
              p.annualRainfallMm.absoluteMin,
              p.annualRainfallMm.absoluteMax,
              " mm / year",
            ),
          },
          {
            name: "Soil pH · method unspecified",
            preferred: envelope(p.soilPh.optimalMin, p.soilPh.optimalMax),
            outer: envelope(p.soilPh.absoluteMin, p.soilPh.absoluteMax),
          },
          ...(
            [
              "soilTexture",
              "soilDepth",
              "soilSalinity",
              "soilDrainage",
            ] as const
          ).map((key) => ({
            name: {
              soilTexture: "Soil texture",
              soilDepth: "Soil depth",
              soilSalinity: "Salinity category · extract unspecified",
              soilDrainage: "Soil drainage",
            }[key],
            preferred: p[key].optimal ?? "Not reported",
            outer: p[key].absolute ?? "Not reported",
          })),
        ]
      : [];
  };
  const exampleString = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : "Not reported";
  return (
    <div class="modal-backdrop commodity-profile-backdrop">
      <section
        class="commodity-profile-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commodity-profile-title"
      >
        <header>
          <div>
            <p class="eyebrow">COMMODITY IDENTITY · SOURCES · OPEN GAPS</p>
            <h2 id="commodity-profile-title">{props.entry.sourceCommodity}</h2>
            <p>
              {groupName(props.entry.grouping)} · {profileLabel(props.entry)}
            </p>
          </div>
          <button
            class="icon-button"
            aria-label="Close commodity profile"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <div class="commodity-profile-body">
          <section class="commodity-identity">
            <span class="round-feature">
              <Icon
                name={NON_CROP.has(props.entry.grouping) ? "grid" : "leaf"}
                size={28}
              />
            </span>
            <div>
              <span class="eyebrow">IDENTITY REFERENCE</span>
              <h3>{props.entry.botanicalName ?? "Identity not resolved"}</h3>
              <span class="commodity-identity-state">
                {props.entry.identityStatus.replace(/_/g, " ")}
              </span>
              <p>
                {props.entry.identityNote ??
                  "The provider commodity name is retained exactly. A reviewed crop identity has not been established."}
              </p>
              <Show when={data()?.sourceCommodities.length}>
                <p class="commodity-related-names">
                  Related source names: {data()?.sourceCommodities.join(", ")}
                </p>
              </Show>
            </div>
          </section>
          <Show when={identityEvidence().length}>
            <section class="commodity-identity-evidence">
              <h3>Botanical identity evidence</h3>
              <p>
                These records document possible trade-name identities. They do
                not establish crop requirements or select a species for your
                farm.
              </p>
              <For each={identityEvidence()}>
                {(record) => (
                  <article>
                    <strong>
                      {typeof record.botanicalCandidate === "string"
                        ? record.botanicalCandidate
                        : "Identity candidate"}
                    </strong>
                    <p>{regionalValue(record.value)}</p>
                    <span class="tiny-pill">Identity not selected</span>
                    <Show when={typeof record.locator === "string"}>
                      <p>Source locator: {String(record.locator)}</p>
                    </Show>
                    <Show when={typeof record.sourceUrl === "string"}>
                      <a
                        href={String(record.sourceUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open identity source ↗
                      </a>
                    </Show>
                  </article>
                )}
              </For>
            </section>
          </Show>
          <section class="commodity-market-evidence">
            <div class="section-heading">
              <div>
                <Icon name="trend" />
                <h3>Actual market coverage</h3>
              </div>
              <span class="tiny-pill">Saved snapshot</span>
            </div>
            <div class="commodity-market-metrics">
              <div>
                <strong>
                  {props.entry.priceCoverage.validRows.toLocaleString("en-IN")}
                </strong>
                <span>positive-price rows</span>
              </div>
              <div>
                <strong>
                  {props.entry.priceCoverage.marketCount.toLocaleString(
                    "en-IN",
                  )}
                </strong>
                <span>markets represented</span>
              </div>
              <div>
                <strong>{props.entry.priceCoverage.states.length}</strong>
                <span>states represented</span>
              </div>
            </div>
            <p>
              Quote dates {dateLabel(props.entry.priceCoverage.dateRange.from)}
              {props.entry.priceCoverage.dateRange.to !==
              props.entry.priceCoverage.dateRange.from
                ? ` → ${dateLabel(props.entry.priceCoverage.dateRange.to)}`
                : ""}
              . Snapshot retrieved{" "}
              {props.snapshot
                ? new Date(props.snapshot.checkedAt).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                : "date unavailable"}
              .
            </p>
            <For each={props.entry.priceCoverage.examples.slice(0, 3)}>
              {(example) => (
                <article class="commodity-quote-example">
                  <div>
                    <strong>{exampleString(example.market)}</strong>
                    <span>
                      {[example.district, example.state]
                        .filter((v) => typeof v === "string")
                        .join(", ")}{" "}
                      ·{" "}
                      {typeof example.date === "string"
                        ? dateLabel(example.date)
                        : "Quote date unknown"}
                    </span>
                  </div>
                  <div>
                    <strong>{exampleString(example.modal)}</strong>
                    <span>source modal field · unit not declared</span>
                  </div>
                </article>
              )}
            </For>
            <p class="commodity-unit-warning">
              The source response did not declare a price unit. These raw
              example values are not converted to INR/kg or used as current
              bids.
            </p>
            <Show when={props.snapshot}>
              <a
                href={props.snapshot!.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open actual AGMARKNET source ↗
              </a>
            </Show>
          </section>
          <Show when={profile.loading}>
            <p class="commodity-profile-loading" role="status">
              Loading the retrieved crop references…
            </p>
          </Show>
          <Show when={profile.error}>
            <p class="inline-error" role="status">
              The source-backed profile could not load.{" "}
              {(profile.error as Error).message}
            </p>
          </Show>
          <Show
            when={eco()}
            fallback={
              <section class="commodity-profile-gap">
                <Icon name="journal" size={25} />
                <div>
                  <h3>
                    {props.entry.profileStatus === "not_applicable"
                      ? "No plant agronomy profile applies"
                      : variants().length
                        ? "Species references available; identity unresolved"
                        : "Crop evidence remains incomplete"}
                  </h3>
                  <p>
                    {variants().length
                      ? "Separate species references are shown below. The market name does not select a species, and none is used for farm matching."
                      : "The priced source entry is available. Crop-specific ecological or regional agronomic facts have not been populated for this identity; no generic requirement is substituted."}
                  </p>
                </div>
              </section>
            }
          >
            {(source) => (
              <section class="commodity-ecological-reference">
                <div class="section-heading">
                  <div>
                    <Icon name="leaf" />
                    <h3>Retrieved ecological reference</h3>
                  </div>
                  <span class="tiny-pill">Legacy global scope</span>
                </div>
                <div class="commodity-scope-warning">
                  <strong>
                    Broad crop ecology, separate from a local recommendation.
                  </strong>
                  <p>
                    These expert-compiled reference envelopes are not
                    measurements of your farm or evidence of suitability for a
                    particular district, cultivar or season. pH method and
                    salinity extract are unspecified.
                  </p>
                </div>
                <a href={source().sourceUrl} target="_blank" rel="noreferrer">
                  FAO EcoCrop · {source().sourceScientificName} ↗
                </a>
                <div class="commodity-reference-table-wrap">
                  <table class="commodity-reference-table">
                    <thead>
                      <tr>
                        <th>Parameter</th>
                        <th>Source “optimal” envelope</th>
                        <th>Source outer envelope</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={rows()}>
                        {(row) => (
                          <tr>
                            <th>{row.name}</th>
                            <td>{row.preferred}</td>
                            <td>{row.outer}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
                <div class="commodity-reference-notes">
                  <p>
                    <strong>Source crop-cycle range:</strong>{" "}
                    {envelope(
                      parameters()?.cropCycleDays.min,
                      parameters()?.cropCycleDays.max,
                      " days",
                    )}
                    . This is not a sourced local first-harvest calendar;
                    perennial records can describe an annual cycle.
                  </p>
                  <p>
                    <strong>Photoperiod:</strong>{" "}
                    {parameters()?.photoperiod ?? "Not reported"}
                  </p>
                  <p>
                    <strong>Light:</strong>{" "}
                    {parameters()?.light.optimalMin ?? "Not reported"} →{" "}
                    {parameters()?.light.optimalMax ?? "Not reported"} (source
                    “optimal” category).
                  </p>
                </div>
                <For each={source().qualityFlags}>
                  {(flag) => (
                    <p class="soil-review-warning">{flag.replace(/_/g, " ")}</p>
                  )}
                </For>
                <For each={source().limitations}>
                  {(line) => <p class="commodity-profile-limit">{line}</p>}
                </For>
              </section>
            )}
          </Show>
          <Show when={variants().length}>
            <section class="commodity-species-variants">
              <h3>Species-specific reference candidates</h3>
              <p>
                The market name does not resolve one botanical species. These
                references stay separate and are not selected for farm matching.
              </p>
              <For each={variants()}>
                {(variant) => (
                  <details class="commodity-species-variant">
                    <summary>
                      <strong>{variant.botanicalName}</strong>
                      <span>
                        Identity not selected · legacy global reference
                      </span>
                    </summary>
                    <p class="commodity-scope-warning">
                      {variant.applicability} pH method and salinity extract
                      remain unspecified; annual rainfall is not an irrigation
                      schedule.
                    </p>
                    <a
                      href={variant.reference.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      FAO EcoCrop · {variant.reference.sourceScientificName} ↗
                    </a>
                    <div class="commodity-reference-table-wrap">
                      <table class="commodity-reference-table">
                        <thead>
                          <tr>
                            <th>Parameter</th>
                            <th>Source “optimal” envelope</th>
                            <th>Source outer envelope</th>
                          </tr>
                        </thead>
                        <tbody>
                          <For
                            each={ecologicalRows(variant.reference.parameters)}
                          >
                            {(row) => (
                              <tr>
                                <th>{row.name}</th>
                                <td>{row.preferred}</td>
                                <td>{row.outer}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                    </div>
                    <p class="commodity-profile-limit">
                      Source crop-cycle range:{" "}
                      {ecologicalRange(
                        variant.reference.parameters.cropCycleDays.min,
                        variant.reference.parameters.cropCycleDays.max,
                        " days",
                      )}
                      . This is not a local first-harvest calendar.
                    </p>
                    <For each={variant.reference.qualityFlags}>
                      {(flag) => (
                        <p class="soil-review-warning">
                          {flag.replace(/_/g, " ")}
                        </p>
                      )}
                    </For>
                    <For each={variant.reference.limitations}>
                      {(line) => <p class="commodity-profile-limit">{line}</p>}
                    </For>
                  </details>
                )}
              </For>
            </section>
          </Show>
          <section class="commodity-regional-evidence">
            <h3>Regional evidence & missing context</h3>
            <Show
              when={data()?.regionalEvidence.length}
              fallback={
                <p>
                  No retrieved regional agronomic evidence is attached to this
                  profile. Local planting windows, cultivar durations and
                  fertilizer guidance remain unestablished here.
                </p>
              }
            >
              <For each={data()?.regionalEvidence ?? []}>
                {(record) => (
                  <article>
                    <strong>
                      {typeof record.title === "string"
                        ? record.title
                        : typeof record.parameter === "string"
                          ? record.parameter.replace(/_/g, " ")
                          : "Regional source record"}
                    </strong>
                    <p class="regional-fact-value">
                      {regionalValue(record.value)}
                      {typeof record.unit === "string"
                        ? ` · ${record.unit}`
                        : ""}
                    </p>
                    <Show
                      when={typeof regionalScope(record).geography === "string"}
                    >
                      <p class="regional-fact-scope">
                        {String(regionalScope(record).geography)}
                      </p>
                    </Show>
                    <Show
                      when={
                        typeof regionalScope(record).conditions === "string"
                      }
                    >
                      <p class="regional-fact-conditions">
                        {String(regionalScope(record).conditions)}
                      </p>
                    </Show>
                    <Show when={typeof record.locator === "string"}>
                      <p class="regional-fact-locator">
                        Source section: {String(record.locator)}
                        {typeof record.retrievedAt === "string"
                          ? ` · retrieved ${dateLabel(record.retrievedAt.slice(0, 10))}`
                          : ""}
                      </p>
                    </Show>
                    <span class="tiny-pill">
                      Published reference · not an executable recommendation
                    </span>
                    <Show when={typeof record.sourceUrl === "string"}>
                      <a
                        href={String(record.sourceUrl)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open source ↗
                      </a>
                    </Show>
                  </article>
                )}
              </For>
            </Show>
            <For each={data()?.gaps ?? []}>
              {(gap) => (
                <p class="commodity-profile-gap-line">
                  <Icon name="journal" size={13} />
                  {gap}
                </p>
              )}
            </For>
          </section>
        </div>
        <footer>
          <p>
            “Profile available” indicates some retrieved source facts. It does
            not mean complete coverage or a farm-specific suitability
            assessment.
          </p>
          <Show
            when={props.canCompare && safePlantIdentity(props.entry)}
            fallback={
              <span class="commodity-screening-unavailable">
                Localized crop screening is not linked for this market identity.
              </span>
            }
          >
            <button class="btn" onClick={props.onCompare}>
              Compare sourced requirements
              <Icon name="compare" size={16} />
            </button>
          </Show>
        </footer>
      </section>
    </div>
  );
}
