import type { CurrentMandiQuotes } from "@harvest/contracts";
import { For, Show } from "solid-js";
import { dateLabel, today } from "./state";
import { priceGapTitle, sourceReason } from "./reasons";
export type CurrentQuoteProduct = CurrentMandiQuotes["products"][number];
export function CurrentQuote(props: {
  product: CurrentQuoteProduct;
  name?: string;
  compact?: boolean;
}) {
  const quote = () => props.product.quotes[0];
  return (
    <article
      class={`current-quote ${props.compact ? "compact" : ""}`}
      aria-label={
        props.name ? `Latest mandi quote for ${props.name}` : undefined
      }
    >
      <Show when={props.name}>
        <h3>{props.name}</h3>
      </Show>
      <Show
        when={quote()}
        fallback={
          <div class="quote-data-gap">
            <strong>{priceGapTitle(props.product.missingReason)}</strong>
            <p>{sourceReason(props.product.missingReason)}</p>
            <details>
              <summary>Provider check</summary>
              <p>{sourceReason(props.product.providerStatus)}</p>
            </details>
          </div>
        }
      >
        {(q) => (
          <>
            <div class="current-quote-value">
              <strong>
                {q().modalInrPerKg !== null
                  ? `₹${Number(q().modalInrPerKg).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
                  : "Price not published"}
                {q().modalInrPerKg !== null ? <small> / kg</small> : null}
              </strong>
              <span class={`tiny-pill ${q().stale ? "stale" : ""}`}>
                {q().date === today()
                  ? "Reported today"
                  : q().stale
                    ? "Older dated quote"
                    : "Recent dated quote"}
              </span>
            </div>
            <p class="current-quote-date">
              {q().marketName} · {dateLabel(q().date)}
            </p>
            <p class="current-quote-scope">
              {props.product.scope === "district"
                ? "Farm district"
                : props.product.scope === "state"
                  ? "Broader state reference"
                  : "Broader national reference"}{" "}
              · {[q().district, q().state].filter(Boolean).join(", ")}
            </p>
            <Show when={props.product.fallbackReason}>
              <p class="quote-fallback">{props.product.fallbackReason}</p>
            </Show>
            <Show
              when={
                !["ok", "not_checked"].includes(props.product.providerStatus)
              }
            >
              <p class="quote-provider-issue">
                Provider check: {sourceReason(props.product.providerStatus)}
              </p>
            </Show>
            <p class="current-quote-source-unit">
              {q().modal !== null
                ? `₹${Number(q().modal).toLocaleString("en-IN")} / quintal in source`
                : "Source modal price unavailable"}
              {q().unitBasis === "agmarknet_convention"
                ? " · AGMARKNET unit convention"
                : " · provider-declared unit"}
            </p>
            <a
              class="current-quote-source"
              href={q().source}
              target="_blank"
              rel="noreferrer"
            >
              AGMARKNET / data.gov.in ↗
            </a>
            <Show when={!props.compact}>
              <p class="current-quote-checked">
                Fetched{" "}
                {new Date(q().fetchedAt).toLocaleString("en-IN", {
                  day: "numeric",
                  month: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}{" "}
                · {q().variety ?? "Variety not specified"}
              </p>
              <Show when={q().flags.length}>
                <details>
                  <summary>Source notes</summary>
                  <For each={q().flags}>
                    {(flag) => <p>{sourceReason(flag)}</p>}
                  </For>
                </details>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </article>
  );
}
