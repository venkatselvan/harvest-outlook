import { For, Show } from 'solid-js';
import type { FarmSummary as Summary } from '@harvest/contracts';
import type { SummaryEntry } from './summaries';

export const summaryOrigin = (summary: Summary) => summary.origin === 'model' ? 'AI summary' : 'Farm records';
export const showDeferredRefresh = (summary: Summary) => !!summary.retryAfter && summary.status !== 'pending' && !summary.canGenerate && !(summary.origin === 'model' && summary.status === 'ready');
export function FarmSummaryHeadline(props: { entry: SummaryEntry | undefined }) {
  return <Show when={props.entry?.summary} fallback={<small class="af-summary-preview" role="status">{props.entry?.status === 'error' ? 'Summary unavailable' : 'Reading farm summary…'}</small>}>
    {(summary) => <small class="af-summary-preview"><span class="af-summary-origin">{summaryOrigin(summary())}</span>{summary().headline || 'No summary available for this farm yet.'}</small>}
  </Show>;
}
export function FarmSummaryPanel(props: { entry: SummaryEntry | undefined; onRetry: () => void; onActions: () => void }) {
  const summary = () => props.entry?.summary;
  const points = () => [...(summary()?.points ?? [])].sort((a, b) => {
    const order = ['do_now', 'watch', 'later', 'money', 'good_news'];
    return order.indexOf(a.kind) - order.indexOf(b.kind);
  }).slice(0, 3);
  const timestamp = (value: string) => new Date(value).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return <section class="af-summary" aria-label="Selected farm summary" aria-busy={props.entry?.status === 'loading' || props.entry?.busy}>
    <Show when={summary()} fallback={<p role="status">{props.entry?.status === 'error' ? 'This farm summary is unavailable.' : 'Reading this farm’s summary…'}</p>}>
      {(current) => <>
        <div class="af-summary-heading"><span class="af-badge">{summaryOrigin(current())}</span><span>Whole farm</span></div>
        <p class="af-summary-headline">{current().headline || 'No summary available for this farm yet.'}</p>
        <Show when={points().length}><ul class="af-summary-points"><For each={points()}>{point => <li>{point.text}</li>}</For></ul></Show>
        <Show when={current().status === 'pending'}><p class="af-summary-status" role="status">{props.entry?.pollingStopped ? 'The AI summary is taking longer than usual. Current farm information is shown above.' : 'Preparing the AI summary. Current farm information is shown while it runs.'}</p></Show>
        <Show when={current().status === 'unavailable'}><p class="af-summary-status">AI summary unavailable. These are the available farm records.</p></Show>
        <p class="af-summary-time">{current().origin === 'model' && current().generatedAt ? <>Generated <time dateTime={current().generatedAt!}>{timestamp(current().generatedAt!)}</time></> : <>Records checked <time dateTime={current().asOf}>{timestamp(current().asOf)}</time></>}</p>
        <Show when={showDeferredRefresh(current())}><p class="af-summary-time">AI refresh deferred until <time dateTime={current().retryAfter!}>{timestamp(current().retryAfter!)}</time></p></Show>
        <Show when={current().facts.length}><details class="af-summary-facts"><summary>Facts behind this summary <span>{current().facts.length}</span></summary><ul><For each={current().facts}>{fact => <li>{fact.text}</li>}</For></ul></details></Show>
      </>}
    </Show>
    <Show when={props.entry?.error}><p class="af-summary-status" role="status">{props.entry!.error}</p></Show>
    <div class="af-summary-actions">
      <Show when={summary()?.canGenerate && summary()?.status !== 'pending' && !props.entry?.busy && props.entry?.status !== 'error'}><button class="af-text-link" onClick={props.onRetry}>Generate AI summary</button></Show>
      <Show when={props.entry?.status === 'error' || props.entry?.pollingStopped}><button class="af-text-link" disabled={props.entry?.busy} onClick={props.onRetry}>Retry summary</button></Show>
      <button class="af-text-link" onClick={props.onActions}>Review farm actions ↗</button>
    </div>
  </section>;
}
