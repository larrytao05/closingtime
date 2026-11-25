import type {
  ActorLocalObservation, BoundedMemoryProposals, NpcId, SimulationAction, SimulationDecisionReply,
  SimulationDecisionRequest, SimulationMemoryProposal, SimulationOption, SimulationRoomEventPayload,
  SimulationVisibleActor, SimulationVisibleObject, WitnessedObservationEvent,
} from './contracts';
import { SIMULATION_REQUEST_MAX_OPTIONS, SIMULATION_REQUEST_MAX_RATIONALE_CHARS,
  SIMULATION_REQUEST_MAX_SPEECH_CHARS, SIMULATION_REQUEST_MAX_WITNESSED_EVENTS } from './contracts';
import type { Point } from '../world';
import type { SimulationRoomObject } from './contracts';
import { layout } from '../world';
import { generateGemini, type ModelEnvironment } from '../mara';
import { LiveMaraRequestError } from '../live-mara-protocol';

const actors = ['player', 'mara', 'riley', 'jo'] as const;
const npcs = ['mara', 'riley', 'jo'] as const;
const objectIds = ['papers', 'mug1', 'mug2', 'towel'] as const;
const surfaces = ['table', 'counter'] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const natural = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const actor = (v: unknown): v is typeof actors[number] => actors.includes(v as never);
const npc = (v: unknown): v is NpcId => npcs.includes(v as never);

