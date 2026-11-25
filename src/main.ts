import Phaser from 'phaser';
import { playTurn, requestMara, type PlayedTurn } from './planner';
import { actionsFor, createWorld, layout } from './world';
import type { Action, ActorId, Interaction, ObjectId, Point } from './world';
import { TraceLog } from './trace-log';
import { LiveGame } from './live-game';
import type { LiveMaraAction } from './live-mara-protocol';
import { SimulationView } from './simulation/view';
import './style.css';

const cell = 86;
const left = 40;
const top = 39;
const width = 768;
const height = 576;
const labels: Record<ObjectId, string> = {
  papers: 'Papers',
  mug1: 'Cream mug',
  mug2: 'Green mug',
  towel: 'Towel',
};

const liveMode = new URLSearchParams(location.search).get('mode') === 'live';
const simulationMode = new URLSearchParams(location.search).get('mode') === 'simulation';
const heldDirections = new Map<string, [number, number]>();

let world = createWorld();
let liveGame: LiveGame | undefined;
let pending: AbortController | undefined;
let recentTurns: PlayedTurn[] = [];
let sessionId = crypto.randomUUID();
const traceLog = new TraceLog();
let latestRationale = '';
let room: CafeScene | undefined;
let activity: string[] = [];

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modeLink = element<HTMLAnchorElement>('mode-link');
if (simulationMode) {
  element('legacy-app').hidden = true;
  element<HTMLButtonElement>('reset').hidden = true;
  element('page-tagline').textContent = 'An autonomous café scene. Observe the cast or join when you like.';
  modeLink.href = '?mode=live';
  modeLink.textContent = 'Play real-time';
  element('simulation-entry').hidden = true;
  element('simulation-app').hidden = false;
} else if (liveMode) {
  const turnBasedUrl = new URL(location.href);
  turnBasedUrl.searchParams.delete('mode');
  modeLink.href = turnBasedUrl.toString();
  modeLink.textContent = 'Play turn-based';
  element('movement-help').textContent = 'Hold arrow keys or WASD to walk, or tap a floor tile.';
  element('audit-title').textContent = 'Scene audit';
  element('export-traces').textContent = 'Export turn-based traces';
  for (const id of ['live-selected', 'live-outcome', 'export-timeline', 'timeline-status']) element(id).hidden = false;
}

function reportAction(action: Action, actor: ActorId) {
  const entry = describe(action, actor);
  if (entry) activity = [...activity.slice(-7), entry];
}

function resetFeedback() {
  activity = [];
  element<HTMLInputElement>('say').value = '';
  element('feedback').textContent = '';
}

function describe(action: Action, actor: ActorId) {
  const name = actor === 'player' ? 'You' : 'Mara';
  switch (action.type) {
    case 'move': return '';
    case 'pickUp': return `${name} picked up the ${labels[action.objectId].toLowerCase()}.`;
    case 'putDown': return `${name} set the ${labels[action.objectId].toLowerCase()} on the ${action.surfaceId}.`;
    case 'open': return `${name} opened the window.`;
    case 'close': return `${name} closed the window.`;
    case 'speak': return `${name} said, “${action.text}”`;
    case 'wait': return '';
  }
}

async function act(action: Action): Promise<boolean> {
  if (liveGame) {
    element('feedback').textContent = '';
    const result = liveGame.act(action);
    if (!result.ok) element('feedback').textContent = result.reason;
    return result.ok;
  }
  if (pending) return false;
  const request = new AbortController();
  pending = request;
  element('feedback').textContent = '';
  update();

  try {
    const result = await playTurn(world, action, recentTurns, observation => requestMara(observation, request.signal));
    if (pending !== request) return false;
    if (!result.ok) {
      element('feedback').textContent = result.reason;
      return false;
    }
    world = result.world;
    const decision = result.trace.decision;
    latestRationale = decision.rationale;
    traceLog.append({ sessionId, recordedAt: new Date().toISOString(), ...result.trace });
    recentTurns = [...recentTurns.slice(-7), { player: action, mara: decision.action }];
    reportAction(action, 'player');
    reportAction(decision.action, 'mara');
    return true;
  } catch (error) {
    if (pending === request) {
      element('feedback').textContent = error instanceof Error ? error.message : "Mara couldn’t take her turn.";
    }
    return false;
  } finally {
    if (pending === request) {
      pending = undefined;
      update();
    }
  }
}

