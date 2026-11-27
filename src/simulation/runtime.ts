import type {
  AuditSnapshot, NpcId, SimulationAction, SimulationActorId, SimulationCommittedEvent,
  SimulationDecisionAuditEntry, SimulationDecisionReply, SimulationDecisionRequest,
  SimulationDispatchOutcome, SimulationRoomCheckpoint, SimulationSaveClaim,
  SimulationSaveEnvelope,
} from './contracts';
import { SimulationRoom } from './room';
import { SimulationScheduler, SimulationRateLimitError } from './scheduler';
import { SimulationMemory } from './memory';
import { SimulationAudit } from './audit';
import { SimulationSaveStore } from './save';
import { chooseSimulationDecision, SimulationAgentError } from './agent-api';
import type { ModelEnvironment } from '../mara';
import type { Point } from '../world';

export interface SimulationActivity {
  id: string;
  activeTimeMs: number;
  actorId: SimulationActorId;
  text: string;
  kind: 'event' | 'decision';
  outcome?: string;
}

export interface SimulationRuntimeSnapshot {
  runId: string;
  generation: number;
  paused: boolean;
  checkpoint: SimulationRoomCheckpoint;
  renderPositions: ReturnType<SimulationRoom['renderPositions']>;
  options: Partial<Record<SimulationActorId, ReturnType<SimulationRoom['optionsFor']>>>;
  activity: SimulationActivity[];
  memory: ReturnType<SimulationMemory['snapshot']>;
  audit: AuditSnapshot;
}

export interface SimulationFrameSnapshot {
  activeTimeMs: number;
  paused: boolean;
  renderPositions: ReturnType<SimulationRoom['renderPositions']>;
}

export interface SimulationRuntimeOptions {
  saveStore?: SimulationSaveStore;
  environment?: ModelEnvironment;
  endpoint?: string;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  checkpointIntervalMs?: number;
  frameIntervalMs?: number;
  ambientIntervalMs?: number;
  decisionDeadlineMs?: number;
  writerToken?: string;
  onUpdate?: (snapshot: SimulationRuntimeSnapshot) => void;
}

const NPCS: readonly NpcId[] = ['mara', 'riley', 'jo'];
const clone = <T>(value: T): T => structuredClone(value);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
function token(): string { return `tab-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function runId(): string { return `simulation-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }
function freshGeneration(): number { return Date.now() * 1_000 + Math.floor(Math.random() * 1_000); }

/** Owns one live run and coordinates its world, decisions, recall, audit, and durable checkpoints. */
export class SimulationRuntime {
  private readonly store: SimulationSaveStore;
  private readonly env: ModelEnvironment;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly checkpointIntervalMs: number;
  private readonly frameIntervalMs: number;
  private readonly ambientIntervalMs: number;
  private readonly decisionDeadlineMs: number;
  private readonly onUpdate?: (snapshot: SimulationRuntimeSnapshot) => void;
  private claim!: SimulationSaveClaim;
  private currentRunId = '';
  private room!: SimulationRoom;
  private memory = new SimulationMemory();
  private audit = new SimulationAudit();
  private scheduler!: SimulationScheduler;
  private generation = freshGeneration();
  private paused = false;
  private resetting = false;
  private disposed = false;
  private resetInstallation?: Promise<void>;
  private disposal?: Promise<void>;
  private playerCheckpointPending = false;
  private savingPlayerCheckpoint = false;
  private lastAmbientAt = 0;
  private frameTimer?: ReturnType<typeof setTimeout>;
  private checkpointTimer?: ReturnType<typeof setTimeout>;
  private unsubscribeRoom?: () => void;
  private activityItems: SimulationActivity[] = [];
  private listeners = new Set<(snapshot: SimulationRuntimeSnapshot) => void>();
  private frameListeners = new Set<(frame: SimulationFrameSnapshot) => void>();
  private requestSequence = 1;

