import { SIMULATION_AUDIT_MAX_BYTES, SIMULATION_AUDIT_MAX_ENTRIES } from './contracts';
import type {
  AuditSnapshot,
  SimulationMemoryRecord,
  SimulationRoomCheckpoint,
  SimulationSaveClaim,
  SimulationSaveClaimResult,
  SimulationSaveEnvelope,
  SimulationSaveMutationResult,
} from './contracts';

const DB_NAME = 'closing-time-simulation';
const DB_VERSION = 1;
const STORE = 'runs';
const KEY = 'current';

export interface DurableState {
  runId: string;
  writerToken: string;
  generation: number;
  envelope: SimulationSaveEnvelope | null;
}

/** Injectable boundary for deterministic tests; browser uses IndexedDB below. */
export interface SimulationSaveStorage {
  readWrite<T>(update: (current: DurableState | null) => { next: DurableState | null; result: T }): Promise<T>;
  readOnly<T>(read: (current: DurableState | null) => T): Promise<T>;
}

/** IndexedDB boundary: each callback and its replacement value run in one transaction. */
export class IndexedDbSimulationSaveStorage implements SimulationSaveStorage {
  private database: Promise<IDBDatabase>;
  constructor(factory: IDBFactory = globalThis.indexedDB, databaseName = DB_NAME) {
    if (!factory) throw new Error('IndexedDB is unavailable in this browser.');
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(databaseName, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open simulation storage.'));
      request.onblocked = () => reject(new Error('Simulation storage upgrade is blocked by another tab.'));
    });
  }

  async readWrite<T>(update: (current: DurableState | null) => { next: DurableState | null; result: T }): Promise<T> {
    const db = await this.database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let result: T;
      let failed = false;
      const request = store.get(KEY);
      request.onerror = () => { failed = true; reject(request.error ?? new Error('Could not read simulation save.')); };
      request.onsuccess = () => {
        try {
          const updated = update((request.result ?? null) as DurableState | null);
          result = updated.result;
          if (updated.next === null) store.delete(KEY); else store.put(updated.next, KEY);
        } catch (error) {
          failed = true;
          try { tx.abort(); } catch { /* transaction may already have completed */ }
          reject(error);
        }
      };
      tx.oncomplete = () => { if (!failed) resolve(result!); };
      tx.onerror = () => { if (!failed) reject(tx.error ?? new Error('Simulation save transaction failed.')); };
      tx.onabort = () => { if (!failed) reject(tx.error ?? new Error('Simulation save transaction was aborted.')); };
    });
  }

  async readOnly<T>(read: (current: DurableState | null) => T): Promise<T> {
    const db = await this.database;
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(KEY);
      let value: T;
      request.onsuccess = () => { try { value = read((request.result ?? null) as DurableState | null); } catch (error) { reject(error); } };
      request.onerror = () => reject(request.error ?? new Error('Could not read simulation save.'));
      tx.oncomplete = () => resolve(value!);
      tx.onerror = () => reject(tx.error ?? new Error('Simulation load transaction failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Simulation load transaction was aborted.'));
    });
  }
}

/** Serializes local operations and uses durable transaction claims across tabs. */
export class SimulationSaveStore {
  private readonly storage: SimulationSaveStorage;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(storage: SimulationSaveStorage = new IndexedDbSimulationSaveStorage()) { this.storage = storage; }

  claim(runId: string, writerToken: string): Promise<SimulationSaveClaimResult> {
    return this.enqueue(() => this.storage.readWrite(current => {
      if (!validId(runId) || !validId(writerToken)) throw new TypeError('Invalid simulation save owner.');
      const sameOwner = current?.runId === runId && current.writerToken === writerToken;
      const generation = sameOwner ? current.generation : (current?.generation ?? 0) + 1;
      const envelope = current?.runId === runId ? current.envelope : null;
      if (current && envelope && !validEnvelope(envelope)) return { next: current, result: { status: 'ownership-lost', currentGeneration: current.generation } as SimulationSaveClaimResult };
      const claim = { runId, writerToken, generation };
      const rebound = envelope ? { ...envelope, writerToken, writerGeneration: generation } : null;
      return { next: { runId, writerToken, generation, envelope: rebound }, result: { status: 'claimed', claim, envelope: rebound ? clone(rebound) : null } as SimulationSaveClaimResult };
    }));
  }

