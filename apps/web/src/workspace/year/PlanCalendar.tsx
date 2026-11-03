import { For, Show, createEffect, createSignal, on } from "solid-js";
import type { YearPlanGap, YearPlanOccupant, YearPlanOption, YearPlanSlot } from "@harvest/contracts";
import { Icon } from "../icons";
import { AiSpark } from "../ui/AiSpark";
import { Chip } from "../ui/Chip";
import { ScoreRing, ringValue } from "../ui/ScoreRing";
import { columnOf, longDate, longSpan, monthColumns, monthPosition, shortSpan, stripPlacement } from "./format";
import {
  calendarWarnings,
  displayLabel,
  editedFrom,
  greenManureName,
  intercropName,
  isGreenManure,
  isIntercrop,
  isLegume,
  nitrogenCreditText,
  noteLines,
  OCCUPANT_STRIP_LABEL,
  occupantHint,
  occupantEndText,
  occupantName,
  profitText,
  sortedOccupants,
} from "./model";

const COLUMNS = 12;

/**
 * The saved seasons listed under a field's plan (FIELDS_MULTICROP_SOIL_SPEC.md 12.6): the seasons naming that field plus
 * legacy seasons without a field (shown as "whole farm"). With no field ("All fields", or a farm without fields) every
 * season stays listed, as before. Seasons of another field are left out.
 */
export function seasonsForField<P extends { fieldId?: string | undefined }>(plans: readonly P[], fieldId: string | null | undefined): P[] {
  return fieldId ? plans.filter((p) => !p.fieldId || p.fieldId === fieldId) : [...plans];
}
/**
 * The season as the Planner's form saves it. A new season in a field view is saved for that field (`fieldId`); an edited
 * season keeps the field it has (a legacy whole-farm season stays whole-farm); "All fields" or a farm without fields
 * adds no field, as before.
 */
export function seasonWithField<P extends { id?: string | undefined; fieldId?: string | undefined }>(season: P, fieldId: string | null | undefined): P {
  if (season.fieldId || season.id || !fieldId) return season;
  return { ...season, fieldId };
}
/**
 * "All fields" on a farm with fields: a new season cannot be saved here, because a season without a field occupies every
 * field. The add controls give way to "Choose a field to add a season".
 */
export const needsFieldForNewSeason = (farmHasFields: boolean, fieldId: string | null | undefined): boolean => farmHasFields && !fieldId;
export const CHOOSE_FIELD_TO_ADD = "Choose a field to add a season";
/**
 * The field a listed season belongs to, for the "All fields" list on a farm with fields: its name, "Whole farm" for a
 * legacy season without a field, "Unknown field" when the field is no longer on the farm. Null in a field's own list or
 * on a farm without fields (the list is then not split by field).
 */
export function seasonFieldLabel(
  p: { fieldId?: string | undefined },
  fields: readonly { id: string; name: string }[] | undefined,
  selectedFieldId: string | null | undefined,
): string | null {
  if (selectedFieldId || !fields?.length) return null;
  if (!p.fieldId) return "Whole farm";
  return fields.find((f) => f.id === p.fieldId)?.name ?? "Unknown field";
}
/** True for a legacy season without a field, seen in a field's list: the row says "Whole farm". */
export const isWholeFarmSeason = (p: { fieldId?: string | undefined }, fieldId: string | null | undefined): boolean => !!fieldId && !p.fieldId;

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
  if (isIntercrop(slot))
    return `${intercropName(slot)}, ${shortSpan(slot.sowing, slot.harvest.latest)}. Intercrop. Sow ${longDate(slot.sowing)}, harvest by ${longDate(slot.harvest.latest)}${price}. Open details`;
  if (slot.fixed)
    return `${slot.cropName}, growing now. Harvest ${longSpan(slot.harvest.earliest, slot.harvest.latest)}${price}. Open details`;
  return `${slot.cropName}, ${shortSpan(slot.sowing, slot.harvest.latest)}. Sow ${longDate(slot.sowing)}, harvest by ${longDate(slot.harvest.latest)}${price}. Open details`;
}

/** Accessible name of a "Field rests" strip: the span, the length and the code-written reason in full. */
export const gapLabel = (gap: YearPlanGap) =>
  `Field rests ${shortSpan(gap.from, gap.to)}, ${gap.days} days. ${gap.reason}`;

/**
 * Accessible name of a saved-season strip (also recorded crops and the assumed plan). It starts with the strip's visible
 * text (name, then "Saved season · dates") for speech control (WCAG 2.5.3). `interactive` false (the "Saved seasons"
 * row of a review without plans) leaves out "Open details".
 */
