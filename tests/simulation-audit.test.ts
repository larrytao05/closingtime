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
