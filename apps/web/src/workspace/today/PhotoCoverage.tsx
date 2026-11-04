import { For, Show } from 'solid-js';
import { canRetryPhotoCoverage, type FieldPhotoCoverage } from '@harvest/contracts';

/**
 * "What the photo shows" (docs/research/PHOTO_COVERAGE_SPEC.md). SAM 3.1 image-region shares for crop plants,
 * weed-like plants and standing water plus a Muse Spark sentence written from those numbers. Shares are of the
 * photo, not the field; with method 'box' they come from the union of outline boxes and overstate pixel share.
 */
export const COVERAGE_CAVEAT_BOX = 'AI estimate from image regions (box outlines), not a field measurement.';
export const COVERAGE_CAVEAT_MASK = 'AI estimate from image regions (outlines), not a field measurement.';

export function coveragePercent(fraction: number | null): string {
  if (fraction === null) return '–';
  if (fraction <= 0) return '0%';
  const p = Math.round(fraction * 100);
  return p < 1 ? '<1%' : `${p}%`;
}

export function coverageStatusText(c: FieldPhotoCoverage): string | null {
  if (c.status === 'queued' || c.status === 'running') return 'Measuring photo…';
  if (c.status === 'ready') return null;
  switch (c.failureReason) {
    case 'provider_unavailable': return 'Photo measuring needs the live AI service; nothing was measured.';
    case 'budget_exceeded': return 'Today’s AI budget is used up, so this photo was not measured.';
    case 'coverage_limit': return 'Today’s photo measurements are used up. Try again tomorrow.';
    case 'cancelled': return 'Measuring was cancelled.';
    case 'photo_changed': case 'photo_unavailable': return 'The photo changed or could not be read, so it was not measured.';
    case 'interrupted_needs_review': case 'provider_outcome_uncertain': return 'Measuring was interrupted. The result is not available.';
    case 'worker_interrupted': return 'Measuring stopped before the photo was sent. You can try again.';
    default: return 'This photo could not be measured.';
  }
}

/**
 * Retry is offered for failures known to have sent nothing. `provider_unavailable` (no live AI when the row was made)
 * is retryable only when the server now answers in live mode (F7); in live mode an outdated ready row can be measured again.
 */
export const canRetryCoverage = (c: FieldPhotoCoverage, live = false) =>
  (c.status === 'ready' && c.outdated && live) ||
  ((c.status === 'failed' || c.status === 'unavailable') && (c.failureReason !== 'provider_unavailable' || live) && canRetryPhotoCoverage(c.failureReason));
export const COVERAGE_OUTDATED = 'The photo date or the crop changed after this was measured, so the crop search words or the stage may no longer apply.';

/** The phrases actually sent for a class, shown when they differ from its label (e.g. "Standing water" was searched as "muddy water"). */
export function searchedAs(k: FieldPhotoCoverage['classes'][number]): string | null {
  const phrases = k.phrases ?? [];
  if (!phrases.length || (phrases.length === 1 && phrases[0]!.toLowerCase() === k.label.toLowerCase())) return null;
  return `${k.label} was searched as ${phrases.map(p => `“${p}”`).join(', then ')}.`;
}
const searchedNote = (c: FieldPhotoCoverage) => c.classes.map(searchedAs).filter((t): t is string => !!t).join(' ');

export function PhotoCoverage(props: {coverage: FieldPhotoCoverage | null | undefined; busy?: boolean; onRetry?: () => void; compact?: boolean; live?: boolean}) {
  return <Show when={props.coverage}>{c => <section class="photo-coverage" classList={{compact: !!props.compact}} aria-label="What the photo shows" aria-live="polite" data-testid="photo-coverage">
    <h4>What the photo shows</h4>
    <Show when={c().status === 'ready'} fallback={<p class="photo-coverage-status" role="status">{coverageStatusText(c())}</p>}>
      <ul class="photo-coverage-bars">
        <For each={c().classes}>{k => <li>
          <span class="photo-coverage-label">{k.label}</span>
          <span class="photo-coverage-track" role="meter" aria-label={`${k.label}: ${coveragePercent(k.fraction)} of the photo`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={k.fraction === null ? 0 : Math.round(k.fraction * 100)}>
            <span class={`photo-coverage-fill ${k.key}`} style={{width: `${Math.min(100, Math.max(0, (k.fraction ?? 0) * 100))}%`}}/>
          </span>
          <span class="photo-coverage-value">{coveragePercent(k.fraction)}</span>
        </li>}</For>
      </ul>
      <Show when={c().outdated}><p class="photo-coverage-status" role="status">{COVERAGE_OUTDATED}</p></Show>
      <Show when={!props.compact && !c().outdated && c().summary}><p class="photo-coverage-summary">{c().summary}</p></Show>
      <p class="photo-coverage-caveat">{c().method === 'mask' ? COVERAGE_CAVEAT_MASK : COVERAGE_CAVEAT_BOX}</p>
      <Show when={!props.compact && searchedNote(c())}><p class="photo-coverage-caveat">{searchedNote(c())}</p></Show>
      <Show when={!props.compact}><details class="photo-coverage-limits"><summary>How this was measured</summary><For each={c().limitations}>{l => <p>{l}</p>}</For></details></Show>
    </Show>
    <Show when={props.onRetry && canRetryCoverage(c(), !!props.live)}>
      <button type="button" class="btn compact secondary" disabled={props.busy} onClick={() => props.onRetry?.()}>{c().status === 'ready' ? 'Measure again' : 'Retry measuring'}</button>
    </Show>
  </section>}</Show>;
}
