import { For, Show, createSignal } from "solid-js";
import { VoiceInput } from "../speech/VoiceInput";
import type { SpeechLang } from "../speech/speechMachine";
import type { Area, CropSummary } from "../comparison/types";
import { IRRIGATION_OPTIONS, IRRIGATION_WHY, MAX_NARRATIVE, MONTHS, areaConversionText, priceConversionText, type ProfileErrors, type ProfileField, type ProfileInput } from "./model";
import "./profile.css";

export interface ProfileFormProps {
  profile: ProfileInput;
  onChange: (patch: Partial<ProfileInput>) => void;
  errors: ProfileErrors;
  states: Area[];
  districts: Area[];
  districtNote: string | null;
  districtsLoading: boolean;
  crops: CropSummary[];
  refsError: string | null;
  submitting: boolean;
  onSubmit: () => void;
}

const nameOf = (a: Area): string => a.names.en ?? a.id;

function FieldError(props: { id: string; message: string | undefined }) {
  return (
    <Show when={props.message}>
      <p id={props.id} class="pf-error" role="alert">{props.message}</p>
    </Show>
  );
}

export function ProfileForm(props: ProfileFormProps) {
  const p = () => props.profile;
  const err = (f: ProfileField) => props.errors[f];
  const describe = (f: ProfileField, extra?: string) => [err(f) ? `pf-err-${f}` : "", extra ?? ""].filter(Boolean).join(" ") || undefined;
  const [voiceOpen, setVoiceOpen] = createSignal(false);
  const [voiceLang, setVoiceLang] = createSignal<SpeechLang>("en");
  const areaText = () => areaConversionText(p());
  const priceText = () => priceConversionText(p());

  const toggleExcluded = (cropId: string, on: boolean) =>
    props.onChange({ excludedCropIds: on ? [...new Set([...p().excludedCropIds, cropId])] : p().excludedCropIds.filter((c) => c !== cropId) });

  return (
    <form class="pf" novalidate onSubmit={(e) => { e.preventDefault(); props.onSubmit(); }} aria-labelledby="pf-title" data-testid="profile-form">
      <h2 id="pf-title">Your farm and season</h2>
      <Show when={props.refsError}>
        <p class="pf-error" role="alert">{props.refsError}</p>
      </Show>

      <div class="pf-field">
        <label for="pf-state">State</label>
        <select id="pf-state" value={p().stateId} aria-invalid={err("state") ? "true" : undefined} aria-describedby={describe("state")}
          onChange={(e) => props.onChange({ stateId: e.currentTarget.value, districtId: "" })}>
          <option value="">Choose a state</option>
          <For each={props.states}>{(s) => <option value={s.id} selected={s.id === p().stateId}>{nameOf(s)}</option>}</For>
        </select>
        <FieldError id="pf-err-state" message={err("state")} />
      </div>

      <div class="pf-field">
        <label for="pf-district">District (optional)</label>
        <select id="pf-district" value={p().districtId} disabled={!p().stateId || props.districts.length === 0} aria-describedby={describe("district", "pf-district-help")}
          onChange={(e) => props.onChange({ districtId: e.currentTarget.value })}>
          <option value="">Not sure / whole state</option>
          <For each={props.districts}>{(d) => <option value={d.id} selected={d.id === p().districtId}>{nameOf(d)}</option>}</For>
        </select>
        <p id="pf-district-help" class="pf-help">
          {!p().stateId ? "Choose a state first." : props.districtsLoading ? "Loading districts…" : props.districts.length === 0 ? (props.districtNote ?? "No sourced district list for this state yet; screening uses the state.") : "A district can carry a regional exception to a state-wide rule."}
        </p>
        <FieldError id="pf-err-district" message={err("district")} />
      </div>

      <div class="pf-field">
        <label for="pf-month">Planting month</label>
        <select id="pf-month" value={p().plantingMonth} aria-invalid={err("month") ? "true" : undefined} aria-describedby={describe("month")}
          onChange={(e) => props.onChange({ plantingMonth: e.currentTarget.value })}>
          <option value="">Choose a month</option>
          <For each={MONTHS}>{(m, i) => <option value={String(i() + 1)} selected={String(i() + 1) === p().plantingMonth}>{m}</option>}</For>
        </select>
        <FieldError id="pf-err-month" message={err("month")} />
      </div>

      <div class="pf-field">
        <label for="pf-date">Exact planting date (optional)</label>
        <input id="pf-date" type="date" value={p().plantingDate} aria-invalid={err("date") ? "true" : undefined} aria-describedby={describe("date")}
          onInput={(e) => props.onChange({ plantingDate: e.currentTarget.value })} />
        <FieldError id="pf-err-date" message={err("date")} />
      </div>

      <div class="pf-field">
        <label for="pf-irrigation">How is the land watered?</label>
        <select id="pf-irrigation" value={p().irrigation} aria-invalid={err("irrigation") ? "true" : undefined} aria-describedby={describe("irrigation", "pf-irrigation-why")}
          onChange={(e) => props.onChange({ irrigation: e.currentTarget.value as ProfileInput["irrigation"] })}>
          <option value="">Choose one</option>
          <For each={IRRIGATION_OPTIONS}>{(o) => <option value={o.value} selected={o.value === p().irrigation}>{o.label}</option>}</For>
        </select>
        <p id="pf-irrigation-why" class="pf-help">{IRRIGATION_WHY}</p>
        <FieldError id="pf-err-irrigation" message={err("irrigation")} />
      </div>

      <fieldset class="pf-field">
        <legend>Area (optional)</legend>
        <label class="pf-check"><input type="checkbox" checked={p().areaKnown} onChange={(e) => props.onChange({ areaKnown: e.currentTarget.checked })} /> I know the area</label>
        <Show when={p().areaKnown}>
          <div class="pf-row">
            <label for="pf-area" class="pf-sr">Area amount</label>
            <input id="pf-area" inputmode="decimal" autocomplete="off" value={p().area} aria-invalid={err("area") ? "true" : undefined} aria-describedby={describe("area", "pf-area-conv")}
              onInput={(e) => props.onChange({ area: e.currentTarget.value })} />
            <div class="pf-toggle" role="radiogroup" aria-label="Area unit">
              <label class={p().areaUnit === "acre" ? "pf-opt on" : "pf-opt"}><input type="radio" name="pf-area-unit" value="acre" checked={p().areaUnit === "acre"} onChange={() => props.onChange({ areaUnit: "acre" })} /> acre</label>
              <label class={p().areaUnit === "ha" ? "pf-opt on" : "pf-opt"}><input type="radio" name="pf-area-unit" value="ha" checked={p().areaUnit === "ha"} onChange={() => props.onChange({ areaUnit: "ha" })} /> hectare</label>
            </div>
          </div>
          <p id="pf-area-conv" class="pf-help" aria-live="polite" data-testid="area-conversion">{areaText() ?? "Check the unit: 1 hectare is about 2.47 acres."}</p>
          <FieldError id="pf-err-area" message={err("area")} />
        </Show>
      </fieldset>

      <fieldset class="pf-field">
        <legend>Assumed price (optional)</legend>
        <label class="pf-check"><input type="checkbox" checked={p().priceOn} onChange={(e) => props.onChange({ priceOn: e.currentTarget.checked })} /> I want to try my own price</label>
        <Show when={p().priceOn}>
          <label for="pf-price-product">Price is for</label>
          <select id="pf-price-product" value={p().priceProductId} aria-invalid={err("priceProduct") ? "true" : undefined} aria-describedby={describe("priceProduct")}
            onChange={(e) => props.onChange({ priceProductId: e.currentTarget.value })}>
            <option value="">Choose a crop product</option>
            <For each={props.crops}>
              {(c) => (
                <optgroup label={c.name}>
                  <For each={c.products}>{(pr) => <option value={pr.productId} selected={pr.productId === p().priceProductId}>{pr.name}</option>}</For>
                </optgroup>
              )}
            </For>
          </select>
          <FieldError id="pf-err-priceProduct" message={err("priceProduct")} />
          <div class="pf-row">
            <label for="pf-price" class="pf-sr">Price amount in rupees</label>
            <input id="pf-price" inputmode="decimal" autocomplete="off" value={p().price} aria-invalid={err("price") ? "true" : undefined} aria-describedby={describe("price", "pf-price-conv")}
              onInput={(e) => props.onChange({ price: e.currentTarget.value })} />
            <div class="pf-toggle" role="radiogroup" aria-label="Price unit">
              <label class={p().priceUnit === "inr_per_kg" ? "pf-opt on" : "pf-opt"}><input type="radio" name="pf-price-unit" value="inr_per_kg" checked={p().priceUnit === "inr_per_kg"} onChange={() => props.onChange({ priceUnit: "inr_per_kg" })} /> INR/kg</label>
              <label class={p().priceUnit === "inr_per_quintal" ? "pf-opt on" : "pf-opt"}><input type="radio" name="pf-price-unit" value="inr_per_quintal" checked={p().priceUnit === "inr_per_quintal"} onChange={() => props.onChange({ priceUnit: "inr_per_quintal" })} /> INR/quintal</label>
            </div>
          </div>
          <p id="pf-price-conv" class="pf-help" aria-live="polite" data-testid="price-conversion">{priceText() ?? "A quintal is 100 kg. This is your own assumption, not a market price."}</p>
          <FieldError id="pf-err-price" message={err("price")} />
        </Show>
      </fieldset>

      <fieldset class="pf-field">
        <legend>Crops I will not grow (optional)</legend>
        <details class="pf-details">
          <summary>{p().excludedCropIds.length ? `${p().excludedCropIds.length} crop${p().excludedCropIds.length === 1 ? "" : "s"} excluded` : "Choose crops to exclude"}</summary>
          <div class="pf-checks">
            <For each={props.crops}>
              {(c) => (
                <label class="pf-check"><input type="checkbox" checked={p().excludedCropIds.includes(c.cropId)} onChange={(e) => toggleExcluded(c.cropId, e.currentTarget.checked)} /> {c.name}</label>
              )}
            </For>
          </div>
        </details>
      </fieldset>

      <div class="pf-field">
        <label for="pf-narrative">Notes about your farm (optional)</label>
        <textarea id="pf-narrative" rows="3" maxlength={MAX_NARRATIVE + 200} value={p().narrative} aria-invalid={err("narrative") ? "true" : undefined} aria-describedby={describe("narrative", "pf-narrative-help")}
          onInput={(e) => props.onChange({ narrative: e.currentTarget.value })} />
        <p id="pf-narrative-help" class="pf-help">Kept on this screen only. It is not saved and does not change the comparison yet.</p>
        <FieldError id="pf-err-narrative" message={err("narrative")} />
        <button type="button" class="btn pf-secondary" aria-expanded={voiceOpen()} aria-controls="pf-voice" onClick={() => setVoiceOpen(!voiceOpen())}>
          {voiceOpen() ? "Hide voice" : "Use voice"}
        </button>
        <Show when={voiceOpen()}>
          <div id="pf-voice" class="pf-voice">
            <label for="pf-voice-lang">Voice language</label>
            <select id="pf-voice-lang" value={voiceLang()} onChange={(e) => setVoiceLang(e.currentTarget.value as SpeechLang)}>
              <option value="en" selected={voiceLang() === "en"}>English</option>
              <option value="ta" selected={voiceLang() === "ta"}>Tamil</option>
              <option value="hi" selected={voiceLang() === "hi"}>Hindi</option>
            </select>
            <VoiceInput language={voiceLang()} onConfirmText={(t) => { props.onChange({ narrative: p().narrative ? `${p().narrative}\n${t}` : t }); setVoiceOpen(false); }} />
          </div>
        </Show>
      </div>

      <button type="submit" class="btn pf-submit" disabled={props.submitting} aria-busy={props.submitting}>
        {props.submitting ? "Comparing…" : "Compare crops"}
      </button>
    </form>
  );
}
