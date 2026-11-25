import {
  SIMULATION_REQUEST_MAX_RECALL_BYTES,
  type ActorLocalObservation,
  type BoundedMemoryProposals,
  type SimulationActorId,
  type SimulationCommittedEvent,
  type SimulationMemoryProposal,
  type SimulationMemoryRecord,
  type SimulationActorRecall,
  type WitnessedObservationEvent,
} from './contracts';

const MAX_RECORDS = 512;
const encoder = new TextEncoder();
const eventId = (event: Pick<WitnessedObservationEvent, 'runId' | 'sequence'>) => `${event.runId}:${event.sequence}`;
const unique = (items: string[]) => [...new Set(items)];

function describeEvent(event: SimulationCommittedEvent): string | null {
  const p = event.payload;
  switch (p.type) {
    case 'actor-joined': return `${p.actorId} joined at (${p.position.x}, ${p.position.y}).`;
    case 'movement-tile-committed': return `${p.actorId} moved from (${p.from.x}, ${p.from.y}) to (${p.to.x}, ${p.to.y}).`;
    case 'room-interaction': {
      const action = p.action;
      if (action.type === 'pickUp') return `${p.actorId} picked up ${action.objectId}.`;
      if (action.type === 'putDown') return `${p.actorId} put down ${action.objectId} on ${action.surfaceId}.`;
      if (action.type === 'open') return `${p.actorId} opened the window.`;
      if (action.type === 'close') return `${p.actorId} closed the window.`;
      return `${p.actorId} waited.`;
    }
    case 'rain': return p.exposed ? `Rain exposed the café for ${p.elapsedMs} ms; wetness changed by ${p.wetnessDelta}.` : `The café was sheltered from rain for ${p.elapsedMs} ms.`;
    case 'speech': return null;
  }
}

function isProposalArray(value: unknown): value is BoundedMemoryProposals {
  return Array.isArray(value) && value.length <= 3 && value.every(item => !!item && typeof item === 'object');
}

function isExplicitCommitment(line: string): boolean {
  return /\b(i promise|i\s*['’]ll|i will|i can|we promise|we\s*['’]ll|we will)\b/i.test(line) && /\b(bring|do|finish|complete|deliver|pay|make|help|take|call|send|return|keep|cover|clean|fix|close|open|stay|come|pick|put|make sure)\b/i.test(line);
}

function hasExplicitOutcome(line: string, outcome: 'completed' | 'withdrawn'): boolean {
  const text = line.toLocaleLowerCase();
  if (outcome === 'completed') return /\b(done|finished|completed|fulfilled|delivered|here it is|i brought|i have brought)\b/.test(text);
  return /\b(withdraw|withdrawn|cancel|cancelled|can't|cannot|won't|will not|i take it back|i retract)\b/.test(text);
}

/** Actor-scoped durable recall. Only committed audience events can enter it. */
export class SimulationMemory {
  private records: SimulationMemoryRecord[] = [];

  ingest(event: SimulationCommittedEvent, forActor: SimulationActorId): void {
    if (!event.audience.includes(forActor)) return;
    const id = eventId(event);
    const p = event.payload;
    if (p.type === 'speech') {
      this.add({
        id: `speech:${id}:${p.actorId}`,
        kind: 'attributed-speech', owner: forActor, speaker: p.actorId,
        sourceEventIds: [id], exactLine: p.text, activeTimeMs: event.activeTimeMs,
      });
      return;
    }
    const text = describeEvent(event);
    if (text) this.add({
      id: `observation:${id}`, kind: 'observation', owner: forActor,
      sourceEventIds: [id], text, activeTimeMs: event.activeTimeMs,
    });
  }

  recall(actorId: SimulationActorId, observation: ActorLocalObservation, budgetBytes = SIMULATION_REQUEST_MAX_RECALL_BYTES): SimulationActorRecall {
    const limit = Math.max(0, Math.min(SIMULATION_REQUEST_MAX_RECALL_BYTES, Math.floor(budgetBytes)));
    const own = this.records.filter(record => record.owner === actorId);
    const current = new Map<string, SimulationMemoryRecord>();
    for (const record of own) if (record.kind === 'commitment') {
      const previous = current.get(record.id);
      if (!previous || previous.activeTimeMs <= record.activeTimeMs) current.set(record.id, record);
    }
    const commitmentIds = new Set<string>();
    for (const [id, record] of current) if (record.kind === 'commitment' && record.status === 'open') commitmentIds.add(id);
    const activeCommitments = own.filter((record): record is Extract<SimulationMemoryRecord, {kind:'commitment'}> => record.kind === 'commitment' && commitmentIds.has(record.id));
    const query = new Set<string>();
    for (const actor of observation.visibleActors) query.add(actor.actorId);
    for (const object of observation.visibleObjects) query.add(object.objectId);
    const scored = own.filter(record => record.kind !== 'commitment').map(record => ({record, score: this.score(record, query)}));
    scored.sort((a, b) => b.score - a.score || b.record.activeTimeMs - a.record.activeTimeMs || a.record.id.localeCompare(b.record.id));
    const nonCommitments = scored.map(item => item.record);
    const selected: SimulationMemoryRecord[] = [];
    const ids: string[] = [];
    const append = (record: SimulationMemoryRecord) => {
      if (ids.includes(record.id)) return;
      const next = [...selected, record];
      const recall = { actorId, records: next, retrievedMemoryIds: next.map(item => item.id) };
      if (encoder.encode(JSON.stringify(recall)).byteLength <= limit) { selected.push(record); ids.push(record.id); }
    };
    // Reserve space for current commitments before ordinary history.
    for (const record of activeCommitments.sort((a, b) => b.activeTimeMs - a.activeTimeMs)) append(record);
    for (const record of nonCommitments) append(record);
    return { actorId, records: selected, retrievedMemoryIds: ids };
  }

