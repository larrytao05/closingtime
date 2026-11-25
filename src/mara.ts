import { actionsFor, canStand, layout, type Action, type World } from './world';
import { reachableTiles } from './movement';
import {
  LiveMaraRequestError, retryAfterMs,
  type LiveMaraObservation, type LiveMaraRequest,
  type LiveMaraResponse,
} from './live-mara-protocol';
import type { MaraDecision, MaraObservation } from './planner';

const systemPrompt = `You are Mara, a coworker helping close a café. You and the player share responsibility for the room. Keep the closing paperwork safe and help finish closing up.

On each turn, look at what’s happening in the room and what the player has said or done. Choose one available action that makes sense in that moment. You can take initiative, let the player handle something, or change course when they’ve already taken care of it.

Treat what the player says as part of the scene. If you choose to speak, keep it brief and natural. You can also wait if that makes sense. Take exactly one action through the provided interface.`;

export interface ModelEnvironment {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

const speech = { type: 'speak' } as const;

export async function chooseMara(observation: MaraObservation, env: ModelEnvironment, signal: AbortSignal): Promise<MaraDecision> {
  const { world } = observation;
  const legal = actionsFor(world, 'mara');
  const choices = [...legal.moves(), ...legal.interactions(), speech];
  const availableActions = choices.map((action, id) => ({ id: String(id), ...action }));
  const { selection, model } = await askGemini({
    ...observation, layout, floorMap: floorMapFor(world), mapLegend, availableActions,
  }, systemPrompt, env, signal);
  const choiceIndex = availableActions.findIndex(action => action.id === selection.actionId);
  if (choiceIndex < 0) throw new Error('The model selected an unknown action.');
  const choice = choices[choiceIndex];
  const text = typeof selection.speech === 'string' ? selection.speech.trim() : '';
  const action: Action = choice.type === 'speak' ? { type: 'speak', text } : choice;
  if (!legal.allows(action)) throw new Error('The model produced an invalid action.');
  const rationale = typeof selection.rationale === 'string' ? selection.rationale.trim() : '';
  if (!rationale) throw new Error('The model returned no rationale.');
  return {
    action,
    actionId: availableActions[choiceIndex].id,
    rationale,
    legalActions: availableActions,
    model,
  };
}

const mapLegend = '. open tile, # blocked tile, M Mara. Coordinates start at (0,0) in the top-left.';

function floorMapFor(world: World) {
  return Array.from({ length: layout.height }, (_, y) =>
    Array.from({ length: layout.width }, (_, x) => {
      if (world.actors.mara.position.x === x && world.actors.mara.position.y === y) return 'M';
      return canStand(world, 'mara', { x, y }) ? '.' : '#';
    }).join(''),
  );
}

const livePrompt = `You are Mara, a coworker helping close a café. You and the player share responsibility for the room. Keep the closing paperwork safe and help finish closing up.

Time and the player's actions continue while you think. Consider the room, recent events and messages, and any active or queued walk. Choose one available action. A walk action only moves to its destination and does not interact on arrival. A new walk can redirect an ongoing walk. Speaking and waiting allow an ongoing walk to continue. Treat player dialogue as part of the scene. If you speak, keep it brief and natural. Give one brief rationale about the single chosen action and avoid claiming any unselected action has occurred.`;

async function askGemini<T extends { availableActions: { id: string }[] }>(
  observation: T,
  prompt: string,
  env: ModelEnvironment,
  signal: AbortSignal,
) {
  const requestedModel = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const timeout = AbortSignal.timeout(15000);
  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestedModel)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, timeout]),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(observation) }] }],
        generationConfig: {
          maxOutputTokens: 256,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: {
              actionId: {
                type: 'string',
                description: 'The ID of one available action.',
                enum: observation.availableActions.map(action => action.id),
              },
              speech: { type: ['string', 'null'], description: 'A line of dialogue for speak. Otherwise null.' },
              rationale: {
                type: 'string',
                description: 'One brief sentence explaining what you observed and why you chose this action.',
              },
            },
            required: ['actionId', 'speech', 'rationale'],
            additionalProperties: false,
          },
        },
      }),
    });
  } catch (error) {
    if (timeout.aborted) throw new LiveMaraRequestError('timeout');
    throw error;
  }
  if (response.status === 429) {
    throw new LiveMaraRequestError('rate-limited', retryAfterMs(response.headers.get('Retry-After')));
  }
  if (response.status === 408 || response.status === 504) throw new LiveMaraRequestError('timeout');
  if (response.status === 401 || response.status === 403) throw new LiveMaraRequestError('unavailable');
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);

  try {
    const data = await response.json();
    const parts: Array<{ text?: string; thought?: boolean }> = data.candidates?.[0]?.content?.parts ?? [];
    const output = parts.filter(part => !part.thought).map(part => part.text ?? '').join('');
    const selection: { actionId?: unknown; speech?: unknown; rationale?: unknown } = JSON.parse(output);
    if (!selection || typeof selection !== 'object') throw new Error('Missing selection');
    const model = typeof data.modelVersion === 'string' ? data.modelVersion : requestedModel;
    return { selection, model };
  } catch {
    throw new LiveMaraRequestError(timeout.aborted ? 'timeout' : 'invalid-response');
  }
}

