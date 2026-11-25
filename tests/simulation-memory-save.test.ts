import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActorLocalObservation, AuditSnapshot, SimulationCommittedEvent, SimulationMemoryRecord, SimulationSaveClaim, SimulationSaveEnvelope } from '../src/simulation/contracts';
import { SimulationMemory } from '../src/simulation/memory';
import { SimulationSaveStore, type SimulationSaveStorage } from '../src/simulation/save';

function speech(sequence: number, actorId: 'mara' | 'riley' | 'jo', text: string, audience: Array<'player' | 'mara' | 'riley' | 'jo'>): SimulationCommittedEvent {
  return { runId: 'cafe-1', sequence, activeTimeMs: sequence * 100, revision: sequence, audience, payload: { type: 'speech', actorId, text }, afterCheckpoint: checkpoint(sequence), afterCheckpointProvenance: { runId: 'cafe-1', eventSequence: sequence, revision: sequence } };
}
function checkpoint(revision = 1) {
  return { activeTimeMs: revision * 100, revision, actors: { mara: { x: 2, y: 2 }, riley: { x: 3, y: 2 }, jo: { x: 4, y: 2 } }, objects: { papers: { location: { surface: 'table' as const }, wetness: 0 }, mug1: { location: { surface: 'counter' as const }, wetness: 0 }, mug2: { location: { surface: 'counter' as const }, wetness: 0 }, towel: { location: { surface: 'counter' as const }, wetness: 0 } }, windowOpen: true, rainExposureMs: 0 };
}
function observation(actorId: ActorLocalObservation['actorId'] = 'mara'): ActorLocalObservation {
  return { actorId, activeTimeMs: 5000, revision: 50, selfPosition: { x: 2, y: 2 }, visibleActors: [{ actorId: 'riley', position: { x: 3, y: 2 } }], visibleObjects: [{ objectId: 'papers', location: { surface: 'table' }, wetness: 0 }], windowOpen: true, rainExposureMs: 0 };
}

test('memory is actor-scoped, only witnessed events are ingested, and witnessed speech stays attributed', () => {
  const memory = new SimulationMemory();
  const privateLine = speech(1, 'riley', 'I promise I will bring the papers.', ['riley']);
  const publicLine = speech(2, 'riley', 'The papers are on the table.', ['mara', 'riley']);
  memory.ingest(privateLine, 'mara');
  memory.ingest(privateLine, 'riley');
  memory.ingest(publicLine, 'mara');
  memory.ingest(publicLine, 'mara');
  assert.deepEqual(memory.snapshot().map(r => [r.kind, r.owner, r.speaker]), [['attributed-speech', 'riley', 'riley'], ['attributed-speech', 'mara', 'riley']]);
  assert.deepEqual(memory.recall('mara', observation()).records.map(r => r.owner), ['mara']);
  assert.deepEqual(memory.recall('jo', observation('jo')).records, []);
});

