import test from 'node:test';
import assert from 'node:assert/strict';
import type { AuditSnapshot, SimulationCommittedEvent, SimulationRoomCheckpoint } from '../src/simulation/contracts';
import { SimulationAudit, sourceEventStatus, validateAuditSnapshot } from '../src/simulation/audit';

function checkpoint(time = 0, revision = 0): SimulationRoomCheckpoint {
  return {
    activeTimeMs: time, revision,
    actors: { mara: { x: 2, y: 3 }, riley: { x: 3, y: 3 }, jo: { x: 4, y: 3 } },
    objects: {
      papers: { location: { surface: 'table' }, wetness: 0 },
      mug1: { location: { heldBy: 'mara' }, wetness: 0 },
      mug2: { location: { heldBy: 'mara' }, wetness: 0 },
      towel: { location: { surface: 'counter' }, wetness: 0 },
    },
    windowOpen: true, rainExposureMs: time,
  };
}

function event(runId: string, sequence: number, state: SimulationRoomCheckpoint): SimulationCommittedEvent {
  return {
    runId, sequence, activeTimeMs: state.activeTimeMs, revision: state.revision,
    audience: ['mara', 'riley'], payload: { type: 'rain', exposed: true, elapsedMs: 100, wetnessDelta: 0 },
    afterCheckpoint: structuredClone(state),
    afterCheckpointProvenance: { runId, eventSequence: sequence, revision: state.revision },
  };
}

test('replays retained committed state then applies exact exported clock metadata', () => {
  const audit = new SimulationAudit();
  audit.start('run-a', checkpoint());
  const committed = checkpoint(200, 1);
  audit.recordEvent(event('run-a', 1, committed));
  const final = { ...committed, activeTimeMs: 275, rainExposureMs: 275 };
  const snapshot = audit.snapshot(final);
  assert.deepEqual(audit.replay(snapshot), final);
  assert.deepEqual(audit.eventsFor('mara').map(entry => entry.kind), ['committed-event']);
  assert.deepEqual(audit.eventsFor('jo'), []);
});

test('accepts fractional active clock and exposure values throughout audit records', () => {
  const audit = new SimulationAudit();
  const start = checkpoint(0.125);
  start.rainExposureMs = 0.0625;
  audit.start('fractional-run', start);

  const committed = checkpoint(0.75, 1);
  committed.rainExposureMs = 0.375;
  const rainEvent = event('fractional-run', 1, committed);
  rainEvent.payload = { type: 'rain', exposed: true, elapsedMs: 0.3125, wetnessDelta: 0.125 };
  audit.recordEvent(rainEvent);
  audit.recordDecision({
    request: {
      runId: 'fractional-run', requestId: 'fractional-request', generation: 1, actorId: 'mara', observedRevision: 1,
      observation: {
        actorId: 'mara', activeTimeMs: 0.6875, revision: 1, selfPosition: { x: 2, y: 3 },
        visibleActors: [], visibleObjects: [], windowOpen: true, rainExposureMs: 0.34375,
      },
      witnessedEvents: [{ runId: 'fractional-run', sequence: 1, activeTimeMs: 0.75,
        payload: { type: 'rain', exposed: true, elapsedMs: 0.3125, wetnessDelta: 0.125 } }],
      options: [{ actionId: 'wait', action: { type: 'wait' } }],
      recall: {
        actorId: 'mara',
        records: [{ id: 'memory-1', kind: 'observation', owner: 'mara', sourceEventIds: ['event-1'],
          text: 'The rain started.', activeTimeMs: 0.5 }],
        retrievedMemoryIds: ['memory-1'],
      },
    },
    outcome: 'failed', reason: 'fixture', startedAtActiveMs: 0.78125, finishedAtActiveMs: 0.8125,
  });

  const final = { ...committed, activeTimeMs: 0.875, rainExposureMs: 0.4375 };
  const snapshot = audit.snapshot(final);
  assert.equal(validateAuditSnapshot(snapshot).entries.length, 2);
  assert.deepEqual(audit.replay(snapshot), final);
  const restored = new SimulationAudit();
  restored.importJSON(JSON.stringify(snapshot));
  assert.deepEqual(restored.replay(snapshot), final);
});

test('replay treats checkpoint object key order as semantically irrelevant', () => {
  const audit = new SimulationAudit();
  audit.start('run-a', checkpoint());
  const snapshot = audit.snapshot(checkpoint());
  snapshot.finalCheckpoint.actors = { jo: { y: 3, x: 4 }, riley: { y: 3, x: 3 }, mara: { y: 3, x: 2 } };
  snapshot.finalCheckpoint.objects = {
    towel: { wetness: 0, location: { surface: 'counter' } },
    mug2: { wetness: 0, location: { heldBy: 'mara' } },
    mug1: { wetness: 0, location: { heldBy: 'mara' } },
    papers: { wetness: 0, location: { surface: 'table' } },
  };
  assert.deepEqual(audit.replay(snapshot), { ...checkpoint(), actors: snapshot.finalCheckpoint.actors, objects: snapshot.finalCheckpoint.objects });
});

