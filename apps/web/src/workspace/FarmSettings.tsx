import { SoilPrintedReference } from "./SoilPrintedReference";
import {
  For,
  Show,
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { A, useSearchParams } from "@solidjs/router";
import {
  SoilReport as reportSchema,
  type SoilReport,
  SoilReportExtraction as soilExtractionSchema,
  type SoilReportExtraction,
  type SoilMarkerDraft,
  type SoilSampleDraft,
  SoilParameter,
} from "@harvest/contracts";
import {
  apiRequest,
  jsonInit,
  newEntryId,
} from "../features/photo-region/http";
import { useWorkspace, dateLabel } from "./state";
import { PageHeading } from "./FarmPage";
import { Icon } from "./icons";
import { Evara } from "./Evara";
import { AiSpark, AiSparkInline } from "./ui/AiSpark";
import { SoilMarkerCards, SoilReferenceCards } from "./SoilMarkerCards";
import {
  loadSoilMarkers,
  loadSoilReport,
  loadReferenceReport,
  uploadSoilReport,
  printedResult,
  soilLabel,
  soilPollDelay,
} from "./soil";
const statusLabel = (status: string) =>
  (
    ({
      pending: "Queued for extraction",
      running: "Evara is reading",
      needs_review: "Review extracted values",
      confirmed: "Confirmed measurements",
      unavailable: "Extraction unavailable",
      error: "Extraction needs attention",
    }) as Record<string, string>
  )[status] ?? status;
export function FarmSettings() {
  const s = useWorkspace();
  const [query] = useSearchParams<{ farmId?: string }>();
  let appliedQuery = "";
  createEffect(() => {
    const id = query.farmId;
    if (id && id !== appliedQuery && s.farms()?.some((f) => f.id === id)) {
      appliedQuery = id;
      s.selectFarm(id);
    }
  });
  const [selected, setSelected] = createSignal<string | null>(null);
  const [requestedPage, setRequestedPage] = createSignal<number | undefined>();
  const openReport = (id: string, page?: number) => {
    setRequestedPage(page);
    setSelected(id);
  };
  const [error, setError] = createSignal("");
  const [uploading, setUploading] = createSignal(false);
  const [uploadName, setUploadName] = createSignal("");
  const [dragged, setDragged] = createSignal(false);
  let uploadRequest = 0;
  let retryFile: File | null = null;
  let retryKey = "";
  let sampleKey = "";
  const farmKey = () =>
    s.farm() ? `${s.sessionEpoch()}|${s.farm()!.id}` : false;
  const [retainedReports, setRetainedReports] = createSignal<
    Record<string, SoilReport>
  >({});
  const progress = (status: string) =>
    (
      ({
        pending: 0,
        running: 1,
        needs_review: 2,
        confirmed: 3,
        error: 2,
        unavailable: 2,
      }) as Record<string, number>
    )[status] ?? 0;
  function retainReport(report: SoilReport) {
    if (report.farmId !== s.farm()?.id) return;
    setRetainedReports((previous) => {
      const old = previous[report.id];
      if (
        old &&
        (old.version > report.version ||
          (old.version === report.version &&
            progress(old.status) > progress(report.status)))
      )
        return previous;
      return { ...previous, [report.id]: report };
    });
  }
  const [reports, { refetch: refreshReports }] = createResource(
    farmKey,
    async (key) => {
      const farmId = key.split("|")[1]!;
      const data = (
        await apiRequest<{ reports: SoilReport[] }>(
          `/api/v1/farms/${farmId}/soil-reports`,
        )
      ).data;
      const next =
        key === farmKey()
          ? (data?.reports ?? []).filter(
              (r) => reportSchema.safeParse(r).success,
            )
          : [];
      for (const report of next) retainReport(report);
      return next;
    },
  );
  const [markers, { refetch: refreshMarkers }] = createResource(
    farmKey,
    async (key) => {
      const data = await loadSoilMarkers(key.split("|")[1]!);
      return key === farmKey() ? data : undefined;
    },
  );
  const reportList = () =>
    Object.values(retainedReports())
      .filter((report) => report.farmId === s.farm()?.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const markerData = () =>
    !markers.error && markers()?.farmId === s.farm()?.id
      ? markers()
      : undefined;
  createEffect(
    on(farmKey, () => {
      ++uploadRequest;
      setSelected(null);
      setRequestedPage(undefined);
      setRetainedReports({});
      setError("");
      setUploading(false);
      retryFile = null;
      retryKey = "";
      sampleKey = "";
    }),
  );
  createEffect(() => {
    const issue = reports.error;
    const loading = reports.loading;
    if (
      !selected() &&
      !loading &&
      reportList().some((r) => ["pending", "running"].includes(r.status))
    ) {
      const timer = setTimeout(() => {
        void Promise.resolve(refreshReports()).catch(() => {});
      }, soilPollDelay(issue));
      onCleanup(() => clearTimeout(timer));
    }
  });
  const [detail, { refetch: refreshDetail, mutate: setDetail }] =
    createResource(
      () => (selected() && farmKey() ? `${farmKey()}|${selected()}` : false),
      async (key) => {
        const report = await loadSoilReport(key.split("|")[2]!);
        if (key !== `${farmKey()}|${selected()}`) return undefined;
        retainReport(report);
        return report;
      },
    );
  const report = () => {
    const cached = selected() ? retainedReports()[selected()!] : undefined;
    return cached?.farmId === s.farm()?.id ? cached : undefined;
  };
  createEffect(() => {
    const current = report();
    const issue = detail.error;
    const loading = detail.loading;
    if (
      current &&
      !loading &&
      ["pending", "running"].includes(current.status)
    ) {
      const timer = setTimeout(() => {
        void Promise.resolve(refreshDetail()).catch(() => {});
      }, soilPollDelay(issue));
      onCleanup(() => clearTimeout(timer));
    }
  });
  async function upload(file: File) {
    setError("");
    if (file.size > 10 * 1024 * 1024) {
      setError("Choose a report up to 10 MB. PDFs can contain up to 8 pages.");
      return;
    }
    if (
      !["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
        file.type,
      )
    ) {
      setError("Choose a PDF, JPEG, PNG or WebP soil report.");
      return;
    }
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    if (!farmId) return;
    const request = ++uploadRequest;
    if (retryFile !== file) {
      retryFile = file;
      retryKey = newEntryId("soil-report");
    }
    setUploading(true);
    setUploadName(file.name);
    try {
      const next = await uploadSoilReport(farmId, file, retryKey);
      if (
        request !== uploadRequest ||
        s.farm()?.id !== farmId ||
        s.sessionEpoch() !== epoch
      )
        return;
      retryFile = null;
      retryKey = "";
      retainReport(next);
      openReport(next.id);
      void Promise.resolve(refreshReports()).catch(() => {});
    } catch (e) {
      if (
        request === uploadRequest &&
        s.farm()?.id === farmId &&
        s.sessionEpoch() === epoch
      )
        setError((e as Error).message);
    } finally {
      if (request === uploadRequest) setUploading(false);
    }
  }
  async function sample() {
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    if (!farmId || uploading()) return;
    const request = ++uploadRequest;
    sampleKey ||= newEntryId("soil-reference");
    setUploading(true);
    setUploadName("Public laboratory reference");
    setError("");
    try {
      const next = await loadReferenceReport(farmId, sampleKey);
      if (
        request !== uploadRequest ||
        s.farm()?.id !== farmId ||
        s.sessionEpoch() !== epoch
      )
        return;
      retainReport(next);
      openReport(next.id);
      void Promise.resolve(refreshReports()).catch(() => {});
    } catch (e) {
      if (
        request === uploadRequest &&
        s.farm()?.id === farmId &&
        s.sessionEpoch() === epoch
      )
        setError((e as Error).message);
    } finally {
      if (request === uploadRequest) setUploading(false);
    }
  }
  const selectedFieldReports = () =>
    reportList().filter((r) => r.kind === "field_report");
  const referenceReports = () =>
    reportList().filter((r) => r.kind === "reference_sample");
  return (
    <div class="workspace-page farm-settings-page">
      <PageHeading
        eyebrow="A RECORD OF YOUR LAND"
        title="Your farm, in measured detail."
        description="Keep soil reports, review the laboratory values Evara extracts, and build a traceable record for each sample."
      >
        <A class="btn secondary" href="/farm">
          <Icon name="map" size={17} />
          Back to farm
        </A>
      </PageHeading>
      <Show
        when={s.farm()}
        fallback={
          <div class="empty-state">
            <Icon name="map" size={35} />
            <h2>Choose a farm first.</h2>
            <A class="btn" href="/farm">
              Go to your farms
            </A>
          </div>
        }
      >
        <div class="settings-farm-context">
          <span class="farm-avatar">
            <Icon name="leaf" size={23} />
          </span>
          <div>
            <strong>{s.farm()?.name}</strong>
            <p>
              {s.farm()?.location.districtName} · Soil reports stay linked to
              this farm.
            </p>
          </div>
          <A class="text-link" href="/farm/details">
            Photos & planting region
            <Icon name="arrow" size={15} />
          </A>
        </div>
        <div class="soil-settings-layout">
          <main class="soil-settings-main">
            <Show when={markers.error}>
              <p class="inline-error" role="status">
                Soil measurements could not load.{" "}
                <button
                  class="text-button"
                  onClick={() => void refreshMarkers()}
                >
                  Try again
                </button>
              </p>
            </Show>
            <Show when={markerData()?.samples.length}>
              <SoilMarkerCards data={markerData()} onReport={openReport} />
            </Show>
            <For
              each={referenceReports().filter(
                (report) =>
                  !!(report.reviewed ?? report.extraction)?.samples.some(
                    (sample) => sample.markers.length,
                  ),
              )}
            >
              {(report) => (
                <SoilReferenceCards
                  report={report}
                  farmName={s.farm()?.name ?? "this farm"}
                  onReview={(page) => openReport(report.id, page)}
                />
              )}
            </For>
            <Show when={!markerData()?.samples.length}>
              <SoilMarkerCards data={markerData()} onReport={openReport} />
            </Show>
            <section
              class="soil-reports-section"
              aria-label="Farm soil reports"
            >
              <div class="section-heading">
                <div>
                  <Icon name="journal" />
                  <h2>Field reports</h2>
                  <span class="tiny-pill">
                    {selectedFieldReports().length} reports
                  </span>
                </div>
                <button
                  class="text-button"
                  onClick={() => void refreshReports()}
                >
                  <Icon name="history" size={14} />
                  Refresh
                </button>
              </div>
              <p class="section-description">
                Extraction is a draft. Only the values you review and confirm
                become farm measurements.{" "}
                <AiSparkInline use="soil_extraction" label="Read by AI" />
              </p>
              <Show when={reports.error}>
                <p class="inline-error" role="status">
                  Reports could not load. {(reports.error as Error).message}
                </p>
              </Show>
              <Show
                when={selectedFieldReports().length}
                fallback={
                  <div class="soil-empty-reports">
                    <Icon name="journal" size={27} />
                    <strong>
                      {reports.loading
                        ? "Loading private reports…"
                        : "No field report added yet"}
                    </strong>
                    <p>
                      Your report’s original, page evidence, and review trail
                      stay together.
                    </p>
                  </div>
                }
              >
                <div class="soil-report-list">
                  <For each={selectedFieldReports()}>
                    {(r) => (
                      <ReportRow report={r} onOpen={() => openReport(r.id)} />
                    )}
                  </For>
                </div>
              </Show>
            </section>
            <Show when={referenceReports().length}>
              <section
                class="soil-reference-list"
                aria-label="Public reference reports"
              >
                <div class="section-heading">
                  <div>
                    <Icon name="layers" />
                    <h2>Public reference samples</h2>
                  </div>
                  <span class="tiny-pill">Kept separate</span>
                </div>
                <p class="section-description">
                  These source documents demonstrate extraction. Their values
                  are not measurements of {s.farm()?.name}.
                </p>
                <For each={referenceReports()}>
                  {(r) => (
                    <ReportRow report={r} onOpen={() => openReport(r.id)} />
                  )}
                </For>
              </section>
            </Show>
          </main>
          <aside class="soil-intake-panel">
            <div class="soil-upload-card">
              <span class="round-feature">
                <Icon name="journal" size={25} />
              </span>
              <p class="eyebrow">FROM THE LAB TO YOUR RECORD</p>
              <h2>Add a soil report.</h2>
              <p>
                Evara reads the document and proposes structured values. Review
                each result against its source page before confirming.{" "}
                <AiSpark use="soil_extraction" />
              </p>
              <div
                class={`soil-file-drop ${dragged() ? "dragged" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragged(true);
                }}
                onDragLeave={() => setDragged(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragged(false);
                  if (!uploading()) {
                    const file = e.dataTransfer?.files[0];
                    if (file) void upload(file);
                  }
                }}
              >
                <label class="btn full-width soil-file-label">
                  <Icon name="plus" size={17} />
                  Choose report
                  <input
                    class="sr-only-input"
                    type="file"
                    aria-label="Upload soil report"
                    accept="application/pdf,image/jpeg,image/png,image/webp"
                    disabled={uploading()}
                    onChange={(e) => {
                      const file = e.currentTarget.files?.[0];
                      e.currentTarget.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
                <span>PDF or image · up to 10 MB · PDFs up to 8 pages</span>
              </div>
              <Show when={uploading()}>
                <p class="soil-upload-status" role="status">
                  Adding {uploadName()}…
                </p>
              </Show>
              <Show when={error()}>
                <p class="inline-error" role="alert">
                  {error()}
                </p>
                <Show when={retryFile}>
                  <button
                    class="text-button"
                    disabled={uploading()}
                    onClick={() => retryFile && void upload(retryFile)}
                  >
                    Retry this upload
                  </button>
                </Show>
              </Show>
              <div class="soil-intake-note">
                <Icon name="check" size={15} />
                <p>
                  The original stays private to this workspace. Reading a report
                  does not automatically confirm its values.
                </p>
              </div>
            </div>
            <div class="soil-public-sample">
              <Evara size={42} />
              <p class="eyebrow">TRY THE REVIEW FLOW</p>
              <h3>Read an agricultural soil analysis.</h3>
              <p>
                ICAR’s published paddy-field research from Vizianagaram contains
                soil samples collected in April–May 2019 and published in 2020.
                Evara reads the selected GRL / NF (natural farming) column:
                twelve chemical readings, kept separate from the other plots and
                treatments.
              </p>
              <p>
                This is a historical agricultural research sample, not a Soil
                Health Card or measurements of {s.farm()?.name}. The selected
                tables do not report pH or electrical conductivity.
              </p>
              <a
                class="soil-public-source-link"
                href="https://www.niti.gov.in/sites/default/files/2023-03/Adoption%20of%20Natural%20Farming%20and%20its%20Effect%20on%20Crop%20Yield%20and%20Farmers%27%20Livelihood%20in%20India.pdf#page=122"
                target="_blank"
                rel="noreferrer"
              >
                View public source · pages 54, 120, 122–123 ↗
              </a>
              <button
                class="btn secondary full-width"
                disabled={uploading()}
                onClick={() => void sample()}
              >
                Load public sample report
                <Icon name="arrow" size={16} />
              </button>
            </div>
            <div class="soil-method-note">
              <h3>Measurements need context.</h3>
              <p>
                Method, extractant, depth and units affect comparability.
                Laboratory ratings remain quoted ratings; there is no universal
                soil-health score.
              </p>
              <a
                href="https://www.fao.org/global-soil-partnership/Scientific-and-technical-support/networks/the-glosolan/en"
                target="_blank"
                rel="noreferrer"
              >
                Why laboratory methods matter ↗
              </a>
            </div>
          </aside>
        </div>
      </Show>
      <Show when={selected()}>
        <SoilReportReview
          report={report()}
          requestedPage={requestedPage()}
          loading={detail.loading}
          error={detail.error as Error | undefined}
          farmName={s.farm()?.name ?? "this farm"}
          onClose={() => setSelected(null)}
          onSaved={(next) => {
            if (next.farmId === s.farm()?.id && next.id === selected()) {
              retainReport(next);
              setDetail(next);
              void Promise.resolve(refreshReports()).catch(() => {});
              void Promise.resolve(refreshMarkers()).catch(() => {});
            }
          }}
        />
      </Show>
    </div>
  );
}
function ReportRow(props: { report: SoilReport; onOpen: () => void }) {
  const r = () => props.report;
  return (
    <button class="soil-report-row" onClick={props.onOpen}>
      <span class="soil-report-icon">
        <Icon name="journal" size={20} />
      </span>
      <span>
        <strong>
          {r().reviewed?.title ?? r().extraction?.title ?? r().filename}
        </strong>
        <small>
          {r().filename} · added {dateLabel(r().createdAt.slice(0, 10))}
          {r().kind === "reference_sample" ? " · public reference" : ""}
        </small>
      </span>
      <span class={`soil-report-status ${r().status}`}>
        {statusLabel(r().status)}
      </span>
      <Icon name="arrow" size={17} />
    </button>
  );
}
function SoilReportReview(props: {
  report?: SoilReport | undefined;
  requestedPage?: number | undefined;
  loading: boolean;
  error?: Error | undefined;
  farmName: string;
  onClose: () => void;
  onSaved: (report: SoilReport) => void;
}) {
  const s = useWorkspace();
  const [draft, setDraft] = createSignal<SoilReportExtraction | null>(null);
  const [included, setIncluded] = createSignal<string[]>([]);
  const [page, setPage] = createSignal(props.requestedPage ?? 1);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const [tab, setTab] = createSignal<"values" | "original">(
    props.requestedPage ? "original" : "values",
  );
  const [depthDrafts, setDepthDrafts] = createSignal<
    Record<string, { from: string; to: string; unit: string }>
  >({});
  const report = () => props.report;
  const baseline = () => report()?.reviewed ?? report()?.extraction ?? null;
  const reportWarnings = () => [
    ...new Set([...(report()?.warnings ?? []), ...(draft()?.warnings ?? [])]),
  ];
  const key = () =>
    `${report()?.id ?? ""}|${report()?.version ?? ""}|${report()?.status ?? ""}|${report()?.reviewed ? "reviewed" : report()?.extraction ? "extracted" : "empty"}`;
  createEffect(
    on(key, () => {
      setDraft(baseline() ? structuredClone(baseline()!) : null);
      setIncluded([]);
      setError("");
      setDepthDrafts(
        Object.fromEntries(
          (baseline()?.samples ?? []).map((sample) => [
            sample.id,
            {
              from: sample.depth ? String(sample.depth.from) : "",
              to: sample.depth ? String(sample.depth.to) : "",
              unit: sample.depth?.unit ?? "",
            },
          ]),
        ),
      );
    }),
  );
  let pageTarget = "";
  createEffect(() => {
    const current = report();
    if (!current) return;
    const target = `${current.id}|${props.requestedPage ?? ""}`;
    if (pageTarget === target) return;
    pageTarget = target;
    setPage(props.requestedPage ?? current.pages[0]?.page ?? 1);
    setTab(props.requestedPage ? "original" : "values");
  });
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(baseline());
  const reference = () => report()?.kind === "reference_sample";
  const currentPage = () => report()?.pages.find((p) => p.page === page());
  const sampleMarkerKey = (sampleId: string, markerId: string) =>
    `${sampleId}|${markerId}`;
  const updateMetadata = (patch: Partial<SoilReportExtraction>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));
  const updateSample = (sampleId: string, patch: Partial<SoilSampleDraft>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            samples: current.samples.map((sample) =>
              sample.id === sampleId ? { ...sample, ...patch } : sample,
            ),
          }
        : current,
    );
  const depthRaw = (id: string) =>
    depthDrafts()[id] ?? { from: "", to: "", unit: "" };
  const validDepth = (raw: { from: string; to: string; unit: string }) =>
    raw.from.trim() !== "" &&
    raw.to.trim() !== "" &&
    ["cm", "m", "inch"].includes(raw.unit) &&
    Number.isFinite(Number(raw.from)) &&
    Number.isFinite(Number(raw.to)) &&
    Number(raw.from) >= 0 &&
    Number(raw.to) >= Number(raw.from);
  const incompleteDepth = () =>
    Object.values(depthDrafts()).some(
      (raw) =>
        (raw.from !== "" || raw.to !== "" || raw.unit !== "") &&
        !validDepth(raw),
    );
  function editDepth(id: string, field: "from" | "to" | "unit", value: string) {
    const raw = { ...depthRaw(id), [field]: value };
    setDepthDrafts((previous) => ({ ...previous, [id]: raw }));
    updateSample(id, {
      depth: validDepth(raw)
        ? {
            from: Number(raw.from),
            to: Number(raw.to),
            unit: raw.unit as "cm" | "m" | "inch",
          }
        : null,
    });
  }
  const updateMarker = (
    sampleId: string,
    markerId: string,
    patch: Partial<SoilMarkerDraft>,
  ) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            samples: current.samples.map((sample) =>
              sample.id === sampleId
                ? {
                    ...sample,
                    markers: sample.markers.map((marker) =>
                      marker.id === markerId ? { ...marker, ...patch } : marker,
                    ),
                  }
                : sample,
            ),
          }
        : current,
    );
  const toggle = (sampleId: string, markerId: string) => {
    const key = sampleMarkerKey(sampleId, markerId);
    setIncluded((current) =>
      current.includes(key)
        ? current.filter((id) => id !== key)
        : [...current, key],
    );
  };
  const toggleSample = (sample: SoilSampleDraft) => {
    const ids = sample.markers.map((m) => sampleMarkerKey(sample.id, m.id));
    setIncluded((current) =>
      ids.every((id) => current.includes(id))
        ? current.filter((id) => !ids.includes(id))
        : [...new Set([...current, ...ids])],
    );
  };
  async function save(confirm: boolean) {
    const r = report();
    const d = draft();
    const epoch = s.sessionEpoch();
    const farmId = s.farm()?.id;
    if (!r || !d || saving() || r.farmId !== farmId) return;
    if (incompleteDepth()) {
      setError(
        "Complete sample depths with both limits and a unit, or clear the depth fields.",
      );
      return;
    }
    const validation = soilExtractionSchema.safeParse(d);
    if (!validation.success) {
      setError(
        "Check required printed labels and results, dates, and sample details before saving.",
      );
      return;
    }
    const selection = [...included()];
    const target = r.id;
    const active = () =>
      epoch === s.sessionEpoch() &&
      s.farm()?.id === farmId &&
      report()?.id === target;
    setError("");
    setSaving(true);
    try {
      let next = r;
      if (dirty()) {
        next = reportSchema.parse(
          (
            await apiRequest(
              `/api/v1/soil-reports/${target}`,
              jsonInit("PATCH", { expectedVersion: r.version, draft: d }),
            )
          ).data,
        );
        if (active()) props.onSaved(next);
      }
      if (!active()) return;
      if (confirm) {
        const selectedSamples = d.samples.filter((sample) =>
          sample.markers.some((m) =>
            selection.includes(sampleMarkerKey(sample.id, m.id)),
          ),
        );
        const markerIds = selectedSamples.flatMap((sample) =>
          sample.markers
            .filter((m) => selection.includes(sampleMarkerKey(sample.id, m.id)))
            .map((m) => m.id),
        );
        if (!markerIds.length)
          throw new Error(
            "Choose the results you have checked against the report.",
          );
        next = reportSchema.parse(
          (
            await apiRequest(
              `/api/v1/soil-reports/${target}/confirm`,
              jsonInit("POST", {
                expectedVersion: next.version,
                sampleIds: selectedSamples.map((sample) => sample.id),
                markerIds: [...new Set(markerIds)],
              }),
            )
          ).data,
        );
      }
      if (active()) props.onSaved(next);
    } catch (e) {
      if (active()) setError((e as Error).message);
    } finally {
      if (active()) setSaving(false);
    }
  }
  return (
    <div class="modal-backdrop soil-report-backdrop">
      <section
        class="soil-report-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="soil-report-title"
      >
        <header class="soil-review-header">
          <div>
            <p class="eyebrow">EVARA · REPORT REVIEW</p>
            <h2 id="soil-report-title">
              {report()?.reviewed?.title ??
                report()?.extraction?.title ??
                report()?.filename ??
                "Soil report"}
            </h2>
            <Show when={report()}>
              <p>
                {statusLabel(report()!.status)} · version {report()?.version}
              </p>
            </Show>
          </div>
          <button
            class="icon-button"
            aria-label="Close soil report"
            onClick={props.onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <Show when={props.loading && !report()}>
          <p class="soil-review-loading" role="status">
            Loading this private report…
          </p>
        </Show>
        <Show when={props.error}>
          <p class="inline-error" role="alert">
            {props.error?.message}
          </p>
        </Show>
        <Show when={report()}>
          {(r) => (
            <>
              <Show when={reference()}>
                <div class="soil-reference-warning" role="note">
                  <Icon name="layers" size={20} />
                  <div>
                    <strong>
                      Public reference sample · not measurements of{" "}
                      {props.farmName}
                    </strong>
                    <p>
                      Review this extraction to try the workflow. Its values
                      cannot be confirmed as this farm’s soil measurements.
                    </p>
                    <Show when={r().referenceSource}>
                      <a
                        href={r().referenceSource!.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {r().referenceSource!.title} ↗
                      </a>
                      <Show when={r().referenceSource!.extractionScope}>
                        {(scope) => (
                          <p>
                            <strong>
                              Selected source sample: {scope().sampleLabel}
                            </strong>
                            {" · "}up to {scope().markerLimit} readings in
                            scope.
                          </p>
                        )}
                      </Show>
                      <details class="soil-reference-source-details">
                        <summary>Source details & limitations</summary>
                        <Show when={r().referenceSource!.extractionScope}>
                          {(scope) => <p>{scope().description}</p>}
                        </Show>
                        <For each={r().referenceSource!.limitations}>
                          {(line) => <p>{line}</p>}
                        </For>
                      </details>
                    </Show>
                  </div>
                </div>
              </Show>
              <div class="soil-review-mobile-tabs">
                <button
                  classList={{ active: tab() === "values" }}
                  onClick={() => setTab("values")}
                >
                  Extracted values
                </button>
                <button
                  classList={{ active: tab() === "original" }}
                  onClick={() => setTab("original")}
                >
                  Original pages
                </button>
              </div>
              <div class="soil-review-body">
                <aside
                  class={`soil-page-viewer ${tab() === "original" ? "mobile-active" : ""}`}
                >
                  <div class="soil-page-controls">
                    <label>
                      Source page
                      <select
                        aria-label="Report preview page"
                        value={page()}
                        onChange={(e) => setPage(Number(e.currentTarget.value))}
                      >
                        <For each={r().pages}>
                          {(p) => (
                            <option value={p.page} selected={p.page === page()}>
                              Page {p.page}
                            </option>
                          )}
                        </For>
                      </select>
                    </label>
                    <span class="soil-original-links">
                      <a
                        href={r().originalUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original ↗
                      </a>
                      <a href={r().originalUrl} download={r().filename}>
                        Download report
                      </a>
                    </span>
                  </div>
                  <Show
                    when={currentPage()}
                    fallback={
                      <p class="soil-preview-pending">
                        {["pending", "running"].includes(r().status)
                          ? "Preparing document pages…"
                          : "A page preview is not available. Open the original to verify the values."}
                      </p>
                    }
                  >
                    {(p) => (
                      <img
                        src={p().imageUrl}
                        alt={`Page ${p().page} of ${r().filename}`}
                        loading="lazy"
                      />
                    )}
                  </Show>
                  <p class="soil-preview-caption">
                    The original page is the evidence. Check digits, units,
                    sample identity and methods before confirming.
                  </p>
                </aside>
                <main
                  class={`soil-extraction-review ${tab() === "values" ? "mobile-active" : ""}`}
                >
                  <Show when={["pending", "running"].includes(r().status)}>
                    <div class="soil-extraction-pending" role="status">
                      <Evara size={49} />
                      <div>
                        <h3>
                          {r().status === "running"
                            ? "Evara is reading the report."
                            : "Report queued for extraction."}
                        </h3>
                        <p>
                          Pages and draft values will appear automatically. No
                          field value is confirmed yet.
                        </p>
                      </div>
                    </div>
                  </Show>
                  <Show when={["error", "unavailable"].includes(r().status)}>
                    <div class="soil-extraction-failed">
                      <h3>The extraction could not be completed.</h3>
                      <p>
                        Your original remains available. Check the source
                        document or upload a clearer report.
                      </p>
                    </div>
                  </Show>
                  <Show when={reportWarnings().length}>
                    <details class="soil-report-warning-details">
                      <summary>
                        Extraction notes & review flags (
                        {reportWarnings().length})
                      </summary>
                      <For each={reportWarnings()}>
                        {(line) => <p class="soil-review-warning">{line}</p>}
                      </For>
                    </details>
                  </Show>
                  <Show when={draft()}>
                    {(d) => (
                      <>
                        <div class="soil-review-intro">
                          <h3>Review the extracted record.</h3>
                          <Show when={r().status !== "confirmed"}>
                            <p>Extracted values still need human review.</p>
                          </Show>
                          <p>
                            Correct any reading errors. Preserve the printed
                            result, unit, analyte and method; leave information
                            missing from the report blank.
                          </p>
                        </div>
                        <fieldset
                          class="soil-review-metadata"
                          disabled={saving()}
                        >
                          <label>
                            Report title
                            <input
                              value={d().title ?? ""}
                              onInput={(e) =>
                                updateMetadata({
                                  title: e.currentTarget.value || null,
                                })
                              }
                            />
                          </label>
                          <div class="form-grid">
                            <label>
                              Report laboratory
                              <input
                                value={d().laboratory ?? ""}
                                onInput={(e) =>
                                  updateMetadata({
                                    laboratory: e.currentTarget.value || null,
                                  })
                                }
                              />
                            </label>
                            <label>
                              Report received date
                              <input
                                type="date"
                                value={d().receivedDate ?? ""}
                                onInput={(e) =>
                                  updateMetadata({
                                    receivedDate: e.currentTarget.value || null,
                                  })
                                }
                              />
                            </label>
                            <label>
                              Report date
                              <input
                                type="date"
                                value={d().reportDate ?? ""}
                                onInput={(e) =>
                                  updateMetadata({
                                    reportDate: e.currentTarget.value || null,
                                  })
                                }
                              />
                            </label>
                          </div>
                        </fieldset>
                        <For each={d().samples}>
                          {(sample) => (
                            <section class="soil-sample-review">
                              <div class="soil-sample-review-title">
                                <div>
                                  <span class="eyebrow">SAMPLE</span>
                                  <h3>
                                    {sample.sampleLabel ?? "Unnamed sample"}
                                  </h3>
                                </div>
                                <Show
                                  when={
                                    !reference() && r().status !== "confirmed"
                                  }
                                >
                                  <label class="soil-include-sample">
                                    <input
                                      type="checkbox"
                                      aria-label={`Include all results for ${sample.sampleLabel ?? "sample"}`}
                                      checked={
                                        sample.markers.length > 0 &&
                                        sample.markers.every((m) =>
                                          included().includes(
                                            sampleMarkerKey(sample.id, m.id),
                                          ),
                                        )
                                      }
                                      disabled={saving()}
                                      onChange={() => toggleSample(sample)}
                                    />
                                    Include all checked results
                                  </label>
                                </Show>
                              </div>
                              <fieldset
                                class="soil-sample-metadata"
                                disabled={saving()}
                              >
                                <div class="form-grid">
                                  <label>
                                    Sample label
                                    <input
                                      value={sample.sampleLabel ?? ""}
                                      onInput={(e) =>
                                        updateSample(sample.id, {
                                          sampleLabel:
                                            e.currentTarget.value || null,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    Sample laboratory
                                    <input
                                      value={sample.laboratory ?? ""}
                                      onInput={(e) =>
                                        updateSample(sample.id, {
                                          laboratory:
                                            e.currentTarget.value || null,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    Collection date
                                    <input
                                      type="date"
                                      value={sample.collectionDate ?? ""}
                                      onInput={(e) =>
                                        updateSample(sample.id, {
                                          collectionDate:
                                            e.currentTarget.value || null,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    Sample received date
                                    <input
                                      type="date"
                                      value={sample.receivedDate ?? ""}
                                      onInput={(e) =>
                                        updateSample(sample.id, {
                                          receivedDate:
                                            e.currentTarget.value || null,
                                        })
                                      }
                                    />
                                  </label>
                                  <label>
                                    Sample report date
                                    <input
                                      type="date"
                                      value={sample.reportDate ?? ""}
                                      onInput={(e) =>
                                        updateSample(sample.id, {
                                          reportDate:
                                            e.currentTarget.value || null,
                                        })
                                      }
                                    />
                                  </label>
                                </div>
                                <div class="soil-depth-controls">
                                  <label>
                                    Depth from
                                    <input
                                      type="number"
                                      min="0"
                                      step="any"
                                      value={depthRaw(sample.id).from}
                                      placeholder="Not reported"
                                      onInput={(e) =>
                                        editDepth(
                                          sample.id,
                                          "from",
                                          e.currentTarget.value,
                                        )
                                      }
                                    />
                                  </label>
                                  <label>
                                    Depth to
                                    <input
                                      type="number"
                                      min="0"
                                      step="any"
                                      value={depthRaw(sample.id).to}
                                      placeholder="Not reported"
                                      onInput={(e) =>
                                        editDepth(
                                          sample.id,
                                          "to",
                                          e.currentTarget.value,
                                        )
                                      }
                                    />
                                  </label>
                                  <label>
                                    Depth unit
                                    <select
                                      value={depthRaw(sample.id).unit}
                                      onChange={(e) =>
                                        editDepth(
                                          sample.id,
                                          "unit",
                                          e.currentTarget.value,
                                        )
                                      }
                                    >
                                      <option value="">Not reported</option>
                                      <option value="cm">cm</option>
                                      <option value="m">m</option>
                                      <option value="inch">inch</option>
                                    </select>
                                  </label>
                                </div>
                                <p class="soil-review-depth">
                                  Depth:{" "}
                                  {sample.depth
                                    ? `${sample.depth.from}–${sample.depth.to} ${sample.depth.unit}`
                                    : "Not reported"}{" "}
                                  · values belong to this sample only
                                </p>
                              </fieldset>
                              <For each={sample.markers}>
                                {(marker) => (
                                  <article class="soil-marker-review">
                                    <div class="soil-marker-review-heading">
                                      <Show
                                        when={
                                          !reference() &&
                                          r().status !== "confirmed"
                                        }
                                      >
                                        <input
                                          type="checkbox"
                                          aria-label={`Confirm ${marker.rawLabel} for ${sample.sampleLabel ?? "sample"}`}
                                          checked={included().includes(
                                            sampleMarkerKey(
                                              sample.id,
                                              marker.id,
                                            ),
                                          )}
                                          disabled={saving()}
                                          onChange={() =>
                                            toggle(sample.id, marker.id)
                                          }
                                        />
                                      </Show>
                                      <div>
                                        <h4>{marker.rawLabel}</h4>
                                        <p>
                                          {soilLabel(marker.parameter)} ·{" "}
                                          {marker.extractionConfidence}{" "}
                                          extraction confidence
                                        </p>
                                      </div>
                                      <button
                                        class="text-button"
                                        onClick={() => {
                                          setPage(marker.evidence.page);
                                          setTab("original");
                                        }}
                                      >
                                        View p. {marker.evidence.page}
                                        <Icon name="arrow" size={13} />
                                      </button>
                                    </div>
                                    <fieldset disabled={saving()}>
                                      <div class="form-grid">
                                        <label>
                                          Printed result
                                          <input
                                            value={marker.rawValue}
                                            onInput={(e) =>
                                              updateMarker(
                                                sample.id,
                                                marker.id,
                                                printedResult(
                                                  e.currentTarget.value,
                                                ),
                                              )
                                            }
                                          />
                                        </label>
                                        <label>
                                          Printed unit
                                          <input
                                            value={marker.rawUnit ?? ""}
                                            placeholder="Not reported"
                                            onInput={(e) =>
                                              updateMarker(
                                                sample.id,
                                                marker.id,
                                                {
                                                  rawUnit:
                                                    e.currentTarget.value ||
                                                    null,
                                                },
                                              )
                                            }
                                          />
                                        </label>
                                      </div>
                                      <details class="soil-marker-metadata">
                                        <summary>
                                          Method, analyte and extraction details
                                        </summary>
                                        <div class="form-grid">
                                          <label>
                                            Parameter
                                            <select
                                              value={marker.parameter}
                                              onChange={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    parameter: e.currentTarget
                                                      .value as SoilMarkerDraft["parameter"],
                                                  },
                                                )
                                              }
                                            >
                                              <For each={SoilParameter.options}>
                                                {(parameter) => (
                                                  <option value={parameter}>
                                                    {soilLabel(parameter)}
                                                  </option>
                                                )}
                                              </For>
                                            </select>
                                          </label>
                                          <label>
                                            Printed label
                                            <input
                                              value={marker.rawLabel}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    rawLabel:
                                                      e.currentTarget.value,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Analyte form
                                            <input
                                              value={marker.analyteForm ?? ""}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    analyteForm:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Laboratory method
                                            <input
                                              value={marker.method ?? ""}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    method:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Extractant
                                            <input
                                              value={marker.extractant ?? ""}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    extractant:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Soil / water ratio
                                            <input
                                              value={
                                                marker.soilWaterRatio ?? ""
                                              }
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    soilWaterRatio:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Quoted laboratory rating
                                            <input
                                              value={
                                                marker.reportedRating ?? ""
                                              }
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    reportedRating:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Mass basis
                                            <input
                                              value={marker.massBasis ?? ""}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    massBasis:
                                                      e.currentTarget.value ||
                                                      null,
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Matrix
                                            <select
                                              value={marker.matrix}
                                              onChange={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    matrix: e.currentTarget
                                                      .value as SoilMarkerDraft["matrix"],
                                                  },
                                                )
                                              }
                                            >
                                              <option value="soil">Soil</option>
                                              <option value="water">
                                                Water
                                              </option>
                                              <option value="plant">
                                                Plant
                                              </option>
                                              <option value="unknown">
                                                Unknown
                                              </option>
                                            </select>
                                          </label>
                                          <label>
                                            Temperature °C
                                            <input
                                              type="number"
                                              step="any"
                                              value={marker.temperatureC ?? ""}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    temperatureC:
                                                      e.currentTarget.value ===
                                                      ""
                                                        ? null
                                                        : Number(
                                                            e.currentTarget
                                                              .value,
                                                          ),
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                          <label>
                                            Evidence page
                                            <input
                                              type="number"
                                              min="1"
                                              max="8"
                                              value={marker.evidence.page}
                                              onInput={(e) =>
                                                updateMarker(
                                                  sample.id,
                                                  marker.id,
                                                  {
                                                    evidence: {
                                                      ...marker.evidence,
                                                      page: Number(
                                                        e.currentTarget.value,
                                                      ),
                                                    },
                                                  },
                                                )
                                              }
                                            />
                                          </label>
                                        </div>
                                        <p>
                                          Result type:{" "}
                                          {marker.qualifier.replace(/_/g, " ")}{" "}
                                          · matrix: {marker.matrix} · native
                                          text check:{" "}
                                          {marker.evidence.nativeTextCheck.replace(
                                            /_/g,
                                            " ",
                                          )}
                                        </p>
                                      </details>
                                    </fieldset>
                                    <fieldset disabled={saving()}>
                                      <SoilPrintedReference
                                        marker={marker}
                                        onPage={(page) => {
                                          setPage(page);
                                          setTab("original");
                                        }}
                                        onChange={(reportedReference) =>
                                          updateMarker(sample.id, marker.id, {
                                            reportedReference,
                                          })
                                        }
                                      />
                                    </fieldset>
                                    <blockquote class="soil-source-quote">
                                      <span>
                                        Source, p. {marker.evidence.page}
                                      </span>
                                      “{marker.evidence.quote}”
                                    </blockquote>
                                    <For each={marker.warnings}>
                                      {(line) => (
                                        <p class="soil-review-warning">
                                          {line}
                                        </p>
                                      )}
                                    </For>
                                  </article>
                                )}
                              </For>
                            </section>
                          )}
                        </For>
                      </>
                    )}
                  </Show>
                </main>
              </div>
              <footer class="soil-review-footer">
                <div>
                  <strong>
                    {reference()
                      ? "Reference review only"
                      : r().status === "confirmed"
                        ? "Confirmed measurement record"
                        : `${included().length} results selected`}
                  </strong>
                  <p>
                    {reference()
                      ? "Public sample values stay outside this farm’s markers."
                      : "Confirmation records the reviewed values and their source; it does not supply a fertilizer recommendation."}
                  </p>
                  <Show when={error()}>
                    <p class="inline-error" role="alert">
                      {error()}
                    </p>
                  </Show>
                </div>
                <Show when={draft()}>
                  <button
                    class="btn secondary"
                    disabled={!dirty() || saving()}
                    onClick={() => void save(false)}
                  >
                    {saving() ? "Saving…" : "Save reviewed draft"}
                  </button>
                  <Show when={!reference() && r().status !== "confirmed"}>
                    <button
                      class="btn"
                      disabled={
                        !included().length ||
                        saving() ||
                        !draft()?.samples.length
                      }
                      onClick={() => void save(true)}
                    >
                      Confirm selected results
                      <Icon name="check" size={16} />
                    </button>
                  </Show>
                </Show>
              </footer>
            </>
          )}
        </Show>
      </section>
    </div>
  );
}
