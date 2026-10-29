import { ApiError, request } from "./api";
import type { ApiWarning, Area, ComparisonRequest, ComparisonResult, CropSummary, EvidenceCitation } from "../features/comparison/types";

/** Typed client for the T06b crop routes. Public browsing: no guest session is needed (POST is origin-checked by the server). */

export async function listStates(fetchImpl?: typeof fetch): Promise<Area[]> {
  const env = await request<{ areas: Area[] }>("/api/v1/districts", undefined, fetchImpl);
  return env.data!.areas.filter((a) => a.level === "state").sort((a, b) => (a.names.en ?? a.id).localeCompare(b.names.en ?? b.id));
}

export interface DistrictList {
  districts: Area[];
  available: boolean;
  note: string | null;
}

export async function listDistricts(stateId: string, fetchImpl?: typeof fetch): Promise<DistrictList> {
  const env = await request<{ districts: Area[]; districtListAvailable: boolean; note: string | null }>(`/api/v1/districts?state=${encodeURIComponent(stateId)}`, undefined, fetchImpl);
  const d = env.data!;
  return { districts: [...d.districts].sort((a, b) => (a.names.en ?? a.id).localeCompare(b.names.en ?? b.id)), available: d.districtListAvailable, note: d.note };
}

export async function listCrops(fetchImpl?: typeof fetch): Promise<CropSummary[]> {
  const env = await request<{ crops: CropSummary[] }>("/api/v1/crops", undefined, fetchImpl);
  return env.data!.crops.map((c) => ({ cropId: c.cropId, name: c.name, products: c.products }));
}

export async function compareCrops(body: ComparisonRequest, fetchImpl?: typeof fetch): Promise<{ result: ComparisonResult; warnings: ApiWarning[]; mode: string }> {
  const env = await request<ComparisonResult>(
    "/api/v1/crop-comparisons",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    fetchImpl,
  );
  return { result: env.data!, warnings: env.warnings as unknown as ApiWarning[], mode: env.mode };
}

/** Evidence records of a crop with citations (publisher, document, page/section, URL). */
export async function getCropEvidence(cropId: string, fetchImpl?: typeof fetch): Promise<EvidenceCitation[]> {
  const env = await request<{ evidence: EvidenceCitation[] }>(`/api/v1/crops/${encodeURIComponent(cropId)}`, undefined, fetchImpl);
  return env.data!.evidence;
}

export type FailureKind = "rate_limited" | "offline" | "invalid_input" | "catalogue_unavailable" | "server";
export interface Failure {
  kind: FailureKind;
  message: string;
}

/** Maps a thrown error to a farmer-readable message. The form always stays on screen. */
export function classifyFailure(e: unknown): Failure {
  if (e instanceof ApiError) {
    if (e.status === 429 || e.code === "rate_limited") return { kind: "rate_limited", message: "Too many comparisons in a short time. Wait a minute, then press Compare again. Your answers are kept." };
    if (e.code === "network_error" || e.status === 0) return { kind: "offline", message: "Could not reach the server. Check the connection and try again. Your answers are kept." };
    if (e.status === 503) return { kind: "catalogue_unavailable", message: `The crop catalogue is not available right now (${e.message}). Try again later.` };
    if (e.status === 400 || e.status === 422) return { kind: "invalid_input", message: `The server did not accept these answers: ${e.message}` };
    return { kind: "server", message: `Comparison failed (${e.code}${e.requestId ? `, request ${e.requestId}` : ""}). Your answers are kept; try again.` };
  }
  return { kind: "server", message: "Something unexpected went wrong. Your answers are kept; try again." };
}
