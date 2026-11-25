import {
  SIMULATION_AUDIT_MAX_BYTES,
  SIMULATION_AUDIT_MAX_ENTRIES,
  SIMULATION_REQUEST_MAX_OPTIONS,
  SIMULATION_REQUEST_MAX_RECALL_BYTES,
  SIMULATION_REQUEST_MAX_SPEECH_CHARS,
  SIMULATION_REQUEST_MAX_WITNESSED_EVENTS,
  type AuditSnapshot,
  type SimulationActorId,
  type SimulationAuditEntry,
  type SimulationCommittedEvent,
  type SimulationDecisionAuditEntry,
  type SimulationRoomCheckpoint,
} from './contracts';

/** Bounded, replayable audit trail for one simulation run. */
export class SimulationAudit {
  private runId?: string;
  private startingCheckpoint?: SimulationRoomCheckpoint;
  private startingCheckpointProvenance?: AuditSnapshot['startingCheckpointProvenance'];
  private entries: SimulationAuditEntry[] = [];
  private prunedThroughSequence = 0;
  private lastSequence = 0;
  private nextAuditOrder = 0;

  start(runId: string, checkpoint: SimulationRoomCheckpoint): void {
    if (!runId.trim()) throw new Error('Audit runId must not be empty.');
    assertCheckpoint(checkpoint, 'starting checkpoint');
    this.runId = runId;
    this.startingCheckpoint = clone(checkpoint);
    this.startingCheckpointProvenance = {
      runId, throughSequence: 0, revision: checkpoint.revision, source: 'run-start',
    };
    this.entries = [];
    this.prunedThroughSequence = 0;
    this.lastSequence = 0;
    this.nextAuditOrder = 0;
  }

  recordEvent(event: SimulationCommittedEvent): void {
    this.assertStarted();
    validateCommittedEvent(event, this.runId!, this.lastSequence);
    this.entries.push({ kind: 'committed-event', auditOrder: this.nextAuditOrder++, event: clone(event) });
    this.lastSequence = event.sequence;
    this.trimToBounds();
  }

  recordDecision(entry: Omit<SimulationDecisionAuditEntry, 'kind' | 'auditOrder'>): void {
    this.assertStarted();
    if (entry.request.runId !== this.runId || entry.request.actorId !== entry.request.observation.actorId)
      throw new Error('Decision request does not belong to this run and actor.');
    if (!Number.isFinite(entry.startedAtActiveMs) || !Number.isFinite(entry.finishedAtActiveMs) ||
      entry.startedAtActiveMs < 0 || entry.finishedAtActiveMs < entry.startedAtActiveMs)
      throw new Error('Decision timing is invalid.');
    const complete: SimulationDecisionAuditEntry = {
      ...clone(entry), kind: 'decision', auditOrder: this.nextAuditOrder++,
    };
    validateDecision(complete, this.runId!);
    this.entries.push(complete);
    this.trimToBounds();
  }

  snapshot(finalCheckpoint: SimulationRoomCheckpoint): AuditSnapshot {
    this.assertStarted();
    assertCheckpoint(finalCheckpoint, 'final checkpoint');
    const firstRetainedSequence = this.firstRetainedSequence();
    const result: AuditSnapshot = {
      schemaVersion: 3,
      runId: this.runId!,
      startingCheckpoint: clone(this.startingCheckpoint!),
      startingCheckpointProvenance: clone(this.startingCheckpointProvenance!),
      firstRetainedSequence,
      entries: clone(this.entries),
      prunedThroughSequence: this.prunedThroughSequence,
      finalCheckpoint: clone(finalCheckpoint),
      finalCheckpointProvenance: {
        runId: this.runId!, throughSequence: this.lastSequence, revision: finalCheckpoint.revision,
      },
    };
    validateAuditSnapshot(result);
    return result;
  }

  exportJSON(finalCheckpoint: SimulationRoomCheckpoint): string {
    return JSON.stringify(this.snapshot(finalCheckpoint));
  }

  /** Validate first, then install. Invalid imported final state is never restored. */
  restore(snapshot: unknown): void {
    const validated = validateAuditSnapshot(snapshot);
    // Replay is deliberately part of restore validation; it verifies non-clock state.
    this.replay(validated);
    this.runId = validated.runId;
    this.startingCheckpoint = clone(validated.startingCheckpoint);
    this.startingCheckpointProvenance = clone(validated.startingCheckpointProvenance);
    this.entries = clone(validated.entries);
    this.prunedThroughSequence = validated.prunedThroughSequence;
    this.lastSequence = validated.finalCheckpointProvenance.throughSequence;
    this.nextAuditOrder = validated.entries.length
      ? validated.entries[validated.entries.length - 1].auditOrder + 1 : 0;
  }

