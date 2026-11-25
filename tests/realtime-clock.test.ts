import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MovementController } from '../src/movement';
import { RealtimeSession, type SessionEvent } from '../src/realtime';
import { advanceRain, createWorld } from '../src/world';

function harness(wetnessIntervalMs = 1000) {
  let wall = 0;
  let id = 0;
  const events: SessionEvent[] = [];
  const session = new RealtimeSession({
    now: () => wall,
    wetnessIntervalMs,
    makeSessionId: () => `test-${++id}`,
    onEvent: event => events.push(event),
  });
  return { session, events, at: (ms: number) => { wall = ms; session.advanceTo(); } };
}

test('rain is measured by exposure time and independent of cadence', () => {
  const fine = harness();
  const coarse = harness();
  for (let ms = 27; ms < 3456; ms += 27) fine.at(ms);
  fine.at(3456);
  coarse.at(3456);
  assert.deepEqual(fine.session.snapshot(), coarse.session.snapshot());
  assert.deepEqual(fine.events, coarse.events);
  assert.equal(fine.session.snapshot().world.objects.papers.wetness, 3);
  assert.equal(fine.session.snapshot().world.turn, 0);
  assert.equal(advanceRain(createWorld()).turn, 1);
});

test('shelter retains partial exposure and pickup stops rain', () => {
  const { session, at } = harness();
  assert.ok(session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } }).ok);
  assert.ok(session.dispatch('player', { type: 'move', to: { x: 5, y: 1 } }).ok);
  at(600);
  assert.ok(session.dispatch('player', { type: 'close' }).ok);
  at(6000);
  assert.equal(session.snapshot().world.objects.papers.wetness, 0);
  assert.ok(session.dispatch('player', { type: 'open' }).ok);
  at(6400);
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
  assert.ok(session.dispatch('player', { type: 'pickUp', objectId: 'papers' }).ok);
  at(10000);
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
});

test('scheduled callbacks settle in chronological order before a command at the same boundary', () => {
  const { session, events, at } = harness();
  session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } });
  session.scheduleAt(400, () => {
    session.dispatch('player', { type: 'move', to: { x: 5, y: 1 } });
    session.scheduleAt(1000, () => session.dispatch('player', { type: 'close' }));
  });
  at(3500);
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
  assert.deepEqual(events.slice(-3).map(event => [event.kind, event.activeMs, event.wallMs]), [
    ['action', 400, 400], ['rain', 1000, 1000], ['action', 1000, 1000],
  ]);
});

test('hide settles due actions, then freezes movement and rain with a rebase on resume', () => {
  const { session, events, at } = harness();
  session.scheduleAt(500, () => session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } }));
  session.scheduleAt(900, () => session.dispatch('player', { type: 'move', to: { x: 5, y: 1 } }));
  session.setPaused(true, 800);
  assert.deepEqual(session.snapshot().world.actors.player.position, { x: 5, y: 2 });
  at(20000);
  assert.equal(session.snapshot().activeMs, 800);
  assert.equal(session.snapshot().world.objects.papers.wetness, 0);
  assert.equal(session.dispatch('player', { type: 'wait' }).ok, false);
  session.setPaused(false);
  at(20200);
  assert.deepEqual(session.snapshot().world.actors.player.position, { x: 5, y: 1 });
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
  assert.deepEqual(events.slice(-2).map(event => [event.kind, event.activeMs, event.wallMs]), [
    ['action', 900, 20100], ['rain', 1000, 20200],
  ]);
});

test('commits are synchronous, immutable and deterministic under competition', () => {
  const { session, events, at } = harness();
  const modelPending = new Promise(() => {});
  void modelPending;
  assert.ok(session.dispatch('player', { type: 'speak', text: 'I can help.' }).ok);
  session.dispatch('mara', { type: 'putDown', objectId: 'mug1', surfaceId: 'counter' });
  session.dispatch('mara', { type: 'move', to: { x: 3, y: 3 } });
  assert.ok(session.dispatch('player', { type: 'move', to: { x: 4, y: 3 } }).ok);
  assert.equal(session.dispatch('mara', { type: 'move', to: { x: 4, y: 3 } }).ok, false);
  for (const to of [{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 1 }])
    session.dispatch('player', { type: 'move', to });
  for (const to of [{ x: 4, y: 3 }, { x: 5, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 2 }])
    session.dispatch('mara', { type: 'move', to });
  const seen: number[] = [];
  session.subscribe(event => {
    if (event.kind === 'action') seen.push(session.snapshot().revision);
  });
  const first = session.dispatch('player', { type: 'pickUp', objectId: 'papers' });
  const second = session.dispatch('mara', { type: 'pickUp', objectId: 'papers' });
  assert.ok(first.ok);
  assert.equal(second.ok, false);
  assert.equal(second.event?.before, second.event?.after);
  assert.deepEqual(seen, [first.event.revision, first.event.revision]);
  assert.deepEqual(first.event.after.world.objects.papers.location, { heldBy: 'player' });
  assert.throws(() => { first.event.after.world.actors.player.position.x = 99; }, TypeError);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i + 1));
  at(1000);
  assert.equal(session.snapshot().world.objects.papers.wetness, 0);
});

