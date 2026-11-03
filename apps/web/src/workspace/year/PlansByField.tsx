import { For, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { Icon } from "../icons";
import { cropColor } from "../today/model";
import { cropLabel, fieldCropOf, type FieldCycleLike } from "../fields/fieldsModel";
import { monthYear } from "./format";
import { reportHref } from "../report/reportApi";

/**
 * "Plans by field" (FIELDS_MULTICROP_SOIL_SPEC.md 12.6): the Plan tab's "All fields" view on a farm with fields. Each field
 * has its own year plan on the server, so no farm-level plan is shown; one row per field names its current crop and the
 * next saved season planned for it, and "Open plan" selects the field (the shell keeps it in `?field=`).
 */
export interface PlanFieldLike {
  id: string;
  name: string;
}
/** A saved season as the workspace stores it (only what the rows read). */
export interface PlanSeasonLike {
  id: string;
  year: number;
  season: string;
  cropId: string;
  cropName?: string | undefined;
  plannedSowingDate?: string | undefined;
  companion?: { cropId: string; cropName?: string | undefined; rowRatio?: string | undefined } | undefined;
  fieldId?: string | undefined;
}
export interface FieldPlanRow {
  id: string;
  name: string;
  /** "Maize", "Paddy + black gram", "Maize (whole farm)" or "No crop". */
  crop: string;
  /** The crop is a legacy whole-farm cycle (it names no field), shown for every field without its own cycle. */
  wholeFarm: boolean;
  cropId: string | null;
  /** "Black gram, sowing Feb 2027", "Maize, Kharif 2027" (no planned date) or "None planned". */
  next: string;
  /** The saved season the `next` text describes, or null. */
  nextPlanId: string | null;
}

/**
 * The field's next planned season: saved seasons naming this field (legacy farm-wide seasons without a fieldId are not
 * counted) whose planned sowing is today or later; a season without a planned date counts from its year onwards and
 * sorts after dated seasons of the same year. Earliest first.
 */
export function nextSeasonOf<P extends PlanSeasonLike>(fieldId: string, plans: readonly P[], todayIso: string): P | null {
  const thisYear = Number(todayIso.slice(0, 4));
  const sortKey = (p: P) => p.plannedSowingDate ?? `${p.year}-99`;
  return (
    plans
      .filter((p) => p.fieldId === fieldId && (p.plannedSowingDate ? p.plannedSowingDate >= todayIso : p.year >= thisYear))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0] ?? null
  );
}

export function nextSeasonText(plan: PlanSeasonLike | null, cropName: (cropId: string) => string): string {
  if (!plan) return "None planned";
  const crop = cropLabel(plan, cropName);
  return plan.plannedSowingDate ? `${crop}, sowing ${monthYear(plan.plannedSowingDate)}` : `${crop}, ${plan.season} ${plan.year}`;
}

export function plansByField(
  fields: readonly PlanFieldLike[],
  cycles: readonly FieldCycleLike[],
  plans: readonly PlanSeasonLike[],
  todayIso: string,
  cropName: (cropId: string) => string,
): FieldPlanRow[] {
  return fields.map((field) => {
    const { cycle, wholeFarm, label } = fieldCropOf(field.id, cycles, cropName);
    const next = nextSeasonOf(field.id, plans, todayIso);
    return {
      id: field.id,
      name: field.name,
      crop: label,
      wholeFarm,
      cropId: cycle?.cropId ?? null,
      next: nextSeasonText(next, cropName),
      nextPlanId: next?.id ?? null,
    };
  });
}

/** The router's navigate, or undefined when rendered without one (static markup in tests): the link then works as a plain anchor. */
function routerNavigate(): ((to: string) => void) | undefined {
  try {
    return useNavigate();
  } catch {
    return undefined;
  }
}

export function PlansByField(props: { rows: readonly FieldPlanRow[]; onOpen: (fieldId: string) => void }) {
  const navigate = routerNavigate();
  return (
    <div class="yp-by-field" data-testid="yp-plans-by-field">
      <h3 class="yp-by-field-title">Plans by field</h3>
      <p class="yp-muted">Each field has its own year plan. Open a field to see and change its plan.</p>
      <ul class="yp-by-field-list">
        <For each={props.rows}>
          {(row) => (
            <li class="yp-by-field-row" data-field-plan={row.id}>
              <span class="today-field-swatch" style={{ background: cropColor(row.cropId) }} aria-hidden="true" />
              <div class="yp-by-field-text">
                <strong>{row.name}</strong>
                <span class="yp-by-field-now" data-testid="yp-field-crop">
                  Now: {row.crop}
                </span>
                <span class="yp-by-field-next" data-testid="yp-field-next">
                  Next: {row.next}
                </span>
              </div>
              <button
                type="button"
                class="btn compact secondary"
                aria-label={`Open the plan for ${row.name}`}
                data-open-field-plan={row.id}
                onClick={() => props.onOpen(row.id)}
              >
                Open plan <Icon name="arrow" size={14} />
              </button>
              <Show when={row.cropId !== null}>
                <a
                  class="btn compact secondary"
                  href={reportHref({ fieldId: row.id })}
                  aria-label={`Open the season report for ${row.name}`}
                  data-open-field-report={row.id}
                  onClick={(event) => {
                    if (!navigate || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
                    event.preventDefault();
                    navigate(reportHref({ fieldId: row.id }));
                  }}
                >
                  Open report
                </a>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