  importJSON(json: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error('Audit export is not valid JSON.'); }
    this.restore(parsed);
  }

  replay(snapshot: unknown): SimulationRoomCheckpoint {
    const checked = validateAuditSnapshot(snapshot);
    let state = clone(checked.startingCheckpoint);
    let lastSequence = checked.startingCheckpointProvenance.throughSequence;
    for (const entry of checked.entries) {
      if (entry.kind !== 'committed-event') continue;
      validateCommittedEvent(entry.event, checked.runId, lastSequence);
      state = clone(entry.event.afterCheckpoint);
      lastSequence = entry.event.sequence;
    }
    if (lastSequence !== checked.finalCheckpointProvenance.throughSequence)
      throw new Error('Replay event cursor does not match final checkpoint provenance.');
    if (!sameNonClockState(state, checked.finalCheckpoint))
      throw new Error('Replay state differs from exported final committed state.');
    // Time/exposure can advance without a material event. Apply only after state checks.
    state.activeTimeMs = checked.finalCheckpoint.activeTimeMs;
    state.rainExposureMs = checked.finalCheckpoint.rainExposureMs;
    return state;
  }

  eventsFor(actorId: SimulationActorId): SimulationAuditEntry[] {
    return this.entries.filter(entry => entry.kind === 'decision'
      ? entry.request.actorId === actorId
      : entry.event.audience.includes(actorId)).map(clone);
  }

  private firstRetainedSequence(): number {
    const event = this.entries.find(entry => entry.kind === 'committed-event');
    return event?.event.sequence ?? this.lastSequence + 1;
  }

  private trimToBounds(): void {
    while (this.entries.length > SIMULATION_AUDIT_MAX_ENTRIES || byteLength(this.entries) > SIMULATION_AUDIT_MAX_BYTES) {
      if (this.entries.length <= 1) throw new Error('A single audit entry exceeds the retention limit.');
      const removed = this.entries.shift()!;
      if (removed.kind === 'committed-event') {
        this.startingCheckpoint = clone(removed.event.afterCheckpoint);
        this.startingCheckpointProvenance = {
          runId: this.runId!, throughSequence: removed.event.sequence,
          revision: removed.event.revision, source: 'retention-boundary',
        };
        this.prunedThroughSequence = removed.event.sequence;
      }
    }
  }

  private assertStarted(): void {
    if (!this.runId || !this.startingCheckpoint || !this.startingCheckpointProvenance)
      throw new Error('Audit has not been started or restored.');
  }
}

