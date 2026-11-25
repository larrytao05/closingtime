import assert from 'node:assert/strict';
import test from 'node:test';
import { findRoute, MovementController, reachableTiles } from '../src/movement';
import { RealtimeSession, type SessionEvent } from '../src/realtime';
import { createWorld, type ActorId } from '../src/world';

function fixture() {
  let wall = 0;
  let scene = 0;
  const events: SessionEvent[] = [];
  const session = new RealtimeSession({
    now: () => wall,
    makeSessionId: () => 'test-' + ++scene,
    onEvent: event => events.push(event),
  });
  const movement = new MovementController(session, 180);
  const advance = (time: number) => { wall = time; session.advanceTo(); };
  const position = (actor: ActorId) => session.snapshot().world.actors[actor].position;
  const finish = (id: string) => events
    .filter(event => event.kind === 'routeFinished' && event.commandId === id)
    .map(event => 'outcome' in event ? event.outcome : undefined);
  return { session, movement, advance, position, finish, events };
}

test('grid routes are stable, cardinal, and exclude walls, other actors, and reserved tiles', () => {
  const world = createWorld();
  assert.deepEqual(findRoute(world, 'player', { x: 4, y: 2 }), [{ x: 5, y: 2 }, { x: 4, y: 2 }]);
  assert.deepEqual(findRoute(world, 'player', { x: 5, y: 3 }), []);
  assert.equal(findRoute(world, 'player', { x: 2, y: 3 }), undefined);
  assert.equal(findRoute(world, 'player', { x: 5, y: 0 }), undefined);
  assert.equal(findRoute(world, 'player', { x: 5.5, y: 3 }), undefined);
  assert.equal(findRoute(world, 'player', { x: 5, y: 2 }, [{ x: 5, y: 2 }]), undefined);
  assert.deepEqual(findRoute(world, 'player', { x: 4, y: 2 }, [{ x: 5, y: 2 }]), [{ x: 4, y: 3 }, { x: 4, y: 2 }]);
  assert.ok(!reachableTiles(world, 'mara', [{ x: 3, y: 3 }]).some(tile => tile.x === 3 && tile.y === 3));
});

test('animation is visual until the active-time step settles and pauses with the scene', () => {
  const { movement, session, advance, position, finish } = fixture();
  const route = movement.walkTo('player', { x: 5, y: 1 });
  assert.ok(route.ok);
  assert.equal(movement.isMoving('player'), true);
  assert.deepEqual(movement.pose('player'), { x: 5, y: 3 });
  advance(90);
  assert.deepEqual(position('player'), { x: 5, y: 3 });
  assert.deepEqual(movement.pose('player'), { x: 5, y: 2.5 });
  assert.deepEqual(movement.reservations(), [{ x: 5, y: 3 }, { x: 5, y: 2 }]);
  session.setPaused(true);
  advance(1090);
  assert.deepEqual(movement.pose('player'), { x: 5, y: 2.5 });
  session.setPaused(false);
  advance(1180);
  assert.deepEqual(position('player'), { x: 5, y: 2 });
  advance(1360);
  assert.deepEqual(position('player'), { x: 5, y: 1 });
  assert.equal(movement.isMoving('player'), false);
  assert.deepEqual(movement.reservations(), []);
  assert.deepEqual(finish(route.commandId), ['arrived']);
});

test('same-tile competition, attempted swaps, and route-step commits respect occupancy', () => {
  const { movement, session, advance, position, finish, events } = fixture();
  movement.walkTo('mara', { x: 3, y: 3 });
  advance(180);
  const player = movement.walkTo('player', { x: 4, y: 3 });
  const denied = movement.walkTo('mara', { x: 4, y: 3 });
  const swap = movement.walkTo('mara', { x: 5, y: 3 });
  assert.equal(player.ok, true);
  assert.equal(denied.ok, false);
  assert.equal(swap.ok, false);
  assert.equal(movement.route('player').active?.commandId, player.commandId);
  assert.equal(session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } }).ok, false);
  advance(360);
  assert.deepEqual(position('player'), { x: 4, y: 3 });
  assert.deepEqual(position('mara'), { x: 3, y: 3 });
  assert.deepEqual(finish(denied.commandId), ['rejected']);
  assert.deepEqual(finish(swap.commandId), ['rejected']);
  assert.deepEqual(finish(player.commandId), ['arrived']);
  assert.ok(movement.canStepTo('player', { x: 4, y: 4 }));
  assert.ok(events.some(event => event.kind === 'action' && event.status === 'completed'
    && event.metadata.routeCommandId === player.commandId && event.metadata.commandId !== player.commandId));
});

