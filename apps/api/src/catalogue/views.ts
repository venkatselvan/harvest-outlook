import type { CoverageRecord } from "@harvest/contracts";
import type { CatalogueSnapshot } from "./snapshot";

const CAPS = ["screening_supported", "historical_reference_available", "forecast_evaluated", "visual_journey_supported", "observation_interpretation_experimental"] as const;
const emptyCounts = () => ({ supported: 0, partial: 0, unsupported: 0, unknown: 0 });

export function coverageSummary(records: CoverageRecord[]) {
  const out: Record<string, ReturnType<typeof emptyCounts>> = {};
  for (const c of CAPS) out[c] = emptyCounts();
  for (const r of records) out[r.capability]![r.supportStatus]++;
  return out;
}

export function buildCropSummaries(snap: CatalogueSnapshot) {
  return snap.profiles.map((p) => {
    const identity = snap.identities.find((i) => i.id === p.cropId);
    const cov = snap.coverage.filter((c) => c.cropId === p.cropId);
    const rules = snap.rules.filter((r) => r.rule.cropId === p.cropId);
    return {
      cropId: p.cropId,
      name: identity?.commonNames[0]?.text ?? p.cropId,
      botanicalName: identity?.botanicalName ?? null,
      group: p.group,
      localNames: (identity?.aliases ?? []).filter((a) => a.kind === "local" || a.kind === "market").map((a) => a.text),
      qualified: p.qualification.qualified,
      products: p.products,
      regions: [...new Set(p.regionalContexts.flatMap((c) => c.geography.ids))].sort(),
      seasons: [...new Set(p.regionalContexts.map((c) => c.season))].sort(),
      marketCoverageStatus: p.marketCoverageStatus,
      rules: { approved: rules.filter((r) => r.rule.reviewStatus === "approved").length, candidate: rules.filter((r) => r.rule.reviewStatus === "candidate").length },
      coverage: coverageSummary(cov),
      evidenceCount: p.evidenceIds.length,
    };
  });
}

export function buildCropDetail(snap: CatalogueSnapshot, cropId: string) {
  const p = snap.profiles.find((x) => x.cropId === cropId);
  if (!p) return null;
  const identity = snap.identities.find((i) => i.id === cropId) ?? null;
  const evidenceIds = new Set<string>(p.evidenceIds);
  const rules = snap.rules.filter((r) => r.rule.cropId === cropId);
  for (const r of rules) r.rule.evidenceIds.forEach((e) => evidenceIds.add(e));
  const evidence = [...evidenceIds].flatMap((id) => {
    const e = snap.evidence.get(id);
    if (!e) return [];
    return [{
      id: e.id, excerpt: e.content.kind === "excerpt" ? e.content.text : null, locator: e.locator, citation: { publisher: e.publisher, documentTitle: e.documentTitle, documentVersion: e.documentVersion, sourceUrl: e.sourceUrl, contentHash: e.contentHash },
      geography: e.geography, validationStatus: e.validationStatus, effectiveAvailableAt: e.availability.effectiveAvailableAt, licence: { accessStatus: e.licence.accessStatus, redistributable: e.licence.redistributable },
    }];
  });
  return {
    identity,
    profile: p,
    rules: rules.map((r) => ({ id: r.rule.id, reviewStatus: r.rule.reviewStatus, reviewer: r.reviewer, sourceId: r.sourceId, effect: r.rule.effect, scope: r.rule.scope, hasExceptions: r.rule.exceptions.length > 0, evidenceIds: r.rule.evidenceIds })),
    stages: snap.stages.filter((s) => s.cropId === cropId).map((s) => ({ id: s.id, stageId: s.stageId, order: s.order, scope: s.scope, durationDays: s.durationDays, reviewStatus: s.reviewStatus })),
    evidence,
    coverage: coverageSummary(snap.coverage.filter((c) => c.cropId === cropId)),
  };
}

export function coverageFor(snap: CatalogueSnapshot, cropId: string) {
  if (!snap.profiles.some((p) => p.cropId === cropId)) return null;
  const records = snap.coverage.filter((c) => c.cropId === cropId);
  return { cropId, records, summary: coverageSummary(records) };
}

export function listAreas(snap: CatalogueSnapshot, state?: string) {
  const pick = (a: CatalogueSnapshot["areas"][number]) => ({ id: a.id, level: a.level, stateId: a.stateId, names: a.names, validationStatus: a.validationStatus });
  if (state) {
    const st = snap.areas.find((a) => a.id === state && a.level === "state");
    const districts = snap.areas.filter((a) => a.level === "district" && a.stateId === state);
    return { state: st ? pick(st) : null, districts: districts.map(pick), districtListAvailable: districts.length > 0, note: districts.length ? null : "No sourced district list for this state yet; use state-level screening." };
  }
  return { areas: snap.areas.filter((a) => a.level !== "district").map(pick), statesWithDistrictLists: [...new Set(snap.areas.filter((a) => a.level === "district").map((a) => a.stateId))] };
}
