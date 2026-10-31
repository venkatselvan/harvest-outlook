import "./ask.css";
import "../speech/speech.css";
import { For, Show, createSignal } from "solid-js";
import { VoiceInput } from "../speech/VoiceInput";
import { newEntryId } from "../photo-region/http";
import { postTurn } from "./askApi";
import {
  askErrorMessage,
  clarificationFollowUp,
  costLabel,
  provenanceLabel,
  wasWithheld,
  WITHHELD_NOTICE,
  type AskLanguage,
  type TurnRequest,
  type TurnResult,
} from "./model";

export interface AskContext {
  farmId?: string | undefined;
  planId?: string | undefined;
  selectedDate?: string | undefined;
}

function Answer(props: { turn: TurnResult }) {
  const t = () => props.turn;
  const refsOf = (ids: string[]) =>
    t().numericRefs.filter((r) => ids.includes(r.id));
  return (
    <section class="card" aria-label="Answer" data-testid="ask-answer">
      <p>
        <span
          class={`ask-badge ${t().provenance === "meta_live" ? "live" : ""}`}
          data-testid="ask-provenance"
        >
          {provenanceLabel(t().provenance)}
        </span>
      </p>
      <Show when={wasWithheld(t())}>
        <p class="ask-withheld" role="status" data-testid="ask-withheld">
          {WITHHELD_NOTICE}
          <Show when={t().incomplete?.reasons.length}>
            {" "}
            Reasons: {t().incomplete!.reasons.join("; ")}.
          </Show>
        </p>
      </Show>
      <Show
        when={t().answerBlocks.length === 0 && t().clarifications.length === 0}
      >
        <p data-testid="ask-empty">
          No checked answer is available for this question.
        </p>
      </Show>
      <For each={t().answerBlocks}>
        {(b) => (
          <div class={`ask-block ${b.kind}`} data-testid="ask-block">
            <p style={{ margin: 0 }}>{b.text}</p>
            <Show when={refsOf(b.numericRefIds).length > 0}>
              <details class="ask-refs">
                <summary>Where these numbers come from</summary>
                <ul>
                  <For each={refsOf(b.numericRefIds)}>
                    {(r) => (
                      <li>
                        Tool result <code>{r.toolResultId}</code> at{" "}
                        <code>{r.jsonPointer}</code> ({r.presentation.unit})
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
            <Show
              when={
                t().claimEvidenceRefs.filter((c) =>
                  b.claimIds.includes(c.claimId),
                ).length > 0
              }
            >
              <details class="ask-refs">
                <summary>Evidence for this statement</summary>
                <ul>
                  <For
                    each={t().claimEvidenceRefs.filter((c) =>
                      b.claimIds.includes(c.claimId),
                    )}
                  >
                    {(c) => (
                      <li>
                        {c.text} (<code>{c.evidenceIds.join(", ")}</code>)
                      </li>
                    )}
                  </For>
                </ul>
              </details>
            </Show>
          </div>
        )}
      </For>
      <Show when={t().limitations.length > 0}>
        <div data-testid="ask-limitations">
          <h3>Limits of this answer</h3>
          <ul>
            <For each={t().limitations}>{(l) => <li>{l}</li>}</For>
          </ul>
        </div>
      </Show>
      <p class="ask-meta" data-testid="ask-trace">
        Trace id: <code>{t().traceId}</code>
      </p>
      <p class="ask-meta" data-testid="ask-cost">
        {costLabel(t().costEstimate)}
      </p>
    </section>
  );
}

/** Functional assistant turn UI. Presentation polish is deferred (docs/ASK_UI.md). */
export function AskPanel(props: {
  context: AskContext;
  defaultLanguage?: AskLanguage;
}) {
  const [language, setLanguage] = createSignal<AskLanguage>(
    props.defaultLanguage ?? "en",
  );
  const [text, setText] = createSignal("");
  const [useContext, setUseContext] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [turn, setTurn] = createSignal<TurnResult | null>(null);
  const [error, setError] = createSignal<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [asked, setAsked] = createSignal("");
  const [reply, setReply] = createSignal("");
  let pendingKey: string | null = null; // reused when the same text is retried after an error

  const hasContext = () => !!(props.context.farmId || props.context.planId);

  const send = async (question: string) => {
    if (busy() || !question.trim()) return;
    setBusy(true);
    setError(null);
    const sentLanguage = language();
    const body: TurnRequest = { text: question.trim(), language: sentLanguage };
    if (useContext()) {
      if (props.context.farmId) body.farmId = props.context.farmId;
      if (props.context.planId) body.planId = props.context.planId;
      if (props.context.selectedDate)
        body.selectedDate = props.context.selectedDate;
    }
    pendingKey ??= newEntryId("ask");
    try {
      const t = await postTurn(body, pendingKey);
      pendingKey = null;
      setTurn(t);
      setAsked(question.trim());
    } catch (e) {
      const m = askErrorMessage(e);
      if (!m.retryable) pendingKey = null;
      setTurn(null);
      setError(m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="ask-page">
      <form
        class="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          pendingKey = null;
          void send(text());
        }}
      >
        <label for="ask-language">Language</label>
        <select
          id="ask-language"
          value={language()}
          onChange={(e) => setLanguage(e.currentTarget.value as AskLanguage)}
        >
          <option value="en">English</option>
          <option value="ta">தமிழ் (Tamil)</option>
          <option value="hi">हिन्दी (Hindi)</option>
        </select>
        <label for="ask-text">Your question</label>
        <textarea
          lang={language()}
          id="ask-text"
          rows="3"
          maxLength={2000}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <VoiceInput
          language={language()}
          onConfirmText={(v) => setText(v)}
          {...(props.context.farmId ? { farmId: props.context.farmId } : {})}
        />
        <Show when={hasContext()}>
          <label>
            <input
              type="checkbox"
              checked={useContext()}
              onChange={(e) => setUseContext(e.currentTarget.checked)}
            />{" "}
            Use my selected {props.context.planId ? "plan" : "farm"} for this
            question
          </label>
        </Show>
        <button type="submit" class="btn" disabled={busy() || !text().trim()}>
          {busy() ? "Asking…" : "Ask"}
        </button>
      </form>

      <Show when={error()}>
        <p class="ask-error" role="alert" data-testid="ask-error">
          {error()!.message}
          <Show when={!error()!.retryable}>
            {" "}
            <a href="/explore">Go to Explore</a>
          </Show>
        </p>
      </Show>

      <Show when={turn()}>
        {(t) => (
          <>
            <Answer turn={t()} />
            <For each={t().clarifications}>
              {(c) => (
                <div class="card ask-reply" data-testid="ask-clarification">
                  <p>
                    <strong>{c.question}</strong>
                  </p>
                  <Show when={c.options.length > 0}>
                    <div class="ask-options">
                      <For each={c.options}>
                        {(o) => (
                          <button
                            type="button"
                            class="btn secondary"
                            disabled={busy()}
                            onClick={() =>
                              void send(
                                clarificationFollowUp(asked(), c.question, o),
                              )
                            }
                          >
                            {o}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <label for={`ask-reply-${c.id}`}>Your reply</label>
                  <input
                    id={`ask-reply-${c.id}`}
                    value={reply()}
                    onInput={(e) => setReply(e.currentTarget.value)}
                    maxLength={500}
                  />
                  <button
                    type="button"
                    class="btn"
                    disabled={busy() || !reply().trim()}
                    onClick={() => {
                      const r = reply();
                      setReply("");
                      pendingKey = null;
                      void send(clarificationFollowUp(asked(), c.question, r));
                    }}
                  >
                    Send reply
                  </button>
                </div>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  );
}
