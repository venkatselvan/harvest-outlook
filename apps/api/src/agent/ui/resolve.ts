import { EvaraUi, type EvaraAction, type EvaraNode, type EvaraOpenTarget, type EvaraPromptKey } from "@harvest/contracts";
import { ACTION_BY_NAME, COMPONENT_BY_NAME, STRING_FORM, type ActionDecl, type ComponentDecl, type ParamDecl } from "./library";
import { parseEvaraLang, type Dropped, type Expr, type Statement } from "./parse";
import {
  addSeasonAction,
  askAction,
  buildActions,
  buildCallout,
  buildChoice,
  buildCropCompare,
  buildFarmSnapshot,
  buildGrowthJourney,
  buildPlanOptions,
  buildText,
  compareAction,
  openAction,
  pickCropAction,
  replaceSeasonAction,
  showJourneyAction,
  usePlanAction,
  type Built,
  type DropCode,
} from "./build";
import { appendNodes, composeFallback, dataComponentsFor, minimalUi, prependNodes } from "./compose";
import type { EvaraResolveData } from "./types";

/**
 * Evara Lang resolver (docs/research/EVARA_ACTIONS_SPEC.md 2.2 to 2.5, docs/EVARA_LANG.md). PURE: no pool, no clock, no
 * network; everything it reads is in `data`. It turns the model's program into an EvaraUi tree:
 *
 *  - statements: the later of two same-named statements wins; forward references are allowed; the entry is `root`, else the
 *    first `Stack(...)` statement (recorded as `no-root`);
 *  - a statement that breaks a rule is dropped with its code and removes itself from the lists that reference it;
 *  - string literals must match STRING_FORM (2.3) or the statement is `prose-not-allowed`;
 *  - every id is checked against the run's data (build.ts);
 *  - after resolution, approved answer blocks the program left out are added as Text nodes (prepended when the program
 *    shows no block at all, else appended), so the tree never hides a gated sentence such as a warning or a limitation;
 *  - a crop, plan or journey intent whose tree has no matching data component gets the composer's component appended
 *    (origin 'fallback'); an empty program, or a root that does not survive, gets the composer's whole tree;
 *  - the final tree is checked against the EvaraUi contract; a failure falls back to the composer (then to a minimal tree).
 */

type Val = { t: "node"; node: EvaraNode } | { t: "action"; action: EvaraAction } | { t: "list"; items: Val[] } | { t: "lit"; v: string | number | boolean | null } | { t: "dropped" };
const DROPPED: Val = { t: "dropped" };
const INVALID = Symbol("invalid");

export interface ResolveOptions {
  /** Defaults to data.intent. */
  intent?: string | null;
  /** Entries recorded before resolution (the loop's program truncation, review fix E7c-3); listed first in EvaraUi.dropped. */
  dropped?: Dropped[];
}

class Resolver {
  readonly dropped: Dropped[] = [];
  private readonly table = new Map<string, Statement>();
  private readonly memo = new Map<string, Val>();
  private readonly active = new Set<string>();

  constructor(
    readonly statements: Statement[],
    private readonly data: EvaraResolveData,
  ) {
    for (const s of statements) this.table.set(s.name, s);
  }

  drop(line: number, code: DropCode, detail: string | null): Val {
    this.dropped.push({ line, code, detail: detail ? detail.slice(0, 200) : null });
    return DROPPED;
  }

  /** `root`, else the first Stack statement that is its name's final definition (recorded as no-root). */
  rootName(): string | null {
    if (this.table.has("root")) return "root";
    const first = this.statements.find((s) => this.table.get(s.name) === s && s.expr.k === "call" && s.expr.name === "Stack");
    if (!first) return null;
    this.dropped.push({ line: first.line, code: "no-root", detail: `no root statement; used ${first.name}` });
    return first.name;
  }

  ref(name: string, line: number): Val {
    const st = this.table.get(name);
    if (!st) return this.drop(line, "unknown-ref", `unknown name ${name}`);
    if (this.active.has(name)) return this.drop(line, "cycle", `${name} refers back to itself`);
    const hit = this.memo.get(name);
    if (hit) return hit;
    this.active.add(name);
    const v = this.statement(st);
    this.active.delete(name);
    this.memo.set(name, v);
    return v;
  }

  private statement(st: Statement): Val {
    const prose = firstProse(st.expr);
    if (prose !== null) return this.drop(st.line, "prose-not-allowed", `string ${JSON.stringify(prose.slice(0, 40))} is not an id, date or enum word`);
    return this.expr(st.expr, st.line);
  }

