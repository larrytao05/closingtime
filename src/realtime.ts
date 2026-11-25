import { actionsFor, createWorld, papersExposed, wetPapers, type Action, type ActorId, type World } from './world';

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly activeMs: number;
  readonly revision: number;
  readonly paused: boolean;
  readonly world: World;
}

export interface DispatchMetadata {
  commandId?: string;
  requestId?: string;
  routeCommandId?: string;
  source?: 'player-input' | 'mara-decision' | 'movement-step';
}

export interface EventEnvelope {
  readonly sessionId: string;
  readonly activeMs: number;
  readonly wallMs: number;
  readonly revision: number;
  readonly sequence: number;
}

type ActionOutcome =
  | { status: 'completed'; reason?: never }
  | { status: 'skipped'; reason: string };

type ActionPayload = {
  kind: 'action';
  actor: ActorId;
  action: Action;
  before: SessionSnapshot;
  after: SessionSnapshot;
  metadata: DispatchMetadata & { commandId: string };
} & ActionOutcome;

type RainPayload = {
  kind: 'rain';
  amount: number;
  before: SessionSnapshot;
  after: SessionSnapshot;
};

type LifecyclePayload = {
  kind: 'session';
  phase: 'started' | 'paused' | 'resumed' | 'ended';
  reason?: 'restart' | 'dispose';
  snapshot: SessionSnapshot;
};

export type CoreEvent = EventEnvelope & (ActionPayload | RainPayload | LifecyclePayload);
export type ActionEvent = EventEnvelope & ActionPayload;

export type RuntimePayload = {
  kind: 'routeSubmitted' | 'routeStarted' | 'routeFinished' | 'decisionRequested' | 'decisionReceived'
    | 'decisionFailed' | 'decisionCanceled' | 'decisionSkipped' | 'decisionRetryScheduled';
  actor?: ActorId;
  outcome?: string;
  requestId?: string;
};
export type SessionEvent = CoreEvent | (EventEnvelope & RuntimePayload);

export type DispatchResult =
  | { ok: true; world: World; event: ActionEvent }
  | { ok: false; reason: string; event?: ActionEvent };

type Listener = (event: SessionEvent) => void;
type MotionGuard = (actor: ActorId, action: Action, metadata: DispatchMetadata) => string | undefined;

interface SessionOptions {
  now?: () => number;
  wetnessIntervalMs?: number;
  makeSessionId?: () => string;
  onEvent?: Listener;
}

