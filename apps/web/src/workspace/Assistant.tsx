import { Evara } from "./Evara";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { Icon } from "./icons";
import { getOwnerScope } from "../features/offline/scope";
import { chatPrefix, loadChats, reviveMessages, type Chat, type ChatMessage as Message } from "../features/ask/chatHistory";
import "./assistant.css";
import { today, useWorkspace } from "./state";
import { postTurn } from "../features/ask/askApi";
import {
  ASSISTANT_PROMPTS,
  askErrorMessage,
  assistantTurnBody,
  assistantWelcomeText,
  provenanceLabel,
  turnAnswerText,
  turnUi,
  type AskLanguage,
  wasWithheld,
} from "../features/ask/model";
import { newEntryId } from "../features/photo-region/http";
import { selectedTab, tabField } from "./farmTabs";
import { EvaraActions, EvaraUiView, hasProse } from "./evara/EvaraUi";
import { PlanCropSheet } from "./evara/PlanCropSheet";
import type { EvaraContext, LocalAssistantMessage, PlanCropRequest } from "./evara/actions";
import {
  InlineMicControl,
  InlineMicMessages,
  InlineMicNotice,
  createInlineMic,
  insertTranscript,
} from "../features/speech/InlineMic";
import "../features/speech/speech.css";
const MESSAGE_LIMIT = 800;
export function Assistant() {
  const s = useWorkspace();
  /**
   * The field selected in the shell (`?field=`, published by the command center; null off the farm tabs). Only a field of
   * the selected farm's stored workspace counts, so a stale id never reaches the server (12.5).
   */
  const selectedField = () => {
    const id = tabField();
    const ws = s.workspace.error ? undefined : s.workspace();
    if (!id || !ws || ws.farmId !== s.farm()?.id) return null;
    return ws.fields?.find((field) => field.id === id) ?? null;
  };
  const loc = useLocation();
  const navigate = useNavigate();
  let ownerScope = getOwnerScope();
  let uiKey = `ho.chat.ui.${ownerScope}`;
  let savedUi: {open?: boolean; expanded?: boolean; activeId?: string} = {};
  try { savedUi = JSON.parse(sessionStorage.getItem(uiKey) ?? '{}'); } catch {}
  const [open, setOpen] = createSignal(!!savedUi.open);
  const [expanded, setExpanded] = createSignal(!!savedUi.expanded);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  const [historyFilter, setHistoryFilter] = createSignal('all');
  const [chats, setChats] = createSignal<Chat[]>((() => { try { return loadChats(localStorage, ownerScope); } catch { return []; } })());
  const [activeId, setActiveId] = createSignal(savedUi.activeId ?? '');
  const currentChat = createMemo(() => chats().find(c => c.id === activeId()));
  const messages = createMemo(() => currentChat()?.messages ?? []);
  const text = () => currentChat()?.draft ?? '';
  const language = () => currentChat()?.language ?? 'en';
  const [pending, setPending] = createSignal<string[]>([]);
  const busy = () => pending().includes(activeId());
  const [errors, setErrors] = createSignal<Record<string, string>>({});
  const error = () => errors()[activeId()] ?? '';
  const setError = (value: string) => setErrors(e => ({...e, [activeId()]: value}));
  let disposed = false;
  const updateChat = (id: string, patch: Partial<Chat>) => {
    setChats(list => list.map(c => c.id === id ? {...c, ...patch} : c));
    const chat = chats().find(c => c.id === id);
    if (chat) try { localStorage.setItem(`${chatPrefix(ownerScope)}${id}`, JSON.stringify(chat)); } catch {}
  };
  const setMessages = (value: Message[]) => updateChat(activeId(), {messages: value, updatedAt: new Date().toISOString()});
  const setText = (draft: string) => updateChat(activeId(), {draft});
  const setLanguage = (value: AskLanguage) => updateChat(activeId(), {language: value});
  const makeChat = (farmId: string | null, farmName: string, imported: Message[] = []) => {
    const now = new Date().toISOString();
    const chat: Chat = {id: newEntryId('conversation'), farmId, farmName, title: imported.find(m => m.role === 'user')?.text.slice(0, 80) ?? 'New chat', createdAt: now, updatedAt: now, messages: imported, draft: '', language: 'en'};
    setChats(list => [chat, ...list]);
    setActiveId(chat.id);
    updateChat(chat.id, {});
    return chat;
  };
  const newChat = () => {
    makeChat(s.farm()?.id ?? null, s.farm()?.name ?? 'General');
    setHistoryOpen(false);
    setSheet(null);
    mic.cancel();
  };
  const visibleChats = () => chats().filter(c => (c.messages.length || c.draft) && (historyFilter() === 'all' || c.farmId === historyFilter())).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  const historyFarms = () => [...new Map(chats().filter(c => c.farmId).map(c => [c.farmId!, c.farmName])).entries()];
  const resumeChat = (chat: Chat) => {
    setActiveId(chat.id);
    if (chat.farmId) s.selectFarm(chat.farmId);
    setHistoryOpen(false);
    setSheet(null);
    mic.cancel();
  };
  createEffect(() => {
    try {
      if (!activeId()) { sessionStorage.removeItem(uiKey); return; }
      sessionStorage.setItem(uiKey, JSON.stringify({open: open(), expanded: expanded(), activeId: activeId()}));
    } catch {}
  });
  /** The Plan-this-crop sheet an Evara action opened (nothing is written until its confirm button). */
  const [sheet, setSheet] = createSignal<PlanCropRequest | null>(null);
  let scroll: HTMLDivElement | undefined;
  let composer: HTMLTextAreaElement | undefined;
  const mic = createInlineMic({
    language,
    farmId: () => s.farm()?.id,
    onTranscript: (transcript) => {
      const current = composer?.value ?? text();
      const at = composer?.selectionStart ?? current.length;
      const to = composer?.selectionEnd ?? at;
      const next = insertTranscript(current, transcript, at, to, MESSAGE_LIMIT);
      setText(next.value);
      queueMicrotask(() => {
        if (!composer) return;
        composer.value = next.value;
        composer.focus();
        composer.setSelectionRange(next.caret, next.caret);
      });
      return next.truncated
        ? `The transcript was shortened to fit ${MESSAGE_LIMIT} characters.`
        : undefined;
    },
  });
  const sessionEnded = () => {
    setChats([]); setActiveId(''); setPending([]); setErrors({});
    setOpen(false); setHistoryOpen(false); setSheet(null); mic.cancel();
    try {
      for (const storage of [localStorage, sessionStorage])
        for (const key of Object.keys(storage)) if (key.startsWith('ho.chat.')) storage.removeItem(key);
    } catch {}
  };
  const ask = (event: Event) => {
    const question = (event as CustomEvent<{ text?: unknown }>).detail?.text;
    if (typeof question === "string" && question.trim()) {
      openAssistant();
      setText(question.trim().slice(0, 800));
      setError("");
    }
  };
  const openAssistant = () => {
    if (!currentChat()) makeChat(s.farm()?.id ?? null, s.farm()?.name ?? 'General');
    setOpen(true);
  };
  const localDataPurged = () => {
    sessionEnded();
    ownerScope = getOwnerScope();
    uiKey = `ho.chat.ui.${ownerScope}`;
  };
  window.addEventListener("ho:assistant-open", openAssistant);
  window.addEventListener("ho:session-ended", sessionEnded);
  window.addEventListener("ho:local-data-purged", localDataPurged);
  window.addEventListener("ho:ask", ask);
  onCleanup(() => {
    disposed = true;
    window.removeEventListener("ho:session-ended", sessionEnded);
    window.removeEventListener("ho:local-data-purged", localDataPurged);
    window.removeEventListener("ho:ask", ask);
    window.removeEventListener("ho:assistant-open", openAssistant);
  });
  // A memo avoids resetting the chat when farm records refresh with the same id.
  const farmId = createMemo(() => s.farm()?.id ?? null);
  createEffect(on([farmId, s.sessionEpoch], ([id]) => {
    if (!id && s.farms.loading) return;
    untrack(() => {
      // Adopt every old per-farm session chat so All chats includes farms not visited yet.
      const selectedChat = activeId();
      try {
        const legacyScope = sessionStorage.getItem('ho.chat.sessionScope');
        const prefix = `ho.chat.${legacyScope}.`;
        for (const key of Object.keys(sessionStorage).filter(k => k.startsWith(prefix))) {
          const legacy = reviveMessages(JSON.parse(sessionStorage.getItem(key) ?? '[]'));
          if (!legacy.length) continue;
          const oldFarm = key.slice(prefix.length);
          const farm = s.farms()?.find(f => f.id === oldFarm);
          const chat = makeChat(oldFarm === 'general' ? null : oldFarm, farm?.name ?? 'General', legacy);
          if (localStorage.getItem(`${chatPrefix(ownerScope)}${chat.id}`)) sessionStorage.removeItem(key);
        }
      } catch {}
      if (chats().some(c => c.id === selectedChat)) setActiveId(selectedChat);
      if (currentChat()?.farmId === id) return;
      const latest = chats().filter(c => c.farmId === id).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (latest) setActiveId(latest.id);
      else makeChat(id, s.farm()?.name ?? 'General');
      setSheet(null); mic.cancel();
    });
  }));
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
    if (!question || busy() || mic.busy()) return;
    const farmId = currentChat()?.farmId ?? undefined;
    const epoch = s.sessionEpoch();
    const chatId = activeId();
    const requestLanguage = language();
    const fieldId = farmId ? selectedField()?.id : undefined;
    const planId = loc.pathname.includes("/farm/plan/")
      ? loc.pathname.split("/").pop()
      : undefined;
    const active = () => !disposed && epoch === s.sessionEpoch() && chats().some(c => c.id === chatId);
    setError("");
    setText("");
    mic.reset();
    const previous = messages();
    setMessages([...previous, { role: "user", text: question }]);
    updateChat(chatId, {title: previous.length ? currentChat()!.title : question.slice(0, 80)});
    setPending(ids => [...ids, chatId]);
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
      result.ui = turnUi(result.ui);
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
      updateChat(chatId, {messages: next, updatedAt: new Date().toISOString()});
    } catch (e) {
      if (active()) {
        setErrors(errors => ({...errors, [chatId]: askErrorMessage(e).message}));
        updateChat(chatId, {draft: question});
      }
    } finally {
      if (active()) setPending(ids => ids.filter(id => id !== chatId));
    }
  }
  /** The workspace of the selected farm, or undefined while it loads or when it belongs to another farm. */
  const currentWorkspace = () => {
    const ws = s.workspace.error ? undefined : s.workspace();
    return ws && ws.farmId === currentChat()?.farmId ? ws : undefined;
  };
  /**
   * What Evara's actions run against (workspace/evara/actions.ts). Getters, so a message rendered earlier still acts on the
   * farm, field and language that are current when the farmer taps.
   */
  const evaraCtx: EvaraContext = {
    get farmId() {
      return currentChat()?.farmId ?? null;
    },
    get fieldId() {
      return currentChat()?.farmId ? selectedField()?.id ?? null : null;
    },
    get language() {
      return language();
    },
    get tab() {
      return selectedTab(loc.pathname, new URLSearchParams(loc.search).get("tab") ?? undefined);
    },
    today,
    rotationPlans: () => currentWorkspace()?.rotationPlans,
    cycles: () => currentWorkspace()?.cycles,
    fields: () => currentWorkspace()?.fields ?? [],
    cropName: s.cropName,
    fieldBoundary: () => selectedField()?.boundary ?? null,
    productIdFor: (cropId) => s.crops()?.find((c) => c.cropId === cropId)?.products[0]?.productId ?? null,
    save: (patch) => s.saveWorkspace(patch),
    refreshWorkspace: () => s.refreshWorkspace(),
    notify: (text) => s.setNotice(text),
    say: (m: LocalAssistantMessage) => {
      const next: Message[] = [...messages(), { role: "assistant" as const, text: m.text, actions: m.actions, language: m.language }];
      setMessages(next);
    },
    ask: (question) => void send(question),
    navigate: (href) => {
      navigate(href);
    },
    writeCompareSelection: (farmId, productIds) => {
      const saved = s.loadCompareSelection(farmId);
      s.rememberCompareSelection(farmId, { productIds, date: saved?.date ?? today(), manualProducts: true, manualDate: saved?.manualDate ?? false });
    },
    openSheet: (request) => setSheet(request),
    // Replaced per message by EvaraUiView, which knows the tree the journey belongs to.
    showJourney: () => undefined,
  };
  return (
    <>
      <Show when={open()}>
        <aside class="assistant-panel" classList={{"is-expanded": expanded()}} aria-label="Evara farm assistant">
          <div class="assistant-header">
            <div class="assistant-avatar">
              <Evara size={38} />
            </div>
            <div>
              <strong>Evara</strong>
              <span>{currentChat()?.farmName ?? "Let's get growing"}</span>
            </div>
            <button type="button" class="icon-button" aria-label={expanded() ? 'Collapse assistant' : 'Expand assistant'} aria-pressed={expanded()} onClick={() => setExpanded(v => !v)}><Icon name={expanded() ? 'collapse' : 'expand'} size={18}/></button>
            <button
              class="icon-button"
              aria-label="Close assistant"
              onClick={() => setOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <div class="assistant-chat-tools">
            <button type="button" class="text-button" aria-pressed={historyOpen()} onClick={() => setHistoryOpen(v => !v)}><Icon name="history" size={16}/> Chat history</button>
            <button type="button" class="text-button" onClick={newChat}><Icon name="plus" size={16}/> New chat</button>
          </div>
          <Show when={historyOpen()} fallback={<></>}>
            <section class="assistant-history" aria-label="Chat history">
              <div class="assistant-history-filters" role="group" aria-label="Filter chats">
                <button type="button" aria-pressed={historyFilter() === 'all'} onClick={() => setHistoryFilter('all')}>All chats</button>
                <For each={historyFarms()}>{([id, name]) => <button type="button" aria-pressed={historyFilter() === id} onClick={() => setHistoryFilter(id)}>{name}</button>}</For>
              </div>
              <p class="assistant-history-note">Saved on this device.</p>
              <Show when={visibleChats().length} fallback={<p>No chats in this view yet.</p>}>
                <For each={visibleChats()}>{chat => <button type="button" class="assistant-history-item" aria-current={chat.id === activeId() ? 'true' : undefined} onClick={() => resumeChat(chat)}>
                  <strong>{chat.title}</strong><span>{chat.farmName} · {new Date(chat.updatedAt).toLocaleDateString('en-IN', {day: 'numeric', month: 'short'})}{pending().includes(chat.id) ? ' · Replying…' : ''}</span>
                  <small>{chat.messages.at(-1)?.text.slice(0, 110) ?? chat.draft}</small>
                </button>}</For>
              </Show>
            </section>
          </Show>
          <div class="assistant-messages" classList={{'assistant-hidden': historyOpen()}} ref={scroll} aria-live="polite">
            <Show when={!messages().length}><div class="assistant-welcome">
              <span class="eyebrow">A LITTLE HELP IN THE FIELD</span>
              <div class="evara-welcome-title">
                <Evara size={76} />
                <h3>Hi, I'm Evara.</h3>
              </div>
              <p>{assistantWelcomeText(currentChat()?.farmId ? currentChat()?.farmName : undefined, currentChat()?.farmId ? selectedField()?.name : undefined)}</p>
            </div>
            </Show>
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
                  <Show when={m.turn?.ui} fallback={<p>{m.text}</p>}>
                    {(ui) => (
                      <>
                        <Show when={!hasProse(ui())}>
                          <p>{m.text}</p>
                        </Show>
                        <EvaraUiView ui={ui()} ctx={evaraCtx} language={m.language} />
                      </>
                    )}
                  </Show>
                  <Show when={m.actions?.length}>
                    <EvaraActions actions={m.actions!} ctx={evaraCtx} />
                  </Show>
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
            class="assistant-compose" classList={{"assistant-hidden": historyOpen()}}
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
            </div>
            <InlineMicNotice mic={mic} />
            <div class="compose-input" classList={{ "mic-active": mic.busy() }}>
              <textarea
                ref={composer}
                aria-label="Message Evara"
                rows="2"
                maxLength={MESSAGE_LIMIT}
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
              <InlineMicControl mic={mic} />
              <button
                type="submit"
                class="send-button"
                disabled={busy() || mic.busy() || !text().trim()}
                aria-label="Send message"
              >
                <Icon name="arrow" />
              </button>
            </div>
            <InlineMicMessages mic={mic} />
            <small>
              Uses this chat’s farm. Guidance depends on available evidence.
            </small>
          </form>
        </aside>
      </Show>
      <Show when={sheet()}>
        {(request) => <PlanCropSheet ctx={evaraCtx} request={request()} onClose={() => setSheet(null)} />}
      </Show>
      <button
        class={`assistant-launcher ${open() ? "open" : ""}`}
        onClick={() => open() ? setOpen(false) : openAssistant()}
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
