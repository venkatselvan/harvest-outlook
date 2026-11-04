import { children, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { UpcomingStep } from "@harvest/contracts";
import { Icon } from "../icons";
import { Evara } from "../Evara";
import { mapPin, mapReady, setMapFocus, mapFocus } from "../mapLayer";
import { alertDomId } from "./AlertsList";
import { stepDomId } from "./UpcomingSteps";
import { formatDay, windowLabel } from "./model";
import {
  GAUGE_BASIS_LABEL,
  formatHa,
  headlineEyebrow,
  headlineSentence,
  headlineTitle,
  type AttentionItem,
  type Gauge,
  type GlanceFacts,
  type WeekDay,
  type WeekPlanRow,
} from "./todayMapModel";

/**
 * Panels of the Today full-map layout (docs/research/TODAY_MAP_LAYOUT_SPEC.md). They only arrange data the Today view
 * already holds; every number arrives computed by `todayMapModel.ts` or the existing helpers, with its basis.
 */

/** Scroll an alert or step card into view and focus it (the same move the overview and the alert buttons make). */
export function jumpToTarget(target: AttentionItem["target"]): boolean {
  const node = document.getElementById(target.kind === "alert" ? alertDomId(target.id) : stepDomId(target.id));
  if (!node) return false;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.focus({ preventScroll: true });
  return true;
}

/** Headline block: weekday and date, "Your farm today." (the page h1) and one sentence from the attention count. */
export function TodayHeadline(props: { date: string | null | undefined; fieldName: string | null | undefined; count: number | null | undefined }) {
  return (
    <header class="today-map-headline" data-testid="today-headline">
      <Show when={props.date ? headlineEyebrow(props.date) : ""}>{(eyebrow) => <p class="today-map-eyebrow">{eyebrow()}</p>}</Show>
      <h1 id="today-headline-title">{headlineTitle(props.fieldName)}</h1>
      <Show when={props.count != null}>
        <p class="today-map-sentence" data-testid="today-headline-sentence">
          {headlineSentence(props.count!)}
        </p>
      </Show>
    </header>
  );
}

/** At a glance: cultivated area, active fields and today's season day; without a crop, the planting call to action. */
export function GlancePanel(props: { facts: GlanceFacts; cropName: string | null; hasCycle: boolean; canPlant: boolean; onPlant: () => void; exploreHref?: string | undefined }) {
  return (
    <section class="today-map-panel today-glance" aria-labelledby="today-glance-title" data-testid="today-glance">
      <div class="today-map-panel-head">
        <h2 id="today-glance-title">At a glance</h2>
        <Show when={props.cropName}>
          <span class="today-map-pill">{props.cropName}</span>
        </Show>
        <Show when={props.exploreHref}>
          {(href) => (
            <a class="today-map-link today-glance-explore" href={href()} data-testid="today-glance-explore">
              Explore fields <Icon name="arrow" size={13} />
            </a>
          )}
        </Show>
      </div>
      <dl class="today-glance-metrics">
        <div title="Area of the drawn fields with a current crop (the drawn farm for a whole-farm crop); map area, not a survey">
          <dt>Cultivated area</dt>
          <dd data-glance="area">
            <Show when={props.facts.areaHa != null} fallback="–">
              {formatHa(props.facts.areaHa!)}
              <small> ha</small>
            </Show>
          </dd>
        </div>
        <div>
          <dt>Active fields</dt>
          <dd data-glance="fields">
            <Show when={props.facts.fields} fallback={<>0<small> fields drawn</small></>}>
              {(f) => (
                <>
                  {f().active}
                  <small> of {f().total}</small>
                </>
              )}
            </Show>
          </dd>
        </div>
        <div title="Days since sowing on the season slider, of the days to the latest harvest date (calendar estimate)">
          <dt>Season day</dt>
          <dd data-glance="season">
            <Show when={props.facts.seasonDay} fallback="–">
              {(d) => (
                <>
                  {d().day}
                  <small> of {d().total}</small>
                </>
              )}
            </Show>
          </dd>
        </div>
      </dl>
      <Show when={!props.hasCycle}>
        <div class="today-glance-cta">
          <p>No crop is recorded here yet. Record what you planted to start stage dates, prices and care steps.</p>
          <button type="button" class="btn compact" onClick={() => props.onPlant()} disabled={!props.canPlant}>
            <Icon name="plus" size={15} /> Record a planting
          </button>
        </div>
      </Show>
    </section>
  );
}

/** The ring (numeric gauges) or the four water states (dry, moist, ponded, flooded); decorative, the text carries the value. */
function GaugeGlyph(props: { gauge: Gauge }) {
  const r = 17;
  const length = 2 * Math.PI * r;
  return (
    <Show
      when={props.gauge.id !== "water"}
      fallback={
        <span class="today-gauge-steps" aria-hidden="true">
          <For each={[0, 1, 2, 3]}>{(step) => <span classList={{ on: props.gauge.level != null && step <= props.gauge.level }} />}</For>
        </span>
      }
    >
      <svg class="today-gauge-ring" viewBox="0 0 44 44" width="44" height="44" aria-hidden="true">
        <circle cx="22" cy="22" r={r} class="track" />
        <Show when={props.gauge.fraction != null}>
          <circle cx="22" cy="22" r={r} class="fill" stroke-dasharray={`${(props.gauge.fraction! * length).toFixed(1)} ${length.toFixed(1)}`} transform="rotate(-90 22 22)" />
        </Show>
      </svg>
    </Show>
  );
}

/** The basis chip every gauge carries: Observed, Modelled or Estimated (or "No reading"). */
export function BasisChip(props: { gauge: Gauge }) {
  return (
    <span class="today-basis-chip" data-basis={props.gauge.basis ?? "none"} title={props.gauge.basisNote}>
      {props.gauge.basis ? GAUGE_BASIS_LABEL[props.gauge.basis] : "No reading"}
    </span>
  );
}

/**
 * Field signals: greenness, water and stage progress for the slider day, stacked in the right pane (TODAY_REFINEMENT_SPEC.md
 * 3 and 4). Each row is one button: the glyph, the label, the value line ("Day 4 of 135 · Mid-season"), an optional note
 * from an existing card (the crop condition headline, the estimated harvest window) and the basis chip; it opens the
 * existing sheet, which carries the full basis words.
 */
export function GaugesPanel(props: { gauges: Gauge[]; subject: string | null; dateLabel: string; onOpen: (sheet: Gauge["sheet"]) => void }) {
  return (
    <section class="today-map-panel today-gauges" aria-labelledby="today-gauges-title" data-testid="today-gauges">
      <div class="today-map-panel-head">
        <h2 id="today-gauges-title">Field signals</h2>
        <span class="today-map-sub">{[props.subject, props.dateLabel].filter(Boolean).join(" · ")}</span>
      </div>
      <ul class="today-gauge-list">
        <For each={props.gauges}>
          {(gauge) => (
            <li>
              <button type="button" class="today-gauge" data-gauge={gauge.id} onClick={() => props.onOpen(gauge.sheet)}>
                <GaugeGlyph gauge={gauge} />
                <span class="today-gauge-text">
                  <span class="today-gauge-label">{gauge.label}</span>
                  <span class="today-gauge-line" data-testid={`today-gauge-line-${gauge.id}`}>
                    <Show when={gauge.value !== "–"}>
                      <strong class="today-gauge-value">{gauge.value}</strong>
                      <span class="today-gauge-sep"> · </span>
                    </Show>
                    <span class="today-gauge-caption">{gauge.caption}</span>
                  </span>
                  <Show when={gauge.note}>
                    <span class="today-gauge-note" data-testid={`today-gauge-note-${gauge.id}`}>
                      {gauge.note}
                    </span>
                  </Show>
                </span>
                <BasisChip gauge={gauge} />
                <span class="today-sr">. {gauge.basisNote}. Opens details and sources.</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/** Needs your attention: up to three alerts and due checks, each with one evidence line and one action link. */
export function AttentionPanel(props: { items: AttentionItem[]; total: number; actionsHref: string }) {
  return (
    <section class="today-map-panel today-attention" aria-labelledby="today-attention-title" data-testid="today-attention">
      <div class="today-map-panel-head">
        <h2 id="today-attention-title">Needs your attention</h2>
        <Show when={props.total}>
          <span class="today-map-count" aria-label={`${props.total} ${props.total === 1 ? "item" : "items"}`}>
            {props.total}
          </span>
        </Show>
      </div>
      <Show when={props.items.length} fallback={<p class="today-map-empty">Nothing needs attention today.</p>}>
        <ul class="today-attention-list">
          <For each={props.items}>
            {(item) => (
              <li class="today-attention-item" data-severity={item.severity} data-attention-kind={item.kind}>
                <h3>{item.title}</h3>
                <p class="today-attention-evidence">{item.evidence}</p>
                <a
                  class="today-attention-action"
                  href={`#${item.target.kind === "alert" ? alertDomId(item.target.id) : stepDomId(item.target.id)}`}
                  aria-label={`${item.action}: ${item.title}`}
                  onClick={(event) => {
                    if (jumpToTarget(item.target)) event.preventDefault();
                  }}
                >
                  {item.action} <Icon name="arrow" size={12} />
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.total > props.items.length}>
        <a class="today-map-link" href={props.actionsHref} data-testid="today-attention-all">
          See all in Actions <Icon name="arrow" size={13} />
        </a>
      </Show>
    </section>
  );
}

const WEEK_KIND: Record<WeekDay["kind"], string | null> = { forecast: null, observed: "Recorded", typical: "Typical", unavailable: "No data" };

/** The week ahead: five days from the weather track (high, low, rain chance or amount) and one takeaway from the alert rules. */
export function WeekPanel(props: { days: WeekDay[]; takeaway: string | null; basis: string | null; onDetails: () => void }) {
  return (
    <section class="today-map-panel today-week" aria-labelledby="today-week-title" data-testid="today-week">
      <div class="today-map-panel-head">
        <h2 id="today-week-title">The week ahead</h2>
        <button type="button" class="today-map-text-button" onClick={() => props.onDetails()}>
          Details <span class="today-sr">of the weather on the selected day</span>
        </button>
      </div>
      <ol class="today-week-days">
        <For each={props.days}>
          {(day) => (
            <li data-kind={day.kind} data-date={day.date}>
              <span class="today-week-day">{day.label}</span>
              <span class="today-week-icon" aria-hidden="true">
                <Show when={day.wet != null}>
                  <Icon name={day.wet ? "rain" : "sun"} size={18} />
                </Show>
              </span>
              <span class="today-week-temp">
                <span aria-hidden="true">
                  {day.high}
                  <small>/{day.low}</small>
                </span>
                <span class="today-sr">
                  High {day.high}, low {day.low}.
                </span>
              </span>
              <span class="today-week-rain">
                <span aria-hidden="true">{day.rain}</span>
                <span class="today-sr">{day.rainSpoken}.</span>
              </span>
              <Show when={WEEK_KIND[day.kind]}>
                <small class="today-week-kind">{WEEK_KIND[day.kind]}</small>
              </Show>
            </li>
          )}
        </For>
      </ol>
      <p class="today-week-takeaway" data-testid="today-week-takeaway">
        <Icon name={props.takeaway ? "info" : "check"} size={14} /> {props.takeaway ?? "No weather alert for these five days."}
      </p>
      <Show when={props.basis}>
        <p class="today-map-basis">{props.basis}</p>
      </Show>
    </section>
  );
}

/** Evara: one of the questions the assistant already suggests, sent to the assistant panel on tap (never a made-up quote). */
export function EvaraPanel(props: { question: string }) {
  return (
    <section class="today-map-panel today-evara" aria-labelledby="today-evara-title" data-testid="today-evara">
      <div class="today-evara-head">
        <Evara size={36} />
        <div>
          <h2 id="today-evara-title">Evara</h2>
          <p>Your farm assistant. A question to start with:</p>
        </div>
      </div>
      <button
        type="button"
        class="today-evara-question"
        onClick={() => window.dispatchEvent(new CustomEvent("ho:ask", { detail: { text: props.question } }))}
      >
        <span>{props.question}</span>
        <Icon name="arrow" size={14} />
      </button>
    </section>
  );
}

/**
 * The phone map band: it publishes its box so the map fits the farm into it, and shows the farm pin (farm name and
 * "Explore fields") where the map projects the farm, plus the imagery credit. Desktop and tablet do not render it (the
 * map is the full-tab background and fits the whole viewport); without the map (no saved location, imagery failing) it
 * stays empty and the layout does not change.
 */
export function MapCentre(props: { farmName: string; exploreHref: string }) {
  let node: HTMLDivElement | undefined;
  onMount(() => {
    const measure = () => {
      if (!node) return;
      const box = node.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) {
        setMapFocus(null);
        return;
      }
      // On a phone the pin card hangs below the farm inside the band, so the farm is fitted into the band above that room.
      const room = node.closest('[data-arrangement="compact"]') ? PHONE_PIN_ROOM : 0;
      setMapFocus({ top: box.top + window.scrollY, left: box.left, right: box.right, bottom: Math.max(box.top + window.scrollY, box.bottom + window.scrollY - room) });
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node!);
    window.addEventListener("resize", measure);
    onCleanup(() => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      setMapFocus(null);
    });
  });
  // Pin position inside the band (the phone band clips and scrolls with the page; the wide layouts keep the viewport position).
  const local = (pin: { x: number; y: number }) => {
    const focus = mapFocus();
    return focus ? { "--pin-x": `${pin.x - focus.left}px`, "--pin-y": `${pin.y - focus.top}px` } : {};
  };
  return (
    <div class="today-map-centre" ref={node} data-testid="today-map-centre">
      <Show when={mapReady() ? mapPin() : null}>
        {(pin) => (
          <div class="today-map-pin" data-testid="today-map-pin" style={{ "--pin-vx": `${pin().x}px`, "--pin-vy": `${pin().y}px`, ...local(pin()) }}>
            <span class="today-map-pin-dot" aria-hidden="true" />
            <strong>{props.farmName}</strong>
            <a class="today-map-explore" href={props.exploreHref}>
              Explore fields <Icon name="arrow" size={13} />
            </a>
          </div>
        )}
      </Show>
      <Show when={mapReady()}>
        <span class="today-map-credit" data-testid="today-map-credit">Satellite basemap · Imagery © Esri · Maxar · Earthstar Geographics</span>
      </Show>
    </div>
  );
}

/** Room kept at the bottom of the phone band for the pin card (dot, farm name, "Explore fields") and the imagery credit. */
const PHONE_PIN_ROOM = 116;

/** Whether the window is phone-sized (the one-sheet order); false outside a browser. */
function createCompact(query = "(max-width: 767px)") {
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
  const [compact, setCompact] = createSignal(!!mq?.matches);
  if (mq) {
    const update = () => setCompact(mq.matches);
    mq.addEventListener?.("change", update);
    onCleanup(() => mq.removeEventListener?.("change", update));
  }
  return compact;
}

export interface TodayMapLayoutProps {
  testid?: string | undefined;
  class?: string | undefined;
  headline: JSX.Element;
  centre: JSX.Element;
  glance: JSX.Element;
  hero: JSX.Element;
  /** The layered "Harvest outlook" card under the hero (TODAY_REFINEMENT_SPEC.md 5). */
  outlook: JSX.Element;
  /** Main-column content after the outlook card (the "Your fields" table on the All fields overview). */
  extra?: JSX.Element;
  /** "Today for you" (the AI overview), second in the right pane. */
  overview: JSX.Element;
  gauges: JSX.Element;
  attention: JSX.Element;
  week: JSX.Element;
  evara: JSX.Element;
}

/**
 * Desktop and tablet (TODAY_REFINEMENT_SPEC.md 3): the headline; the main column (at a glance, the hero frame, the harvest
 * outlook card, then any extra main content); the right pane (needs your attention, Today for you, the week ahead, field
 * signals, Evara). The map is the full-tab background. Phone: the map band first, then one sheet in the order headline,
 * hero, the right pane's order (attention, Today for you, week, field signals, Evara), then the outlook card, at a glance
 * and the extra content. The DOM follows the visible order in both, so the keyboard order does too; each panel is created
 * once and moved, never rebuilt, when the window crosses the breakpoint.
 */
export function TodayMapLayout(props: TodayMapLayoutProps) {
  const compact = createCompact();
  const headline = children(() => props.headline);
  const centre = children(() => props.centre);
  const glance = children(() => props.glance);
  const hero = children(() => props.hero);
  const outlook = children(() => props.outlook);
  const extra = children(() => props.extra);
  const overview = children(() => props.overview);
  const gauges = children(() => props.gauges);
  const attention = children(() => props.attention);
  const week = children(() => props.week);
  const evara = children(() => props.evara);
  return (
    <div class={`today-map-layout ${props.class ?? ""}`} data-arrangement={compact() ? "compact" : "wide"} data-testid={props.testid}>
      <Show
        when={compact()}
        fallback={
          <>
            {headline()}
            <div class="today-map-main">
              {glance()}
              {hero()}
              {outlook()}
              {extra()}
            </div>
            <div class="today-map-right">
              {attention()}
              {overview()}
              {week()}
              {gauges()}
              {evara()}
            </div>
          </>
        }
      >
        {centre()}
        <div class="today-map-sheet">
          {headline()}
          {hero()}
          {attention()}
          {overview()}
          {week()}
          {gauges()}
          {evara()}
          {outlook()}
          {glance()}
          {extra()}
        </div>
      </Show>
    </div>
  );
}

// ---------------------------------------------------------------- Actions: this week

/** The Actions tab's right-hand plan: open steps on today and the next six days, from their existing due dates. */
export function ThisWeekPanel(props: { rows: WeekPlanRow[]; today: string }) {
  const statusText = (step: UpcomingStep) =>
    step.status === "overdue" ? "Overdue" : step.status === "due" ? (step.dueTo === props.today ? "Due today" : `Due by ${formatDay(step.dueTo, false)}`) : windowLabel(step.dueFrom, step.dueTo);
  return (
    <aside class="today-map-panel today-this-week" aria-labelledby="today-this-week-title" data-testid="today-this-week">
      <div class="today-map-panel-head">
        <h2 id="today-this-week-title">This week</h2>
        <span class="today-map-sub">Today and the next six days</span>
      </div>
      <Show when={props.rows.length} fallback={<p class="today-map-empty">Nothing is due this week.</p>}>
        <ol class="today-this-week-rows">
          <For each={props.rows}>
            {(row) => (
              <li data-date={row.date}>
                <span class="today-this-week-day">{row.label}</span>
                <ul>
                  <For each={row.steps}>
                    {(step) => (
                      <li>
                        <a
                          href={`#${stepDomId(step.id)}`}
                          onClick={(event) => {
                            if (jumpToTarget({ kind: "step", id: step.id })) event.preventDefault();
                          }}
                        >
                          {step.title}
                        </a>
                        <small>{statusText(step)}</small>
                      </li>
                    )}
                  </For>
                </ul>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </aside>
  );
}