  private expr(e: Expr, line: number): Val {
    switch (e.k) {
      case "str":
      case "num":
      case "bool":
        return { t: "lit", v: e.v };
      case "null":
        return { t: "lit", v: null };
      case "list":
        return { t: "list", items: e.items.map((x) => this.expr(x, line)) };
      case "ref":
        return this.ref(e.name, line);
      case "call": {
        const decl = COMPONENT_BY_NAME.get(e.name);
        if (!decl) return this.drop(line, "unknown-component", `${e.name} is not a library component`);
        return this.component(decl, e.args, line);
      }
      case "action": {
        const decl = ACTION_BY_NAME.get(e.name);
        if (!decl) return this.drop(line, "unknown-action", `@${e.name} is not an allowed action`);
        return this.action(decl, e.args, line);
      }
    }
  }

  /** Positional binding (2.2): excess-args, missing-required, type-mismatch; lists cut to their max (recorded excess-args). */
  private bind(name: string, params: ParamDecl[], args: Expr[], line: number): unknown[] | null {
    if (args.length > params.length) {
      this.drop(line, "excess-args", `${name} takes ${params.length} argument${params.length === 1 ? "" : "s"}, got ${args.length}`);
      return null;
    }
    const out: unknown[] = [];
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const a = args[i];
      if (a === undefined || a.k === "null") {
        if (!p.optional) {
          this.drop(line, "missing-required", `${name}: ${p.name} is required`);
          return null;
        }
        out.push(null);
        continue;
      }
      const v = this.expr(a, line);
      if (p.kind === "value") {
        let plain = toPlain(v);
        if (plain === undefined) {
          // a dropped ref: the argument is absent
          if (!p.optional) {
            this.drop(line, "missing-required", `${name}: ${p.name} did not resolve`);
            return null;
          }
          out.push(null);
          continue;
        }
        if (plain === INVALID) {
          this.drop(line, "type-mismatch", `${name}: ${p.name} must be ${p.type}`);
          return null;
        }
        if (Array.isArray(plain) && p.max !== undefined && plain.length > p.max) {
          this.dropped.push({ line, code: "excess-args", detail: `${name}: ${p.name} cut to ${p.max} items` });
          plain = plain.slice(0, p.max);
        }
        const ok = p.schema.safeParse(plain);
        if (!ok.success || (Array.isArray(plain) && p.min !== undefined && plain.length < p.min)) {
          this.drop(line, "type-mismatch", `${name}: ${p.name} must be ${p.type}`);
          return null;
        }
        out.push(ok.data);
        continue;
      }
      const want = p.kind === "nodes" ? "node" : "action";
      const items = v.t === "list" ? v.items : [v];
      const kept: (EvaraNode | EvaraAction)[] = [];
      for (const it of items) {
        if (it.t === "dropped") continue; // already recorded where it was dropped
        if (it.t === want) kept.push(it.t === "node" ? it.node : (it as { action: EvaraAction }).action);
        else this.dropped.push({ line, code: "type-mismatch", detail: `${name}: ${p.name} items must be ${want === "node" ? "components" : "actions"}` });
      }
      if (p.max !== undefined && kept.length > p.max) {
        this.dropped.push({ line, code: "excess-args", detail: `${name}: ${p.name} cut to ${p.max} items` });
        kept.length = p.max;
      }
      out.push(kept);
    }
    return out;
  }

  private built(b: Built<EvaraNode>, line: number): Val {
    if (!b.ok) return this.drop(line, b.code, b.detail);
    for (const n of b.notes ?? []) this.dropped.push({ line, code: n.code, detail: n.detail.slice(0, 200) });
    return { t: "node", node: b.value };
  }

  private component(decl: ComponentDecl, args: Expr[], line: number): Val {
    const a = this.bind(decl.name, decl.params, args, line);
    if (!a) return DROPPED;
    const d = this.data;
    switch (decl.name) {
      case "Stack": {
        const children = a[0] as EvaraNode[];
        if (!children.length) return this.drop(line, "empty-after-resolve", "Stack: no child survived");
        return { t: "node", node: { type: "stack", children } };
      }
      case "Text":
        return this.built(buildText(d, a[0] as string), line);
      case "Callout":
        return this.built(buildCallout(d, a[0] as "warning" | "info" | "good", a[1] as string), line);
      case "FarmSnapshot":
        return this.built(buildFarmSnapshot(d), line);
      case "CropCompare":
        return this.built(buildCropCompare(d, a[0] as string[]), line);
      case "PlanOptions":
        return this.built(buildPlanOptions(d, a[0] as "plan" | "alternatives" | "saved" | null), line);
      case "GrowthJourney":
        return this.built(buildGrowthJourney(d, a[0] as string, a[1] as string | null), line);
      case "Choice":
        return this.built(buildChoice(d, a[0] as string, a[1] as EvaraAction[]), line);
      case "Actions":
        return this.built(buildActions(a[0] as EvaraAction[]), line);
    }
  }

  private action(decl: ActionDecl, args: Expr[], line: number): Val {
    const a = this.bind(`@${decl.name}`, decl.params, args, line);
    if (!a) return DROPPED;
    const d = this.data;
    let b: Built<EvaraAction>;
    switch (decl.name) {
      case "PickCrop":
        b = pickCropAction(d, a[0] as string);
        break;
      case "ShowJourney":
        b = showJourneyAction(d, a[0] as string);
        break;
      case "Compare":
        b = compareAction(d, a[0] as string[]);
        break;
      case "UsePlan":
        b = usePlanAction(d, a[0] as "plan" | "alternatives", a[1] as string);
        break;
      case "ReplaceSeason":
        b = replaceSeasonAction(d, a[0] as string, a[1] as string);
        break;
      case "AddSeason":
        b = addSeasonAction(d, a[0] as string, a[1] as string | null);
        break;
      case "Open":
        b = openAction(d, a[0] as EvaraOpenTarget);
        break;
      case "Ask":
        b = askAction(d, a[0] as EvaraPromptKey);
        break;
    }
    if (!b.ok) return this.drop(line, b.code, b.detail);
    for (const n of b.notes ?? []) this.dropped.push({ line, code: n.code, detail: n.detail.slice(0, 200) });
    return { t: "action", action: b.value };
  }
}