export async function chooseLiveMara(
  request: LiveMaraRequest,
  env: ModelEnvironment,
  signal: AbortSignal,
): Promise<LiveMaraResponse> {
  const { sessionId, requestId, world, intent, moving, reserved, revision, activeMs, recentEvents } = request;
  const legal = actionsFor(world, 'mara');
  const availableActions = [
    ...reachableTiles(world, 'mara', reserved).map(to => ({ type: 'walkTo' as const, to })),
    ...legal.interactions().filter(action => !moving || action.type === 'wait'),
    speech,
  ].map((action, id) => ({ id: String(id), ...action }));
  const observation: LiveMaraObservation = {
    world, moving, reserved, revision, activeMs, recentEvents,
    intent: { active: intent.active?.to ?? null, queued: intent.queued?.to ?? null },
    layout, floorMap: floorMapFor(world), mapLegend, availableActions,
  };
  const { selection, model } = await askGemini(observation, livePrompt, env, signal);
  const option = availableActions.find(action => action.id === selection.actionId);
  const rationale = typeof selection.rationale === 'string' ? selection.rationale.trim() : '';
  if (!option || !rationale || rationale.length > 2048) throw new LiveMaraRequestError('invalid-response');
  const { id: actionId, ...choice } = option;
  const text = typeof selection.speech === 'string' ? selection.speech.trim() : '';
  const action = choice.type === 'speak' ? { type: 'speak' as const, text } : choice;
  if (action.type !== 'walkTo' && !legal.allows(action)) throw new LiveMaraRequestError('invalid-response');
  return { mode: 'live', sessionId, requestId, observation, decision: { action, actionId, rationale, model } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActor(value: unknown) {
  if (!isRecord(value) || !isRecord(value.position)) return false;
  const { x, y } = value.position;
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < layout.width
    && typeof y === 'number' && Number.isInteger(y) && y >= 0 && y < layout.height;
}

export function isObservation(value: unknown): value is MaraObservation {
  if (!isRecord(value) || !isRecord(value.world) || !isRecord(value.playerAction)) return false;
  const { world, recentTurns } = value;
  if (typeof world.windowOpen !== 'boolean' || !Number.isSafeInteger(world.turn)
    || !isRecord(world.actors) || !isActor(world.actors.player) || !isActor(world.actors.mara)
    || !Array.isArray(world.dialogue) || world.dialogue.length > 12
    || !Array.isArray(recentTurns) || recentTurns.length > 8
    || !isRecord(world.objects)) return false;

  const objects = world.objects;
  return ['papers', 'mug1', 'mug2', 'towel'].every(id => {
    const item = objects[id];
    if (!isRecord(item) || !isRecord(item.location) || !Number.isSafeInteger(item.wetness)) return false;
    const { surface, heldBy } = item.location;
    if ('surface' in item.location) return surface === 'table' || surface === 'counter';
    return heldBy === 'player' || heldBy === 'mara';
  });
}
