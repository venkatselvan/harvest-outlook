import { For, Show, createSignal } from "solid-js";
import { Icon } from "./icons";

/**
 * The farm tabs (docs/research/UI_BRIEF.md section 2). The ids are the stable `?tab=` values and the CSS hooks
 * (`tab-today`, `tab-year`, ...); the labels are what the farmer reads.
 *
 * | label  | id        | content                                                     |
 * | Today  | `today`   | TodayView                                                   |
 * | Plan   | `year`    | YearPlanView                                                |
 * | Market | `harvest` | local market timeline and harvest outlook                  |
 * | Farm   | `soil`    | crop fit, soil records (FarmSettings) and Activity (Journal) |
 * | Modify | `modify`  | farm boundary and field editor                              |
 * | Actions| `actions` | alerts and upcoming field work                              |
 */
export type FarmTab = "today" | "year" | "harvest" | "soil" | "actions" | "modify";
/** The secondary toggle inside the Farm tab. Nothing from the old Soil, Settings and Activity views is dropped. */
export type FarmSection = "fit" | "records" | "activity";

export const farmTabs: { id: FarmTab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "grid" },
  { id: "actions", label: "Actions", icon: "check" },
  { id: "year", label: "Plan", icon: "calendar" },
  { id: "harvest", label: "Market", icon: "trend" },
  { id: "soil", label: "Farm", icon: "leaf" },
  { id: "modify", label: "Modify", icon: "map" },
];
export const farmSections: { id: FarmSection; label: string }[] = [
  { id: "fit", label: "Crop fit" },
  { id: "records", label: "Soil records" },
  { id: "activity", label: "Activity" },
];

const isTab = (value: string | null | undefined): value is FarmTab =>
  farmTabs.some((tab) => tab.id === value);
const isSection = (value: string | null | undefined): value is FarmSection =>
  farmSections.some((section) => section.id === value);
const clean = (path: string) =>
  path.length > 1 ? path.replace(/\/+$/, "") : path;

/** Paths the farm command center renders. Every other route (catalogue, manage, setup, a saved plan) has no active tab. */
const commandPaths = [
  "/farm",
  "/farm/settings",
  "/farm/manage",
  "/planner",
  "/explore",
  "/outlook",
  "/journal",
  "/ask",
];

/**
 * Which tab a path and `?tab=` value select. Legacy routes keep working:
 * `/planner` is Plan, `/outlook` is Market, `/explore`, `/farm/settings` and `/journal` are Farm, and `?tab=activity`
 * (the old fifth tab) is Farm. An explicit `?tab=` wins over the path.
 */
export const selectedTab = (path: string, query?: string): FarmTab => {
  const route = clean(path);
  if (isTab(query)) return query;
  if (query === "activity") return "soil";
  if (route === "/farm/manage") return "modify";
  if (route === "/planner") return "year";
  if (route === "/explore" || route === "/farm/settings") return "soil";
  if (route === "/outlook") return "harvest";
  if (route === "/journal") return "soil";
  return "today";
};

/**
 * Which sub-view of the Farm tab is selected. `?view=` wins; otherwise the legacy entry points decide:
 * `/farm/settings` opens the soil records, `/journal` and `?tab=activity` open Activity, everything else opens crop fit.
 */
export const selectedSection = (
  path: string,
  tabQuery?: string,
  viewQuery?: string,
): FarmSection => {
  const route = clean(path);
  if (isSection(viewQuery)) return viewQuery;
  if (tabQuery === "activity") return "activity";
  if (isTab(tabQuery) && tabQuery !== "soil") return "fit";
  if (route === "/farm/settings") return "records";
  if (route === "/journal") return "activity";
  return "fit";
};

/** The active tab for the shell chrome, or undefined on routes that are not a farm tab. */
export const activeFarmTab = (
  path: string,
  search: string,
): FarmTab | undefined =>
  commandPaths.includes(clean(path))
    ? selectedTab(path, new URLSearchParams(search).get("tab") ?? undefined)
    : undefined;

/**
 * `/farm?tab=soil&view=activity`. The default sub-view stays out of the URL. `field` (2026-11-03,
 * FIELDS_MULTICROP_SOIL_SPEC.md 6.3) is the field selected on Today; it rides along on every tab link so the choice
 * survives tab switches. Field ids are URL-safe by contract; they are encoded anyway.
 */
export const farmHref = (tab: FarmTab, section?: FarmSection, field?: string | null) =>
  `/farm?tab=${tab}${tab === "soil" && section && section !== "fit" ? `&view=${section}` : ""}${field ? `&field=${encodeURIComponent(field)}` : ""}`;

/**
 * The field selected on Today, published by the command center for the tab bars (which live in the shell, outside it),
 * the same way as the due badge. Null = no field (a farm without fields, or "All fields"). Cleared when the command
 * center unmounts.
 */
/**
 * What the Plan tab shows. On a farm with fields every year-plan call must name a field, and whether the farm has fields is
 * only known from its workspace, so the plan view is not mounted before that: "loading" while the workspace or a `?field=`
 * link resolves, "error" when the workspace failed to load (an unscoped call would only answer 400 field_required), "ready"
 * otherwise.
 */
export type PlanTabGate = "loading" | "error" | "ready";
export function planTabGate(field: string | null | undefined, workspaceKnown: boolean, workspaceFailed: boolean): PlanTabGate {
  if (!workspaceKnown) return workspaceFailed ? "error" : "loading";
  return field === undefined ? "loading" : "ready";
}

const [tabField, setTabField] = createSignal<string | null>(null);
export { tabField, setTabField };

/**
 * Open care tasks that are due or overdue. The command center publishes it so the tab bars, which live in different
 * parts of the tree, show one number. It is cleared when the command center unmounts.
 */
const [dueBadge, setDueBadge] = createSignal(0);
export { dueBadge, setDueBadge };

/**
 * The farm tab row stays visible above the selected view at every screen size.
 * The optional bottom variant shares the same links; so every tab is keyboard reachable with Tab and opens with Enter. They are plain
 * anchors: the router intercepts same-origin links itself, and its `A` component would mark every tab as the current
 * page because it ignores the query string.
 */
export function FarmTabNav(props: {
  variant: "top" | "bottom";
  current: () => FarmTab | undefined;
}) {
  return (
    <nav
      class={props.variant === "top" ? "farm-context-tabs" : "farm-bottom-tabs"}
      aria-label="Farm views"
    >
      <For each={farmTabs}>
        {(item) => {
          const dueId = `farm-tab-${props.variant}-due`;
          return (
            <a
              href={farmHref(item.id, undefined, tabField())}
              aria-label={item.label}
              classList={{ active: props.current() === item.id }}
              aria-current={props.current() === item.id ? "page" : undefined}
              aria-describedby={
                item.id === "today" && dueBadge() ? dueId : undefined
              }
            >
              <Icon name={item.icon} size={props.variant === "top" ? 16 : 22} />
              <span class="farm-tab-label">{item.label}</span>
              <Show when={item.id === "today" && dueBadge()}>
                <small aria-hidden="true">{dueBadge()}</small>
                <span class="farm-tab-sr" id={dueId}>
                  {dueBadge() === 1
                    ? "1 care task due"
                    : `${dueBadge()} care tasks due`}
                </span>
              </Show>
            </a>
          );
        }}
      </For>
    </nav>
  );
}
