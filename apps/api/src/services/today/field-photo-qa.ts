import sharp from 'sharp';
import type { FieldPhotoGuidance } from '@harvest/contracts';
/** A bounded no-op/aspect check, NOT a test of agronomic or semantic accuracy. Long stage transitions cannot return the same foreground. */
export async function checkPhotoProgress(source: Uint8Array, output: Uint8Array, guidance: FieldPhotoGuidance | null) {
  const [a, b] = await Promise.all([sharp(source).metadata(), sharp(output, {limitInputPixels: 64_000_000}).metadata()]);
  if (!a.width || !a.height || !b.width || !b.height || Math.abs((b.width / b.height) / (a.width / a.height) - 1) > 0.05) return {passed: false, reason: 'image_framing_changed', difference: 0};
  const major = guidance && guidance.elapsedDays > 14 && guidance.sourceStage !== guidance.targetStage && !['generic', 'establishing'].includes(guidance.change);
  if (!major) return {passed: true, reason: null, difference: null};
  const foreground = async (bytes: Uint8Array) => sharp(bytes).resize(96, 96, {fit: 'fill'}).removeAlpha().toColourspace('srgb').extract({left: 0, top: 32, width: 96, height: 64}).raw().toBuffer();
  const [left, right] = await Promise.all([foreground(source), foreground(output)]);
  const difference = left.reduce((sum, value, i) => sum + Math.abs(value - right[i]!), 0) / left.length;
  // Engineering threshold: catches unchanged/nearly identical output; it cannot verify panicles or crop age.
  return {passed: difference >= 5, reason: difference < 5 ? 'image_did_not_progress' : null, difference};
}
