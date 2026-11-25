import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaraController, type LiveMaraAuditEvent } from '../src/mara-controller';
import { chooseLiveMara } from '../src/mara';
import { LiveMaraRequestError, readLiveMaraRequest, requestLiveMara,
  type LiveMaraRequest, type LiveMaraResponse, type LiveMaraAction, type LiveMaraSnapshot,
} from '../src/live-mara-protocol';
import { layout, type World } from '../src/world';
import { RealtimeSession } from '../src/realtime';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const wait: LiveMaraAction = { type: 'wait' };

function harness(limits: ConstructorParameters<typeof MaraController>[0]['limits'] = {}) {
  let wall = 0;
  let sessionNumber = 0;
  const session = new RealtimeSession({ now: () => wall, makeSessionId: () => 'scene-' + ++sessionNumber });
  let motion: Pick<LiveMaraSnapshot, 'intent' | 'moving' | 'reserved'> = {
    intent: { active: null, queued: null }, moving: false, reserved: [],
  };
  const readSnapshot = () => ({ ...session.snapshot(), ...motion });
  const calls: { observation: LiveMaraRequest; signal: AbortSignal;
    resolve: (response: LiveMaraResponse) => void; reject: (error: unknown) => void }[] = [];
  const decisions: LiveMaraAction[] = [];
  let walkStatus: 'started' | 'noop' = 'started';
  const events: LiveMaraAuditEvent[] = [];
  let auditHook: ((event: LiveMaraAuditEvent) => void) | undefined;
  const status: string[] = [];
  const timers = new Set<{ at: number; callback: () => void }>();
  const controller = new MaraController({
    readSnapshot,
    request: (observation, signal) => new Promise((resolve, reject) => calls.push({ observation, signal, resolve, reject })),
    dispatch: action => {
      decisions.push(action);
      if (action.type === 'walkTo') return { ok: true, status: walkStatus };
      return session.dispatch('mara', action);
    },
    audit: event => {
      events.push(event);
      auditHook?.(event);
    },
    status: value => status.push(value),
    timing: {
      now: () => wall,
      schedule(callback, delayMs) {
        const item = { at: wall + delayMs, callback };
        timers.add(item);
        return () => { timers.delete(item); };
      },
    },
    limits,
  });
  const advance = (ms: number) => {
    wall += ms;
    session.advanceTo(wall);
    for (const entry of timers) {
      if (entry.at > wall) continue;
      timers.delete(entry);
      entry.callback();
    }
    controller.update();
  };
  const apply = (i: number, action: LiveMaraAction = wait) => {
    const call = calls[i];
    call.resolve({
      mode: 'live',
      sessionId: call.observation.sessionId,
      requestId: call.observation.requestId,
      observation: { ...call.observation, layout, floorMap: [], mapLegend: '', availableActions: [] },
      decision: { action, actionId: '0', rationale: 'fixture', model: 'fixture' },
    });
  };
  const change = (event: Parameters<typeof controller.materialChange>[0]) => {
    controller.materialChange(event);
    controller.update();
  };
  const pose = (next: typeof motion) => { motion = next; };
  controller.update();
  const finishWalkAsNoop = () => { walkStatus = 'noop'; };
  const onAudit = (hook: typeof auditHook) => { auditHook = hook; };
  return { controller, session, calls, decisions, events, status, advance, apply, change, pose, finishWalkAsNoop, onAudit };
}

test('model requests never gate player actions or rain, and a burst coalesces to the latest context', async () => {
  const h = harness();
  const first = h.calls[0].observation;
  assert.equal(h.session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } }).ok, true);
  h.advance(4000);
  assert.equal(h.session.snapshot().world.objects.papers.wetness, 1);
  assert.equal(h.calls.length, 1, 'rain and movement alone do not request');
  assert.equal(h.session.dispatch('player', { type: 'speak', text: 'First statement' }).ok, true);
  h.change({ type: 'player-speech', actor: 'player', action: { type: 'speak', text: 'First statement' } });
  assert.equal(h.session.dispatch('player', { type: 'speak', text: 'Latest statement' }).ok, true);
  h.change({ type: 'player-speech', actor: 'player', action: { type: 'speak', text: 'Latest statement' } });
  assert.equal(h.calls.length, 1);
  h.apply(0, { type: 'speak', text: 'Old reply' });
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(first.world.dialogue.length, 0);
  assert.equal(h.calls[1].observation.world.dialogue.at(-1)?.text, 'Latest statement');
  assert.deepEqual(h.decisions, []);
  const skipped = h.events.find(e => e.kind === 'decisionSkipped');
  assert.equal(skipped?.reason, 'Newer player dialogue arrived.');
  assert.equal(skipped?.effectiveSnapshot.world.dialogue.at(-1)?.text, 'Latest statement');
});

