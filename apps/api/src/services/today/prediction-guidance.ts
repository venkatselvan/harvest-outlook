/**
 * Code guidance for an AI-predicted satellite look (FIELDS_MULTICROP_SOIL_SPEC.md section 11.2, 2026-11-03). Pure: from the
 * source scene date, the target date, the calendar stage at both dates, the field's index-stage phase carried to the target
 * (index-stage.ts), the latest NDVI reading, the day's field conditions (conditions.ts) and the crop name, it writes the
 * sentence that tells Meta how the field should change between the real image and the target date, plus the list of
 * inputs used. Meta only renders; every claim about the change comes from these rules.
 *
 * What the guidance never does (and tests check):
 * - it never puts an NDVI (or any index) number in the sentence; the reading is listed in `facts` only, because the image
 *   prompt must not invite the model to "draw an NDVI of 0.6";
 * - it never claims a colour change for rain or heat; those are only noted ("do not change the colours for it");
 * - it never adds anything beyond the change class: no damage, pests, lodging or yield.
 *
 * Rule order (first that applies decides the change class; each rule's basis is at the rule):
 * 1. the target is after the end of the harvest window, or the field's curve already read `harvested` -> stubble and bare soil;
 * 2. the field's own phase carried to the target: green_up/rising -> denser green; plateau -> full closed canopy;
 *    falling -> green fading to yellow-brown. The phase is observed evidence, so it wins over the calendar where both exist;
 *    `phaseForTarget` carries it only within the same calendar stage (or when harvested), otherwise the calendar decides;
 * 3. the calendar stage at the target by its name or id (FAO-56 stage definitions and the keyword classes of view.ts);
 * 4. before the recorded establishment date -> bare prepared soil;
 * 5. otherwise a generic, small change.
 */
import type {FieldConditionPoint, IndexStagePhase} from '@harvest/contracts';

export const GUIDANCE_MAX_CHARS = 400;
/** At or below this many days the guidance says the change is small (engineering choice: about one Sentinel-2 revisit). */
export const SMALL_CHANGE_DAYS = 5;

export type ChangeClass = 'after_harvest' | 'senescing' | 'full_canopy' | 'denser' | 'establishing' | 'before_sowing' | 'generic';

export interface GuidanceStage { id: string; name: string }

export interface PredictionGuidanceInput {
  /** Acquisition date of the real scene the look is edited from. */
  sourceDate: string;
  /** Date the look is for. */
  targetDate: string;
  /** Calendar stage at each date (StageTimeline via stageAt); null outside the stages. */
  sourceStage: GuidanceStage | null;
  targetStage: GuidanceStage | null;
  /** Where the target falls on the timeline (stage-timeline.ts TimelinePhase); null without a timeline. */
  targetTimeline: 'unknown' | 'before_anchor' | 'growing' | 'harvest_window' | 'after_harvest' | null;
  /** Index-stage phase carried to the target (see phaseForTarget), or null. */
  phaseAtTarget: IndexStagePhase | null;
  /** Latest usable field NDVI with its date (facts only, never in the sentence). */
  latestNdvi: {value: number; date: string} | null;
  /** The conditions point at the target date (conditions.ts), or null. */
  conditions: FieldConditionPoint | null;
  cropName: string;
}

export interface PredictionGuidance {
  guidance: string;
  facts: string[];
  change: ChangeClass;
  /** Which rule decided the change class. */
  rule: 'harvest' | 'index_phase' | 'calendar_stage' | 'before_sowing' | 'generic';
}

const DAY_MS = 86_400_000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
const norm = (s: string) => s.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const stageWords = (name: string) => (/\bstage\b/i.test(name) ? name : `${name} stage`).toLowerCase();

/**
 * The field's index-stage phase carried from the latest real scene to the target date. Basis: the phase describes the trend
 * of the curve up to the source scene (index-stage.ts); carrying it forward is an assumption that holds only while the crop
 * stays in the same calendar stage. A harvested field stays harvested. bare and unknown carry nothing (the calendar decides).
 */
