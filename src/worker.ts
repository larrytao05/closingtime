import page from '../dist/client/index.html?raw';
import { chooseLiveMara, chooseMara, isObservation, type ModelEnvironment } from './mara';
import { isLiveMode, LiveMaraRequestError, readLiveMaraRequest } from './live-mara-protocol';
import { chooseSimulationDecision, readSimulationDecisionRequest, SimulationAgentError } from './simulation/agent-api';

const json = (body: object, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export default {
  async fetch(request: Request, env: ModelEnvironment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname !== '/api/mara' && url.pathname !== '/api/simulation') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response('Method not allowed', {
      status: 405, headers: { Allow: 'POST' },
    });
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Invalid origin.' }, 403);
    if (url.pathname === '/api/simulation') {
      let body: unknown;
      try {
        const raw = await request.text();
        if (raw.length > 32000) return json({ error: 'Decision request is too large.', reason: 'invalid-request' }, 413);
        body = JSON.parse(raw);
      } catch { return json({ error: 'Invalid decision request.', reason: 'invalid-request' }, 400); }
      const decision = readSimulationDecisionRequest(body);
      if (!decision) return json({ error: 'Invalid decision request.', reason: 'invalid-request' }, 400);
      if (!env.GEMINI_API_KEY) return json({ error: 'The model is not configured.', reason: 'missing-key' }, 503);
      try { return json(await chooseSimulationDecision(decision, env, request.signal)); }
      catch (error) {
        const reason = error instanceof SimulationAgentError ? error.reason : 'provider-error';
        const status = reason === 'rate-limited' ? 429 : reason === 'timeout' ? 504 : reason === 'missing-key' ? 503 : 502;
        const headers: Record<string, string> = {};
        if (error instanceof SimulationAgentError && status === 429 && error.retryAfterMs > 0) headers['Retry-After'] = String(Math.ceil(error.retryAfterMs / 1000));
        return json({ error: 'The actor could not decide.', reason }, status, headers);
      }
    }
    if (!env.GEMINI_API_KEY) return json({ error: 'Mara’s model is not configured.' }, 503);

    let observation: unknown;
    try {
      const body = await request.text();
      if (body.length > 16000) return json({ error: 'Observation is too large.' }, 413);
      observation = JSON.parse(body);
    } catch {
      return json({ error: 'Invalid observation.' }, 400);
    }

    if (isLiveMode(observation)) {
      const live = readLiveMaraRequest(observation);
      if (!live) return json({ error: 'Invalid observation.' }, 400);
      try {
        return json(await chooseLiveMara(live, env, request.signal));
      } catch (error) {
        const reason = error instanceof LiveMaraRequestError ? error.reason : 'provider-error';
        const status = reason === 'rate-limited' ? 429 : reason === 'timeout' ? 504 : reason === 'unavailable' ? 503 : 502;
        const headers: Record<string, string> = {};
        if (error instanceof LiveMaraRequestError && status === 429 && error.retryAfterMs > 0) {
          headers['Retry-After'] = String(Math.ceil(error.retryAfterMs / 1000));
        }
        return json({ error: 'Mara couldn’t decide what to do.', reason }, status, headers);
      }
    }

    if (!isObservation(observation)) return json({ error: 'Invalid observation.' }, 400);

    try {
      return json(await chooseMara(observation, env, request.signal));
    } catch (error) {
      console.warn('Mara could not complete her turn.', error instanceof Error && /^Gemini request failed \(\d+\)\.$/.test(error.message) ? error.message : 'Invalid model result or timeout.');
      return json({ error: 'Mara could not complete her turn.' }, 502);
    }
  },
};
