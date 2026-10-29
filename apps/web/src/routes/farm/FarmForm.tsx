import { For, Show, createSignal } from "solid-js";
import { ApiError } from "../../lib/api";
import { apiRequest, jsonInit, newEntryId } from "../../features/photo-region/http";
import { IRRIGATION_OPTIONS, MONTHS, STATES, buildFarmBody, validateFarmForm, type FarmFormErrors, type FarmFormInput } from "./formModel";
import type { Farm } from "./types";

export function FarmForm(props: { onCreated: (farm: Farm) => void }) {
  const [district, setDistrict] = createSignal("");
  const [stateCode, setStateCode] = createSignal("");
  const [startMonth, setStartMonth] = createSignal("");
  const [endMonth, setEndMonth] = createSignal("");
  const [irrigation, setIrrigation] = createSignal("");
  const [areaKnown, setAreaKnown] = createSignal(true);
  const [area, setArea] = createSignal("");
  const [areaUnit, setAreaUnit] = createSignal<"acre" | "ha">("acre");
  const [errors, setErrors] = createSignal<FarmFormErrors>({});
  const [serverError, setServerError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let key = newEntryId("farm");

  const input = (): FarmFormInput => ({
    district: district(),
    stateCode: stateCode(),
    startMonth: startMonth(),
    endMonth: endMonth(),
    irrigation: irrigation(),
    areaKnown: areaKnown(),
    area: area(),
    areaUnit: areaUnit(),
  });

  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    if (busy()) return;
    const errs = validateFarmForm(input());
    setErrors(errs);
    setServerError(null);
    if (Object.keys(errs).length > 0) {
      queueMicrotask(() => (document.querySelector("[data-field-error]") as HTMLElement | null)?.focus());
      return;
    }
    setBusy(true);
    try {
      const env = await apiRequest<Farm>("/api/v1/farms", jsonInit("POST", buildFarmBody(input()), { "idempotency-key": key }));
      props.onCreated(env.data!);
    } catch (err) {
      if (err instanceof ApiError && err.code === "idempotency_payload_mismatch") key = newEntryId("farm");
      setServerError(err instanceof ApiError ? `Could not save the farm: ${err.message}` : "Could not save the farm.");
    } finally {
      setBusy(false);
    }
  };

  const err = (k: keyof FarmFormErrors) => errors()[k];

  return (
    <form class="farm-form card" onSubmit={submit} novalidate aria-labelledby="farm-form-title">
      <h2 id="farm-form-title">Tell us about your farm</h2>
      <p class="pr-help">Only the district is required. Choose "I don't know" or "Not decided" when unsure; nothing is guessed for you.</p>

      <div class="field">
        <label for="f-district">District name</label>
        <input id="f-district" name="district" type="text" autocomplete="off" maxlength="120" value={district()} onInput={(e) => setDistrict(e.currentTarget.value)} aria-invalid={err("district") ? "true" : "false"} aria-describedby={err("district") ? "f-district-err" : undefined} required />
        <Show when={err("district")}><p id="f-district-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{err("district")}</p></Show>
      </div>

      <div class="field">
        <label for="f-state">State or union territory</label>
        <select id="f-state" name="state" value={stateCode()} onChange={(e) => setStateCode(e.currentTarget.value)}>
          <option value="">Not sure</option>
          <For each={STATES}>{(s) => <option value={s.code}>{s.name}</option>}</For>
        </select>
      </div>

      <fieldset class="field" aria-describedby={err("window") ? "f-window-err" : undefined}>
        <legend>Planting window (months)</legend>
        <div class="row">
          <div>
            <label for="f-start">From</label>
            <select id="f-start" name="startMonth" value={startMonth()} onChange={(e) => setStartMonth(e.currentTarget.value)}>
              <option value="">Not decided</option>
              <For each={MONTHS}>{(m, i) => <option value={String(i() + 1)}>{m}</option>}</For>
            </select>
          </div>
          <div>
            <label for="f-end">To</label>
            <select id="f-end" name="endMonth" value={endMonth()} onChange={(e) => setEndMonth(e.currentTarget.value)}>
              <option value="">Not decided</option>
              <For each={MONTHS}>{(m, i) => <option value={String(i() + 1)}>{m}</option>}</For>
            </select>
          </div>
        </div>
        <Show when={err("window")}><p id="f-window-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{err("window")}</p></Show>
      </fieldset>

      <div class="field">
        <label for="f-irrigation">How is the land watered?</label>
        <select id="f-irrigation" name="irrigation" value={irrigation()} onChange={(e) => setIrrigation(e.currentTarget.value)} aria-invalid={err("irrigation") ? "true" : "false"}>
          <option value="" disabled>Choose one</option>
          <For each={IRRIGATION_OPTIONS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </select>
        <Show when={err("irrigation")}><p class="pr-error" role="alert" tabindex="-1" data-field-error>{err("irrigation")}</p></Show>
      </div>

      <fieldset class="field">
        <legend>Area (optional)</legend>
        <div class="row">
          <div>
            <label for="f-area">Area</label>
            <input id="f-area" name="area" type="number" inputmode="decimal" min="0" step="any" value={area()} disabled={!areaKnown()} onInput={(e) => setArea(e.currentTarget.value)} aria-invalid={err("area") ? "true" : "false"} aria-describedby={err("area") ? "f-area-err" : undefined} />
          </div>
          <div>
            <label for="f-unit">Unit</label>
            <select id="f-unit" name="areaUnit" value={areaUnit()} disabled={!areaKnown()} onChange={(e) => setAreaUnit(e.currentTarget.value as "acre" | "ha")}>
              <option value="acre">acre</option>
              <option value="ha">hectare</option>
            </select>
          </div>
        </div>
        <label class="check">
          <input type="checkbox" checked={!areaKnown()} onChange={(e) => setAreaKnown(!e.currentTarget.checked)} /> I don't know the area
        </label>
        <Show when={err("area")}><p id="f-area-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{err("area")}</p></Show>
      </fieldset>

      <Show when={serverError()}><p class="pr-error" role="alert">{serverError()}</p></Show>
      <button type="submit" class="btn" disabled={busy()}>{busy() ? "Saving…" : "Save farm"}</button>
    </form>
  );
}