export function phaseForTarget(p: {phase: IndexStagePhase | null; sourceStageId: string | null; targetStageId: string | null}): IndexStagePhase | null {
  if (!p.phase || p.phase === 'unknown' || p.phase === 'bare') return null;
  if (p.phase === 'harvested') return 'harvested';
  return p.sourceStageId !== null && p.sourceStageId === p.targetStageId ? p.phase : null;
}

/**
 * Calendar stage keyword classes, most specific first. Basis: the FAO-56 crop growth stages (FAO Irrigation and Drainage
 * Paper 56, chapter 5: initial to about 10% cover; development to effective full cover; mid-season full cover to the start
 * of maturity; late season ageing and yellowing to harvest) and the stage keyword table of view.ts (STAGE_KEYWORDS,
 * orchestrator table 2026-11-01). Crop-specific stage names are matched by these words only.
 */
const STAGE_CLASSES: readonly {change: ChangeClass; pattern: RegExp}[] = [
  {change: 'senescing', pattern: /late season|matur|ripen|harvest|senesc|grain fill|dough|drying/},
  {change: 'full_canopy', pattern: /mid season|flower|reproductive|heading|panicle|boot|silk|tassel|pod|bulking/},
  {change: 'denser', pattern: /develop|vegetative|tiller|branch|elongat|canopy|growth/},
  {change: 'establishing', pattern: /initial|establish|seedling|sprout|germinat|emergence|nursery|transplant|sowing|planting/},
];
export function stageChange(stage: GuidanceStage): ChangeClass | null {
  const text = `${norm(stage.name)} ${norm(stage.id)}`;
  return STAGE_CLASSES.find((c) => c.pattern.test(text))?.change ?? null;
}

/** The change in words for each class (no numbers). */
export const CHANGE_WORDS: Readonly<Record<ChangeClass, string>> = {
  // Rule 1. Basis: after harvest only stubble or residue and soil remain (FAO-56 late season ends at harvest).
  after_harvest: 'the crop has been harvested, so the field shows stubble and bare soil with little or no green',
  // Rule 2 falling / rule 3 late season. Basis: FAO-56 late season, ageing, yellowing or senescence of leaves.
  senescing: 'the green fades to yellow-brown as the crop ripens',
  // Rule 2 plateau / rule 3 mid-season. Basis: FAO-56 mid-season, effective full cover.
  full_canopy: 'a full, closed canopy of deep green covers the ground',
  // Rule 2 green_up and rising / rule 3 development. Basis: FAO-56 development, cover rising towards full cover.
  denser: 'the canopy fills in, so the field turns a denser, more uniform green with less bare soil between the rows',
  // Rule 3 initial. Basis: FAO-56 initial stage, less than about 10% of the ground covered.
  establishing: 'mostly soil with small young plants, only a little green',
  // Rule 4. Basis: no crop is recorded on the field before the establishment date.
  before_sowing: 'the soil is bare and prepared for the crop',
  // Rule 5. No basis for a specific change: keep the look close to the real image.
  generic: 'the field changes only slightly from the real image',
};

const HEAVY: ReadonlySet<string> = new Set(['heavy', 'very_heavy', 'extremely_heavy']);