test('accepted target revisions while walking preserve the old route until a replacement', async () => {
  const h = harness();
  const initial = { type: 'walkTo' as const, to: { x: 4, y: 1 } };
  h.apply(0, initial);
  await settle();
  h.pose({ intent: { active: { to: initial.to, commandId: 'original' }, queued: null }, moving: true, reserved: [] });
  assert.equal(h.session.dispatch('player', { type: 'move', to: { x: 5, y: 2 } }).ok, true);
  assert.equal(h.session.dispatch('player', { type: 'move', to: { x: 5, y: 1 } }).ok, true);
  assert.equal(h.session.dispatch('player', { type: 'close' }).ok, true);
  h.change({ type: 'room', actor: 'player', action: { type: 'close' } });
  h.advance(1000);
  assert.equal(h.calls[1].observation.world.windowOpen, false);
  assert.deepEqual(h.calls[1].observation.intent.active?.to, initial.to);
  h.apply(1, { type: 'putDown', objectId: 'mug1', surfaceId: 'counter' });
  await settle();
  assert.deepEqual(h.decisions, [initial]);
  assert.equal(h.events.find(e => e.kind === 'decisionSkipped')?.reason, 'Mara is between tiles.');
  h.advance(1000);
  assert.equal(h.calls.length, 3, 'reconsider once after the rejected response');
  const replacement = { type: 'walkTo' as const, to: { x: 3, y: 2 } };
  h.apply(2, replacement);
  await settle();
  assert.deepEqual(h.decisions, [initial, replacement]);
});

test('unchanged legal actions survive passive ticks and invalid choices do not deadlock', async () => {
  const h = harness();
  h.advance(4000);
  h.apply(0, { type: 'putDown', objectId: 'mug1', surfaceId: 'counter' });
  await settle();
  assert.equal(h.decisions.length, 1);
  h.change({ type: 'room' });
  h.advance(1000);
  h.apply(1, { type: 'putDown', objectId: 'mug1', surfaceId: 'counter' });
  await settle();
  const skipped = h.events.find(e => e.kind === 'decisionSkipped');
  assert.match(skipped?.reason ?? '', /holding/);
  assert.equal(skipped?.effectiveSnapshot.revision, h.session.snapshot().revision);
  h.advance(1000);
  assert.equal(h.calls.length, 3);
  h.apply(2, wait);
  await settle();
  assert.equal(h.decisions.at(-1)?.type, 'wait');
});

test('reset rejects the oldest response even when it arrives last', async () => {
  const h = harness();
  h.session.restart();
  h.controller.update();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].signal.aborted, true);
  h.apply(1, wait);
  await settle();
  h.apply(0, { type: 'speak', text: 'Old scene' });
  await settle();
  assert.deepEqual(h.decisions, [wait]);
  assert.equal(h.session.snapshot().world.dialogue.length, 0);
  assert.equal(h.events.filter(event => event.kind === 'decisionReceived').length, 1);
});

test('pause cancels without applying; deadline releases a transport that ignores abort', async () => {
  const h = harness({ deadlineMs: 60, minimumSpacingMs: 0 });
  h.session.setPaused(true);
  h.controller.update();
  assert.equal(h.calls[0].signal.aborted, true);
  h.session.setPaused(false);
  h.controller.update();
  assert.equal(h.calls.length, 1);
  h.advance(60);
  await settle();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].observation.activeMs, 60);
  h.apply(0, { type: 'speak', text: 'Late canceled reply' });
  await settle();
  assert.deepEqual(h.decisions, []);
  h.apply(1, wait);
  await settle();
  assert.deepEqual(h.decisions, [wait]);
  assert.equal(h.events.filter(event => event.kind === 'decisionCanceled').length, 1);
});

test('waits stop polling and restart on material activity, with a hard attempt cap', async () => {
  const h = harness({ maxAttempts: 4 });
  for (let i = 0; i < 3; i++) {
    h.apply(i);
    await settle();
    h.advance(3000);
  }
  h.advance(12000);
  assert.equal(h.calls.length, 3);
  h.change({ type: 'room' });
  assert.equal(h.calls.length, 4);
  h.apply(3);
  await settle();
  h.change({ type: 'room' });
  h.advance(12000);
  assert.equal(h.calls.length, 4);
  assert.match(h.status.at(-1) ?? '', /request limit/);
});

