import { MovementController } from '../movement';
import { RealtimeSession, type SessionEvent } from '../realtime';
import {
  actionsFor, createWorld, layout, type Action, type ObjectId, type Point,
  type World,
} from '../world';
import type {
  ActorLocalObservation, SimulationAction, SimulationCommittedEvent, SimulationDispatchOutcome,
  SimulationOption, SimulationRoomCheckpoint, SimulationRoomEventPayload, WitnessedObservationEvent,
  SimulationActorId,
} from './contracts';

const actorIds: readonly SimulationActorId[] = ['player', 'mara', 'riley', 'jo'];
const objectIds: readonly ObjectId[] = ['papers', 'mug1', 'mug2', 'towel'];
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const copyPoint = (point: Point): Point => ({ x: point.x, y: point.y });

export interface SimulationRoomOptions {
  runId?: string;
  checkpoint?: SimulationRoomCheckpoint;
  nextEventSequence?: number;
  now?: () => number;
  routeStepMs?: number;
  hearingDistance?: number;
  sightDistance?: number;
}

function initialWorld(): World<SimulationActorId> {
  const base = createWorld();
  const actors = {
    mara: { position: { x: 2, y: 3 } },
    riley: { position: { x: 3, y: 4 } },
    jo: { position: { x: 4, y: 3 } },
  };
  return { ...base, actors: actors as unknown as World<SimulationActorId>['actors'] } as unknown as World<SimulationActorId>;
}

function worldFromCheckpoint(checkpoint: SimulationRoomCheckpoint): World<SimulationActorId> {
  const base = initialWorld();
  const actors = Object.fromEntries(Object.entries(checkpoint.actors).map(([id, position]) => [id, { position: copyPoint(position!) }]));
  return {
    ...base,
    actors: actors as unknown as World<SimulationActorId>['actors'],
    objects: structuredClone(checkpoint.objects) as World<SimulationActorId>['objects'],
    windowOpen: checkpoint.windowOpen,
  } as unknown as World<SimulationActorId>;
}

export class SimulationRoom {
  private readonly runId: string;
  private readonly session: RealtimeSession<SimulationActorId>;
  private readonly movement: MovementController<SimulationActorId>;
  private readonly listeners = new Set<(event: SimulationCommittedEvent) => void>();
  private readonly witnessed = new Map<SimulationActorId, WitnessedObservationEvent[]>();
  private eventCapture?: SimulationCommittedEvent[];
  private sequence: number;
  private paused = false;
  private readonly sightDistance: number;
  private readonly hearingDistance: number;
  private directedRecipient?: SimulationActorId;
  private renderCache?: Partial<Record<SimulationActorId, Point>>;
  private readonly now: () => number;

  constructor(options: SimulationRoomOptions = {}) {
    this.runId = options.runId ?? 'simulation-run';
    this.sequence = options.nextEventSequence ?? 1;
    this.sightDistance = options.sightDistance ?? 6;
    this.hearingDistance = options.hearingDistance ?? 5;
    this.now = options.now ?? (() => performance.now());
    const initial = options.checkpoint ? worldFromCheckpoint(options.checkpoint) : initialWorld();
    this.session = new RealtimeSession<SimulationActorId>({
      now: this.now,
      initialWorld: initial,
      wetnessIntervalMs: 4_000,
      onEvent: event => this.onSessionEvent(event),
    });
    this.movement = new MovementController(this.session, options.routeStepMs ?? 180);
    if (options.checkpoint) this.session.restoreClock(
      options.checkpoint.activeTimeMs, options.checkpoint.rainExposureMs, options.checkpoint.revision,
    );
  }

  checkpoint(): SimulationRoomCheckpoint {
    const { activeMs, revision, world } = this.session.snapshot();
    const actors: SimulationRoomCheckpoint['actors'] = {};
    for (const [actorId, state] of Object.entries(world.actors)) {
      if (state) actors[actorId as SimulationActorId] = copyPoint(state.position);
    }
    const objects = {} as SimulationRoomCheckpoint['objects'];
    for (const objectId of objectIds) objects[objectId] = structuredClone(world.objects[objectId]);
    return {
      activeTimeMs: activeMs,
      revision,
      actors,
      objects,
      windowOpen: world.windowOpen,
      rainExposureMs: this.session.rainExposureMs(),
    };
  }

