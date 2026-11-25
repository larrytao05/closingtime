import { SimulationRuntime } from './runtime';
import { SimulationAudit } from './audit';
import type { SimulationActorId, SimulationAction, SimulationRoomCheckpoint } from './contracts';
import { layout, type Point } from '../world';

const CELL = 86, LEFT = 40, TOP = 39, WIDTH = 768, HEIGHT = 576;
const CAST: SimulationActorId[] = ['mara', 'riley', 'jo', 'player'];
const NAMES: Record<SimulationActorId, string> = { mara: 'Mara', riley: 'Riley', jo: 'Jo', player: 'You' };
const OBJECT_NAMES = { papers: 'Papers', mug1: 'Cream mug', mug2: 'Green mug', towel: 'Towel' } as const;
type RuntimeState = ReturnType<SimulationRuntime['snapshot']>;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Browser controls and canvas for the autonomous simulation mode. */
export class SimulationView {
  private runtime?: SimulationRuntime;
  private state?: RuntimeState;
  private actor: SimulationActorId = 'mara';
  private started = false;
  private held = new Map<string, Point>();
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;

  constructor() {
    this.canvas = el<HTMLCanvasElement>('simulation-canvas');
    this.context = this.canvas.getContext('2d')!;
    this.canvas.setAttribute('aria-label', 'Simulation café room');
    this.bind();
    this.draw();
  }

  async start(resume: boolean) {
    if (this.started) {
      try {
        await this.runtime?.reset();
        el('simulation-replay-section').hidden = true;
        el('simulation-replay').textContent = '';
        this.message('A new café scene is running.');
      } catch (error) { this.message(`Could not start a new scene: ${this.errorMessage(error)}`); }
      return;
    }
    try {
      const query = new URLSearchParams(location.search);
      const fixture = query.has('fixture');
      this.runtime = resume ? await SimulationRuntime.resume(fixture ? { ambientIntervalMs: 4_000 } : {})
        : await SimulationRuntime.start(fixture ? { ambientIntervalMs: 4_000 } : {});
      this.runtime.subscribe(snapshot => { this.state = snapshot; this.render(); });
      this.runtime.subscribeFrame(frame => { this.draw(frame.renderPositions); });
      if (!resume) this.runtime.wake('mara', 'opening the café');
      this.started = true;
      el('simulation-start').hidden = true;
      el('simulation-controls').hidden = false;
      this.render();
    } catch (error) {
      this.runtime = undefined;
      this.message(`Could not start the simulation: ${this.errorMessage(error)}`);
    }
  }

