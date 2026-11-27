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

test('promise survives more than 512 records of churn and can still be closed', () => {
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
  for (let i = 4; i <= 600; i++) memory.ingest(speech(i, 'riley', `Dialogue turn ${i}.`, ['mara', 'riley']), 'mara');
  assert.equal(memory.snapshot().length, 512);
  const recalled = memory.recall('mara', observation());
  assert.ok(recalled.records.some(r => r.kind === 'commitment' && r.exactLine === promise.payload.text && r.status === 'open'));
  assert.deepEqual(recalled.retrievedMemoryIds, recalled.records.map(r => r.id));
  assert.ok(new TextEncoder().encode(JSON.stringify(recalled)).byteLength <= 2048);
  const completion = speech(601, 'mara', 'Done, I brought the papers.', ['mara', 'riley']);
  const completionWitness = [{ runId: completion.runId, sequence: completion.sequence, activeTimeMs: completion.activeTimeMs, payload: completion.payload }];
  assert.equal(memory.applyProposals('mara', [{ kind: 'close-commitment', commitmentId: `commitment:cafe-1:1:mara`, sourceEventId: 'cafe-1:601', exactLine: completion.payload.text, outcome: 'completed' }], completionWitness).length, 1);
  assert.ok(memory.snapshot().some(r => r.kind === 'commitment' && r.status === 'completed'));
});

