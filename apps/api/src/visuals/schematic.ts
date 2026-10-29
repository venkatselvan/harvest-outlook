import { SCHEMATIC_LABEL } from "./labels";

/**
 * Server-side metadata for the schematic fallback. The drawing itself is rendered in the browser
 * (apps/web/src/features/season-scene/schematic.ts): ground plus simple stems whose count and height scale with
 * the stage ORDER only. It is not a growth model and carries no agronomic quantity.
 */
export interface SchematicSpec {
  kind: "schematic";
  label: string;
  /** Stems drawn for a stage index; mirrors the web renderer and is asserted equal in tests. */
  stemsForStage: (stageIndex: number, stageCount: number) => number;
}

export const SCHEMATIC: SchematicSpec = {
  kind: "schematic",
  label: SCHEMATIC_LABEL,
  stemsForStage: (i, n) => 2 + Math.round((Math.max(0, Math.min(i, n - 1)) * 6) / Math.max(1, n - 1)),
};
