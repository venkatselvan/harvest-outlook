import type { YearPlanReview } from "@harvest/contracts";
import { USE_PLAN_ALTERNATIVE_PARAM, USE_PLAN_OPTION_PARAM } from "../evara/actions";

/**
 * The Plan tab link of Evara's `use_plan` action (`/farm?tab=year&field=<id>&option=<optionId>[&alternative=1]`, built by
 * `usePlanHref` in evara/actions.ts, whose parameter names are imported here, not repeated). Pure: no router, no Solid.
 */

export interface UsePlanTarget {
  optionId: string;
  /** True when the option is one of `review.alternatives.options`: the sheet opens in alternative mode. */
  alternative: boolean;
}

/**
 * The option the link asks for, or null when the link names none or the loaded review has no such option. With
 * `alternative=1` the alternatives are searched first, without it the review's own options; the other list is the
 * fallback (option ids of the alternatives start with "alt-" and never collide with the review's own), so a link whose
 * flag disagrees with the review still opens the right plan rather than nothing.
 */
export function usePlanTarget(search: string, review: Pick<YearPlanReview, "options" | "alternatives"> | undefined): UsePlanTarget | null {
  const params = new URLSearchParams(search);
  const optionId = params.get(USE_PLAN_OPTION_PARAM);
  if (!optionId || !review) return null;
  const inOwn = review.options.some((o) => o.optionId === optionId);
  const inAlternatives = !!review.alternatives?.options.some((o) => o.optionId === optionId);
  if (!inOwn && !inAlternatives) return null;
  const preferAlternative = params.get(USE_PLAN_ALTERNATIVE_PARAM) === "1";
  return { optionId, alternative: preferAlternative ? inAlternatives : !inOwn };
}

/** True when the query string carries either parameter. */
export const hasUsePlanParams = (search: string): boolean => {
  const params = new URLSearchParams(search);
  return params.has(USE_PLAN_OPTION_PARAM) || params.has(USE_PLAN_ALTERNATIVE_PARAM);
};

/** The query string without the two parameters (everything else, such as tab and field, stays), as "?a=b" or "". */
export function withoutUsePlanParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(USE_PLAN_OPTION_PARAM);
  params.delete(USE_PLAN_ALTERNATIVE_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}