function actionSummary(action: Action): string {
  if (action.type === 'move') return 'Mara moved one tile.';
  if (action.type === 'wait') return 'Mara waited.';
  return describe(action, 'mara');
}

function interactionLabel(action: Interaction) {
  switch (action.type) {
    case 'close': return 'Close window';
    case 'open': return 'Open window';
    case 'pickUp': return `Pick up ${labels[action.objectId].toLowerCase()}`;
    case 'putDown': return `Set ${labels[action.objectId].toLowerCase()} on ${action.surfaceId}`;
    case 'wait': return 'Wait';
  }
}

function selectedAction(action: LiveMaraAction): string {
  if (action.type === 'walkTo') return `Walk to tile (${action.to.x}, ${action.to.y})`;
  if (action.type === 'speak') return `Say “${action.text}”`;
  if (action.type === 'move') return `Move to tile (${action.to.x}, ${action.to.y})`;
  return interactionLabel(action);
}

function update() {
  const paper = world.objects.papers;
  const exposed = world.windowOpen && 'surface' in paper.location && paper.location.surface === 'table';
  const handIds = (Object.keys(labels) as ObjectId[]).filter(id => {
    const location = world.objects[id].location;
    return 'heldBy' in location && location.heldBy === 'player';
  });
  updateClock();
  element('window').textContent = world.windowOpen ? 'Open' : 'Closed';
  element('papers').textContent = paper.wetness ? `Wetness ${paper.wetness}${exposed ? ' · Exposed' : ''}` : exposed ? 'Dry · Exposed' : 'Dry';
  element('papers').classList.toggle('exposed', exposed);
  element('hands').textContent = handIds.map(id => labels[id]).join(', ') || 'Empty';
  const lastTurn = recentTurns.at(-1);
  element('intent').textContent = (liveGame?.snapshot.paused ? 'Scene paused.' : liveGame?.status)
    ?? (pending ? 'Mara is thinking…' : lastTurn ? actionSummary(lastTurn.mara) : 'Your turn.');
  const rationale = liveGame?.rationale ?? latestRationale;
  element('rationale').textContent = rationale || (liveMode
    ? 'Mara’s stated rationale appears after she chooses an action.'
    : 'Mara’s stated rationale appears after she acts.');
  if (liveGame) {
    element('live-selected').textContent = liveGame.selected ? `Selected: ${selectedAction(liveGame.selected)}` : '';
    element('live-outcome').textContent = liveGame.outcome ? `Outcome: ${liveGame.outcome}` : '';
    element<HTMLButtonElement>('export-timeline').disabled = liveGame.trace.count === 0;
    element('timeline-status').textContent = liveGame.trace.needsExport
      ? 'Browser storage is unavailable or full. Export before closing this tab.'
      : `${liveGame.trace.count} events. Traces include in-game dialogue.`;
  }
  element<HTMLButtonElement>('export-traces').disabled = traceLog.count === 0;
  element('trace-status').textContent = traceLog.needsExport
    ? 'Browser storage is unavailable or full. Export before closing this tab.'
    : `${traceLog.count} recorded turns. Traces include in-game dialogue.`;
  element<HTMLInputElement>('say').disabled = Boolean(pending);
  element<HTMLButtonElement>('say-button').disabled = Boolean(pending);
  const history = element('history');
  history.replaceChildren(...activity.slice().reverse().map(entry => {
    const item = document.createElement('li');
    item.textContent = entry;
    return item;
  }));

  const actions = element('actions');
  const oldFocus = (document.activeElement as HTMLElement | null)?.dataset.action;
  const available = actionsFor(world, 'player').interactions().filter(action => !liveMode || action.type !== 'wait');
  actions.replaceChildren(...available.map(action => {
    const label = interactionLabel(action);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.action = label;
    button.setAttribute('aria-disabled', String(Boolean(pending)));
    button.disabled = Boolean(liveGame?.playerMoving);
    if (action.type === 'wait') button.className = 'quiet';
    button.addEventListener('click', () => act(action));
    return button;
  }));
  if (oldFocus) {
    const buttons = [...actions.querySelectorAll('button')];
    const nextFocus = buttons.find(button => button.dataset.action === oldFocus) ?? buttons.at(-1);
    nextFocus?.focus();
  }
  room?.drawRoom();
}