export function buildPredictionGuidance(i: PredictionGuidanceInput): PredictionGuidance {
  const days = Math.max(0, dayDiff(i.sourceDate, i.targetDate));
  const facts: string[] = [
    `Real image date: ${i.sourceDate}`,
    `Target date: ${i.targetDate} (${days} day${days === 1 ? '' : 's'} later)`,
    `Calendar stage at the real image: ${i.sourceStage?.name ?? 'none'}`,
    `Calendar stage at the target: ${i.targetStage?.name ?? (i.targetTimeline === 'after_harvest' ? 'after the harvest window' : i.targetTimeline === 'before_anchor' ? 'before establishment' : 'none')}`,
    `Satellite curve phase carried to the target: ${i.phaseAtTarget ?? 'not used'}`,
    // Facts only: this number never enters the guidance sentence or the prompt.
    i.latestNdvi ? `Latest field NDVI: ${i.latestNdvi.value} on ${i.latestNdvi.date} (not used in the image prompt)` : 'Latest field NDVI: none',
  ];

  let change: ChangeClass;
  let rule: PredictionGuidance['rule'];
  const calendar = i.targetStage ? stageChange(i.targetStage) : null;
  if (i.targetTimeline === 'after_harvest' || i.phaseAtTarget === 'harvested') { change = 'after_harvest'; rule = 'harvest'; }
  else if (i.phaseAtTarget === 'green_up' || i.phaseAtTarget === 'rising') { change = 'denser'; rule = 'index_phase'; }
  else if (i.phaseAtTarget === 'plateau') { change = 'full_canopy'; rule = 'index_phase'; }
  else if (i.phaseAtTarget === 'falling') { change = 'senescing'; rule = 'index_phase'; }
  else if (calendar) { change = calendar; rule = 'calendar_stage'; }
  else if (i.targetTimeline === 'harvest_window') { change = 'senescing'; rule = 'calendar_stage'; }
  else if (i.targetTimeline === 'before_anchor') { change = 'before_sowing'; rule = 'before_sowing'; }
  else { change = 'generic'; rule = 'generic'; }
  facts.push(`Rule applied: ${rule.replace(/_/g, ' ')} (${change.replace(/_/g, ' ')})`);

  const crop = i.cropName.trim().toLowerCase() || 'crop';
  const where = change === 'after_harvest' ? `after the ${crop} harvest`
    : i.targetStage ? `in the ${stageWords(i.targetStage.name)} of ${crop}` : `in this ${crop} field`;
  const parts: string[] = [`${days} day${days === 1 ? '' : 's'} after the real image, ${where}: ${CHANGE_WORDS[change]}.`];
  if (days <= SMALL_CHANGE_DAYS && change !== 'after_harvest') parts.push('The change is small.');

  const c = i.conditions;
  if (c) {
    facts.push(`Water on the target date: ${c.water.state} (${c.water.basis.replace(/_/g, ' ')})`);
    facts.push(`Rain on the target date: ${c.rain.class.replace(/_/g, ' ')}${c.rain.mm !== null ? ` (${c.rain.mm} mm, ${c.kind})` : ''}`);
    if (c.heat.tMaxC !== null) facts.push(`Maximum temperature on the target date: ${c.heat.tMaxC} C${c.heat.stress ? ' (heat stress)' : ''}`);
    // Basis: the sourced standing-water practice (conditions.ts, TNAU paddy) keeps water on the field in this period; a
    // rain-rule `ponded` state is inferred from rain only and is treated as rain below, not drawn.
    if (c.water.state === 'flooded' && c.water.basis === 'crop_practice' && change !== 'after_harvest' && change !== 'before_sowing') {
      parts.push('Standing water is visible between the rows.');
    }
    // Noted without a colour claim: one day of rain or heat has no sourced effect on what the canopy looks like from above.
    if (HEAVY.has(c.rain.class) || (c.water.state === 'ponded' && c.water.basis === 'rain_rule')) parts.push('With heavy rain around that date; do not change the colours for it.');
    if (c.heat.stress) parts.push('With hot weather around that date; do not change the colours for it.');
  } else {
    facts.push('Field conditions on the target date: not available');
  }

  let guidance = parts.join(' ');
  if (guidance.length > GUIDANCE_MAX_CHARS) guidance = `${guidance.slice(0, GUIDANCE_MAX_CHARS - 1).trimEnd()}…`;
  return {guidance, facts: facts.map((f) => f.slice(0, 200)), change, rule};
}
