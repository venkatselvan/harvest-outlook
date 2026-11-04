import { For, Match, Show, Switch, createSignal, createUniqueId } from "solid-js";
import type { EvaraAction, EvaraCell, EvaraCompareColumn, EvaraNode, EvaraUi } from "@harvest/contracts";
import type { AskLanguage } from "../../features/ask/model";
import { Chip } from "../ui/Chip";
import { runEvaraAction, type EvaraContext } from "./actions";
import { GrowthJourney, type JourneyNode } from "./GrowthJourney";
import { kitLabels, labelDate } from "./labels";
import "./evara-ui.css";

/**
 * Renders an `EvaraUi` tree (docs/research/EVARA_ACTIONS_SPEC.md 2.8) node by node. The tree is already resolved and
 * validated by the server: sentences come from gated answer blocks, every other string was written by code, and each
 * action is one the executor in `actions.ts` knows. Reading order is tree order; every control is a real button of at
 * least 44 px; colour never carries meaning alone (tones add a word for screen readers).
 */

type NodeOf<T extends EvaraNode["type"]> = Extract<EvaraNode, { type: T }>;
const as = <T extends EvaraNode["type"]>(node: EvaraNode, type: T): NodeOf<T> | undefined => (node.type === type ? (node as NodeOf<T>) : undefined);

/** Every node of the tree, depth first, in reading order. */
export function walkNodes(node: EvaraNode, visit: (node: EvaraNode) => void): void {
  visit(node);
  if (node.type === "stack") for (const child of node.children) walkNodes(child, visit);
}

/** True when the tree shows at least one sentence (text, callout or choice prompt); the panel adds the plain answer text when it does not. */
export function hasProse(ui: EvaraUi): boolean {
  let found = false;
  walkNodes(ui.root, (n) => {
    if (n.type === "text" || n.type === "callout" || n.type === "choice") found = true;
  });
  return found;
}

/** The context with some members replaced, keeping the panel's live getters (a spread would freeze them). */
export function withOverrides(ctx: EvaraContext, overrides: Partial<EvaraContext>): EvaraContext {
  return Object.create(ctx, Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, { value, enumerable: true }]))) as EvaraContext;
}

export interface Env {
  ctx: EvaraContext;
  inserted: () => JourneyNode[];
  anchorFor: (cropId: string) => string;
}