export function occupantLabel(o: YearPlanOccupant, interactive = true): string {
  const what = o.source === "saved_season" ? "saved season" : o.source === "recorded_cycle" ? "recorded crop" : "assumed plan";
  const from = o.source === "assumed_plan" ? " Assumed from last year's plan." : "";
  return `${occupantName(o)}, ${what}, ${shortSpan(o.sowing, o.occupancy.to)}.${from} Sow ${longDate(o.sowing)}, ${occupantEndText(o)}${interactive ? ". Open details" : ""}`;
}

export type TrackItem =
  | { kind: "slot"; slot: YearPlanSlot }
  | { kind: "gap"; gap: YearPlanGap }
  | { kind: "occupant"; occupant: YearPlanOccupant };

const TRACK_RANK = { slot: 0, occupant: 1, gap: 2 } as const;

/**
 * Crops, saved seasons and idle gaps of one option in calendar order, so Tab follows the timeline. Of two items that
 * start the same day a crop sorts first, then a saved season, then a gap.
 */
export function trackItems(
  option: Pick<YearPlanOption, "slots" | "gaps">,
  occupied: readonly YearPlanOccupant[] = [],
): TrackItem[] {
  const items: TrackItem[] = [
    ...option.slots.map((slot) => ({ kind: "slot" as const, slot })),
    ...sortedOccupants(occupied).map((occupant) => ({ kind: "occupant" as const, occupant })),
    ...(option.gaps ?? []).map((gap) => ({ kind: "gap" as const, gap })),
  ];
  const start = (i: TrackItem) => (i.kind === "slot" ? i.slot.sowing : i.kind === "occupant" ? i.occupant.sowing : i.gap.from);
  return items.sort((a, b) => start(a).localeCompare(start(b)) || TRACK_RANK[a.kind] - TRACK_RANK[b.kind]);
}

const gapKey = (optionId: string, gap: YearPlanGap) => `${optionId}|${gap.from}|${gap.to}`;

