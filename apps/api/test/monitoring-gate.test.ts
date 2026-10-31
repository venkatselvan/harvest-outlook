import { expect, it } from 'vitest';
import { evaluateGate, type GateContext, type StoredToolResult } from '../src/agent/gate';

it('permits a sourced monitoring forecast and still rejects market or missing evidence for rain claims', () => {
  const context: GateContext = { ownerId: 'o', mode: 'live', agentRunId: 'r', asOf: '2026-10-30T06:00:00Z', language: 'en', claimScope: { geographyIds: [], cropIds: [] }, userText: '', rainHorizonDays: 7 };
  const record = { kind: 'quantity', value: 12, unit: 'mm', evidenceState: 'forecast' };
  const run = (evidenceState: string, refs = true) => {
    const stored: StoredToolResult = { id: 't', ownerId: 'o', runMode: 'live', agentRunId: 'r', status: 'ok', toolName: 'get_farm_context', result: { farm: { monitoring: { references: [{ ...record, evidenceState }] } } } };
    const raw = { schemaVersion: '1.0', intent: 'plan_question', language: 'en', proposedFacts: [], clarifications: [], toolRequests: [], answerBlocks: [{ id: 'b', kind: 'numeric', text: 'Forecast rain this week will be 12 mm.', numericRefIds: refs ? ['n'] : [], claimIds: [] }], numericRefs: refs ? [{ id: 'n', toolResultId: 't', jsonPointer: '/farm/monitoring/references/0/value', presentation: { unit: 'mm', sourceUnit: 'mm', rounding: { mode: 'decimals', digits: 0 }, intervalLabel: 'none' } }] : [], claimEvidenceRefs: [], limitations: [] };
    return evaluateGate(raw, context, { toolResults: new Map([['t', stored]]), evidence: new Map() });
  };
  expect(run('forecast').status).toBe('approved');
  expect(run('observed').status).toBe('correction_requested');
  expect(run('forecast', false).status).toBe('correction_requested');
});