export function EvaraUiView(props: { ui: EvaraUi; ctx: EvaraContext; language?: AskLanguage | undefined }) {
  const scope = createUniqueId();
  const [inserted, setInserted] = createSignal<JourneyNode[]>([]);
  const anchorFor = (cropId: string) => `ev-journey-${scope}-${cropId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  const focusAnchor = (cropId: string) => {
    const el = document.getElementById(anchorFor(cropId));
    if (!el) return false;
    el.scrollIntoView?.({ block: "nearest" });
    el.focus();
    return true;
  };
  /** show_journey: expand the tree's own journey for the crop (focus it), else insert one below the message. */
  const showJourney: EvaraContext["showJourney"] = (action) => {
    if (focusAnchor(action.cropId)) return;
    const node: JourneyNode = {
      type: "growth_journey",
      cropId: action.cropId,
      cropName: action.cropName,
      productId: null,
      fieldId: props.ctx.fieldId,
      sowingDate: action.sowingDate ?? props.ctx.today(),
      stages: [],
      journeyId: null,
      note: null,
    };
    setInserted((list) => [...list, node]);
    queueMicrotask(() => focusAnchor(action.cropId));
  };
  const ctx = withOverrides(props.ctx, { ...(props.language ? { language: props.language } : {}), showJourney });
  const env: Env = { ctx, inserted, anchorFor };
  return (
    <div class="ev-ui">
      <NodeView node={props.ui.root} env={env} />
      <For each={inserted()}>
        {(node) => (
          <div class="ev-journey-anchor" id={env.anchorFor(node.cropId)} tabindex="-1">
            <GrowthJourney node={node} ctx={ctx} />
          </div>
        )}
      </For>
    </div>
  );
}

/** A strip of actions outside a tree (the panel's own messages, such as "Open plan" after a save). */
export function EvaraActions(props: { actions: readonly EvaraAction[]; ctx: EvaraContext }) {
  const env: Env = { ctx: props.ctx, inserted: () => [], anchorFor: (cropId) => cropId };
  return <ActionStrip actions={props.actions} env={env} />;
}

export function NodeView(props: { node: EvaraNode; env: Env }) {
  return (
    <Switch>
      <Match when={as(props.node, "stack")}>
        {(n) => (
          <div class="ev-stack">
            <For each={n().children}>{(child) => <NodeView node={child} env={props.env} />}</For>
          </div>
        )}
      </Match>
      <Match when={as(props.node, "text")}>{(n) => <TextNode node={n()} env={props.env} />}</Match>
      <Match when={as(props.node, "callout")}>{(n) => <CalloutNode node={n()} env={props.env} />}</Match>
      <Match when={as(props.node, "farm_snapshot")}>{(n) => <SnapshotNode node={n()} env={props.env} />}</Match>
      <Match when={as(props.node, "crop_compare")}>{(n) => <CompareNode node={n()} env={props.env} />}</Match>
      <Match when={as(props.node, "plan_options")}>{(n) => <PlanOptionsNode node={n()} env={props.env} />}</Match>
      <Match when={as(props.node, "growth_journey")}>
        {(n) => (
          <div class="ev-journey-anchor" id={props.env.anchorFor(n().cropId)} tabindex="-1">
            <GrowthJourney node={n()} ctx={props.env.ctx} />
          </div>
        )}
      </Match>
      <Match when={as(props.node, "actions")}>{(n) => <ActionStrip actions={n().items} env={props.env} />}</Match>
      <Match when={as(props.node, "choice")}>{(n) => <ChoiceNode node={n()} env={props.env} />}</Match>
    </Switch>
  );
}

const PRIMARY: ReadonlySet<EvaraAction["kind"]> = new Set(["pick_crop", "add_season", "replace_season", "use_plan"]);

export function ActionButton(props: { action: EvaraAction; env: Env }) {
  return (
    <button type="button" class="ev-btn" classList={{ primary: PRIMARY.has(props.action.kind) }} data-action={props.action.kind} onClick={() => runEvaraAction(props.action, props.env.ctx)}>
      {props.action.label}
    </button>
  );
}

function ActionStrip(props: { actions: readonly EvaraAction[]; env: Env; label?: string }) {
  return (
    <div class="ev-actions" role={props.label ? "group" : undefined} aria-label={props.label}>
      <For each={props.actions}>{(action) => <ActionButton action={action} env={props.env} />}</For>
    </div>
  );
}

function TextNode(props: { node: NodeOf<"text">; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language);
  return (
    <p class={`ev-text kind-${props.node.kind}`} data-block={props.node.blockId}>
      <Show when={props.node.kind === "warning"}>
        <span class="ev-sr">{t().warningLabel}: </span>
      </Show>
      {props.node.text}
    </p>
  );
}

function CalloutNode(props: { node: NodeOf<"callout">; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language);
  return (
    <div class={`ev-callout tone-${props.node.tone}`} role="note">
      <Show when={props.node.tone === "warning"}>
        <span class="ev-sr">{t().warningLabel}: </span>
      </Show>
      <p>{props.node.text}</p>
    </div>
  );
}

function SnapshotNode(props: { node: NodeOf<"farm_snapshot">; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language).snapshot;
  const rows = () => {
    const n = props.node;
    const label = t();
    const next = n.nextAction ? (n.nextActionWindow ? `${n.nextAction} · ${n.nextActionWindow}` : n.nextAction) : null;
    return [
      [label.field, n.fieldName],
      [label.crop, n.crop],
      [label.stage, n.stage],
      [label.day, n.dayOfSeason],
      [label.rain, n.rainNext7Days],
      [label.next, next],
      [label.alerts, String(n.openAlerts)],
    ].filter((row): row is [string, string] => row[1] !== null);
  };
  return (
    <dl class="ev-snapshot">
      <For each={rows()}>
        {([term, value]) => (
          <div>
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        )}
      </For>
    </dl>
  );
}

const TONE_MARK: Record<NonNullable<EvaraCell["tone"]>, string> = { good: "✓", watch: "!", short: "−", neutral: "" };

function CellView(props: { cell: EvaraCell | undefined; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language).tones;
  const tone = () => (props.cell?.tone && props.cell.tone !== "neutral" ? props.cell.tone : null);
  return (
    <Show when={props.cell} fallback={<span class="ev-cell-empty">—</span>}>
      {(cell) => (
        <>
          <span class="ev-cell-text" data-tone={cell().tone ?? "neutral"}>
            <Show when={tone()}>
              {(name) => (
                <>
                  <i class="ev-tone-mark" aria-hidden="true">{TONE_MARK[name()]}</i>
                  <span class="ev-sr">{t()[name()]}: </span>
                </>
              )}
            </Show>
            {cell().text}
          </span>
          <Show when={cell().note}>
            <small class="ev-cell-note">{cell().note}</small>
          </Show>
        </>
      )}
    </Show>
  );
}

function CompareNode(props: { node: NodeOf<"crop_compare">; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language);
  const columns = (): EvaraCompareColumn[] => props.node.columns;
  return (
    <div class="ev-compare">
      {/* A scroll region the keyboard can reach: the table is wider than a phone. */}
      <div class="ev-table-wrap" role="region" aria-label={t().compareCaption} tabindex="0">
        <table class="ev-table">
          <caption class="ev-sr">{t().compareCaption}</caption>
          <thead>
            <tr>
              <th scope="col" class="ev-sticky">
                {t().crop}
              </th>
              <For each={columns()}>{(column) => <th scope="col">{t().columns[column]}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={props.node.rows}>
              {(row) => (
                <>
                  <tr class="ev-row">
                    <th scope="row" class="ev-sticky">
                      <span class="ev-crop-name">{row.cropName}</span>
                      <Show when={row.productName}>
                        <small>{row.productName}</small>
                      </Show>
                    </th>
                    <For each={columns()}>
                      {(column) => (
                        <td>
                          <CellView cell={row.cells[column]} env={props.env} />
                        </td>
                      )}
                    </For>
                  </tr>
                  <Show when={row.actions.length}>
                    <tr class="ev-row-actions">
                      <td colspan={columns().length + 1}>
                        <div class="ev-row-strip">
                          <ActionStrip actions={row.actions} env={props.env} label={`${t().rowActions} ${row.cropName}`} />
                        </div>
                      </td>
                    </tr>
                  </Show>
                </>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <Show when={props.node.note}>
        <p class="ev-muted">{props.node.note}</p>
      </Show>
      <p class="ev-muted ev-scroll-hint">{t().compareHint}</p>
    </div>
  );
}

/** "harvest 20 Sep 2027 – 15 Oct 2027", or "harvest not known" when the slot has no sourced harvest window (never a date made up). */
export function slotHarvestText(harvest: { earliest: string; latest: string } | null, label: string, unknown: string, date: (iso: string) => string): string {
  return harvest ? `${label} ${date(harvest.earliest)} – ${date(harvest.latest)}` : `${label} ${unknown}`;
}

function PlanOptionsNode(props: { node: NodeOf<"plan_options">; env: Env }) {
  const t = () => kitLabels(props.env.ctx.language);
  const lang = () => props.env.ctx.language;
  const date = (iso: string) => labelDate(iso, lang());
  return (
    <section class="ev-plan" aria-label={t().planTitles[props.node.source]}>
      <h4>{t().planTitles[props.node.source]}</h4>
      <Show when={props.node.note}>
        <p class="ev-muted">{props.node.note}</p>
      </Show>
      <ul class="ev-plan-list">
        <For each={props.node.options}>
          {(option) => (
            <li class="ev-plan-card">
              <strong class="ev-plan-label">{option.label}</strong>
              <Show when={option.chips.length}>
                <div class="ev-chips">
                  <For each={option.chips}>{(chip) => <Chip>{chip}</Chip>}</For>
                </div>
              </Show>
              <ol class="ev-slots">
                <For each={option.slots}>
                  {(slot) => (
                    <li>
                      <span class="ev-slot-crop">
                        {slot.cropName}
                        <Show when={slot.productName}> · {slot.productName}</Show>
                        <Show when={slot.kind !== "crop"}>
                          <Chip tone="legume">{slot.kind.replace(/_/g, " ")}</Chip>
                        </Show>
                      </span>
                      <span>
                        {t().slotSow} {date(slot.sowing)} · {slotHarvestText(slot.harvest, t().slotHarvest, t().slotHarvestUnknown, date)}
                      </span>
                      <Show when={slot.profitForField}>
                        <span>
                          {t().slotProfit}: {slot.profitForField}
                        </span>
                      </Show>
                      <Show when={slot.replaces}>
                        <span class="ev-slot-replaces">
                          {t().slotReplaces}: {slot.replaces}
                        </span>
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={option.actions.length}>
                <ActionStrip actions={option.actions} env={props.env} label={option.label} />
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

function ChoiceNode(props: { node: NodeOf<"choice">; env: Env }) {
  const promptId = createUniqueId();
  return (
    <div class="ev-choice" role="group" aria-labelledby={promptId}>
      <p class="ev-text" id={promptId}>
        {props.node.prompt}
      </p>
      <ActionStrip actions={props.node.options} env={props.env} />
    </div>
  );
}
