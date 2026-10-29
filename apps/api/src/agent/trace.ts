import type { ParsedUsage } from "../providers/meta/types";
import type { Provenance } from "./provider";

const MAX_TEXT = 200;
const COORD_KEYS = /^(lat|lon|lng|latitude|longitude|coordinates|coords|point|geometry|location_geojson|accuracym)$/i;
const IMAGE_KEYS = /^(image_url|imagebase64|image_base64|b64_json|bytes|buffer|photo|photos|polygon|region_polygon)$/i;
const TEXTISH_KEYS = /(text|transcript|note|utterance|sourcespan|input)/i;
const COORD_PAIR = /-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}/g;

/**
 * Redacts a value for the persisted trace: no image bytes/data URLs, no precise coordinates, and no
 * free text beyond 200 characters (transcripts and notes are truncated). Applied recursively.
 */
export function redactForTrace(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") {
    if (/^data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(value)) return "[image omitted]";
    let s = value.replace(COORD_PAIR, "[coordinates redacted]");
    if (s.length > MAX_TEXT && (TEXTISH_KEYS.test(key) || key === "")) s = `${s.slice(0, MAX_TEXT)}…[truncated ${value.length - MAX_TEXT} chars]`;
    else if (s.length > 2000) s = `${s.slice(0, 2000)}…[truncated]`;
    return s;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactForTrace(v, key, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (COORD_KEYS.test(k)) out[k] = "[coordinates redacted]";
      else if (IMAGE_KEYS.test(k)) out[k] = "[omitted]";
      else out[k] = redactForTrace(v, k, depth + 1);
    }
    return out;
  }
  return value;
}

export type TraceStepKind =
  | "run_started"
  | "provider_call"
  | "tool_call"
  | "gate"
  | "ceiling_refused"
  | "budget"
  | "cancelled"
  | "provider_error"
  | "escalation"
  | "run_finished";

export interface TraceStep {
  n: number;
  at: string;
  kind: TraceStepKind;
  pass?: string;
  provider?: Provenance;
  model?: string;
  requestId?: string | null;
  responseId?: string | null;
  usage?: ParsedUsage;
  latencyMs?: number;
  retries?: number;
  detail?: unknown;
}

export class AgentTrace {
  readonly steps: TraceStep[] = [];
  constructor(readonly runId: string) {}

  add(kind: TraceStepKind, fields: Omit<TraceStep, "n" | "at" | "kind" | "detail"> & { detail?: unknown } = {}): TraceStep {
    const { detail, ...rest } = fields;
    const step: TraceStep = { n: this.steps.length + 1, at: new Date().toISOString(), kind, ...rest, ...(detail !== undefined ? { detail: redactForTrace(detail) } : {}) };
    this.steps.push(step);
    return step;
  }

  toJSON(): { runId: string; steps: TraceStep[] } {
    return { runId: this.runId, steps: this.steps };
  }
}
