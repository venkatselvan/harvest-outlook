import { WaterBalanceInput, type WaterBalanceResult, type WaterRun } from '@harvest/contracts';
import { waterDimensionalCheck } from '../units';
import { addDays } from '../time/stages';

/**
 * FAO-56 single-coefficient daily root-zone depletion bucket (method water-balance/1).
 *
 *   ETc_i  = Ks_i * Kc_i * ET0_i
 *   Dr_i   = Dr_{i-1} - Peff_i + ETc_i                     (before irrigation)
 *   if Dr_i < 0: deep percolation/runoff += -Dr_i, Dr_i = 0  (surplus leaves the root zone)
 *   if Dr_i > RAW (= p * TAW): irrigate net I_i = Dr_i (refill to field capacity), Dr_i = 0
 *   Ks_i   = 1 if Dr_{i-1} <= RAW else (TAW - Dr_{i-1}) / (TAW - RAW)
 *   gross  = net / efficiency;  litres/ha = gross_mm * 10,000
 *
 * Simplifications (stated in the result): Kc is constant within each supplied stage
 * (no linear interpolation through development), no dual-Kc soil evaporation, no
 * capillary rise, no explicit runoff model (all surplus counted as deep percolation/
 * runoff together). stressDays counts days with Ks < 1 (start-of-day depletion above RAW);
 * under refill-at-RAW irrigation this is 0 unless the initial depletion exceeds RAW.
 *
 * Missing inputs are never filled: missing ET0 or Kc makes the result incomplete;
 * missing rain is not assumed zero (incomplete); forecast rain is either used and
 * labelled scenario, or ignored (treated as zero rain, also a scenario).
 * Unknown TAW produces labelled TAW scenarios (if provided) plus a no-storage
 * scenario (daily max(0, ETc - Peff)) — never a 'derived' figure.
 */
export const WATER_METHOD_VERSION = 'water-balance/1';

type Input = ReturnType<typeof WaterBalanceInput.parse>;

/** Daily fixed fraction used for calendar months that are only partly covered by the series (FAO-56 / CROPWAT "fixed percentage" convention). */
export const PARTIAL_MONTH_FIXED_FRACTION = 0.8;

function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * USDA-SCS monthly ratio is only meaningful on a full calendar-month total. For a month not fully
 * covered by the (contiguous) series the documented daily fixed fraction is used instead.
 * `methodByMonth` records which method applied to each month.
 */
