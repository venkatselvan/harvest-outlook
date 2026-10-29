import { PlanSnapshot } from '@harvest/contracts';
import { contentHash } from '../hash';

export type PlanSnapshotDraft = Omit<PlanSnapshot, 'contentHash'>;

/** Hash covers every field except contentHash itself. */
export function computePlanContentHash(draft: PlanSnapshotDraft): string {
  const { contentHash: _ignored, ...rest } = draft as PlanSnapshotDraft & { contentHash?: string };
  return contentHash(rest);
}

/** Build a validated, deeply frozen snapshot. */
export function sealPlanSnapshot(draft: PlanSnapshotDraft): PlanSnapshot {
  const parsed = PlanSnapshot.parse({ ...draft, contentHash: computePlanContentHash(draft) });
  return deepFreeze(parsed);
}

export function verifyPlanSnapshot(s: PlanSnapshot): boolean {
  return computePlanContentHash(s) === s.contentHash;
}

/**
 * Create a revision draft from a parent. Refuses when the caller's expected
 * parent hash does not match (optimistic concurrency). The parent is untouched.
 */
export function deriveRevisionDraft(
  parent: PlanSnapshot,
  expectedParentHash: string,
  changes: Partial<Pick<PlanSnapshotDraft, 'confirmedInputs' | 'assumptions' | 'ruleVersions' | 'modelVersions' | 'outputIds' | 'sourceSnapshotId'>> & {
    id: string;
    createdAt: string;
    decidedAt: string;
  },
): PlanSnapshotDraft {
  if (!verifyPlanSnapshot(parent)) throw new Error('parent snapshot hash does not verify');
  if (parent.contentHash !== expectedParentHash) throw new Error('version_conflict: parent hash mismatch');
  const { contentHash: parentHash, ...base } = parent;
  return { ...structuredClone(base), ...structuredClone(changes), parentId: parent.id, parentContentHash: parentHash };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}
