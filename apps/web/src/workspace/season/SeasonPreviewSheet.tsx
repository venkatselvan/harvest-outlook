import { For, Match, Show, Switch, createResource, type JSX } from "solid-js";
import type { SeasonPreview } from "@harvest/contracts";
import { Sheet } from "../ui/Sheet";
import { Sparkline } from "../ui/Sparkline";
import { Chip } from "../ui/Chip";
import { describeSeasonPreviewError, loadSeasonPreview, withPreviewField, type SeasonPreviewRequest } from "./seasonPreviewApi";
import {
  STEP_KIND, VERDICT_TEXT, VERDICT_TONE, YIELD_BASIS, dateSpan, inr, inrRange, kgRange, previewTitle, pricePathModel, rainBars, shortDate, stageStrip,
} from "./seasonPreviewModel";
import "./season-preview.css";

/**
 * Season preview sheet (ROUND3_SPEC.md section 7 item 7): a planned season in the shape of the Today view, from the
 * synchronous season-preview endpoint. Phone width first; every section has an empty state that says why it is empty.
 * All figures are code-computed references (stage calendar, past years' weather normals, historical seasonal prices,
 * the year-plan slot scoring); nothing here is a forecast or an observation.
 */
export function SeasonPreviewSheet(props: {
  farmId: string;
  request: SeasonPreviewRequest;
  /** Title shown while loading and used for sole crops (the Planner's season title). */
  title: string;
  onClose: () => void;
  fetchImpl?: typeof fetch;
  /** 2026-11-03 (12.3): preview on this field (a saved season's own field); null or omitted = the whole farm. */
  fieldId?: string | null | undefined;
}) {
  const [preview, { refetch }] = createResource(
    () => ({ farmId: props.farmId, request: withPreviewField(props.request, props.fieldId) }),
    ({ farmId, request }) => loadSeasonPreview(farmId, request, props.fetchImpl),
  );
  const title = () => (preview.state === "ready" ? previewTitle(preview()!, props.title) : props.title);
  return (
    <Sheet title={title()} subtitle="Planned season · calculated reference" closeLabel="Close season preview" class="season-preview-sheet" onClose={props.onClose}>
      <Switch>
        <Match when={preview.error}>
          <div class="sp-error" role="alert">
            <p>{describeSeasonPreviewError(preview.error)}</p>
            <button type="button" class="btn secondary" onClick={() => void refetch()}>Try again</button>
          </div>
        </Match>
        <Match when={preview.state === "ready" && preview()}>{(p) => <SeasonPreviewBody preview={p()} />}</Match>
        <Match when={true}>
          <p class="sp-loading" aria-busy="true">Building the season preview…</p>
        </Match>
      </Switch>
    </Sheet>
  );
}

function Section(props: { id: string; title: string; children: JSX.Element; aside?: JSX.Element }) {
  return (
    <section class="sp-section" aria-labelledby={props.id}>
      <div class="sp-section-head">
        <h3 id={props.id}>{props.title}</h3>
        <Show when={props.aside}>{props.aside}</Show>
      </div>
      {props.children}
    </section>
  );
}
const Empty = (props: { children: JSX.Element }) => <p class="sp-empty">{props.children}</p>;