  private bind() {
    el('simulation-new').addEventListener('click', async () => {
      if (!this.runtime) { await this.start(false); return; }
      try {
        await this.runtime.reset();
        el('simulation-replay-section').hidden = true;
        this.message('A new café scene is running.');
      } catch (error) { this.message(`Could not start a new scene: ${this.errorMessage(error)}`); }
    });
    el('simulation-resume').addEventListener('click', () => void this.start(true));
    el('simulation-pause').addEventListener('click', () => {
      if (!this.runtime || !this.state) return;
      if (this.state.paused) this.runtime.resumeRun(); else void this.runtime.pause();
    });
    el('simulation-join').addEventListener('click', () => {
      const result = this.runtime?.join();
      this.message(result?.status === 'committed' ? 'You joined the café.' : result?.status === 'rejected' ? result.reason : 'You are already in the café.');
    });
    el<HTMLSelectElement>('simulation-actor').addEventListener('change', event => {
      this.actor = (event.currentTarget as HTMLSelectElement).value as SimulationActorId;
      this.renderInspector(); this.renderActions();
    });
    el<HTMLFormElement>('simulation-speak').addEventListener('submit', event => {
      event.preventDefault();
      const line = el<HTMLInputElement>('simulation-line').value.trim();
      if (!line || !this.runtime || !this.state?.checkpoint.actors.player) return;
      const recipient = el<HTMLSelectElement>('simulation-recipient').value as SimulationActorId | '';
      const result = this.runtime.action('player', { type: 'speak', ...(recipient ? { recipient } : {}) }, line);
      this.message(result.status === 'committed' ? '' : result.status === 'rejected' ? result.reason : 'Join the café before speaking.');
      if (result.status === 'committed') el<HTMLInputElement>('simulation-line').value = '';
    });
    el('simulation-export').addEventListener('click', () => {
      if (this.runtime) this.download(this.runtime.exportAudit(), 'closing-time-simulation-audit-v3.json');
    });
    el<HTMLInputElement>('simulation-import-file').addEventListener('change', async event => {
      const file = (event.currentTarget as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const json = await file.text();
        const audit = new SimulationAudit();
        audit.importJSON(json);
        const checkpoint = audit.replay(JSON.parse(json) as unknown);
        this.renderImported(checkpoint);
        this.message('Read-only replay loaded. The live scene and save are unchanged.');
      } catch (error) { this.message(error instanceof Error ? error.message : 'Replay could not be loaded.'); }
    });
    this.canvas.addEventListener('click', event => {
      if (!this.runtime || !this.state?.checkpoint.actors.player) return;
      const point = this.tileAt(event);
      const result = this.runtime.action('player', { type: 'walk', to: point });
      if (result.status === 'rejected') this.message(result.reason);
    });
    const keys: Record<string, Point> = { ArrowUp: {x:0,y:-1}, w:{x:0,y:-1}, ArrowDown:{x:0,y:1}, s:{x:0,y:1}, ArrowLeft:{x:-1,y:0}, a:{x:-1,y:0}, ArrowRight:{x:1,y:0}, d:{x:1,y:0} };
    document.addEventListener('keydown', event => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const delta = keys[event.key];
      if (!delta || !this.runtime || !this.state?.checkpoint.actors.player || event.repeat) return;
      event.preventDefault(); this.held.set(event.key, delta); this.moveBy(delta);
    });
    document.addEventListener('keyup', event => this.held.delete(event.key));
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('pagehide', () => { this.held.clear(); void this.runtime?.dispose(); });
  }

  private moveBy(delta: Point) {
    const p = this.state?.checkpoint.actors.player;
    if (!p || !this.runtime) return;
    const result = this.runtime.action('player', { type: 'walk', to: { x: p.x + delta.x, y: p.y + delta.y } });
    if (result.status === 'rejected') this.message(result.reason);
  }

  private render() {
    if (!this.runtime || !this.state) return;
    const { checkpoint, activity, paused } = this.state;
    el('simulation-clock').textContent = `${Math.floor(checkpoint.activeTimeMs / 1000)}s${paused ? ' · Paused' : ''}`;
    el<HTMLButtonElement>('simulation-pause').textContent = paused ? 'Resume' : 'Pause';
    const names = CAST.filter(id => checkpoint.actors[id]).map(id => NAMES[id]);
    el('simulation-cast').textContent = names.join(' · ');
    el('simulation-join').hidden = Boolean(checkpoint.actors.player);
    el('simulation-speak').hidden = !checkpoint.actors.player;
    el('simulation-window').textContent = checkpoint.windowOpen ? 'Open' : 'Closed';
    el('simulation-papers').textContent = checkpoint.objects.papers.wetness ? `Wetness ${checkpoint.objects.papers.wetness}` : 'Dry';
    const list = el('simulation-activity');
    list.replaceChildren(...activity.slice(-12).reverse().map(item => { const li = document.createElement('li'); li.textContent = item.text; return li; }));
    this.renderRecipients(); this.renderActions(); this.renderInspector(); this.draw();
    el<HTMLButtonElement>('simulation-export').disabled = this.state.audit.entries.length === 0;
  }

  private renderRecipients() {
    const select = el<HTMLSelectElement>('simulation-recipient');
    const current = select.value;
    const actors = this.state?.checkpoint.actors ?? {};
    select.replaceChildren(new Option('Anyone nearby', ''), ...CAST.filter(id => id !== 'player' && actors[id]).map(id => new Option(NAMES[id], id)));
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  private renderActions() {
    const host = el('simulation-actions');
    const options = this.state?.options.player ?? [];
    const seen = new Set<string>();
    host.replaceChildren(...options.filter(option => option.action.type !== 'walk' && option.action.type !== 'speak').map(option => {
      const action = option.action as Exclude<SimulationAction, { type: 'walk' } | { type: 'speak' }>;
      const label = action.type === 'pickUp' ? `Pick up ${OBJECT_NAMES[action.objectId]}` : action.type === 'putDown' ? `Set ${OBJECT_NAMES[action.objectId]} on ${action.surfaceId}` : action.type === 'wait' ? 'Wait' : `${action.type} window`;
      if (seen.has(label)) return null; seen.add(label);
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => { const result = this.runtime?.action('player', action); if (result?.status === 'rejected') this.message(result.reason); });
      return button;
    }).filter((item): item is HTMLButtonElement => item !== null));
  }

  private renderInspector() {
    const checkpoint = this.state?.checkpoint;
    const select = el<HTMLSelectElement>('simulation-actor');
    const actors = CAST.filter(id => checkpoint?.actors[id]);
    const current = actors.includes(this.actor) ? this.actor : actors[0] ?? 'mara';
    if (select.value !== current) this.actor = current;
    select.replaceChildren(...actors.map(id => new Option(NAMES[id], id)));
    select.value = current;
    const view = this.runtime?.inspector(current);
    el('simulation-inspector').textContent = view ? JSON.stringify(view, null, 2) : 'Start a simulation to inspect a character.';
    const audit = this.state?.audit;
    el('simulation-audit').textContent = audit ? JSON.stringify({ schemaVersion: audit.schemaVersion, runId: audit.runId, entries: audit.entries.slice(-12) }, null, 2) : 'No audit yet.';
  }

  private renderImported(checkpoint: SimulationRoomCheckpoint) {
    el('simulation-replay').textContent = JSON.stringify({ ...checkpoint, readOnly: true }, null, 2);
    el('simulation-replay-section').hidden = false;
  }

  private message(text: string) { el('simulation-feedback').textContent = text; el('simulation-start-feedback').textContent = text; }
  private errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Please try again.'; }
  private tileAt(event: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: Math.floor(((event.clientX - rect.left) * WIDTH / rect.width - LEFT) / CELL), y: Math.floor(((event.clientY - rect.top) * HEIGHT / rect.height - TOP) / CELL) };
  }
  private download(data: string, name: string) {
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private draw(positions = this.state?.renderPositions) {
    const c = this.context; c.clearRect(0, 0, WIDTH, HEIGHT); c.fillStyle = '#222a37'; c.fillRect(0, 0, WIDTH, HEIGHT); c.fillStyle = '#493845'; c.fillRect(34, 33, 700, 510);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) { c.fillStyle = ['#9a6e57','#a1765a','#a77a61','#946754'][((x * 3 + y * 7) % 4)]; c.fillRect(LEFT + x * CELL, TOP + y * CELL, CELL - 1, CELL - 1); }
    const center = (p: Point) => ({x:LEFT+p.x*CELL+CELL/2,y:TOP+p.y*CELL+CELL/2});
    const drawFurniture = (p: Point, label: string) => { const q = center(p); c.fillStyle='#513641'; c.fillRect(q.x-30,q.y-27,60,41); c.fillStyle='#f6e9d4'; c.font='12px monospace'; c.fillText(label,q.x-24,q.y+39); };
    drawFurniture(layout.surfaces.counter,'Counter'); drawFurniture(layout.surfaces.table,'Table');
    const s = this.state?.checkpoint;
    if (s) {
      const w = center(layout.window); c.fillStyle=s.windowOpen?'#87c2d1':'#667b94'; c.fillRect(w.x-27,43,54,27); c.fillStyle='#d6a17a'; c.fillRect(w.x-35,72,70,5); c.fillStyle='#f6e9d4'; c.fillText(s.windowOpen?'Open window':'Closed window',w.x-45,96);
      const surfaceOffsets: Record<string, number> = {};
      for (const [id,obj] of Object.entries(s.objects)) { if ('surface' in obj.location) { const surface = obj.location.surface; const q=center(layout.surfaces[surface]); const index=surfaceOffsets[surface] ?? 0; surfaceOffsets[surface]=index+1; c.fillStyle=id==='papers'?(obj.wetness?'#a8c9d0':'#ffedbc'):id==='towel'?'#be908e':id==='mug1'?'#f1d4a1':'#9bc49d'; c.fillRect(q.x-17+(index%2)*20,q.y-10+Math.floor(index/2)*15,15,12); } }
    }
    const colors: Record<SimulationActorId,string>={mara:'#f4b887',riley:'#bad6a3',jo:'#c5b0df',player:'#b0ddd7'};
    if (positions) for (const id of CAST) { const p=positions[id]; if (!p) continue; const q=center(p); c.fillStyle=colors[id]; c.fillRect(q.x-14,q.y-17,28,35); c.fillStyle='#252429'; c.font='bold 12px monospace'; c.fillText(NAMES[id],q.x-20,q.y+33); }
  }
}
