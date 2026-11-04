import { For, Match, Show, Switch, createMemo, createResource, createSignal } from "solid-js";
import type { SeasonPreview } from "@harvest/contracts";
import { Sheet } from "../ui/Sheet";
import { Chip } from "../ui/Chip";
import { newEntryId } from "../../features/photo-region/http";
import { describeSeasonPreviewError, loadSeasonPreview, withPreviewField } from "../season/seasonPreviewApi";
import type { EvaraContext, PlanCropRequest } from "./actions";
import { kitLabels, labelDate } from "./labels";
import { loadStageTimeline } from "../year/seasonStripApi";
import { addPlannedSeason, planCropModel, replacePlannedSeason, type PlanCropOutcome } from "./planCrop";
import { growingCycles, releaseOfTimeline, type Releases } from "./seasons";
import "./evara-ui.css";

/**
 * Plan-this-crop sheet (docs/research/EVARA_ACTIONS_SPEC.md 2.8): the season preview of the crop at the candidate sowing date
 * (stages, harvest window), then the one change the farmer can confirm: "Add as planned season", or "Replace <crop> (planned
 * <date>)" when a replaceable saved season of the viewed field overlaps the crop's occupancy. The exact change is written out
 * before the button; nothing is written on open. Errors (a 409 version conflict, a refusal) stay inline with a retry.
 */
export function PlanCropSheet(props: { ctx: EvaraContext; request: PlanCropRequest; onClose: () => void }) {
  const t = () => kitLabels(props.ctx.language).sheet;
  const sowing = () => props.request.sowingDate ?? props.ctx.today();
  const [preview, { refetch }] = createResource(
    () => ({ farmId: props.ctx.farmId, cropId: props.request.cropId, productId: props.request.productId, sowing: sowing(), fieldId: props.ctx.fieldId }),
    async (key) => {
      if (!key.farmId) throw new Error(t().noFarm);
      return loadSeasonPreview(
        key.farmId,
        withPreviewField({ cropId: key.cropId, ...(key.productId ? { productId: key.productId } : {}), sowing: key.sowing }, key.fieldId),
        props.ctx.fetchImpl,
      );
    },
  );
  // The release dates of the crops standing in the field: their stage timelines (a code route, no provider call). A failed read leaves the date unknown, and an unknown date refuses the add.
  const [releases] = createResource(
    () => ({ farmId: props.ctx.farmId, ids: growingCycles({ cycles: props.ctx.cycles() ?? [], fieldId: props.ctx.fieldId, cropName: props.ctx.cropName }).map((g) => g.cycle.id) }),
    async (key): Promise<Releases> => {
      if (!key.farmId || !key.ids.length) return {};
      const found = await Promise.all(key.ids.map(async (id) => [id, releaseOfTimeline(await loadStageTimeline(key.farmId!, id, undefined, props.ctx.fetchImpl))] as const));
      return Object.fromEntries(found);
    },
  );
  return (
    <Sheet
      title={t().title(props.request.cropName)}
      subtitle={props.request.mode === "replace" ? t().subtitleReplace : t().subtitleAdd}
      closeLabel={`${t().close} ${t().title(props.request.cropName)}`}
      class="ev-plan-sheet"
      onClose={props.onClose}
    >
      <Switch>
        <Match when={preview.error}>
          <div class="ev-sheet-error" role="alert">
            <p>{preview.error instanceof Error && preview.error.message === t().noFarm ? t().noFarm : describeSeasonPreviewError(preview.error)}</p>
            <button type="button" class="ev-btn" onClick={() => void refetch()}>
              {t().retry}
            </button>
          </div>
        </Match>
        <Match when={preview.state === "ready" && releases.state === "ready" && preview()}>
          {(p) => <PlanCropBody ctx={props.ctx} request={props.request} preview={p()} releases={releases() ?? {}} onClose={props.onClose} />}
        </Match>
        <Match when={true}>
          <p class="ev-sheet-loading" aria-busy="true" role="status">
            {t().loading}
          </p>
        </Match>
      </Switch>
    </Sheet>
  );
}

