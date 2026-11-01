import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { YearPlanGap, YearPlanOption, YearPlanSlot } from "@harvest/contracts";
import { AiSpark } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { ScoreRing, ringValue } from "../ui/ScoreRing";
import { columnOf, longDate, longSpan, monthColumns, monthPosition, shortSpan, stripPlacement } from "./format";
import {
  calendarWarnings,
  displayLabel,
  editedFrom,
  greenManureName,
  isGreenManure,
  isLegume,
  nitrogenCreditText,
  noteLines,
  profitText,
} from "./model";

const COLUMNS = 12;

/**
 * Accessible name of a strip. It starts with the strip's visible text (crop name, then the dates or "Growing now" or the
 * nitrogen credit) so that speech-control users can say what they see (WCAG 2.5.3), then adds the full dates.
 */
export function stripLabel(slot: YearPlanSlot): string {
  if (isGreenManure(slot)) {
    const second = nitrogenCreditText(slot.nitrogenCreditKgPerHa) ?? shortSpan(slot.sowing, slot.harvest.latest);
    return `Green manure, ${greenManureName(slot.cropName)}, ${second}. Sow ${longDate(slot.sowing)}, ploughed in by ${longDate(slot.harvest.latest)}. Open details`;
  }
  const price = slot.price?.status === "available" ? "" : ", no price series yet";
  if (slot.fixed)
    return `${slot.cropName}, growing now. Harvest ${longSpan(slot.harvest.earliest, slot.harvest.latest)}${price}. Open details`;
  return `${slot.cropName}, ${shortSpan(slot.sowing, slot.harvest.latest)}. Sow ${longDate(slot.sowing)}, harvest by ${longDate(slot.harvest.latest)}${price}. Open details`;
}

/** Accessible name of a "Field rests" strip: the span, the length and the code-written reason in full. */
export const gapLabel = (gap: YearPlanGap) =>
  `Field rests ${shortSpan(gap.from, gap.to)}, ${gap.days} days. ${gap.reason}`;

export type TrackItem = { kind: "slot"; slot: YearPlanSlot } | { kind: "gap"; gap: YearPlanGap };

/** Crops and idle gaps of one option in calendar order, so Tab follows the timeline. A crop sorts before a gap that starts the same day. */
export function trackItems(option: Pick<YearPlanOption, "slots" | "gaps">): TrackItem[] {
  const items: TrackItem[] = [
    ...option.slots.map((slot) => ({ kind: "slot" as const, slot })),
    ...(option.gaps ?? []).map((gap) => ({ kind: "gap" as const, gap })),
  ];
  const start = (i: TrackItem) => (i.kind === "slot" ? i.slot.sowing : i.gap.from);
  return items.sort((a, b) => start(a).localeCompare(start(b)) || (a.kind === b.kind ? 0 : a.kind === "slot" ? -1 : 1));
}

const gapKey = (optionId: string, gap: YearPlanGap) => `${optionId}|${gap.from}|${gap.to}`;

/**
 * 12-month calendar with one row per option (up to four). Each row has a head (score ring, label with its AI mark or
 * "Calculated" chip, profit headline) and a track with one strip per crop from sowing to the latest harvest. The crop
 * already growing is hatched and labelled "Growing now"; a green manure is dashed with a leaf pattern; an idle stretch of
 * 21 days or more is a light "Field rests" strip whose reason opens on tap or focus.
 *
 * The head is a div with a stretched button over it (not a button around everything) because the AI spark is itself a
 * button and buttons cannot nest. Strips, gaps and the head button are all reachable by Tab; Enter or Space opens the
 * detail sheet. On narrow screens the calendar scrolls sideways inside its own box (never the page) and starts with the
 * current month. No sentence longer than 90 characters is drawn here at rest: long warnings are counted and shown in
 * the sheet, and a gap's reason appears only when asked for.
 */
