import { describe, expect, it } from 'vitest';
import { renderToString } from 'solid-js/web';
import { FieldPhotoCoverage, PHOTO_COVERAGE_PROMPT_VERSION } from '@harvest/contracts';
import { canRetryCoverage, COVERAGE_CAVEAT_BOX, COVERAGE_OUTDATED, coveragePercent, coverageStatusText, PhotoCoverage, searchedAs } from './PhotoCoverage';

const base = FieldPhotoCoverage.parse({
  photoId: '00000000-0000-4000-8000-000000000001', status: 'ready', method: 'box', modelId: 'sam-3.1', summaryModelId: 'muse-spark-1.3',
  classes: [
    {key: 'crop', label: 'Maize plants', fraction: 0.293, regions: 2, confidence: 0.6, phrases: ['maize plants']},
    {key: 'weed', label: 'Weed-like plants', fraction: 0.004, regions: 1, confidence: 0.99, phrases: ['weeds']},
    {key: 'water', label: 'Standing water', fraction: 0, regions: 0, confidence: null, phrases: ['muddy water', 'flooded field']},
  ],
  summary: 'Outlines cover about 29% for maize plants.', limitations: ['Measured from SAM 3.1 region outlines (boxes).'], failureReason: null, promptVersion: PHOTO_COVERAGE_PROMPT_VERSION, createdAt: '2026-11-04T00:00:00Z', outdated: false,
});

describe('photo coverage block', () => {
  it('renders three bars, the summary, the box caveat and the phrases actually searched', () => {
    const html = renderToString(() => <PhotoCoverage coverage={base}/>);
    expect(html).toContain('What the photo shows');
    expect(html).toContain('Maize plants'); expect(html).toContain('29%'); expect(html).toContain('&lt;1%'); expect(html).toContain('0%');
    expect(html).toContain('Outlines cover about 29% for maize plants.');
    expect(html).toContain(COVERAGE_CAVEAT_BOX);
    expect(html.match(/role="meter"/g)).toHaveLength(3);
    expect(html).toContain('Standing water was searched as “muddy water”, then “flooded field”.');
    expect(searchedAs(base.classes[0]!)).toBeNull();
  });
  it('shows status while measuring and offers retry only for retryable failures', () => {
    const queued = {...base, status: 'queued' as const, classes: [], summary: null};
    expect(renderToString(() => <PhotoCoverage coverage={queued}/>)).toContain('Measuring photo…');
    const failed = {...base, status: 'failed' as const, failureReason: 'provider_server', classes: []};
    expect(canRetryCoverage(failed)).toBe(true);
    expect(renderToString(() => <PhotoCoverage coverage={failed} onRetry={() => {}}/>)).toContain('Retry measuring');
    const uncertain = {...base, status: 'failed' as const, failureReason: 'interrupted_needs_review', classes: []};
    expect(canRetryCoverage(uncertain)).toBe(false);
    expect(canRetryCoverage(uncertain, true)).toBe(false);
    const stopped = {...base, status: 'failed' as const, failureReason: 'worker_interrupted', classes: []};
    expect(canRetryCoverage(stopped)).toBe(true);
    expect(coverageStatusText(stopped)).toContain('before the photo was sent');
  });
  it('F7: an old provider_unavailable row offers a retry only when the server answers in live mode', () => {
    const unavailable = {...base, status: 'unavailable' as const, failureReason: 'provider_unavailable', classes: []};
    expect(canRetryCoverage(unavailable)).toBe(false);
    expect(coverageStatusText(unavailable)).toContain('nothing was measured');
    expect(renderToString(() => <PhotoCoverage coverage={unavailable} onRetry={() => {}}/>)).not.toContain('Retry measuring');
    expect(canRetryCoverage(unavailable, true)).toBe(true);
    expect(renderToString(() => <PhotoCoverage coverage={unavailable} live onRetry={() => {}}/>)).toContain('Retry measuring');
  });
  it('F5: an outdated measurement hides the summary, says why, and can be measured again in live mode', () => {
    const outdated = {...base, outdated: true};
    const html = renderToString(() => <PhotoCoverage coverage={outdated} live onRetry={() => {}}/>);
    expect(html).toContain(COVERAGE_OUTDATED);
    expect(html).not.toContain('Outlines cover about 29% for maize plants.');
    expect(html).toContain('Re-evaluate');
    expect(renderToString(() => <PhotoCoverage coverage={outdated} onRetry={() => {}}/>)).not.toContain('Re-evaluate');
    expect(renderToString(() => <PhotoCoverage coverage={base} live onRetry={() => {}}/>)).toContain('Re-evaluate');
  });
  it('offers evaluation for older photos without coverage, but not compact comparisons or offline views', () => {
    expect(renderToString(() => <PhotoCoverage coverage={null} live onRetry={() => {}}/>)).toContain('Re-evaluate');
    expect(renderToString(() => <PhotoCoverage coverage={base} live compact onRetry={() => {}}/>)).not.toContain('Re-evaluate');
    expect(renderToString(() => <PhotoCoverage coverage={base} live busy onRetry={() => {}}/>)).toContain('disabled');
  });
  it('renders nothing without coverage and formats percentages', () => {
    expect(renderToString(() => <PhotoCoverage coverage={null}/>)).toBe('');
    expect([coveragePercent(null), coveragePercent(0), coveragePercent(0.004), coveragePercent(0.5)]).toEqual(['–', '0%', '<1%', '50%']);
  });
});
