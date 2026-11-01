import { For, Show } from "solid-js";
import type { CropFitCandidate, CropFitPick, CropFitReview } from "@harvest/contracts";
import { Chip } from "../ui/Chip";
import { ScoreRing } from "../ui/ScoreRing";
import { Sheet } from "../ui/Sheet";
import { AiSpark } from "../ui/AiSpark";
import {
  BAND_NOTE,
  COMPONENT_LABELS,
  VERDICT_TEXT,
  arrangementText,
  candidateTitle,
  companionYieldText,
  displayName,
  estimateLines,
  formatArea,
  formatDate,
  formatInr,
  harvestText,
  isIntercrop,
  priceHarvestText,
  ratingText,
  shareBasisText,
  sowingText,
  verdictTone,
  waitLine,
  yieldFieldText,
  yieldText,
} from "./cropFitModel";
import { CandidateChips } from "./CropFitCard";

/**
 * Detail of one crop (ROUND2_SPEC.md 4.2): score parts, profit (central, likely, possible; per hectare and for the
 * field), prices, the soil comparison table (marker, your value, rating, crop need, verdict, source), the water and
 * rotation notes, uncertainties and basis links. Exported separately from the sheet so tests can render it.
 */
export function CandidateDetail(props: { candidate: CropFitCandidate; review: Pick<CropFitReview, "fieldAreaHa" | "pickOrigin">; pick?: CropFitPick | undefined }) {
  const c = () => props.candidate;
  const win = () => c().window;
  return (
    <div class="cf-detail">
      <CandidateChips candidate={c()} />
      <p class="cf-detail-dates">
        {sowingText(c())} · {harvestText(c())} · {c().durationDays.low === c().durationDays.high ? c().durationDays.low : `${c().durationDays.low} to ${c().durationDays.high}`} days
      </p>
      <Show when={waitLine(c())}>{(t) => <p class="cf-wait">{t()}</p>}</Show>
      <Show when={win()}>
        {(w) => (
          <p class="cf-muted">
            {w().scope === "district" ? "District" : "State"} {w().season} sowing window{w().fit < 1 ? ` (fit ${Math.round(w().fit * 100)}%)` : ""}
          </p>
        )}
      </Show>

      <Show when={props.pick && props.pick.reasons.length}>
        <section class="cf-detail-section" aria-label="Why it was picked">
          <h3>
            Why it was picked
            <Show when={props.review.pickOrigin === "model"}>
              {" "}
              <AiSpark use="crop_fit_picks" size={14} />
            </Show>
          </h3>
          <ul class="cf-reasons">
            <For each={props.pick!.reasons}>{(r) => <li>{r.text}</li>}</For>
          </ul>
        </section>
      </Show>

      <section class="cf-detail-section">
        <h3>Score</h3>
        <div class="cf-score-row">
          <ScoreRing score={c().score} size={56} label={`Fit score ${Math.round(c().score)} out of 100`} />
          <table class="cf-components">
            <tbody>
              <For each={COMPONENT_LABELS}>
                {(k) => (
                  <tr>
                    <th scope="row">{k.label}</th>
                    <td>{Math.round(c().components[k.key] * 100)}</td>
                    <td class="cf-muted">weight {k.weight}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <p class="cf-muted">
          Confidence {c().confidence}. Scored with the year-plan slot scoring.
          <Show when={c().rankScore !== undefined && c().waitPenalty}>{` Ranked on ${Math.round(c().rankScore!)} (score minus the wait penalty).`}</Show>
        </p>
      </section>

      <section class="cf-detail-section">
        <h3>Profit</h3>
        <Show when={c().profitPerHa} fallback={<p>Not shown: {c().cost ? "the harvest price or yield range is missing" : "the cost of cultivation is not sourced"}.</p>}>
          {(p) => (
            <table class="cf-estimates">
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col">Per ha</th>
                  <Show when={c().profitForField && props.review.fieldAreaHa}>
                    <th scope="col">Your {formatArea(props.review.fieldAreaHa!)}</th>
                  </Show>
                </tr>
              </thead>
              <tbody>
                <For each={[["Central", "central"], ["Likely", "likely"], ["Possible", "possible"]] as const}>
                  {([label, key]) => (
                    <tr>
                      <th scope="row">{label}</th>
                      <td>{estimateLines(p())[key]}</td>
                      <Show when={c().profitForField && props.review.fieldAreaHa}>
                        <td>{estimateLines(c().profitForField!)[key]}</td>
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          )}
        </Show>
        <p class="cf-muted">{BAND_NOTE}</p>
        <Show when={c().cost}>
          {(cost) => (
            <p class="cf-muted">
              Cost deducted: {cost().a2flPerHa ? `A2+FL ${formatInr(cost().a2flPerHa!)}/ha` : cost().c2PerHa ? `C2 ${formatInr(cost().c2PerHa!)}/ha` : "not sourced"} ({(cost().authority ?? "source").toUpperCase()} {cost().year ?? ""})
            </p>
          )}
        </Show>
      </section>

      <section class="cf-detail-section">
        <h3>Price and yield</h3>
        <p>
          Now: {c().marketNow ? `₹${c().marketNow!.p50}/kg, ${c().marketNow!.scopeLabel}` : "no recent mandi quotes"}
        </p>
        <p>
          {priceHarvestText(c())}
          <Show when={c().price?.yearsUsed.length}> (harvest weeks of {c().price!.yearsUsed.join(", ")})</Show>
        </p>
        <p>Yield {yieldText(c())}</p>
        <Show when={yieldFieldText(c())}>{(t) => <p>{t()}</p>}</Show>
      </section>

      <Show when={isIntercrop(c()) && c().companion}>
        {(k) => (
          <section class="cf-detail-section cf-companion" aria-label="Companion crop">
            <h3>Companion crop</h3>
            <p>
              <strong>{displayName(k())}</strong> in rows {k().rowRatio} with {c().cropName.toLowerCase()}
              <Show when={arrangementText(k())}>{(a) => `, as ${a()}`}</Show>
            </p>
            <p>
              <Chip tone={k().shareBasis === "sourced" ? "done" : "watch"}>{shareBasisText(k())}</Chip>{" "}
              <span class="cf-muted">{k().shareBasis === "sourced" ? "Each crop's share of its sole-crop yield comes from the cited source." : "No source gave the yield shares for this pair; code used its stated fallback shares."}</span>
            </p>
            <p>
              {c().cropName}: {priceHarvestText(c())}
            </p>
            <p>
              {k().cropName}: {priceHarvestText(k())}
            </p>
            <p>{k().cropName} yield {companionYieldText(k())}</p>
            <Show when={k().nitrogenCreditKgPerHa}>
              {(n) => <p>Nitrogen left for the next crop: {n().low === n().high ? n().low : `${n().low} to ${n().high}`} kg/ha</p>}
            </Show>
            <Show when={k().source}>
              {(src) => (
                <p class="cf-muted">
                  Source:{" "}
                  <Show when={src().url} fallback={src().title}>
                    <a href={src().url!} target="_blank" rel="noreferrer">
                      {src().title}
                    </a>
                  </Show>
                  <Show when={src().locator}>{` · ${src().locator}`}</Show>
                </p>
              )}
            </Show>
          </section>
        )}
      </Show>

      <section class="cf-detail-section">
        <h3>Soil comparison</h3>
        <Show when={c().soil.status === "compared"} fallback={<p>Confirm a soil report from this field to compare it with this crop.</p>}>
          <div class="cf-table-wrap">
            <table class="cf-soil-table">
              <thead>
                <tr>
                  <th scope="col">Marker</th>
                  <th scope="col">Your value</th>
                  <th scope="col">Rating</th>
                  <th scope="col">Crop need</th>
                  <th scope="col">Verdict</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                <For each={c().soil.checks}>
                  {(s) => (
                    <tr>
                      <th scope="row">{s.label}</th>
                      <td>{s.value === null ? "—" : `${s.value}${s.unit ? ` ${s.unit}` : ""}`}</td>
                      <td>{ratingText(s.rating)}</td>
                      <td>{s.need ?? "—"}</td>
                      <td>
                        <Chip tone={verdictTone(s.verdict)}>{VERDICT_TEXT[s.verdict]}</Chip>
                      </td>
                      <td>
                        <Show when={s.ratingSource} fallback="—">
                          {(src) => (
                            <Show when={src().url} fallback={src().title}>
                              <a href={src().url!} target="_blank" rel="noreferrer">
                                {src().title}
                              </a>
                            </Show>
                          )}
                        </Show>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <ul class="cf-notes">
            <For each={c().soil.checks.filter((s) => s.note || s.assumption)}>
              {(s) => (
                <li>
                  <strong>{s.label}:</strong> {s.note}
                  <Show when={s.assumption}> Assumption: {s.assumption}</Show>
                  <Show when={s.collectionDate}> Sampled {formatDate(s.collectionDate!)}.</Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>

      <section class="cf-detail-section">
        <h3>Water</h3>
        <p>{c().water.verdict}</p>
      </section>
      <section class="cf-detail-section">
        <h3>Rotation</h3>
        <p>{c().rotation.note ?? "No rotation note."}</p>
      </section>

      <Show when={c().uncertainties.length}>
        <section class="cf-detail-section">
          <h3>Uncertainties</h3>
          <ul class="cf-notes">
            <For each={c().uncertainties}>{(u) => <li>{u}</li>}</For>
          </ul>
        </section>
      </Show>
      <Show when={c().basis.length}>
        <section class="cf-detail-section">
          <h3>Basis</h3>
          <ul class="cf-notes">
            <For each={c().basis}>
              {(b) => (
                <li>
                  <Show when={b.url} fallback={b.label}>
                    <a href={b.url!} target="_blank" rel="noreferrer">
                      {b.label}
                    </a>
                  </Show>
                  <Show when={b.note}>
                    <span class="cf-muted"> · {b.note}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
    </div>
  );
}

export function CropFitSheet(props: { candidate: CropFitCandidate; review: CropFitReview; pick?: CropFitPick | undefined; onClose: () => void }) {
  return (
    <Sheet title={candidateTitle(props.candidate)} subtitle={<span>Rank {props.candidate.rank} of {props.review.candidates.length}</span>} onClose={props.onClose} class="cf-sheet">
      <CandidateDetail candidate={props.candidate} review={props.review} pick={props.pick} />
    </Sheet>
  );
}