test('promise survives dialogue churn and fabricated, unrelated, and other-speaker proposals are rejected', () => {
  const memory = new SimulationMemory();
  const promise = speech(1, 'mara', 'I promise I will bring the papers.', ['mara', 'riley']);
  const unrelated = speech(2, 'mara', 'The rain is loud in here.', ['mara', 'riley']);
  const witnessedOther = speech(3, 'riley', 'I promise I will bring the mug.', ['mara', 'riley']);
  const witnesses = [promise, unrelated, witnessedOther].map(event => ({ runId: event.runId, sequence: event.sequence, activeTimeMs: event.activeTimeMs, payload: event.payload }));
  const open = { kind: 'open-commitment' as const, sourceEventId: 'cafe-1:1', exactLine: 'I promise I will bring the papers.' };
  assert.equal(memory.applyProposals('mara', [{ ...open, exactLine: 'I promise I will bring the mugs.' }], witnesses).length, 0);
  assert.equal(memory.applyProposals('mara', [{ ...open, sourceEventId: 'cafe-1:2', exactLine: unrelated.payload.text }], witnesses).length, 0);
  assert.equal(memory.applyProposals('mara', [{ ...open, sourceEventId: 'cafe-1:3', exactLine: witnessedOther.payload.text }], witnesses).length, 0);
  assert.equal(memory.applyProposals('mara', [open], witnesses).length, 1);
  assert.equal(memory.applyProposals('mara', [open], witnesses).length, 0);
  for (let i = 4; i <= 80; i++) memory.ingest(speech(i, 'riley', `Dialogue turn ${i}.`, ['mara', 'riley']), 'mara');
  const recalled = memory.recall('mara', observation());
  assert.ok(recalled.records.some(r => r.kind === 'commitment' && r.exactLine === promise.payload.text && r.status === 'open'));
  assert.deepEqual(recalled.retrievedMemoryIds, recalled.records.map(r => r.id));
  assert.ok(new TextEncoder().encode(JSON.stringify(recalled)).byteLength <= 2048);
});

test('commitment closure cites later explicit same-speaker line; restore and dedupe preserve actor records', () => {
  const memory = new SimulationMemory();
  const openEvent = speech(4, 'mara', "I'll bring the mug.", ['mara']);
  const openWitness = [{ runId: openEvent.runId, sequence: openEvent.sequence, activeTimeMs: openEvent.activeTimeMs, payload: openEvent.payload }];
  const opened = memory.applyProposals('mara', [{ kind: 'open-commitment', sourceEventId: 'cafe-1:4', exactLine: openEvent.payload.text }], openWitness)[0];
  assert.ok(opened && opened.kind === 'commitment');
  const closeEvent = speech(5, 'mara', 'Done, I brought the mug.', ['mara']);
  const closeWitness = [{ runId: closeEvent.runId, sequence: closeEvent.sequence, activeTimeMs: closeEvent.activeTimeMs, payload: closeEvent.payload }];
  assert.equal(memory.applyProposals('mara', [{ kind: 'close-commitment', commitmentId: opened.id, sourceEventId: 'cafe-1:5', exactLine: closeEvent.payload.text, outcome: 'completed' }], closeWitness).length, 1);
  const records = memory.snapshot();
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'commitment');
  if (records[0].kind === 'commitment') assert.deepEqual([records[0].status, records[0].sourceEventIds], ['completed', ['cafe-1:4', 'cafe-1:5']]);
  const restored = new SimulationMemory();
  restored.restore(records);
  assert.deepEqual(restored.snapshot(), records);
  assert.throws(() => restored.restore([{ ...records[0], id: 'same' }, { ...records[0], id: 'same' }] as SimulationMemoryRecord[]), /Duplicate/);
});

class MemoryStorage implements SimulationSaveStorage {
  value: { runId: string; writerToken: string; generation: number; envelope: SimulationSaveEnvelope | null } | null = null;
  fail = false;
  async readOnly<T>(read: (current: typeof this.value) => T): Promise<T> { if (this.fail) throw new Error('read failed'); return read(structuredClone(this.value)); }
  async readWrite<T>(update: (current: typeof this.value) => { next: typeof this.value; result: T }): Promise<T> {
    if (this.fail) throw new Error('write failed');
    const result = update(structuredClone(this.value));
    this.value = structuredClone(result.next);
    return result.result;
  }
}
function envelope(sequence = 1): SimulationSaveEnvelope {
  const cp = checkpoint(sequence);
  const audit: AuditSnapshot = { schemaVersion: 3, runId: 'run-a', startingCheckpoint: checkpoint(), startingCheckpointProvenance: { runId: 'run-a', throughSequence: 0, revision: 1, source: 'run-start' }, firstRetainedSequence: 1, entries: [], prunedThroughSequence: 0, finalCheckpoint: cp, finalCheckpointProvenance: { runId: 'run-a', throughSequence: sequence, revision: sequence } };
  return { schemaVersion: 3, runId: 'run-a', checkpoint: cp, memory: [], audit, nextEventSequence: sequence + 1, writerToken: 'tab-a', writerGeneration: 1 };
}