  private constructor(options: SimulationRuntimeOptions) {
    this.store = options.saveStore ?? new SimulationSaveStore();
    this.env = options.environment ?? { GEMINI_API_KEY: '' };
    this.endpoint = options.endpoint ?? '/api/simulation';
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 15_000;
    this.frameIntervalMs = options.frameIntervalMs ?? 100;
    this.ambientIntervalMs = options.ambientIntervalMs ?? 35_000;
    this.decisionDeadlineMs = options.decisionDeadlineMs ?? 15_000;
    this.onUpdate = options.onUpdate;
  }

  static async start(options: SimulationRuntimeOptions = {}): Promise<SimulationRuntime> {
    const runtime = new SimulationRuntime(options);
    await runtime.startNewInternal(options.writerToken ?? token());
    runtime.beginLoops();
    return runtime;
  }

  static async resume(options: SimulationRuntimeOptions = {}): Promise<SimulationRuntime> {
    const runtime = new SimulationRuntime(options);
    const saved = await runtime.store.loadCurrent();
    if (!saved) return SimulationRuntime.start(options);
    const result = await runtime.store.claim(saved.runId, options.writerToken ?? token());
    if (result.status !== 'claimed' || !result.envelope) return SimulationRuntime.start(options);
    runtime.claim = result.claim;
    runtime.installRun(result.envelope.runId, result.envelope.checkpoint, result.envelope.memory, result.envelope.audit, result.envelope.nextEventSequence);
    // A save contains only terminal audit records. Requests interrupted by page close
    // were intentionally never persisted and cannot be mistaken for completed work.
    runtime.beginLoops();
    return runtime;
  }