function updateClock() {
  const time = liveGame?.snapshot;
  const label = time ? `${Math.floor(time.activeMs / 1000)}s${time.paused ? ' · Paused' : ''}` : `Turn ${world.turn}`;
  const timer = element('turn');
  if (timer.textContent !== label) timer.textContent = label;
}

function move(dx: number, dy: number) {
  const { x, y } = world.actors.player.position;
  if (liveGame) liveGame.walk({ x: x + dx, y: y + dy });
  else void act({ type: 'move', to: { x: x + dx, y: y + dy } });
}

class CafeScene extends Phaser.Scene {
  private art!: Phaser.GameObjects.Graphics;
  private signs!: Phaser.GameObjects.Container;
  private actorArt!: Phaser.GameObjects.Graphics;
  private actorLabels!: Record<ActorId, Phaser.GameObjects.Text>;
  private hover: Point | undefined;

  create() {
    this.game.canvas.setAttribute('aria-label', 'Top-down café room');
    this.art = this.add.graphics();
    this.signs = this.add.container();
    this.actorArt = this.add.graphics();
    this.actorLabels = {
      player: this.createLabel('You', '#b0ddd7'),
      mara: this.createLabel('Mara', '#f4b887'),
    };
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const tile = this.tileAt(pointer);
      if (tile.x !== this.hover?.x || tile.y !== this.hover?.y) {
        this.hover = tile;
        this.drawRoom();
      }
    });
    this.input.on('gameout', () => { this.hover = undefined; this.drawRoom(); });
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.leftButtonDown() && !pointer.wasTouch) return;
      const to = this.tileAt(pointer);
      if (liveGame) {
        heldDirections.clear();
        const result = liveGame.walk(to);
        element('feedback').textContent = result.ok ? '' : result.reason;
      } else void act({ type: 'move', to });
    });
    room = this;
    if (liveMode) {
      liveGame = new LiveGame({
        onChange: () => {
          if (!liveGame) return;
          world = liveGame.snapshot.world;
          update();
        },
        onAction: reportAction,
      });
      world = liveGame.snapshot.world;
      liveGame.setPaused(document.hidden);
    }
    update();
  }

  update() {
    if (!liveGame) return;
    liveGame.frame();
    const direction = [...heldDirections.values()].at(-1);
    if (direction && !liveGame.playerMoving && !liveGame.snapshot.paused) {
      const { x, y } = world.actors.player.position;
      if (liveGame.canWalk({ x: x + direction[0], y: y + direction[1] })) move(...direction);
    }
    updateClock();
    this.drawActors();
  }

  private tileAt(pointer: Phaser.Input.Pointer): Point {
    return { x: Math.floor((pointer.x - left) / cell), y: Math.floor((pointer.y - top) / cell) };
  }

  private center(point: Point) {
    return { x: left + point.x * cell + cell / 2, y: top + point.y * cell + cell / 2 };
  }

  private rect(x: number, y: number, w: number, h: number, color: number, alpha = 1, art = this.art) {
    art.fillStyle(color, alpha).fillRect(x, y, w, h);
  }

  private createLabel(text: string, color = '#f4ddbb', size = 13) {
    return this.add.text(0, 0, text, {
      color, fontFamily: 'monospace', fontSize: size, fontStyle: 'bold',
      backgroundColor: '#252429', padding: { x: 5, y: 3 },
    }).setOrigin(.5);
  }

  private textAt(text: string, x: number, y: number, color?: string, size?: number) {
    this.signs.add(this.createLabel(text, color, size).setPosition(x, y));
  }

  private drawFurniture(point: Point, label: string, color: number) {
    const { x, y } = this.center(point);
    this.rect(x - 36, y - 17, 72, 47, 0x473435, .35);
    this.rect(x - 33, y - 24, 66, 48, 0x362730);
    this.rect(x - 30, y - 27, 60, 41, 0x513641);
    this.rect(x - 28, y - 24, 56, 32, color);
    this.rect(x - 23, y - 20, 47, 2, 0xf8c491, .38);
    this.textAt(label, x, y + 29);
  }

  private drawObject(id: ObjectId, x: number, y: number, art = this.art) {
    const rect = (x: number, y: number, w: number, h: number, color: number) => this.rect(x, y, w, h, color, 1, art);
    switch (id) {
      case 'mug1':
      case 'mug2': {
        const color = id === 'mug1' ? 0xf1d4a1 : 0x9bc49d;
        rect(x - 7, y - 6, 13, 13, color);
        rect(x + 5, y - 3, 5, 7, color);
        rect(x + 6, y - 1, 2, 3, 0x514048);
        rect(x - 5, y - 4, 9, 3, 0x684633);
        break;
      }
      case 'papers':
        rect(x - 10, y - 5, 19, 12, 0x916d5e);
        rect(x - 9, y - 8, 17, 12, world.objects.papers.wetness ? 0xa8c9d0 : 0xffedbc);
        rect(x - 5, y - 5, 9, 1, 0x7f7772);
        rect(x - 5, y - 2, 6, 1, 0x7f7772);
        break;
      case 'towel':
        rect(x - 10, y - 6, 20, 12, 0xbe908e);
        rect(x - 10, y - 3, 20, 2, 0xe2b7a5);
        rect(x - 10, y + 2, 20, 2, 0xe2b7a5);
        break;
    }
  }

  private drawActor(actor: ActorId) {
    const {x, y} = this.center(liveGame?.pose(actor) ?? world.actors[actor].position);
    const rect = (x: number, y: number, w: number, h: number, color: number) => this.rect(x, y, w, h, color, 1, this.actorArt);
    const main = actor === 'player' ? 0xb0ddd7 : 0xf4b887;
    const trim = actor === 'player' ? 0x367a77 : 0x9f6048;
    this.actorArt.fillStyle(0x352936, .31).fillEllipse(x, y + 18, 44, 16);
    rect(x - 11, y + 10, 9, 13, 0x34363d);
    rect(x + 2, y + 10, 9, 13, 0x34363d);
    rect(x - 15, y - 6, 30, 21, trim);
    rect(x - 11, y - 4, 22, 17, main);
    rect(x - 10, y - 22, 20, 17, 0x49343e);
    rect(x - 8, y - 17, 16, 11, actor === 'player' ? 0xd2a177 : 0xe7aa81);
    rect(x - 5, y - 12, 2, 2, 0x342b31);
    rect(x + 3, y - 12, 2, 2, 0x342b31);
    const held = (Object.keys(labels) as ObjectId[]).filter(id => {
      const item = world.objects[id].location;
      return 'heldBy' in item && item.heldBy === actor;
    });
    held.forEach((id, index) => this.drawObject(id, x + (index ? 21 : -21), y + 4, this.actorArt));
    this.actorLabels[actor].setPosition(x, y + 32);
  }

  private drawActors() {
    this.actorArt.clear();
    this.drawActor('player');
    this.drawActor('mara');
  }

  drawRoom() {
    this.art.clear();
    this.signs.removeAll(true);
    this.rect(0, 0, width, height, 0x222a37);
    this.rect(24, 23, 720, 530, 0x353448);
    this.rect(34, 33, 700, 510, 0x493845);

    const moves = liveGame?.reachable() ?? actionsFor(world, 'player').moves().map(move => move.to);
    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) {
        const bx = left + x * cell;
        const by = top + y * cell;
        const boards = [0x9a6e57, 0xa1765a, 0xa77a61, 0x946754, 0xab7f61];
        for (let plank = 0; plank < 4; plank++) {
          const py = by + plank * 21;
          this.rect(bx, py, cell - 1, 21, boards[(x * 3 + y * 7 + plank * 2) % boards.length]);
          this.rect(bx + 8 + (x * 11 + y * 17 + plank * 13) % 45, py + 8, 21, 1, 0x795644, .42);
          this.rect(bx, py + 20, cell - 1, 1, 0x765043, .53);
        }
        this.rect(bx, by + 84, cell - 1, 2, 0x785342, .65);
        const adjacent = moves.some(to => to.x === x && to.y === y);
        if (adjacent) {
          if (!liveMode || (this.hover?.x === x && this.hover?.y === y)) {
            this.art.lineStyle(1, 0xe4d4b8, .48).strokeRect(bx + 3, by + 3, cell - 7, cell - 7);
          }
          if (this.hover?.x === x && this.hover.y === y) this.rect(bx + 4, by + 4, cell - 9, cell - 9, 0xffe5ba, .22);
        }
      }
    }

    const window = this.center(layout.window);
    if (world.windowOpen) {
      this.art.fillStyle(0x789fab, .23).fillTriangle(window.x - 32, window.y - 12, window.x + 118, window.y + 106, window.x + 21, window.y + 113);
      for (let i = 0; i < 14; i++) {
        const x = window.x - 18 + (i * 23) % 115;
        const y = window.y - 7 + (i * 17) % 93;
        this.art.lineStyle(2, 0xcbe6ee, .6).lineBetween(x, y, x + 7, y + 11);
      }
    }
    this.rect(window.x - 32, 39, 64, 38, 0x382c3d);
    this.rect(window.x - 27, 43, 54, 27, 0x688b9e);
    this.rect(window.x - 25, 45, 50, 23, 0x354d68);
    for (let i = 0; i < 7; i++) {
      this.art.lineStyle(1, 0x8bb9d2, .7).lineBetween(window.x - 22 + i * 7, 48 + (i % 2) * 5, window.x - 26 + i * 7, 58 + (i % 2) * 5);
    }
    if (world.windowOpen) this.rect(window.x - 29, 42, 7, 30, 0xc39875);
    else {
      this.rect(window.x - 2, 43, 4, 27, 0xca9d80);
      this.rect(window.x - 26, 54, 52, 3, 0xca9d80);
    }
    this.rect(window.x - 35, 72, 70, 5, 0xd6a17a);
    this.textAt(world.windowOpen ? 'Open window' : 'Closed window', window.x, 93, '#dbedf4');

    this.drawFurniture(layout.surfaces.counter, 'Counter', 0xb58369);
    this.drawFurniture(layout.surfaces.table, 'Table', 0xc08c6d);
    for (const surface of ['counter', 'table'] as const) {
      const objects = (Object.keys(labels) as ObjectId[]).filter(id => {
        const location = world.objects[id].location;
        return 'surface' in location && location.surface === surface;
      });
      const { x, y } = this.center(layout.surfaces[surface]);
      objects.forEach((id, index) => this.drawObject(id, x + (index % 2 ? 13 : -13), y - 15 + Math.floor(index / 2) * 15));
    }
    this.drawActors();
  }
}