function effectiveRainFactors(inp: Input, rainUsed: (number | null)[]): { factors: number[]; methodByMonth: Map<string, string> } {
  const m = inp.effectiveRain;
  const methodByMonth = new Map<string, string>();
  if (m.method === 'fixed_fraction') {
    inp.days.forEach((d) => methodByMonth.set(d.date.slice(0, 7), `fixed_fraction(${m.fraction})`));
    return { factors: rainUsed.map(() => m.fraction), methodByMonth };
  }
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  inp.days.forEach((d, i) => {
    const k = d.date.slice(0, 7);
    totals.set(k, (totals.get(k) ?? 0) + (rainUsed[i] ?? 0));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const complete = (k: string) => counts.get(k) === daysInMonth(k);
  for (const k of counts.keys()) methodByMonth.set(k, complete(k) ? 'usda_scs_monthly' : `partial_month_fixed_fraction(${PARTIAL_MONTH_FIXED_FRACTION})`);
  const factors = inp.days.map((d) => {
    const k = d.date.slice(0, 7);
    if (!complete(k)) return PARTIAL_MONTH_FIXED_FRACTION;
    const p = totals.get(k) ?? 0;
    if (p <= 0) return 0;
    const peff = p <= 250 ? (p * (125 - 0.2 * p)) / 125 : 125 + 0.1 * p;
    return Math.min(1, peff / p);
  });
  return { factors, methodByMonth };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function runBucket(inp: Input, kc: number[], et0: number[], peff: number[], fromForecast: boolean[], taw: number, label: string, evidenceState: 'derived' | 'scenario'): WaterRun {
  const raw = inp.rootZone.depletionFraction * taw;
  let dr = Math.min(inp.rootZone.initialDepletionMm, taw);
  let etcSum = 0, peffSum = 0, peffFc = 0, net = 0, deep = 0, stress = 0;
  const events: WaterRun['events'] = [];
  const daily: WaterRun['daily'] = [];
  inp.days.forEach((d, i) => {
    const ks = dr <= raw ? 1 : Math.max(0, (taw - dr) / (taw - raw));
    if (ks < 1) stress += 1;
    const etc = ks * kc[i]! * et0[i]!;
    const pe = peff[i]!;
    etcSum += etc;
    peffSum += pe;
    if (fromForecast[i]) peffFc += pe;
    dr = dr - pe + etc;
    if (dr < 0) {
      deep += -dr;
      dr = 0;
    }
    if (dr > taw) dr = taw;
    let irr = 0;
    if (dr > raw) {
      irr = dr;
      net += irr;
      events.push({ date: d.date, netMm: r3(irr) });
      dr = 0;
    }
    daily.push({ date: d.date, kc: kc[i]!, etcMm: r3(etc), effectiveRainMm: r3(pe), rainState: d.rainState, irrigationNetMm: r3(irr), depletionEndMm: r3(dr) });
  });
  return finishRun(inp, { label, evidenceState, tawMm: taw, etcMm: etcSum, effectiveRainMm: peffSum, effectiveRainFromForecastMm: peffFc, netIrrigationMm: net, deepPercolationMm: deep, stressDays: stress, events, daily });
}

function finishRun(
  inp: Input,
  r: Omit<WaterRun, 'grossIrrigationMm' | 'grossLitresPerHa' | 'grossLitresTotal'>,
): WaterRun {
  const gross = inp.irrigationEfficiency === null ? null : r.netIrrigationMm / inp.irrigationEfficiency;
  return {
    ...r,
    etcMm: r3(r.etcMm),
    effectiveRainMm: r3(r.effectiveRainMm),
    effectiveRainFromForecastMm: r3(r.effectiveRainFromForecastMm),
    netIrrigationMm: r3(r.netIrrigationMm),
    deepPercolationMm: r3(r.deepPercolationMm),
    grossIrrigationMm: gross === null ? null : r3(gross),
    grossLitresPerHa: gross === null ? null : Math.round(gross * 10000),
    grossLitresTotal: gross === null || inp.areaHa === null ? null : Math.round(gross * 10000 * inp.areaHa),
  };
}

function noStorageRun(inp: Input, kc: number[], et0: number[], peff: number[], fromForecast: boolean[]): WaterRun {
  let etcSum = 0, peffSum = 0, peffFc = 0, net = 0, deep = 0;
  const daily: WaterRun['daily'] = [];
  inp.days.forEach((d, i) => {
    const etc = kc[i]! * et0[i]!;
    const pe = peff[i]!;
    etcSum += etc;
    peffSum += pe;
    if (fromForecast[i]) peffFc += pe;
    const need = Math.max(0, etc - pe);
    deep += Math.max(0, pe - etc);
    net += need;
    daily.push({ date: d.date, kc: kc[i]!, etcMm: r3(etc), effectiveRainMm: r3(pe), rainState: d.rainState, irrigationNetMm: r3(need), depletionEndMm: null });
  });
  return finishRun(inp, { label: 'no_soil_storage', evidenceState: 'scenario', tawMm: null, etcMm: etcSum, effectiveRainMm: peffSum, effectiveRainFromForecastMm: peffFc, netIrrigationMm: net, deepPercolationMm: deep, stressDays: 0, events: [], daily });
}

export function calculateWaterBalance(raw: unknown): WaterBalanceResult {
  const dimensionalCheck = waterDimensionalCheck();
  const base = { schemaVersion: '1.0' as const, methodVersion: WATER_METHOD_VERSION, dimensionalCheck };
  const assumptions = [
    'FAO-56 single crop coefficient; Kc constant within each supplied stage.',
    'No dual-Kc soil evaporation, capillary rise or explicit runoff model; surplus rain is reported as deep percolation/runoff.',
    'Irrigation refills the root zone to field capacity when depletion exceeds RAW (p x TAW).',
  ];
  const parsed = WaterBalanceInput.safeParse(raw);
  if (!parsed.success) {
    return { ...base, status: 'invalid', evidenceState: 'scenario', missingInputs: [], errors: parsed.error.issues.map((i) => ({ code: 'schema_invalid', message: `${i.path.join('.') || '(root)'}: ${i.message}` })), assumptions, permittedPrecision: 'range_only', runs: [] };
  }
  const inp = parsed.data;
  if (!dimensionalCheck.passed) {
    return { ...base, status: 'invalid', evidenceState: 'scenario', missingInputs: [], errors: [{ code: 'dimensional_check_failed', message: '1 mm over 1 ha != 10,000 L' }], assumptions, permittedPrecision: 'range_only', runs: [] };
  }
  const errors: { code: string; message: string }[] = [];
  for (let i = 1; i < inp.days.length; i++) {
    if (inp.days[i]!.date <= inp.days[i - 1]!.date) errors.push({ code: 'days_not_strictly_increasing', message: `day ${inp.days[i]!.date} out of order` });
  }
  if (errors.length) return { ...base, status: 'invalid', evidenceState: 'scenario', missingInputs: [], errors, assumptions, permittedPrecision: 'range_only', runs: [] };

  // Gaps are never bridged: every calendar date between first and last must be present.
  const present = new Set(inp.days.map((d) => d.date));
  const gapDates: string[] = [];
  for (let d = inp.days[0]!.date, last = inp.days[inp.days.length - 1]!.date; d < last; d = addDays(d, 1)) {
    if (!present.has(d)) gapDates.push(d);
  }
  if (gapDates.length > 0) {
    const shown = gapDates.slice(0, 366).map((d) => `day:${d}`);
    if (gapDates.length > 366) shown.push(`day:+${gapDates.length - 366}_more`);
    return { ...base, status: 'incomplete', evidenceState: 'scenario', missingInputs: shown, errors: [], assumptions: [...assumptions, `The day series has ${gapDates.length} missing calendar date(s); gaps are not treated as consecutive days, so no water figure is produced.`], permittedPrecision: 'range_only', runs: [] };
  }

  const missingInputs: string[] = [];
  const kc = inp.days.map((d) => {
    const st = inp.stages.find((s) => s.start <= d.date && d.date <= s.end);
    if (!st) missingInputs.push(`kc:${d.date}`);
    return st?.kc ?? NaN;
  });
  const et0 = inp.days.map((d) => {
    if (d.et0Mm === null) missingInputs.push(`et0:${d.date}`);
    return d.et0Mm ?? NaN;
  });
  let usesScenario = false;
  const rainUsed = inp.days.map((d) => {
    if (d.rainState === 'missing') {
      missingInputs.push(`rain:${d.date}`);
      return null;
    }
    if (d.rainState === 'forecast' || d.rainState === 'climatology') {
      usesScenario = true;
      return inp.forecastRainPolicy === 'use_forecast' ? d.rainMm : 0;
    }
    return d.rainMm;
  });
  if (inp.days.some((d) => d.rainState === 'climatology')) {
    assumptions.push('climatology: some days use long-term normal rain, not observed or forecast values; results are a scenario.');
  }
  if (inp.days.some((d) => d.rainState === 'forecast' || d.rainState === 'climatology')) {
    assumptions.push(
      inp.forecastRainPolicy === 'use_forecast'
        ? 'Forecast rain is included as effective rain; results are a scenario, not an observation.'
        : 'Forecast rain is ignored (treated as no rain); results are a dry scenario.',
    );
  }
  if (inp.irrigationEfficiency === null) missingInputs.push('irrigationEfficiency');

  const blocking = missingInputs.filter((m) => m !== 'irrigationEfficiency');
  if (blocking.length > 0) {
    return { ...base, status: 'incomplete', evidenceState: 'scenario', missingInputs, errors: [], assumptions, permittedPrecision: 'range_only', runs: [] };
  }

  const { factors, methodByMonth } = effectiveRainFactors(inp, rainUsed);
  for (const [k, v] of [...methodByMonth].sort()) assumptions.push(`effective_rain_method:${k}=${v}`);
  const peff = rainUsed.map((r, i) => (r ?? 0) * factors[i]!);
  const fromForecast = inp.days.map((d) => (d.rainState === 'forecast' || d.rainState === 'climatology') && inp.forecastRainPolicy === 'use_forecast');
  const runs: WaterRun[] = [];
  const taw = inp.rootZone.totalAvailableWaterMm;
  if (taw !== null) {
    runs.push(runBucket(inp, kc, et0, peff, fromForecast, taw, 'confirmed_inputs', usesScenario ? 'scenario' : 'derived'));
  } else {
    missingInputs.push('rootZone.totalAvailableWaterMm');
    usesScenario = true;
    assumptions.push('Soil water capacity unknown: TAW scenarios and a no-storage scenario are shown instead of a single estimate.');
    for (const t of inp.tawScenariosMm) runs.push(runBucket(inp, kc, et0, peff, fromForecast, t, `taw_scenario_${t}mm`, 'scenario'));
    runs.push(noStorageRun(inp, kc, et0, peff, fromForecast));
  }
  const evidenceState = usesScenario ? 'scenario' : 'derived';
  return {
    ...base,
    status: missingInputs.length === 0 ? 'complete' : 'incomplete',
    evidenceState,
    missingInputs,
    errors: [],
    assumptions,
    permittedPrecision: evidenceState === 'derived' && inp.irrigationEfficiency !== null ? 'rounded_5mm' : 'range_only',
    runs,
  };
}
