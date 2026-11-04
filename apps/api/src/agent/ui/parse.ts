import type { z } from "zod";
import type { EvaraDropped } from "@harvest/contracts";

/**
 * Evara Lang parser (docs/research/EVARA_ACTIONS_SPEC.md 2.2, docs/EVARA_LANG.md). Line oriented: one `name = Expression`
 * statement per line; blank lines, `# comments` (whole line or after a statement) and Markdown fence lines are skipped.
 * A line that does not parse is dropped with `parse-failed`; the rest of the program still parses. Semantics (refs,
 * components, ids, prose) are the resolver's job.
 */

export type Expr =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "null" }
  | { k: "list"; items: Expr[] }
  | { k: "ref"; name: string }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "action"; name: string; args: Expr[] };

export interface Statement {
  name: string;
  expr: Expr;
  /** 1-based line number in the program text. */
  line: number;
}

export type Dropped = z.infer<typeof EvaraDropped>;

export interface ParsedProgram {
  /** Every statement that parsed, in source order (same-name statements are all kept; the resolver lets the later win). */
  statements: Statement[];
  dropped: Dropped[];
}

export const MAX_STATEMENTS = 60;
/** StructuredAssistantOutput.ui maximum (packages/contracts/src/assistant.ts). */
export const MAX_PROGRAM_CHARS = 4000;

/**
 * Review fix E7c-3: a program longer than the contract's 4000 characters would make the whole structured output fail its
 * schema (a repair or an incomplete turn) although every answer block could pass the gate. The loop cuts it here, before the
 * strict validation: at the last newline before the limit (whole statements survive), or at the limit when the first line is
 * already longer. The cut is recorded as `parse-failed` / "program truncated" on the first line removed; the resolver carries
 * it into EvaraUi.dropped.
 */
export function capProgram(program: string, max = MAX_PROGRAM_CHARS): { program: string; dropped: Dropped | null } {
  if (program.length <= max) return { program, dropped: null };
  const head = program.slice(0, max);
  const nl = head.lastIndexOf("\n");
  const kept = nl > 0 ? head.slice(0, nl) : head;
  const line = kept.split("\n").length + (nl > 0 ? 1 : 0);
  return { program: kept, dropped: { line, code: "parse-failed", detail: "program truncated" } };
}
const MAX_DEPTH = 8;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["true", "false", "null"]);

type Tok = { t: "ident"; v: string } | { t: "str"; v: string } | { t: "num"; v: number } | { t: "punct"; v: "(" | ")" | "[" | "]" | "," | "=" | "@" };

class ParseError extends Error {}

function tokenize(line: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#") break; // trailing comment (strings cannot hold '#': 2.3)
    if (c === '"') {
      let j = i + 1;
      let s = "";
      for (;;) {
        if (j >= line.length) throw new ParseError("unterminated string");
        const d = line[j]!;
        if (d === "\\" && j + 1 < line.length) {
          s += line[j + 1]!;
          j += 2;
          continue;
        }
        if (d === '"') break;
        s += d;
        j++;
      }
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(line.slice(i));
    if (num && (c !== "-" || /\d/.test(line[i + 1] ?? ""))) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
    if (id) {
      out.push({ t: "ident", v: id[0] });
      i += id[0].length;
      continue;
    }
    if ("()[],=@".includes(c)) {
      out.push({ t: "punct", v: c as "(" });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(c)}`);
  }
  return out;
}

class Cursor {
  i = 0;
  constructor(private readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  next(): Tok {
    const t = this.toks[this.i++];
    if (!t) throw new ParseError("unexpected end of line");
    return t;
  }
  isPunct(v: string): boolean {
    const t = this.peek();
    return t?.t === "punct" && t.v === v;
  }
  expect(v: string): void {
    const t = this.next();
    if (t.t !== "punct" || t.v !== v) throw new ParseError(`expected ${v}`);
  }
  done(): boolean {
    return this.i >= this.toks.length;
  }
}

function parseArgs(c: Cursor, close: ")" | "]", depth: number): Expr[] {
  const args: Expr[] = [];
  if (c.isPunct(close)) {
    c.next();
    return args;
  }
  for (;;) {
    args.push(parseExpr(c, depth + 1));
    if (c.isPunct(",")) {
      c.next();
      if (c.isPunct(close)) {
        c.next(); // a trailing comma is tolerated
        return args;
      }
      continue;
    }
    c.expect(close);
    return args;
  }
}

function parseExpr(c: Cursor, depth: number): Expr {
  if (depth > MAX_DEPTH) throw new ParseError("expression nested too deeply");
  const t = c.next();
  if (t.t === "str") return { k: "str", v: t.v };
  if (t.t === "num") return { k: "num", v: t.v };
  if (t.t === "punct" && t.v === "[") return { k: "list", items: parseArgs(c, "]", depth) };
  if (t.t === "punct" && t.v === "@") {
    const n = c.next();
    if (n.t !== "ident") throw new ParseError("expected an action name after @");
    c.expect("(");
    return { k: "action", name: n.v, args: parseArgs(c, ")", depth) };
  }
  if (t.t === "ident") {
    if (t.v === "true" || t.v === "false") return { k: "bool", v: t.v === "true" };
    if (t.v === "null") return { k: "null" };
    if (c.isPunct("(")) {
      c.next();
      return { k: "call", name: t.v, args: parseArgs(c, ")", depth) };
    }
    return { k: "ref", name: t.v };
  }
  const rest = t as Tok;
  throw new ParseError(`unexpected ${rest.t === "punct" ? rest.v : rest.t}`);
}

/** Parses one statement line; throws ParseError. */
export function parseLine(text: string): { name: string; expr: Expr } {
  const c = new Cursor(tokenize(text));
  const n = c.next();
  if (n.t !== "ident" || !NAME.test(n.v) || RESERVED.has(n.v)) throw new ParseError("a statement starts with a name");
  c.expect("=");
  const expr = parseExpr(c, 0);
  if (!c.done()) throw new ParseError("unexpected text after the expression");
  return { name: n.v, expr };
}

export function parseEvaraLang(program: string | null | undefined): ParsedProgram {
  const statements: Statement[] = [];
  const dropped: Dropped[] = [];
  if (!program) return { statements, dropped };
  const lines = program.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "" || raw.startsWith("#") || raw.startsWith("```")) continue;
    if (statements.length >= MAX_STATEMENTS) {
      dropped.push({ line: i + 1, code: "parse-failed", detail: `more than ${MAX_STATEMENTS} statements` });
      break;
    }
    try {
      const s = parseLine(raw);
      statements.push({ ...s, line: i + 1 });
    } catch (e) {
      dropped.push({ line: i + 1, code: "parse-failed", detail: e instanceof ParseError ? e.message.slice(0, 200) : "the line could not be read" });
    }
  }
  return { statements, dropped };
}