/** The sheet's content once the preview is in. Exported for tests (rendered without the portal). */
export function PlanCropBody(props: { ctx: EvaraContext; request: PlanCropRequest; preview: SeasonPreview; releases?: Releases; onClose: () => void; onDone?: (outcome: PlanCropOutcome) => void }) {
  const lang = () => props.ctx.language;
  const t = () => kitLabels(lang()).sheet;
  const date = (iso: string) => labelDate(iso, lang());
  const model = createMemo(() => planCropModel({ request: props.request, preview: props.preview, ctx: props.ctx, releases: props.releases }));
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<{ message: string; conflict: boolean } | null>(null);
  // Stable across retries: a save whose answer was lost must not add the season twice.
  const newId = newEntryId("rotation");
  const fieldLabel = () => props.ctx.fields().find((f) => f.id === props.ctx.fieldId)?.name ?? t().wholeFarm;
  const harvestText = () => (props.preview.harvest ? `${date(props.preview.harvest.earliest)} – ${date(props.preview.harvest.latest)}` : t().harvestUnknown);
  const stages = () => props.preview.timeline?.stages ?? [];

  async function confirm(run: () => Promise<PlanCropOutcome>) {
    if (busy()) return;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await run();
      if (outcome.kind === "saved") {
        props.onDone?.(outcome);
        props.onClose();
      } else {
        setProblem({ message: outcome.message, conflict: outcome.kind === "failed" && outcome.conflict });
      }
    } catch (error) {
      setProblem({ message: (error as Error)?.message || t().saveFailed, conflict: false });
    } finally {
      setBusy(false);
    }
  }
  const add = () => confirm(() => addPlannedSeason({ ctx: props.ctx, request: props.request, preview: props.preview, id: newId, releases: props.releases }));
  const replace = (rotationPlanId: string) => confirm(() => replacePlannedSeason({ ctx: props.ctx, request: props.request, preview: props.preview, rotationPlanId, releases: props.releases }));
  async function reload() {
    setBusy(true);
    try {
      await props.ctx.refreshWorkspace();
      setProblem(null);
    } catch {
      setProblem({ message: t().conflict, conflict: true });
    } finally {
      setBusy(false);
    }
  }
  const noneChoice = () => {
    const c = model().choice;
    return c.kind === "none" ? c : null;
  };
  const replaceChoice = () => {
    const c = model().choice;
    return c.kind === "replace" ? c : null;
  };
  const harvestBy = () => (props.preview.harvest ? date(props.preview.harvest.latest) : null);

  return (
    <div class="ev-sheet-body" aria-busy={busy()}>
      <div class="ev-sheet-facts">
        <p>
          <strong>{t().sowing}</strong> {date(model().sowing)}
        </p>
        <p>
          <strong>{t().harvest}</strong> {harvestText()}
        </p>
        <p>
          <strong>{t().field}</strong> {fieldLabel()}
        </p>
        <div class="ev-chips">
          <Chip tone="typical">{t().subtitleAdd}</Chip>
        </div>
      </div>

      <section aria-labelledby="ev-sheet-stages">
        <h3 id="ev-sheet-stages">{t().stages}</h3>
        <Show when={stages().length} fallback={<p class="ev-muted">{t().noStages}</p>}>
          <ol class="ev-stage-list">
            <For each={stages()}>
              {(stage) => (
                <li>
                  <strong>{stage.name}</strong>
                  <span>
                    {date(stage.from)} – {date(stage.to)}
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </section>

      <section class="ev-change" aria-labelledby="ev-sheet-change">
        <h3 id="ev-sheet-change">{t().changeTitle}</h3>
        <Show when={noneChoice()}>
          {(choice) => (
            <p class="ev-sheet-refusal" role="status">
              {choice().message}
            </p>
          )}
        </Show>
        <Show when={model().choice.kind === "add"}>
          <p>{t().addChange(props.preview.cropName, date(model().sowing), harvestBy(), fieldLabel())}</p>
          <p class="ev-muted">{t().noWrite}</p>
          <button type="button" class="ev-btn primary" disabled={busy()} onClick={() => void add()}>
            {busy() ? t().saving : t().add}
          </button>
        </Show>
        <Show when={replaceChoice()}>
          {(choice) => (
            <>
              <Show when={props.request.mode !== "replace"}>
                <p class="ev-muted">{t().overlapNote}</p>
              </Show>
              <For each={choice().seasons}>
                {(season) => {
                  const from = () => season.plan.cropName ?? props.ctx.cropName(season.plan.cropId);
                  const fromDate = () => date(season.plan.plannedSowingDate ?? model().sowing);
                  return (
                    <div class="ev-change-option">
                      <p>{t().replaceChange(from(), fromDate(), props.preview.cropName, date(model().sowing), harvestBy())}</p>
                      <button type="button" class="ev-btn primary" disabled={busy()} onClick={() => void replace(season.plan.id)}>
                        {busy() ? t().saving : t().replace(from(), fromDate())}
                      </button>
                    </div>
                  );
                }}
              </For>
              <p class="ev-muted">{t().noWrite}</p>
            </>
          )}
        </Show>
        <Show when={problem()}>
          {(p) => (
            <div class="ev-sheet-error" role="alert">
              <p>{p().message}</p>
              <Show when={p().conflict}>
                <button type="button" class="ev-btn" disabled={busy()} onClick={() => void reload()}>
                  {t().reload}
                </button>
              </Show>
            </div>
          )}
        </Show>
      </section>

      <div class="ev-sheet-foot">
        <button type="button" class="ev-btn" onClick={() => props.onClose()}>
          {t().cancel}
        </button>
      </div>
    </div>
  );
}
