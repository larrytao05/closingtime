import { MaraController } from './mara-controller';
import { MovementController } from './movement';
import { RealtimeSession, type SessionEvent } from './realtime';
import { RealtimeTrace } from './realtime-trace';
import type { LiveMaraAction, requestLiveMara } from './live-mara-protocol';
import type { Action, ActorId, Point } from './world';

interface LiveGameOptions {
  onChange: () => void;
  onAction: (action: Action, actor: ActorId) => void;
  now?: () => number;
  request?: typeof requestLiveMara;
}

const isRoomInteraction = (action: Action) =>
  action.type === 'close' || action.type === 'open' || action.type === 'pickUp' || action.type === 'putDown';

export class LiveGame {
  readonly trace = new RealtimeTrace({ onStorageStatusChange: () => { this.changed = true; } });
  readonly session: RealtimeSession;
  private readonly movement: MovementController;
  private readonly unsubscribe: () => void;
  private mara: MaraController;
  private changed = true;
  private disposed = false;

  status = 'Mara is ready.';
  rationale = '';
  selected?: LiveMaraAction;
  private selectedRequest?: string;
  outcome = '';

  constructor(private readonly options: LiveGameOptions) {
    this.session = new RealtimeSession({
      now: options.now,
      onEvent: event => this.trace.append(event),
    });
    this.movement = new MovementController(this.session);
    this.mara = this.createMara();
    this.unsubscribe = this.session.subscribe(event => this.observe(event));
  }

  get snapshot() { return this.session.snapshot(); }
  get playerMoving() { return this.movement.isMoving('player'); }

  pose(actor: ActorId) { return this.movement.pose(actor); }
  reachable() { return this.movement.reachable('player'); }
  interruptPlayerRoute() { this.movement.stopAfterStep('player'); }
  canWalk(to: Point) { return this.movement.canStepTo('player', to); }

  frame() {
    if (this.disposed) return;
    this.session.advanceTo();
    this.mara.update();
    this.refresh();
  }

  act(action: Action) {
    const result = this.session.dispatch('player', action, undefined, { source: 'player-input' });
    this.refresh();
    return result;
  }

  walk(to: Point) {
    const scene = this.snapshot.sessionId;
    this.session.advanceTo();
    if (this.disposed || this.snapshot.sessionId !== scene) {
      return { ok: false as const, reason: 'This scene has ended.' };
    }
    const result = this.movement.walkTo('player', to, { source: 'player-input' });
    this.refresh();
    return result;
  }

  setPaused(paused: boolean) {
    if (this.disposed) return;
    this.session.setPaused(paused);
    this.mara.update();
    this.refresh();
  }

  restart() {
    if (this.disposed) return;
    const scene = this.snapshot.sessionId;
    this.mara.dispose();
    this.session.restart();
    this.trace.flush();
    if (this.snapshot.sessionId !== scene) this.frame();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mara.dispose();
    this.session.dispose();
    this.movement.dispose();
    this.unsubscribe();
    this.trace.flush();
  }

  private createMara() {
    return new MaraController({
      readSnapshot: () => {
        const { active, queued } = this.movement.route('mara');
        return {
          ...this.snapshot,
          intent: { active: active ?? null, queued: queued ?? null },
          moving: this.movement.isMoving('mara'),
          reserved: this.movement.reservations('mara'),
        };
      },
      request: this.options.request,
      timing: this.options.now ? {
        now: this.options.now,
        schedule: (callback, delay) => {
          const timer = setTimeout(callback, delay);
          return () => clearTimeout(timer);
        },
      } : undefined,
      dispatch: (action, requestId, commandId) => this.applyMara(action, requestId, commandId),
      audit: event => {
        if (event.kind === 'decisionReceived') {
          this.selected = event.decision.action;
          this.selectedRequest = event.requestId;
          this.rationale = event.decision.rationale;
          this.outcome = 'Awaiting validation.';
        }
        if (event.kind === 'decisionSkipped' && event.requestId === this.selectedRequest) {
          this.outcome = `Skipped. ${event.reason}`;
        }
        this.session.record({ ...event });
      },
      status: status => {
        if (status === this.status) return;
        this.status = status;
        this.changed = true;
      },
    });
  }

  private applyMara(action: LiveMaraAction, requestId: string, commandId: string) {
    const metadata = { source: 'mara-decision' as const, requestId, commandId };
    if (action.type === 'walkTo') {
      const scene = this.snapshot.sessionId;
      // Advance before reading occupancy or marking the start of an animation.
      this.session.advanceTo();
      if (this.disposed || this.snapshot.sessionId !== scene) {
        return { ok: false as const, reason: 'This scene has ended.' };
      }
      const result = this.movement.walkTo('mara', action.to, metadata);
      if (result.ok && result.status === 'queued' && requestId === this.selectedRequest) {
        this.outcome = 'Queued for the next tile.';
      }
      return result;
    }
    return this.session.dispatch('mara', action, undefined, metadata);
  }

  private observe(event: SessionEvent) {
    this.changed = true;
    switch (event.kind) {
      case 'session':
        if (event.phase === 'started') {
          this.status = 'Mara is ready.';
          this.rationale = '';
          this.selected = undefined;
          this.selectedRequest = undefined;
          this.outcome = '';
          this.mara = this.createMara();
        }
        break;
      case 'action': {
        const { actor, action } = event;
        if (event.status !== 'completed') {
          if (actor === 'mara' && event.metadata.requestId === this.selectedRequest) {
            this.outcome = `Skipped. ${event.reason}`;
          }
          return;
        }
        this.options.onAction(action, actor);
        if (isRoomInteraction(action)) this.mara.materialChange({ type: 'room', actor, action });
        if (action.type === 'speak') {
          this.mara.materialChange({ type: actor === 'player' ? 'player-speech' : 'mara-action', actor, action });
        }
        if (actor === 'mara' && action.type !== 'move' && event.metadata.requestId === this.selectedRequest) {
          this.outcome = 'Applied.';
        }
        break;
      }
      case 'routeFinished':
        if (event.actor !== 'mara') return;
        if (event.outcome === 'arrived' || event.outcome === 'blocked') {
          this.mara.materialChange({ type: 'mara-action', actor: 'mara', outcome: event.outcome });
        }
        if (!('requestId' in event) || event.requestId !== this.selectedRequest) break;
        if (event.outcome === 'arrived') this.outcome = 'Arrived.';
        if (event.outcome === 'blocked' || event.outcome === 'rejected') {
          const reason = 'reason' in event && typeof event.reason === 'string' ? event.reason : '';
          this.outcome = `${event.outcome === 'rejected' ? 'Skipped.' : 'Route blocked.'}${reason ? ' ' + reason : ''}`;
        }
        if (event.outcome === 'noop') this.outcome = 'Already there.';
        if (event.outcome === 'superseded') this.outcome = 'Superseded.';
        if (event.outcome === 'canceled') this.outcome = 'Canceled.';
        break;
      case 'routeStarted':
        if (event.actor === 'mara' && 'requestId' in event && event.requestId === this.selectedRequest) this.outcome = 'Walking.';
        break;
    }
  }

  private refresh() {
    if (this.disposed || !this.changed) return;
    this.changed = false;
    this.options.onChange();
  }
}