test('an unavailable queued replacement leaves the original route running', () => {
  const { movement, advance, position, finish } = fixture();
  const mara = movement.walkTo('mara', { x: 4, y: 3 });
  const player = movement.walkTo('player', { x: 7, y: 3 });
  advance(100);
  const replacement = movement.walkTo('player', { x: 4, y: 3 });
  assert.ok(replacement.ok && replacement.status === 'queued');

  advance(180);
  assert.deepEqual(finish(replacement.commandId), ['blocked']);
  assert.equal(movement.route('player').active?.commandId, player.commandId);
  assert.deepEqual(position('player'), { x: 6, y: 3 });
  advance(360);
  assert.deepEqual(position('player'), { x: 7, y: 3 });
  assert.deepEqual(finish(player.commandId), ['arrived']);
  assert.deepEqual(finish(mara.commandId), ['arrived']);
  assert.deepEqual(movement.reservations(), []);
});

test('queued routes supersede at the tile boundary and rejected replacements keep the prior request', () => {
  const { movement, advance, position, finish } = fixture();
  const first = movement.walkTo('player', { x: 7, y: 3 });
  const earlier = movement.walkTo('player', { x: 7, y: 2 });
  const later = movement.walkTo('player', { x: 6, y: 4 });
  const rejected = movement.walkTo('player', { x: 5, y: 0 });
  assert.ok(later.ok && later.status === 'queued');
  assert.deepEqual(movement.nextTile('player'), { x: 6, y: 3 });
  assert.deepEqual(finish(earlier.commandId), ['superseded']);
  assert.deepEqual(finish(rejected.commandId), ['rejected']);
  assert.equal(movement.route('player').queued?.commandId, later.commandId);

  advance(180);
  assert.deepEqual(position('player'), { x: 6, y: 3 });
  assert.deepEqual(finish(first.commandId), ['superseded']);
  advance(360);
  assert.deepEqual(position('player'), { x: 6, y: 4 });
  assert.deepEqual(finish(later.commandId), ['arrived']);
  const noop = movement.walkTo('player', { x: 6, y: 4 });
  assert.ok(noop.ok && noop.status === 'noop');
  assert.deepEqual(finish(noop.commandId), ['noop']);
});

test('a blocked route terminates at the boundary and a route with a detour stays active', () => {
  const blocked = fixture();
  const first = blocked.movement.walkTo('player', { x: 3, y: 3 });
  blocked.movement.walkTo('mara', { x: 3, y: 3 });
  blocked.advance(180);
  assert.deepEqual(blocked.finish(first.commandId), ['blocked']);
  assert.deepEqual(blocked.position('player'), { x: 4, y: 3 });
  assert.deepEqual(blocked.position('mara'), { x: 3, y: 3 });
  assert.deepEqual(blocked.movement.reservations(), []);

  const detour = fixture();
  detour.movement.walkTo('mara', { x: 4, y: 3 });
  detour.advance(360);
  const second = detour.movement.walkTo('player', { x: 2, y: 4 });
  detour.movement.walkTo('mara', { x: 4, y: 4 });
  detour.advance(540);
  assert.deepEqual(detour.position('player'), { x: 5, y: 4 });
  assert.deepEqual(detour.movement.nextTile('player'), { x: 5, y: 5 });
  detour.advance(1440);
  assert.deepEqual(detour.position('player'), { x: 2, y: 4 });
  assert.deepEqual(detour.finish(second.commandId), ['arrived']);
});

