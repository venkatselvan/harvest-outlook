import { Logo } from "./Logo";
import { ModelActivity } from "./ModelActivity";
import { AiUsesButton } from "./ui/AiSpark";
import { installModalFocus } from "./modalFocus";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  type ParentProps,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { WorkspaceProvider, useWorkspace } from "./state";
import { Assistant } from "./Assistant";
import { Icon } from "./icons";
import { capabilitiesState, refreshCapabilities } from "../lib/capabilities";
import { theme, toggleTheme } from "../lib/theme";
import { FarmTabNav, activeFarmTab } from "./farmTabs";

/**
 * Below 768 px the left rail is hidden and the bottom tab bar replaces it. The rail's other destinations
 * (add a farm, crop library, manage farms) live behind this header button instead of a fifth tab.
 */
function MoreMenu(props: { links: { href: string; icon: string; label: string }[] }) {
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  let wrap: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  createEffect(
    on(
      () => location.pathname + location.search,
      () => setOpen(false),
      { defer: true },
    ),
  );
  onMount(() => {
    const away = (event: Event) => {
      if (open() && wrap && !wrap.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("focusin", away);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("focusin", away);
    });
  });
  return (
    <div
      class="more-menu"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open()) {
          setOpen(false);
          button?.focus();
        }
      }}
    >
      <button
        ref={button}
        type="button"
        class="more-menu-button"
        aria-label="More"
        aria-expanded={open()}
        aria-controls="more-menu-panel"
        title="More"
        onClick={() => setOpen(!open())}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="12" cy="19" r="1.8" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="more-menu-panel" id="more-menu-panel">
          <For each={props.links}>
            {(link) => (
              <A href={link.href} class="more-menu-link">
                <Icon name={link.icon} size={18} />
                {link.label}
              </A>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Shell(props: ParentProps) {
  onMount(() => onCleanup(installModalFocus()));
  const s = useWorkspace();
  const location = useLocation();
  const nav = [
    { href: "/farm", icon: "map", label: "Farm workspace" },
    { href: "/farm/setup", icon: "plus", label: "Add a farm" },
    { href: "/catalogue", icon: "leaf", label: "Crop library" },
    { href: "/farm/manage", icon: "settings", label: "Manage farms" },
  ];
  const selectedNav = (href: string) =>
    href === "/farm"
      ? !["/catalogue", "/farm/manage", "/farm/setup"].some((path) =>
          location.pathname.startsWith(path),
        )
      : location.pathname.startsWith(href);
  const activeTab = () => activeFarmTab(location.pathname, location.search);
  /** The bottom tab bar needs a farm to show, and stays out of the way of the add-a-farm wizard. */
  const showTabBar = () =>
    !!s.farm() && !location.pathname.startsWith("/farm/setup");
  createEffect(() => {
    const title =
      nav.find((n) => location.pathname.startsWith(n.href))?.label ??
      "Season explorer";
    document.title = `${title} · Harvest Outlook`;
  });
  void refreshCapabilities();
  createEffect(() => {
    if (s.notice()) {
      const timer = setTimeout(() => s.setNotice(""), 5000);
      onCleanup(() => clearTimeout(timer));
    }
  });
  return (
    <div class="app-shell farm-shell">
      <a class="skip-link" href="#main">
        Skip to content
      </a>
      <aside class="sidebar">
        <A href="/farm" class="brand-lockup" aria-label="Harvest Outlook home">
          <span class="brand-mark">
            <Logo size={38} />
          </span>
          <span>
            Harvest<span>OUTLOOK</span>
          </span>
        </A>
        <div class="workspace-label">YOUR WORKSPACE</div>
        <nav aria-label="Main navigation">
          <For each={nav}>
            {(n) => (
              <A
                href={n.href}
                aria-label={n.label}
                title={n.label}
                class="sidebar-link"
                classList={{ selected: selectedNav(n.href) }}
              >
                <Icon name={n.icon} size={20} />
                <span>{n.label}</span>
                <Show when={n.href === "/farm" && s.farms()?.length}>
                  <small>{s.farms()!.length}</small>
                </Show>
              </A>
            )}
          </For>
        </nav>
        <div class="sidebar-bottom">
          <div
            class="connection-status"
            title={navigator.onLine ? "Browser online" : "Browser offline"}
          >
            <span class="status-dot" />
            <span>
              {navigator.onLine ? "Browser online" : "Working offline"}
            </span>
          </div>
        </div>
      </aside>
      <div class="app-body">
        <header class="topbar">
          <div class="breadcrumbs">
            <span>Workspace</span>
            <span>/</span>
            <strong>
              {location.pathname.includes("/farm/plan/")
                ? "Season explorer"
                : (nav.find((n) => location.pathname.startsWith(n.href))
                    ?.label ?? "Harvest assistant")}
            </strong>
          </div>
          <div class="topbar-actions">
            <button
              class="theme-toggle"
              type="button"
              aria-label="Dark mode"
              aria-pressed={theme() === "dark"}
              title={`Switch to ${theme() === "dark" ? "light" : "dark"} mode`}
              onClick={toggleTheme}
            >
              <Icon name={theme() === "dark" ? "moon" : "sun"} size={18} />
              <span>Dark mode</span>
            </button>
            <Show when={s.farms()?.length}>
              <label class="farm-picker">
                <Icon name="leaf" size={17} />
                <Show
                  when={
                    s.farm()?.facts.demo_prefilled?.value === true ||
                    s.farm()?.facts.demo_illustrative?.value === true
                  }
                >
                  <span class="demo-mini-badge">DEMO BOUNDARY</span>
                </Show>
                <select
                  aria-label="Selected farm"
                  value={s.farm()?.id ?? ""}
                  onChange={(e) => s.selectFarm(e.currentTarget.value)}
                >
                  <For each={s.farms() ?? []}>
                    {(f) => (
                      <option value={f.id} selected={f.id === s.farm()?.id}>
                        {f.name}
                      </option>
                    )}
                  </For>
                </select>
              </label>
            </Show>
            <Show when={capabilitiesState().status === "ready"}>
              <span
                class="runtime-status"
                title="Mode applies to source data and configured providers. Individual unavailable or historical sources are labeled."
              >
                {(() => {
                  const c = capabilitiesState();
                  return c.status === "ready"
                    ? c.envelope.mode.toUpperCase()
                    : "";
                })()}
              </span>
            </Show>
            <span class="today-label">
              {new Date().toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
            <ModelActivity />
            <AiUsesButton />
            <MoreMenu links={nav.slice(1)} />
          </div>
        </header>
        <main id="main" tabindex="-1">
          <Show when={s.workspace.error}>
            <div class="alert-card" role="alert">
              Your farm details could not load.{" "}
              {(s.workspace.error as Error).message}
              <button
                class="text-button"
                onClick={() => void s.refreshWorkspace()}
              >
                Try again
              </button>
            </div>
          </Show>
          {props.children}
        </main>
        <Show when={showTabBar()}>
          <FarmTabNav variant="bottom" current={activeTab} />
        </Show>
      </div>
      <Assistant />
      <Show when={s.notice()}>
        <div class="toast" role="status">
          <Icon name="check" size={17} />
          {s.notice()}
          <button
            aria-label="Dismiss notification"
            onClick={() => s.setNotice("")}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </Show>
    </div>
  );
}
export function WorkspaceShell(props: ParentProps) {
  return (
    <WorkspaceProvider>
      <Shell>{props.children}</Shell>
    </WorkspaceProvider>
  );
}
