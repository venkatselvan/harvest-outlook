import type { CompareItem } from "../features/comparison/types";

/**
 * Compare cards (SEASON_STRIP_COMPARE_SPEC.md part 2): the four rows of a crop card and the source chip of each, read from
 * the comparison result the page already holds. Nothing is computed or estimated here: a row with no sourced figure says
 * so instead of showing a number.
 *
 * Chips: "state window" is a figure from a record scoped to the farm's state or region; "sourced" is a figure from a record
 * with evidence that is not state-specific (a national record, or the sum of sourced stage durations); "estimate" is a figure
 * present without any evidence record behind it.
 */
export type CardChip = "sourced" | "state window" | "estimate";
export const NOT_SOURCED = "Not sourced for this state";
export const CHIP_TITLE: Record<CardChip, string> = {
  "state window": "A sourced figure for your state or region",
  sourced: "A sourced figure, not specific to your state",
  estimate: "No evidence record is linked to this figure",
};

export interface CardRow {
  key: "season" | "window" | "duration" | "water";
  label: string;
  /** The figure, or NOT_SOURCED. */
  value: string;
  /** Null when the row has no sourced figure. */
  chip: CardChip | null;
  /** A second small line (the farm's water access fit), or null. */
  note: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const regionChip = (item: CompareItem, evidenceIds: readonly string[]): CardChip =>
  evidenceIds.length === 0 ? "estimate" : item.context?.regionMatch === "state_or_region" ? "state window" : "sourced";

const FIT_TEXT: Record<string, string> = {
  matches: "Matches water access",
  partial: "Partial match with water access",
  mismatch: "Water access mismatch",
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function cardRows(item: CompareItem): CardRow[] {
  const none = (key: CardRow["key"], label: string): CardRow => ({ key, label, value: NOT_SOURCED, chip: null, note: null });
  const window = item.plantingWindow;
  const windowIds = window?.evidenceIds ?? [];

  const season: CardRow = item.season && window ? { key: "season", label: "Season", value: capital(item.season), chip: regionChip(item, windowIds), note: null } : none("season", "Season");
  const plantingWindow: CardRow = window
    ? {
        key: "window",
        label: "Planting window",
        value: `${MONTHS[window.fromMonth - 1]} to ${MONTHS[window.toMonth - 1]}`,
        chip: regionChip(item, windowIds),
        note: item.context?.plantingMonthInWindow ? "Your sowing month is in this window" : "Check your chosen date",
      }
    : none("window", "Planting window");

  const d = item.dimensions.timeToFirstIncome;
  const days = d.value as { minDays?: number; maxDays?: number } | null;
  const duration: CardRow =
    d.status === "known" && days && typeof days.minDays === "number"
      ? {
          key: "duration",
          label: "Duration",
          value: days.maxDays != null && days.maxDays !== days.minDays ? `${days.minDays} to ${days.maxDays} days` : `${days.minDays} days`,
          // The duration of a sourced regional record follows that record's region; a sum of stage durations is sourced, not state-specific.
          chip: d.basis === "crop_duration_in_sourced_context" ? regionChip(item, d.evidenceIds) : d.evidenceIds.length ? "sourced" : "estimate",
          note: null,
        }
      : none("duration", "Duration");

  const w = item.dimensions.waterFit;
  const need = w.status === "known" && w.basis === "water_need_class" ? (w.value as { waterNeedClass?: string; fit?: string }) : null;
  const fit = w.status === "known" ? (w.value as { fit?: string } | null)?.fit : undefined;
  const water: CardRow = need?.waterNeedClass
    ? {
        key: "water",
        label: "Water need",
        value: `${capital(need.waterNeedClass)} water need`,
        chip: regionChip(item, w.evidenceIds),
        note: (fit && FIT_TEXT[fit]) || null,
      }
    : { ...none("water", "Water need"), note: (fit && FIT_TEXT[fit]) || null };

  return [season, plantingWindow, duration, water];
}
