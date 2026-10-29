# Crop catalogue profiles (T06a)

One JSON per crop (`<cropId>.json`), built by `scripts/catalogue/build.ts` from `scripts/catalogue/authoring.ts` and the saved pages in `data/raw/crops/` (gitignored). Evidence is in `data/curated/crop-evidence/<cropId>.json` (EvidenceRecord, excerpt <= 60 words, verified verbatim against the saved page text).

Schema (zod, `scripts/catalogue/profile-schema.ts`): `cropId, identityRef, group, products[], regionalContexts[], exclusionsOrCautions[], marketCoverageStatus ('unavailable_pending_price_access' for all), evidenceIds[], qualification{...}`.
Each regional context: `geography{level,ids}`, `stateId` (single state or null), `districtIds` (null = state level; zone/district text kept in `notes`), `season`, `plantingWindow{fromMonth,toMonth,evidenceIds}` (a window may wrap the year; months refer to sowing/planting as stated), `durationDays{min,max}` (null bound = only one bound published), `irrigation` (adds `unspecified` where the page does not say) with `irrigationEvidenceIds`, `waterNeedClass` (null = unknown everywhere; no sourced class thresholds), `soilNotes`, `yieldReference` (kg/ha, `regional_reference`, varietal figures converted from q/ha or t/ha), `labourClass` (null), `harvestPattern`, `notes`.

Notes: `season` (kharif/rabi/zaid) is assigned by the catalogue from the sourced sowing months, not quoted. TN-derived contexts carry stateId TN only. Qualification: >= 1 context, season window sourced, and >= 2 of duration/soil/irrigation/yield sourced in one context. All evidence is `validationStatus: pending` (excerpt presence machine-checked; meaning not human-reviewed). Botanical names are standard taxonomy (23/25 also appear on a saved page; pearl-millet and cotton do not).

Rebuild: `packages/contracts/node_modules/.bin/tsx scripts/catalogue/build.ts` then `.../validate.ts`.
