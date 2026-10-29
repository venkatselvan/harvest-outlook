import type { Pt } from "../../lib/geometry";

export interface MediaInfo {
  id: string;
  farmId: string | null;
  exifOrientation: number | null;
  orientedWidth: number;
  orientedHeight: number;
  normalized: { width: number; height: number; bytes: number; contentType: "image/jpeg" };
  contentPath: string;
  region: { polygon: Pt[]; source: "manual" | "sam_confirmed"; transform: { orientationApplied: boolean; normalizedWidth: number; normalizedHeight: number }; version: number } | null;
}

export type RegionSource = "manual" | "sam_confirmed";

export const normalizedUrl = (id: string): string => `/api/v1/media/${id}/content?variant=normalized`;

export const FIELD_OUTLINE_NOTE = "A photo outline is not a surveyed field boundary.";
export const AI_LABEL = "AI suggestion — illustrative outline, confirm or correct";
