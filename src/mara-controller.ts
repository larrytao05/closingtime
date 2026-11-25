import {
  LiveMaraRequestError, requestLiveMara,
  type LiveMaraAction, type LiveMaraDecision, type LiveMaraFailure, type LiveMaraMaterialEvent,
  type LiveMaraObservation, type LiveMaraRequest, type LiveMaraResponse, type LiveMaraSnapshot,
} from './live-mara-protocol';
import { actionsFor } from './world';

export type { LiveMaraSnapshot } from './live-mara-protocol';

interface RequestAudit {
  requestId: string;
  observedRevision: number;
  observedActiveMs: number;
}

export type LiveMaraAuditEvent = RequestAudit & (
  | { kind: 'decisionRequested'; clientObservation: LiveMaraRequest }
  | { kind: 'decisionReceived'; observation: LiveMaraObservation; decision: LiveMaraDecision; latencyMs: number }
  | { kind: 'decisionFailed'; reason: LiveMaraFailure; clientObservation: LiveMaraRequest; latencyMs: number }
  | { kind: 'decisionCanceled'; reason: 'hidden' | 'session-restarted' | 'disposed'; clientObservation: LiveMaraRequest; latencyMs: number }
  | { kind: 'decisionSkipped'; commandId: string; action: LiveMaraAction; reason: string; effectiveSnapshot: LiveMaraSnapshot }
  | { kind: 'decisionRetryScheduled'; reason: LiveMaraFailure; delayMs: number }
);

interface ControllerTiming {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}

interface ControllerLimits {
  minimumSpacingMs: number;
  deadlineMs: number;
  retryBackoffMs: readonly number[];
  idleWaitMs: number;
  maxIdleWaits: number;
  maxAttempts: number;
}

const defaults: ControllerLimits = {
  minimumSpacingMs: 1000,
  deadlineMs: 15000,
  retryBackoffMs: [2000, 4000],
  idleWaitMs: 3000,
  maxIdleWaits: 3,
  maxAttempts: 60,
};

const timingDefaults: ControllerTiming = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => {
    const timeout = setTimeout(callback, delayMs);
    return () => clearTimeout(timeout);
  },
};

interface ControllerDependencies {
  readSnapshot: () => LiveMaraSnapshot;
  request?: (request: LiveMaraRequest, signal: AbortSignal) => Promise<LiveMaraResponse>;
  dispatch: (action: LiveMaraAction, requestId: string, commandId: string) =>
    { ok: true; status?: 'started' | 'queued' | 'noop' } | { ok: false; reason: string };
  audit: (event: LiveMaraAuditEvent) => void;
  status?: (status: string) => void;
  limits?: Partial<ControllerLimits>;
  timing?: ControllerTiming;
}

interface ActiveRequest {
  observation: LiveMaraRequest;
  context: RequestAudit;
  epoch: number;
  startedAt: number;
  speechSerial: number;
  materialSerial: number;
  abort: AbortController;
  canceled: boolean;
  terminal: boolean;
}

export class MaraController {
  private readonly limits: ControllerLimits;
  private readonly timing: ControllerTiming;
  private readonly request: NonNullable<ControllerDependencies['request']>;
  private active: ActiveRequest | undefined;
  private sessionId: string | undefined;
  private epoch = 0;
  private disposed = false;
  private wasPaused = false;
  private attempts = 0;
  private retries = 0;
  private consecutiveWaits = 0;
  private reconsidered = false;
  private needsDecision = false;
  private stopped = false;
  private wakeAt = Infinity;
  private rateLimitUntil = 0;
  private lastStartedAt = -Infinity;
  private speechSerial = 0;
  private materialSerial = 0;
  private events: LiveMaraMaterialEvent[] = [];
  private statusText = '';

  constructor(private readonly dependencies: ControllerDependencies) {
    this.limits = { ...defaults, ...dependencies.limits };
    this.timing = dependencies.timing ?? timingDefaults;
    this.request = dependencies.request ?? requestLiveMara;
  }

  update(): void {
    if (this.disposed) return;
    const snapshot = this.dependencies.readSnapshot();
    if (snapshot.sessionId !== this.sessionId) this.beginScene(snapshot.sessionId);
    if (snapshot.paused) {
      if (!this.wasPaused) this.cancelActive('hidden');
      this.wasPaused = true;
      return;
    }
    if (this.wasPaused) {
      this.wasPaused = false;
      this.needsDecision = true;
      this.wakeAt = Infinity;
    }
    if (snapshot.activeMs >= this.wakeAt) {
      this.wakeAt = Infinity;
      this.needsDecision = true;
    }
    if (this.active || this.stopped) return;
    if (this.attempts >= this.limits.maxAttempts) {
      this.stopped = true;
      this.setStatus('Mara reached the request limit for this scene.');
      return;
    }
    const now = this.timing.now();
    if (!this.needsDecision || now < this.rateLimitUntil || now - this.lastStartedAt < this.limits.minimumSpacingMs) return;
    this.start(snapshot);
  }

