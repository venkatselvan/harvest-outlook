import { For, Show, createEffect, on } from "solid-js";
import type { YearPlanOption, YearPlanSlot } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { ScoreRing } from "../ui/ScoreRing";
import { columnOf, formatInrRange, longDate, longSpan, monthColumns, monthPosition, shortSpan, stripPlacement } from "./format";
import { displayLabel, editedFrom, isLegume } from "./model";

const COLUMNS = 12;

export function profitText(option: Pick<YearPlanOption, "totalProfitPerHa">): { value: string; caption: string } {
  return option.totalProfitPerHa
    ? { value: formatInrRange(option.totalProfitPerHa), caption: "profit per ha" }
    : { value: "Profit not available", caption: "needs a price and a cost for every crop" };
}

export function stripLabel(slot: YearPlanSlot): string {
  const when = slot.fixed
    ? `growing now, harvest ${longSpan(slot.harvest.earliest, slot.harvest.latest)}`
    : `sow ${longDate(slot.sowing)}, harvest by ${longDate(slot.harvest.latest)}`;
  const price = slot.price?.status === "available" ? "" : ", no price series yet";
  return `${slot.cropName}, ${when}${price}. Open details`;
}

/**
 * 12-month calendar with one row per option. Each row has a heading button (label, score ring, profit range) and a
 * track with one strip per crop from sowing to the latest harvest; the crop already growing is hatched and labelled
 * "Growing now". Rows and strips are buttons, so Tab reaches them and Enter or Space opens the detail sheet. On narrow
 * screens the calendar scrolls sideways inside its own box (never the page) and starts with the current month.
 */
export function PlanCalendar(props: {
  horizonFrom: string;
  todayIso: string;
  options: readonly YearPlanOption[];
  appliedOptionIds: readonly string[];
  onOpen: (optionId: string, slotId: string | null) => void;
}) {
  let scroller: HTMLDivElement | undefined;
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
              return (
                <div class="yp-cal-row" role="group" aria-label={displayLabel(option)} data-option-id={option.optionId}>
                  <button type="button" class="yp-row-head" onClick={() => props.onOpen(option.optionId, null)}>
                    <span class="yp-row-title">
                      <strong>{displayLabel(option)}</strong>
                      <Show when={editedFrom(option)}>{(from) => <small>from {from()}</small>}</Show>
                    </span>
                    <ScoreRing score={option.score} size={36} />
                    <span class="yp-row-profit">
                      <strong>{profit().value}</strong>
                      <small>{profit().caption}</small>
                    </span>
                  </button>
                  <div class="yp-track">
                    <div class="yp-track-grid" aria-hidden="true">
                      <For each={columns()}>{(_, i) => <span classList={{ "is-current": i() === todayColumn() }} />}</For>
                    </div>
                    <Show when={todayColumn() != null}>
                      <span class="yp-today" style={{ left: `${todayLeft()}%` }} aria-hidden="true" />
                    </Show>
                    <For each={option.slots}>
                      {(slot) => {
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
                                "is-legume": !slot.fixed && isLegume(slot.cropId),
                                "is-clipped-start": place().clippedStart,
                                "is-clipped-end": place().clippedEnd,
                              }}
                              style={{ left: `${place().left}%`, width: `${place().width}%` }}
                              aria-label={stripLabel(slot)}
                              onClick={() => props.onOpen(option.optionId, slot.slotId)}
                            >
                              <Show when={!slot.fixed}>
                                <span class="yp-strip-harvest" style={{ left: `${harvestBand()}%` }} aria-hidden="true" />
                              </Show>
                              <span class="yp-strip-text" aria-hidden="true">
                                <span class="yp-strip-name">{slot.cropName}</span>
                                <span class="yp-strip-dates">
                                  {slot.fixed ? "Growing now" : shortSpan(slot.sowing, slot.harvest.latest)}
                                </span>
                              </span>
                            </button>
                          </Show>
                        );
                      }}
                    </For>
                  </div>
                  <Show when={applied() || option.warnings.length}>
                    <div class="yp-row-chips">
                      <Show when={applied()}>
                        <Chip tone="done">In saved seasons</Chip>
                      </Show>
                      <For each={option.warnings}>{(warning) => <Chip tone="watch">{warning}</Chip>}</For>
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
