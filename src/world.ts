export type ActorId = 'player' | 'mara';
export type ObjectId = 'papers' | 'mug1' | 'mug2' | 'towel';
export type SurfaceId = 'table' | 'counter';

export interface Point {
  x: number;
  y: number;
}

export type Action =
  | { type: 'move'; to: Point }
  | { type: 'pickUp'; objectId: ObjectId }
  | { type: 'putDown'; objectId: ObjectId; surfaceId: SurfaceId }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'speak'; text: string }
  | { type: 'wait' };

interface RoomObject {
  location: { heldBy: ActorId } | { surface: SurfaceId };
  wetness: number;
}

export interface World {
  actors: Record<ActorId, { position: Point }>;
  objects: Record<ObjectId, RoomObject>;
  windowOpen: boolean;
  turn: number;
  dialogue: Array<{ actor: ActorId; text: string }>;
}

export type ActionResult = { ok: true; world: World } | { ok: false; reason: string };

export const layout = {
  width: 8,
  height: 6,
  window: { x: 5, y: 0 },
  surfaces: {
    table: { x: 6, y: 1 },
    counter: { x: 2, y: 2 },
  } satisfies Record<SurfaceId, Point>,
};

const objectIds: readonly ObjectId[] = ['papers', 'mug1', 'mug2', 'towel'];
const handCapacity = 2;
const directions = [
  { x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 },
];
type Move = Extract<Action, { type: 'move' }>;
export type Interaction = Exclude<Action, Move | { type: 'speak' }>;

const interactions: Interaction[] = [{ type: 'close' }, { type: 'open' }];
for (const objectId of objectIds) {
  interactions.push({ type: 'pickUp', objectId });
  interactions.push({ type: 'putDown', objectId, surfaceId: 'table' });
  interactions.push({ type: 'putDown', objectId, surfaceId: 'counter' });
}
interactions.push({ type: 'wait' });

export function actionsFor(world: World, actor: ActorId) {
  const execute = (action: Action) => perform(world, actor, action);
  const allows = (action: Action) => execute(action).ok;
  return {
    execute,
    allows,
    moves(): Move[] {
      const { x, y } = world.actors[actor].position;
      return directions
        .map(({ x: dx, y: dy }): Move => ({ type: 'move', to: { x: x + dx, y: y + dy } }))
        .filter(allows);
    },
    interactions: () => interactions.filter(allows),
  };
}

export function createWorld(): World {
  return {
    actors: {
      player: { position: { x: 5, y: 3 } },
      mara: { position: { x: 2, y: 3 } },
    },
    objects: {
      papers: { location: { surface: 'table' }, wetness: 0 },
      mug1: { location: { heldBy: 'mara' }, wetness: 0 },
      mug2: { location: { heldBy: 'mara' }, wetness: 0 },
      towel: { location: { surface: 'counter' }, wetness: 0 },
    },
    windowOpen: true,
    turn: 0,
    dialogue: [],
  };
}

function distance(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function isWithinReach(position: Point, target: Point): boolean {
  return distance(position, target) <= 1;
}

export function canStand(world: World, actor: ActorId, point: Point): boolean {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) return false;
  if (point.x < 0 || point.x >= layout.width || point.y < 0 || point.y >= layout.height) {
    return false;
  }

  const otherActor = actor === 'player' ? 'mara' : 'player';
  const blocked = [layout.window, ...Object.values(layout.surfaces), world.actors[otherActor].position];
  return blocked.every(obstacle => distance(point, obstacle) > 0);
}

export function heldItems(world: World, actor: ActorId): ObjectId[] {
  return objectIds.filter(id => {
    const { location } = world.objects[id];
    return 'heldBy' in location && location.heldBy === actor;
  });
}

export function perform(world: World, actor: ActorId, action: Action): ActionResult {
  const { position } = world.actors[actor];

  switch (action.type) {
    case 'move': {
      if (distance(position, action.to) !== 1 || !canStand(world, actor, action.to)) {
        return { ok: false, reason: 'Choose an open tile one step away.' };
      }
      const actors = { ...world.actors, [actor]: { position: { ...action.to } } };
      return { ok: true, world: { ...world, actors } };
    }

    case 'pickUp': {
      const item = world.objects[action.objectId];
      if (!('surface' in item.location)) {
        return { ok: false, reason: 'Someone is already holding that.' };
      }
      if (!isWithinReach(position, layout.surfaces[item.location.surface])) {
        return { ok: false, reason: 'That object is out of reach.' };
      }
      if (heldItems(world, actor).length >= handCapacity) {
        return { ok: false, reason: 'Both hands are full.' };
      }
      const objects = {
        ...world.objects,
        [action.objectId]: { ...item, location: { heldBy: actor } },
      };
      return { ok: true, world: { ...world, objects } };
    }

    case 'putDown': {
      const item = world.objects[action.objectId];
      if (!('heldBy' in item.location) || item.location.heldBy !== actor) {
        return { ok: false, reason: 'You must be holding the object first.' };
      }
      if (!isWithinReach(position, layout.surfaces[action.surfaceId])) {
        return { ok: false, reason: 'That surface is out of reach.' };
      }
      const objects = {
        ...world.objects,
        [action.objectId]: { ...item, location: { surface: action.surfaceId } },
      };
      return { ok: true, world: { ...world, objects } };
    }

    case 'open':
    case 'close': {
      const windowOpen = action.type === 'open';
      if (!isWithinReach(position, layout.window)) {
        return { ok: false, reason: 'The window is out of reach.' };
      }
      if (world.windowOpen === windowOpen) {
        return { ok: false, reason: windowOpen ? 'The window is already open.' : 'The window is already closed.' };
      }
      if (heldItems(world, actor).length >= handCapacity) {
        return { ok: false, reason: 'Both hands are full.' };
      }
      return { ok: true, world: { ...world, windowOpen } };
    }

    case 'speak': {
      const text = action.text.trim();
      if (!text) return { ok: false, reason: 'Enter something to say.' };
      if (text.length > 160) return { ok: false, reason: 'Keep speech to 160 characters.' };
      return { ok: true, world: { ...world, dialogue: [...world.dialogue, { actor, text }] } };
    }

    case 'wait':
      return { ok: true, world };
  }
}

export function advanceRain(world: World): World {
  const nextWorld = { ...world, turn: world.turn + 1 };
  const { papers } = world.objects;

  if (world.windowOpen && 'surface' in papers.location && papers.location.surface === 'table') {
    nextWorld.objects = {
      ...world.objects,
      papers: { ...papers, wetness: papers.wetness + 1 },
    };
  }

  return nextWorld;
}
