import { actionsFor, canStand, layout, type Action } from './world';
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
  const floorMap = Array.from({ length: layout.height }, (_, y) =>
    Array.from({ length: layout.width }, (_, x) => {
      if (world.actors.mara.position.x === x && world.actors.mara.position.y === y) return 'M';
      return canStand(world, 'mara', { x, y }) ? '.' : '#';
    }).join(''),
  );
  const model = env.GEMINI_MODEL || 'gemini-3.1-flash-lite';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({
        ...observation,
        layout,
        floorMap,
        mapLegend: '. open tile, # blocked tile, M Mara. Coordinates start at (0,0) in the top-left.',
        availableActions,
      }) }] }],
      generationConfig: {
        maxOutputTokens: 256,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: {
            actionId: {
              type: 'string',
              description: 'The ID of one available action.',
              enum: availableActions.map(action => action.id),
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
  if (!response.ok) throw new Error(`Gemini request failed (${response.status}).`);
  const data = await response.json();
  const parts: Array<{ text?: string; thought?: boolean }> = data.candidates?.[0]?.content?.parts ?? [];
  const output = parts.filter(part => !part.thought).map(part => part.text ?? '').join('');
  if (!output) throw new Error('Gemini returned no action.');

  const selection = JSON.parse(output);
  const choice = choices[availableActions.findIndex(action => action.id === selection?.actionId)];
  if (!choice) throw new Error('The model selected an unknown action.');
  const text = typeof selection.speech === 'string' ? selection.speech.trim() : '';
  const action: Action = choice.type === 'speak' ? { type: 'speak', text } : choice;
  if (!legal.allows(action)) throw new Error('The model produced an invalid action.');
  const rationale = typeof selection.rationale === 'string' ? selection.rationale.trim() : '';
  if (!rationale) throw new Error('The model returned no rationale.');
  return {
    action,
    actionId: selection.actionId,
    rationale,
    legalActions: availableActions,
    model: typeof data.modelVersion === 'string' ? data.modelVersion : model,
  };
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
