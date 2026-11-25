import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

const [checkout, mode, ...extra] = process.argv.slice(2);
assert.ok(checkout && (!mode || mode === '--gemini') && !extra.length,
  'Usage: node verify.mjs CHECKOUT [--gemini]');
const root = resolve(checkout);
const useGemini = mode === '--gemini';
if (useGemini && !process.env.GEMINI_API_KEY) {
  const dotenv = await readFile(join(root, '.env'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  if (!parseEnv(dotenv).GEMINI_API_KEY) {
    console.error('BLOCKED Gemini verification: GEMINI_API_KEY is missing from the environment and checkout .env.');
    process.exit(1);
  }
}

const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const dir = await mkdtemp(join(tmpdir(), 'closing-time-verify-'));

try {
  await build({
    entryPoints: ['world', 'planner', 'trace-log', 'movement'].map(name => join(root, 'src', name + '.ts')),
    bundle: true, outdir: dir, outExtension: { '.js': '.mjs' }, format: 'esm',
  });
  const load = file => import(pathToFileURL(join(dir, file)));
  const { createWorld, actionsFor, advanceRain } = await load('world.mjs');
  const { playTurn } = await load('planner.mjs');
  const { reachableTiles } = await load('movement.mjs');
  const { TraceLog } = await load('trace-log.mjs');

  let requestDecision;
  if (useGemini) {
    const origin = 'http://127.0.0.1:4173';
    for (const path of ['/', '/?mode=live', '/?mode=unknown']) {
      const page = await fetch(origin + path, { redirect: 'error', signal: AbortSignal.timeout(5000) });
      assert.equal(page.status, 200, path);
      assert.match(await page.text(), /Export turn traces/);
    }
    console.log('PASS local server serves the game shell for both modes and the unknown-mode URL');
    requestDecision = (observation, method = 'POST') => fetch(origin + '/api/mara', {
      method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(observation) } : {}),
    });
  } else {
    const { default: worker } = await import(pathToFileURL(join(root, 'dist/server/index.js')));
    const origin = 'https://closing-time.test';
    const page = await worker.fetch(new Request(origin), {});
    const html = await page.text();
    assert.match(html, /Export turn traces/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    console.log('PASS built page exposes audit controls with bundled JavaScript');
    globalThis.fetch = async (_endpoint, options) => {
      const payload = JSON.parse(options.body);
      assert.match(payload.systemInstruction.parts[0].text, /You are Mara/);
      assert.ok(payload.generationConfig.responseJsonSchema.required.includes('rationale'));
      const input = JSON.parse(payload.contents[0].parts[0].text);
      const move = input.availableActions.find(action => ['move', 'walkTo'].includes(action.type));
      const reply = { actionId: move.id, speech: null, rationale: 'I can take a step toward the work.' };
      return Response.json({
        modelVersion: 'fixture-model',
        candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }],
      });
    };
    requestDecision = (observation, method = 'POST') => worker.fetch(new Request(origin + '/api/mara', {
      method, headers: { Origin: origin, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(observation) } : {}),
    }), { GEMINI_API_KEY: 'stub' });
  }

  assert.equal((await requestDecision({}, 'GET')).status, 405);
  assert.equal((await requestDecision({})).status, 400);
  assert.equal((await requestDecision({ mode: 'live' })).status, 400);
  console.log('PASS invalid HTTP method and malformed observations in both modes');

  const start = createWorld();
  const near = { ...start, turn: 2,
    actors: { ...start.actors, player: { position: {x:5,y:1} } },
    objects: { ...start.objects,
      papers: { ...start.objects.papers, wetness: 2 },
      mug1: { ...start.objects.mug1, location: {surface:'counter'} },
    },
  };
  const papersHeld = { ...near, actors: start.actors,
    objects: { ...near.objects, papers: { ...near.objects.papers, location: {heldBy:'player'} } },
  };
  const scenarios = [
    ['wait baseline, Mara’s hands full', start, {type:'wait'}],
    ['player closes the window', near, {type:'close'}],
    ['player picks up the papers', near, {type:'pickUp',objectId:'papers'}],
    ['player offers to close the window', start, {type:'speak',text:'My hands are free. I’ll close the window. Could you get the papers away from the rain?'}],
    ['player asks for paper status while holding them', papersHeld, {type:'speak',text:'These look damp. How are the papers doing?'}],
  ];
  const speech = { type: 'speak', text: 'I have the papers. Could you close the window?' };
  const liveScenarios = [
    { label: 'rain at scene start', world: start },
    { label: 'player just closed the window', world: actionsFor(near, 'player').execute({ type: 'close' }).world,
      event: { type: 'room', actor: 'player', action: { type: 'close' } } },
    { label: 'player holds the papers and speaks while Mara walks',
      world: actionsFor(papersHeld, 'player').execute(speech).world,
      event: { type: 'player-speech', actor: 'player', action: speech },
      route: { to: { x: 3, y: 3 }, commandId: 'verify-route' }, reserved: [{ x: 5, y: 2 }] },
  ];

  let httpFailures = 0;
  async function getDecision(observation, label) {
    const started = performance.now();
    const response = await requestDecision(observation);
    const elapsedMs = Math.round(performance.now() - started);
    if (!response.ok) {
      assert.ok(useGemini, label + ': unexpected fixture HTTP ' + response.status);
      const body = await response.json().catch(() => null);
      const reasons = ['unavailable', 'rate-limited', 'timeout', 'provider-error', 'invalid-response'];
      const reason = reasons.includes(body?.reason) ? ' ' + body.reason : '';
      console.error(`FAIL ${label}: HTTP ${response.status}${reason} (${elapsedMs} ms)`);
      httpFailures++;
      return;
    }
    return { result: await response.json(), elapsedMs };
  }

  for (const [revision, { label, world, event, route, reserved = [] }] of liveScenarios.entries()) {
    const request = {
      mode: 'live', sessionId: 'verify-live', requestId: 'verify-' + revision,
      revision, activeMs: revision * 1200, world, moving: !!route, reserved,
      intent: { active: route ?? null, queued: null }, recentEvents: event ? [event] : [],
    };
    const name = 'real-time: ' + label;
    const reply = await getDecision(request, name);
    if (!reply) continue;
    const { result: { mode, sessionId, requestId, observation, decision }, elapsedMs } = reply;
    assert.equal(mode, 'live', name);
    assert.equal(sessionId, request.sessionId, name);
    assert.equal(requestId, request.requestId, name);
    const { availableActions, floorMap, layout, mapLegend, ...state } = observation;
    assert.deepEqual(state, {
      activeMs: request.activeMs, revision, world, moving: request.moving, reserved,
      recentEvents: request.recentEvents, intent: { active: route?.to ?? null, queued: null },
    }, name);
    assert.equal(floorMap.length, layout.height, name);
    assert.ok(mapLegend, name);
    const legal = actionsFor(world, 'mara');
    assert.deepEqual(availableActions, [
      ...reachableTiles(world, 'mara', reserved).map(to => ({ type: 'walkTo', to })),
      ...legal.interactions().filter(action => !request.moving || action.type === 'wait'),
      { type: 'speak' },
    ].map((action, index) => ({ ...action, id: String(index) })), name);
    const chosen = availableActions.find(option => option.id === decision.actionId);
    assert.ok(chosen && chosen.type === decision.action.type, name);
    if (chosen.type === 'speak') {
      assert.ok(legal.allows(decision.action), name);
    } else {
      const { id, ...action } = chosen;
      assert.deepEqual(decision.action, action, name);
    }
    assert.ok(decision.rationale.trim() && decision.model.trim(), name);
    console.log(JSON.stringify({ scenario: name, model: decision.model, elapsedMs,
      action: decision.action, rationale: decision.rationale, choices: availableActions.length }));
  }

  const entries = new Map();
  globalThis.localStorage = {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index],
    getItem: key => entries.get(key) ?? null,
    setItem: (key,value) => entries.set(key,value),
  };
  const log = new TraceLog();

  for (const [label, world, playerAction] of scenarios) {
    let elapsedMs;
    const providerFailure = new Error('Turn-based inference failed');
    const run = await playTurn(world, playerAction, [], async observation => {
      const reply = await getDecision(observation, 'turn-based: ' + label);
      if (!reply) throw providerFailure;
      elapsedMs = reply.elapsedMs;
      return reply.result;
    }).catch(error => {
      if (error !== providerFailure) throw error;
    });
    if (!run) continue;
    assert.ok(run.ok);
    const { trace } = run;
    const { observation, decision } = trace;
    assert.deepEqual(trace.worldBefore, world);
    assert.deepEqual(observation.playerAction, playerAction);
    const playerResult = actionsFor(world, 'player').execute(playerAction);
    assert.ok(playerResult.ok);
    assert.deepEqual(observation.world, playerResult.world);
    const options = actionsFor(observation.world, 'mara');
    const listed = decision.legalActions.map(({id, ...action}, i) => {
      assert.equal(id, String(i));
      return action;
    });
    assert.deepEqual(listed, [...options.moves(), ...options.interactions(), {type:'speak'}]);
    const chosen = decision.legalActions.find(option => option.id === decision.actionId);
    assert.ok(chosen && chosen.type === decision.action.type);
    if (chosen.type !== 'speak') {
      const { id, ...action } = chosen;
      assert.deepEqual(decision.action, action);
    }
    assert.ok(decision.rationale.trim());
    assert.ok(decision.model);
    const applied = options.execute(decision.action);
    assert.ok(applied.ok, 'Selected action failed validation');
    assert.deepEqual(trace.worldAfter, advanceRain(applied.world));
    log.append({ sessionId: label, recordedAt: new Date().toISOString(), ...trace });
    console.log(JSON.stringify({ scenario: label, action: decision.action, rationale: decision.rationale,
      model: decision.model, elapsedMs, choices: listed.length, wetness: trace.worldAfter.objects.papers.wetness }));
  }

  if (!useGemini) {
    const reload = new TraceLog();
    const exported = JSON.parse(reload.toJSON());
    assert.equal(exported.schemaVersion, 1);
    assert.equal(exported.turns.length, scenarios.length);
    const [sample] = exported.turns;
    for (const name of ['sessionId', 'recordedAt', 'worldBefore', 'observation', 'decision', 'worldAfter']) {
      assert.ok(name in sample);
    }
    localStorage.setItem = () => { throw Error('quota fixture'); };
    reload.append({ ...sample, sessionId: 'quota fixture' });
    assert.ok(reload.needsExport);
    assert.equal(JSON.parse(reload.toJSON()).turns.length, scenarios.length + 1);

    await assert.rejects(playTurn(start, {type:'wait'}, [], async () => { throw Error('model failure fixture'); }));
    assert.deepEqual(start, createWorld());
    assert.equal((await playTurn(start, {type:'close'}, [], () => {
      throw Error('Called model for an illegal player action');
    })).ok, false);
    console.log('PASS export schema, persistence on reopening the log, quota fallback, and invalid/failed turns');
  }

  assert.equal(httpFailures, 0, 'One or more local inference requests failed.');
  console.log(useGemini ? 'PASS local Gemini inference in both game modes' : 'PASS local fixture contracts in both game modes');
} finally {
  await rm(dir, { recursive: true, force: true });
}
