import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { apiRequest } from "../features/photo-region/http";
import { foregroundModelRequests } from "../lib/model-activity";
import { useWorkspace } from "./state";
import { Evara } from "./Evara";
interface Invocation {
  id: string;
  provider: string;
  model: string | null;
  requestedModel?: string;
  purpose: string;
  status: string;
  startedAt: string;
  processing?: string;
}
const activityPurpose = (purpose: string | undefined) =>
  purpose?.startsWith("planning_review/")
    ? "Localized crop planning"
    : purpose?.startsWith("soil_report")
      ? "Soil report extraction"
      : purpose?.startsWith("speech") || purpose?.startsWith("voice")
        ? "Voice transcription"
        : purpose?.replace(/_/g, " ");
export function ModelActivity() {
  const s = useWorkspace();
  const [active, setActive] = createSignal<Invocation[]>([]);
  let inflight = false;
  let disposed = false;
  let lastPoll = 0;
  async function poll(force = false) {
    if (
      inflight ||
      disposed ||
      document.hidden ||
      (!force &&
        Date.now() - lastPoll < (foregroundModelRequests() ? 300 : 1500))
    )
      return;
    lastPoll = Date.now();
    inflight = true;
    const epoch = s.sessionEpoch();
    try {
      const data = (
        await apiRequest<{ invocations: Invocation[] }>("/api/v1/ai/activity")
      ).data!;
      if (!disposed && epoch === s.sessionEpoch())
        setActive(
          (data.invocations ?? []).filter(
            (i) =>
              i.provider === "meta" &&
              i.status === "running" &&
              typeof (i.model ?? i.requestedModel) === "string",
          ),
        );
    } catch {
      if (!disposed && epoch === s.sessionEpoch()) setActive([]);
    } finally {
      inflight = false;
    }
  }
  createEffect(() => {
    s.sessionEpoch();
    setActive([]);
    void poll(true);
  });
  createEffect(() => {
    if (foregroundModelRequests()) void poll(true);
  });
  onMount(() => {
    const timer = setInterval(() => void poll(), 350);
    const visible = () => {
      if (!document.hidden) void poll(true);
    };
    document.addEventListener("visibilitychange", visible);
    onCleanup(() => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    });
  });
  return (
    <>
      <button
        class={`evara-topbar ${active().length ? "thinking" : ""}`}
        onClick={() => window.dispatchEvent(new Event("ho:assistant-open"))}
        aria-label="Open Evara"
      >
        <Evara size={29} />
        <span>Evara</span>
        <Show when={active().length}>
          <i class="evara-thinking-dot" />
        </Show>
      </button>
      <Show when={active().length}>
        <aside
          class="model-activity-toast"
          role="status"
          aria-live="polite"
          aria-label="Actual model activity"
        >
          <Evara size={38} />
          <div>
            <strong>
              Evara · Thinking with{" "}
              {active()[0]?.model ?? active()[0]?.requestedModel}
            </strong>
            <span>
              {activityPurpose(active()[0]?.purpose)}
              {active().length > 1 ? ` · ${active().length} active calls` : ""}
            </span>
          </div>
          <span class="activity-pulse">
            <i />
            <i />
            <i />
          </span>
          <details>
            <summary aria-label="Show model invocation details">ⓘ</summary>
            <For each={active()}>
              {(i) => (
                <p>
                  {i.model ?? i.requestedModel} · {activityPurpose(i.purpose)} ·{" "}
                  {i.processing ?? "standard"} processing
                </p>
              )}
            </For>
            <p>
              Reported by the provider invocation tracker. Cached responses do
              not appear here.
            </p>
          </details>
        </aside>
      </Show>
    </>
  );
}