test('rejected commands retain rain already due and restarts drop old callbacks', () => {
  const { session, events, at } = harness();
  const stale = session.snapshot();
  session.scheduleAt(2500, () => assert.fail('Previous session callback executed.'));
  const invalid = session.dispatch('player', { type: 'close' }, 1000);
  assert.equal(invalid.ok, false);
  assert.deepEqual(events.slice(-2).map(event => event.kind), ['rain', 'action']);
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
  session.restart(1100);
  assert.notEqual(session.snapshot().sessionId, stale.sessionId);
  assert.equal(session.snapshot().world.objects.papers.wetness, 0);
  assert.equal(session.snapshot().activeMs, 0);
  assert.equal(events.at(-1)?.sequence, 1);
  at(4000);
  assert.equal(session.snapshot().activeMs, 2900);
  assert.equal(session.snapshot().world.objects.papers.wetness, 2);
  session.dispose();
  at(7000);
  assert.equal(session.snapshot().activeMs, 2900);
});


test('observer pause settles at that boundary and stops an in-progress catch-up', () => {
  const { session, events, at } = harness();
  session.scheduleAt(1200, () => assert.fail('Hidden movement executed.'));
  session.subscribe(event => {
    if (event.kind === 'rain') session.setPaused(true, event.wallMs);
  });
  at(4000);
  assert.equal(session.snapshot().paused, true);
  assert.equal(session.snapshot().activeMs, 1000);
  assert.equal(session.snapshot().world.objects.papers.wetness, 1);
  assert.equal(events.at(-1)?.kind, 'session');
});

test('observer restart neither ages the new scene nor dispatches an old command into it', () => {
  const { session, events, at } = harness();
  const initialId = session.snapshot().sessionId;
  session.subscribe(event => {
    if (event.kind === 'rain' && event.sessionId === initialId) session.restart(4000);
  });
  const result = session.dispatch('player', { type: 'speak', text: 'Old command' }, 4000);
  assert.equal(result.ok, false);
  assert.equal(result.event, undefined);
  assert.notEqual(session.snapshot().sessionId, initialId);
  assert.equal(session.snapshot().activeMs, 0);
  assert.equal(session.snapshot().world.objects.papers.wetness, 0);
  assert.equal(session.snapshot().world.dialogue.length, 0);
  assert.deepEqual(events.slice(-2).map(event => [event.kind, event.sequence]), [
    ['session', 3], ['session', 1],
  ]);
  at(4500);
  assert.equal(session.snapshot().activeMs, 500);
});


test('observer restart records route cancellation in the old session before the new session starts', () => {
  const { session, events, at } = harness();
  const motion = new MovementController(session, 2000);
  const oldId = session.snapshot().sessionId;
  const route = motion.walkTo('player', { x: 5, y: 1 });
  assert.ok(route.ok);
  session.subscribe(event => {
    if (event.kind === 'rain' && event.sessionId === oldId) session.restart(3000);
  });
  at(3000);
  const cancellation = events.find(event => event.kind === 'routeFinished');
  assert.ok(cancellation);
  assert.equal(cancellation.sessionId, oldId);
  assert.equal('outcome' in cancellation && cancellation.outcome, 'canceled');
  assert.equal(events.at(-1)?.kind, 'session');
  assert.notEqual(events.at(-1)?.sessionId, oldId);
  assert.equal(motion.isMoving('player'), false);
});

test('observer disposal delivers ended and route cancellation before clearing listeners', () => {
  const { session, events, at } = harness();
  const motion = new MovementController(session, 2000);
  const route = motion.walkTo('player', { x: 5, y: 1 });
  assert.ok(route.ok);
  session.subscribe(event => {
    if (event.kind === 'rain') session.dispose(3000);
  });
  at(3000);
  assert.equal(events.at(-2)?.kind, 'session');
  const cancellation = events.at(-1);
  assert.ok(cancellation && cancellation.kind === 'routeFinished');
  assert.equal(cancellation.outcome, 'canceled');
  assert.equal(motion.isMoving('player'), false);
});
