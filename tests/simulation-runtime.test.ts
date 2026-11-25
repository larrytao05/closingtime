import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DurableState, SimulationSaveStorage } from '../src/simulation/save';
import { SimulationSaveStore } from '../src/simulation/save';
import { SimulationRuntime } from '../src/simulation/runtime';

class MemoryStorage implements SimulationSaveStorage {
  value: DurableState | null = null;
  async readOnly<T>(read: (current: DurableState | null) => T): Promise<T> { return read(structuredClone(this.value)); }
  async readWrite<T>(update: (current: DurableState | null) => { next: DurableState | null; result: T }): Promise<T> {
    const updated = update(structuredClone(this.value)); this.value = structuredClone(updated.next); return updated.result;
  }
}

const tick = async () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean, limit = 40): Promise<void> {
  for (let i = 0; i < limit && !predicate(); i++) await tick();
  assert.ok(predicate(), 'expected runtime state did not arrive');
}
function runtimeOptions(store: SimulationSaveStore, fetch: typeof globalThis.fetch, onUpdate?: () => void) {
  return { saveStore: store, fetch, onUpdate, frameIntervalMs: 10_000, checkpointIntervalMs: 10_000,
    ambientIntervalMs: 10_000, endpoint: '/api/simulation', now: () => Math.floor(performance.now()) };
}

test('runtime sends same-origin actor-local requests and commits an NPC speech response', async () => {
  const store = new SimulationSaveStore(new MemoryStorage());
  const calls: { url: string; request: any }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = JSON.parse(String(init?.body));
    calls.push({ url: String(input), request });
    const speech = request.options.find((option: any) => option.action.type === 'speak' && option.action.recipient === 'player');
    assert.ok(speech);
    return Response.json({ runId: request.runId, requestId: request.requestId, generation: request.generation,
      actorId: request.actorId, actionId: speech.actionId, reply: 'I can take a look.', rationale: 'The player addressed Mara.' });
  };
  const runtime = await SimulationRuntime.start(runtimeOptions(store, fetcher));
  runtime.join();
  const result = runtime.action('player', { type: 'speak', recipient: 'mara' }, 'Mara, can you check the papers?');
  assert.equal(result.status, 'committed');
  runtime.wake('mara', 'player spoke');
  await until(() => runtime.snapshot().audit.entries.some(entry => entry.kind === 'decision'));
  assert.equal(calls[0].url, '/api/simulation');
  assert.equal(calls[0].request.actorId, 'mara');
  assert.equal('wholeWorld' in calls[0].request, false);
  assert.ok(runtime.snapshot().audit.entries.some(entry => entry.kind === 'committed-event' && entry.event.payload.type === 'speech' && entry.event.payload.actorId === 'mara'));
  await runtime.dispose();
});

test('held inference does not block player actions; pause terminalizes once and ignores a late response', async () => {
  const store = new SimulationSaveStore(new MemoryStorage());
  let resolveFetch!: (value: Response) => void;
  let seenSignal: AbortSignal | null = null;
  let request: any;
  const fetcher: typeof fetch = (input, init) => {
    assert.equal(String(input), '/api/simulation');
    seenSignal = init?.signal as AbortSignal;
    request = JSON.parse(String(init?.body));
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  const runtime = await SimulationRuntime.start(runtimeOptions(store, fetcher));
  runtime.join();
  runtime.wake('riley', 'fixture');
  await until(() => !!request);
  assert.equal(seenSignal?.aborted, false);
  assert.equal(runtime.action('player', { type: 'speak' }, 'I am still here.').status, 'committed');
  await runtime.pause();
  assert.equal(seenSignal?.aborted, true);
  const decisions = runtime.snapshot().audit.entries.filter(entry => entry.kind === 'decision');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind === 'decision' ? decisions[0].outcome : '', 'cancelled');
  const stale = request.options.find((option: any) => option.action.type === 'wait');
  resolveFetch(Response.json({ runId: request.runId, requestId: request.requestId, generation: request.generation,
    actorId: request.actorId, actionId: stale.actionId, rationale: 'Late response.' }));
  await tick();
  assert.equal(runtime.snapshot().audit.entries.filter(entry => entry.kind === 'decision').length, 1);
  assert.equal(runtime.snapshot().audit.entries.filter(entry => entry.kind === 'committed-event' && entry.event.payload.type === 'room-interaction').length, 0);
  await runtime.dispose();
});

test('deadline gives an unresolved transport one failed terminal audit result', async () => {
  const store = new SimulationSaveStore(new MemoryStorage());
  let resolveFetch!: (value: Response) => void;
  let request: any;
  const fetcher: typeof fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  const runtime = await SimulationRuntime.start({ ...runtimeOptions(store, fetcher), decisionDeadlineMs: 10 });
  runtime.wake('jo', 'fixture timeout');
  await until(() => runtime.snapshot().audit.entries.some(entry => entry.kind === 'decision'));
  const decision = runtime.snapshot().audit.entries.find(entry => entry.kind === 'decision');
  assert.equal(decision?.kind === 'decision' ? decision.outcome : '', 'failed');
  assert.match(decision?.kind === 'decision' ? decision.reason ?? '' : '', /deadline/i);
  const wait = request.options.find((option: any) => option.action.type === 'wait');
  resolveFetch(Response.json({ runId: request.runId, requestId: request.requestId, generation: request.generation,
    actorId: request.actorId, actionId: wait.actionId, rationale: 'Arrived too late.' }));
  await tick();
  assert.equal(runtime.snapshot().audit.entries.filter(entry => entry.kind === 'decision').length, 1);
  await runtime.dispose();
});

test('pause checkpoint resumes sourceable memory and a replayable audit', async () => {
  const storage = new MemoryStorage();
  const store = new SimulationSaveStore(storage);
  const fetcher: typeof fetch = async () => { throw new Error('not expected'); };
  const runtime = await SimulationRuntime.start(runtimeOptions(store, fetcher));
  runtime.join();
  assert.equal(runtime.action('player', { type: 'speak' }, 'The mugs are staying on the counter.').status, 'committed');
  const before = runtime.snapshot();
  assert.ok(before.audit.entries.some(entry => entry.kind === 'committed-event' && entry.event.payload.type === 'speech'));
  assert.ok(before.memory.some(record => record.kind === 'attributed-speech' && record.owner === 'player' && record.exactLine === 'The mugs are staying on the counter.'));
  await runtime.pause();
  const savedAudit = JSON.parse(runtime.exportAudit());
  const replayed = runtime.replay(savedAudit);
  assert.deepEqual(replayed, runtime.snapshot().checkpoint);
  await runtime.dispose();
  const resumed = await SimulationRuntime.resume(runtimeOptions(store, fetcher));
  assert.ok(resumed.snapshot().memory.some(record => record.kind === 'attributed-speech' && record.owner === 'player' && record.exactLine === 'The mugs are staying on the counter.'));
  assert.deepEqual(resumed.replay(JSON.parse(resumed.exportAudit())), resumed.snapshot().checkpoint);
  await resumed.dispose();
});
