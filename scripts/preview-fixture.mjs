import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const option = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const workerPath = resolve(option('worker', 'dist/server/index.js'));
const { default: worker } = await import(pathToFileURL(workerPath));
const contexts = new AsyncLocalStorage();
const held = [];
const counts = new Map();
const exportsByRun = new Map();

globalThis.fetch = async (input, { body, signal } = {}) => {
  assert.match(String(input), /^https:\/\/generativelanguage\.googleapis\.com\//, 'Only synthetic Gemini requests are allowed');
  const fixture = contexts.getStore();
  const { contents } = JSON.parse(body);
  const context = JSON.parse(contents[0].parts[0].text);
  const choices = context.availableActions ?? context.options;
  const kind = fixture.scenario;
  const world = context.world;
  const sequence = (counts.get(fixture.key) || 0) + 1;
  counts.set(fixture.key, sequence);
  if (kind === 'failure' || kind === 'rate-limit' && sequence === 1) {
    return new Response(null, { status: 429, headers: { 'Retry-After': '2' } });
  }
  if (kind === 'timeout') {
    await new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  if (kind === 'delay' || kind === 'stale' && choices.some(action => action.type === 'close')) {
    await new Promise((accept, reject) => {
      const entry = { key: fixture.key, accept: () => finish(accept) };
      const finish = (callback, reason) => {
        const index = held.indexOf(entry);
        if (index >= 0) held.splice(index, 1);
        signal.removeEventListener('abort', abort);
        callback(reason);
      };
      const abort = () => finish(reject, signal.reason);
      if (signal.aborted) abort();
      else {
        held.push(entry);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
  }

  if (context.actorId) {
    const addressed = choices.find(candidate => candidate.action?.type === 'speak' && candidate.action.recipient);
    const ownLine = context.witnessedEvents?.map((event, index) => ({ event, index }))
      .find(({ event }) => event.payload?.type === 'speech' && event.payload.actorId === context.actorId);
    const simulationChoice = addressed ?? choices.find(candidate => candidate.action?.type === 'speak') ?? choices.find(candidate => candidate.action?.type === 'wait') ?? choices[0];
    const reply = context.actorId === 'mara' && !ownLine ? 'I’ll check the window once we finish talking.'
      : context.actorId === 'riley' ? 'I can keep an eye on it, Mara.' : 'That sounds good.';
    const simulationOutput = {
      actionId: simulationChoice.actionId,
      reply: simulationChoice.action.type === 'speak' ? reply : null,
      rationale: 'I am responding to what I can see and hear here.',
      memoryProposals: ownLine && context.actorId === 'mara' ? [{ kind: 'open-commitment', sourceEventId: `evidence-${ownLine.index + 1}`, exactLine: ownLine.event.payload.text }] : [],
    };
    return Response.json({ modelVersion: 'browser-fixture', candidates: [{ content: { parts: [{ text: JSON.stringify(simulationOutput) }] } }] });
  }

  const toWindow = candidate => candidate.type === 'walkTo' && candidate.to.x === 4 && candidate.to.y === 0;
  const speech = choices.find(candidate => candidate.type === 'speak');
  const choice = kind === 'route' || kind === 'stale'
    ? choices.find(candidate => world.windowOpen && candidate.type === 'close')
      || choices.find(candidate => world.windowOpen && candidate.type === 'putDown' && candidate.surfaceId === 'counter')
      || choices.find(candidate => world.windowOpen && toWindow(candidate))
      || choices.find(candidate => candidate.type === 'wait')
    : speech;
  assert.ok(choice, 'Fixture could not find its requested option');
  const output = {
    actionId: choice.id,
    speech: choice.type === 'speak' ? 'I see the papers.' : null,
    rationale: choice.type === 'walkTo' ? 'I can reach the window from that tile.'
      : choice.type === 'close' ? 'The open window is letting in rain.'
        : choice.type === 'wait' ? 'The window no longer needs my help.'
          : choice.type === 'putDown' ? 'I need a free hand before I can close the window.'
            : 'I can tell you what I see without moving.',
  };
  return Response.json({ modelVersion: 'browser-fixture', candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] });
};

const fixtureControls = key => `
<aside aria-label="Model fixture" style="position:fixed; bottom:8px; right:8px; padding:8px; background:#21242a">
<button id="release-fixture">Release model response</button> <output id="fixture-count"></output>
</aside>
<script>
const path = '/__fixture?key=' + encodeURIComponent(${JSON.stringify(key)});
async function refreshFixture() {
  const state = await fetch(path).then(response => response.json());
  document.querySelector('#fixture-count').textContent = state.pending + ' pending, ' + state.calls + ' calls, ' + state.exports.length + ' export formats';
}
document.querySelector('#release-fixture').onclick = async () => {
  await fetch(path, { method: 'POST' });
  await refreshFixture();
};
const createObjectURL = URL.createObjectURL.bind(URL);
URL.createObjectURL = blob => {
  const url = createObjectURL(blob);
  if (blob.type === 'application/json' && blob.size <= 2000000) {
    void blob.text().then(body => fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    })).then(refreshFixture).catch(() => {});
  }
  return url;
};
refreshFixture();
setInterval(refreshFixture, 300);
</script>`;

function readFixture(url) {
  const requested = url.searchParams.get('fixture') ?? (url.searchParams.get('mode') === 'simulation' ? 'simulation' : undefined);
  const scenario = ['fixed', 'simulation', 'delay', 'route', 'stale', 'failure', 'rate-limit', 'timeout'].includes(requested) ? requested : 'fixed';
  const requestedRun = url.searchParams.get('run');
  const run = /^[a-z0-9_-]{1,40}$/i.test(requestedRun ?? '') ? requestedRun : 'default';
  return { scenario, key: scenario + ':' + run };
}

createServer(async (req, res) => {
  try {
    const origin = req.headers.origin || 'http://' + req.headers.host;
    const url = new URL(req.url, origin);
    if (url.pathname === '/__fixture') {
      const key = url.searchParams.get('key');
      if (!key || !/^[a-z0-9-]+:[a-z0-9_-]{1,40}$/i.test(key)) return res.writeHead(400).end();
      const recorded = exportsByRun.get(key) || {};
      if (req.method === 'POST') {
        if (req.headers['content-type'] === 'application/json') {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 2000000) return res.writeHead(413).end();
          }
          const { schemaVersion } = JSON.parse(body);
          if (schemaVersion !== 1 && schemaVersion !== 2 && schemaVersion !== 3) return res.writeHead(400).end();
          recorded[schemaVersion] = body;
          exportsByRun.set(key, recorded);
        } else held.find(entry => entry.key === key)?.accept();
      }
      const pending = held.filter(entry => entry.key === key).length;
      const captured = recorded[url.searchParams.get('export')];
      return res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(captured || JSON.stringify({ pending, calls: counts.get(key) || 0, exports: Object.keys(recorded) }));
    }
    const fixtureUrl = req.method === 'POST' && req.headers.referer ? new URL(req.headers.referer) : url;
    const fixture = readFixture(fixtureUrl);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let body = '';
    for await (const chunk of req) body += chunk;
    const result = await contexts.run(fixture, () => worker.fetch(new Request(url, {
      method: req.method,
      headers: req.headers,
      signal: abort.signal,
      ...(req.method === 'POST' ? {body} : {}),
    }), { GEMINI_API_KEY: 'browser-fixture' }));
    const headers = Object.fromEntries(result.headers);
    if (url.pathname === '/' && req.method === 'GET') {
      const html = await result.text();
      const closeBody = html.lastIndexOf('</body>');
      assert.ok(closeBody >= 0);
      res.writeHead(result.status, headers)
        .end(html.slice(0, closeBody) + fixtureControls(fixture.key) + html.slice(closeBody));
    } else res.writeHead(result.status, headers).end(Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('The fixture server could not complete the request.');
  }
}).listen(Number(option('port', '4173')), option('host', '127.0.0.1'));
