import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FarmAlerts } from '@harvest/contracts';
import { migrate } from '../src/db/migrate';
import { listAlerts, persistAlerts } from '../src/services/today/alerts';
import { farmBody, login, setupHarness, type Harness } from './helpers';

/**
 * Migration 0038_farm_alerts_field.sql applied to a database that already holds farm_alerts rows. The harness migrates
 * everything; the test then restores the exact pre-0038 shape (no field_id column, no index, no migration record), inserts
 * rows, and runs the project's migration runner so only 0038 applies over them. SYNTHETIC rows.
 */
let h: Harness;
beforeAll(async () => { h = await setupHarness(); }, 60_000);
afterAll(async () => h?.close());

describe('0038_farm_alerts_field', () => {
  it('applies over existing farm_alerts rows: they stay farm-wide (field_id NULL), list unchanged, and new rows can name a field', async () => {
    const owner = await login(h.app);
    const farmId = (await owner.call('POST', '/api/v1/farms', { payload: farmBody({ facts: {} }) })).json().data.id as string;
    const ownerId = (await h.pool.query<{ owner_id: string }>('SELECT owner_id FROM farms WHERE id=$1', [farmId])).rows[0]!.owner_id;

    // Back to the 0037 shape.
    await h.pool.query(`
      DROP INDEX farm_alerts_farm_field;
      ALTER TABLE farm_alerts DROP COLUMN field_id;
      DELETE FROM schema_migrations WHERE name = '0038_farm_alerts_field.sql';`);
    expect((await h.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name='farm_alerts' AND column_name='field_id'")).rowCount).toBe(0);
    const insert = (title: string, fp: string, validTo: string) => h.pool.query(
      `INSERT INTO farm_alerts (owner_id, farm_id, mode, type, severity, origin, title, detail, source, valid_from, valid_to, suggested_step, fingerprint)
       VALUES ($1,$2,'synthetic','weather','watch','rule',$3,'Synthetic pre-migration alert.',$4::jsonb,'2026-10-30',$5::date,NULL,$6)`,
      [ownerId, farmId, title, JSON.stringify({ name: 'Open-Meteo', url: 'https://open-meteo.com/', date: '2026-10-30' }), validTo, fp]);
    await insert('Heavy rain in the forecast', 'fp-old-1', '2026-12-31');
    await insert('Heat in the forecast', 'fp-old-2', '2026-12-31');

    expect(await migrate(h.pool, undefined, () => undefined)).toEqual(['0038_farm_alerts_field.sql']);
    expect(await migrate(h.pool, undefined, () => undefined)).toEqual([]); // applied once

    const old = (await h.pool.query<{ title: string; field_id: string | null }>('SELECT title, field_id FROM farm_alerts WHERE farm_id=$1 ORDER BY title', [farmId])).rows;
    expect(old).toEqual([{ title: 'Heat in the forecast', field_id: null }, { title: 'Heavy rain in the forecast', field_id: null }]);
    // The old rows list as farm-wide alerts, with and without a field filter on a farm.
    const listed = FarmAlerts.parse(await listAlerts(h.pool, ownerId, farmId, 'synthetic', '2026-11-01T06:00:00Z'));
    expect(listed.alerts.map((a) => [a.title, a.scope, a.fieldId ?? null]).sort()).toEqual([['Heat in the forecast', 'farm', null], ['Heavy rain in the forecast', 'farm', null]]);
    // The unique key still holds, and new rows can name a field (not a foreign key: fields live in the workspace JSON).
    await expect(insert('Duplicate', 'fp-old-1', '2026-12-31')).rejects.toMatchObject({ code: '23505' });
    expect(await persistAlerts(h.pool, ownerId, farmId, 'synthetic', [{ type: 'crop_threat', severity: 'watch', origin: 'rule', title: 'Fall armyworm scouting window', detail: 'x', source: { name: 'Guide', url: 'https://example.test/g', date: '2026-10-20' }, validFrom: '2026-10-26', validTo: '2026-12-15', suggestedStep: null, fieldId: 'west' }])).toEqual({ inserted: 1, updated: 0 });
    expect((await h.pool.query<{ field_id: string }>("SELECT field_id FROM farm_alerts WHERE type='crop_threat' AND farm_id=$1", [farmId])).rows).toEqual([{ field_id: 'west' }]);
    // The column rejects an empty or overlong id, and its index exists.
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    expect(await code(h.pool.query("UPDATE farm_alerts SET field_id='' WHERE farm_id=$1 AND type='crop_threat'", [farmId]))).toBe('23514');
    expect(await code(h.pool.query("UPDATE farm_alerts SET field_id=$2 WHERE farm_id=$1 AND type='crop_threat'", [farmId, 'x'.repeat(121)]))).toBe('23514');
    expect((await h.pool.query("SELECT indexdef FROM pg_indexes WHERE indexname='farm_alerts_farm_field'")).rows[0].indexdef).toMatch(/\(farm_id, field_id\)/);
  });
});
