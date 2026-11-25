import type { Action, ObjectId, Point, SurfaceId } from '../world';

/** Stable identities used by the simulation; legacy ActorId stays unchanged. */
export type SimulationActorId = 'player' | 'mara' | 'riley' | 'jo';
export type NpcId = Exclude<SimulationActorId, 'player'>;

/** Movement is committed one tile at a time. Speech content travels separately. */
export type SimulationAction =
  | { type: 'walk'; to: Point }
  | Exclude<Action, { type: 'move' } | { type: 'speak' }>
  | { type: 'speak'; recipient?: SimulationActorId };

/** Speech has one option per permitted recipient and one unaddressed option. */
export interface SimulationOption {
  actionId: string;
  action: SimulationAction;
}

export interface SimulationRoomObject {
  location: { heldBy: SimulationActorId } | { surface: SurfaceId };
  wetness: number;
}

/** A save/replay-safe world state: committed tiles only, with no in-flight work. */
export interface SimulationRoomCheckpoint {
  activeTimeMs: number;
  revision: number;
  actors: Partial<Record<SimulationActorId, Point>>;
  objects: Record<ObjectId, SimulationRoomObject>;
  windowOpen: boolean;
  /** Milliseconds of accumulated rain exposure, including a partial interval. */
  rainExposureMs: number;
}

export interface SimulationVisibleActor {
  actorId: SimulationActorId;
  position: Point;
}

export interface SimulationVisibleObject {
  objectId: ObjectId;
  location: SimulationRoomObject['location'];
  wetness: number;
}

/** Explicit actor-local projection. It intentionally has no whole-world field. */
export interface ActorLocalObservation {
  actorId: SimulationActorId;
  activeTimeMs: number;
  revision: number;
  selfPosition: Point;
  visibleActors: SimulationVisibleActor[];
  visibleObjects: SimulationVisibleObject[];
  windowOpen: boolean;
  rainExposureMs: number;
}

export type SimulationRoomEventPayload =
  | { type: 'actor-joined'; actorId: SimulationActorId; position: Point }
  | { type: 'movement-tile-committed'; actorId: SimulationActorId; from: Point; to: Point }
  | { type: 'speech'; actorId: SimulationActorId; recipient?: SimulationActorId; text: string }
  | { type: 'room-interaction'; actorId: SimulationActorId; action: Exclude<Action, { type: 'move' } | { type: 'speak' }> }
  | { type: 'rain'; exposed: boolean; elapsedMs: number; wetnessDelta: number };

/** Authoritative committed event; never place this envelope in a model request. */
export interface SimulationCommittedEvent {
  runId: string;
  sequence: number;
  activeTimeMs: number;
  revision: number;
  audience: SimulationActorId[];
  payload: SimulationRoomEventPayload;
  /** Settled state makes replay independent of re-running action logic. */
  afterCheckpoint: SimulationRoomCheckpoint;
  afterCheckpointProvenance: { runId: string; eventSequence: number; revision: number };
}

/** Safe event representation selected for one witnessing actor. */
export interface WitnessedObservationEvent {
  runId: string;
  sequence: number;
  activeTimeMs: number;
  payload: SimulationRoomEventPayload;
}

export type SimulationMemoryRecord =
  | {
      id: string;
      kind: 'observation';
      owner: SimulationActorId;
      sourceEventIds: [string];
      text: string;
      activeTimeMs: number;
    }
  | {
      id: string;
      kind: 'attributed-speech';
      owner: SimulationActorId;
      speaker: SimulationActorId;
      sourceEventIds: [string];
      exactLine: string;
      activeTimeMs: number;
    }
  | {
      id: string;
      kind: 'commitment';
      owner: SimulationActorId;
      speaker: SimulationActorId;
      sourceEventIds: [string, ...string[]];
      exactLine: string;
      status: 'open' | 'completed' | 'withdrawn';
      activeTimeMs: number;
    };

/** Proposals can only cite witnessed lines; the memory port validates grounding. */
export type SimulationMemoryProposal =
  | { kind: 'open-commitment'; sourceEventId: string; exactLine: string }
  | {
      kind: 'close-commitment';
      commitmentId: string;
      sourceEventId: string;
      exactLine: string;
      outcome: 'completed' | 'withdrawn';
    };

export type BoundedMemoryProposals =
  | []
  | [SimulationMemoryProposal]
  | [SimulationMemoryProposal, SimulationMemoryProposal]
  | [SimulationMemoryProposal, SimulationMemoryProposal, SimulationMemoryProposal];