  observationFor(actorId: SimulationActorId): ActorLocalObservation {
    const checkpoint = this.checkpoint();
    const selfPosition = checkpoint.actors[actorId];
    if (!selfPosition) throw new Error(`Actor ${actorId} is not in the room.`);
    const world = this.session.snapshot().world;
    const visibleActors = actorIds.flatMap(otherId => {
      if (otherId === actorId) return [];
      const position = checkpoint.actors[otherId];
      return position && distance(selfPosition, position) <= this.sightDistance
        ? [{ actorId: otherId, position: copyPoint(position) }] : [];
    });
    const visibleObjects = objectIds.flatMap(objectId => {
      const item = world.objects[objectId];
      const position = 'surface' in item.location
        ? layout.surfaces[item.location.surface]
        : checkpoint.actors[item.location.heldBy];
      return position && distance(selfPosition, position) <= this.sightDistance
        ? [{ objectId, location: structuredClone(item.location), wetness: item.wetness }] : [];
    });
    return {
      actorId,
      activeTimeMs: checkpoint.activeTimeMs,
      revision: checkpoint.revision,
      selfPosition: copyPoint(selfPosition),
      visibleActors,
      visibleObjects,
      windowOpen: checkpoint.windowOpen,
      rainExposureMs: checkpoint.rainExposureMs,
    };
  }

  optionsFor(actorId: SimulationActorId): SimulationOption[] {
    const world = this.session.snapshot().world;
    if (!world.actors[actorId]) return [];
    const options: SimulationOption[] = [];
    const legal = actionsFor(world, actorId);
    const push = (action: SimulationAction) => options.push({ actionId: JSON.stringify(action), action });
    for (const destination of this.movement.reachable(actorId)) push({ type: 'walk', to: destination });
    for (const action of legal.interactions()) push(action);
    push({ type: 'speak' });
    for (const { actorId: recipient } of this.observationFor(actorId).visibleActors) push({ type: 'speak', recipient });
    return options;
  }

  renderPositions(): Partial<Record<SimulationActorId, Point>> {
    if (this.renderCache && actorIds.every(actorId => !this.movement.isMoving(actorId))) return this.renderCache;
    const present = this.session.actorIdsInWorld();
    const positions: Partial<Record<SimulationActorId, Point>> = {};
    const snapshot = this.session.snapshot();
    for (const actorId of present) {
      if (snapshot.world.actors[actorId]) positions[actorId] = this.movement.pose(actorId, snapshot);
    }
    if (present.every(actorId => !this.movement.isMoving(actorId))) {
      this.renderCache = Object.freeze(Object.fromEntries(Object.entries(positions)
        .map(([actorId, position]) => [actorId, Object.freeze(position)]))) as Partial<Record<SimulationActorId, Point>>;
      return this.renderCache;
    }
    this.renderCache = undefined;
    return positions;
  }

  subscribe(listener: (event: SimulationCommittedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  witnessedEventsFor(actorId: SimulationActorId): WitnessedObservationEvent[] {
    return structuredClone(this.witnessed.get(actorId) ?? []);
  }

  dispatch(actorId: SimulationActorId, action: SimulationAction, reply?: string): SimulationDispatchOutcome {
    if (this.paused) return { status: 'skipped', reason: 'paused' };
    const world = this.session.snapshot().world;
    if (!world.actors[actorId]) return { status: 'skipped', reason: 'actor-absent' };
    if (action.type === 'speak' && action.recipient
      && !this.observationFor(actorId).visibleActors.some(actor => actor.actorId === action.recipient)) {
      return { status: 'rejected', reason: 'That actor is not visible.' };
    }
    if (action.type === 'walk') {
      const result = this.movement.walkTo(actorId, action.to);
      if (!result.ok) return { status: 'rejected', reason: result.reason };
      if (result.status === 'noop') return { status: 'rejected', reason: 'Already at that tile.' };
      return { status: 'route-accepted', routeId: result.commandId };
    }
    const converted: Action = action.type === 'speak'
      ? { type: 'speak', text: reply ?? '' }
      : action as Exclude<Action, { type: 'move' } | { type: 'speak' }>;
    this.directedRecipient = action.type === 'speak' ? action.recipient : undefined;
    const batch: SimulationCommittedEvent[] = [];
    this.eventCapture = batch;
    let result: ReturnType<typeof this.session.dispatch>;
    try { result = this.session.dispatch(actorId, converted); }
    finally { this.directedRecipient = undefined; this.eventCapture = undefined; }
    if (!result.ok) return { status: 'rejected', reason: result.reason };
    const event = batch[0];
    return event ? { status: 'committed', event } : { status: 'rejected', reason: 'Action did not produce a committed event.' };
  }

  joinPlayer(position: Point = { x: 5, y: 3 }): SimulationDispatchOutcome {
    if (this.paused) return { status: 'skipped', reason: 'paused' };
    const world = this.session.snapshot().world;
    if (world.actors.player) return { status: 'rejected', reason: 'The player has already joined.' };
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y) || !this.isFreeTile(position)) {
      return { status: 'rejected', reason: 'Choose a free floor tile.' };
    }
    const next = { ...world, actors: { ...world.actors, player: { position: copyPoint(position) } } } as World<SimulationActorId>;
    this.session.commitWorld(next);
    this.renderCache = undefined;
    const event = this.commitEvent({ type: 'actor-joined', actorId: 'player', position: copyPoint(position) });
    return { status: 'committed', event };
  }

