import { actionsFor, advanceRain, type Action, type World } from './world';

export interface PlayedTurn {
  player: Action;
  mara: Action;
}

export interface MaraObservation {
  world: World;
  recentTurns: PlayedTurn[];
  playerAction: Action;
}

type ActionOption = (Exclude<Action, { type: 'speak' }> | { type: 'speak' }) & { id: string };

export interface MaraDecision {
  action: Action;
  actionId: string;
  rationale: string;
  legalActions: ActionOption[];
  model: string;
}

type ChooseAction = (observation: MaraObservation) => Promise<MaraDecision>;

export async function playTurn(
  world: World,
  action: Action,
  recentTurns: PlayedTurn[],
  chooseMara: ChooseAction,
) {
  const player = actionsFor(world, 'player').execute(action);
  if (!player.ok) return player;

  const snapshot = (state: World) => ({ ...state, dialogue: state.dialogue.slice(-12) });
  const observation = {
    world: snapshot(player.world),
    recentTurns: recentTurns.slice(-8),
    playerAction: action,
  };
  const decision = await chooseMara(observation);
  const mara = actionsFor(player.world, 'mara').execute(decision.action);
  if (!mara.ok) throw new Error('Mara chose an unavailable action.');

  const nextWorld = advanceRain(mara.world);
  return {
    ok: true as const,
    world: nextWorld,
    trace: { worldBefore: snapshot(world), observation, decision, worldAfter: snapshot(nextWorld) },
  };
}

export async function requestMara(observation: MaraObservation, signal: AbortSignal): Promise<MaraDecision> {
  const response = await fetch('/api/mara', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(observation),
    signal,
  });
  if (response.status === 503) throw new Error('Mara needs a model connection before you can play.');
  if (!response.ok) throw new Error('Mara couldn’t take her turn. Try the action again.');
  return response.json();
}
