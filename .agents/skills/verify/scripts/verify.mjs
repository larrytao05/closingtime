import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [checkout, mode, liveUrl] = process.argv.slice(2);
assert.ok(checkout, 'Usage: node verify.mjs CHECKOUT [--live SITE_URL]');
const root = resolve(checkout);
const require = createRequire(join(root, 'package.json'));
const { build } = require('esbuild');
const dir = await mkdtemp(join(tmpdir(), 'closing-time-verify-'));

try {
  await build({
    entryPoints: ['world', 'planner', 'trace-log'].map(name => join(root, 'src', name + '.ts')),
    bundle: true, outdir: dir, outExtension: { '.js': '.mjs' }, format: 'esm',
  });
  const load = file => import(pathToFileURL(join(dir, file)));
  const { createWorld, actionsFor, advanceRain } = await load('world.mjs');
  const { playTurn } = await load('planner.mjs');
  const { TraceLog } = await load('trace-log.mjs');

  let requestDecision;
  if (mode === '--live') {
    const origin = new URL(liveUrl).origin;
    let token = '';
    for await (const chunk of process.stdin) token += chunk;
    const key = token.trim();
    assert.ok(key, 'Supply the authorized Site service token on stdin.');
    const auth = { 'OAI-Sites-Authorization': 'Bearer ' + key };
    const page = await fetch(origin, { headers: auth, redirect: 'error', signal: AbortSignal.timeout(20000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Export turn traces/);
    console.log('PASS live page exposes audit controls');
    requestDecision = async (observation, method = 'POST') => {
      const response = await fetch(origin + '/api/mara', {
        method, redirect: 'error', signal: AbortSignal.timeout(24000),
        headers: { ...auth, Origin: origin, 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify(observation) } : {}),
      });
      return response;
    };
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
      const move = input.availableActions.find(action => action.type === 'move');
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
  console.log('PASS invalid HTTP method and malformed observation');

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
    ['wait baseline, both hands full', start, {type:'wait'}],
    ['player closes the window', near, {type:'close'}],
    ['player picks up the papers', near, {type:'pickUp',objectId:'papers'}],
    ['player offers to close the window', start, {type:'speak',text:'My hands are free. I’ll close the window. Could you get the papers away from the rain?'}],
    ['player asks for paper status while holding them', papersHeld, {type:'speak',text:'These look damp. How are the papers doing?'}],
  ];
  const entries = new Map();
  globalThis.localStorage = {
    get length() { return entries.size; },
    key: index => [...entries.keys()][index],
    getItem: key => entries.get(key) ?? null,
    setItem: (key,value) => entries.set(key,value),
  };
  const log = new TraceLog();

  for (const [label, world, playerAction] of scenarios) {
    const run = await playTurn(world, playerAction, [], async observation => {
      const response = await requestDecision(observation);
      assert.equal(response.status, 200, label);
      return response.json();
    });
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
      model: decision.model, choices: listed.length, wetness: trace.worldAfter.objects.papers.wetness }));
  }

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
} finally {
  await rm(dir, { recursive: true, force: true });
}