/**
 * 12-month calendar with one row per option (up to five). The month columns start at the horizon's first month, so a
 * later year reads the same way. Each row has a head (score ring, label with its AI mark or
 * "Calculated" chip, profit headline) and a track with one strip per crop from sowing to the latest harvest. The crop
 * already growing is hatched and labelled "Growing now"; a green manure is dashed with a leaf pattern; an intercrop is
 * banded and reads "Main + companion · row ratio"; an idle stretch of
 * 21 days or more is a light "Field rests" strip whose reason opens on tap or focus. Saved seasons (and recorded crops
 * or the assumed plan) that take months of the horizon are drawn in every row as blue-outlined "Saved season" strips
 * with a pin; when there are no plans at all but there are saved seasons, one non-interactive "Saved seasons" row shows them.
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
  /** Saved seasons, recorded crops and the assumed plan taking months of the horizon (`review.scenario.occupied ?? []`). */
  occupied: readonly YearPlanOccupant[];
  /** A crop strip passes its slot id; a saved-season strip passes null and the occupant's id; a row head passes neither. */
  onOpen: (optionId: string, slotId: string | null, occupantId?: string) => void;
}) {
  let scroller: HTMLDivElement | undefined;
  const [openGap, setOpenGap] = createSignal<string | null>(null);
  const columns = () => monthColumns(props.horizonFrom, COLUMNS);
  const todayColumn = () => columnOf(props.todayIso, props.horizonFrom, COLUMNS);
  const todayLeft = () => (monthPosition(props.todayIso, props.horizonFrom) / COLUMNS) * 100;

  // The "Saved seasons" row of a review without plans has nothing at the current month: start at its first season.
  const firstSavedColumn = () => {
    const first = sortedOccupants(props.occupied)[0];
    return first ? Math.max(0, Math.min(COLUMNS - 1, Math.floor(monthPosition(first.sowing, props.horizonFrom)))) : null;
  };
  // Scroll so the current month is the first visible column (only matters when the grid is wider than the screen).
  createEffect(
    on(
      () => [props.horizonFrom, props.todayIso, props.options.length > 0, props.occupied.length] as const,
      ([, , hasOptions]) => {
        const column = hasOptions ? todayColumn() : (firstSavedColumn() ?? todayColumn());
        if (scroller && column == null) scroller.scrollLeft = 0; // a later horizon has no current month
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
                        <For each={option.secondaryLabels ?? []}>
                          {(label) => <span class="yp-row-secondary">{label}</span>}
                        </For>
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
                      aria-label={`${displayLabel(option)}${(option.secondaryLabels ?? []).map((l) => `, also ${l}`).join("")}, score ${ringValue(option.score)} out of 100, ${profit().value}, ${profit().caption}. Open details`}
                      onClick={() => props.onOpen(option.optionId, null)}
                    />
                  </div>
                  <div class="yp-track">
                    <TrackBackdrop columns={columns()} todayColumn={todayColumn()} todayLeft={todayLeft()} />
                    <For each={trackItems(option, props.occupied)}>
                      {(item) => {
                        if (item.kind === "occupant")
                          return (
                            <OccupantStrip
                              occupant={item.occupant}
                              horizonFrom={props.horizonFrom}
                              onOpen={() => props.onOpen(option.optionId, null, item.occupant.id)}
                            />
                          );
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
                                "is-intercrop": isIntercrop(slot),
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
                                      <span class="yp-strip-name">{intercropName(slot)}</span>{" "}
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
                  <SavedHint text={occupantHint(props.occupied)} />
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
          <Show when={props.options.length === 0 && props.occupied.length > 0}>
            <div class="yp-cal-row yp-saved-row" role="group" aria-label="Saved seasons">
              <div class="yp-row-head">
                <span class="yp-row-text">
                  <span class="yp-row-line">
                    <span class="yp-row-title">
                      <strong>Saved seasons</strong>
                    </span>
                    <Chip tone="info">Yours</Chip>
                  </span>
                </span>
              </div>
              <div class="yp-track">
                <TrackBackdrop columns={columns()} todayColumn={todayColumn()} todayLeft={todayLeft()} />
                <For each={sortedOccupants(props.occupied)}>
                  {(occupant) => <OccupantStrip occupant={occupant} horizonFrom={props.horizonFrom} />}
                </For>
              </div>
              <SavedHint text={occupantHint(props.occupied)} />
            </div>
          </Show>
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
          <i class="yp-swatch is-saved" /> Saved season
        </span>
        <Show when={props.occupied.some((o) => o.source === "assumed_plan")}>
          <span>
            <i class="yp-swatch is-assumed" /> Assumed
          </span>
        </Show>
        <span>
          <i class="yp-swatch is-legume" /> Legume
        </span>
        <span>
          <i class="yp-swatch is-green-manure" /> Green manure
        </span>
        <span>
          <i class="yp-swatch is-intercrop" /> Intercrop
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

/**
 * The saved seasons in words, kept in view beside the scrolling calendar (sticky like the other row notes). Shown only
 * where the calendar is narrower than its 12 columns (a container query in the stylesheet), since only there can a
 * season be out of sight; hidden from assistive technology because each strip already carries its full name.
 */
function SavedHint(props: { text: string | null }) {
  return (
    <Show when={props.text}>
      {(text) => (
        <p class="yp-row-notes yp-saved-hint" aria-hidden="true">
          <span>{text()}</span>
        </p>
      )}
    </Show>
  );
}

/** The month lines and the today marker behind a row's strips. */
function TrackBackdrop(props: { columns: readonly unknown[]; todayColumn: number | null; todayLeft: number }) {
  return (
    <>
      <div class="yp-track-grid" aria-hidden="true">
        <For each={props.columns}>{(_, i) => <span classList={{ "is-current": i() === props.todayColumn }} />}</For>
      </div>
      <Show when={props.todayColumn != null}>
        <span class="yp-today" style={{ left: `${props.todayLeft}%` }} aria-hidden="true" />
      </Show>
    </>
  );
}

/**
 * One saved season, recorded crop or assumed plan, from sowing to the day the engine holds the field until. A button
 * that opens the option sheet on this season when `onOpen` is given; otherwise a plain labelled image (the row of a
 * review without plans, where there is no sheet to open). Solid outline and a pin, so it cannot be taken for a crop
 * the plan suggests; the assumed plan is lighter.
 */
function OccupantStrip(props: { occupant: YearPlanOccupant; horizonFrom: string; onOpen?: () => void }) {
  const o = () => props.occupant;
  const place = () => stripPlacement(o().sowing, o().occupancy.to, props.horizonFrom, COLUMNS);
  const classes = () => ({
    "is-saved": o().source !== "assumed_plan",
    "is-assumed": o().source === "assumed_plan",
    "is-clipped-start": place().clippedStart,
    "is-clipped-end": place().clippedEnd,
  });
  const inner = () => (
    <span class="yp-strip-text" aria-hidden="true">
      <span class="yp-strip-name">
        <Icon name="pin" size={11} class="yp-strip-pin" />
        {occupantName(o())}
      </span>
      <span class="yp-strip-dates">
        {OCCUPANT_STRIP_LABEL[o().source]} · {shortSpan(o().sowing, o().occupancy.to)}
      </span>
    </span>
  );
  const style = () => ({ left: `${place().left}%`, width: `${place().width}%` });
  return (
    <Show when={place().visible}>
      <Show
        when={props.onOpen}
        fallback={
          <div class="yp-strip" classList={classes()} style={style()} role="img" aria-label={occupantLabel(o(), false)}>
            {inner()}
          </div>
        }
      >
        {(open) => (
          <button
            type="button"
            class="yp-strip"
            classList={classes()}
            style={style()}
            aria-label={occupantLabel(o())}
            data-occupant-id={o().id}
            onClick={() => open()()}
          >
            {inner()}
          </button>
        )}
      </Show>
    </Show>
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