test('retains the exact settled nested decision request and filters entries by actor', () => {
  const audit = new SimulationAudit();
  audit.start('run-a', checkpoint());
  audit.recordDecision({
    request: {
      runId: 'run-a', requestId: 'req-1', generation: 2, actorId: 'jo', observedRevision: 0,
      observation: {
        actorId: 'jo', activeTimeMs: 0, revision: 0, selfPosition: { x: 4, y: 3 },
        visibleActors: [], visibleObjects: [], windowOpen: true, rainExposureMs: 0,
      },
      witnessedEvents: [], options: [{ actionId: 'wait', action: { type: 'wait' } }],
      recall: { actorId: 'jo', records: [], retrievedMemoryIds: [] },
    },
    outcome: 'failed', reason: 'fixture', startedAtActiveMs: 0, finishedAtActiveMs: 0,
  });
  assert.equal(audit.eventsFor('jo')[0].kind, 'decision');
  assert.deepEqual(audit.eventsFor('mara'), []);
  assert.equal(audit.snapshot(checkpoint()).entries[0].kind, 'decision');
});

test('restore validates imported JSON before replacing a usable trace', () => {
  const audit = new SimulationAudit();
  audit.start('safe', checkpoint());
  const snapshot = audit.snapshot(checkpoint());
  const bad = structuredClone(snapshot) as AuditSnapshot;
  bad.finalCheckpoint.actors.mara = { x: 99, y: 99 };
  assert.throws(() => audit.restore(bad), /Replay state differs/);
  assert.equal(audit.snapshot(checkpoint()).runId, 'safe');
  audit.importJSON(JSON.stringify(snapshot));
  assert.equal(audit.snapshot(checkpoint()).runId, 'safe');
});

test('import rejects malformed nested actions and witnessed room payloads', () => {
  const audit = new SimulationAudit();
  audit.start('run-a', checkpoint());
  audit.recordDecision({
    request: {
      runId: 'run-a', requestId: 'req', generation: 0, actorId: 'mara', observedRevision: 0,
      observation: { actorId: 'mara', activeTimeMs: 0, revision: 0, selfPosition: { x: 2, y: 3 }, visibleActors: [], visibleObjects: [], windowOpen: true, rainExposureMs: 0 },
      witnessedEvents: [], options: [{ actionId: 'wait', action: { type: 'wait' } }],
      recall: { actorId: 'mara', records: [], retrievedMemoryIds: [] },
    }, outcome: 'failed', startedAtActiveMs: 0, finishedAtActiveMs: 0,
  });
  const snapshot = audit.snapshot(checkpoint());
  const badAction = structuredClone(snapshot);
  (badAction.entries[0] as any).request.options[0].action = { type: 'pickUp', objectId: 'unknown' };
  assert.throws(() => validateAuditSnapshot(badAction), /Decision audit entry is malformed/);
  const badPayload = structuredClone(snapshot);
  (badPayload.entries[0] as any).request.witnessedEvents = [{ runId: 'run-a', sequence: 1, activeTimeMs: 0, payload: { type: 'movement-tile-committed', actorId: 'mara', from: {}, to: { x: 1, y: 2 } } }];
  assert.throws(() => validateAuditSnapshot(badPayload), /Decision audit entry is malformed/);
});

test('rejects misordered sequence and checkpoint provenance', () => {
  const audit = new SimulationAudit();
  audit.start('run-a', checkpoint());
  const committed = checkpoint(100, 1);
  audit.recordEvent(event('run-a', 1, committed));
  const snapshot = audit.snapshot(committed);
  const wrongRun = structuredClone(snapshot) as AuditSnapshot;
  wrongRun.entries[0] = { kind: 'committed-event', auditOrder: 0, event: event('other-run', 1, committed) };
  assert.throws(() => validateAuditSnapshot(wrongRun), /malformed or misordered/);
});

test('truncates at a retained checkpoint and distinguishes pruned evidence', () => {
  const audit = new SimulationAudit();
  audit.start('long', checkpoint());
  let state = checkpoint();
  for (let sequence = 1; sequence <= 2_010; sequence++) {
    state = checkpoint(sequence, sequence);
    audit.recordEvent(event('long', sequence, state));
  }
  const snapshot = audit.snapshot(state);
  assert.equal(snapshot.entries.length, 2_000);
  assert.equal(snapshot.startingCheckpointProvenance.source, 'retention-boundary');
  assert.equal(sourceEventStatus(1, snapshot), 'pruned');
  assert.equal(sourceEventStatus(snapshot.firstRetainedSequence, snapshot), 'retained');
  assert.equal(sourceEventStatus(0, snapshot), 'missing');
  assert.deepEqual(audit.replay(snapshot), state);
});
