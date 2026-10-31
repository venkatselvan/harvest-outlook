import { z } from 'zod';
import { DecimalString, Id, IsoDate, IsoDateTime, Mode, SchemaVersion, Sha256Hex } from './common';

export const JobState = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobState>;

/**
 * BUILD_SPEC 12 job state machine. running -> queued is a lease-expiry/retry
 * requeue. Terminal states have no outgoing transitions.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'queued'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export const JobKind = z.enum([
  'segmentation',
  'visual_keyframes',
  'observation_analysis',
  'document_extraction',
  'forecast_replay',
  'speech_transcription',
  'speech_synthesis',
]);

export const JobFailure = z
  .object({
    code: z.string().min(1),
    classification: z.enum(['transient', 'permanent', 'uncertain_provider_outcome']),
    retryable: z.boolean(),
    message: z.string().max(2000),
  })
  .strict();

export const Job = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    ownerId: Id.nullable(),
    mode: Mode,
    kind: JobKind,
    state: JobState,
    attempt: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    leaseOwner: z.string().nullable(),
    leaseExpiresAt: IsoDateTime.nullable(),
    progress: z.number().min(0).max(1),
    idempotencyKey: z.string().min(1).max(200).nullable(),
    payloadHash: Sha256Hex,
    outputRefs: z.array(Id),
    failure: JobFailure.nullable(),
    reservationId: Id.nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    cancelRequestedAt: IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((j, ctx) => {
    if (j.attempt > j.maxAttempts) ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'attempt exceeds maxAttempts' });
    if (j.state === 'failed' && j.failure === null) ctx.addIssue({ code: 'custom', path: ['failure'], message: 'failed job requires failure' });
    if (j.state === 'running' && j.leaseExpiresAt === null) ctx.addIssue({ code: 'custom', path: ['leaseExpiresAt'], message: 'running job requires a lease' });
  });
export type Job = z.infer<typeof Job>;

/** Includes retired provider names solely to read historical usage ledger rows. No adapter is dispatched from this enum. */
export const Provider = z.enum(['meta', 'elevenlabs']);

export const UsageReservation = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    ownerId: Id.nullable(),
    sessionId: Id.nullable(),
    provider: Provider,
    operation: z.string().min(1),
    modelId: z.string().min(1),
    estimatedMaxUsd: DecimalString,
    state: z.enum(['reserved', 'settled', 'released', 'uncertain']),
    jobId: Id.nullable(),
    agentRunId: Id.nullable(),
    priceTableVersion: z.string().min(1),
    createdAt: IsoDateTime,
    resolvedAt: IsoDateTime.nullable(),
  })
  .strict();
export type UsageReservation = z.infer<typeof UsageReservation>;

export const UsageLedgerEntry = z
  .object({
    schemaVersion: SchemaVersion,
    id: Id,
    reservationId: Id,
    provider: Provider,
    modelId: z.string().min(1),
    operation: z.string().min(1),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        images: z.number().int().nonnegative().optional(),
        audioSeconds: z.number().nonnegative().optional(),
        characters: z.number().int().nonnegative().optional(),
        requests: z.number().int().nonnegative().optional(),
      })
      .strict(),
    estimatedUsd: DecimalString,
    billedUsd: DecimalString.nullable(),
    costBasis: z.enum(['estimated', 'billed']),
    providerRequestId: z.string().nullable(),
    priceTableVersion: z.string().min(1),
    recordedAt: IsoDateTime,
  })
  .strict()
  .refine((e) => (e.costBasis === 'billed') === (e.billedUsd !== null), { message: 'billed basis requires billedUsd and vice versa' });
export type UsageLedgerEntry = z.infer<typeof UsageLedgerEntry>;

export const PriceTable = z
  .object({
    schemaVersion: SchemaVersion,
    version: z.string().min(1),
    effectiveFrom: IsoDate,
    currency: z.literal('USD'),
    source: z.object({ url: z.url().nullable(), retrievedAt: IsoDateTime.nullable(), verified: z.boolean(), note: z.string().optional() }).strict(),
    entries: z
      .array(
        z
          .object({
            provider: Provider,
            modelId: z.string().min(1),
            meter: z.enum(['input_token', 'output_token', 'image', 'audio_second', 'character', 'request']),
            usdPerBlock: DecimalString,
            blockSize: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type PriceTable = z.infer<typeof PriceTable>;
