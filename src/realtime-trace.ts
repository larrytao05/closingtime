import type { SessionEvent } from './realtime';

const storagePrefix = 'closing-time:trace:2:';
const batchDelayMs = 750;
const maxBufferedCharacters = 1_000_000;

type TraceStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>;
type RecordedEvent = SessionEvent & { capturedAt: string };

interface PendingOperations {
  requestIds: string[];
  commandIds: string[];
}

interface SessionProgress {
  requestIds: Set<string>;
  commandIds: Set<string>;
  droppedEvents: number;
  lastSequence: number;
  ended: boolean;
}

interface StoredChunk {
  sessionId: string;
  lastSequence: number;
  events: RecordedEvent[];
  droppedEvents: number;
  pending: PendingOperations;
}

interface BufferedEvent {
  sessionId: string;
  serialized: string;
}

interface TraceOptions {
  storage?: TraceStorage | null;
  now?: () => Date;
  maxBufferedCharacters?: number;
  onStorageStatusChange?: () => void;
}

function browserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function progress(): SessionProgress {
  return {
    requestIds: new Set(),
    commandIds: new Set(),
    droppedEvents: 0,
    lastSequence: -1,
    ended: false,
  };
}

function pendingOperations(session: SessionProgress): PendingOperations {
  return {
    requestIds: [...session.requestIds],
    commandIds: [...session.commandIds],
  };
}

function isStringArray(data: unknown): data is string[] {
  return Array.isArray(data) && data.every(item => typeof item === 'string');
}

function readChunk(value: string): StoredChunk {
  const chunk: Partial<StoredChunk> = JSON.parse(value);
  if (!chunk || typeof chunk.sessionId !== 'string' || !Number.isSafeInteger(chunk.lastSequence)
    || !Number.isSafeInteger(chunk.droppedEvents) || (chunk.droppedEvents ?? -1) < 0
    || !Array.isArray(chunk.events)
    || !chunk.events.every(event => event?.sessionId === chunk.sessionId && typeof event.kind === 'string'
      && Number.isSafeInteger(event.sequence) && typeof event.capturedAt === 'string')
    || !isStringArray(chunk.pending?.requestIds) || !isStringArray(chunk.pending?.commandIds)) {
    throw new Error('Invalid audit chunk');
  }
  return chunk as StoredChunk;
}

export class RealtimeTrace {
  private readonly storage?: TraceStorage;
  private readonly now: () => Date;
  private readonly characterLimit: number;
  private readonly onStorageStatusChange?: () => void;
  private readonly sessions = new Map<string, SessionProgress>();
  private buffer: BufferedEvent[] = [];
  private bufferedCharacters = 0;
  private storedCount = 0;
  private unreadableChunks = 0;
  private storageFailed = false;
  private dropped = false;
  private flushTimer?: ReturnType<typeof setTimeout>;

  constructor(options: TraceOptions = {}) {
    this.storage = options.storage === undefined ? browserStorage() : options.storage ?? undefined;
    this.now = options.now ?? (() => new Date());
    this.characterLimit = options.maxBufferedCharacters ?? maxBufferedCharacters;
    this.onStorageStatusChange = options.onStorageStatusChange;
    this.readStoredChunks();
  }

  get count() {
    return this.storedCount + this.buffer.length;
  }

  get needsExport() {
    return this.storageFailed || this.dropped || this.unreadableChunks > 0;
  }

  append(event: SessionEvent) {
    const state = this.sessions.get(event.sessionId) ?? progress();
    if (event.sequence <= state.lastSequence) return;
    state.lastSequence = event.sequence;
    this.sessions.set(event.sessionId, state);
    this.observe(event, state);

    try {
      const serialized = JSON.stringify({ ...event, capturedAt: this.now().toISOString() });
      this.buffer.push({ sessionId: event.sessionId, serialized });
      this.bufferedCharacters += serialized.length;
    } catch {
      state.droppedEvents++;
      this.dropped = true;
    }
    // Truncation applies only to events that have not already been persisted.
    while (this.bufferedCharacters > this.characterLimit) {
      const oldest = this.buffer.shift();
      if (!oldest) break;
      this.bufferedCharacters -= oldest.serialized.length;
      const oldestSession = this.sessions.get(oldest.sessionId);
      if (oldestSession) oldestSession.droppedEvents++;
      this.dropped = true;
    }

    if (!this.storage) {
      this.storageFailed = true;
      return;
    }
    this.flushTimer ??= setTimeout(() => this.flush(), batchDelayMs);
  }

  flush() {
    const hadWarning = this.needsExport;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.storage) return;

    const bySession = new Map<string, BufferedEvent[]>();
    for (const entry of this.buffer) {
      const entries = bySession.get(entry.sessionId) ?? [];
      entries.push(entry);
      bySession.set(entry.sessionId, entries);
    }

