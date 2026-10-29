import { createEffect, createRoot } from "solid-js";
import { render } from "solid-js/web";
import { StaleLabel } from "../../components/StaleLabel";
import { isOnline, staleAt, staleKeys } from "./status";

/**
 * Adds offline cues to screens this module does not own, without editing them (see docs/UI_ISSUES.md: a native
 * integration is the better long-term shape). Idempotent: running it twice changes nothing.
 *  - plan page: a StaleLabel on every panel when the plan came from a snapshot; "Generate illustrations" disabled
 *    with an explanation whenever the plan is stale or the device is offline;
 *  - journal page: StaleLabel on the timeline when it came from a snapshot; actions inside the timeline (analysis,
 *    accept/reject/confirm) disabled while offline, with an explanation. Saving a new entry stays enabled (it queues).
 */
const disposers = new WeakMap<Element, () => void>();
const NOTE_ID = "offline-action-note";

function mountLabel(host: Element, fetchedAt: number): void {
  if (host.querySelector(":scope > [data-offline-label]")) return;
  const box = document.createElement("div");
  box.setAttribute("data-offline-label", "");
  host.prepend(box);
  disposers.set(box, render(() => <StaleLabel fetchedAt={fetchedAt} />, box));
}
function unmountLabels(): void {
  document.querySelectorAll("[data-offline-label]").forEach((box) => {
    disposers.get(box)?.();
    box.remove();
  });
}

function setDisabled(btn: HTMLButtonElement, off: boolean, noteId: string): void {
  if (off) {
    if (!btn.hasAttribute("data-offline-disabled")) {
      btn.setAttribute("data-offline-disabled", btn.disabled ? "was" : "set");
      btn.disabled = true;
      btn.setAttribute("aria-describedby", noteId);
    }
  } else if (btn.hasAttribute("data-offline-disabled")) {
    if (btn.getAttribute("data-offline-disabled") === "set") btn.disabled = false;
    btn.removeAttribute("data-offline-disabled");
    if (btn.getAttribute("aria-describedby") === noteId) btn.removeAttribute("aria-describedby");
  }
}

function ensureNote(after: Element, id: string, text: string, on: boolean): void {
  const existing = document.getElementById(id);
  if (!on) return void existing?.remove();
  if (existing) return;
  const p = document.createElement("p");
  p.id = id;
  p.className = "offline-note";
  p.setAttribute("data-testid", id);
  p.textContent = text;
  after.after(p);
}

export function applyOfflineCues(): void {
  const online = isOnline();
  const path = location.pathname;
  const plan = /^\/farm\/plan\/([^/]+)/.exec(path);
  const planStale = plan ? staleAt(`plan:${decodeURIComponent(plan[1]!)}`) : undefined;

  unmountLabelsIfNotNeeded(planStale !== undefined || (path === "/journal" && staleKeys().some((k) => k.includes("/journal"))));

  if (plan) {
    if (planStale !== undefined) document.querySelectorAll(".se-page .se-panel, .se-page .se-summary").forEach((p) => mountLabel(p, planStale));
    const gen = document.querySelector<HTMLButtonElement>('[data-testid="generate-illustrations"]');
    if (gen) {
      const off = !online || planStale !== undefined;
      setDisabled(gen, off, `${NOTE_ID}-gen`);
      ensureNote(gen, `${NOTE_ID}-gen`, "Generating illustrations needs the server. It is unavailable while you are offline or viewing a saved copy. Your saved illustrations and plan stay readable.", off);
    }
  }
  if (path === "/journal") {
    const tl = document.querySelector(".jr-timeline");
    if (tl) {
      const jk = staleKeys().find((k) => k.includes("/journal"));
      const at = jk ? staleAt(jk) : undefined;
      if (at !== undefined) mountLabel(tl, at);
      tl.querySelectorAll<HTMLButtonElement>("button").forEach((b) => setDisabled(b, !online || at !== undefined, `${NOTE_ID}-jr`));
      const heading = tl.querySelector("h2");
      if (heading) ensureNote(heading, `${NOTE_ID}-jr`, "Analysis and confirming changes need the server, so they are paused while you are offline or viewing a saved copy.", !online || at !== undefined);
    }
  }
}

function unmountLabelsIfNotNeeded(needed: boolean): void {
  if (!needed) unmountLabels();
}

export function startDecorator(): void {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyOfflineCues();
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  createRoot(() => createEffect(() => {
    isOnline();
    staleKeys();
    schedule();
  }));
  window.addEventListener("popstate", schedule);
}
