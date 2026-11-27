import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DurableState, SimulationSaveStorage } from '../src/simulation/save';
import { SimulationSaveStore } from '../src/simulation/save';
import { SimulationRuntime } from '../src/simulation/runtime';
import type { SimulationDecisionRequest, SimulationSaveEnvelope } from '../src/simulation/contracts';

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

test('the decision audit links directed speech between rain and a subscriber joining the player', async () => {
  let now = 0;
  const store = new SimulationSaveStore(new MemoryStorage());
  const fetcher: typeof fetch = async (_url, init) => {
    const request: SimulationDecisionRequest = JSON.parse(String(init?.body));
    const speak = request.actorId === 'mara';
    const option = request.options.find(({ action }) => speak
      ? action.type === 'speak' && action.recipient === 'riley'
      : action.type === 'wait');
    assert.ok(option);
    if (speak) now = 4_001;
    return Response.json({ runId: request.runId, requestId: request.requestId, generation: request.generation,
      actorId: request.actorId, actionId: option.actionId, reply: speak ? 'Hello Riley.' : undefined, rationale: 'Fixture decision.' });
  };
  const runtime = await SimulationRuntime.start({ ...runtimeOptions(store, fetcher), now: () => now });
  try {
    let replayedJoin = false;
    runtime.subscribe(snapshot => {
      if (snapshot.checkpoint.actors.player || !snapshot.audit.entries.some(entry =>
        entry.kind === 'committed-event' && entry.event.payload.type === 'speech')) return;
      assert.equal(runtime.join().status, 'committed');
      replayedJoin = Boolean(runtime.replay(JSON.parse(runtime.exportAudit())).actors.player);
    });
    runtime.wake('mara', 'fixture');
    await until(() => runtime.snapshot().audit.entries.some(entry => entry.kind === 'decision' && entry.request.actorId === 'mara'));

    const { audit, checkpoint } = runtime.snapshot();
    const committed = audit.entries.flatMap(entry => entry.kind === 'committed-event' ? [entry.event] : []);
    assert.deepEqual(committed.slice(0, 3).map(event => event.payload.type), ['rain', 'speech', 'actor-joined']);
    assert.deepEqual(committed[1].payload, { type: 'speech', actorId: 'mara', recipient: 'riley', text: 'Hello Riley.' });
    const decision = audit.entries.find(entry => entry.kind === 'decision' && entry.request.actorId === 'mara');
    assert.ok(decision?.kind === 'decision');
    assert.deepEqual(decision.dispatchOutcome, { status: 'committed', event: committed[1] });
    assert.ok(replayedJoin);
    assert.deepEqual(runtime.replay(JSON.parse(runtime.exportAudit())), checkpoint);
  } finally {
    await runtime.dispose();
  }
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

test('reset cancels held inference before delayed persistence and serializes lifecycle changes', async () => {
  let holdSaves = false;
  let releaseSave!: () => void;
  let saveEntered!: () => void;
  const enteredSave = new Promise<void>(resolve => { saveEntered = resolve; });
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  class DelayedSaveStore extends SimulationSaveStore {
    override async save(...args: Parameters<SimulationSaveStore['save']>) {
      if (holdSaves) { saveEntered(); await saveGate; }
      return super.save(...args);
    }
  }
  const store = new DelayedSaveStore(new MemoryStorage());
  let resolveFetch!: (value: Response) => void;
  let request: any;
  const fetcher: typeof fetch = (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Promise(resolve => { resolveFetch = resolve; });
  };
  const runtime = await SimulationRuntime.start(runtimeOptions(store, fetcher));
  runtime.wake('riley', 'reset race');
  await until(() => !!request);
  const oldRunId = runtime.getRunId();
  holdSaves = true;
  const reset = runtime.reset();
  try {
    await enteredSave;
    const decision = runtime.snapshot().audit.entries.find(entry => entry.kind === 'decision');
    assert.equal(runtime.snapshot().audit.entries.filter(entry => entry.kind === 'decision').length, 1);
    assert.equal(decision?.kind === 'decision' ? decision.outcome : '', 'cancelled');
    assert.equal(runtime.action('player', { type: 'speak' }, 'during reset').status, 'skipped');
    await Promise.all([runtime.pause(), runtime.reset()]);
    runtime.resumeRun();
    resolveFetch(Response.json({ runId: request.runId, requestId: request.requestId, generation: request.generation,
      actorId: request.actorId, actionId: request.options.find((item: any) => item.action.type === 'wait').actionId,
      rationale: 'Late response.' }));
    await tick();
    assert.equal(runtime.getRunId(), oldRunId);
    assert.equal(runtime.snapshot().audit.entries.filter(entry => entry.kind === 'committed-event' && entry.event.payload.type === 'speech').length, 0);
  } finally { releaseSave(); await reset; await runtime.dispose(); }
  assert.notEqual(runtime.getRunId(), oldRunId);
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

test('disposal waits for the checkpoint that preserves committed state, memory, and audit', async () => {
  let holdWrite = false;
  let writeEntered = false;
  let releaseWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  class DelayedSaveStore extends SimulationSaveStore {
    override async save(...args: Parameters<SimulationSaveStore['save']>) {
      if (holdWrite) { writeEntered = true; await writeGate; }
      return super.save(...args);
    }
  }
  const store = new DelayedSaveStore(new MemoryStorage());
  const fetcher: typeof fetch = async () => { throw new Error('No model decision expected.'); };
  const options = { ...runtimeOptions(store, fetcher), now: () => 0 };
  const runtime = await SimulationRuntime.start(options);
  assert.equal(runtime.join().status, 'committed');
  assert.equal(runtime.action('riley', { type: 'speak' }, 'Keep this line.').status, 'committed');
  const before = runtime.snapshot();

  holdWrite = true;
  const disposal = runtime.dispose();
  let disposed = false;
  void disposal.then(() => { disposed = true; });
  try {
    assert.equal(runtime.dispose(), disposal);
    await until(() => writeEntered);
    assert.equal(disposed, false);
    assert.equal(runtime.action('player', { type: 'wait' }).status, 'skipped');
  } finally {
    holdWrite = false;
    releaseWrite();
    await disposal;
  }

  const resumed = await SimulationRuntime.resume(options);
  try {
    const after = resumed.snapshot();
    assert.equal(after.runId, before.runId);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(after.memory, before.memory);
    assert.deepEqual(after.audit, before.audit);
    assert.deepEqual(resumed.replay(after.audit), before.checkpoint);
  } finally {
    await resumed.dispose();
  }
});

test('player activity saves the latest committed snapshot without queuing a write for every action', async () => {
  let holdNextWrite = false;
  let releaseWrite!: () => void;
  let enterWrite!: () => void;
  const writeGate = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeEntered = new Promise<void>(resolve => { enterWrite = resolve; });
  class DelayedStorage extends MemoryStorage {
    override async readWrite<T>(update: (current: DurableState | null) => { next: DurableState | null; result: T }): Promise<T> {
      if (holdNextWrite) {
        holdNextWrite = false;
        enterWrite();
        await writeGate;
      }
      return super.readWrite(update);
    }
  }
  const writes: SimulationSaveEnvelope[] = [];
  class TrackedStore extends SimulationSaveStore {
    override save(...args: Parameters<SimulationSaveStore['save']>) {
      writes.push(args[1]);
      return super.save(...args);
    }
  }
  const store = new TrackedStore(new DelayedStorage());
  const fetcher: typeof fetch = async () => { throw new Error('No model decision expected.'); };
  const runtime = await SimulationRuntime.start({ ...runtimeOptions(store, fetcher), now: () => 0 });
  try {
    holdNextWrite = true;
    assert.equal(runtime.join({ x: 5, y: 1 }).status, 'committed');
    assert.equal(writes.length, 2);
    await writeEntered;
    assert.equal(runtime.action('player', { type: 'speak' }, 'First line.').status, 'committed');
    assert.equal(runtime.action('player', { type: 'speak' }, 'Last line.').status, 'committed');
    assert.equal(writes.length, 2);
    releaseWrite();
    await until(() => writes.length === 3);
    const afterSpeech = await store.loadCurrent();
    assert.ok(afterSpeech?.memory.some(record => record.kind === 'attributed-speech' && record.exactLine === 'Last line.'));

    assert.equal(runtime.action('player', { type: 'close' }).status, 'committed');
    await until(() => writes.length === 4);

    const saved = await store.loadCurrent();
    assert.ok(saved);
    assert.equal(saved.checkpoint.windowOpen, false);
    const live = runtime.snapshot();
    assert.deepEqual(saved.checkpoint, live.checkpoint);
    assert.deepEqual(saved.audit, live.audit);
    assert.deepEqual(saved.memory, live.memory);
    assert.deepEqual(runtime.replay(saved.audit), live.checkpoint);
  } finally {
    releaseWrite();
    await runtime.dispose();
  }
});

test('mid-frame dispatch advances simulation clock through a single clock source without double counting', async () => {
  let currentTime = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { dueAt: number; callback: () => void }>();

  const fakeSetTimer = ((callback: TimerHandler, delay = 0) => {
    const id = ++nextTimerId;
    timers.set(id, { dueAt: currentTime + Number(delay), callback: callback as () => void });
    return id;
  }) as typeof setTimeout;

  const fakeClearTimer = ((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout;

  const advanceTimeTo = async (targetTime: number) => {
    currentTime = targetTime;
    while (true) {
      let earliestId: number | null = null;
      let earliestDue = Infinity;
      for (const [id, timer] of timers) {
        if (timer.dueAt <= currentTime && timer.dueAt < earliestDue) {
          earliestDue = timer.dueAt;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const timer = timers.get(earliestId)!;
      timers.delete(earliestId);
      timer.callback();
      await tick();
    }
  };

  const store = new SimulationSaveStore(new MemoryStorage());
  const fetcher: typeof fetch = async () => { throw new Error('not expected'); };

  const runtime = await SimulationRuntime.start({
    saveStore: store,
    fetch: fetcher,
    now: () => currentTime,
    setTimer: fakeSetTimer,
    clearTimer: fakeClearTimer,
    frameIntervalMs: 100,
    checkpointIntervalMs: 10_000,
    ambientIntervalMs: 10_000,
  });

  const frameTimes: number[] = [];
  runtime.subscribeFrame(frame => {
    frameTimes.push(frame.activeTimeMs);
  });

  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 0);

  // Dispatch mid-frame action at 50 ms
  currentTime = 50;
  const outcome = runtime.action('mara', { type: 'wait' });
  assert.equal(outcome.status, 'committed');
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 50);

  // Advance to first frame boundary at 100 ms
  await advanceTimeTo(100);
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 100);

  // Advance to second frame boundary at 200 ms without mid-frame action
  await advanceTimeTo(200);
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 200);

  // Dispatch another mid-frame action at 250 ms
  currentTime = 250;
  const outcome2 = runtime.action('riley', { type: 'wait' });
  assert.equal(outcome2.status, 'committed');
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 250);

  // Advance to third frame boundary at 300 ms
  await advanceTimeTo(300);
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 300);

  // Verify pause and resume behavior preserves single-clock advance
  currentTime = 340;
  await runtime.pause();
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 340);

  currentTime = 10_340;
  runtime.resumeRun();
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 340);

  await advanceTimeTo(10_440);
  assert.equal(runtime.snapshot().checkpoint.activeTimeMs, 440);

  await runtime.dispose();
});
