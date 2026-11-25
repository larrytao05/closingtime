import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationRoom } from '../src/simulation/room';
import type { SimulationRoomCheckpoint } from '../src/simulation/contracts';

function checkpoint(actors: SimulationRoomCheckpoint['actors']): SimulationRoomCheckpoint {
  return {
    activeTimeMs: 0,
    revision: 0,
    actors,
    objects: {
      papers: { location: { surface: 'table' }, wetness: 0 },
      mug1: { location: { heldBy: 'mara' }, wetness: 0 },
      mug2: { location: { heldBy: 'mara' }, wetness: 0 },
      towel: { location: { surface: 'counter' }, wetness: 0 },
    },
    windowOpen: true,
    rainExposureMs: 0,
  };
}

test('simulation room shares tile reservations, commits routes, and joins the player on a free tile', () => {
  const room = new SimulationRoom({ routeStepMs: 100 });
  const routes = [
    room.dispatch('mara', { type: 'walk', to: { x: 1, y: 3 } }),
    room.dispatch('riley', { type: 'walk', to: { x: 3, y: 5 } }),
    room.dispatch('jo', { type: 'walk', to: { x: 5, y: 3 } }),
  ];
  assert.ok(routes.every(route => route.status === 'route-accepted'));
  const conflict = room.dispatch('jo', { type: 'walk', to: { x: 1, y: 3 } });
  assert.equal(conflict.status, 'rejected');
  const joined = room.joinPlayer({ x: 5, y: 4 });
  assert.equal(joined.status, 'committed');
  assert.deepEqual(room.checkpoint().actors.player, { x: 5, y: 4 });
  room.advance(300);
  assert.deepEqual(room.checkpoint().actors, {
    mara: { x: 1, y: 3 }, riley: { x: 3, y: 5 }, jo: { x: 5, y: 3 }, player: { x: 5, y: 4 },
  });
  room.dispose();
});

test('shared object ownership makes simultaneous pickup deterministic and stale actions fail', () => {
  const saved = checkpoint({ mara: { x: 5, y: 1 }, riley: { x: 6, y: 2 }, jo: { x: 4, y: 2 } });
  saved.objects.mug1 = { location: { heldBy: 'jo' }, wetness: 0 };
  saved.objects.mug2 = { location: { heldBy: 'jo' }, wetness: 0 };
  const room = new SimulationRoom({ checkpoint: saved });
  const before = room.optionsFor('mara');
  assert.ok(before.some(option => option.action.type === 'pickUp' && option.action.objectId === 'papers'));
  const winner = room.dispatch('mara', { type: 'pickUp', objectId: 'papers' });
  const stale = room.dispatch('riley', { type: 'pickUp', objectId: 'papers' });
  assert.equal(winner.status, 'committed');
  assert.deepEqual(stale, { status: 'rejected', reason: 'Someone is already holding that.' });
  assert.deepEqual(room.checkpoint().objects.papers.location, { heldBy: 'mara' });
  room.dispose();
});

test('rain advances with the room clock without a pending request and commits its settled checkpoint', () => {
  const room = new SimulationRoom({ runId: 'rain-fixture', now: () => 0 });
  const events = room.advance(4_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.type, 'rain');
  assert.equal(events[0].afterCheckpoint.objects.papers.wetness, 1);
  assert.equal(events[0].afterCheckpoint.rainExposureMs, 0);
  assert.equal(events[0].afterCheckpointProvenance.eventSequence, events[0].sequence);
  room.dispose();
});

test('Jo receives no speech text outside hearing range even when visible to the speaker', () => {
  const room = new SimulationRoom({ hearingDistance: 5, sightDistance: 6, checkpoint: checkpoint({
    mara: { x: 1, y: 0 }, riley: { x: 3, y: 0 }, jo: { x: 7, y: 0 },
  }) });
  assert.ok(room.optionsFor('mara').some(option => option.action.type === 'speak' && option.action.recipient === 'jo'));
  const outcome = room.dispatch('mara', { type: 'speak', recipient: 'jo' }, 'I can see you, Jo.');
  assert.equal(outcome.status, 'committed');
  assert.deepEqual(room.witnessedEventsFor('jo'), []);
  assert.equal(room.witnessedEventsFor('mara')[0]?.payload.type, 'speech');
  const unaddressed = room.dispatch('mara', { type: 'speak' }, 'No one can hear this.');
  assert.equal(unaddressed.status, 'committed');
  assert.equal(room.witnessedEventsFor('jo').length, 0);
  room.dispose();
});

test('checkpoints restore only committed tile positions and preserve clock and partial rain exposure', () => {
  const room = new SimulationRoom({ checkpoint: {
    ...checkpoint({ mara: { x: 2, y: 3 }, riley: { x: 3, y: 4 }, jo: { x: 4, y: 3 } }),
    activeTimeMs: 2_500, revision: 7, rainExposureMs: 1_250,
  } });
  assert.equal(room.checkpoint().activeTimeMs, 2_500);
  assert.equal(room.checkpoint().revision, 7);
  assert.equal(room.checkpoint().rainExposureMs, 1_250);
  room.dispatch('mara', { type: 'walk', to: { x: 1, y: 3 } });
  assert.deepEqual(room.checkpoint().actors.mara, { x: 2, y: 3 });
  room.advance(50);
  assert.notDeepEqual(room.renderPositions().mara, { x: 2, y: 3 });
  room.dispose();
});