  loadCurrent(): Promise<SimulationSaveEnvelope | null> {
    return this.enqueue(() => this.storage.readOnly(current => {
      if (!current?.envelope || !validEnvelope(current.envelope)) return null;
      if (current.envelope.runId !== current.runId || current.envelope.writerToken !== current.writerToken || current.envelope.writerGeneration !== current.generation) return null;
      return clone(current.envelope);
    }));
  }

  save(claim: SimulationSaveClaim, envelope: SimulationSaveEnvelope): Promise<SimulationSaveMutationResult> {
    return this.enqueue(() => this.storage.readWrite(current => {
      if (!current) return { next: null, result: { status: 'missing' } as SimulationSaveMutationResult };
      if (!owns(current, claim)) return { next: current, result: { status: 'ownership-lost', currentGeneration: current.generation } as SimulationSaveMutationResult };
      if (!validEnvelope(envelope) || envelope.runId !== claim.runId) throw new TypeError('Invalid simulation save envelope.');
      const saved = current.envelope;
      // A delayed checkpoint from this tab cannot roll the event stream back.
      if (saved && (envelope.nextEventSequence < saved.nextEventSequence || envelope.checkpoint.revision < saved.checkpoint.revision || envelope.checkpoint.activeTimeMs < saved.checkpoint.activeTimeMs))
        return { next: current, result: { status: 'ownership-lost', currentGeneration: current.generation } as SimulationSaveMutationResult };
      const normalized = { ...clone(envelope), writerToken: claim.writerToken, writerGeneration: claim.generation };
      return { next: { ...current, envelope: normalized }, result: { status: 'saved', generation: claim.generation } as SimulationSaveMutationResult };
    }));
  }

