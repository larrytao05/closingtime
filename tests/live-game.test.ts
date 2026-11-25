import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { LiveGame } from '../src/live-game';
import { playTurn, type MaraDecision } from '../src/planner';
import { createWorld, layout } from '../src/world';
import type { LiveMaraAction, LiveMaraRequest, LiveMaraResponse } from '../src/live-mara-protocol';

function fixture() {
  let time = 0;
  const pending: { request: LiveMaraRequest; signal: AbortSignal; resolve: (value: LiveMaraResponse) => void }[] = [];
  const game = new LiveGame({
    now: () => time,
    onAction: () => {},
    onChange: () => {},
    request: (request, signal) => new Promise(resolve => pending.push({ request, signal, resolve })),
  });
  return {
    game, pending,
    advance(ms: number) {
      time += ms;
      game.frame();
    },
    elapseWithoutFrame(ms: number) { time += ms; },
    complete(index: number, action: LiveMaraAction) {
      const { request, resolve } = pending[index];
      const { mode, sessionId, requestId, ...context } = request;
      const rationale = 'I can take care of the papers.';
      resolve({
        mode, sessionId, requestId,
        decision: { action, actionId: '0', model: 'fixture', rationale },
        observation: {
          ...context, layout, floorMap: [], mapLegend: '',
          availableActions: [{ ...action, id: '0' }],
        },
      });
    },
  };
}

test('baseline still couples accepted actions, Gemini and rain, and failures commit nothing', async () => {
  const initial = createWorld();
  let calls = 0;
  const reply = { action: { type: 'wait' }, actionId: '0', rationale: 'I can wait.', model: 'fixture' } as const;
  const decision: MaraDecision = { ...reply, legalActions: [{ id: '0', type: 'wait' }] };
  const wait = () => { calls++; return Promise.resolve(decision); };
  const rejected = await playTurn(initial, { type: 'close' }, [], wait);
  assert.equal(rejected.ok, false);
  assert.equal(calls, 0);
  const next = await playTurn(initial, { type: 'move', to: { x: 5, y: 2 } }, [], wait);
  assert.ok(next.ok);
  assert.equal(calls, 1);
  assert.deepEqual(next.world.actors.player.position, { x: 5, y: 2 });
  assert.equal(next.world.turn, 1);
  assert.equal(next.world.objects.papers.wetness, 1);
  assert.equal(next.trace.observation.world.turn, 0);
  await assert.rejects(playTurn(initial, { type: 'wait' }, [], async () => { throw Error('fixture'); }));
  assert.deepEqual(initial, createWorld());
});

test('independent movement, exposure and interaction while the model is unresolved', async () => {
  const f = fixture();
  try {
    f.game.frame();
    assert.equal(f.pending.length, 1);
    assert.ok(f.game.walk({x:5,y:1}).ok);
    f.advance(4100);
    assert.deepEqual(f.game.snapshot.world.actors.player.position, {x:5,y:1});
    assert.equal(f.game.snapshot.world.objects.papers.wetness, 1);
    assert.ok(f.game.act({type:'pickUp',objectId:'papers'}).ok);
    assert.ok(f.game.act({type:'close'}).ok);
    f.advance(5000);
    assert.equal(f.game.snapshot.world.objects.papers.wetness, 1);
    assert.equal(f.pending.length, 1);
    f.complete(0, {type:'wait'});
    await flush();
    assert.equal(f.game.selected?.type, 'wait');
    assert.match(f.game.rationale, /care of the papers/);
    assert.equal(f.game.outcome, 'Applied.');
    assert.equal(f.pending.length, 2, 'world changes coalesce to one fresh request');
    f.complete(1, {type:'wait'});
    await flush();
  } finally { f.game.dispose(); }
});

test('pause and restart isolate delayed results and preserve both audit sessions', async () => {
  const f = fixture();
  try {
    f.game.frame();
    const first = f.game.snapshot.sessionId;
    f.game.setPaused(true);
    assert.ok(f.pending[0].signal.aborted);
    const paused = f.game.snapshot.activeMs;
    f.advance(10_000);
    assert.equal(f.game.snapshot.activeMs, paused);
    f.game.setPaused(false);
    assert.equal(f.pending.length, 1);
    f.game.restart();
    const fresh = f.game.snapshot.sessionId;
    assert.notEqual(fresh, first);
    assert.equal(f.pending.length, 2);
    f.complete(1, {type:'speak',text:'New scene'});
    await flush();
    f.complete(0, {type:'speak',text:'Old scene'});
    await flush();
    assert.deepEqual(f.game.snapshot.world.dialogue, [{actor:'mara',text:'New scene'}]);
    const exported = JSON.parse(f.game.trace.toJSON()) as {
      sessions: { sessionId: string; events: { kind: string; requestId?: string }[] }[];
    };
    const oldSession = exported.sessions.find(s => s.sessionId === first);
    const newSession = exported.sessions.find(s => s.sessionId === fresh);
    assert.ok(oldSession?.events.some(e => e.kind === 'decisionCanceled'));
    assert.ok(newSession?.events.some(e => e.kind === 'decisionReceived'));
    assert.ok(!newSession.events.some(e => e.requestId === f.pending[0].request.requestId));
  } finally { f.game.dispose(); }
});


test('audit UI reports a rejected route with the recorded reason', async () => {
  const f = fixture();
  try {
    f.game.frame();
    const target = {x:5,y:2};
    assert.ok(f.game.walk(target).ok);
    f.advance(500);
    f.complete(0, {type:'walkTo',to:target});
    await flush();
    assert.equal(f.game.selected?.type, 'walkTo');
    assert.match(f.game.outcome, /^Skipped\. Choose a reachable, unoccupied floor tile\./);
    assert.equal(f.pending.length, 1);
  } finally { f.game.dispose(); }
});


test('a restart during clock advancement keeps a stale walk and old status out of the fresh scene', async () => {
  const f = fixture();
  try {
    f.game.frame();
    const first = f.game.snapshot.sessionId;
    const unsubscribe = f.game.session.subscribe(event => {
      if (event.kind !== 'rain') return;
      unsubscribe();
      f.game.restart();
    });
    f.elapseWithoutFrame(4500);
    f.complete(0, {type:'walkTo',to:{x:4,y:0}});
    await flush();
    const fresh = f.game.snapshot.sessionId;
    assert.notEqual(fresh, first);
    assert.equal(f.game.selected, undefined);
    assert.equal(f.game.outcome, '');
    assert.deepEqual(f.game.snapshot.world.actors.mara.position, {x:2,y:3});
    assert.equal(f.pending.length, 1);
    f.game.frame();
    assert.equal(f.pending.length, 2);
    assert.equal(f.pending[1].request.sessionId, fresh);
    f.complete(1, {type:'wait'});
    await flush();
  } finally { f.game.dispose(); }
});
