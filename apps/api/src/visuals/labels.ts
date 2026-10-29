/**
 * Honesty labels for the visual journey. Generated and schematic images are never observations.
 * These strings are mirrored by the web compositor (apps/web/src/features/season-scene/labels.ts).
 */
export const ILLUSTRATIVE_LABEL = "Illustrative growth — generated image, not a prediction";
export const SCHEMATIC_LABEL = "Schematic — simple drawing by stage order, not a growth model or prediction";
export const QA_FLAG_LABEL = "Scene changed outside the planting region";

export const VISUAL_JOB_TYPE = "visuals.keyframes";
export const MAX_KEYFRAMES = 5;
/** Longest side of the base image sent to the provider. */
export const MAX_SENT_SIDE = 1024;

/** Why a stage shows the schematic instead of a generated keyframe. */
export type SchematicReason = "synthetic_mode" | "replay_mode" | "provider_unavailable" | "no_brief";
/** Schematic outcomes that do not depend on credentials or time, so a repeat request is a cache hit. */
export const STABLE_SCHEMATIC_REASONS: ReadonlySet<string> = new Set<SchematicReason>(["synthetic_mode", "replay_mode", "no_brief"]);

export type AssetState = "queued" | "ready" | "failed" | "schematic";
