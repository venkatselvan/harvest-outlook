import { z } from "zod";

/**
 * Strict-mode JSON Schema generation for Meta Responses `text.format` / function tools.
 *
 * The contracts zod schemas are the single source of truth. Strict mode requires
 * `additionalProperties: false` on every object and every property listed in `required`;
 * originally optional properties are therefore sent as `anyOf [schema, null]`, and
 * `restoreOptionals` removes those nulls again before zod validation so the contract
 * (which uses `.optional()`) is validated exactly as written.
 */
export type JsonSchema = { [k: string]: unknown };

const isObj = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

export interface StrictOptions {
  /** Replace the schema at these top-level property names (e.g. `toolRequests`, whose items are z.unknown()). */
  overrideProperties?: Record<string, JsonSchema>;
}

export function toStrictJsonSchema(schema: z.ZodType, opts: StrictOptions = {}): JsonSchema {
  const raw = z.toJSONSchema(schema, { io: "output", unrepresentable: "any", reused: "inline", target: "draft-7" }) as JsonSchema;
  const out = strictify(raw) as JsonSchema;
  if (opts.overrideProperties && isObj(out.properties)) {
    for (const [k, v] of Object.entries(opts.overrideProperties)) {
      if (k in out.properties) out.properties[k] = v;
    }
  }
  return out;
}

/** The unmodified JSON Schema, kept so optional properties can be restored on the way back. */
export function toRawJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { io: "output", unrepresentable: "any", reused: "inline", target: "draft-7" }) as JsonSchema;
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!isObj(node)) return node;
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$schema" || k === "default") continue;
    if (k === "oneOf") {
      out.anyOf = strictify(v);
      continue;
    }
    if (k === "properties" && isObj(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strictify(pv)]));
      continue;
    }
    out[k] = strictify(v);
  }
  if (isObj(out.properties)) {
    const props = out.properties;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = nullable(props[key]);
    }
    out.required = Object.keys(props);
    out.additionalProperties = false;
  } else if (out.type === "object" && out.additionalProperties === undefined) {
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  return collapseNullableAnyOf(out);
}

const isNullType = (b: unknown): boolean => isObj(b) && b.type === "null" && Object.keys(b).length === 1;
const singleType = (n: JsonSchema): string | null => (typeof n.type === "string" && n.type !== "null" && n.anyOf === undefined && n.allOf === undefined && n.const === undefined ? n.type : null);

/**
 * Makes a schema nullable using a type array (`type: [T, "null"]`) when it has a single primitive/object type,
 * falling back to `anyOf [schema, {type: "null"}]` otherwise.
 *
 * Verified live 2026-10-30 (muse-spark-1.3, strict function tool): with `anyOf [object, null]` the model
 * returned the *string* `"null"` for an omitted optional object (`{"context":"null",...}`), which fails the
 * contract; with `type: ["object", "null"]` it returned a JSON `null`. Both forms are accepted by the API.
 */
function nullable(node: unknown): JsonSchema {
  if (isObj(node)) {
    const t = singleType(node);
    if (t !== null) {
      const out: JsonSchema = { ...node, type: [t, "null"] };
      if (Array.isArray(node.enum) && !node.enum.includes(null)) out.enum = [...node.enum, null];
      return out;
    }
    if (Array.isArray(node.anyOf) && node.anyOf.some(isNullType)) return node;
  }
  return { anyOf: [node, { type: "null" }] };
}

/** Rewrites `anyOf [T, {type: "null"}]` (zod `.nullable()`) into the type-array form when T has a single type. */
function collapseNullableAnyOf(node: JsonSchema): JsonSchema {
  const keys = Object.keys(node);
  if (!Array.isArray(node.anyOf) || node.anyOf.length !== 2 || keys.some((k) => k !== "anyOf" && k !== "description")) return node;
  const [a, b] = node.anyOf as unknown[];
  const other = isNullType(a) ? b : isNullType(b) ? a : null;
  if (!isObj(other) || singleType(other) === null) return node;
  const out = nullable(other);
  if (typeof node.description === "string" && out.description === undefined) out.description = node.description;
  return out;
}

/** Asserts the strict-mode invariants; used by tests and as a runtime guard before sending a schema. */
export function strictViolations(schema: unknown, path = "#"): string[] {
  const issues: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => issues.push(...strictViolations(s, `${path}/${i}`)));
    return issues;
  }
  if (!isObj(schema)) return issues;
  if (schema.oneOf !== undefined) issues.push(`${path}: oneOf present`);
  if (schema.type === "object" || isObj(schema.properties)) {
    if (schema.additionalProperties !== false) issues.push(`${path}: additionalProperties must be false`);
    const props = isObj(schema.properties) ? Object.keys(schema.properties) : [];
    const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    for (const p of props) if (!req.has(p)) issues.push(`${path}: property ${p} not required`);
  }
  for (const [k, v] of Object.entries(schema)) issues.push(...strictViolations(v, `${path}/${k}`));
  return issues;
}

const pickBranch = (branches: unknown[], value: JsonSchema): JsonSchema | null => {
  const objBranches = branches.filter((b): b is JsonSchema => isObj(b) && isObj(b.properties));
  const keys = Object.keys(value);
  const fits = objBranches.filter((b) => keys.every((k) => k in (b.properties as JsonSchema)));
  if (fits.length === 1) return fits[0]!;
  // Discriminator: prefer the branch whose const properties match the value.
  const byConst = fits.filter((b) => Object.entries(b.properties as JsonSchema).every(([k, p]) => !isObj(p) || p.const === undefined || value[k] === p.const));
  return byConst[0] ?? fits[0] ?? null;
};

const acceptsString = (n: unknown): boolean => {
  if (!isObj(n)) return true; // unknown schema: be conservative and keep the value
  const t = n.type;
  if (t === "string" || (Array.isArray(t) && t.includes("string"))) return true;
  const branches = (Array.isArray(n.anyOf) ? n.anyOf : Array.isArray(n.oneOf) ? n.oneOf : null) as unknown[] | null;
  if (branches) return branches.some(acceptsString);
  return t === undefined && n.properties === undefined && n.enum === undefined && n.const === undefined;
};

/**
 * Removes `null` values for properties that the original (non-strict) schema marks optional.
 * Guided by the raw JSON Schema so required nullable fields keep their explicit null.
 */
export function restoreOptionals(raw: unknown, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = isObj(raw) ? raw.items : undefined;
    return value.map((v) => restoreOptionals(items, v));
  }
  if (!isObj(value) || !isObj(raw)) return value;
  const branches = (Array.isArray(raw.anyOf) ? raw.anyOf : Array.isArray(raw.oneOf) ? raw.oneOf : null) as unknown[] | null;
  if (branches && !isObj(raw.properties)) {
    const b = pickBranch(branches, value);
    return b ? restoreOptionals(b, value) : value;
  }
  if (!isObj(raw.properties)) return value;
  const required = new Set(Array.isArray(raw.required) ? (raw.required as string[]) : []);
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k) && k in raw.properties) continue;
    // Live quirk (2026-10-30): the string "null" was emitted for an omitted optional object. Treat it as absent
    // only when the property's schema cannot accept a string, so a real string value is never discarded.
    if (v === "null" && !required.has(k) && k in raw.properties && !acceptsString((raw.properties as JsonSchema)[k])) continue;
    out[k] = restoreOptionals((raw.properties as JsonSchema)[k], v);
  }
  return out;
}
