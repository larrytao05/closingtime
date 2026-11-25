import { layout, type Action, type ActorId, type ObjectId, type Point, type World } from './world';

export type LiveMaraAction = Action | { type: 'walkTo'; to: Point };
type Option = Exclude<LiveMaraAction, { type: 'speak' }> | { type: 'speak' };

export type LiveMaraOption = Option & { id: string };

export type LiveRouteIntent = { to: Point; commandId: string };
export type LiveMaraIntent = {
  active: LiveRouteIntent | null;
  queued: LiveRouteIntent | null;
};

export interface LiveMaraMaterialEvent {
  type: 'room' | 'player-speech' | 'mara-action';
  actor?: ActorId;
  action?: LiveMaraAction;
  outcome?: string;
}

export interface LiveMaraSnapshot {
  sessionId: string;
  activeMs: number;
  revision: number;
  paused: boolean;
  world: World;
  intent: LiveMaraIntent;
  moving: boolean;
  reserved: readonly Point[];
}

export interface LiveMaraContext {
  activeMs: number;
  revision: number;
  world: World;
  intent: LiveMaraIntent;
  moving: boolean;
  reserved: readonly Point[];
  recentEvents: LiveMaraMaterialEvent[];
}

export interface LiveMaraObservation extends Omit<LiveMaraContext, 'intent'> {
  intent: { active: Point | null; queued: Point | null };
  layout: typeof layout;
  floorMap: string[];
  mapLegend: string;
  availableActions: LiveMaraOption[];
}

export interface LiveMaraRequest extends LiveMaraContext {
  mode: 'live';
  sessionId: string;
  requestId: string;
}

export interface LiveMaraDecision {
  action: LiveMaraAction;
  actionId: string;
  rationale: string;
  model: string;
}

export interface LiveMaraResponse {
  mode: 'live';
  sessionId: string;
  requestId: string;
  observation: LiveMaraObservation;
  decision: LiveMaraDecision;
}

export type LiveMaraFailure =
  | 'unavailable' | 'rate-limited' | 'timeout' | 'provider-error'
  | 'invalid-observation' | 'invalid-response';

export class LiveMaraRequestError extends Error {
  constructor(
    readonly reason: LiveMaraFailure,
    readonly retryAfterMs = 0,
  ) {
    super(reason);
  }
}

const objectIds: readonly ObjectId[] = ['papers', 'mug1', 'mug2', 'towel'];

const isActor = (value: unknown): value is ActorId => value === 'player' || value === 'mara';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNatural = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

function readPoint(value: unknown): Point | undefined {
  if (!isRecord(value) || !isNatural(value.x) || !isNatural(value.y)
    || value.x >= layout.width || value.y >= layout.height) return;
  return { x: value.x, y: value.y };
}

function readAction(value: unknown): LiveMaraAction | undefined {
  if (!isRecord(value)) return;
  switch (value.type) {
    case 'move':
    case 'walkTo': {
      const to = readPoint(value.to);
      if (to) return { type: value.type, to };
      return;
    }
    case 'pickUp':
    case 'putDown': {
      const objectId = objectIds.find(id => id === value.objectId);
      if (!objectId) return;
      if (value.type === 'pickUp') return { type: 'pickUp', objectId };
      if (value.surfaceId === 'table' || value.surfaceId === 'counter') {
        return { type: 'putDown', objectId, surfaceId: value.surfaceId };
      }
      return;
    }
    case 'open':
    case 'close':
    case 'wait':
      return { type: value.type };
    case 'speak':
      if (isText(value.text, 160)) return { type: 'speak', text: value.text };
  }
}

function readWorld(value: unknown): World | undefined {
  if (!isRecord(value) || typeof value.windowOpen !== 'boolean' || !isNatural(value.turn)
    || !isRecord(value.actors) || !isRecord(value.objects) || !Array.isArray(value.dialogue)
    || value.dialogue.length > 12) return;
  const { player, mara } = value.actors;
  if (!isRecord(player) || !isRecord(mara)) return;
  const playerPosition = readPoint(player.position);
  const maraPosition = readPoint(mara.position);
  if (!playerPosition || !maraPosition) return;
  const objects = {} as World['objects'];
  for (const id of objectIds) {
    const item = value.objects[id];
    if (!isRecord(item) || !isRecord(item.location) || !isNatural(item.wetness)) return;
    const { surface, heldBy } = item.location;
    if (surface === 'table' || surface === 'counter') {
      objects[id] = { location: { surface }, wetness: item.wetness };
    } else if (isActor(heldBy)) {
      objects[id] = { location: { heldBy }, wetness: item.wetness };
    } else return;
  }
  const dialogue: World['dialogue'] = [];
  for (const line of value.dialogue) {
    if (!isRecord(line) || !isActor(line.actor) || !isText(line.text, 160)) return;
    dialogue.push({ actor: line.actor, text: line.text });
  }
  return {
    turn: value.turn,
    windowOpen: value.windowOpen,
    actors: { player: { position: playerPosition }, mara: { position: maraPosition } },
    objects,
    dialogue,
  };
}

