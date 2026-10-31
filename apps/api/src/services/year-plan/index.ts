/**
 * Deterministic year-plan engine (Stream A, packet 1). Pure modules: no database, network or model calls.
 * Orchestration (packet 2): buildScenario -> enumerateCandidates -> runInputKeys -> prefetch Inputs ->
 * runYearPlanEngine -> Meta selects among the shortlist -> rescoreOption for farmer edits (editInputKeys first).
 */
export * from './types';
export * from './dates';
export * as data from './data';
export * from './scoring';
export * from './inputs';
export * from './scenario';
export * from './windows';
export * from './candidates';
export * from './assemble';
