import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulationRoom } from '../src/simulation/room';
import type { SimulationCommittedEvent, SimulationRoomCheckpoint } from '../src/simulation/contracts';

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

test('implicit join uses the preferred tile when free and falls back when reserved or occupied', () => {
  const preferred = { x: 5, y: 3 };
  const initial = new SimulationRoom({ now: () => 0 });
  assert.equal(initial.joinPlayer().status, 'committed');
  assert.deepEqual(initial.checkpoint().actors.player, preferred);
  initial.dispose();

  for (const activeMs of [50, 100]) {
    const room = new SimulationRoom({ now: () => 0, routeStepMs: 100 });
    assert.equal(room.dispatch('jo', { type: 'walk', to: preferred }).status, 'route-accepted');
    room.advance(activeMs);
    assert.deepEqual(room.joinPlayer(preferred), { status: 'rejected', reason: 'Choose a free floor tile.' });
    const fallback = { x: 5, y: 2 };
    const joined = room.joinPlayer();
    assert.equal(joined.status, 'committed');
    assert.deepEqual(joined.event.payload, { type: 'actor-joined', actorId: 'player', position: fallback });
    assert.deepEqual(joined.event.afterCheckpoint.actors.player, fallback);
    assert.equal(joined.event.activeTimeMs, activeMs);
    room.advance(100);
    assert.deepEqual(room.checkpoint().actors.jo, preferred);
    room.dispose();
  }
});

test('join during movement publication uses the next step reservation', () => {
  const room = new SimulationRoom({ now: () => 0, routeStepMs: 100, checkpoint: checkpoint({
    mara: { x: 2, y: 3 }, riley: { x: 3, y: 4 }, jo: { x: 5, y: 4 },
  }) });
  const target = { x: 5, y: 2 };
  const unsubscribe = room.subscribe(event => {
    if (event.payload.type !== 'movement-tile-committed') return;
    unsubscribe();
    room.joinPlayer();
  });
  assert.equal(room.dispatch('jo', { type: 'walk', to: target }).status, 'route-accepted');
  room.advance(100);
  assert.deepEqual(room.checkpoint().actors.player, { x: 4, y: 3 });
  room.advance(100);
  assert.deepEqual(room.checkpoint().actors.jo, target);
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

test('moving actors keep walk, wait, and speech options and regain interactions when they stop', () => {
  const room = new SimulationRoom({ now: () => 0, routeStepMs: 100 });
  const interaction = { type: 'putDown', objectId: 'mug1', surfaceId: 'counter' } as const;
  const interactionId = JSON.stringify(interaction);
  const maraOptions = () => room.optionsFor('mara');
  assert.ok(maraOptions().some(option => option.actionId === interactionId));
  assert.equal(room.dispatch('mara', { type: 'walk', to: { x: 1, y: 2 } }).status, 'route-accepted');

  const movingOptions = maraOptions();
  assert.deepEqual(new Set(movingOptions.map(option => option.action.type)), new Set(['walk', 'wait', 'speak']));
  assert.equal(room.dispatch('mara', { type: 'wait' }).status, 'committed');
  assert.equal(room.dispatch('mara', { type: 'speak', recipient: 'riley' }, 'On my way.').status, 'committed');
  assert.deepEqual(room.dispatch('mara', interaction), {
    status: 'rejected', reason: 'Finish the current step before interacting.',
  });

  room.advance(200);
  assert.deepEqual(room.checkpoint().actors.mara, { x: 1, y: 2 });
  assert.ok(maraOptions().some(option => option.actionId === interactionId));
  assert.equal(room.dispatch('mara', interaction).status, 'committed');
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

test('dispatch returns its own committed event after due movement and rain', () => {
  let now = 0;
  const room = new SimulationRoom({ now: () => now, routeStepMs: 100 });
  const events: SimulationCommittedEvent[] = [];
  room.subscribe(event => events.push(event));
  assert.equal(room.dispatch('mara', { type: 'walk', to: { x: 1, y: 3 } }).status, 'route-accepted');

  now = 4_001;
  const wait = room.dispatch('mara', { type: 'wait' });
  assert.deepEqual(events.map(event => event.payload.type), ['movement-tile-committed', 'rain', 'room-interaction']);
  assert.equal(wait.status, 'committed');
  assert.equal(wait.event, events[2]);
  assert.deepEqual(wait.event.payload, { type: 'room-interaction', actorId: 'mara', action: { type: 'wait' } });

  now = 8_001;
  assert.equal(room.dispatch('mara', { type: 'speak' }, '').status, 'rejected');
  assert.deepEqual(events.map(event => event.payload.type), ['movement-tile-committed', 'rain', 'room-interaction', 'rain']);
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

test('witnessed tails stay bounded while subscriptions receive the full event stream', () => {
  const room = new SimulationRoom();
  const streamed: number[] = [];
  room.subscribe(event => streamed.push(event.sequence));
  for (let index = 0; index < 80; index += 1) {
    assert.equal(room.dispatch('mara', { type: 'speak' }, `line ${index}`).status, 'committed');
  }
  const tail = room.witnessedEventsFor('mara');
  assert.equal(tail.length, 32);
  assert.equal(tail[0].sequence, 49);
  assert.equal(tail[31].sequence, 80);
  assert.equal(streamed.length, 80);
  assert.equal(new Set(streamed).size, 80);
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

test('simulation room advanceTo drives absolute advance with event capture', () => {
  let currentTime = 1_000;
  const room = new SimulationRoom({ runId: 'advance-to-fixture', now: () => currentTime, routeStepMs: 100 });
  assert.equal(room.checkpoint().activeTimeMs, 0);

  currentTime = 1_050;
  const events = room.advanceTo(currentTime);
  assert.equal(events.length, 0);
  assert.equal(room.checkpoint().activeTimeMs, 50);

  // Dispatch mid-advance
  currentTime = 1_100;
  const waitOutcome = room.dispatch('mara', { type: 'wait' });
  assert.equal(waitOutcome.status, 'committed');
  assert.equal(room.checkpoint().activeTimeMs, 100);

  // Absolute advanceTo continues from wall clock without double count
  currentTime = 1_200;
  room.advanceTo(currentTime);
  assert.equal(room.checkpoint().activeTimeMs, 200);

  // Relative advance still increments clock and pause/resume works
  room.advance(50);
  assert.equal(room.checkpoint().activeTimeMs, 250);

  const paused = room.pause();
  assert.equal(paused.activeTimeMs, 250);
  currentTime = 5_000;
  room.advanceTo(currentTime);
  assert.equal(room.checkpoint().activeTimeMs, 250);

  room.resume();
  currentTime = 5_100;
  room.advanceTo(currentTime);
  assert.equal(room.checkpoint().activeTimeMs, 350);

  room.dispose();
});
