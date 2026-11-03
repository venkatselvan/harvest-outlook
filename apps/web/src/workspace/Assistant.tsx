import { Evara } from "./Evara";
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { useLocation } from "@solidjs/router";
import { Icon } from "./icons";
import { AiSpark } from "./ui/AiSpark";
import { useWorkspace } from "./state";
import { postTurn } from "../features/ask/askApi";
import {
  ASSISTANT_PROMPTS,
  askErrorMessage,
  assistantTurnBody,
  assistantWelcomeText,
  provenanceLabel,
  turnAnswerText,
  type AskLanguage,
  type TurnResult,
  wasWithheld,
} from "../features/ask/model";
import { newEntryId } from "../features/photo-region/http";
import { tabField } from "./farmTabs";
import { VoiceInput } from "../features/speech/VoiceInput";
import "../features/speech/speech.css";
interface Message {
  role: "user" | "assistant";
  text: string;
  turn?: TurnResult;
  language?: AskLanguage;
}
export function Assistant() {
  const s = useWorkspace();
  /**
   * The field selected in the shell (`?field=`, published by the command center; null off the farm tabs). Only a field of
   * the selected farm's stored workspace counts, so a stale id never reaches the server (12.5).
   */
  const selectedField = () => {
    const id = tabField();
    const ws = s.workspace();
    if (!id || !ws || ws.farmId !== s.farm()?.id) return null;
    return ws.fields?.find((field) => field.id === id) ?? null;
  };
  const loc = useLocation();
  const [open, setOpen] = createSignal(false);
  const [messages, setMessages] = createSignal<Message[]>([]);
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [language, setLanguage] = createSignal<AskLanguage>("en");
  const [voice, setVoice] = createSignal(false);
  let scroll: HTMLDivElement | undefined;
  let requestSequence = 0;
  let scope = "";
  const ensureScope = () => {
    if (scope) return scope;
    try {
      scope =
        sessionStorage.getItem("ho.chat.sessionScope") ?? newEntryId("session");
      sessionStorage.setItem("ho.chat.sessionScope", scope);
    } catch {
      scope = newEntryId("session");
    }
    return scope;
  };
  const storageKey = () =>
    `ho.chat.${ensureScope()}.${s.farm()?.id ?? "general"}`;
  const clearMessages = () => {
    ++requestSequence;
    setBusy(false);
    setMessages([]);
    try {
      sessionStorage.removeItem(storageKey());
    } catch {}
  };
  const sessionEnded = () => {
    ++requestSequence;
    scope = "";
    setBusy(false);
    setMessages([]);
    setText("");
    setError("");
    setVoice(false);
    try {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("ho.chat.")) sessionStorage.removeItem(key);
    } catch {}
  };
  const ask = (event: Event) => {
    const question = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (typeof question === "string" && question.trim()) {
      setOpen(true);
      setText(question.trim().slice(0, 800));
      setError("");
    }
  };
  const openAssistant = () => setOpen(true);
  window.addEventListener("ho:assistant-open", openAssistant);
  window.addEventListener("ho:session-ended", sessionEnded);
  window.addEventListener("ho:ask", ask);
  onCleanup(() => {
    ++requestSequence;
    window.removeEventListener("ho:session-ended", sessionEnded);
    window.removeEventListener("ho:ask", ask);
    window.removeEventListener("ho:assistant-open", openAssistant);
  });
  createEffect(
    on([() => s.farm()?.id, s.sessionEpoch], () => {
      ++requestSequence;
      setBusy(false);
      setText("");
      setVoice(false);
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey()) ?? "[]");
        setMessages(
          Array.isArray(saved)
            ? saved
                .filter(
                  (m: Message) =>
                    m &&
                    ["user", "assistant"].includes(m.role) &&
                    typeof m.text === "string",
                )
                .slice(-40)
            : [],
        );
      } catch {
        setMessages([]);
      }
      setError("");
    }),
  );
  createEffect(() => {
    messages();
    queueMicrotask(() =>
      scroll?.scrollTo({ top: scroll.scrollHeight, behavior: "smooth" }),
    );
  });
  createEffect(() => {
    if (loc.pathname === "/ask") setOpen(true);
  });
  async function send(question: string) {
    question = question.trim().slice(0, 800);
    if (!question || busy()) return;
    const farmId = s.farm()?.id;
    const epoch = s.sessionEpoch();
    const key = storageKey();
    const requestLanguage = language();
    const fieldId = selectedField()?.id;
    const planId = loc.pathname.includes("/farm/plan/")
      ? loc.pathname.split("/").pop()
      : undefined;
    const request = ++requestSequence;
    const active = () =>
      request === requestSequence &&
      epoch === s.sessionEpoch() &&
      s.farm()?.id === farmId;
    setError("");
    setText("");
    const previous = messages();
    setMessages([...previous, { role: "user", text: question }]);
    setBusy(true);
    try {
      const context = previous
        .slice(-4)
        .map((m) => `${m.role}: ${m.text}`)
        .join("\n");
      const result = await postTurn(
        assistantTurnBody({
          text: context
            ? `Recent conversation:\n${context.slice(-1100)}\nCurrent question: ${question}`.slice(
                -2000,
              )
            : question,
          language: requestLanguage,
          farmId,
          fieldId: fieldId ?? null,
          planId,
        }),
        newEntryId("chat"),
      );
      if (!active()) return;
      const answer = turnAnswerText(result);
      const next: Message[] = [
        ...previous,
        { role: "user", text: question },
        {
          role: "assistant",
          text: answer,
          turn: result,
          language: requestLanguage,
        },
      ];
      setMessages(next);
      try {
        sessionStorage.setItem(key, JSON.stringify(next));
      } catch {}
    } catch (e) {
      if (active()) {
        setError(askErrorMessage(e).message);
        setText(question);
      }
    } finally {
      if (active()) setBusy(false);
    }
  }
  return (
    <>
      <Show when={open()}>
        <aside class="assistant-panel" aria-label="Evara farm assistant">
          <div class="assistant-header">
            <div class="assistant-avatar">
              <Evara size={38} />
            </div>
            <div>
              <strong>Evara</strong>
              <span>{s.farm()?.name ?? "Let's get growing"}</span>
            </div>
            <AiSpark use="assistant" />
            <button
              class="icon-button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <div class="assistant-messages" ref={scroll} aria-live="polite">
            <div class="assistant-welcome">
              <span class="eyebrow">A LITTLE HELP IN THE FIELD</span>
              <div class="evara-welcome-title">
                <Evara size={61} />
                <h3>Hi, I'm Evara.</h3>
              </div>
              <p>{assistantWelcomeText(s.farm()?.name, selectedField()?.name)}</p>
            </div>
            <Show when={!messages().length}>
              <div class="assistant-prompts">
                <For each={ASSISTANT_PROMPTS}>
                  {(q) => (
                    <button onClick={() => void send(q)}>
                      {q}
                      <Icon name="arrow" size={15} />
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <For each={messages()}>
              {(m) => (
                <div class={`chat-message ${m.role}`}>
                  <Show when={m.role === "assistant"}>
                    <span class="chat-role">
                      <Evara size={19} /> EVARA
                    </span>
                  </Show>
                  <p>{m.text}</p>
                  <Show when={m.turn}>
                    <div class="chat-evidence">
                      <span>{provenanceLabel(m.turn!.provenance)}</span>
                      <Show when={wasWithheld(m.turn!)}>
                        <p>
                          Only statements checked against available data are
                          shown.
                        </p>
                      </Show>
                      <Show when={m.turn!.limitations.length}>
                        <details>
                          <summary>Sources & limitations</summary>
                          <For each={m.turn!.limitations}>
                            {(l) => <p>{l}</p>}
                          </For>
                          <p>Reference: {m.turn!.traceId}</p>
                        </details>
                      </Show>
                      <For each={m.turn!.clarifications}>
                        {(c) => (
                          <div class="clarification">
                            <p>{c.question}</p>
                            <For each={c.options}>
                              {(o) => (
                                <button
                                  onClick={() =>
                                    void send(`${c.question} ${o}`)
                                  }
                                >
                                  {o}
                                </button>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <Show when={busy()}>
              <div class="chat-thinking">
                <span />
                <span />
                <span /> Checking your farm's context…
              </div>
            </Show>
            <Show when={error()}>
              <p class="inline-error" role="alert">
                {error()}
              </p>
            </Show>
          </div>
          <form
            class="assistant-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text());
            }}
          >
            <div class="assistant-options">
              <select
                aria-label="Assistant language"
                value={language()}
                onChange={(e) =>
                  setLanguage(e.currentTarget.value as AskLanguage)
                }
              >
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
                <option value="ta">தமிழ்</option>
              </select>
              <button
                type="button"
                class="text-button"
                onClick={() => setVoice(!voice())}
              >
                Voice input
              </button>
              <AiSpark use="speech" />
              <Show when={messages().length}>
                <button
                  type="button"
                  class="text-button"
                  onClick={clearMessages}
                >
                  Clear
                </button>
              </Show>
            </div>
            <Show when={voice()}>
              <VoiceInput
                language={language()}
                onConfirmText={setText}
                {...(s.farm() ? { farmId: s.farm()!.id } : {})}
              />
            </Show>
            <div class="compose-input">
              <textarea
                aria-label="Message Evara"
                rows="2"
                maxLength="800"
                lang={language()}
                placeholder="Ask anything about your farm…"
                value={text()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(text());
                  }
                }}
              />
              <button
                type="submit"
                class="send-button"
                disabled={busy() || !text().trim()}
                aria-label="Send message"
              >
                <Icon name="arrow" />
              </button>
            </div>
            <small>
              Uses your selected farm. Guidance depends on available evidence.
            </small>
          </form>
        </aside>
      </Show>
      <button
        class={`assistant-launcher ${open() ? "open" : ""}`}
        onClick={() => setOpen(!open())}
        aria-label={open() ? "Close Evara" : "Open Evara"}
      >
        <Show when={open()} fallback={<Evara size={32} />}>
          <Icon name="close" size={23} />
        </Show>
        <Show when={!open()}>
          <span>Ask Evara</span>
          <span class="assistant-launcher-dot" />
        </Show>
      </button>
    </>
  );
}