  applyProposals(actorId: SimulationActorId, proposals: BoundedMemoryProposals, witnessedEvents: WitnessedObservationEvent[]): SimulationMemoryRecord[] {
    if (!isProposalArray(proposals)) return [];
    const byId = new Map(witnessedEvents.map(event => [eventId(event), event]));
    const created: SimulationMemoryRecord[] = [];
    for (const proposal of proposals) {
      const record = this.applyOne(actorId, proposal, byId);
      if (record) {
        if (record.kind === 'commitment' && record.status !== 'open') {
          const index = this.records.findIndex(item => item.id === record.id);
          if (index >= 0) this.records[index] = structuredClone(record); else this.add(record);
        } else this.add(record);
        created.push(record);
      }
    }
    return created;
  }

  snapshot(): SimulationMemoryRecord[] { return this.records.map(record => structuredClone(record)); }

  restore(records: SimulationMemoryRecord[]): void {
    if (!Array.isArray(records) || records.length > MAX_RECORDS || records.some(record => !validMemoryRecord(record)))
      throw new TypeError('Invalid simulation memory snapshot.');
    const seen = new Set<string>();
    for (const record of records) {
      if (seen.has(record.id)) throw new TypeError('Duplicate simulation memory record.');
      seen.add(record.id);
    }
    this.records = records.map(record => structuredClone(record));
  }

  private applyOne(actorId: SimulationActorId, proposal: SimulationMemoryProposal, events: Map<string, WitnessedObservationEvent>): SimulationMemoryRecord | null {
    const source = events.get(proposal.sourceEventId);
    if (!source || source.payload.type !== 'speech' || source.payload.actorId !== actorId || source.payload.text !== proposal.exactLine) return null;
    if (proposal.kind === 'open-commitment') {
      if (!isExplicitCommitment(source.payload.text)) return null;
      const id = `commitment:${eventId(source)}:${actorId}`;
      const prior = this.records.find(record => record.id === id);
      if (prior) return null;
      return { id, kind: 'commitment', owner: actorId, speaker: actorId, sourceEventIds: [eventId(source)], exactLine: source.payload.text, status: 'open', activeTimeMs: source.activeTimeMs };
    }
    const target = this.records.find((record): record is Extract<SimulationMemoryRecord, {kind:'commitment'}> => record.id === proposal.commitmentId && record.kind === 'commitment' && record.owner === actorId && record.speaker === actorId && record.status === 'open');
    if (!target || source.sequence <= Number(target.sourceEventIds[0].split(':').at(-1)) || !hasExplicitOutcome(source.payload.text, proposal.outcome)) return null;
    if (target.sourceEventIds.includes(eventId(source))) return null;
    const parsed = Number(eventId(source).split(':').at(-1));
    if (!Number.isFinite(parsed)) return null;
    return { ...target, sourceEventIds: unique([...target.sourceEventIds, eventId(source)]) as [string, ...string[]], exactLine: source.payload.text, status: proposal.outcome, activeTimeMs: source.activeTimeMs };
  }

  private score(record: Exclude<SimulationMemoryRecord, {kind:'commitment'}>, query: Set<string>): number {
    const text = record.kind === 'observation' ? record.text : `${record.speaker} ${record.exactLine}`;
    const lower = text.toLocaleLowerCase();
    let score = 0;
    for (const term of query) if (lower.includes(term.toLocaleLowerCase())) score += 20;
    if (record.kind === 'observation') score += 1; // prefer concrete observations over dialogue for ties
    return score;
  }

  private add(record: SimulationMemoryRecord): void {
    if (this.records.some(item => item.id === record.id)) return;
    this.records.push(structuredClone(record));
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
  }
}

const ACTORS = new Set(['player', 'mara', 'riley', 'jo']);
function validMemoryRecord(value: unknown): value is SimulationMemoryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || !ACTORS.has(String(r.owner)) || !Array.isArray(r.sourceEventIds) || r.sourceEventIds.length < 1 || r.sourceEventIds.some(id => typeof id !== 'string') || typeof r.activeTimeMs !== 'number' || !Number.isFinite(r.activeTimeMs) || r.activeTimeMs < 0) return false;
  if (r.kind === 'observation') return r.sourceEventIds.length === 1 && typeof r.text === 'string' && r.text.length <= 1000;
  if (r.kind === 'attributed-speech') return r.sourceEventIds.length === 1 && ACTORS.has(String(r.speaker)) && typeof r.exactLine === 'string' && r.exactLine.length <= 160;
  return r.kind === 'commitment' && r.sourceEventIds.length <= 128 && ACTORS.has(String(r.speaker)) && typeof r.exactLine === 'string' && r.exactLine.length <= 160 && ['open', 'completed', 'withdrawn'].includes(String(r.status));
}