export interface SimulationActorRecall {
  actorId: SimulationActorId;
  records: SimulationMemoryRecord[];
  retrievedMemoryIds: string[];
}

/** Decision lifetime is requestId/generation; run event sequence is separate. */
export interface SimulationDecisionRequest {
  runId: string;
  requestId: string;
  generation: number;
  actorId: SimulationActorId;
  observedRevision: number;
  observation: ActorLocalObservation;
  witnessedEvents: WitnessedObservationEvent[];
  options: SimulationOption[];
  recall: SimulationActorRecall;
}

export interface SimulationDecisionReply {
  runId: string;
  requestId: string;
  generation: number;
  actorId: SimulationActorId;
  actionId: string;
  /** Required only when the selected option is speech; never embedded in it. */
  reply?: string;
  rationale: string;
  memoryProposals?: BoundedMemoryProposals;
}

export interface SimulationDecisionAuditEntry {
  kind: 'decision';
  runId: string;
  auditOrder: number;
  actorId: SimulationActorId;
  requestId: string;
  generation: number;
  actionId?: string;
  rationale?: string;
  observedRevision: number;
  observation: ActorLocalObservation;
  recall: SimulationActorRecall;
  options: SimulationOption[];
  outcome: 'committed' | 'stale' | 'cancelled' | 'failed';
  reason?: string;
  startedAtActiveMs: number;
  finishedAtActiveMs: number;
}

export type SimulationAuditEntry =
  | { kind: 'committed-event'; auditOrder: number; event: SimulationCommittedEvent }
  | SimulationDecisionAuditEntry;

/** Retained bounded audit history; finalCheckpoint captures clock/exposure at export. */
export interface AuditSnapshot {
  schemaVersion: 3;
  runId: string;
  startingCheckpoint: SimulationRoomCheckpoint;
  startingCheckpointProvenance: {
    runId: string;
    throughSequence: number;
    revision: number;
    source: 'run-start' | 'retention-boundary';
  };
  firstRetainedSequence: number;
  entries: SimulationAuditEntry[];
  finalCheckpoint: SimulationRoomCheckpoint;
  finalCheckpointProvenance: { runId: string; throughSequence: number; revision: number };
}

export interface SimulationSaveEnvelope {
  schemaVersion: 3;
  runId: string;
  checkpoint: SimulationRoomCheckpoint;
  memory: SimulationMemoryRecord[];
  audit: AuditSnapshot;
  nextEventSequence: number;
  writerToken: string;
}

/** Stable ports for the parallel room, scheduler, memory, save, and audit work. */
export interface SimulationRoom {
  checkpoint(): SimulationRoomCheckpoint;
  observationFor(actorId: SimulationActorId): ActorLocalObservation;
  optionsFor(actorId: SimulationActorId): SimulationOption[];
  subscribe(listener: (event: SimulationCommittedEvent) => void): () => void;
  dispatch(actorId: SimulationActorId, action: SimulationAction, reply?: string): Promise<SimulationCommittedEvent | null>;
  joinPlayer(position?: Point): Promise<SimulationCommittedEvent | null>;
  pause(): void;
}

export interface SimulationScheduler {
  wake(actorId: SimulationActorId, reason: string): void;
  pause(): void;
  resume(): void;
  cancelAll(reason: string): void;
  dispose(): void;
}

export interface SimulationMemory {
  ingest(event: SimulationCommittedEvent, forActor: SimulationActorId): void;
  recall(actorId: SimulationActorId, observation: ActorLocalObservation, budgetBytes?: number): SimulationActorRecall;
  applyProposals(actorId: SimulationActorId, proposals: SimulationMemoryProposal[], witnessedEvents: WitnessedObservationEvent[]): SimulationMemoryRecord[];
  snapshot(): SimulationMemoryRecord[];
  restore(records: SimulationMemoryRecord[]): void;
}

export interface SimulationSaveStore {
  load(runId: string): Promise<SimulationSaveEnvelope | null>;
  save(envelope: SimulationSaveEnvelope): Promise<void>;
  clear(runId: string): Promise<void>;
}

export interface SimulationAudit {
  start(runId: string, checkpoint: SimulationRoomCheckpoint): void;
  recordEvent(event: SimulationCommittedEvent): void;
  recordDecision(entry: Omit<SimulationDecisionAuditEntry, 'kind' | 'auditOrder'>): void;
  snapshot(finalCheckpoint: SimulationRoomCheckpoint): AuditSnapshot;
  replay(snapshot: AuditSnapshot): SimulationRoomCheckpoint;
  eventsFor(actorId: SimulationActorId): SimulationAuditEntry[];
}