test('429 and finite wall-time backoffs retry twice until new activity', async () => {
  const h = harness();
  h.calls[0].reject(new LiveMaraRequestError('rate-limited', 5000));
  await settle();
  h.advance(4999);
  assert.equal(h.calls.length, 1);
  h.advance(1);
  assert.equal(h.calls.length, 2);
  h.calls[1].reject(new LiveMaraRequestError('provider-error'));
  await settle();
  h.advance(3999);
  assert.equal(h.calls.length, 2);
  h.advance(1);
  assert.equal(h.calls.length, 3);
  h.calls[2].reject(new LiveMaraRequestError('timeout'));
  await settle();
  h.advance(10000);
  assert.equal(h.calls.length, 3);
  h.change({ type: 'room' });
  assert.equal(h.calls.length, 4);
  assert.equal(h.events.filter(event => event.kind === 'decisionRetryScheduled').length, 2);
});

test('Gemini and audit receive an identical game projection, excluding session IDs and secrets', async () => {
  const h = harness();
  const request = structuredClone(h.calls[0].observation) as LiveMaraRequest;
  h.controller.dispose();
  const world = request.world as World & { arbitrary?: string };
  world.arbitrary = 'omit this';
  request.moving = true;
  request.intent.active = { to: { x: 4, y: 1 }, commandId: 'internal-id' };
  const parsed = readLiveMaraRequest(request);
  assert.ok(parsed);
  assert.equal(readLiveMaraRequest({ ...request, recentEvents: [{}] }), undefined);

  const original = globalThis.fetch;
  let providerProjection: unknown;
  let requestedOption: unknown;
  try {
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      const projection = JSON.parse(payload.contents[0].parts[0].text);
      providerProjection = projection;
      assert.equal(projection.sessionId, undefined);
      assert.equal(projection.requestId, undefined);
      assert.equal(projection.world.arbitrary, undefined);
      assert.deepEqual(projection.intent.active, { x: 4, y: 1 });
      assert.ok(!projection.availableActions.some((action: { type: string }) => action.type === 'putDown'));
      requestedOption = projection.availableActions.find((action: { type: string }) => action.type === 'walkTo');
      const id = (requestedOption as { id: string }).id;
      return Response.json({ modelVersion: 'fixture', candidates: [{ content: { parts: [{ text: JSON.stringify({
        actionId: id, speech: null, rationale: 'Walk toward the window.',
      }) }] } }] });
    };
    const result = await chooseLiveMara(parsed, { GEMINI_API_KEY: 'unused-local-fixture' }, new AbortController().signal);
    assert.deepEqual(JSON.parse(JSON.stringify(result.observation)), providerProjection);
    assert.equal(result.decision.action.type, 'walkTo');
    assert.equal(result.decision.actionId, (requestedOption as { id: string }).id);
  } finally {
    globalThis.fetch = original;
  }
});


test('a late route already reached does not show walking or start an unbounded reconsideration loop', async () => {
  const h = harness();
  h.finishWalkAsNoop();
  const route = { type: 'walkTo' as const, to: { x: 3, y: 3 } };
  h.apply(0, route);
  await settle();
  assert.equal(h.status.at(-1), 'Mara is ready.');
  h.advance(1000);
  assert.equal(h.calls.length, 2);
  h.apply(1, route);
  await settle();
  h.advance(10000);
  assert.equal(h.calls.length, 2);
});

test('browser rejects a response whose action disagrees with its selection ID', async () => {
  const h = harness();
  const request = h.calls[0].observation;
  h.controller.dispose();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({
      mode: 'live', sessionId: request.sessionId, requestId: request.requestId,
      observation: { availableActions: [{ id: '0', type: 'walkTo', to: { x: 4, y: 1 } }] },
      decision: { actionId: '0', action: { type: 'walkTo', to: { x: 4, y: 2 } },
        rationale: 'I can reach the papers.', model: 'fixture' },
    });
    await assert.rejects(requestLiveMara(request, new AbortController().signal),
      (error: unknown) => error instanceof LiveMaraRequestError && error.reason === 'invalid-response');
  } finally {
    globalThis.fetch = original;
  }
});


test('synchronous restart during decision receipt neither dispatches nor double-terminates the old request', async () => {
  const h = harness();
  h.onAudit(event => {
    if (event.kind !== 'decisionReceived') return;
    h.session.restart();
    h.controller.update();
  });
  h.apply(0, { type: 'speak', text: 'Old scene' });
  await settle();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.decisions, []);
  assert.equal(h.events.filter(event => event.kind === 'decisionCanceled').length, 0);
  h.onAudit(undefined);
  h.apply(1, wait);
  await settle();
  assert.deepEqual(h.decisions, [wait]);
});

test('disposal during the decisionRequested event prevents sending the transport', async () => {
  const h = harness();
  h.apply(0, wait);
  await settle();
  h.onAudit(event => {
    if (event.kind === 'decisionRequested') h.controller.dispose();
  });
  h.change({ type: 'room' });
  h.advance(1000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.events.filter(event => event.kind === 'decisionCanceled').length, 1);
});
