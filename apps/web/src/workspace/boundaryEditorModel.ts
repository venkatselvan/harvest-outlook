/** Local edits remain reversible until the farmer explicitly finishes the outline. */
export interface BoundaryDraft<T> { points: readonly T[]; history: readonly (readonly T[])[] }
export const boundaryDraft = <T>(points: readonly T[] = []): BoundaryDraft<T> => ({ points: [...points], history: [] });
export const commitBoundaryDraft = <T>(draft: BoundaryDraft<T>, points: readonly T[]): BoundaryDraft<T> => ({ points: [...points], history: [...draft.history, draft.points] });
export const undoBoundaryDraft = <T>(draft: BoundaryDraft<T>): BoundaryDraft<T> => draft.history.length ? { points: draft.history[draft.history.length - 1]!, history: draft.history.slice(0, -1) } : draft;
