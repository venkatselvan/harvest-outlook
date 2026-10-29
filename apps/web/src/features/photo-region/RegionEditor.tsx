import { For, Index, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { ApiError } from "../../lib/api";
import {
  MAX_POINTS, MIN_POINTS, PROBLEM_TEXT, addCentrePoint, addPoint, clientToNormalized, containBox, cornersRectangle, moveHandle, normalizedToContainer,
  polygonArea, removePoint, round6, sameAspect, validatePolygon, type MoveKey, type Pt,
} from "../../lib/geometry";
import { apiRequest, jsonInit } from "./http";
import { cancelSuggestion, pollSuggestion, requestSegmentation, type SuggestionOutcome } from "./segmentation";
import { AI_LABEL, FIELD_OUTLINE_NOTE, normalizedUrl, type MediaInfo, type RegionSource } from "./types";

type Ai =
  | { status: "idle" }
  | { status: "working"; jobId: string | null }
  | { status: "proposal"; polygon: Pt[]; score: number | null; extra: number }
  | { status: "message"; text: string };

const ARROWS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);

export function RegionEditor(props: { media: MediaInfo; onSaved?: (m: MediaInfo) => void }) {
  const norm = props.media.normalized;
  const imageSize = { w: norm.width, h: norm.height };
  const saved = props.media.region && props.media.region.transform.normalizedWidth === norm.width && props.media.region.transform.normalizedHeight === norm.height ? props.media.region : null;

  const [points, setPoints] = createSignal<Pt[]>(saved ? saved.polygon.map(([x, y]) => [x, y] as Pt) : []);
  const [history, setHistory] = createSignal<Pt[][]>([]);
  const [origin, setOrigin] = createSignal<RegionSource>(saved?.source ?? "manual");
  const [savedKey, setSavedKey] = createSignal<string | null>(saved ? JSON.stringify(saved.polygon) : null);
  const [savedVersion, setSavedVersion] = createSignal<number | null>(saved?.version ?? null);
  const [active, setActive] = createSignal<number | null>(null);
  const [stage, setStage] = createSignal({ w: 0, h: 0 });
  const [imgState, setImgState] = createSignal<"loading" | "ready" | "error" | "mismatch">("loading");
  const [saveMsg, setSaveMsg] = createSignal<{ kind: "ok" | "error"; text: string } | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [ai, setAi] = createSignal<Ai>({ status: "idle" });
  const [hint, setHint] = createSignal<string | null>(null);

  let stageEl!: HTMLDivElement;
  let aiAbort: AbortController | null = null;
  const handleEls: (HTMLButtonElement | undefined)[] = [];
  let dragging: number | null = null;

  const box = createMemo(() => containBox(stage(), imageSize));
  const validation = createMemo(() => validatePolygon(points()));
  const dirty = createMemo(() => JSON.stringify(points()) !== savedKey());
  const cssPoints = createMemo(() => points().map((p) => normalizedToContainer(p, box())));
  const proposal = createMemo(() => {
    const a = ai();
    return a.status === "proposal" ? a.polygon.map((p) => normalizedToContainer(p, box())) : [];
  });
  const ready = () => imgState() === "ready";

  onMount(() => {
    const measure = () => setStage({ w: stageEl.clientWidth, h: stageEl.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stageEl);
    onCleanup(() => ro.disconnect());
  });
  onCleanup(() => aiAbort?.abort());

  const commit = (next: Pt[], opts: { origin?: RegionSource; keepHistory?: boolean } = {}) => {
    if (!opts.keepHistory) setHistory((h) => [...h.slice(-49), points()]);
    setPoints(next);
    setSaveMsg(null);
    if (opts.origin) setOrigin(opts.origin);
  };
  const focusHandle = (i: number) => {
    setActive(i);
    queueMicrotask(() => handleEls[i]?.focus());
  };

  const stageRect = () => stageEl.getBoundingClientRect();
  const toNorm = (e: { clientX: number; clientY: number }, clamp = false) => clientToNormalized([e.clientX, e.clientY], stageRect(), imageSize, clamp);

  const onStageClick = (e: MouseEvent) => {
    if (!ready() || e.detail === 0) return; // detail 0 = synthetic/keyboard click
    const p = toNorm(e);
    if (!p) return; // letterbox margin
    const next = addPoint(points(), p);
    if (!next) {
      setHint(`An outline can have at most ${MAX_POINTS} points.`);
      return;
    }
    setHint(null);
    commit(next);
    setActive(next.length - 1);
  };

  const onStageKey = (e: KeyboardEvent) => {
    if (!ready()) return;
    const t = e.target as HTMLElement;
    const handleIndex = t.dataset.handle !== undefined ? Number(t.dataset.handle) : null;
    if (e.key === "Enter") {
      e.preventDefault();
      const next = addCentrePoint(points());
      if (!next) return setHint(`An outline can have at most ${MAX_POINTS} points.`);
      setHint(null);
      commit(next);
      focusHandle(next.length - 1);
    } else if (handleIndex !== null && ARROWS.has(e.key)) {
      e.preventDefault();
      const next = moveHandle(points(), handleIndex, e.key as MoveKey, e.shiftKey);
      if (next) commit(next, { keepHistory: e.repeat });
    } else if (handleIndex !== null && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      commit(removePoint(points(), handleIndex));
      const left = points().length;
      if (left > 0) focusHandle(Math.min(handleIndex, left - 1));
      else stageEl.focus();
    }
  };

  const onHandleDown = (e: PointerEvent, i: number) => {
    if (!ready()) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragging = i;
    setActive(i);
    setHistory((h) => [...h.slice(-49), points()]);
  };
  const onHandleMove = (e: PointerEvent, i: number) => {
    if (dragging !== i) return;
    const p = toNorm(e, true);
    if (!p) return;
    const next = points().slice();
    next[i] = [round6(p[0]), round6(p[1])];
    setPoints(next);
    setSaveMsg(null);
  };
  const onHandleUp = () => {
    dragging = null;
  };

  const undo = () => {
    const h = history();
    const prev = h[h.length - 1];
    if (!prev) return;
    setHistory(h.slice(0, -1));
    setPoints(prev);
    setActive(null);
    setSaveMsg(null);
  };
  const clear = () => {
    if (points().length === 0) return;
    commit([], { origin: "manual" });
    setActive(null);
    stageEl.focus();
  };
  const fourCorners = () => {
    commit(cornersRectangle(), { origin: "manual" });
    setHint("Drag each numbered corner onto the edge of your planting area.");
    focusHandle(0);
  };

  const save = async () => {
    const v = validation();
    if (!v.ok || saving()) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const env = await apiRequest<MediaInfo>(
        `/api/v1/media/${props.media.id}/region`,
        jsonInit("PUT", { polygon: points(), source: origin(), transform: { orientationApplied: true, normalizedWidth: norm.width, normalizedHeight: norm.height } }),
      );
      setSavedKey(JSON.stringify(points()));
      setSavedVersion(env.data!.region?.version ?? null);
      setSaveMsg({ kind: "ok", text: "Outline saved." });
      props.onSaved?.(env.data!);
    } catch (e) {
      setSaveMsg({ kind: "error", text: e instanceof ApiError ? `Could not save the outline: ${e.message}` : "Could not save the outline. Check your connection and try again." });
    } finally {
      setSaving(false);
    }
  };

  const suggest = async () => {
    if (ai().status === "working") return;
    aiAbort?.abort();
    aiAbort = new AbortController();
    const signal = aiAbort.signal;
    setAi({ status: "working", jobId: null });
    let outcome: SuggestionOutcome | { kind: "aborted" };
    let jobId: string | null = null;
    try {
      ({ jobId } = await requestSegmentation(props.media.id, { kind: "concept", text: "field" }));
      setAi({ status: "working", jobId });
      outcome = await pollSuggestion(jobId, { signal });
    } catch (e) {
      outcome = { kind: "failed", message: e instanceof ApiError && e.status === 404 ? "That photo was not found." : "Could not reach the AI suggestion service." };
    }
    if (outcome.kind === "aborted") return;
    if (outcome.kind === "proposal") setAi({ status: "proposal", polygon: outcome.polygon, score: outcome.score, extra: outcome.extra });
    else setAi({ status: "message", text: outcome.message });
  };
  const cancelAi = () => {
    const a = ai();
    aiAbort?.abort();
    if (a.status === "working" && a.jobId) void cancelSuggestion(a.jobId);
    setAi({ status: "idle" });
  };
  const acceptProposal = async () => {
    const a = ai();
    if (a.status !== "proposal") return;
    commit(a.polygon, { origin: "sam_confirmed" });
    setAi({ status: "idle" });
    await save();
  };

  const coverage = () => Math.round(polygonArea(points()) * 100);
  const sourceLabel = () => (origin() === "sam_confirmed" ? "AI suggestion confirmed by you" : "drawn by you");
  const polyStr = (pts: Pt[]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

  return (
    <section class="pr-editor" aria-labelledby="pr-title">
      <h2 id="pr-title">Outline the planting area</h2>
      <p class="pr-note">{FIELD_OUTLINE_NOTE}</p>
      <p id="pr-help" class="pr-help">
        Tap the photo to add points around your planting area (3 to {MAX_POINTS}). Drag a numbered point to adjust it. With a keyboard: Tab to the photo, press Enter to add a point at the centre, then use the arrow keys to move the selected point
        (Shift for small steps; Delete removes it).
      </p>

      <Show when={imgState() === "error"}>
        <p role="alert" class="pr-error">Could not load the photo. Reload the page or upload it again.</p>
      </Show>
      <Show when={imgState() === "mismatch"}>
        <p role="alert" class="pr-error">The photo and its stored size do not match, so an outline could not be placed safely. Upload the photo again.</p>
      </Show>

      <div
        ref={stageEl}
        class="pr-stage"
        data-testid="region-stage"
        style={{ "aspect-ratio": `${norm.width} / ${norm.height}` }}
        tabindex="0"
        role="group"
        aria-label="Farm photo with outline. Tap to add points. Press Enter to add a point at the centre."
        aria-describedby="pr-help"
        onClick={onStageClick}
        onKeyDown={onStageKey}
      >
        <img
          class="pr-img"
          src={normalizedUrl(props.media.id)}
          alt="Your farm photo"
          draggable={false}
          onLoad={(e) => {
            const im = e.currentTarget;
            setImgState(sameAspect({ w: im.naturalWidth, h: im.naturalHeight }, imageSize) ? "ready" : "mismatch");
          }}
          onError={() => setImgState("error")}
        />
        <svg class="pr-overlay" width={stage().w} height={stage().h} viewBox={`0 0 ${stage().w} ${stage().h}`} aria-hidden="true">
          <Show when={proposal().length >= 3}>
            <polygon class="pr-proposal-under" points={polyStr(proposal())} />
            <polygon class="pr-proposal" points={polyStr(proposal())} />
          </Show>
          <Show when={cssPoints().length >= 3}>
            <polygon class="pr-poly-under" points={polyStr(cssPoints())} />
            <polygon class="pr-poly" points={polyStr(cssPoints())} data-testid="region-polygon" />
          </Show>
          <Show when={cssPoints().length === 2}>
            <polyline class="pr-poly-under" points={polyStr(cssPoints())} fill="none" />
            <polyline class="pr-line" points={polyStr(cssPoints())} fill="none" />
          </Show>
        </svg>
        {/* Index (not For): handles are keyed by position so focus and pointer capture survive every move. */}
        <Index each={cssPoints()}>
          {(p, i) => (
            <button
              type="button"
              class="pr-handle"
              classList={{ active: active() === i }}
              ref={(el) => (handleEls[i] = el)}
              data-handle={i}
              data-testid="region-handle"
              style={{ left: `${p()[0]}px`, top: `${p()[1]}px` }}
              aria-label={`Point ${i + 1} of ${points().length}. Arrow keys move it. Delete removes it.`}
              onFocus={() => setActive(i)}
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => onHandleDown(e, i)}
              onPointerMove={(e) => onHandleMove(e, i)}
              onPointerUp={onHandleUp}
              onPointerCancel={onHandleUp}
            >
              <span class="pr-dot" aria-hidden="true">{i + 1}</span>
            </button>
          )}
        </Index>
      </div>

      <p class="pr-summary" role="status" aria-live="polite" data-testid="region-summary">
        <Show when={points().length > 0} fallback={<>No outline yet.</>}>
          Outline: {points().length} {points().length === 1 ? "point" : "points"}
          <Show when={points().length >= MIN_POINTS}>, covering about {coverage()}% of the photo</Show>.
          <Show when={savedVersion() !== null && !dirty()}> Saved ({sourceLabel()}).</Show>
          <Show when={dirty() && savedVersion() !== null}> Unsaved changes.</Show>
        </Show>
      </p>
      <Show when={hint()}><p class="pr-hint">{hint()}</p></Show>
      <Show when={points().length > 0 && !validation().ok}>
        <ul class="pr-problems" role="alert">
          <For each={validation().problems}>{(p) => <li>{PROBLEM_TEXT[p]}</li>}</For>
        </ul>
      </Show>

      <div class="pr-toolbar" role="group" aria-label="Outline tools">
        <button type="button" class="btn secondary" onClick={undo} disabled={history().length === 0}>Undo</button>
        <button type="button" class="btn secondary" onClick={clear} disabled={points().length === 0}>Clear</button>
        <button type="button" class="btn secondary" onClick={fourCorners} disabled={!ready()}>Four corners</button>
        <button type="button" class="btn" onClick={save} disabled={!validation().ok || saving() || !dirty() || !ready()} aria-describedby="pr-save-note">
          {saving() ? "Saving…" : "Save outline"}
        </button>
      </div>
      <p id="pr-save-note" class="pr-help">
        <Show when={!validation().ok} fallback={<Show when={!dirty()}>Nothing new to save.</Show>}>Save is available once the outline has at least 3 points and does not cross itself.</Show>
      </p>
      <Show when={saveMsg()}>{(m) => <p role={m().kind === "error" ? "alert" : "status"} class={m().kind === "error" ? "pr-error" : "pr-ok"}>{m().text}</p>}</Show>

      <div class="card pr-ai" aria-labelledby="pr-ai-title">
        <h3 id="pr-ai-title">AI suggestion (optional)</h3>
        <p class="pr-help">The AI can propose an outline for you to confirm or correct. Drawing by hand always works without it.</p>
        <Show when={ai().status === "idle" || ai().status === "message"}>
          <button type="button" class="btn secondary" onClick={suggest} disabled={!ready()}>Suggest region with AI</button>
        </Show>
        <Show when={ai().status === "working"}>
          <p role="status" aria-live="polite">Asking for a suggestion… you can keep drawing meanwhile.</p>
          <button type="button" class="btn secondary" onClick={cancelAi}>Cancel suggestion</button>
        </Show>
        <Show when={(() => { const a = ai(); return a.status === "message" ? a.text : null; })()}>
          {(t) => (
            <p role="status" data-testid="ai-message">
              {t()} Manual outline is still available — tap the photo to draw it.
            </p>
          )}
        </Show>
        <Show when={(() => { const a = ai(); return a.status === "proposal" ? a : null; })()}>
          {(a) => (
            <div data-testid="ai-proposal">
              <p class="pr-ai-label"><strong>{AI_LABEL}</strong></p>
              <p>
                Shown on the photo as a dashed outline ({a().polygon.length} points).
                <Show when={a().score !== null}> Outline score {a().score!.toFixed(2)} describes the outline only, not the crop or its accuracy.</Show>
                <Show when={a().extra > 0}> {a().extra} other candidate{a().extra === 1 ? " was" : "s were"} not shown.</Show>
              </p>
              <div class="pr-toolbar">
                <button type="button" class="btn" onClick={() => void acceptProposal()}>Accept and save this outline</button>
                <button type="button" class="btn secondary" onClick={() => setAi({ status: "idle" })}>Discard suggestion</button>
              </div>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}
