import { describe, it, expect } from 'vitest';
import { loadPriorities, type Priority } from './priorities';
const id = '11111111-1111-4111-8111-111111111111';
const alerts = (farmId = id) => ({
  farmId,
  asOf: '2026-11-03',
  alerts: [],
  imdStatus: 'not_connected',
  newsReview: {
    status: 'not_run',
    reason: null,
    lastReviewedAt: null
  },
  limitations: []
});
describe('selected farm priorities', () => {
  it('keeps a failed care read distinct from an empty valid alerts list', async () => {
    let result: Priority | undefined;
    await loadPriorities(id, 2, () => true, v => {
      result = v;
    }, async part => {
      if (part === 'command-center') throw Error('offline');
      return {
        mode: 'live',
        data: alerts()
      };
    });
    expect(result).toMatchObject({
      farmId: id,
      epoch: 2,
      status: 'ready',
      alerts: [],
      alertsError: false,
      tasksError: true,
      mode: 'live'
    });
  });
  it('rejects a response for a different farm', async () => {
    let result: Priority | undefined;
    await loadPriorities(id, 0, () => true, v => {
      result = v;
    }, async () => ({
      mode: 'live',
      data: alerts('22222222-2222-4222-8222-222222222222')
    }));
    expect(result).toMatchObject({
      status: 'error',
      alertsError: true,
      tasksError: true
    });
  });
  it('does not publish private results after a selection or session change', async () => {
    let active = true;
    const published: Priority[] = [];
    await loadPriorities(id, 0, () => active, v => published.push(v), async () => {
      active = false;
      return {
        mode: 'live',
        data: alerts()
      };
    });
    expect(published).toEqual([]);
  });
});