export function PlanCalendar(props: {
  horizonFrom: string;
  todayIso: string;
  options: readonly YearPlanOption[];
  appliedOptionIds: readonly string[];
  onOpen: (optionId: string, slotId: string | null) => void;
}) {
  let scroller: HTMLDivElement | undefined;
  const [openGap, setOpenGap] = createSignal<string | null>(null);
  const columns = () => monthColumns(props.horizonFrom, COLUMNS);
  const todayColumn = () => columnOf(props.todayIso, props.horizonFrom, COLUMNS);
  const todayLeft = () => (monthPosition(props.todayIso, props.horizonFrom) / COLUMNS) * 100;

  // Scroll so the current month is the first visible column (only matters when the grid is wider than the screen).
  createEffect(
    on(
      () => [props.horizonFrom, props.todayIso, props.options.length > 0] as const,
      () => {
        const column = todayColumn();
        if (!scroller || column == null) return;
        requestAnimationFrame(() => {
          if (!scroller || scroller.scrollWidth <= scroller.clientWidth + 1) return;
          scroller.scrollLeft = (scroller.scrollWidth / COLUMNS) * column;
        });
      },
    ),
  );

  return (
    <div class="yp-calendar">
      <div class="yp-cal-scroll" ref={scroller}>
        <div class="yp-cal-grid">
          <div class="yp-cal-months" aria-hidden="true">
            <For each={columns()}>
              {(c, i) => (
                <span classList={{ "is-current": i() === todayColumn() }}>
                  {c.label}
                  <Show when={c.showYear}>
                    <small>{c.year}</small>
                  </Show>
                </span>
              )}
            </For>
          </div>
          <For each={props.options}>
            {(option) => {
              const profit = () => profitText(option);
              const applied = () => props.appliedOptionIds.includes(option.optionId);
              const warnings = () => calendarWarnings(option.warnings);
              const growingLines = () => noteLines(option.slots.find((s) => s.fixed)?.transitionNote);
              const openedGap = () => (option.gaps ?? []).find((g) => gapKey(option.optionId, g) === openGap());
              return (
                <div class="yp-cal-row" role="group" aria-label={displayLabel(option)} data-option-id={option.optionId}>
                  <div class="yp-row-head">
                    <span class="yp-row-ring" aria-hidden="true">
                      <ScoreRing score={option.score} size={36} />
                    </span>
                    <span class="yp-row-text">
                      <span class="yp-row-line">
                        <span class="yp-row-title" aria-hidden="true">
                          <strong>{displayLabel(option)}</strong>
                          <Show when={editedFrom(option)}>{(from) => <small>from {from()}</small>}</Show>
                        </span>
                        <Show when={option.origin === "model"}>
                          <span class="yp-row-mark">
                            <AiSpark use="year_plan_select" />
                          </span>
                        </Show>
                        <Show when={option.origin === "deterministic"}>
                          <Chip tone="typical">Calculated</Chip>
                        </Show>
                      </span>
                      <span class="yp-row-profit" aria-hidden="true">
                        <strong>{profit().value}</strong>
                        <small>{profit().caption}</small>
                      </span>
                    </span>
                    <button
                      type="button"
                      class="yp-row-open"
                      aria-label={`${displayLabel(option)}, score ${ringValue(option.score)} out of 100, ${profit().value}, ${profit().caption}. Open details`}
                      onClick={() => props.onOpen(option.optionId, null)}
                    />
                  </div>
                  <div class="yp-track">
                    <div class="yp-track-grid" aria-hidden="true">
                      <For each={columns()}>{(_, i) => <span classList={{ "is-current": i() === todayColumn() }} />}</For>
                    </div>
                    <Show when={todayColumn() != null}>
                      <span class="yp-today" style={{ left: `${todayLeft()}%` }} aria-hidden="true" />
                    </Show>
                    <For each={trackItems(option)}>
                      {(item) => {
                        if (item.kind === "gap") {
                          const gap = item.gap;
                          const place = () => stripPlacement(gap.from, gap.to, props.horizonFrom, COLUMNS);
                          const key = gapKey(option.optionId, gap);
                          return (
                            <Show when={place().visible}>
                              <button
                                type="button"
                                class="yp-gap"
                                classList={{ "is-open": openGap() === key }}
                                style={{ left: `${place().left}%`, width: `${place().width}%` }}
                                aria-label={gapLabel(gap)}
                                title={gap.reason}
                                onClick={() => setOpenGap(key)}
                                onFocus={() => setOpenGap(key)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape" && openGap() === key) {
                                    event.stopPropagation();
                                    setOpenGap(null);
                                  }
                                }}
                              >
                                <span class="yp-gap-label" aria-hidden="true">
                                  Field rests
                                </span>
                              </button>
                            </Show>
                          );
                        }
                        const slot = item.slot;
                        const manure = isGreenManure(slot);
                        const place = () => stripPlacement(slot.sowing, slot.harvest.latest, props.horizonFrom, COLUMNS);
                        const harvestBand = () => {
                          const start = monthPosition(slot.sowing, props.horizonFrom);
                          const end = monthPosition(slot.harvest.latest, props.horizonFrom, true);
                          const from = monthPosition(slot.harvest.earliest, props.horizonFrom);
                          return end > start ? Math.max(0, Math.min(100, ((from - start) / (end - start)) * 100)) : 100;
                        };
                        return (
                          <Show when={place().visible}>
                            <button
                              type="button"
                              class="yp-strip"
                              classList={{
                                "is-fixed": slot.fixed,
                                "is-legume": !slot.fixed && !manure && isLegume(slot.cropId),
                                "is-green-manure": manure,
                                "is-clipped-start": place().clippedStart,
                                "is-clipped-end": place().clippedEnd,
                              }}
                              style={{ left: `${place().left}%`, width: `${place().width}%` }}
                              aria-label={stripLabel(slot)}
                              onClick={() => props.onOpen(option.optionId, slot.slotId)}
                            >
                              <Show when={!slot.fixed && !manure}>
                                <span class="yp-strip-harvest" style={{ left: `${harvestBand()}%` }} aria-hidden="true" />
                              </Show>
                              <span class="yp-strip-text" aria-hidden="true">
                                <Show
                                  when={manure}
                                  fallback={
                                    <>
                                      <span class="yp-strip-name">{slot.cropName}</span>{" "}
                                      <span class="yp-strip-dates">
                                        {slot.fixed ? "Growing now" : shortSpan(slot.sowing, slot.harvest.latest)}
                                      </span>
                                    </>
                                  }
                                >
                                  <span class="yp-strip-name">Green manure · {greenManureName(slot.cropName)}</span>{" "}
                                  <span class="yp-strip-dates">
                                    {nitrogenCreditText(slot.nitrogenCreditKgPerHa) ?? shortSpan(slot.sowing, slot.harvest.latest)}
                                  </span>
                                </Show>
                              </span>
                            </button>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                  <Show when={growingLines().length}>
                    <p class="yp-row-notes">
                      <For each={growingLines()}>{(line) => <span>{line}</span>}</For>
                    </p>
                  </Show>
                  <Show when={openedGap()}>
                    {(gap) => (
                      <div class="yp-gap-note" role="status">
                        <p>
                          <strong>
                            Field rests {shortSpan(gap().from, gap().to)} · {gap().days} days.
                          </strong>{" "}
                          {gap().reason}
                        </p>
                        <button type="button" class="yp-link-button" aria-label="Hide the field rests note" onClick={() => setOpenGap(null)}>
                          Hide
                        </button>
                      </div>
                    )}
                  </Show>
                  <Show when={applied() || warnings().short.length || warnings().hidden}>
                    <div class="yp-row-chips">
                      <Show when={applied()}>
                        <Chip tone="done">In saved seasons</Chip>
                      </Show>
                      <For each={warnings().short}>{(warning) => <Chip tone="watch">{warning}</Chip>}</For>
                      <Show when={warnings().hidden}>
                        <Chip tone="watch">
                          {warnings().hidden === 1 ? "1 note in the details" : `${warnings().hidden} notes in the details`}
                        </Chip>
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
      <div class="yp-legend" aria-hidden="true">
        <span>
          <i class="yp-swatch is-fixed" /> Growing now
        </span>
        <span>
          <i class="yp-swatch" /> Planned crop
        </span>
        <span>
          <i class="yp-swatch is-legume" /> Legume
        </span>
        <span>
          <i class="yp-swatch is-green-manure" /> Green manure
        </span>
        <span>
          <i class="yp-swatch is-rest" /> Field rests
        </span>
        <span>
          <i class="yp-swatch is-harvest" /> Harvest window
        </span>
        <Show when={todayColumn() != null}>
          <span>
            <i class="yp-swatch is-today" /> Today
          </span>
        </Show>
      </div>
    </div>
  );
}

/** Placeholder rows while the first plan is being built. */
export function PlanCalendarSkeleton(props: { rows?: number }) {
  return (
    <div class="yp-calendar yp-skeleton" aria-hidden="true">
      <For each={Array.from({ length: props.rows ?? 3 })}>
        {() => (
          <div class="yp-skeleton-row">
            <span class="yp-skeleton-line short" />
            <span class="yp-skeleton-track" />
          </div>
        )}
      </For>
    </div>
  );
}