function point(v: unknown): Point | undefined {
  if (!isRecord(v) || !exact(v, ['x', 'y']) || !natural(v.x) || !natural(v.y) || v.x >= layout.width || v.y >= layout.height) return;
  return { x: v.x, y: v.y };
}
function readAction(v: unknown): SimulationAction | undefined {
  if (!isRecord(v) || typeof v.type !== 'string') return;
  switch (v.type) {
    case 'walk': { const to = point(v.to); return to && exact(v, ['type', 'to']) ? { type: 'walk', to } : undefined; }
    case 'move': return undefined;
    case 'pickUp': return objectIds.includes(v.objectId as never) && exact(v, ['type', 'objectId']) ? { type: 'pickUp', objectId: v.objectId as typeof objectIds[number] } : undefined;
    case 'putDown': return objectIds.includes(v.objectId as never) && surfaces.includes(v.surfaceId as never) && exact(v, ['type', 'objectId', 'surfaceId']) ? { type: 'putDown', objectId: v.objectId as typeof objectIds[number], surfaceId: v.surfaceId as typeof surfaces[number] } : undefined;
    case 'open': case 'close': case 'wait': return exact(v, ['type']) ? { type: v.type } : undefined;
    case 'speak': return exact(v, ['type', 'recipient']) && (v.recipient === undefined || actor(v.recipient)) ? { type: 'speak', ...(v.recipient === undefined ? {} : { recipient: v.recipient }) } : undefined;
    default: return undefined;
  }
}
function readObservation(v: unknown, expected: unknown): ActorLocalObservation | undefined {
  if (!isRecord(v) || !exact(v, ['actorId', 'activeTimeMs', 'revision', 'selfPosition', 'visibleActors', 'visibleObjects', 'windowOpen', 'rainExposureMs'])
    || !actor(v.actorId) || v.actorId !== expected || !natural(v.activeTimeMs) || !natural(v.revision) || typeof v.windowOpen !== 'boolean' || !natural(v.rainExposureMs)) return;
  const selfPosition = point(v.selfPosition);
  if (!selfPosition || !Array.isArray(v.visibleActors) || v.visibleActors.length > actors.length - 1 || !Array.isArray(v.visibleObjects) || v.visibleObjects.length > objectIds.length) return;
  const seenActors = new Set<string>();
  const visibleActors: SimulationVisibleActor[] = [];
  for (const entry of v.visibleActors) {
    if (!isRecord(entry) || !exact(entry, ['actorId', 'position']) || !actor(entry.actorId) || entry.actorId === v.actorId || seenActors.has(entry.actorId)) return;
    const pos = point(entry.position); if (!pos) return;
    seenActors.add(entry.actorId); visibleActors.push({ actorId: entry.actorId, position: pos });
  }
  const seenObjects = new Set<string>();
  const visibleObjects: SimulationVisibleObject[] = [];
  for (const entry of v.visibleObjects) {
    if (!isRecord(entry) || !exact(entry, ['objectId', 'location', 'wetness']) || !objectIds.includes(entry.objectId as never) || seenObjects.has(entry.objectId as string) || !natural(entry.wetness) || !isRecord(entry.location)) return;
    const id = entry.objectId as typeof objectIds[number];
    let location: SimulationRoomObject['location'];
    if (exact(entry.location, ['heldBy']) && actor(entry.location.heldBy)) location = { heldBy: entry.location.heldBy };
    else if (exact(entry.location, ['surface']) && surfaces.includes(entry.location.surface as never)) location = { surface: entry.location.surface as typeof surfaces[number] };
    else return;
    seenObjects.add(id); visibleObjects.push({ objectId: id, location, wetness: entry.wetness });
  }
  return { actorId: v.actorId, activeTimeMs: v.activeTimeMs, revision: v.revision, selfPosition, visibleActors, visibleObjects, windowOpen: v.windowOpen, rainExposureMs: v.rainExposureMs };
}
function readPayload(v: unknown): SimulationRoomEventPayload | undefined {
  if (!isRecord(v) || typeof v.type !== 'string') return;
  switch (v.type) {
    case 'actor-joined': { const p = point(v.position); return p && actor(v.actorId) && exact(v, ['type','actorId','position']) ? { type: v.type, actorId: v.actorId, position: p } : undefined; }
    case 'movement-tile-committed': { const from = point(v.from), to = point(v.to); return from && to && actor(v.actorId) && exact(v, ['type','actorId','from','to']) ? { type: v.type, actorId: v.actorId, from, to } : undefined; }
    case 'speech': return actor(v.actorId) && (v.recipient === undefined || actor(v.recipient)) && text(v.text, SIMULATION_REQUEST_MAX_SPEECH_CHARS) && exact(v, ['type','actorId','recipient','text']) ? { type: 'speech', actorId: v.actorId, ...(v.recipient === undefined ? {} : { recipient: v.recipient }), text: v.text } : undefined;
    case 'room-interaction': { const action = readAction(v.action); return actor(v.actorId) && action && action.type !== 'walk' && action.type !== 'speak' && exact(v, ['type','actorId','action']) ? { type: v.type, actorId: v.actorId, action } : undefined; }
    case 'rain': return typeof v.exposed === 'boolean' && natural(v.elapsedMs) && natural(v.wetnessDelta) && exact(v, ['type','exposed','elapsedMs','wetnessDelta']) ? { type: v.type, exposed: v.exposed, elapsedMs: v.elapsedMs, wetnessDelta: v.wetnessDelta } : undefined;
  }
}
function readWitnessed(v: unknown): WitnessedObservationEvent | undefined {
  if (!isRecord(v) || !exact(v, ['runId','sequence','activeTimeMs','payload']) || !text(v.runId, 96) || !natural(v.sequence) || v.sequence < 1 || !natural(v.activeTimeMs)) return;
  const payload = readPayload(v.payload); return payload && { runId: v.runId, sequence: v.sequence, activeTimeMs: v.activeTimeMs, payload };
}
function readRecall(v: unknown, owner: unknown) {
  if (!isRecord(v) || !exact(v, ['actorId','records','retrievedMemoryIds']) || v.actorId !== owner || !actor(v.actorId) || !Array.isArray(v.records) || v.records.length > 32 || !Array.isArray(v.retrievedMemoryIds) || v.retrievedMemoryIds.length > 32) return;
  const retrievedMemoryIds: string[] = [];
  for (const id of v.retrievedMemoryIds) { if (!text(id, 128)) return; retrievedMemoryIds.push(id); }
  const records: SimulationDecisionRequest['recall']['records'] = [];
  for (const x of v.records) {
    if (!isRecord(x) || !text(x.id, 128) || x.owner !== owner || !natural(x.activeTimeMs) || !Array.isArray(x.sourceEventIds) || x.sourceEventIds.length < 1 || x.sourceEventIds.length > 8 || x.sourceEventIds.some(id => !text(id, 160))) return;
    const common = { id: x.id, owner: owner as SimulationDecisionRequest['actorId'], sourceEventIds: x.sourceEventIds as [string, ...string[]], activeTimeMs: x.activeTimeMs };
    if (x.kind === 'observation' && exact(x, ['id','kind','owner','sourceEventIds','text','activeTimeMs']) && text(x.text, 500)) records.push({ ...common, kind: 'observation', sourceEventIds: [x.sourceEventIds[0] as string], text: x.text });
    else if (x.kind === 'attributed-speech' && exact(x, ['id','kind','owner','speaker','sourceEventIds','exactLine','activeTimeMs']) && actor(x.speaker) && text(x.exactLine, SIMULATION_REQUEST_MAX_SPEECH_CHARS) && x.sourceEventIds.length === 1) records.push({ ...common, kind: 'attributed-speech', speaker: x.speaker, sourceEventIds: [x.sourceEventIds[0] as string], exactLine: x.exactLine });
    else if (x.kind === 'commitment' && exact(x, ['id','kind','owner','speaker','sourceEventIds','exactLine','status','activeTimeMs']) && actor(x.speaker) && text(x.exactLine, SIMULATION_REQUEST_MAX_SPEECH_CHARS) && ['open','completed','withdrawn'].includes(x.status as string)) records.push({ ...common, kind: 'commitment', speaker: x.speaker, sourceEventIds: x.sourceEventIds as [string, ...string[]], exactLine: x.exactLine, status: x.status as 'open'|'completed'|'withdrawn' });
    else return;
  }
  const recall = { actorId: owner as SimulationDecisionRequest['actorId'], records, retrievedMemoryIds };
  if (new TextEncoder().encode(JSON.stringify(recall)).length > 2048) return;
  return recall;
}

