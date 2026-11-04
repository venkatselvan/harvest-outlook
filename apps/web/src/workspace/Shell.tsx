import { Logo } from "./Logo";
import { Evara } from "./Evara";
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
import { activeFarmTab, farmHref, tabField, dueBadge } from "./farmTabs";
import { WorkspaceBackdrop } from "./WorkspaceBackdrop";

/**
 * Secondary destinations share this anchored header disclosure on desktop and mobile.
 * Native links keep their normal Tab order; Escape, focus leaving and outside pointer presses close it.
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
              <a href={link.href} class="more-menu-link">
                <Icon name={link.icon} size={18} />
                {link.label}
              </a>
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
  const safeFarms = () => s.farms.error ? [] : s.farms() ?? [];
  const nav = [
    { href: "/farm?tab=today", icon: "grid", label: "Today" },
    { href: "/farms", icon: "leaf", label: "All farms" },
  ];
  const moreLinks = () => [
    { href: farmHref("year", undefined, tabField()), icon: "calendar", label: "Plan" },
    { href: farmHref("harvest", undefined, tabField()), icon: "trend", label: "Market" },
    { href: farmHref("soil", undefined, tabField()), icon: "leaf", label: "Farm · crop fit" },
    { href: farmHref("soil", "records", tabField()), icon: "journal", label: "Soil records" },
    { href: farmHref("soil", "activity", tabField()), icon: "journal", label: "Activity & journal" },
    { href: "/farm/setup", icon: "plus", label: "Add a farm" },
    { href: "/catalogue", icon: "leaf", label: "Crops for your farm" },
    { href: farmHref("modify", undefined, tabField()), icon: "settings", label: "Modify farm" },
  ];
  const selectedNav = (href: string) => {
    if (href.includes("?tab=")) return !!activeFarmTab(location.pathname, location.search);
    return location.pathname === href;
  };
  const openAssistant = () => window.dispatchEvent(new CustomEvent("ho:assistant-open"));
  const activeTab = () => activeFarmTab(location.pathname, location.search);
  /** The bottom tab bar needs a farm to show, and stays out of the way of the add-a-farm wizard. */
  const showTabBar = () =>
    !!s.farm() && !location.pathname.startsWith("/farm/setup");
  createEffect(() => {
    const title =
      nav.find((n) => selectedNav(n.href))?.label ??
      (activeTab() ? "Farm workspace" : "Harvest Outlook");
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
    <div class="app-shell farm-shell glass-workspace">
      <WorkspaceBackdrop />
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
              <a
                href={n.href.includes("?tab=") ? farmHref("today", undefined, tabField()) : n.href}
                aria-label={n.label}
                title={n.label}
                class="sidebar-link"
                classList={{ selected: selectedNav(n.href) }}
                aria-current={selectedNav(n.href) ? "page" : undefined}
                aria-describedby={n.href.includes("?tab=today") && dueBadge() ? "glass-rail-due" : undefined}
              >
                <Icon name={n.icon} size={20} />
                <span>{n.label}</span>
                <Show when={n.href.includes("?tab=today") && dueBadge()}>
                  <small class="glass-rail-badge" aria-hidden="true">{dueBadge()}</small>
                  <span class="farm-tab-sr" id="glass-rail-due">{dueBadge() === 1 ? "1 care task due" : `${dueBadge()} care tasks due`}</span>
                </Show>
              </a>
            )}
          </For>
          <button type="button" class="sidebar-link evara-nav" aria-label="Evara assistant" title="Evara assistant" onClick={openAssistant}><Evara size={25} /><span>Evara</span></button>
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
          <div class="breadcrumbs glass-farm-context">
            <span class="glass-context-icon"><Icon name="leaf" size={20} /></span>
            <div class="glass-context-copy">
              <Show when={safeFarms().length} fallback={<strong>Harvest Outlook</strong>}>
                <label class="farm-picker">
                  <select aria-label="Selected farm" value={s.farm()?.id ?? ""} onChange={(event) => s.selectFarm(event.currentTarget.value)}>
                    <For each={safeFarms()}>{farm => <option value={farm.id}>{farm.name}</option>}</For>
                  </select>
                </label>
              </Show>
              <span class="glass-context-location">
                {location.pathname === "/farms" ? "All farms · " : ""}{s.farm()?.location.districtName ?? "Your growing workspace"}
                <Show when={s.farm()?.facts.demo_prefilled?.value === true || s.farm()?.facts.demo_illustrative?.value === true}><span class="demo-mini-badge">Demo farm</span></Show>
              </span>
            </div>
          </div>
          <div class="topbar-actions">
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
            <MoreMenu links={moreLinks()} />
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
          <nav class="farm-bottom-tabs glass-bottom-tabs" aria-label="Main farm navigation">
            <a href={farmHref("today", undefined, tabField())} classList={{ active: !!activeTab() }} aria-label="Today" aria-current={activeTab() ? "page" : undefined} aria-describedby={dueBadge() ? "glass-bottom-due" : undefined}><Icon name="grid" size={21} /><span class="farm-tab-label">Today</span><Show when={dueBadge()}><small aria-hidden="true">{dueBadge()}</small><span class="farm-tab-sr" id="glass-bottom-due">{dueBadge() === 1 ? "1 care task due" : `${dueBadge()} care tasks due`}</span></Show></a>
            <A href="/farms" classList={{ active: location.pathname === "/farms" }} aria-label="All farms" aria-current={location.pathname === "/farms" ? "page" : undefined}><Icon name="leaf" size={21} /><span class="farm-tab-label">All farms</span></A>
            <button type="button" onClick={openAssistant} aria-label="Evara assistant"><Evara size={22} /><span class="farm-tab-label">Evara</span></button>
          </nav>
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