  materialChange(event: LiveMaraMaterialEvent): void {
    if (this.disposed) return;
    const { sessionId } = this.dependencies.readSnapshot();
    if (sessionId !== this.sessionId) this.beginScene(sessionId);
    this.events = [...this.events.slice(-7), structuredClone(event)];
    this.materialSerial++;
    if (event.type === 'player-speech') this.speechSerial++;
    this.needsDecision = true;
    this.consecutiveWaits = 0;
    this.reconsidered = false;
  }

  dispose(): void {
    this.cancelActive('disposed');
    this.disposed = true;
    this.epoch++;
    this.active = undefined;
  }

  private beginScene(sessionId: string): void {
    this.cancelActive('session-restarted');
    this.sessionId = sessionId;
    this.epoch++;
    this.active = undefined;
    this.wasPaused = false;
    this.attempts = 0;
    this.retries = 0;
    this.consecutiveWaits = 0;
    this.reconsidered = false;
    this.needsDecision = true;
    this.stopped = false;
    this.wakeAt = Infinity;
    this.rateLimitUntil = 0;
    this.lastStartedAt = -Infinity;
    this.speechSerial = 0;
    this.materialSerial = 0;
    this.events = [];
    this.setStatus('Mara is ready.');
  }

  private setStatus(status: string): void {
    if (status === this.statusText) return;
    this.statusText = status;
    this.dependencies.status?.(status);
  }

  private isCurrent(request: ActiveRequest): boolean {
    return !this.disposed && this.active === request && this.epoch === request.epoch
      && this.dependencies.readSnapshot().sessionId === request.observation.sessionId;
  }

  private cancelActive(reason: Extract<LiveMaraAuditEvent, { kind: 'decisionCanceled' }>['reason']): void {
    const current = this.active;
    if (!current || current.canceled) return;
    current.canceled = true;
    current.abort.abort();
    if (current.terminal) return;
    current.terminal = true;
    this.dependencies.audit({
      ...current.context, kind: 'decisionCanceled', reason, clientObservation: current.observation,
      latencyMs: this.timing.now() - current.startedAt,
    });
  }

  private start(snapshot: LiveMaraSnapshot): void {
    const requestId = `${snapshot.sessionId}:mara:${++this.attempts}`;
    const observation: LiveMaraRequest = structuredClone({
      mode: 'live',
      requestId,
      sessionId: snapshot.sessionId,
      activeMs: snapshot.activeMs,
      revision: snapshot.revision,
      world: { ...snapshot.world, dialogue: snapshot.world.dialogue.slice(-12) },
      intent: snapshot.intent,
      moving: snapshot.moving,
      reserved: snapshot.reserved,
      recentEvents: this.events,
    });
    const active: ActiveRequest = {
      observation,
      context: { requestId, observedRevision: snapshot.revision, observedActiveMs: snapshot.activeMs },
      epoch: this.epoch,
      startedAt: this.timing.now(),
      speechSerial: this.speechSerial,
      materialSerial: this.materialSerial,
      abort: new AbortController(),
      canceled: false,
      terminal: false,
    };
    this.active = active;
    this.lastStartedAt = active.startedAt;
    this.needsDecision = false;
    this.wakeAt = Infinity;
    this.dependencies.audit({ ...active.context, kind: 'decisionRequested', clientObservation: observation });
    if (this.canContinue(active)) this.setStatus('Mara is thinking…');
    if (this.canContinue(active)) {
      void this.run(active);
    } else if (this.isCurrent(active)) {
      this.cancelActive('hidden');
      this.active = undefined;
    }
  }

  private canContinue(active: ActiveRequest): boolean {
    return this.isCurrent(active) && !active.canceled && !this.dependencies.readSnapshot().paused;
  }

