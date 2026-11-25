import type { NpcId } from './contracts';

export class SimulationRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) { super('provider rate limited'); }
}
type Job = { actorId: NpcId; reason: string; retries: number; token: number };
type Running = { job: Job; controller: AbortController; token: number; deadline: ReturnType<typeof setTimeout> };

/**
 * Fair scene-wide decision queue. Each wake carries one coalesced pending reason
 * per actor; active requests are cancelled on pause/cancel/dispose/deadline.
 */
export class SimulationScheduler {
  private readonly now: () => number;
  private readonly startDecision: (actorId: NpcId, reason: string, signal: AbortSignal) => Promise<void>;
  private readonly maxInFlight: number;
  private readonly deadlineMs: number;
  private readonly startsPerMinute: number;
  private readonly replyWakeCap: number;
  private pending = new Map<NpcId, Job>();
  private order: NpcId[] = [];
  private running = new Map<NpcId, Running>();
  private starts: number[] = [];
  private replyStreak = new Map<NpcId, number>();
  private paused = false;
  private disposed = false;
  private epoch = 0;
  private nextToken = 1;
  private blockedUntil = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: { now: () => number; startDecision: (actorId: NpcId, reason: string, signal: AbortSignal) => Promise<void>; maxInFlight?: number; deadlineMs?: number; startsPerMinute?: number; replyWakeCap?: number }) {
    this.now = options.now; this.startDecision = options.startDecision;
    this.maxInFlight = options.maxInFlight ?? 2;
    this.deadlineMs = options.deadlineMs ?? 15_000; this.startsPerMinute = options.startsPerMinute ?? 12;
    this.replyWakeCap = options.replyWakeCap ?? 3;
  }

  wake(actorId: NpcId, reason: string): void {
    if (this.disposed || this.paused || !reason.trim()) return;
    const isReply = reason.startsWith('reply:');
    if (!isReply) this.replyStreak.set(actorId, 0);
    else if ((this.replyStreak.get(actorId) ?? 0) >= this.replyWakeCap) return;
    const existing = this.pending.get(actorId);
    if (existing) { existing.reason = reason; existing.retries = 0; }
    else {
      const job = { actorId, reason, retries: 0, token: this.nextToken++ };
      this.pending.set(actorId, job); this.order.push(actorId);
    }
    this.pump();
  }

  pause(_reason = 'paused'): void {
    if (this.disposed) return;
    this.paused = true; this.epoch++;
    this.pending.clear(); this.order = [];
    this.abortRunning(); this.clearTimer();
  }
  resume(): void { if (this.disposed) return; this.paused = false; this.pump(); }
  cancelAll(_reason: string): void {
    if (this.disposed) return;
    this.epoch++; this.pending.clear(); this.order = []; this.abortRunning(); this.clearTimer();
  }
  dispose(): void { if (this.disposed) return; this.cancelAll('disposed'); this.disposed = true; }

  private abortRunning() {
    for (const item of this.running.values()) { clearTimeout(item.deadline); item.controller.abort(); }
    this.running.clear();
  }
  private clearTimer() { if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private schedule(at: number) {
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.max(0, at - this.now()));
  }
  private pump() {
    if (this.disposed || this.paused) return;
    const now = this.now();
    this.starts = this.starts.filter(t => now - t < 60_000);
    if (now < this.blockedUntil) { this.schedule(this.blockedUntil); return; }
    while (this.running.size < this.maxInFlight && this.order.length) {
      const nextAt = this.starts.length >= this.startsPerMinute ? this.starts[0] + 60_000 : undefined;
      if (nextAt !== undefined && now < nextAt) { this.schedule(nextAt); return; }
      const actorId = this.order.shift()!;
      const job = this.pending.get(actorId);
      if (!job) continue;
      if (this.running.has(actorId)) { this.order.push(actorId); if (this.order.every(id => this.running.has(id))) return; continue; }
      this.pending.delete(actorId);
      const controller = new AbortController(); const token = this.nextToken++;
      const epoch = this.epoch;
      const deadline = setTimeout(() => {
        if (this.running.get(actorId)?.token !== token) return;
        controller.abort(); this.running.delete(actorId); this.pump();
      }, this.deadlineMs);
      const running: Running = { job, controller, token, deadline };
      this.running.set(actorId, running);
      this.starts.push(now);
      if (job.reason.startsWith('reply:')) this.replyStreak.set(actorId, (this.replyStreak.get(actorId) ?? 0) + 1);
      let promise: Promise<void>;
      try { promise = this.startDecision(actorId, job.reason, controller.signal); }
      catch (error) { promise = Promise.reject(error); }
      promise.then(() => this.finish(actorId, token, epoch), error => this.failed(actorId, token, epoch, error));
    }
  }
  private finish(actorId: NpcId, token: number, epoch: number) {
    if (epoch !== this.epoch || this.running.get(actorId)?.token !== token) return;
    const running = this.running.get(actorId)!; clearTimeout(running.deadline); this.running.delete(actorId);
    this.rotatePendingActor(actorId); this.pump();
  }
  private failed(actorId: NpcId, token: number, epoch: number, error: unknown) {
    if (epoch !== this.epoch || this.running.get(actorId)?.token !== token) return;
    const current = this.running.get(actorId)!;
    clearTimeout(current.deadline);
    const { job } = current;
    this.running.delete(actorId);
    if (error instanceof SimulationRateLimitError) {
      const delay = Math.max(0, Math.min(120_000, error.retryAfterMs));
      this.blockedUntil = Math.max(this.blockedUntil, this.now() + delay);
      if (job.retries < 2 && !this.pending.has(actorId)) {
        job.retries++;
        this.pending.set(actorId, job);
        this.order.push(actorId);
      }
    }
    this.rotatePendingActor(actorId);
    this.pump();
  }
  private rotatePendingActor(actorId: NpcId) {
    if (!this.pending.has(actorId)) return;
    this.order = this.order.filter(id => id !== actorId);
    this.order.push(actorId);
  }
}
