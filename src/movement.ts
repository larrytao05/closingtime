import type { DispatchMetadata, RealtimeSession, SessionSnapshot } from './realtime';
import { canStand, type ActorId, type Point, type World } from './world';

const actorIds = ['player', 'mara'] as const;
const directions = [{ x: 0, y: -1 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }];
const sameTile = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const tileKey = ({ x, y }: Point) => `${x},${y}`;

interface PathVisit {
  tile: Point;
  previous?: PathVisit;
}

function routeTree(world: World, actor: ActorId, reserved: readonly Point[], start: Point) {
  const origin = { tile: start };
  const visits = new Map<string, PathVisit>([[tileKey(start), origin]]);
  const queue: PathVisit[] = [origin];
  const reservations = new Set(reserved.map(tileKey));

  for (const visit of queue) {
    for (const direction of directions) {
      const tile = { x: visit.tile.x + direction.x, y: visit.tile.y + direction.y };
      const key = tileKey(tile);
      if (visits.has(key) || reservations.has(key) || !canStand(world, actor, tile)) continue;
      const next = { tile, previous: visit };
      visits.set(key, next);
      queue.push(next);
    }
  }

  return visits;
}

export function reachableTiles(world: World, actor: ActorId, reserved: readonly Point[] = []): Point[] {
  const start = world.actors[actor].position;
  return Array.from(routeTree(world, actor, reserved, start).values())
    .slice(1)
    .map(visit => ({ ...visit.tile }));
}

/** Return the steps after the start, or undefined if a destination cannot be reached. */
export function findRoute(
  world: World,
  actor: ActorId,
  to: Point,
  reserved: readonly Point[] = [],
  start = world.actors[actor].position,
): Point[] | undefined {
  let visit = routeTree(world, actor, reserved, start).get(tileKey(to));
  if (!visit) return;
  const path: Point[] = [];
  while (visit.previous) {
    path.push({ ...visit.tile });
    visit = visit.previous;
  }
  return path.reverse();
}

export type RouteOutcome = 'arrived' | 'noop' | 'rejected' | 'blocked' | 'superseded' | 'canceled';
export type WalkResult =
  | { ok: true; commandId: string; status: 'started' | 'queued' | 'noop' }
  | { ok: false; commandId: string; reason: string };

export type WalkAction = { type: 'walkTo'; to: Point };

interface RouteCommand {
  commandId: string;
  requestId?: string;
  to: Point;
  path: Point[];
}

interface Segment {
  from: Point;
  to: Point;
  startAt: number;
  cancel: () => void;
}

interface ActorMotion {
  active?: RouteCommand;
  queued?: RouteCommand;
  segment?: Segment;
  stopAfterStep?: boolean;
}

export class MovementController {
  private readonly states: Record<ActorId, ActorMotion> = { player: {}, mara: {} };
  private readonly detachGuard: () => void;
  private readonly unsubscribe: () => void;
  private stepCommit?: { actor: ActorId; commandId: string; to: Point };
  private disposed = false;
  private sessionEnded = false;

  constructor(private readonly session: RealtimeSession, private readonly stepMs = 180) {
    if (!Number.isFinite(stepMs) || stepMs <= 0) throw new Error('Movement duration must be positive.');
    this.detachGuard = session.setMotionGuard((actor, action, metadata) => {
      if (action.type === 'move') {
        const step = this.stepCommit;
        if (!step || step.actor !== actor || step.commandId !== metadata?.commandId || !sameTile(step.to, action.to)) {
          return 'Submit movement through the route controller.';
        }
      } else if (this.isMoving(actor) && action.type !== 'speak' && action.type !== 'wait') {
        return 'Finish the current step before interacting.';
      }
    });
    this.unsubscribe = session.subscribe(event => {
      if (event.kind !== 'session') return;
      if (event.phase === 'started') this.sessionEnded = false;
      if (event.phase === 'ended') {
        this.sessionEnded = true;
        this.cancelAll();
      }
    });
  }

  isMoving(actor: ActorId) {
    return this.states[actor].segment !== undefined;
  }

