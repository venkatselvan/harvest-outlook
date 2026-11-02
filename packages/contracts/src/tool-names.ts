import { z } from 'zod';

/** BUILD_SPEC 9 allowlisted agent tools. Names are exact and stable. */
export const ToolName = z.enum([
  'resolve_crop_identity',
  'get_farm_context',
  'retrieve_evidence',
  'screen_crops',
  'get_market_outlook',
  'calculate_scenarios',
  'calculate_water_balance',
  'interpret_observation',
  'propose_plan_revision',
  'request_segmentation',
  'request_visual_keyframes',
  'get_job_status',
  /** 2026-11-02: server-composed, read-only state of the selected farm (docs/research/ASSISTANT_FARM_BRIEFING_SPEC.md). */
  'get_farm_briefing',
]);
export type ToolName = z.infer<typeof ToolName>;