  advance(deltaMs: number): SimulationCommittedEvent[] {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) throw new RangeError('Advance duration must be non-negative and finite.');
    const batch: SimulationCommittedEvent[] = [];
    this.eventCapture = batch;
    try { this.session.advanceBy(deltaMs); }
    finally { this.eventCapture = undefined; }
    return batch;
  }

  advanceTo(wallNow = this.now()): SimulationCommittedEvent[] {
    const batch: SimulationCommittedEvent[] = [];
    this.eventCapture = batch;
    try { this.session.advanceTo(wallNow); }
    finally { this.eventCapture = undefined; }
    return batch;
  }

  pause(): SimulationRoomCheckpoint {
    this.paused = true;
    this.session.setPaused(true);
    return this.checkpoint();
  }

  resume(): void {
    this.paused = false;
    this.session.setPaused(false);
  }

  dispose(): void {
    this.movement.dispose();
    this.session.dispose();
    this.listeners.clear();
  }

  private isFreeTile(position: Point): boolean {
    const world = this.session.snapshot().world;
    return position.x >= 0 && position.x < layout.width && position.y >= 0 && position.y < layout.height
      && this.session.actorIdsInWorld().every(actor => !same(world.actors[actor]!.position, position))
      && !same(layout.window, position)
      && !Object.values(layout.surfaces).some(surface => same(surface, position))
      && this.movement.reservations().every(tile => !same(tile, position));
  }

  private onSessionEvent(event: SessionEvent<SimulationActorId>): void {
    if (event.kind === 'action' && event.status === 'completed') {
      const { actor, action, before, after } = event;
      if (action.type === 'move') {
        this.renderCache = undefined;
        this.commitEvent({ type: 'movement-tile-committed', actorId: actor,
          from: copyPoint(before.world.actors[actor]!.position), to: copyPoint(after.world.actors[actor]!.position) });
      } else if (action.type === 'speak') {
        const recipient = this.directedRecipient;
        this.commitEvent({ type: 'speech', actorId: actor, recipient, text: action.text });
      } else {
        this.commitEvent({ type: 'room-interaction', actorId: actor, action: action as SimulationRoomEventPayload extends { type: 'room-interaction'; action: infer T } ? T : never });
      }
    } else if (event.kind === 'rain') {
        this.commitEvent({ type: 'rain', exposed: true, elapsedMs: 4_000, wetnessDelta: event.amount });
    }
  }

  private commitEvent(payload: SimulationRoomEventPayload): SimulationCommittedEvent {
    const checkpoint = this.checkpoint();
    const audience = this.audience(payload);
    const sequence = this.sequence++;
    const event: SimulationCommittedEvent = {
      runId: this.runId,
      sequence,
      activeTimeMs: checkpoint.activeTimeMs,
      revision: checkpoint.revision,
      audience,
      payload: structuredClone(payload),
      afterCheckpoint: checkpoint,
      afterCheckpointProvenance: { runId: this.runId, eventSequence: sequence, revision: checkpoint.revision },
    };
    this.eventCapture?.push(event);
    const witnessedEvent: WitnessedObservationEvent = {
      runId: event.runId,
      sequence: event.sequence,
      activeTimeMs: event.activeTimeMs,
      payload: structuredClone(event.payload),
    };
    for (const actorId of audience) {
      const tail = this.witnessed.get(actorId) ?? [];
      tail.push(witnessedEvent);
      if (tail.length > 32) tail.shift();
      this.witnessed.set(actorId, tail);
    }
    for (const listener of this.listeners) {
      try { listener(event); } catch { console.error('Simulation room event listener failed.'); }
    }
    return event;
  }

  private audience(payload: SimulationRoomEventPayload): SimulationActorId[] {
    const positions = this.checkpoint().actors;
    if (payload.type === 'speech') {
      const speaker = positions[payload.actorId];
      if (!speaker) return [];
      return actorIds.filter(actorId => actorId === payload.actorId || (positions[actorId]
        && distance(speaker, positions[actorId]!) <= this.hearingDistance));
    }
    const source = 'actorId' in payload ? positions[payload.actorId] : undefined;
    const origin = payload.type === 'rain' ? layout.surfaces.table : source;
    if (!origin) return [];
    return actorIds.filter(actorId => positions[actorId] !== undefined
      && distance(origin, positions[actorId]!) <= this.sightDistance);
  }
}