  route(actor: ActorId) {
    const { active, queued } = this.states[actor];
    const describe = (route?: RouteCommand) => route && { commandId: route.commandId, to: { ...route.to } };
    return { active: describe(active), queued: describe(queued) };
  }

  pose(actor: ActorId, snapshot: SessionSnapshot = this.session.snapshot()): Point {
    const segment = this.states[actor].segment;
    if (!segment) return { ...snapshot.world.actors[actor].position };
    const progress = Math.max(0, Math.min(1, (snapshot.activeMs - segment.startAt) / this.stepMs));
    return {
      x: segment.from.x + (segment.to.x - segment.from.x) * progress,
      y: segment.from.y + (segment.to.y - segment.from.y) * progress,
    };
  }

  reservations(exceptActor?: ActorId): Point[] {
    const tiles: Point[] = [];
    for (const actor of actorIds) {
      if (actor === exceptActor) continue;
      const segment = this.states[actor].segment;
      if (segment) tiles.push({ ...segment.from }, { ...segment.to });
    }
    return tiles;
  }

  reachable(actor: ActorId, snapshot: SessionSnapshot = this.session.snapshot()): Point[] {
    return reachableTiles(snapshot.world, actor, this.reservations(actor));
  }

  nextTile(actor: ActorId): Point {
    return { ...(this.states[actor].segment?.to ?? this.session.snapshot().world.actors[actor].position) };
  }

  canStepTo(actor: ActorId, to: Point): boolean {
    const { paused, world } = this.session.snapshot();
    const start = world.actors[actor].position;
    return !this.disposed && !this.sessionEnded && !paused && !this.isMoving(actor)
      && Math.abs(to.x - start.x) + Math.abs(to.y - start.y) === 1
      && canStand(world, actor, to)
      && !this.reservations(actor).some(tile => sameTile(tile, to));
  }

  walkTo(actor: ActorId, to: Point, metadata?: DispatchMetadata): WalkResult {
    return this.session.batchEvents(() => this.submitRoute(actor, to, metadata));
  }

  private submitRoute(actor: ActorId, to: Point, metadata?: DispatchMetadata): WalkResult {
    const command: RouteCommand = {
      commandId: metadata?.commandId ?? this.session.nextId(),
      requestId: metadata?.requestId,
      to: { ...to },
      path: [],
    };
    this.record('routeSubmitted', actor, command);
    const reject = (reason: string): WalkResult => {
      this.finish(actor, command, 'rejected', reason);
      return { ok: false, commandId: command.commandId, reason };
    };

    const snapshot = this.session.snapshot();
    if (this.disposed || this.sessionEnded || snapshot.paused) return reject('Movement is paused or unavailable.');
    const motion = this.states[actor];
    const start = motion.segment?.to ?? snapshot.world.actors[actor].position;
    const path = findRoute(snapshot.world, actor, to, this.reservations(actor), start);
    if (!path) return reject('Choose a reachable, unoccupied floor tile.');

    if (motion.active) {
      const superseded = motion.queued;
      motion.stopAfterStep = false;
      motion.queued = command;
      if (superseded) this.finish(actor, superseded, 'superseded', 'A newer route replaced the queued route.');
      return { ok: true, commandId: command.commandId, status: 'queued' };
    }

    if (!path.length) {
      this.finish(actor, command, 'noop');
      return { ok: true, commandId: command.commandId, status: 'noop' };
    }

    command.path = path;
    motion.active = command;
    this.startStep(actor, command);
    this.record('routeStarted', actor, command);
    return { ok: true, commandId: command.commandId, status: 'started' };
  }

  stopAfterStep(actor: ActorId) {
    const motion = this.states[actor];
    if (!motion.active) return;
    const queued = motion.queued;
    motion.queued = undefined;
    motion.stopAfterStep = true;
    if (queued) this.finish(actor, queued, 'canceled', 'Directional movement took over.');
  }

  dispose() {
    this.session.batchEvents(() => {
      if (this.disposed) return;
      this.disposed = true;
      this.cancelAll();
      this.detachGuard();
      this.unsubscribe();
    });
  }

