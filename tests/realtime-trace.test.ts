import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionEvent } from '../src/realtime';
import { RealtimeTrace } from '../src/realtime-trace';
import { TraceLog } from '../src/trace-log';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

function event(sessionId: string, sequence: number, payload: { kind: string; [key: string]: unknown }) {
  // Supply only the lifecycle fields exercised by the journal itself.
  return { sessionId, sequence, activeMs: 1000, revision: sequence, wallMs: 1200, ...payload } as SessionEvent;
}

test('exports separate request and route outcomes, with event sequence breaking clock ties', () => {
  const storage = memoryStorage();
  const log = new RealtimeTrace({ storage, now: () => new Date('2026-11-24T22:30:00Z') });
  const input = { windowOpen: true };
  log.append(event('old', 0, { kind: 'decisionRequested', requestId: 'req-1', observedRevision: 0, clientObservation: input }));
  log.append(event('old', 1, { kind: 'routeSubmitted', commandId: 'route-1', actor: 'player' }));
  assert.equal(storage.length, 0);
  const inFlight = JSON.parse(log.toJSON()).sessions[0];
  assert.equal(storage.length, 1);
  assert.deepEqual(inFlight.pendingAtExport, { requestIds: ['req-1'], commandIds: ['route-1'] });
  assert.deepEqual(inFlight.events.map(item => item.sequence), [0, 1]);
  assert.equal(inFlight.events[0].capturedAt, '2026-11-24T22:30:00.000Z');

  log.append(event('old', 2, {
    kind: 'decisionReceived', requestId: 'req-1', observedRevision: 0,
    latencyMs: 200, observation: input,
  }));
  log.append(event('old', 3, {
    kind: 'decisionSkipped', requestId: 'req-1', commandId: 'skip-1',
    effectiveSnapshot: { revision: 3, world: { windowOpen: false } },
  }));
  log.append(event('old', 4, { kind: 'routeFinished', commandId: 'route-1', outcome: 'canceled' }));
  log.append(event('old', 5, { kind: 'session', phase: 'ended' }));
  log.append(event('new', 0, { kind: 'decisionRequested', requestId: 'req-2' }));
  log.flush();

  const reopened = new RealtimeTrace({ storage });
  assert.equal(reopened.count, 7);
  const result = JSON.parse(reopened.toJSON());
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.mode, 'realtime');
  const previous = result.sessions.find(item => item.sessionId === 'old');
  const next = result.sessions.find(item => item.sessionId === 'new');
  assert.deepEqual(previous.pendingAtExport, { requestIds: [], commandIds: [] });
  assert.deepEqual(previous.events.map(item => item.sequence), [0, 1, 2, 3, 4, 5]);
  assert.equal(previous.events[0].clientObservation.windowOpen, true);
  assert.equal(previous.events[3].effectiveSnapshot.world.windowOpen, false);
  assert.equal(previous.events[3].effectiveSnapshot.revision, 3);
  assert.deepEqual(next.pendingAtExport, { requestIds: ['req-2'], commandIds: [] });
});

test('reports timeout and cancellation separately and keeps decision skip distinct', () => {
  const log = new RealtimeTrace({ storage: memoryStorage() });
  const append = (sequence: number, payload: { kind: string; requestId: string }) => {
    log.append(event('room', sequence, payload));
  };
  append(0, { kind: 'decisionRequested', requestId: 'timeout' });
  append(1, { kind: 'decisionFailed', requestId: 'timeout' });
  append(2, { kind: 'decisionRequested', requestId: 'cancel' });
  append(3, { kind: 'decisionCanceled', requestId: 'cancel' });
  append(4, { kind: 'decisionRequested', requestId: 'pending' });
  append(5, { kind: 'decisionSkipped', requestId: 'pending' });
  const session = JSON.parse(log.toJSON()).sessions[0];
  assert.deepEqual(session.pendingAtExport.requestIds, ['pending']);
  assert.equal(session.events.length, 6);
});

test('exports unwritten events and a drop count under quota or buffer pressure', () => {
  const storage = memoryStorage();
  storage.setItem('closing-time:trace:2:bad:0', '{invalid');
  const quotaStorage = {
    get length() { return storage.length; }, key: storage.key, getItem: storage.getItem,
    setItem() { throw new Error('quota'); },
  };
  const log = new RealtimeTrace({ storage: quotaStorage, maxBufferedCharacters: 600 });
  log.append(event('room', 0, { kind: 'decisionRequested', requestId: 'req' }));
  log.append(event('room', 1, { kind: 'rain', detail: 'x'.repeat(350) }));
  log.append(event('room', 2, { kind: 'decisionReceived', requestId: 'req' }));
  log.flush();
  assert.equal(log.needsExport, true);
  const result = JSON.parse(log.toJSON());
  assert.equal(result.unreadableChunks, 1);
  assert.ok(result.sessions[0].droppedEvents >= 1);
  assert.equal(result.sessions[0].events.at(-1).kind, 'decisionReceived');
  assert.deepEqual(result.sessions[0].pendingAtExport.requestIds, []);
});

test('preserves the existing v1 storage key and export bytes', () => {
  const storage = memoryStorage();
  const testGlobal = globalThis as unknown as { localStorage?: Storage };
  const previous = testGlobal.localStorage;
  testGlobal.localStorage = storage as unknown as Storage;
  try {
    const legacyKey = 'closing-time:trace:1:legacy:1';
    const legacyData = '{"sessionId":"legacy","recordedAt":"2026-11-24","worldAfter":{"turn":1}}';
    storage.setItem(legacyKey, legacyData);
    const original = new TraceLog().toJSON();
    const log = new RealtimeTrace({ storage });
    assert.equal(log.count, 0);
    log.append(event('realtime', 0, { kind: 'session', phase: 'started' }));
    assert.equal(JSON.parse(log.toJSON()).sessions.length, 1);
    assert.equal(new RealtimeTrace({ storage }).count, 1);
    assert.equal(storage.getItem(legacyKey), legacyData);
    assert.equal(new TraceLog().toJSON(), original);
  } finally {
    testGlobal.localStorage = previous;
  }
});

test('notifies the audit UI when a background flush first encounters a quota error', () => {
  const storage = memoryStorage();
  let warnings = 0;
  const trace = new RealtimeTrace({
    storage: { ...storage, setItem() { throw Error('quota'); } },
    onStorageStatusChange: () => { warnings++; },
  });
  trace.append(event('room', 0, { kind: 'session', phase: 'started' }));
  assert.equal(trace.needsExport, false);
  trace.flush();
  assert.equal(trace.needsExport, true);
  trace.flush();
  assert.equal(warnings, 1);
  assert.equal(trace.count, 1);
});