export function readSimulationDecisionRequest(v: unknown): SimulationDecisionRequest | undefined {
  if (!isRecord(v) || !exact(v, ['runId','requestId','generation','actorId','observedRevision','observation','witnessedEvents','options','recall'])
    || !text(v.runId, 96) || !text(v.requestId, 96) || !natural(v.generation) || v.generation < 1 || !npc(v.actorId) || !natural(v.observedRevision)) return;
  const observation = readObservation(v.observation, v.actorId);
  if (!observation || observation.revision !== v.observedRevision || !Array.isArray(v.witnessedEvents) || v.witnessedEvents.length > SIMULATION_REQUEST_MAX_WITNESSED_EVENTS || !Array.isArray(v.options) || !v.options.length || v.options.length > SIMULATION_REQUEST_MAX_OPTIONS) return;
  const witnessedEvents: WitnessedObservationEvent[] = [];
  const sequences = new Set<number>();
  for (const e of v.witnessedEvents) { const parsed = readWitnessed(e); if (!parsed || parsed.runId !== v.runId || sequences.has(parsed.sequence)) return; sequences.add(parsed.sequence); witnessedEvents.push(parsed); }
  const options: SimulationOption[] = []; const ids = new Set<string>();
  for (const x of v.options) { if (!isRecord(x) || !exact(x, ['actionId','action']) || !text(x.actionId, 96) || ids.has(x.actionId)) return; const action = readAction(x.action); if (!action) return; ids.add(x.actionId); options.push({ actionId: x.actionId, action }); }
  const recall = readRecall(v.recall, v.actorId); if (!recall) return;
  return { runId: v.runId, requestId: v.requestId, generation: v.generation, actorId: v.actorId, observedRevision: v.observedRevision, observation, witnessedEvents, options, recall };
}

export class SimulationAgentError extends Error {
  constructor(readonly reason: 'missing-key'|'rate-limited'|'timeout'|'provider-error'|'invalid-response', readonly retryAfterMs = 0) { super(reason); }
}

const profiles: Record<NpcId, { name: string; voice: string }> = {
  mara: { name: 'Mara', voice: 'direct, considerate, and practical' },
  riley: { name: 'Riley', voice: 'curious, upbeat, and observant' },
  jo: { name: 'Jo', voice: 'calm, dry-witted, and attentive' },
};
const schema = (request: SimulationDecisionRequest) => ({ type: 'object', properties: {
  actionId: { type: 'string', enum: request.options.map(o => o.actionId) },
  reply: { type: ['string','null'], description: 'Brief dialogue only when choosing a speak option.' },
  rationale: { type: 'string', description: 'Brief explanation grounded in this actor’s visible situation.' },
  memoryProposals: { type: 'array', maxItems: 3, items: { type: 'object', properties: {
    kind: { type: 'string', enum: ['open-commitment','close-commitment'] }, sourceEventId: { type: 'string' }, exactLine: { type: 'string' },
    commitmentId: { type: 'string' }, outcome: { type: 'string', enum: ['completed','withdrawn'] },
  }, required: ['kind'], additionalProperties: false } },
}, required: ['actionId','reply','rationale','memoryProposals'], additionalProperties: false });
function readProposals(v: unknown): BoundedMemoryProposals | undefined {
  if (!Array.isArray(v) || v.length > 3) return;
  const out: SimulationMemoryProposal[] = [];
  for (const p of v) {
    if (!isRecord(p) || typeof p.kind !== 'string') return;
    if (p.kind === 'open-commitment' && exact(p, ['kind','sourceEventId','exactLine']) && text(p.sourceEventId, 160) && text(p.exactLine, SIMULATION_REQUEST_MAX_SPEECH_CHARS)) out.push({ kind: p.kind, sourceEventId: p.sourceEventId, exactLine: p.exactLine });
    else if (p.kind === 'close-commitment' && exact(p, ['kind','commitmentId','sourceEventId','exactLine','outcome']) && text(p.commitmentId,128) && text(p.sourceEventId,160) && text(p.exactLine,SIMULATION_REQUEST_MAX_SPEECH_CHARS) && (p.outcome === 'completed' || p.outcome === 'withdrawn')) out.push({ kind: p.kind, commitmentId: p.commitmentId, sourceEventId: p.sourceEventId, exactLine: p.exactLine, outcome: p.outcome });
    else return;
  }
  return out as BoundedMemoryProposals;
}