if (!simulationMode) new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'room',
  width,
  height,
  backgroundColor: '#222a37',
  pixelArt: true,
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: CafeScene,
});

const keys: Record<string, [number, number]> = {
  arrowup: [0, -1], w: [0, -1],
  arrowdown: [0, 1], s: [0, 1],
  arrowleft: [-1, 0], a: [-1, 0],
  arrowright: [1, 0], d: [1, 0],
};
document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const direction = keys[event.key.toLowerCase()];
  if (direction) {
    event.preventDefault();
    if (liveGame) {
      heldDirections.set(event.key.toLowerCase(), direction);
      if (liveGame.playerMoving) liveGame.interruptPlayerRoute();
      else move(...direction);
    } else move(...direction);
  }
});
document.addEventListener('keyup', event => heldDirections.delete(event.key.toLowerCase()));
window.addEventListener('blur', () => heldDirections.clear());
document.addEventListener('focusin', event => {
  if (event.target instanceof HTMLInputElement) heldDirections.clear();
});
document.addEventListener('visibilitychange', () => {
  heldDirections.clear();
  liveGame?.setPaused(document.hidden);
});
window.addEventListener('pagehide', () => {
  heldDirections.clear();
  pending?.abort();
  liveGame?.dispose();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});
element<HTMLFormElement>('speak').addEventListener('submit', async event => {
  event.preventDefault();
  const input = element<HTMLInputElement>('say');
  const line = input.value.trim();
  if (line && await act({ type: 'speak', text: line })) input.value = '';
});
function download(data: string, name: string) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
element('export-traces').addEventListener('click', () => {
  download(traceLog.toJSON(), 'closing-time-turn-traces.json');
});
element('export-timeline').addEventListener('click', () => {
  if (liveGame) download(liveGame.trace.toJSON(), 'closing-time-timeline.json');
});
element('reset').addEventListener('click', () => {
  heldDirections.clear();
  resetFeedback();
  if (liveGame) {
    liveGame.restart();
    return;
  }
  world = createWorld();
  pending?.abort();
  pending = undefined;
  recentTurns = [];
  sessionId = crypto.randomUUID();
  latestRationale = '';
  update();
});
if (simulationMode) {
  const simulation = new SimulationView();
  element('simulation-new-scene').addEventListener('click', () => void simulation.start(false));
}
update();
