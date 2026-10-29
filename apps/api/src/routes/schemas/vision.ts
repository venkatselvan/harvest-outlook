import { z } from "zod";
import { promptSchema } from "../../vision/jobs/segmentation";

export const segmentationBody = z.object({ prompt: promptSchema });

export const segmentationOut = z.object({
  jobId: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  /** True when an identical request (same session, image, prompt, model) returned an existing job. */
  deduplicated: z.boolean(),
  /** The manual polygon editor is always available regardless of this job. */
  manualFallbackAvailable: z.literal(true),
  label: z.string(),
});