export async function chooseSimulationDecision(request: SimulationDecisionRequest, env: ModelEnvironment, signal: AbortSignal): Promise<SimulationDecisionReply> {
  if (!env.GEMINI_API_KEY) throw new SimulationAgentError('missing-key');
  const profile = profiles[request.actorId as NpcId];
  const prompt = `You are ${profile.name}, a café coworker. Your voice is ${profile.voice}. Respond naturally to this moment and choose one available action. There is no closing objective, score, or required task. Do not invent facts, claim actions you did not choose, or treat spoken claims as changes to the room. Speak briefly only when selecting a speak option. Return optional memory proposals only for exact witnessed dialogue lines. Choose exactly one action.`;
  let result: { selection: Record<string, unknown>; model: string; responseId?: string };
  try { result = await generateGemini({ input: providerProjection(request), prompt, schema: schema(request), env, signal }); }
  catch (error) {
    if (error instanceof LiveMaraRequestError) {
      const reason = error.reason === 'rate-limited' ? 'rate-limited' : error.reason === 'timeout' ? 'timeout' : error.reason === 'invalid-response' ? 'invalid-response' : 'provider-error';
      throw new SimulationAgentError(reason, error.retryAfterMs);
    }
    throw new SimulationAgentError('provider-error');
  }
  const selection = result.selection;
  if (!isRecord(selection) || !exact(selection, ['actionId','reply','rationale','memoryProposals']) || typeof selection.actionId !== 'string' || !text(selection.rationale, SIMULATION_REQUEST_MAX_RATIONALE_CHARS)) throw new SimulationAgentError('invalid-response');
  const option = request.options.find(o => o.actionId === selection.actionId);
  if (!option || (selection.reply !== null && (option.action.type !== 'speak' || !text(selection.reply, SIMULATION_REQUEST_MAX_SPEECH_CHARS)))) throw new SimulationAgentError('invalid-response');
  const memoryProposals = readProposals(selection.memoryProposals);
  if (!memoryProposals) throw new SimulationAgentError('invalid-response');
  return { runId: request.runId, requestId: request.requestId, generation: request.generation, actorId: request.actorId,
    actionId: option.actionId, ...(option.action.type === 'speak' && typeof selection.reply === 'string' ? { reply: selection.reply.trim() } : {}),
    rationale: selection.rationale.trim(), ...(result.responseId ? { modelResponseId: result.responseId } : {}), ...(memoryProposals.length ? { memoryProposals } : {}) };
}

/** Assemble a new provider object from parsed safe fields; caller-owned envelopes are never serialized. */
function providerProjection(r: SimulationDecisionRequest) {
  return { actorId: r.actorId, activeTimeMs: r.observation.activeTimeMs, revision: r.observedRevision,
    selfPosition: { ...r.observation.selfPosition }, visibleActors: r.observation.visibleActors.map(a => ({ actorId: a.actorId, position: { ...a.position } })),
    visibleObjects: r.observation.visibleObjects.map(o => ({ objectId: o.objectId, location: { ...o.location }, wetness: o.wetness })),
    windowOpen: r.observation.windowOpen, rainExposureMs: r.observation.rainExposureMs,
    witnessedEvents: r.witnessedEvents.map(e => ({ activeTimeMs: e.activeTimeMs, payload: structuredClone(e.payload) })),
    options: r.options.map(o => ({ actionId: o.actionId, action: structuredClone(o.action) })),
    recall: { actorId: r.recall.actorId, records: r.recall.records.map(x => structuredClone(x)), retrievedMemoryIds: [...r.recall.retrievedMemoryIds] } };
}