  release(claim: SimulationSaveClaim): Promise<SimulationSaveMutationResult> {
    return this.enqueue(() => this.storage.readWrite(current => {
      if (!current) return { next: null, result: { status: 'missing' } as SimulationSaveMutationResult };
      if (!owns(current, claim)) return { next: current, result: { status: 'ownership-lost', currentGeneration: current.generation } as SimulationSaveMutationResult };
      // Retain the durable generation tombstone so a stale writer can never recreate the save.
      const generation = current.generation + 1;
      return { next: { ...current, writerToken: '', generation, envelope: null }, result: { status: 'saved', generation } as SimulationSaveMutationResult };
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function owns(current: DurableState, claim: SimulationSaveClaim): boolean {
  return current.runId === claim.runId && current.writerToken === claim.writerToken && current.generation === claim.generation;
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function clone<T>(value: T): T { return structuredClone(value); }

const ACTORS = new Set(['player', 'mara', 'riley', 'jo']);
function validCheckpoint(value: unknown): value is SimulationRoomCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  if (![c.activeTimeMs, c.revision, c.rainExposureMs].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0) || typeof c.windowOpen !== 'boolean' || !c.actors || typeof c.actors !== 'object' || !c.objects || typeof c.objects !== 'object') return false;
  for (const [actor, point] of Object.entries(c.actors as Record<string, unknown>)) if (!ACTORS.has(actor) || !validPoint(point)) return false;
  const objects = c.objects as Record<string, unknown>;
  if (Object.keys(objects).length !== 4 || ['papers', 'mug1', 'mug2', 'towel'].some(id => !(id in objects))) return false;
  for (const object of Object.values(objects)) {
    if (!object || typeof object !== 'object') return false;
    const o = object as Record<string, unknown>;
    const loc = o.location as Record<string, unknown> | undefined;
    const held = loc && Object.keys(loc).length === 1 && ACTORS.has(String(loc.heldBy));
    const surfaced = loc && Object.keys(loc).length === 1 && ['table', 'counter'].includes(String(loc.surface));
    if (!loc || typeof o.wetness !== 'number' || !Number.isFinite(o.wetness) || o.wetness < 0 || !(held || surfaced)) return false;
  }
  return true;
}
function validPoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y);
}
function validAudit(value: unknown, runId: string): value is AuditSnapshot {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  if (a.schemaVersion !== 3 || a.runId !== runId || !validCheckpoint(a.startingCheckpoint) || !validCheckpoint(a.finalCheckpoint) || !Array.isArray(a.entries) || a.entries.length > SIMULATION_AUDIT_MAX_ENTRIES || typeof a.firstRetainedSequence !== 'number' || !Number.isSafeInteger(a.firstRetainedSequence) || a.firstRetainedSequence < 1 || typeof a.prunedThroughSequence !== 'number' || !Number.isSafeInteger(a.prunedThroughSequence) || a.prunedThroughSequence < 0) return false;
  const start = a.startingCheckpointProvenance as Record<string, unknown> | undefined;
  const end = a.finalCheckpointProvenance as Record<string, unknown> | undefined;
  if (!start || start.runId !== runId || !Number.isSafeInteger(start.throughSequence) || typeof start.revision !== 'number' || !Number.isSafeInteger(start.revision) || !['run-start', 'retention-boundary'].includes(String(start.source))) return false;
  if (!end || end.runId !== runId || !Number.isSafeInteger(end.throughSequence) || typeof end.revision !== 'number' || !Number.isSafeInteger(end.revision)) return false;
  let previousOrder = -1;
  for (const entry of a.entries) {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as Record<string, unknown>;
    if (!Number.isSafeInteger(item.auditOrder) || Number(item.auditOrder) <= previousOrder) return false;
    previousOrder = Number(item.auditOrder);
    if (item.kind === 'committed-event') {
      const event = item.event as Record<string, unknown> | undefined;
      if (!event || event.runId !== runId || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < Number(a.firstRetainedSequence) || !Number.isFinite(event.activeTimeMs) || !Number.isSafeInteger(event.revision) || !Array.isArray(event.audience) || event.audience.some(actor => !ACTORS.has(String(actor))) || !event.payload || typeof event.payload !== 'object' || !validCheckpoint(event.afterCheckpoint)) return false;
      const provenance = event.afterCheckpointProvenance as Record<string, unknown> | undefined;
      if (!provenance || provenance.runId !== runId || provenance.eventSequence !== event.sequence || provenance.revision !== event.revision) return false;
    } else if (item.kind === 'decision') {
      const request = item.request as Record<string, unknown> | undefined;
      if (!request || request.runId !== runId || !validId(request.requestId) || !Number.isSafeInteger(request.generation) || !ACTORS.has(String(request.actorId)) || !Array.isArray(request.witnessedEvents) || !Array.isArray(request.options) || !request.recall || !['committed', 'stale', 'cancelled', 'failed'].includes(String(item.outcome))) return false;
    } else return false;
  }
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= SIMULATION_AUDIT_MAX_BYTES; } catch { return false; }
}

function validMemory(value: unknown): value is SimulationMemoryRecord[] {
  if (!Array.isArray(value) || value.length > 512) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return false;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id) || !ACTORS.has(String(r.owner)) || !Array.isArray(r.sourceEventIds) || r.sourceEventIds.length < 1 || r.sourceEventIds.length > 128 || r.sourceEventIds.some(id => typeof id !== 'string') || typeof r.activeTimeMs !== 'number' || !Number.isFinite(r.activeTimeMs) || r.activeTimeMs < 0) return false;
    if (r.kind === 'observation') { if (r.sourceEventIds.length !== 1 || typeof r.text !== 'string' || r.text.length > 1000) return false; }
    else if (r.kind === 'attributed-speech') { if (r.sourceEventIds.length !== 1 || !ACTORS.has(String(r.speaker)) || typeof r.exactLine !== 'string' || r.exactLine.length > 160) return false; }
    else if (r.kind === 'commitment') { if (!ACTORS.has(String(r.speaker)) || typeof r.exactLine !== 'string' || r.exactLine.length > 160 || !['open', 'completed', 'withdrawn'].includes(String(r.status))) return false; }
    else return false;
    ids.add(r.id);
  }
  return true;
}
function validEnvelope(value: unknown): value is SimulationSaveEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (!(e.schemaVersion === 3 && validId(e.runId) && validId(e.writerToken) && Number.isSafeInteger(e.writerGeneration) && Number(e.writerGeneration) > 0 && validCheckpoint(e.checkpoint) && validMemory(e.memory) && validAudit(e.audit, String(e.runId)) && Number.isSafeInteger(e.nextEventSequence) && Number(e.nextEventSequence) > 0)) return false;
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= SIMULATION_AUDIT_MAX_BYTES + 512 * 1024; } catch { return false; }
}