function readRoute(value: unknown): LiveRouteIntent | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isText(value.commandId, 128)) return;
  const to = readPoint(value.to);
  if (to) return { to, commandId: value.commandId };
}

function readEvents(value: unknown): LiveMaraMaterialEvent[] | undefined {
  if (!Array.isArray(value) || value.length > 8) return;
  const events: LiveMaraMaterialEvent[] = [];
  for (const event of value) {
    if (!isRecord(event) || (event.type !== 'room' && event.type !== 'player-speech' && event.type !== 'mara-action')) return;
    const action = readAction(event.action);
    if (event.action !== undefined && !action) return;
    if (event.actor !== undefined && !isActor(event.actor)) return;
    if (event.outcome !== undefined && !isText(event.outcome, 96)) return;
    events.push({ type: event.type, actor: event.actor, action, outcome: event.outcome });
  }
  return events;
}

export function isLiveMode(value: unknown): boolean {
  return isRecord(value) && value.mode === 'live';
}

export function readLiveMaraRequest(value: unknown): LiveMaraRequest | undefined {
  if (!isRecord(value) || value.mode !== 'live' || !isText(value.sessionId, 64) || !isText(value.requestId, 96)
    || !isNatural(value.revision) || !isMs(value.activeMs) || !isRecord(value.intent)
    || typeof value.moving !== 'boolean' || !Array.isArray(value.reserved) || value.reserved.length > 8) return;
  const world = readWorld(value.world);
  const active = readRoute(value.intent.active);
  const queued = readRoute(value.intent.queued);
  const recentEvents = readEvents(value.recentEvents);
  const reserved: Point[] = [];
  for (const point of value.reserved) {
    const parsed = readPoint(point);
    if (!parsed) return;
    reserved.push(parsed);
  }
  if (!world || active === undefined || queued === undefined || !recentEvents) return;
  return {
    mode: 'live',
    sessionId: value.sessionId,
    requestId: value.requestId,
    revision: value.revision,
    activeMs: value.activeMs,
    world,
    moving: value.moving,
    reserved,
    intent: { active, queued },
    recentEvents,
  };
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : 0;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export async function requestLiveMara(request: LiveMaraRequest, signal: AbortSignal): Promise<LiveMaraResponse> {
  const response = await fetch('/api/mara', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (response.status === 503) throw new LiveMaraRequestError('unavailable');
  if (response.status === 429) throw new LiveMaraRequestError('rate-limited', retryAfterMs(response.headers.get('Retry-After')));
  if (response.status === 504) throw new LiveMaraRequestError('timeout');
  if ([400, 403, 405, 413].includes(response.status)) throw new LiveMaraRequestError('invalid-observation');
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new LiveMaraRequestError(isRecord(body) && body.reason === 'invalid-response'
      ? 'invalid-response' : 'provider-error');
  }
  const result: unknown = await response.json().catch(() => null);
  if (!isRecord(result) || result.mode !== 'live' || result.sessionId !== request.sessionId || result.requestId !== request.requestId
    || !isRecord(result.observation) || !isRecord(result.decision)
    || !isText(result.decision.actionId, 16) || !isText(result.decision.rationale, 2048)
    || !isText(result.decision.model, 128) || !Array.isArray(result.observation.availableActions)) {
    throw new LiveMaraRequestError('invalid-response');
  }
  const decision = result.decision;
  const action = readAction(decision.action);
  const option = result.observation.availableActions.find(item => isRecord(item) && item.id === decision.actionId);
  if (!action || !isRecord(option) || option.type !== action.type
    || (action.type !== 'speak' && JSON.stringify(readAction(option)) !== JSON.stringify(action))) {
    throw new LiveMaraRequestError('invalid-response');
  }
  return result as unknown as LiveMaraResponse;
}