test('save claims are atomic across tabs, ordered by event cursor, and never overwrite invalid data', async () => {
  const storage = new MemoryStorage();
  const storeA = new SimulationSaveStore(storage);
  const storeB = new SimulationSaveStore(storage);
  const claimedA = await storeA.claim('run-a', 'tab-a');
  assert.equal(claimedA.status, 'claimed');
  if (claimedA.status !== 'claimed') return;
  const claimA = claimedA.claim;
  assert.deepEqual(await storeA.save(claimA, envelope(5)), { status: 'saved', generation: claimA.generation });
  assert.equal(await storeA.save(claimA, envelope(2)).then(result => result.status), 'ownership-lost');
  assert.equal((await storeA.loadCurrent())?.nextEventSequence, 6);
  const claimedB = await storeB.claim('run-a', 'tab-b');
  assert.equal(claimedB.status, 'claimed');
  if (claimedB.status !== 'claimed') return;
  assert.equal(claimedB.envelope?.writerToken, 'tab-b');
  assert.equal((await storeA.save(claimA, envelope(7))).status, 'ownership-lost');
  assert.equal((await storeA.release(claimA)).status, 'ownership-lost');
  assert.equal((await storeB.save(claimedB.claim, envelope(7))).status, 'saved');
  const bad = envelope(8); bad.checkpoint.revision = -1;
  await assert.rejects(storeB.save(claimedB.claim, bad), /Invalid/);
  assert.equal((await storeB.loadCurrent())?.nextEventSequence, 8);
});

test('save queue preserves call order and surfaces storage failures without losing the previous save', async () => {
  const storage = new MemoryStorage();
  const store = new SimulationSaveStore(storage);
  const claimResult = await store.claim('run-a', 'tab-a');
  assert.equal(claimResult.status, 'claimed');
  if (claimResult.status !== 'claimed') return;
  const [first, second] = await Promise.all([store.save(claimResult.claim, envelope(1)), store.save(claimResult.claim, envelope(2))]);
  assert.deepEqual([first.status, second.status], ['saved', 'saved']);
  assert.equal((await store.loadCurrent())?.nextEventSequence, 3);
  storage.fail = true;
  await assert.rejects(store.save(claimResult.claim, envelope(3)), /write failed/);
  storage.fail = false;
  assert.equal((await store.loadCurrent())?.nextEventSequence, 3);
  assert.equal((await store.release(claimResult.claim)).status, 'saved');
  assert.equal(await store.loadCurrent(), null);
});


test('recall stays bounded after ingesting 1,000 seeded witnessed records', () => {
  const memory = new SimulationMemory();
  for (let i = 1; i <= 1000; i++) {
    const event: SimulationCommittedEvent = { runId: 'seeded', sequence: i, activeTimeMs: i * 10, revision: i, audience: ['mara'], payload: i % 5 === 0 ? { type: 'speech', actorId: 'riley', text: `Seeded dialogue ${i}.` } : { type: 'rain', exposed: i % 2 === 0, elapsedMs: 10, wetnessDelta: 0 }, afterCheckpoint: checkpoint(i), afterCheckpointProvenance: { runId: 'seeded', eventSequence: i, revision: i } };
    memory.ingest(event, 'mara');
  }
  const snapshot = memory.snapshot();
  const recall = memory.recall('mara', observation(), 2048);
  assert.equal(snapshot.length, 512);
  assert.ok(recall.records.length > 0);
  assert.ok(new TextEncoder().encode(JSON.stringify(recall)).byteLength <= 2048);
  assert.equal(recall.records.some(record => record.activeTimeMs < snapshot[0].activeTimeMs), false);
});