/** Validates untrusted schema-v3 JSON and returns a detached, typed snapshot. */
export function validateAuditSnapshot(value: unknown): AuditSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 3 || typeof value.runId !== 'string' || !value.runId.trim() ||
    !Array.isArray(value.entries) || value.entries.length > SIMULATION_AUDIT_MAX_ENTRIES ||
    byteLength(value) > SIMULATION_AUDIT_MAX_BYTES)
    throw new Error('Audit export header or bounds are invalid.');
  const snapshot = value as unknown as AuditSnapshot;
  assertCheckpoint(snapshot.startingCheckpoint, 'starting checkpoint');
  assertCheckpoint(snapshot.finalCheckpoint, 'final checkpoint');
  const start = snapshot.startingCheckpointProvenance;
  const end = snapshot.finalCheckpointProvenance;
  if (!isRecord(start) || start.runId !== snapshot.runId || !isInt(start.throughSequence) ||
    start.throughSequence < 0 || start.revision !== snapshot.startingCheckpoint.revision ||
    !['run-start', 'retention-boundary'].includes(String(start.source)) ||
    !isRecord(end) || end.runId !== snapshot.runId || !isInt(end.throughSequence) ||
    end.throughSequence < start.throughSequence || end.revision !== snapshot.finalCheckpoint.revision ||
    !isInt(snapshot.prunedThroughSequence) || snapshot.prunedThroughSequence < 0 ||
    !isInt(snapshot.firstRetainedSequence) || snapshot.firstRetainedSequence < 1)
    throw new Error('Audit checkpoint provenance is invalid.');
  if ((start.source === 'run-start' && (start.throughSequence !== 0 || snapshot.prunedThroughSequence !== 0)) ||
    (start.source === 'retention-boundary' && (start.throughSequence !== snapshot.prunedThroughSequence || start.throughSequence === 0)))
    throw new Error('Audit retention boundary provenance is invalid.');
  let previousOrder = -1;
  let previousSequence = start.throughSequence;
  let previousTime = snapshot.startingCheckpoint.activeTimeMs;
  let lastEventSequence: number | undefined;
  for (const item of snapshot.entries) {
    if (!isRecord(item) || !isInt(item.auditOrder) || item.auditOrder <= previousOrder)
      throw new Error('Audit entry order is invalid.');
    previousOrder = item.auditOrder;
    if (item.kind === 'committed-event') {
      validateCommittedEvent(item.event, snapshot.runId, previousSequence);
      if (item.event.sequence < snapshot.firstRetainedSequence)
        throw new Error('Retained event precedes the retained boundary.');
      previousSequence = item.event.sequence;
      lastEventSequence = item.event.sequence;
      previousTime = item.event.activeTimeMs;
    } else if (item.kind === 'decision') {
      validateDecision(item, snapshot.runId);
      if (item.finishedAtActiveMs < previousTime) throw new Error('Decision timing is out of audit order.');
      previousTime = item.finishedAtActiveMs;
    } else throw new Error('Unknown audit entry kind.');
  }
  if (previousSequence !== end.throughSequence || snapshot.finalCheckpoint.activeTimeMs < previousTime)
    throw new Error('Audit final cursor or clock is invalid.');
  const expectedFirst = lastEventSequence === undefined ? end.throughSequence + 1 :
    snapshot.entries.find((entry): entry is Extract<SimulationAuditEntry, { kind: 'committed-event' }> => entry.kind === 'committed-event')!.event.sequence;
  if (snapshot.firstRetainedSequence !== expectedFirst) throw new Error('Audit retained event boundary is inconsistent.');
  return clone(snapshot);
}

/** Resolve source event references without pretending pruned evidence is absent. */
export function sourceEventStatus(sequence: number, snapshot: AuditSnapshot): 'retained' | 'pruned' | 'missing' {
  if (!isInt(sequence) || sequence === 0) return 'missing';
  if (sequence <= snapshot.prunedThroughSequence) return 'pruned';
  return snapshot.entries.some(entry => entry.kind === 'committed-event' && entry.event.sequence === sequence)
    ? 'retained' : 'missing';
}

function validateDecision(entry: SimulationDecisionAuditEntry, runId: string): void {
  const request = entry.request;
  if (!isRecord(request) || request.runId !== runId || typeof request.requestId !== 'string' || !request.requestId ||
    !Number.isInteger(request.generation) || request.generation < 0 ||
    !['player', 'mara', 'riley', 'jo'].includes(request.actorId) ||
    !isInt(request.observedRevision) || !isRecord(request.observation) || request.observation.actorId !== request.actorId ||
    !isInt(request.observation.activeTimeMs) || request.observation.revision !== request.observedRevision ||
    !isPoint(request.observation.selfPosition) || typeof request.observation.windowOpen !== 'boolean' ||
    !isInt(request.observation.rainExposureMs) || !Array.isArray(request.observation.visibleActors) ||
    !Array.isArray(request.observation.visibleObjects) || !isRecord(request.recall) || request.recall.actorId !== request.actorId ||
    !Array.isArray(request.recall.records) || !Array.isArray(request.recall.retrievedMemoryIds) ||
    byteLength(request.recall) > SIMULATION_REQUEST_MAX_RECALL_BYTES ||
    !Array.isArray(request.witnessedEvents) || request.witnessedEvents.length > SIMULATION_REQUEST_MAX_WITNESSED_EVENTS ||
    !request.witnessedEvents.every(event => isRecord(event) && event.runId === runId && isInt(event.sequence) &&
      isInt(event.activeTimeMs) && isRecord(event.payload)) ||
    !Array.isArray(request.options) || request.options.length > SIMULATION_REQUEST_MAX_OPTIONS ||
    !request.options.every(option => isRecord(option) && typeof option.actionId === 'string' && isRecord(option.action)) ||
    !Number.isFinite(entry.startedAtActiveMs) || !Number.isFinite(entry.finishedAtActiveMs) ||
    entry.finishedAtActiveMs < entry.startedAtActiveMs ||
    !['committed', 'stale', 'cancelled', 'failed'].includes(entry.outcome))
    throw new Error('Decision audit entry is malformed.');
  if (entry.kind !== 'decision' || typeof entry.auditOrder !== 'number') throw new Error('Decision audit envelope is malformed.');
  if (entry.reply !== undefined && (typeof entry.reply !== 'string' || entry.reply.length > SIMULATION_REQUEST_MAX_SPEECH_CHARS))
    throw new Error('Decision reply exceeds the speech limit.');
}