  private async run(active: ActiveRequest): Promise<void> {
    let clearDeadline = () => {};
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        clearDeadline = this.timing.schedule(() => {
          reject(new LiveMaraRequestError('timeout'));
          active.abort.abort();
        }, this.limits.deadlineMs);
      });
      const result = await Promise.race([deadline, this.request(active.observation, active.abort.signal)]);
      if (!this.canContinue(active)) return;
      if (result.sessionId !== active.observation.sessionId || result.requestId !== active.context.requestId) {
        throw new LiveMaraRequestError('invalid-response');
      }
      this.apply(active, result);
    } catch (error) {
      if (this.canContinue(active) && !active.terminal) {
        this.fail(active, error instanceof LiveMaraRequestError ? error : new LiveMaraRequestError('provider-error'));
      }
    } finally {
      clearDeadline();
      if (this.isCurrent(active)) {
        this.active = undefined;
        this.update();
      }
    }
  }

  private apply(active: ActiveRequest, result: LiveMaraResponse): void {
    const { decision, observation } = result;
    const { action } = decision;
    const commandId = `${active.context.requestId}:action`;
    active.terminal = true;
    this.dependencies.audit({
      ...active.context, kind: 'decisionReceived', decision, observation,
      latencyMs: this.timing.now() - active.startedAt,
    });
    if (!this.canContinue(active)) return;
    const snapshot = this.dependencies.readSnapshot();
    const skipReason = this.skipReason(active, snapshot, action);
    const outcome = skipReason
      ? { ok: false as const, reason: skipReason }
      : this.dependencies.dispatch(action, active.context.requestId, commandId);
    if (!this.canContinue(active)) return;
    if (!outcome.ok) {
      if (skipReason) {
        const effective = this.dependencies.readSnapshot();
        this.dependencies.audit({
          ...active.context, kind: 'decisionSkipped', commandId, action, reason: skipReason,
          effectiveSnapshot: { ...effective, world: { ...effective.world, dialogue: effective.world.dialogue.slice(-12) } },
        });
      }
      if (!this.canContinue(active)) return;
      this.setStatus('Mara is reconsidering.');
      if (!this.reconsidered) {
        this.reconsidered = true;
        this.needsDecision = true;
      }
      return;
    }

    this.retries = 0;
    if (outcome.status === 'noop') {
      this.setStatus('Mara is ready.');
      if (!this.reconsidered) {
        this.reconsidered = true;
        this.needsDecision = true;
      }
      return;
    }

    this.reconsidered = false;
    if (action.type === 'wait') {
      if (active.materialSerial === this.materialSerial) this.consecutiveWaits++;
      if (this.consecutiveWaits < this.limits.maxIdleWaits) {
        this.wakeAt = snapshot.activeMs + this.limits.idleWaitMs;
      }
      this.setStatus('Mara is waiting.');
    } else {
      this.consecutiveWaits = 0;
      this.setStatus(action.type === 'walkTo' ? 'Mara is walking.' : 'Mara is ready.');
    }
  }

  private skipReason(active: ActiveRequest, snapshot: LiveMaraSnapshot, action: LiveMaraAction): string | undefined {
    if (action.type === 'speak' && active.speechSerial !== this.speechSerial) return 'Newer player dialogue arrived.';
    if (action.type === 'walkTo') return; // The movement dispatcher validates occupancy and route intent atomically.
    if (snapshot.moving && action.type !== 'speak' && action.type !== 'wait') return 'Mara is between tiles.';
    const result = actionsFor(snapshot.world, 'mara').execute(action);
    return result.ok ? undefined : result.reason;
  }

  private fail(active: ActiveRequest, error: LiveMaraRequestError): void {
    const { reason, retryAfterMs } = error;
    active.terminal = true;
    this.dependencies.audit({
      ...active.context, kind: 'decisionFailed', reason, clientObservation: active.observation,
      latencyMs: this.timing.now() - active.startedAt,
    });
    if (!this.canContinue(active)) return;
    if (reason === 'unavailable' || reason === 'invalid-observation') {
      this.needsDecision = false;
      this.stopped = true;
      this.setStatus(reason === 'unavailable' ? 'Mara’s model is unavailable.' : 'Mara couldn’t read the scene.');
      return;
    }

    const delay = this.limits.retryBackoffMs[this.retries];
    if (reason === 'rate-limited') this.rateLimitUntil = this.timing.now() + retryAfterMs;
    if (delay !== undefined && this.attempts < this.limits.maxAttempts) {
      this.retries++;
      this.rateLimitUntil = Math.max(this.rateLimitUntil, this.timing.now() + delay);
      this.needsDecision = true;
      this.setStatus('Mara will try again shortly.');
      this.dependencies.audit({ ...active.context, kind: 'decisionRetryScheduled', reason, delayMs: Math.max(delay, retryAfterMs) });
      return;
    }

    this.retries = 0;
    this.needsDecision = this.materialSerial > active.materialSerial;
    this.setStatus(this.attempts >= this.limits.maxAttempts
      ? 'Mara reached the request limit for this scene.'
      : 'Mara couldn’t decide what to do.');
  }
}