test('memory rejects incoming records when all 512 retained records are open commitments', () => {
  const memory = new SimulationMemory();
  memory.restore(Array.from({ length: 512 }, (_, index): SimulationMemoryRecord => ({
    id: `commitment:seed:${index}:mara`, kind: 'commitment', owner: 'mara', speaker: 'mara',
    sourceEventIds: [`seed:${index}`], exactLine: 'I promise I will bring the papers.', status: 'open', activeTimeMs: index,
  })));
  const ordinary = speech(513, 'riley', 'A later witnessed dialogue turn.', ['mara', 'riley']);
  memory.ingest(ordinary, 'mara');
  assert.equal(memory.snapshot().length, 512);
  assert.equal(memory.snapshot().some(record => record.id === 'speech:cafe-1:513:riley:mara'), false);
  const proposedOpen = speech(514, 'mara', 'I promise I will bring the mug.', ['mara']);
  const witnessed = [{ runId: proposedOpen.runId, sequence: proposedOpen.sequence, activeTimeMs: proposedOpen.activeTimeMs, payload: proposedOpen.payload }];
  assert.deepEqual(memory.applyProposals('mara', [{ kind: 'open-commitment', sourceEventId: 'cafe-1:514', exactLine: proposedOpen.payload.text }], witnessed), []);
  assert.equal(memory.snapshot().length, 512);
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

test('recall includes a Unicode record at its exact UTF-8 byte budget boundary', () => {
  const memory = new SimulationMemory();
  memory.ingest(speech(1, 'mara', 'Café ☕ — papers are ready.', ['mara']), 'mara');
  const expected = { actorId: 'mara', records: memory.snapshot(), retrievedMemoryIds: ['speech:cafe-1:1:mara:mara'] };
  const exactBytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength;

  assert.equal(new TextEncoder().encode(JSON.stringify(memory.recall('mara', observation(), exactBytes))).byteLength, exactBytes);
  assert.deepEqual(memory.recall('mara', observation(), exactBytes - 1).records, []);
});

test('multiple witnesses receive distinct memory records with owner in speech and observation IDs', () => {
  const memory = new SimulationMemory();
  const dialogue = speech(1, 'riley', 'The rain stopped outside.', ['mara', 'riley', 'jo']);
  const movement: SimulationCommittedEvent = {
    runId: 'cafe-1', sequence: 2, activeTimeMs: 200, revision: 2,
    audience: ['mara', 'riley', 'jo'],
    payload: { type: 'movement-tile-committed', actorId: 'mara', from: { x: 2, y: 2 }, to: { x: 3, y: 2 } },
    afterCheckpoint: checkpoint(2),
    afterCheckpointProvenance: { runId: 'cafe-1', eventSequence: 2, revision: 2 },
  };

  // Ingest speech for all witnesses in audience
  memory.ingest(dialogue, 'mara');
  memory.ingest(dialogue, 'riley');
  memory.ingest(dialogue, 'jo');

  // Ingest observation for all witnesses in audience
  memory.ingest(movement, 'mara');
  memory.ingest(movement, 'riley');
  memory.ingest(movement, 'jo');

  const snapshot = memory.snapshot();
  assert.equal(snapshot.length, 6);

  // Check speech record IDs and ownership
  const speechRecords = snapshot.filter(r => r.kind === 'attributed-speech');
  assert.equal(speechRecords.length, 3);
  assert.deepEqual(speechRecords.map(r => ({ id: r.id, owner: r.owner, speaker: r.speaker })), [
    { id: 'speech:cafe-1:1:riley:mara', owner: 'mara', speaker: 'riley' },
    { id: 'speech:cafe-1:1:riley:riley', owner: 'riley', speaker: 'riley' },
    { id: 'speech:cafe-1:1:riley:jo', owner: 'jo', speaker: 'riley' },
  ]);

  // Check observation record IDs and ownership
  const observationRecords = snapshot.filter(r => r.kind === 'observation');
  assert.equal(observationRecords.length, 3);
  assert.deepEqual(observationRecords.map(r => ({ id: r.id, owner: r.owner })), [
    { id: 'observation:cafe-1:2:mara', owner: 'mara' },
    { id: 'observation:cafe-1:2:riley', owner: 'riley' },
    { id: 'observation:cafe-1:2:jo', owner: 'jo' },
  ]);

  // Each witness recalls only their own records
  const maraRecall = memory.recall('mara', observation('mara'));
  assert.equal(maraRecall.records.length, 2);
  assert.ok(maraRecall.records.every(r => r.owner === 'mara'));
  assert.deepEqual(maraRecall.retrievedMemoryIds, ['speech:cafe-1:1:riley:mara', 'observation:cafe-1:2:mara']);

  const rileyRecall = memory.recall('riley', observation('riley'));
  assert.equal(rileyRecall.records.length, 2);
  assert.ok(rileyRecall.records.every(r => r.owner === 'riley'));
  assert.deepEqual(rileyRecall.retrievedMemoryIds, ['speech:cafe-1:1:riley:riley', 'observation:cafe-1:2:riley']);

  const joRecall = memory.recall('jo', observation('jo'));
  assert.equal(joRecall.records.length, 2);
  assert.ok(joRecall.records.every(r => r.owner === 'jo'));
  assert.deepEqual(joRecall.retrievedMemoryIds, ['speech:cafe-1:1:riley:jo', 'observation:cafe-1:2:jo']);
});

test('per-witness deduplication rejects repeated ingest and preserves old saves with legacy IDs', async () => {
  const memory = new SimulationMemory();
  const dialogue = speech(1, 'riley', 'The rain stopped outside.', ['mara', 'riley']);

  memory.ingest(dialogue, 'mara');
  assert.equal(memory.snapshot().length, 1);

  // Re-ingest the exact same event for the same witness: deduplicated
  memory.ingest(dialogue, 'mara');
  assert.equal(memory.snapshot().length, 1);

  // Ingest for a different witness: accepted
  memory.ingest(dialogue, 'riley');
  assert.equal(memory.snapshot().length, 2);

  // Re-ingest for second witness: deduplicated
  memory.ingest(dialogue, 'riley');
  assert.equal(memory.snapshot().length, 2);

  // Preserves old saves with legacy IDs (without owner in ID)
  const legacyRecords: SimulationMemoryRecord[] = [
    { id: 'speech:legacy-1:1:riley', kind: 'attributed-speech', owner: 'mara', speaker: 'riley', sourceEventIds: ['legacy-1:1'], exactLine: 'Old dialogue line.', activeTimeMs: 100 },
    { id: 'observation:legacy-1:2', kind: 'observation', owner: 'mara', sourceEventIds: ['legacy-1:2'], text: 'mara moved.', activeTimeMs: 200 },
  ];

  const restored = new SimulationMemory();
  restored.restore(legacyRecords);
  assert.deepEqual(restored.snapshot(), legacyRecords);

  // Recalls legacy records properly by owner
  const recalled = restored.recall('mara', observation('mara'));
  assert.equal(recalled.records.length, 2);
  assert.deepEqual(recalled.retrievedMemoryIds, ['speech:legacy-1:1:riley', 'observation:legacy-1:2']);

  // Re-ingesting an event that matches an existing legacy record for that owner is deduplicated
  const legacySpeechEvent = speech(1, 'riley', 'Old dialogue line.', ['mara', 'riley']);
  (legacySpeechEvent as any).runId = 'legacy-1';
  (legacySpeechEvent.afterCheckpointProvenance as any).runId = 'legacy-1';
  restored.ingest(legacySpeechEvent, 'mara');
  assert.equal(restored.snapshot().length, 2);

  // Ingesting that same legacy event for a new witness (who wasn't in the legacy save) succeeds
  restored.ingest(legacySpeechEvent, 'riley');
  assert.equal(restored.snapshot().length, 3);
  assert.equal(restored.snapshot()[2].id, 'speech:legacy-1:1:riley:riley');
  assert.equal(restored.snapshot()[2].owner, 'riley');

  // Durable store saves and loads legacy save envelope without issue
  const storage = new MemoryStorage();
  const store = new SimulationSaveStore(storage);
  const claim = await store.claim('legacy-1', 'tab-1');
  assert.equal(claim.status, 'claimed');
  if (claim.status !== 'claimed') return;

  const legacyEnvelope: SimulationSaveEnvelope = {
    schemaVersion: 3,
    runId: 'legacy-1',
    checkpoint: checkpoint(2),
    memory: legacyRecords,
    audit: {
      schemaVersion: 3,
      runId: 'legacy-1',
      startingCheckpoint: checkpoint(),
      startingCheckpointProvenance: { runId: 'legacy-1', throughSequence: 0, revision: 1, source: 'run-start' },
      firstRetainedSequence: 1,
      entries: [],
      prunedThroughSequence: 0,
      finalCheckpoint: checkpoint(2),
      finalCheckpointProvenance: { runId: 'legacy-1', throughSequence: 2, revision: 2 },
    },
    nextEventSequence: 3,
    writerToken: 'tab-1',
    writerGeneration: 1,
  };

  const saveResult = await store.save(claim.claim, legacyEnvelope);
  assert.equal(saveResult.status, 'saved');
  const loaded = await store.loadCurrent();
  assert.deepEqual(loaded?.memory, legacyRecords);
});
