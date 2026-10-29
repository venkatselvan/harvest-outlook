import sharp from "sharp";

export const QUALITY_METHOD = "heuristic-v1";
export type QualityIssue = "blur" | "too_dark" | "too_bright" | "low_contrast" | "too_small";

export interface ImageQuality {
  mediaId: string;
  issues: QualityIssue[];
  metrics: { meanLuma: number; lumaStdev: number; laplacianVariance: number; width: number; height: number };
}

const LAPLACIAN = { width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0] };
/** Heuristic thresholds. Not calibrated on field photos; a flag means "retake if you can", never a verdict. */
export const THRESHOLDS = { dark: 45, bright: 215, lowContrast: 18, blurVariance: 40, minSide: 480 } as const;

/** Blur and exposure checks computed in code from pixel statistics, independent of any model. */
export async function assessImage(mediaId: string, data: Uint8Array): Promise<ImageQuality> {
  const src = Buffer.from(data);
  const meta = await sharp(src).rotate().metadata();
  const small = await sharp(src, { failOn: "error" }).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).greyscale().toBuffer();
  const luma = (await sharp(small).stats()).channels[0]!;
  const lap = (await sharp(small).convolve(LAPLACIAN).stats()).channels[0]!;
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const issues: QualityIssue[] = [];
  const laplacianVariance = lap.stdev * lap.stdev;
  if (Math.min(width, height) < THRESHOLDS.minSide) issues.push("too_small");
  if (luma.mean < THRESHOLDS.dark) issues.push("too_dark");
  if (luma.mean > THRESHOLDS.bright) issues.push("too_bright");
  if (luma.stdev < THRESHOLDS.lowContrast) issues.push("low_contrast");
  if (laplacianVariance < THRESHOLDS.blurVariance) issues.push("blur");
  const r = (n: number) => Math.round(n * 100) / 100;
  return { mediaId, issues, metrics: { meanLuma: r(luma.mean), lumaStdev: r(luma.stdev), laplacianVariance: r(laplacianVariance), width, height } };
}

export function summariseQuality(per: ImageQuality[]): { method: string; issues: QualityIssue[]; perImage: ImageQuality[]; note: string } {
  const issues = [...new Set(per.flatMap((p) => p.issues))];
  return { method: QUALITY_METHOD, issues, perImage: per, note: "Computed in code from pixel statistics (heuristic, not calibrated). It does not judge the crop." };
}