/** The sheet's sections, in spec order. Exported for tests (rendered without the portal). */
export function SeasonPreviewBody(props: { preview: SeasonPreview }) {
  const p = () => props.preview;
  const strip = () => stageStrip(p().timeline, p().harvest, p().today);
  const bars = () => rainBars(p().weather.months);
  const path = () => pricePathModel(p().price, p().harvest);
  return (
    <div class="sp-body">
      {/* header */}
      <div class="sp-header">
        <p class="sp-dates">
          Sow {shortDate(p().sowing)}
          <Show when={p().harvest}>{(h) => <> · harvest {dateSpan(h().earliest, h().latest)}</>}</Show>
        </p>
        <div class="sp-chips">
          <Chip tone="typical">Planned season · calculated reference</Chip>
          <Show when={p().kind === "green_manure"}><Chip tone="legume">Green manure</Chip></Show>
          <Show when={p().kind === "intercrop"}><Chip tone="legume">Intercrop</Chip></Show>
          <Show when={p().productName}><Chip>{p().productName}</Chip></Show>
        </div>
        <Show when={p().companion}>
          {(c) => (
            <p class="sp-companion">
              With {c().cropName} ({c().productName}), rows {c().rowRatio}
              {c().shareBasis === "assumed" ? " · assumed yield shares" : " · sourced yield shares"}
            </p>
          )}
        </Show>
      </div>

      <Section id="sp-stages" title="Stages">
        <Show when={strip().segments.length} fallback={<Empty>No sourced stage calendar for this crop, so no stage strip is drawn.</Empty>}>
          <div class="sp-strip" role="img" aria-label={`Stages from ${shortDate(strip().start!)} to ${shortDate(strip().end!)}: ${strip().segments.map((s) => s.name).join(", ")}`}>
            <For each={strip().segments}>
              {(s, i) => <span class={`sp-strip-seg tone-${i() % 4}`} style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }} title={s.name} />}
            </For>
            <Show when={strip().todayPct !== null}>
              <i class="sp-strip-today" style={{ left: `${strip().todayPct}%` }} aria-hidden="true" />
            </Show>
          </div>
          <ol class="sp-strip-legend">
            <For each={strip().segments}>{(s, i) => <li><i class={`tone-${i() % 4}`} aria-hidden="true" />{s.name}</li>}</For>
          </ol>
          <Show when={strip().todayPct !== null}><p class="sp-note">The marker shows today.</p></Show>
        </Show>
      </Section>

      <Section id="sp-weather" title="Typical weather by month" aside={<Chip tone="typical">Typical</Chip>}>
        <Show when={p().weather.status === "typical" && bars().length} fallback={<Empty>{p().weather.note}</Empty>}>
          <ul class="sp-rain" aria-label="Typical rain and temperature by month">
            <For each={bars()}>
              {(b) => (
                <li>
                  <span class="sp-rain-bar" style={{ height: `${b.heightPct}%` }} aria-hidden="true" />
                  <strong>{b.rainMm === null ? "—" : `${Math.round(b.rainMm)} mm`}</strong>
                  <small>{b.tempText ?? "—"}</small>
                  <span class="sp-rain-label">{b.label}{b.days < 28 ? ` (${b.days} d)` : ""}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="sp-note">{p().weather.note}<Show when={p().weather.source}>{(s) => <> Normals {s().years.from} to {s().years.to}.</>}</Show></p>
        </Show>
        <Show when={p().water} fallback={<p class="sp-note">Water fit appears once the year plan has been generated.</p>}>
          {(w) => <p class="sp-water"><strong>Water fit {Math.round(w().fit * 100)}%</strong> · {w().verdict}{w().needMm !== null && w().rainMm !== null ? ` (need about ${w().needMm} mm, typical rain ${w().rainMm} mm)` : ""}</p>}
        </Show>
      </Section>

      <Section id="sp-price" title="Price through the season">
        <Show when={p().price} fallback={<Empty>{p().kind === "green_manure" ? "A green manure is ploughed in: no product and no price." : "No product is chosen for this season, so no price is shown."}</Empty>}>
          {(pr) => (
            <>
              <Show when={path().values.some((v) => v !== null)} fallback={<Empty>Not enough mandi history for a weekly price path in these weeks.</Empty>}>
                <Sparkline
                  values={path().values}
                  marks={path().harvestIndex !== null ? [path().harvestIndex!] : []}
                  label={`Past years' typical wholesale price by week, ${inr(path().min!)} to ${inr(path().max!)} per kg; the mark is the harvest week.`}
                  height={64}
                />
              </Show>
              <Show when={pr().status === "available" && pr().likely} fallback={<p class="sp-note">No harvest-week price range: {pr().reason?.replace(/_/g, " ") ?? "not enough history"}.</p>}>
                <p class="sp-price-line"><strong>Harvest week likely {inrRange(pr().likely!)}/kg</strong>{pr().p50 !== null ? ` · middle ${inr(pr().p50!)}` : ""}</p>
              </Show>
              <p class="sp-note">{pr().scopeLabel}{pr().yearsUsed.length ? ` · years ${pr().yearsUsed.join(", ")}` : ""}. Past seasons, not a forecast.</p>
              <Show when={p().marketNow} fallback={<p class="sp-note">No recent mandi quotes are stored for this product.</p>}>
                {(m) => <p class="sp-now">Price now {inr(m().p50)}/kg · {m().scopeLabel} ({m().markets} market{m().markets === 1 ? "" : "s"})</p>}
              </Show>
            </>
          )}
        </Show>
      </Section>

      <Section id="sp-money" title="Yield and profit for this field" aside={<Show when={p().score !== null}><Chip>Score {Math.round(p().score!)}</Chip></Show>}>
        <Show when={p().yieldKgPerHa || p().profitPerHa} fallback={<Empty>Generate the year plan to see yield, profit and score here.</Empty>}>
          <dl class="sp-money">
            <Show when={p().yieldKgPerHa}>
              <div>
                <dt>Yield{p().yieldForFieldKg ? " for the field" : " per ha"}</dt>
                <dd>{kgRange(p().yieldForFieldKg ?? p().yieldKgPerHa!)}</dd>
                <Show when={p().yieldBasis}><small>{YIELD_BASIS[p().yieldBasis!]}{p().yieldForFieldKg && p().fieldAreaHa ? ` · ${p().fieldAreaHa!.toFixed(2)} ha` : ""}</small></Show>
              </div>
            </Show>
            <Show when={p().profitForField ?? p().profitPerHa}>
              {(est) => (
                <div>
                  <dt>Likely profit{p().profitForField ? " for the field" : " per ha"}</dt>
                  <dd>{inrRange(est().likely)}</dd>
                  <small>Middle half of simulated outcomes; cost {p().cost?.authority ? `from ${p().cost!.authority!.toUpperCase()}${p().cost!.year ? ` ${p().cost!.year}` : ""}` : "not sourced"}</small>
                </div>
              )}
            </Show>
          </dl>
          <Show when={!p().profitPerHa}><p class="sp-note">Profit needs a price range, a yield and a sourced cost.</p></Show>
        </Show>
      </Section>

      <Section id="sp-soil" title="Soil checks">
        <Show when={p().soil?.status === "compared" && p().soil!.checks.length} fallback={<Empty>{p().soil ? "No confirmed soil report for this field. Add one in Farm settings to compare it with this crop." : "Soil checks could not be read."}</Empty>}>
          <ul class="sp-soil">
            <For each={p().soil!.checks}>
              {(c) => <li><Chip tone={VERDICT_TONE[c.verdict]}>{c.label}: {VERDICT_TEXT[c.verdict]}</Chip><Show when={c.note}><small>{c.note}</small></Show></li>}
            </For>
          </ul>
        </Show>
      </Section>

      <Section id="sp-steps" title="Steps">
        <Show when={p().steps.length} fallback={<Empty>No dated steps for this season: the crop has no stage calendar or care schedule here.</Empty>}>
          <ol class="sp-steps">
            <For each={p().steps}>
              {(st) => (
                <li class={`sp-step sp-step-${st.kind}`}>
                  <span class="sp-step-when">{dateSpan(st.from, st.to)}</span>
                  <span class="sp-step-title"><small>{STEP_KIND[st.kind]}</small> {st.title}</span>
                  <Show when={st.detail}><span class="sp-step-detail">{st.detail}</span></Show>
                  <Show when={st.source}>{(s) => <span class="sp-step-source">Source: {s().publisher}</span>}</Show>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </Section>

      <Section id="sp-limits" title="Limits of this preview">
        <Show when={p().limitations.length} fallback={<Empty>No limitations were reported.</Empty>}>
          <ul class="sp-limits"><For each={p().limitations}>{(l) => <li>{l}</li>}</For></ul>
        </Show>
      </Section>
    </div>
  );
}
