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

/** Shared request bounds. Owning modules validate before accepting or sending. */
export const SIMULATION_REQUEST_MAX_WITNESSED_EVENTS = 32;
export const SIMULATION_REQUEST_MAX_OPTIONS = 64;
export const SIMULATION_REQUEST_MAX_RECALL_BYTES = 2 * 1024;
export const SIMULATION_REQUEST_MAX_SPEECH_CHARS = 160;
export const SIMULATION_REQUEST_MAX_RATIONALE_CHARS = 1_000;

export interface SimulationDecisionReply {
  runId: string;
  requestId: string;
  generation: number;
  actorId: SimulationActorId;
  actionId: string;
  /** Required only when the selected option is speech; never embedded in it. */
  reply?: string;
  rationale: string;
  /** Provider response identifier when available, retained for audit. */
  modelResponseId?: string;
  memoryProposals?: BoundedMemoryProposals;
}

export interface SimulationDecisionAuditEntry {
  kind: 'decision';
  auditOrder: number;
  /** Exact actor-local request sent to inference, including witnessed events. */
  /** Full request is retained only when the decision reaches a terminal result. */
  request: SimulationDecisionRequest;
  modelResponseId?: string;
  actionId?: string;
  reply?: string;
  memoryProposals?: BoundedMemoryProposals;
  /** Present only when a route/action was actually selected for dispatch. */
  selectedAction?: SimulationAction;
  rationale?: string;
  outcome: 'committed' | 'stale' | 'cancelled' | 'failed';
  dispatchOutcome?: SimulationDispatchOutcome;
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
  /** Oldest source sequence retained; older memory/event references are pruned. */
  prunedThroughSequence: number;
  finalCheckpoint: SimulationRoomCheckpoint;
  finalCheckpointProvenance: { runId: string; throughSequence: number; revision: number };
}

/** Bounded audit policy: retain at most 2,000 ordered entries and 2 MiB JSON. */
export const SIMULATION_AUDIT_MAX_ENTRIES = 2_000;
export const SIMULATION_AUDIT_MAX_BYTES = 2 * 1024 * 1024;

export type SimulationDispatchOutcome =
  | { status: 'skipped'; reason: 'paused' | 'actor-absent' | 'no-route' }
  | { status: 'rejected'; reason: string }
  | { status: 'route-accepted'; routeId: string }
  | { status: 'committed'; event: SimulationCommittedEvent };

export interface SimulationSaveEnvelope {
  schemaVersion: 3;
  runId: string;
  checkpoint: SimulationRoomCheckpoint;
  memory: SimulationMemoryRecord[];
  audit: AuditSnapshot;
  nextEventSequence: number;
  writerToken: string;
  /** Durable claim generation is compared atomically on every write. */
  writerGeneration: number;
}

export interface SimulationSaveClaim {
  runId: string;
  writerToken: string;
  generation: number;
}

export type SimulationSaveMutationResult =
  | { status: 'saved'; generation: number }
  | { status: 'ownership-lost'; currentGeneration: number }
  | { status: 'missing' };

export type SimulationSaveClaimResult =
  | { status: 'claimed'; claim: SimulationSaveClaim; envelope: SimulationSaveEnvelope | null }
  | { status: 'ownership-lost'; currentGeneration: number };