function validateCommittedEvent(event: SimulationCommittedEvent, runId: string, afterSequence: number): void {
  if (!isRecord(event) || event.runId !== runId || !isInt(event.sequence) || event.sequence !== afterSequence + 1 ||
    !isInt(event.activeTimeMs) || !isInt(event.revision) || !Array.isArray(event.audience) ||
    !isRecord(event.payload) || !isRecord(event.afterCheckpoint) || !isRecord(event.afterCheckpointProvenance))
    throw new Error('Committed audit event is malformed or misordered.');
  assertCheckpoint(event.afterCheckpoint, 'event after-checkpoint');
  if (event.afterCheckpointProvenance.runId !== runId || event.afterCheckpointProvenance.eventSequence !== event.sequence ||
    event.afterCheckpointProvenance.revision !== event.revision || event.afterCheckpoint.revision !== event.revision ||
    event.afterCheckpoint.activeTimeMs !== event.activeTimeMs ||
    !event.audience.every(id => ['player', 'mara', 'riley', 'jo'].includes(id)))
    throw new Error('Committed event checkpoint provenance is invalid.');
  validatePayload(event.payload);
}

function validatePayload(value: Record<string, unknown>): void {
  if (typeof value.type !== 'string' || !['actor-joined', 'movement-tile-committed', 'speech', 'room-interaction', 'rain'].includes(value.type))
    throw new Error('Audit event payload type is invalid.');
  if ('actorId' in value && !['player', 'mara', 'riley', 'jo'].includes(String(value.actorId)))
    throw new Error('Audit event actor is invalid.');
  if (value.type === 'speech' && (typeof value.text !== 'string' || value.text.length > 160)) throw new Error('Audit speech is invalid.');
}

function assertCheckpoint(value: SimulationRoomCheckpoint, label: string): void {
  if (!isRecord(value) || !isInt(value.activeTimeMs) || !isInt(value.revision) || value.revision < 0 ||
    !isRecord(value.actors) || !isRecord(value.objects) || typeof value.windowOpen !== 'boolean' ||
    !isInt(value.rainExposureMs) || value.rainExposureMs < 0) throw new Error(`Audit ${label} is malformed.`);
  for (const [actor, position] of Object.entries(value.actors)) {
    if (!['player', 'mara', 'riley', 'jo'].includes(actor) || !isPoint(position)) throw new Error(`Audit ${label} has an invalid actor position.`);
  }
  const objectIds = ['papers', 'mug1', 'mug2', 'towel'];
  if (Object.keys(value.objects).length !== objectIds.length || Object.keys(value.objects).some(id => !objectIds.includes(id)))
    throw new Error(`Audit ${label} has invalid room objects.`);
  for (const object of Object.values(value.objects)) {
    if (!isRecord(object) || !Number.isFinite(object.wetness) || object.wetness < 0 || !isRecord(object.location))
      throw new Error(`Audit ${label} has malformed object state.`);
    const location = object.location;
    if (!(('heldBy' in location && ['player', 'mara', 'riley', 'jo'].includes(String(location.heldBy))) ||
      ('surface' in location && ['table', 'counter'].includes(String(location.surface)))))
      throw new Error(`Audit ${label} has malformed object state.`);
  }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isInt(value.x) && isInt(value.y);
}
function isInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function byteLength(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
function sameNonClockState(a: SimulationRoomCheckpoint, b: SimulationRoomCheckpoint): boolean {
  return a.revision === b.revision && a.windowOpen === b.windowOpen && JSON.stringify(a.actors) === JSON.stringify(b.actors) &&
    JSON.stringify(a.objects) === JSON.stringify(b.objects);
}
function clone<T>(value: T): T { return structuredClone(value); }
