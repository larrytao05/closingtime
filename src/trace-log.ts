import type { MaraDecision, MaraObservation } from './planner';
import type { World } from './world';

export interface TurnTrace {
  sessionId: string;
  recordedAt: string;
  worldBefore: World;
  observation: MaraObservation;
  decision: MaraDecision;
  worldAfter: World;
}

const prefix = 'closing-time:trace:1:';

export class TraceLog {
  private readonly unsaved: TurnTrace[] = [];
  needsExport = false;

  private keys(): string[] {
    try {
      const keys = [];
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
      }
      return keys;
    } catch {
      this.needsExport = true;
      return [];
    }
  }

  get count() {
    return this.keys().length + this.unsaved.length;
  }

  append(trace: TurnTrace) {
    try {
      localStorage.setItem(prefix + trace.sessionId + ':' + trace.worldAfter.turn, JSON.stringify(trace));
    } catch {
      this.needsExport = true;
      this.unsaved.push(trace);
    }
  }

  toJSON() {
    const turns = [...this.unsaved];
    for (const key of this.keys()) {
      try {
        const value = localStorage.getItem(key);
        if (value) turns.push(JSON.parse(value) as TurnTrace);
      } catch {
        this.needsExport = true;
      }
    }
    turns.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
    return JSON.stringify({ schemaVersion: 1, turns }, null, 2);
  }
}
