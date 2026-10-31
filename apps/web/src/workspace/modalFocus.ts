/** Keep keyboard interaction inside the currently open dialog and restore the trigger on close. */
export function installModalFocus(): () => void {
  let dialog: HTMLElement | null = null;
  let previous: HTMLElement | null = null;
  const focusables = () =>
    dialog
      ? Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
          ),
        ).filter((node) => node.getClientRects().length > 0)
      : [];
  const reconcile = () => {
    const next =
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]',
        ),
      ).at(-1) ?? null;
    if (next === dialog) return;
    if (!next) {
      dialog = null;
      if (previous?.isConnected) previous.focus();
      previous = null;
      return;
    }
    if (!dialog)
      previous =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    dialog = next;
    queueMicrotask(() => focusables()[0]?.focus());
  };
  const keydown = (event: KeyboardEvent) => {
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      dialog
        .querySelector<HTMLButtonElement>(
          '.modal-close, button[aria-label^="Close"]',
        )
        ?.click();
      return;
    }
    if (event.key !== "Tab") return;
    const nodes = focusables();
    if (!nodes.length) return;
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last ||
        !dialog.contains(document.activeElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener("keydown", keydown);
  reconcile();
  return () => {
    observer.disconnect();
    document.removeEventListener("keydown", keydown);
  };
}