/** The first string literal that is not an id, date or enum word (2.3), or null. */
function firstProse(e: Expr): string | null {
  if (e.k === "str") return STRING_FORM.test(e.v) ? null : e.v;
  const kids = e.k === "list" ? e.items : e.k === "call" || e.k === "action" ? e.args : [];
  for (const k of kids) {
    const p = firstProse(k);
    if (p !== null) return p;
  }
  return null;
}

/** Literal or list of literals; undefined for a dropped value; INVALID for a node or an action. */
function toPlain(v: Val): unknown {
  if (v.t === "lit") return v.v;
  if (v.t === "dropped") return undefined;
  if (v.t === "list") {
    const out: unknown[] = [];
    for (const it of v.items) {
      const p = toPlain(it);
      if (p === INVALID) return INVALID;
      if (p !== undefined) out.push(p);
    }
    return out;
  }
  return INVALID;
}

function walk(n: EvaraNode, f: (n: EvaraNode) => void): void {
  f(n);
  if (n.type === "stack") for (const c of n.children) walk(c, f);
}

/** Block ids a tree shows (text, callout, choice). */
export function shownBlockIds(root: EvaraNode): Set<string> {
  const ids = new Set<string>();
  walk(root, (n) => {
    if (n.type === "text") ids.add(n.blockId);
    else if (n.type === "callout" && n.blockId) ids.add(n.blockId);
    else if (n.type === "choice") ids.add(n.blockId);
  });
  return ids;
}

export function nodeTypes(root: EvaraNode): Set<EvaraNode["type"]> {
  const t = new Set<EvaraNode["type"]>();
  walk(root, (n) => t.add(n.type));
  return t;
}

const capDropped = (d: Dropped[]) => d.slice(0, 20);

export function resolveEvaraUi(program: string | null | undefined, data: EvaraResolveData, opts: ResolveOptions = {}): EvaraUi {
  const intent = opts.intent !== undefined ? opts.intent : data.intent;
  const d: EvaraResolveData = { ...data, intent };
  const parsed = parseEvaraLang(program);
  const r = new Resolver(parsed.statements, d);
  const dropped: Dropped[] = [...(opts.dropped ?? []), ...parsed.dropped];
  let root: EvaraNode | null = null;
  const name = r.rootName();
  if (name) {
    const line = parsed.statements.find((s) => s.name === name)?.line ?? 0;
    const v = r.ref(name, line);
    if (v.t === "node") root = v.node;
    else if (v.t === "list") {
      const kids = v.items.flatMap((x) => (x.t === "node" ? [x.node] : []));
      if (kids.length) root = { type: "stack", children: kids.slice(0, 12) };
    } else if (v.t !== "dropped") r.drop(line, "type-mismatch", `${name} must be a component`);
  }
  dropped.push(...r.dropped);

  let ui: EvaraUi;
  if (root) {
    const shown = shownBlockIds(root);
    const missing: EvaraNode[] = d.blocks.filter((b) => !shown.has(b.id)).map((b) => ({ type: "text", blockId: b.id, kind: b.kind, text: b.text }));
    if (missing.length) root = shown.size === 0 ? prependNodes(root, missing) : appendNodes(root, missing);
    const extra = dataComponentsFor(d, nodeTypes(root), dropped);
    if (extra.length) root = appendNodes(root, extra);
    ui = { version: "1", origin: extra.length ? "fallback" : "model", root, dropped: capDropped(dropped) };
  } else ui = composeFallback(d, dropped);

  const checked = EvaraUi.safeParse(ui);
  if (checked.success) return checked.data;
  const fb = composeFallback(d, [...dropped, { line: 0, code: "type-mismatch", detail: "the resolved tree did not fit the EvaraUi contract" }]);
  const fbChecked = EvaraUi.safeParse(fb);
  return fbChecked.success ? fbChecked.data : minimalUi(d, dropped);
}
