import {describe, expect, it} from 'vitest';
import sharp from 'sharp';
import {stageAt, stageTimeline} from '../src/services/today/stage-timeline';
import {buildPhotoGuidance, photoWeatherCue} from '../src/services/today/field-photo-guidance';
import {checkPhotoProgress} from '../src/services/today/field-photo-qa';
import type {WeatherTrackDay} from '../src/services/today/weather-track';
import type {WeatherAgro} from '@harvest/contracts';

const timeline = stageTimeline({cropId: 'paddy', productId: 'paddy-grain', establishmentMethod: 'direct_sowing', anchorDate: '2026-10-31', stateId: 'IN-KA', districtId: 'IN-KA-hassan'});
const day = (kind: WeatherTrackDay['kind'], rainMm: number | null, sun: number | null = null): WeatherTrackDay => ({date: '2027-02-27', kind, rainMm, tMinC: 18, tMaxC: 28, basis: {source: 'weather-test', issuedAt: kind === 'forecast' ? '2027-02-25T06:00:00Z' : null, years: kind === 'typical' ? [2024,2025] : null}, agro: {sunshineHours: sun} as WeatherAgro});
const build = (weather = day('typical', 0.2), targetDate = '2027-02-27') => buildPhotoGuidance({cropId: 'paddy', cropName: 'Paddy', sourceDate: '2026-11-03', targetDate, timeline,
  context: {sourcePhase: null, latestNdvi: null, conditionsAt: () => null}, weather: {days: [{...weather, date: targetDate}], forecastHorizonEnd: '2026-11-15', limitations: []}, condition: null});

describe('ground-photo growth and weather guidance', () => {
  it('reproduces the reported 116-day rice error: harvest window wins over the generic mid-season block', () => {
    expect(stageAt(timeline, '2027-02-27').stage?.name).toBe('Mid-season');
    const result = build();
    expect(result.guidance).toMatchObject({targetStage: 'Ripening / estimated harvest window', elapsedDays: 116, targetAgeDays: 119, change: 'senescing'});
    expect(result.prompt).toContain('grain-filled panicles arching and drooping');
    expect(result.prompt).toContain('yellow to straw-gold');
    expect(result.prompt).toContain('not sparse young green tufts');
  });
  it('does not force golden harvest-ready rice at an earlier full-canopy date', () => {
    const result = build(day('typical', 0.2), '2027-01-11');
    expect(result.guidance.change).toBe('full_canopy');
    expect(result.prompt).toContain('Tall, dense rice');
    expect(result.prompt).toContain('do not invent ripe golden grain');
  });
  it('changes sky and lighting from forecast evidence while locking camera and landscape geometry', () => {
    expect(photoWeatherCue(day('forecast', 12)).instruction).toContain('visible rain streaks');
    expect(photoWeatherCue(day('forecast', 0, 8)).instruction).toContain('mostly clear sky');
    expect(photoWeatherCue(day('forecast', 0, 1)).instruction).toContain('cloud-filtered daylight');
    expect(photoWeatherCue(day('forecast', 0)).instruction).toContain('Do not equate low rainfall');
    const prompt = build(day('forecast', 12)).prompt;
    expect(prompt).toContain('Sky/clouds, illumination, reflections and shadows MUST be allowed to change');
    expect(prompt).toContain('identical image dimensions/aspect ratio');
    expect(prompt).toContain('No zoom, crop, camera movement');
  });
  it('never turns climatological rain into definite rain on a particular future date', () => {
    const typical = photoWeatherCue(day('typical', 12));
    expect(typical.instruction).toContain('not rain predicted on this date');
    expect(typical.instruction).not.toContain('rain streaks');
    expect(build().guidance.weather.kind).toBe('typical');
    expect(build().guidance.limitations.join(' ')).toContain('beyond the weather forecast');
    expect(photoWeatherCue(null).instruction).toContain('do not invent rain');
  });
  it('uses the photo date as the starting reference without resetting crop age, and labels weather coverage gaps', () => {
    const result = build();
    expect(result.prompt).toContain('photo date is NOT a new sowing date');
    expect(result.guidance.interval).toMatchObject({typicalDays: 1, observedDays: 0, forecastDays: 0, missingDays: 115});
    expect(result.prompt).toContain('not all observed');
  });
  it('rejects a near-copy for a major stage transition and rejects changed framing', async () => {
    const source = await sharp({create: {width: 80, height: 100, channels: 3, background: '#258725'}}).png().toBuffer();
    const grown = await sharp({create: {width: 80, height: 100, channels: 3, background: '#b5ad3a'}}).png().toBuffer();
    const cropped = await sharp(grown).resize(100, 80).toBuffer();
    expect(await checkPhotoProgress(source, source, build().guidance)).toMatchObject({passed: false, reason: 'image_did_not_progress'});
    expect(await checkPhotoProgress(source, grown, build().guidance)).toMatchObject({passed: true});
    expect(await checkPhotoProgress(source, cropped, build().guidance)).toMatchObject({passed: false, reason: 'image_framing_changed'});
    expect(await checkPhotoProgress(source, source, {...build().guidance, elapsedDays: 2})).toMatchObject({passed: true});
  });
});
