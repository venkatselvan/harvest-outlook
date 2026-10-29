import { z } from "zod";

export const sessionOut = z.object({
  authenticated: z.boolean(),
  scope: z.literal("device_guest").optional(),
  expiresAt: z.string().optional(),
  /** Mirror of the ho_csrf cookie; send it back in X-CSRF-Token on state-changing requests. */
  csrfToken: z.string().optional(),
  reused: z.boolean().optional(),
  caveat: z.string().optional(),
});
export const sessionDeletedOut = z.object({ revoked: z.boolean() });
export const jobOut = z.object({
  id: z.string(),
  type: z.string(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  progress: z.number(),
  attempt: z.number(),
  maxAttempts: z.number(),
  retryable: z.boolean().nullable(),
  cancelRequested: z.boolean(),
  result: z.unknown(),
  error: z.object({ code: z.string(), retryable: z.boolean() }).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