  private record(kind: 'routeSubmitted' | 'routeStarted', actor: ActorId, command: RouteCommand) {
    this.session.record({ kind, ...this.fields(actor, command) });
  }

  private fields(actor: ActorId, command: RouteCommand) {
    const { commandId, requestId, to } = command;
    const action: WalkAction = { type: 'walkTo', to: { ...to } };
    return { actor, commandId, requestId, action, snapshot: this.session.snapshot() };
  }

  private finish(actor: ActorId, command: RouteCommand, outcome: RouteOutcome, reason?: string) {
    this.session.record({ kind: 'routeFinished', ...this.fields(actor, command), outcome, reason });
  }

  private startStep(actor: ActorId, command: RouteCommand) {
    const { activeMs, world } = this.session.snapshot();
    const from = world.actors[actor].position;
    const to = command.path.shift()!;
    const endAt = activeMs + this.stepMs;
    const segment: Segment = {
      from, to, startAt: activeMs,
      cancel: this.session.scheduleAt(endAt, () => {
        this.session.batchEvents(() => this.settleStep(actor, command, segment));
      }),
    };
    this.states[actor].segment = segment;
  }

  private settleStep(actor: ActorId, command: RouteCommand, segment: Segment) {
    const motion = this.states[actor];
    if (motion.active !== command || motion.segment !== segment) return;
    const commandId = this.session.nextId();
    const metadata: DispatchMetadata = {
      commandId, routeCommandId: command.commandId, requestId: command.requestId, source: 'movement-step',
    };
    // Release both reservations immediately before the synchronous commit. The source
    // remains occupied in world state until dispatch commits the destination.
    motion.segment = undefined;
    this.stepCommit = { actor, commandId, to: segment.to };
    try {
      this.session.dispatch(actor, { type: 'move', to: segment.to }, undefined, metadata);
    } finally {
      this.stepCommit = undefined;
    }
    if (motion.active !== command) return;

    const { world } = this.session.snapshot();
    const atGoal = sameTile(world.actors[actor].position, command.to);
    if (motion.stopAfterStep) {
      motion.stopAfterStep = false;
      motion.active = undefined;
      this.finish(actor, command, atGoal ? 'arrived' : 'canceled', atGoal ? undefined : 'Directional movement took over.');
      return;
    }
    if (motion.queued) {
      const replacement = motion.queued;
      motion.queued = undefined;
      const path = findRoute(world, actor, replacement.to, this.reservations(actor));
      if (!path) {
        this.finish(actor, replacement, 'blocked', 'The queued destination is no longer reachable.');
      } else {
        motion.active = undefined;
        if (!path.length) {
          this.finish(actor, command, atGoal ? 'arrived' : 'superseded');
          this.finish(actor, replacement, 'noop');
        } else {
          replacement.path = path;
          motion.active = replacement;
          this.startStep(actor, replacement);
          this.finish(actor, command, atGoal ? 'arrived' : 'superseded');
          this.record('routeStarted', actor, replacement);
        }
        return;
      }
    }

    if (atGoal) {
      motion.active = undefined;
      this.finish(actor, command, 'arrived');
      return;
    }

    const next = command.path[0];
    const reserved = this.reservations(actor);
    const position = world.actors[actor].position;
    if (!next || Math.abs(next.x - position.x) + Math.abs(next.y - position.y) !== 1
      || !canStand(world, actor, next) || reserved.some(tile => sameTile(tile, next))) {
      command.path = findRoute(world, actor, command.to, reserved) ?? [];
    }
    if (!command.path.length) {
      motion.active = undefined;
      this.finish(actor, command, 'blocked', 'The destination is no longer reachable.');
      return;
    }

    this.startStep(actor, command);
  }

  private cancelAll() {
    const commands: Array<[ActorId, RouteCommand]> = [];
    for (const actor of actorIds) {
      const { active, queued, segment } = this.states[actor];
      segment?.cancel();
      this.states[actor] = {};
      if (active) commands.push([actor, active]);
      if (queued) commands.push([actor, queued]);
    }
    for (const [actor, command] of commands) this.finish(actor, command, 'canceled', 'The scene ended.');
  }
}
