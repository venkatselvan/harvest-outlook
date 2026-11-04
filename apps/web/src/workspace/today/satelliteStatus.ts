import type { NdviSeries } from '@harvest/contracts';
import { formatDay } from './model';

export function satelliteStatus(series: NdviSeries | null | undefined): string | null {
  if (!series || series.reason === 'live_mode_required') return null;
  const latest = [...series.readings].sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))[0];
  const daily = 'New satellite imagery is checked daily.';
  if (!latest) return series.status === 'unavailable' ? 'Satellite imagery is unavailable for this location right now.' : `No usable satellite image has been found yet. ${daily}`;
  const retained = series.latestUsable ? ` Last usable image: ${formatDay(series.latestUsable.date)}.` : ' No usable image is available yet.';
  const reason = latest.field.rejection === 'implausible_band_values' ? 'its image data failed quality checks'
    : latest.field.rejection === 'no_pixels' ? 'it contains no pixels for this boundary'
    : 'too few clear pixels remained over this field';
  const status = latest.usable ? `Latest usable satellite pass: ${formatDay(latest.date)}.`
    : `The satellite pass from ${formatDay(latest.date)} was fetched, but ${reason}.${retained}`;
  return `${status} ${series.reason === 'scene_catalogue_unavailable_cached_only' ? 'The latest catalogue check failed; showing saved imagery. ' : ''}${daily}`;
}