  getRunId(): string { return this.currentRunId; }
  subscribe(listener: (snapshot: SimulationRuntimeSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  /** Lightweight animation stream; it avoids copying the bounded audit each frame. */
  subscribeFrame(listener: (frame: SimulationFrameSnapshot) => void): () => void {
    this.frameListeners.add(listener);
    listener(this.frameSnapshot());
    return () => this.frameListeners.delete(listener);
  }

  snapshot(): SimulationRuntimeSnapshot {
    const checkpoint = this.room.checkpoint();
    const options: SimulationRuntimeSnapshot['options'] = {};
    for (const actorId of ['player', ...NPCS] as SimulationActorId[]) {
      if (checkpoint.actors[actorId]) options[actorId] = this.room.optionsFor(actorId);
    }
    const audit = this.audit.snapshot(checkpoint);
    return freeze({ runId: this.currentRunId, generation: this.generation,
      paused: this.paused, checkpoint, renderPositions: this.room.renderPositions(), options,
      activity: clone(this.activityItems), memory: this.memory.snapshot(), audit });
  }

  inspector(actorId: SimulationActorId) {
    const entries = this.audit.eventsFor(actorId);
    return freeze({ actorId, observation: this.room.observationFor(actorId), options: this.room.optionsFor(actorId),
      recall: this.memory.recall(actorId, this.room.observationFor(actorId)), events: entries });
  }

  action(actorId: SimulationActorId, action: SimulationAction, reply?: string): SimulationDispatchOutcome {
    if (this.disposed || this.resetting) return { status: 'skipped', reason: 'paused' };
    const outcome = this.room.dispatch(actorId, clone(action), reply);
    this.publish();
    return outcome;
  }

  wake(actorId: NpcId, reason = 'external input'): void {
    if (!this.paused && !this.disposed && !this.resetting) this.scheduler.wake(actorId, reason);
  }

  join(position?: Point): SimulationDispatchOutcome {
    if (this.disposed || this.resetting) return { status: 'skipped', reason: 'paused' };
    const outcome = this.room.joinPlayer(position);
    this.publish();
    return outcome;
  }

  async pause(): Promise<void> {
    if (this.disposed || this.paused || this.resetting) return;
    this.paused = true;
    this.generation++;
    this.scheduler.pause('paused');
    if (this.disposed) return;
    const checkpoint = this.room.pause();
    if (this.disposed) return;
    this.stopLoops();
    await this.persist(checkpoint);
    this.publish();
  }

  resumeRun(): void {
    if (this.disposed || this.resetting || !this.paused) return;
    this.paused = false;
    this.generation++;
    this.room.resume();
    this.scheduler.resume();
    this.resetClocks();
    this.beginLoops();
    this.publish();
  }

  exportAudit(): string { return this.audit.exportJSON(this.room.checkpoint()); }
  replay(snapshot: unknown): SimulationRoomCheckpoint { return this.audit.replay(snapshot); }
  importAudit(json: string): SimulationRoomCheckpoint {
    const imported = new SimulationAudit();
    imported.importJSON(json);
    return imported.replay(JSON.parse(json) as unknown);
  }

  importReplay(json: string): SimulationRoomCheckpoint { return this.importAudit(json); }

  async reset(): Promise<void> {
    if (this.disposed || this.resetting) return;
    // Establish a synchronous barrier before any save can yield. Aborting the
    // scheduler synchronously terminalizes its decisions as cancelled.
    this.resetting = true;
    this.paused = true;
    this.generation++;
    this.stopLoops();
    this.scheduler.pause('resetting');
    if (this.disposed) return;
    this.room.pause();
    if (this.disposed) return;
    await this.persist(this.room.checkpoint());
    if (this.disposed) return;
    this.scheduler.dispose();
    this.unsubscribeRoom?.();
    this.room.dispose();
    this.resetInstallation = Promise.resolve().then(() => {
      if (!this.disposed) return this.startNewInternal(token());
    });
    try { await this.resetInstallation; }
    finally { this.resetInstallation = undefined; }
    if (this.disposed) return;
    this.resetting = false;
    this.beginLoops();
    this.publish();
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    let complete!: (result: Promise<void>) => void;
    this.disposal = new Promise(resolve => { complete = resolve; });
    this.disposed = true;
    this.generation++;
    complete(this.finishDisposal());
    return this.disposal;
  }

  private async finishDisposal(): Promise<void> {
    this.stopLoops();
    this.listeners.clear();
    this.frameListeners.clear();
    if (this.resetInstallation) {
      try { await this.resetInstallation; } catch { /* reset reports installation failure */ }
    }
    this.scheduler.dispose();
    const saved = this.persist(this.room.checkpoint());
    this.unsubscribeRoom?.();
    this.room.dispose();
    await saved;
  }

  private async startNewInternal(writerToken: string): Promise<void> {
    const id = runId();
    const claimed = await this.store.claim(id, writerToken);
    if (claimed.status !== 'claimed') throw new Error('Could not claim the new simulation run.');
    this.claim = claimed.claim;
    this.installRun(id);
    await this.persist(this.room.checkpoint());
  }

  private installRun(id: string, checkpoint?: SimulationRoomCheckpoint,
    records: SimulationRuntimeSnapshot['memory'] = [], auditSnapshot?: AuditSnapshot, nextEventSequence = 1): void {
    this.paused = false;
    this.currentRunId = id;
    this.memory = new SimulationMemory();
    if (records.length) this.memory.restore(records);
    this.room = new SimulationRoom({ runId: id, checkpoint, nextEventSequence, now: this.now });
    this.audit = new SimulationAudit();
    if (auditSnapshot) this.audit.restore(auditSnapshot); else this.audit.start(id, this.room.checkpoint());
    const previousGeneration = auditSnapshot?.entries.reduce((max, entry) => entry.kind === 'decision'
      ? Math.max(max, entry.request.generation) : max, 0) ?? 0;
    this.generation = Math.max(this.generation, previousGeneration + 1);
    this.unsubscribeRoom = this.room.subscribe(event => this.onCommittedEvent(event));
    this.activityItems = [];
    this.requestSequence = 1;
    this.scheduler = new SimulationScheduler({ now: this.now, deadlineMs: this.decisionDeadlineMs,
      setTimer: this.setTimer, clearTimer: this.clearTimer,
      startDecision: (actorId, reason, signal) => this.decide(actorId, reason, signal) });
    this.resetClocks();
  }

  private onCommittedEvent(event: SimulationCommittedEvent): void {
    if (this.disposed || event.runId !== this.currentRunId) return;
    this.audit.recordEvent(event);
    for (const actor of event.audience) this.memory.ingest(event, actor);
    const p = event.payload;
    if ((p.type === 'actor-joined' || p.type === 'speech' || p.type === 'room-interaction') && p.actorId === 'player') {
      void this.checkpointPlayerActivity();
    }
    const description = p.type === 'speech' ? `${p.actorId}: ${p.text}`
      : p.type === 'movement-tile-committed' ? `${p.actorId} moved.`
      : p.type === 'actor-joined' ? `${p.actorId} joined the room.`
      : p.type === 'rain' ? 'Rain changed the café.'
      : `${p.actorId} ${p.action.type === 'pickUp' ? `picked up ${p.action.objectId}` : p.action.type === 'putDown' ? `put down ${p.action.objectId}` : p.action.type === 'wait' ? 'waited' : `${p.action.type} the window`}.`;
    this.addActivity({ id: `event:${event.sequence}`, activeTimeMs: event.activeTimeMs,
      actorId: p.type === 'rain' ? 'mara' : p.actorId, text: description, kind: 'event' });
    if (p.type === 'speech' && p.recipient && event.audience.includes(p.recipient) && p.recipient !== p.actorId && NPCS.includes(p.recipient as NpcId)) {
      this.scheduler.wake(p.recipient as NpcId, `reply:${event.sequence}`);
    }
    this.publish();
  }

  private async decide(actorId: NpcId, reason: string, signal: AbortSignal): Promise<void> {
    const generation = this.generation;
    if (this.paused || this.disposed || !this.room.checkpoint().actors[actorId]) return;
    const request = this.makeRequest(actorId);
    const startedAtActiveMs = request.observation.activeTimeMs;
    let terminal = false;
    const finish = (entry: Omit<SimulationDecisionAuditEntry, 'kind' | 'auditOrder'>) => {
      if (terminal) return;
      terminal = true;
      this.audit.recordDecision(entry);
      this.addActivity({ id: `decision:${request.requestId}`, activeTimeMs: entry.finishedAtActiveMs,
        actorId, kind: 'decision', text: entry.reason ?? entry.rationale ?? 'Decision finished.', outcome: entry.outcome });
      this.publish();
      if (!this.disposed) void this.persist(this.room.checkpoint());
    };
    const onAbort = () => {
      const abortReason: 'cancelled' | 'failed' = this.generation !== generation || this.paused || this.disposed ? 'cancelled' : 'failed';
      finish({ request, outcome: abortReason, reason: abortReason === 'failed' ? 'Decision deadline exceeded.' : 'Decision cancelled.',
        startedAtActiveMs, finishedAtActiveMs: this.room.checkpoint().activeTimeMs });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const reply = await this.requestOrAbort(request, signal);
      if (terminal || signal.aborted || this.generation !== generation || this.paused || this.disposed) return;
      if (!this.validReply(request, reply)) throw new Error('Decision identity or option did not match the request.');
      const option = request.options.find(item => item.actionId === reply.actionId)!;
      const memoryProposals = reply.memoryProposals;
      if (memoryProposals?.length) this.memory.applyProposals(actorId, memoryProposals, this.room.witnessedEventsFor(actorId));
      const dispatchOutcome = this.room.dispatch(actorId, option.action, reply.reply);
      const success = dispatchOutcome.status === 'committed' || dispatchOutcome.status === 'route-accepted';
      finish({ request, modelResponseId: reply.modelResponseId, actionId: reply.actionId,
        selectedAction: option.action, reply: reply.reply, rationale: reply.rationale,
        memoryProposals, outcome: success ? 'committed' : 'stale', dispatchOutcome,
        ...(!success ? { reason: dispatchOutcome.status === 'rejected' ? dispatchOutcome.reason : dispatchOutcome.status === 'skipped' ? dispatchOutcome.reason : undefined } : {}),
        startedAtActiveMs, finishedAtActiveMs: this.room.checkpoint().activeTimeMs });
    } catch (error) {
      if (terminal || signal.aborted || this.generation !== generation) return;
      const rate = error instanceof SimulationAgentError && error.reason === 'rate-limited';
      finish({ request, outcome: 'failed', reason: error instanceof Error ? error.message : 'Decision failed.',
        startedAtActiveMs, finishedAtActiveMs: this.room.checkpoint().activeTimeMs });
      if (rate) throw new SimulationRateLimitError((error as SimulationAgentError).retryAfterMs);
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  }

  private makeRequest(actorId: NpcId): SimulationDecisionRequest {
    const observation = this.room.observationFor(actorId);
    return { runId: this.currentRunId,
      requestId: `${this.generation}-${this.requestSequence++}`, generation: this.generation,
      actorId, observedRevision: observation.revision, observation,
      witnessedEvents: this.room.witnessedEventsFor(actorId), options: this.room.optionsFor(actorId),
      recall: this.memory.recall(actorId, observation) };
  }

  private async requestDecision(request: SimulationDecisionRequest, signal: AbortSignal): Promise<SimulationDecisionReply> {
    if (this.env.GEMINI_API_KEY) return chooseSimulationDecision(request, this.env, signal);
    const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request), signal });
    if (response.status === 429) {
      const retry = Number(response.headers.get('retry-after'));
      throw new SimulationAgentError('rate-limited', Number.isFinite(retry) && retry > 0 ? retry * 1000 : 0);
    }
    if (!response.ok) throw new SimulationAgentError(response.status === 503 ? 'missing-key' : 'provider-error');
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object') throw new SimulationAgentError('invalid-response');
    return body as SimulationDecisionReply;
  }

