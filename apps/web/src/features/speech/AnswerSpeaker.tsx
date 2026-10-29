import { createSignal, onCleanup, Show } from "solid-js";
import { ApiError } from "../../lib/api";
import { fetchSynthesis } from "./speechApi";
import { speakerReducer, type SpeakerEvent, type SpeakerState, type SpeechLang } from "./speechMachine";
import "./speech.css";

export interface AnswerSpeakerProps {
  /** The approved answer text, exactly as issued by the assistant route. */
  text: string;
  /** sha256 hex of `text` issued by the assistant route in this session. */
  approvedTextHash: string;
  language: SpeechLang;
}

/** Speaks only the approved answer. The answer stays visible as text whatever happens here. */
export function AnswerSpeaker(props: AnswerSpeakerProps) {
  const [state, setState] = createSignal<SpeakerState>({ kind: "idle" });
  const dispatch = (e: SpeakerEvent) => setState((s) => speakerReducer(s, e));
  let audio: HTMLAudioElement | undefined;
  let url: string | null = null;
  let abort: AbortController | null = null;

  const revoke = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  onCleanup(() => {
    abort?.abort();
    audio?.pause();
    revoke();
  });

  const play = async () => {
    if (state().kind === "paused") {
      void audio?.play();
      dispatch({ type: "play" });
      return;
    }
    dispatch({ type: "play" });
    abort = new AbortController();
    try {
      const blob = await fetchSynthesis({ text: props.text, language: props.language, approvedTextHash: props.approvedTextHash }, abort.signal);
      revoke();
      url = URL.createObjectURL(blob);
      if (!audio) return;
      audio.src = url;
      await audio.play();
      dispatch({ type: "loaded" });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      dispatch({ type: "fail", ...(e instanceof ApiError ? { code: e.code } : {}) });
    }
  };
  const pause = () => {
    audio?.pause();
    dispatch({ type: "pause" });
  };
  const stop = () => {
    abort?.abort();
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    dispatch({ type: "stop" });
  };

  const kind = () => state().kind;
  return (
    <div class="speech-speaker">
      <div class="speech-actions">
        <Show
          when={kind() === "playing"}
          fallback={
            <button type="button" class="btn" disabled={kind() === "loading"} onClick={() => void play()} aria-label="Listen to this answer">
              {kind() === "loading" ? "Loading audio…" : kind() === "paused" ? "Resume" : "Listen"}
            </button>
          }
        >
          <button type="button" class="btn" onClick={pause} aria-label="Pause audio">
            Pause
          </button>
        </Show>
        <Show when={kind() === "playing" || kind() === "paused" || kind() === "loading"}>
          <button type="button" class="btn speech-secondary" onClick={stop} aria-label="Stop audio">
            Stop
          </button>
        </Show>
      </div>
      <p class="speech-note">Spoken from the approved answer</p>
      <Show when={state().kind === "error"}>
        <p class="speech-error" role="alert">
          {(state() as Extract<SpeakerState, { kind: "error" }>).message}
        </p>
      </Show>
      <audio ref={audio} onEnded={() => dispatch({ type: "ended" })} onError={() => dispatch({ type: "fail" })} />
    </div>
  );
}
