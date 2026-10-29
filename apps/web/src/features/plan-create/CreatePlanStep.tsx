import { Show, createResource, createSignal } from "solid-js";
import { A, useNavigate } from "@solidjs/router";
import { ApiError, request } from "../../lib/api";
import { createPlan } from "../../lib/plan-api";
import type { Farm } from "../../routes/farm/types";
import { defaultPlantingDate, toCreateInput, validateCreate, type CreatePlanErrors, type CreatePlanForm } from "./model";
import { newEntryId } from "../photo-region/http";

export interface CreatePlanStepProps {
  farm: Farm;
  cropId: string;
  productId: string | null;
}

async function cropSupportsPlans(cropId: string): Promise<{ name: string; supported: boolean }> {
  const env = await request<{ identity?: { commonNames?: { text: string; language: string }[] }; stages?: unknown[] }>(`/api/v1/crops/${encodeURIComponent(cropId)}`);
  const d = env.data!;
  const name = d.identity?.commonNames?.find((n) => n.language === "en")?.text ?? cropId;
  return { name, supported: Array.isArray(d.stages) && d.stages.length > 0 };
}

/** Plan creation after the farm photo region: the farmer confirms the few facts the plan needs. Stages and tasks are resolved on the server. */
export function CreatePlanStep(props: CreatePlanStepProps) {
  const navigate = useNavigate();
  const known = () => ({
    hasArea: !!props.farm.areaHectares || typeof props.farm.facts["area_reported"]?.value === "number",
    hasIrrigation: ["rainfed", "supplemental", "irrigated"].includes(String(props.farm.facts["irrigation_category"]?.value)),
  });
  const [form, setForm] = createSignal<CreatePlanForm>({ plantingDate: defaultPlantingDate(new Date()), area: "", irrigation: "", price: "" });
  const [errors, setErrors] = createSignal<CreatePlanErrors>({});
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [unsupported, setUnsupported] = createSignal<string | null>(null);
  const [support] = createResource(() => props.cropId, cropSupportsPlans);
  // One idempotency key per unchanged form so a retry after a timeout cannot create a second plan.
  let key = newEntryId("plan");
  const patch = (p: Partial<CreatePlanForm>) => {
    setForm({ ...form(), ...p });
    key = newEntryId("plan");
  };

  const submit = async (ev: SubmitEvent) => {
    ev.preventDefault();
    const errs = validateCreate(form(), known());
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      (document.querySelector("[data-field-error]") as HTMLElement | null)?.focus();
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const res = await createPlan(toCreateInput(props.farm.id, props.cropId, props.productId ?? `${props.cropId}-fresh`, form()), key);
      navigate(`/farm/plan/${res.data.snapshot.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "bad_request" && /stage definitions/i.test(e.message)) setUnsupported(e.message);
      else if (e instanceof ApiError && e.status === 422 && /stage definitions/i.test(e.message)) setUnsupported(e.message);
      else setFailure(e instanceof ApiError ? `The plan could not be created: ${e.message}` : "The plan could not be created. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card" aria-labelledby="cp-h" data-testid="create-plan">
      <h2 id="cp-h">Create your season plan</h2>
      <Show when={support() && !support()!.supported}>
        <UnsupportedNote name={support()!.name} />
      </Show>
      <Show when={unsupported()}>
        {(m) => (
          <div role="alert" data-testid="plan-unsupported">
            <p>Season plan not yet supported for this crop/region.</p>
            <p class="se-help">{m()}</p>
            <p><A href="/explore">Back to crop information</A></p>
          </div>
        )}
      </Show>
      <Show when={!(support() && !support()!.supported) && !unsupported()}>
        <form onSubmit={(e) => void submit(e)} novalidate>
          <p class="pr-help">Planting dates and stage windows are estimates. Tasks and stage durations come from the crop catalogue, not from you.</p>
          <div class="field">
            <label for="cp-date">Planting date</label>
            <input id="cp-date" type="date" value={form().plantingDate} onInput={(e) => patch({ plantingDate: e.currentTarget.value })} aria-invalid={errors().plantingDate ? "true" : "false"} aria-describedby={errors().plantingDate ? "cp-date-err" : undefined} required />
            <Show when={errors().plantingDate}><p id="cp-date-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{errors().plantingDate}</p></Show>
          </div>
          <Show when={!known().hasArea}>
            <div class="field">
              <label for="cp-area">Area (hectares)</label>
              <input id="cp-area" type="text" inputmode="decimal" value={form().area} onInput={(e) => patch({ area: e.currentTarget.value })} aria-invalid={errors().area ? "true" : "false"} aria-describedby={errors().area ? "cp-area-err" : undefined} />
              <Show when={errors().area}><p id="cp-area-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{errors().area}</p></Show>
            </div>
          </Show>
          <Show when={!known().hasIrrigation}>
            <div class="field">
              <label for="cp-irr">How is the land watered?</label>
              <select id="cp-irr" value={form().irrigation} onChange={(e) => patch({ irrigation: e.currentTarget.value as CreatePlanForm["irrigation"] })} aria-invalid={errors().irrigation ? "true" : "false"} aria-describedby={errors().irrigation ? "cp-irr-err" : undefined}>
                <option value="">Choose…</option>
                <option value="rainfed">Rain only</option>
                <option value="supplemental">Rain plus some irrigation</option>
                <option value="irrigated">Irrigated</option>
              </select>
              <Show when={errors().irrigation}><p id="cp-irr-err" class="pr-error" role="alert" tabindex="-1" data-field-error>{errors().irrigation}</p></Show>
            </div>
          </Show>
          <div class="field">
            <label for="cp-price">Price you expect (rupees per kg, optional)</label>
            <input id="cp-price" type="text" inputmode="decimal" value={form().price} onInput={(e) => patch({ price: e.currentTarget.value })} aria-invalid={errors().price ? "true" : "false"} aria-describedby="cp-price-help" />
            <p id="cp-price-help" class="pr-help">Used only for your own profit estimate, labelled as your price. Leave empty if you do not know.</p>
            <Show when={errors().price}><p class="pr-error" role="alert" tabindex="-1" data-field-error>{errors().price}</p></Show>
          </div>
          <Show when={failure()}><p role="alert" class="pr-error">{failure()}</p></Show>
          <button type="submit" class="btn" disabled={busy()} data-testid="create-plan-submit">{busy() ? "Creating plan…" : "Create season plan"}</button>
        </form>
      </Show>
    </section>
  );
}

function UnsupportedNote(props: { name: string }) {
  return (
    <div data-testid="plan-unsupported">
      <p>Season plan not yet supported for this crop/region.</p>
      <p class="se-help">{props.name} has crop information in the catalogue, but no source-backed stage definitions yet, so no stage windows or tasks are built.</p>
      <p><A href="/explore">Back to crop information</A></p>
    </div>
  );
}