  private requestOrAbort(request: SimulationDecisionRequest, signal: AbortSignal): Promise<SimulationDecisionReply> {
    if (signal.aborted) return Promise.reject(new Error('Decision cancelled.'));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('Decision cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.requestDecision(request, signal).then(value => {
        signal.removeEventListener('abort', onAbort); resolve(value);
      }, error => {
        signal.removeEventListener('abort', onAbort); reject(error);
      });
    });
  }

  private validReply(request: SimulationDecisionRequest, reply: SimulationDecisionReply): boolean {
    if (!reply || reply.runId !== request.runId || reply.requestId !== request.requestId
      || reply.generation !== request.generation || reply.actorId !== request.actorId
      || typeof reply.rationale !== 'string' || reply.rationale.trim().length === 0 || reply.rationale.length > 1_000) return false;
    const option = request.options.find(item => item.actionId === reply.actionId);
    if (!option || (option.action.type === 'speak'
      ? typeof reply.reply !== 'string' || reply.reply.trim().length === 0 || reply.reply.length > 160
      : reply.reply !== undefined)) return false;
    const proposals = reply.memoryProposals;
    if (proposals !== undefined && (!Array.isArray(proposals) || proposals.length > 3 || proposals.some(proposal => {
      if (!proposal || typeof proposal !== 'object') return true;
      const value = proposal as Record<string, unknown>;
      return value.kind === 'open-commitment'
        ? Object.keys(value).some(key => !['kind', 'sourceEventId', 'exactLine'].includes(key)) || typeof value.sourceEventId !== 'string' || typeof value.exactLine !== 'string' || value.exactLine.length > 160
        : value.kind !== 'close-commitment' || Object.keys(value).some(key => !['kind', 'commitmentId', 'sourceEventId', 'exactLine', 'outcome'].includes(key)) || typeof value.commitmentId !== 'string' || typeof value.sourceEventId !== 'string' || typeof value.exactLine !== 'string' || value.exactLine.length > 160 || !['completed', 'withdrawn'].includes(String(value.outcome));
    }))) return false;
    return true;
  }

  private async checkpointPlayerActivity(): Promise<void> {
    this.playerCheckpointPending = true;
    if (this.savingPlayerCheckpoint) return;
    this.savingPlayerCheckpoint = true;
    try {
      while (this.playerCheckpointPending && !this.paused && !this.disposed && !this.resetting) {
        this.playerCheckpointPending = false;
        await this.persist(this.room.checkpoint());
      }
    } finally {
      this.playerCheckpointPending = false;
      this.savingPlayerCheckpoint = false;
    }
  }

  private async persist(checkpoint: SimulationRoomCheckpoint): Promise<void> {
    const generation = this.generation;
    const claim = this.claim;
    try {
      const audit = this.audit.snapshot(checkpoint);
      const envelope: SimulationSaveEnvelope = { schemaVersion: 3, runId: audit.runId,
        checkpoint: clone(checkpoint), memory: this.memory.snapshot(), audit,
        nextEventSequence: audit.finalCheckpointProvenance.throughSequence + 1,
        writerToken: claim.writerToken, writerGeneration: claim.generation };
      const result = await this.store.save(claim, envelope);
      if (this.disposed || generation !== this.generation || claim !== this.claim) return;
      if (result.status === 'ownership-lost') {
        this.paused = true;
        this.scheduler.pause('save ownership lost');
        this.room.pause();
        this.stopLoops();
        this.addActivity({ id: `save-lost:${generation}`, activeTimeMs: checkpoint.activeTimeMs, actorId: 'mara', text: 'This tab lost save ownership.', kind: 'event' });
        this.publish();
      }
    } catch (error) {
      if (generation === this.generation && claim === this.claim) console.error('Simulation checkpoint failed.', error);
    }
  }

  private beginLoops(): void {
    if (this.paused || this.disposed) return;
    this.lastAmbientAt = this.room.checkpoint().activeTimeMs;
    this.frameLoop();
    this.scheduleCheckpoint();
  }
  private frameLoop(): void {
    if (this.paused || this.disposed) return;
    const now = this.now();
    this.room.advanceTo(now);
    if (this.paused || this.disposed) return;
    const activeTimeMs = this.room.checkpoint().activeTimeMs;
    if (activeTimeMs - this.lastAmbientAt >= this.ambientIntervalMs) {
      const actor = NPCS[Math.floor(Math.random() * NPCS.length)];
      if (this.room.checkpoint().actors[actor]) this.scheduler.wake(actor, 'ambient initiative');
      this.lastAmbientAt = activeTimeMs;
    }
    this.publishFrame();
    if (!this.paused && !this.disposed) this.frameTimer = this.setTimer(() => this.frameLoop(), this.frameIntervalMs);
  }
  private scheduleCheckpoint(): void {
    if (this.paused || this.disposed) return;
    this.checkpointTimer = this.setTimer(() => {
      if (this.paused || this.disposed) return;
      void this.persist(this.room.checkpoint());
      this.scheduleCheckpoint();
    }, this.checkpointIntervalMs);
  }
  private resetClocks(): void { this.lastAmbientAt = this.room.checkpoint().activeTimeMs; }
  private stopLoops(): void {
    for (const timer of [this.frameTimer, this.checkpointTimer]) if (timer) this.clearTimer(timer);
    this.frameTimer = this.checkpointTimer = undefined;
  }
  private addActivity(item: SimulationActivity): void {
    this.activityItems.push(item);
    if (this.activityItems.length > 100) this.activityItems.splice(0, this.activityItems.length - 100);
  }
  private publish(): void {
    if (this.disposed) return;
    const value = this.snapshot();
    try { this.onUpdate?.(value); } catch (error) { console.error('Simulation update listener failed.', error); }
    for (const listener of this.listeners) { try { listener(value); } catch { console.error('Simulation update listener failed.'); } }
  }

  private frameSnapshot(): SimulationFrameSnapshot {
    return freeze({ activeTimeMs: this.room.checkpoint().activeTimeMs, paused: this.paused,
      renderPositions: this.room.renderPositions() });
  }
  private publishFrame(): void {
    if (this.disposed) return;
    const value = this.frameSnapshot();
    for (const listener of this.frameListeners) { try { listener(value); } catch { console.error('Simulation frame listener failed.'); } }
  }
}
