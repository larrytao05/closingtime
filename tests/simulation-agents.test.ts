import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSimulationDecisionRequest, chooseSimulationDecision } from '../src/simulation/agent-api';
import { SimulationScheduler, SimulationRateLimitError } from '../src/simulation/scheduler';

const request = (patch: Record<string, unknown> = {}) => ({
  runId: 'run-1', requestId: 'request-1', generation: 1, actorId: 'jo', observedRevision: 7,
  observation: { actorId: 'jo', activeTimeMs: 4000, revision: 7, selfPosition: { x: 1, y: 1 },
    visibleActors: [{ actorId: 'mara', position: { x: 2, y: 1 } }],
    visibleObjects: [{ objectId: 'mug1', location: { surface: 'table' }, wetness: 0 }],
    windowOpen: true, rainExposureMs: 0 },
  witnessedEvents: [{ runId: 'run-1', sequence: 3, activeTimeMs: 3900,
    payload: { type: 'movement-tile-committed', actorId: 'mara', from: { x: 2, y: 2 }, to: { x: 2, y: 1 } } }],
  options: [{ actionId: 'walk-1', action: { type: 'walk', to: { x: 1, y: 2 } } }, { actionId: 'speak-1', action: { type: 'speak', recipient: 'mara' } }],
  recall: { actorId: 'jo', records: [{ id: 'mem-1', kind: 'observation', owner: 'jo', sourceEventIds: ['run-1:2'], text: 'Mara moved by the table.', activeTimeMs: 3000 }], retrievedMemoryIds: ['mem-1'] },
  ...patch,
});

test('strictly reads actor-local simulation requests and rejects cross-actor or shadow fields', () => {
  const parsed = readSimulationDecisionRequest(request());
  assert.equal(parsed?.actorId, 'jo');
  assert.equal(readSimulationDecisionRequest(request({ actorId: 'player' })), undefined);
  const shadow = request();
  (shadow.observation as Record<string, unknown>).wholeWorld = { dialogue: ['private'] };
  assert.equal(readSimulationDecisionRequest(shadow), undefined);
  const badAction = request({ options: [{ actionId: 'x', action: { type: 'walk', to: { x: 99, y: 99 } } }] });
  assert.equal(readSimulationDecisionRequest(badAction), undefined);
});

test('provider projection sent for Jo contains only witnessed local fields and validates selected option', async () => {
  const oldFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    sent = JSON.parse(body.contents[0].parts[0].text);
    return Response.json({ modelVersion: 'fixture-model', candidates: [{ content: { parts: [{ text: JSON.stringify({ actionId: 'speak-1', reply: 'I saw you move over.', rationale: 'Mara is nearby.', memoryProposals: [] }) }] } }] });
  };
  try {
    const parsed = readSimulationDecisionRequest(request());
    assert.ok(parsed);
    const reply = await chooseSimulationDecision(parsed, { GEMINI_API_KEY: 'fixture-only' }, new AbortController().signal);
    assert.equal(reply.actionId, 'speak-1');
    assert.deepEqual(Object.keys(sent!).sort(), ['actorId','activeTimeMs','options','rainExposureMs','recall','revision','selfPosition','visibleActors','visibleObjects','windowOpen','witnessedEvents'].sort());
    assert.equal(JSON.stringify(sent).includes('wholeWorld'), false);
    assert.equal(JSON.stringify(sent).includes('afterCheckpoint'), false);
    assert.equal((sent!.recall as { records: { sourceEventIds: string[] }[] }).records[0].sourceEventIds[0], 'run-1:2');
    assert.equal((sent!.recall as { actorId: string }).actorId, 'jo');
    globalThis.fetch = async () => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ actionId: 'other', reply: null, rationale: 'bad', memoryProposals: [] }) }] } }] });
    await assert.rejects(() => chooseSimulationDecision(parsed, { GEMINI_API_KEY: 'fixture-only' }, new AbortController().signal), /invalid-response/);
  } finally { globalThis.fetch = oldFetch; }
});

test('scheduler rotates fairly, caps scene starts, and coalesces one pending reason per actor', async () => {
  let now = 0;
  const active: { actor: string; resolve: () => void }[] = [];
  const started: string[] = [];
  const scheduler = new SimulationScheduler({ now: () => now, deadlineMs: 5000, startDecision: (actor, reason) => {
    started.push(`${actor}:${reason}`);
    return new Promise<void>(resolve => active.push({ actor, resolve }));
  } });
  scheduler.wake('mara', 'ambient'); scheduler.wake('mara', 'player-spoke');
  scheduler.wake('riley', 'ambient'); scheduler.wake('jo', 'ambient');
  assert.deepEqual(started, ['mara:ambient', 'riley:ambient']);
  active[0].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(started[2], 'jo:ambient');
  active[1].resolve(); active[2].resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(started[3], 'mara:player-spoke');
  scheduler.cancelAll('test end'); scheduler.dispose();

  const capStarts: string[] = [];
  const cap = new SimulationScheduler({ now: () => now, startDecision: async (actor, reason) => { capStarts.push(`${actor}:${reason}`); } });
  for (let i = 0; i < 15; i++) {
    cap.wake((['mara','riley','jo'] as const)[i % 3], `external-${i}`);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(capStarts.length, 12);
  cap.cancelAll('stop capped burst'); cap.dispose();
});

test('scheduler retries a rate-limited start after a global backoff and cancels deadlines', async () => {
  let now = 0; let calls = 0;
  const scheduler = new SimulationScheduler({ now: () => now, deadlineMs: 5, startDecision: async () => {
    calls++;
    if (calls === 1) throw new SimulationRateLimitError(20);
    return new Promise<void>(() => {}); // ignores cancellation, as some transports do
  } });
  scheduler.wake('mara', 'external');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  scheduler.cancelAll('discard request');
  scheduler.wake('jo', 'external');
  await new Promise(resolve => setTimeout(resolve, 10));
  now = 30;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls, 2);
  scheduler.pause(); scheduler.wake('riley', 'external');
  assert.equal(calls, 2);
  scheduler.dispose();
});

test('scheduler releases an in-flight slot at its deadline when a provider ignores abort', async () => {
  const started: string[] = []; const signals: AbortSignal[] = [];
  const scheduler = new SimulationScheduler({ now: () => Date.now(), deadlineMs: 10, startDecision: (actor, _reason, signal) => {
    started.push(actor); signals.push(signal); return new Promise<void>(() => {});
  } });
  scheduler.wake('mara', 'external'); scheduler.wake('riley', 'external'); scheduler.wake('jo', 'external');
  assert.deepEqual(started, ['mara', 'riley']);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(started, ['mara', 'riley', 'jo']);
  assert.equal(signals[0].aborted, true);
  scheduler.cancelAll('test complete'); scheduler.dispose();
});
