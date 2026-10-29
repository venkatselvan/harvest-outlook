import { PlanSnapshot } from '@harvest/contracts';
import { describe, expect, it } from 'vitest';
import { computePlanContentHash, deriveRevisionDraft, sealPlanSnapshot, verifyPlanSnapshot, type PlanSnapshotDraft } from './snapshot';

const draft: PlanSnapshotDraft = {
  schemaVersion: '1.0',
  id: 'synthetic-plan-1',
  parentId: null,
  parentContentHash: null,
  ownerId: 'synthetic-owner',
  farmId: 'synthetic-farm',
  cropId: 'synthetic-ginger',
  productId: 'synthetic-ginger-fresh',
  createdAt: '2026-10-30T00:00:00Z',
  decidedAt: '2026-10-30T00:00:00Z',
  mode: 'synthetic',
  sourceSnapshotId: 'synthetic-snapshot',
  confirmedInputs: [],
  assumptions: [],
  ruleVersions: [{ id: 'synthetic-rule', version: 1 }],
  modelVersions: [],
  outputIds: [],
};

describe('plan snapshots', () => {
  it('seals with a stable content hash and is frozen', () => {
    const s = sealPlanSnapshot(draft);
    expect(s.contentHash).toBe(computePlanContentHash(draft));
    expect(verifyPlanSnapshot(s)).toBe(true);
    expect(Object.isFrozen(s)).toBe(true);
    expect(() => {
      (s as { cropId: string }).cropId = 'synthetic-other';
    }).toThrow();
    expect(PlanSnapshot.parse(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
  it('detects tampering', () => {
    const s = sealPlanSnapshot(draft);
    expect(verifyPlanSnapshot({ ...s, cropId: 'synthetic-other' })).toBe(false);
  });
  it('revision links parent and requires the expected parent hash', () => {
    const parent = sealPlanSnapshot(draft);
    expect(() => deriveRevisionDraft(parent, '0'.repeat(64), { id: 'synthetic-plan-2', createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-01T00:00:00Z' })).toThrow(/version_conflict/);
    const child = sealPlanSnapshot(deriveRevisionDraft(parent, parent.contentHash, { id: 'synthetic-plan-2', createdAt: '2026-11-01T00:00:00Z', decidedAt: '2026-11-01T00:00:00Z', outputIds: ['synthetic-output'] }));
    expect(child.parentId).toBe(parent.id);
    expect(child.parentContentHash).toBe(parent.contentHash);
    expect(child.contentHash).not.toBe(parent.contentHash);
    expect(parent.outputIds).toEqual([]);
  });
});
