import {describe, expect, it} from 'vitest';
import {cycleInYear, recordedBar, recordedForField, recordedStage} from './recordedRotation';
import type {Cycle} from '../state';
const cycle: Cycle = {id: 'current', cropId: 'paddy', fieldId: 'north', sowingDate: '2026-11-01', stage: 'sowed'};
describe('recorded crops in the rotation board', () => {
  it('scopes current crops to their field and keeps whole-farm records', () => {
    const {fieldId: _fieldId, ...wholeFarm} = cycle;
    const whole = {...wholeFarm, id: 'whole'};
    const south = {...cycle, id: 'south', fieldId: 'south'};
    expect(recordedForField([cycle, south, whole], 'north').map(c => c.id)).toEqual(['current','whole']);
    expect(recordedForField([cycle, south], null)).toHaveLength(2);
  });
  it('clips cross-year crops to each calendar year and labels the actual stage', () => {
    const c = {...cycle, harvestDate: '2027-03-01'};
    expect(cycleInYear(c, 2026)).toBe(true);
    expect(cycleInYear(c, 2027)).toBe(true);
    expect(cycleInYear(c, 2028)).toBe(false);
    expect(recordedBar(c, 2027).left).toBe(0);
    expect(recordedBar(c, 2027).width).toBeLessThan(20);
    expect(recordedStage(c)).toBe('Sown');
  });
  it('does not invent a harvest date for a crop still growing', () => {
    expect(cycleInYear(cycle, 2027)).toBe(true);
    expect(recordedBar(cycle, 2026).left + recordedBar(cycle, 2026).width).toBe(100);
    expect(cycleInYear({...cycle, stage: 'harvested'}, 2027)).toBe(false);
  });
});