interface ScheduledStep {
  dueAt: number;
  callback: () => void;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class RealtimeSession {
  private world = freeze(createWorld());
  private sessionId: string;
  private activeMs = 0;
  private revision = 0;
  private sequence = 0;
  private id = 0;
  private exposure = 0;
  private paused = false;
  private disposed = false;
  private ending = false;
  private epoch = 0;
  private advancing = false;
  private publishing = false;
  private eventBatchDepth = 0;
  private flushingLifecycle = false;
  private wallMs: number;
  private readonly now: () => number;
  private readonly makeSessionId: () => string;
  private readonly wetnessIntervalMs: number;
  private readonly listeners = new Set<Listener>();
  private readonly events: SessionEvent[] = [];
  private readonly lifecycleQueue: (() => void)[] = [];
  private readonly scheduled: ScheduledStep[] = [];
  private motionGuard?: MotionGuard;

  constructor({ now = () => performance.now(), wetnessIntervalMs = 4000,
    makeSessionId = () => crypto.randomUUID(), onEvent }: SessionOptions = {}) {
    if (!Number.isFinite(wetnessIntervalMs) || wetnessIntervalMs <= 0) {
      throw new RangeError('Wetness interval must be positive and finite.');
    }
    this.now = now;
    this.wetnessIntervalMs = wetnessIntervalMs;
    this.makeSessionId = makeSessionId;
    this.sessionId = makeSessionId();
    this.wallMs = now();
    if (onEvent) this.listeners.add(onEvent);
    this.lifecycle('started');
  }

  snapshot(): SessionSnapshot {
    return Object.freeze({
      sessionId: this.sessionId,
      activeMs: this.activeMs,
      revision: this.revision,
      paused: this.paused,
      world: this.world,
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  batchEvents<T>(run: () => T): T {
    this.eventBatchDepth++;
    try {
      return run();
    } finally {
      this.eventBatchDepth--;
      this.publishEvents();
    }
  }

  nextId(prefix = 'command'): string {
    return `${this.sessionId}:${prefix}:${++this.id}`;
  }

  record<T extends RuntimePayload>(payload: T): EventEnvelope & T {
    return this.emit(payload);
  }

  setMotionGuard(guard: MotionGuard): () => void {
    this.motionGuard = guard;
    return () => { if (this.motionGuard === guard) this.motionGuard = undefined; };
  }

  scheduleAt(activeMs: number, callback: () => void): () => void {
    if (!Number.isFinite(activeMs) || activeMs <= this.activeMs) {
      throw new RangeError('A motion step must be scheduled for a future active time.');
    }
    if (this.disposed) return () => {};
    const step = { dueAt: activeMs, callback };
    this.scheduled.push(step);
    this.scheduled.sort((a, b) => a.dueAt - b.dueAt);
    return () => {
      const index = this.scheduled.indexOf(step);
      if (index !== -1) this.scheduled.splice(index, 1);
    };
  }

  advanceTo(wallNow = this.now()): void {
    if (this.disposed || this.advancing || !Number.isFinite(wallNow) || wallNow < this.wallMs) return;
    if (this.paused) {
      this.wallMs = wallNow;
      return;
    }

    const startWall = this.wallMs;
    const startActive = this.activeMs;
    const targetActive = startActive + (wallNow - startWall);
    const epoch = this.epoch;
    this.advancing = true;
    try {
      while (epoch === this.epoch) {
        const exposed = papersExposed(this.world);
        const nextWetness = exposed ? this.activeMs + (this.wetnessIntervalMs - this.exposure) : Infinity;
        const nextStep = this.scheduled[0]?.dueAt ?? Infinity;
        const boundary = Math.min(targetActive, nextWetness, nextStep);
        if (exposed) this.exposure += boundary - this.activeMs;
        this.activeMs = boundary;
        this.wallMs = startWall + (boundary - startActive);

        if (boundary === nextWetness) {
          this.exposure = 0;
          const before = this.snapshot();
          this.commit(wetPapers(this.world));
          this.emit({ kind: 'rain', amount: 1, before, after: this.snapshot() });
          if (this.epoch !== epoch) break;
        }
        // Rain due at a boundary settles before motion or player commands at that time.
        if (this.scheduled[0]?.dueAt === boundary) this.scheduled.shift()?.callback();
        if (boundary === targetActive && this.scheduled[0]?.dueAt !== boundary) break;
      }
    } finally {
      this.advancing = false;
    }
  }

  dispatch(actor: ActorId, action: Action, wallNow = this.now(), input?: DispatchMetadata): DispatchResult {
    const sessionId = this.sessionId;
    this.advanceTo(wallNow);
    if (this.disposed || sessionId !== this.sessionId) return { ok: false, reason: 'This scene has ended.' };
    const before = this.snapshot();
    const metadata = Object.freeze({ ...input, commandId: input?.commandId ?? this.nextId() });
    const command = freeze(structuredClone(action));
    const event = { kind: 'action' as const, actor, action: command, before, metadata };
    const reason = this.paused ? 'This scene is paused.' : this.motionGuard?.(actor, command, metadata);
    const result = reason ? { ok: false as const, reason } : actionsFor(this.world, actor).execute(command);
    if (!result.ok) {
      return {
        ok: false,
        reason: result.reason,
        event: this.emit({ ...event, status: 'skipped' as const, reason: result.reason, after: before }),
      };
    }

    this.commit(result.world);
    const after = this.snapshot();
    return {
      ok: true,
      world: after.world,
      event: this.emit({ ...event, status: 'completed' as const, after }),
    };
  }

  setPaused(paused: boolean, wallNow = this.now()): void {
    if (this.disposed) return;
    if (this.publishing || this.eventBatchDepth > 0) {
      this.lifecycleQueue.push(() => this.setPaused(paused, wallNow));
      return;
    }
    if (this.paused === paused) return;
    const sessionId = this.sessionId;
    this.advanceTo(wallNow);
    if (this.disposed || this.paused === paused || sessionId !== this.sessionId) return;
    this.rebaseWall(wallNow);
    this.paused = paused;
    this.epoch++;
    this.lifecycle(paused ? 'paused' : 'resumed');
  }

  restart(wallNow = this.now()): void {
    if (this.disposed || this.ending) return;
    if (this.publishing || this.eventBatchDepth > 0) {
      this.lifecycleQueue.push(() => this.restart(wallNow));
      return;
    }
    this.ending = true;
    try {
      this.advanceTo(wallNow);
      this.rebaseWall(wallNow);
      this.epoch++;
      this.scheduled.length = 0;
      this.lifecycle('ended', 'restart');
      this.scheduled.length = 0;
      this.world = freeze(createWorld());
      this.sessionId = this.makeSessionId();
      this.activeMs = this.revision = this.sequence = this.id = this.exposure = 0;
    } finally {
      this.ending = false;
    }
    this.lifecycle('started');
  }

  dispose(wallNow = this.now()): void {
    if (this.disposed || this.ending) return;
    if (this.publishing || this.eventBatchDepth > 0) {
      this.lifecycleQueue.push(() => this.dispose(wallNow));
      return;
    }
    this.ending = true;
    try {
      this.advanceTo(wallNow);
      this.rebaseWall(wallNow);
      this.disposed = true;
      this.epoch++;
      this.scheduled.length = 0;
      this.lifecycle('ended', 'dispose');
    } finally {
      this.ending = false;
      this.listeners.clear();
    }
  }

  private rebaseWall(wallNow: number): void {
    if (Number.isFinite(wallNow) && wallNow > this.wallMs) this.wallMs = wallNow;
  }

  private commit(world: World): void {
    if (world === this.world) return;
    this.world = freeze(world);
    this.revision++;
  }

  private lifecycle(phase: LifecyclePayload['phase'], reason?: LifecyclePayload['reason']): void {
    this.emit({ kind: 'session', phase, reason, snapshot: this.snapshot() });
  }

  private emit<T extends ActionPayload | RainPayload | LifecyclePayload | RuntimePayload>(payload: T): EventEnvelope & T {
    const event: EventEnvelope & T = {
      ...payload,
      sessionId: this.sessionId,
      activeMs: this.activeMs,
      wallMs: this.wallMs,
      revision: this.revision,
      sequence: ++this.sequence,
    };
    Object.freeze(event);
    this.events.push(event);
    this.publishEvents();
    return event;
  }

  private publishEvents(): void {
    if (this.publishing || this.eventBatchDepth > 0) return;
    this.publishing = true;
    try {
      for (let current = this.events.shift(); current; current = this.events.shift()) {
        for (const listener of this.listeners) {
          try { listener(current); } catch { console.error('Closing Time event listener failed.'); }
        }
      }
    } finally {
      this.publishing = false;
    }
    this.flushLifecycleQueue();
  }

  private flushLifecycleQueue(): void {
    if (this.flushingLifecycle) return;
    this.flushingLifecycle = true;
    try {
      // Lifecycle listeners may emit cancellation events. Drain those under the old session
      // before restart replaces the session ID or disposal removes listeners.
      for (let operation = this.lifecycleQueue.shift(); operation; operation = this.lifecycleQueue.shift()) {
        operation();
      }
    } finally {
      this.flushingLifecycle = false;
    }
  }
}