    const persisted = new Set<string>();
    for (const [sessionId, state] of this.sessions) {
      const events = bySession.get(sessionId) ?? [];
      if (events.length === 0 && state.droppedEvents === 0) continue;
      const header = JSON.stringify({
        sessionId,
        lastSequence: state.lastSequence,
        droppedEvents: state.droppedEvents,
        pending: pendingOperations(state),
      });
      // Events are serialized once on receipt, including an immutable copy of their snapshots.
      const chunk = header.slice(0, -1) + ',"events":['
        + events.map(entry => entry.serialized).join(',') + ']}';
      try {
        this.storage.setItem(storagePrefix + sessionId + ':' + state.lastSequence, chunk);
      } catch {
        // Keep this session's unwritten events available to the download.
        continue;
      }
      persisted.add(sessionId);
      this.storedCount += events.length;
      state.droppedEvents = 0;
      if (state.ended) this.sessions.delete(sessionId);
    }

    this.buffer = this.buffer.filter(entry => {
      if (!persisted.has(entry.sessionId)) return true;
      this.bufferedCharacters -= entry.serialized.length;
      return false;
    });
    this.storageFailed = this.buffer.length > 0
      || [...this.sessions.values()].some(session => session.droppedEvents > 0);
    if (this.needsExport !== hadWarning) this.onStorageStatusChange?.();
  }

  toJSON() {
    this.flush();
    const hadWarning = this.needsExport;
    const chunks = this.readStoredChunks();
    if (this.needsExport !== hadWarning) this.onStorageStatusChange?.();
    const sessions = new Map<string, {
      sessionId: string;
      lastSequence: number;
      events: RecordedEvent[];
      droppedEvents: number;
      pendingAtExport: PendingOperations;
    }>();
    const merge = (chunk: StoredChunk) => {
      const current = sessions.get(chunk.sessionId) ?? {
        sessionId: chunk.sessionId,
        lastSequence: -1,
        events: [],
        droppedEvents: 0,
        pendingAtExport: { requestIds: [], commandIds: [] },
      };
      for (const event of chunk.events) current.events.push(event);
      current.droppedEvents += chunk.droppedEvents;
      if (chunk.lastSequence > current.lastSequence) {
        current.lastSequence = chunk.lastSequence;
        current.pendingAtExport = chunk.pending;
      }
      sessions.set(chunk.sessionId, current);
    };

    for (const chunk of chunks) merge(chunk);
    const unsaved = new Map<string, RecordedEvent[]>();
    for (const entry of this.buffer) {
      const events = unsaved.get(entry.sessionId) ?? [];
      events.push(JSON.parse(entry.serialized) as RecordedEvent);
      unsaved.set(entry.sessionId, events);
    }
    for (const [sessionId, state] of this.sessions) {
      merge({
        sessionId,
        lastSequence: state.lastSequence,
        events: unsaved.get(sessionId) ?? [],
        droppedEvents: state.droppedEvents,
        pending: pendingOperations(state),
      });
    }

    return JSON.stringify({
      schemaVersion: 2,
      mode: 'realtime',
      unreadableChunks: this.unreadableChunks,
      sessions: [...sessions.values()].map(({ lastSequence: _, ...session }) => ({
        ...session,
        events: session.events.sort((a, b) => a.sequence - b.sequence),
      })),
    }, null, 2);
  }

  private observe(event: SessionEvent, state: SessionProgress) {
    if (event.kind === 'session' && 'phase' in event && event.phase === 'ended') state.ended = true;
    if ('requestId' in event && typeof event.requestId === 'string') {
      if (event.kind === 'decisionRequested') state.requestIds.add(event.requestId);
      if (event.kind === 'decisionReceived' || event.kind === 'decisionFailed' || event.kind === 'decisionCanceled') {
        state.requestIds.delete(event.requestId);
      }
    }
    if ('commandId' in event && typeof event.commandId === 'string') {
      if (event.kind === 'routeSubmitted' || event.kind === 'routeStarted') state.commandIds.add(event.commandId);
      if (event.kind === 'routeFinished') state.commandIds.delete(event.commandId);
    }
  }

  private readStoredChunks() {
    const chunks: StoredChunk[] = [];
    let unreadable = 0;
    try {
      for (let index = 0; index < (this.storage?.length ?? 0); index++) {
        const key = this.storage?.key(index);
        if (!key?.startsWith(storagePrefix)) continue;
        try {
          const value = this.storage?.getItem(key);
          if (value) chunks.push(readChunk(value));
        } catch {
          unreadable++;
        }
      }
    } catch {
      this.storageFailed = true;
    }
    this.unreadableChunks = unreadable;
    if (chunks.some(chunk => chunk.droppedEvents > 0)) this.dropped = true;
    this.storedCount = chunks.reduce((count, chunk) => count + chunk.events.length, 0);
    return chunks;
  }
}
