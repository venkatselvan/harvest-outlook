import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { backdropSuppressed, claimBackdrop } from '../mapLayer';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

// The vitest environment is the Solid server build, where onCleanup and onMount are no-ops. The claim and release logic is
// tested directly; the wiring (dashboard claims, backdrop reacts, CSS hides) is asserted against the sources.
describe('shell backdrop suppression while the All farms map is mounted', () => {
  it('is set by a claim and cleared by its release', () => {
    expect(backdropSuppressed()).toBe(false);
    const release = claimBackdrop();
    expect(backdropSuppressed()).toBe(true);
    release();
    expect(backdropSuppressed()).toBe(false);
  });
  it('a new mount claiming before the old one releases is not cleared by the old release, and release is idempotent', () => {
    const first = claimBackdrop();
    const second = claimBackdrop();
    first();
    first();
    expect(backdropSuppressed()).toBe(true);
    second();
    expect(backdropSuppressed()).toBe(false);
  });
  it('the dashboard map claims the backdrop for its lifetime', () => {
    const source = read('./FarmsMap.tsx');
    expect(source).toMatch(/\bsuppressBackdrop\(\);/);
    // suppressBackdrop releases through onCleanup.
    expect(read('../mapLayer.ts')).toMatch(/onCleanup\(release\)/);
  });
  it('the backdrop drops its map, credit and notes and flags the root while suppressed, and the Today rule is untouched', () => {
    const source = read('../WorkspaceBackdrop.tsx');
    expect(source).toContain('"backdrop-suppressed": suppressed()');
    expect(source).toContain('"credit-in-band": fullTab() && !!mapFocus()');
    expect(source).toMatch(/const b = suppressed\(\) \? null : boundary\(\)/);
    expect(source).toMatch(/const point = suppressed\(\) \? null : savedPoint\(\)/);
    const css = read('../glass.css');
    expect(css).toMatch(/\.workspace-backdrop\.backdrop-suppressed :is\(\.workspace-backdrop-map,\.workspace-imagery-credit,\.workspace-geography-note\)\{display:none\}/);
    expect(css).toContain('.workspace-backdrop.credit-in-band .workspace-imagery-credit{display:none}');
  });
});