test('speech works during motion while physical actions wait for a settled in-reach actor', () => {
  const { movement, session, advance, position } = fixture();
  movement.walkTo('player', { x: 5, y: 1 });
  assert.equal(session.dispatch('player', { type: 'speak', text: 'I will close it.' }).ok, true);
  assert.equal(session.dispatch('player', { type: 'close' }).ok, false);
  advance(180);
  assert.deepEqual(position('player'), { x: 5, y: 2 });
  assert.equal(session.dispatch('player', { type: 'pickUp', objectId: 'papers' }).ok, false);
  advance(360);
  assert.equal(session.dispatch('player', { type: 'pickUp', objectId: 'papers' }).ok, true);
  assert.equal(session.dispatch('player', { type: 'pickUp', objectId: 'papers' }).ok, false);
});

test('directional takeover and restart cancel active and queued routes once', () => {
  const { movement, session, advance, position, finish, events } = fixture();
  const active = movement.walkTo('player', { x: 7, y: 3 });
  const queued = movement.walkTo('player', { x: 7, y: 2 });
  movement.stopAfterStep('player');
  assert.deepEqual(finish(queued.commandId), ['canceled']);
  advance(180);
  assert.deepEqual(position('player'), { x: 6, y: 3 });
  assert.deepEqual(finish(active.commandId), ['canceled']);
  assert.ok(movement.canStepTo('player', { x: 6, y: 4 }));

  const second = movement.walkTo('player', { x: 6, y: 4 });
  const waiting = movement.walkTo('player', { x: 7, y: 4 });
  const old = session.snapshot().sessionId;
  session.restart();
  assert.notEqual(session.snapshot().sessionId, old);
  assert.deepEqual(movement.reservations(), []);
  assert.deepEqual(finish(second.commandId), ['canceled']);
  assert.deepEqual(finish(waiting.commandId), ['canceled']);
  advance(1000);
  assert.deepEqual(position('player'), { x: 5, y: 3 });
  assert.equal(events.filter(event => event.kind === 'routeFinished' && event.sessionId === old).length, 4);

  session.dispose();
  assert.equal(movement.walkTo('mara', { x: 3, y: 3 }).ok, false);
});

test('a restart requested by an observer of route submission cancels the command in the old scene', () => {
  const { movement, session, advance, position, finish, events } = fixture();
  const oldSession = session.snapshot().sessionId;
  session.subscribe(event => {
    if (event.kind === 'routeSubmitted') {
      assert.equal(movement.isMoving('player'), true);
      session.restart();
    }
  });
  const route = movement.walkTo('player', { x: 7, y: 3 });
  const newSession = session.snapshot().sessionId;
  assert.notEqual(newSession, oldSession);
  assert.deepEqual(finish(route.commandId), ['canceled']);
  assert.ok(events.every(event => !('commandId' in event) || event.commandId !== route.commandId || event.sessionId === oldSession));
  assert.deepEqual(movement.reservations(), []);
  advance(1000);
  assert.deepEqual(position('player'), { x: 5, y: 3 });
});

test('a restart requested while settling a route cannot carry its queued replacement into the new scene', () => {
  const { movement, session, advance, position, finish, events } = fixture();
  const oldSession = session.snapshot().sessionId;
  const original = movement.walkTo('player', { x: 7, y: 3 });
  const replacement = movement.walkTo('player', { x: 6, y: 4 });
  session.subscribe(event => {
    if (event.kind === 'routeFinished' && event.commandId === original.commandId) session.restart();
  });
  advance(180);
  assert.notEqual(session.snapshot().sessionId, oldSession);
  assert.deepEqual(finish(original.commandId), ['superseded']);
  assert.deepEqual(finish(replacement.commandId), ['canceled']);
  assert.ok(events.every(event => !('commandId' in event) || event.commandId !== replacement.commandId || event.sessionId === oldSession));
  assert.deepEqual(movement.reservations(), []);
  advance(1000);
  assert.deepEqual(position('player'), { x: 5, y: 3 });
});
