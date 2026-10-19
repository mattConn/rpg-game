import { editorDungeonSeed } from "../shared/editor-seed.js";
import { ARENA_X, ARENA_Y, EDITOR_TILE_CELLS, TILE_PX } from "../shared/tactics.js";

type TileType = "void" | "floor" | "grass" | "wall" | "doorway";
type EntityType = "player" | "hellhound" | "bat" | "spider" | "gargoyle" | "snake"
  | "purple-gem" | "pressure-plate" | "portal-exit" | "torch" | "boulder" | "angel-statue"
  | "gate" | "gate-button" | "rock-1" | "rock-2" | "rock-3" | "rock-4"
  | "rock-5" | "rock-6" | "rock-7" | "rock-8";
type ToolType = TileType | EntityType | "erase";

interface PlacedEntity { id: string; type: EntityType; x: number; y: number; facing: number; label?: string; destinationSeed?: number }
interface LevelData {
  version: 1;
  name: string;
  width: number;
  height: number;
  tiles: Array<{ x: number; y: number; type: Exclude<TileType, "void"> }>;
  entities: PlacedEntity[];
}
interface ProjectData {
  version: 1;
  activeRoom: string;
  rooms: Record<string, LevelData>;
}

interface ToolDefinition { type: ToolType; label: string; icon: string; group: "tile" | "entity" | "object" | "scenery" }

const tools: ToolDefinition[] = [
  { type: "floor", label: "Stone tile", icon: "◇", group: "tile" },
  { type: "grass", label: "Grass tile", icon: "♧", group: "tile" },
  { type: "wall", label: "Wall block", icon: "◆", group: "tile" },
  { type: "erase", label: "Delete", icon: "⌫", group: "tile" },
  { type: "player", label: "Player spawn", icon: "▲", group: "entity" },
  { type: "hellhound", label: "Hellhound spawn", icon: "◆", group: "entity" },
  { type: "bat", label: "Bat spawn", icon: "⌁", group: "entity" },
  { type: "spider", label: "Spider spawn", icon: "✣", group: "entity" },
  { type: "snake", label: "Snake spawn", icon: "≈", group: "entity" },
  { type: "gate", label: "Gate", icon: "▥", group: "object" },
  { type: "gate-button", label: "Gate button", icon: "◉", group: "object" },
  { type: "portal-exit", label: "Exit hole", icon: "▣", group: "object" },
  { type: "gargoyle", label: "Gargoyle statue", icon: "♜", group: "scenery" },
  ...Array.from({ length: 8 }, (_, index) => ({
    type: `rock-${index + 1}` as EntityType,
    label: `${index < 4 ? "Small" : "Large"} rock ${index % 4 + 1}`,
    icon: ["◒", "◓", "◑", "◐"][index % 4]!,
    group: "scenery" as const,
  })),
];

const entityTypes = new Set<EntityType>(tools.filter((tool) => tool.group !== "tile").map((tool) => tool.type as EntityType));
const canvas = document.querySelector<HTMLCanvasElement>("#editor")!;
const context = canvas.getContext("2d")!;
const gamePreview = document.querySelector<HTMLIFrameElement>("#game-preview")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const levelName = document.querySelector<HTMLInputElement>("#level-name")!;
const zoomInput = document.querySelector<HTMLInputElement>("#zoom")!;
const status = document.querySelector<HTMLElement>("#status")!;
const coords = document.querySelector<HTMLElement>("#coords")!;
const counts = document.querySelector<HTMLElement>("#counts")!;
const seedLabel = document.querySelector<HTMLElement>("#level-seed")!;
const rotationLabel = document.querySelector<HTMLElement>("#rotation")!;
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;
const linkLabel = document.querySelector<HTMLInputElement>("#link-label")!;
const entityFacing = document.querySelector<HTMLSelectElement>("#entity-facing")!;
const roomLabel = document.querySelector<HTMLInputElement>("#room-label")!;
const roomSelect = document.querySelector<HTMLSelectElement>("#room-select")!;
const validLinkLabel = (value: string) => /^[0-9A-Za-z]$/.test(value);
const projectStorageKey = "rpg-dungeon-editor-project";
const editorAssets = new Map<string, HTMLImageElement>();
for (const [name, source] of Object.entries({
  floor: "/graphics/med/textures/dungeon-floor-stone.png",
  wall: "/graphics/med/textures/dungeon-wall-stone.png",
  gate: "/textures/gate-weathered-iron.png",
  player: "/sprites/player.png",
  spider: "/sprites/spider.png",
  gargoyle: "/sprites/gargoyle.png",
  boulder: "/sprites/boulder.png",
})) {
  const image = new Image(); image.src = source; image.addEventListener("load", () => draw()); editorAssets.set(name, image);
}
const grassTexture = document.createElement("canvas");
grassTexture.width = grassTexture.height = 64;
{
  const grass = grassTexture.getContext("2d")!; let state = 0x6a55;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  grass.fillStyle = "#35472a"; grass.fillRect(0, 0, 64, 64);
  for (let index = 0; index < 2400; index++) {
    const x = Math.floor(random() * 64), y = Math.floor(random() * 64);
    grass.fillStyle = ["#293820", "#465834", "#55643b", "#687047", "#3a4b29", "#49472f"][Math.floor(random() * 6)]!;
    grass.fillRect(x, y, 1, 1 + Math.floor(random() * 3));
  }
}

const width = 100;
const height = 100;
let cellSize = 12;
let viewRotation = 0;
let tiles: TileType[] = [];
let entities: PlacedEntity[] = [];
let selectedTool: ToolType = "floor";
let drawing = false;
let panning = false;
let rotating = false;
let rotationDragX = 0;
let rotationPressX = 0;
let rotationPressY = 0;
let rotationDragMoved = false;
let panX = 0;
let panY = 0;
let panPointerX = 0;
let panPointerY = 0;
let changedDuringGesture = false;
let draggedEntityId: string | null = null;
let sequence = 1;
let history: string[] = [];
let historyIndex = -1;
let activeRoomLabel = "A";
let rooms = new Map<string, LevelData>();
interface GameEditorBridge {
  groundAt(u: number, v: number): { x: number; y: number } | null;
  project(x: number, y: number, height?: number): { x: number; y: number } | null;
  projectPlayer(x: number, y: number): { x: number; y: number } | null;
  look(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoom(delta: number): void;
  reset(): void;
  fullMap(): void;
  updateLevel(level: LevelData): void;
}
const previewBridge = () => (gamePreview.contentWindow as (Window & { rpgEditorBridge?: GameEditorBridge }) | null)?.rpgEditorBridge;
const editorTilePixels = EDITOR_TILE_CELLS * TILE_PX;
let previewRefreshTimer = 0;
async function refreshGamePreview(): Promise<void> {
  const level = serialize();
  if (!level.entities.some((entity) => entity.type === "player")) return;
  const bridge = previewBridge();
  if (bridge) {
    bridge.updateLevel(level);
    draw();
    return;
  }
  try {
    const response = await fetch("/api/editor-level", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(level) });
    if (!response.ok) return;
    const result = await response.json() as { id: string; seed: number };
    localStorage.setItem(`rpg-editor-level:${result.id}`, JSON.stringify(level));
    gamePreview.src = `/?seed=${result.seed}&editor=${result.id}&editing=1`;
  } catch { /* The grid remains editable while the preview server is unavailable. */ }
}
function schedulePreviewRefresh(): void {
  window.clearTimeout(previewRefreshTimer);
  previewRefreshTimer = window.setTimeout(() => { void refreshGamePreview(); }, 120);
}

const tileIndex = (x: number, y: number) => y * width + x;
const tileAt = (x: number, y: number) => tiles[tileIndex(x, y)] ?? "void";
const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

function blankLevel(): void {
  tiles = Array.from({ length: width * height }, () => "void" as TileType);
  entities = [];
}

function cloneLevel(level: LevelData): LevelData { return JSON.parse(JSON.stringify(level)) as LevelData; }

function projectData(): ProjectData {
  return { version: 1, activeRoom: activeRoomLabel, rooms: Object.fromEntries([...rooms].map(([label, level]) => [label, cloneLevel(level)])) };
}

function refreshRoomSelect(): void {
  roomSelect.replaceChildren(...[...rooms.keys()].sort().map((label) => {
    const option = document.createElement("option"); option.value = label; option.textContent = label; return option;
  }));
  roomSelect.value = activeRoomLabel;
  roomLabel.value = activeRoomLabel;
}

function storeCurrentRoom(label = activeRoomLabel): boolean {
  if (!validLinkLabel(label)) { status.textContent = "Room label must be one letter or number"; roomLabel.focus(); return false; }
  const previous = activeRoomLabel;
  activeRoomLabel = label;
  if (previous !== label) rooms.delete(previous);
  rooms.set(label, cloneLevel(serialize()));
  refreshRoomSelect();
  return true;
}

async function saveProject(): Promise<boolean> {
  if (!storeCurrentRoom(roomLabel.value)) return false;
  const project = projectData();
  localStorage.setItem(projectStorageKey, JSON.stringify(project));
  // Keep the original key updated so older editor builds can still recover the active room.
  localStorage.setItem("rpg-dungeon-editor-level", snapshot());
  try {
    const response = await fetch("/api/editor-project", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(project),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    return true;
  } catch (error) {
    status.textContent = `Saved in browser only; disk save failed: ${error instanceof Error ? error.message : error}`;
    return false;
  }
}

function resetRoomHistory(): void {
  history = []; historyIndex = -1; recordHistory();
}

function openRoom(label: string): void {
  const room = rooms.get(label); if (!room) return;
  activeRoomLabel = label; roomLabel.value = label; roomSelect.value = label;
  applyLevel(cloneLevel(room), false); resetRoomHistory();
}

function applyProject(raw: Partial<ProjectData>): void {
  if (!raw.rooms || typeof raw.rooms !== "object") throw new Error("Invalid room project");
  rooms = new Map(Object.entries(raw.rooms).filter(([label]) => validLinkLabel(label)).map(([label, level]) => [label, normalizeLevel(level)]));
  const target = raw.activeRoom && rooms.has(raw.activeRoom) ? raw.activeRoom : rooms.keys().next().value;
  if (!target) throw new Error("The project has no rooms");
  refreshRoomSelect(); openRoom(target);
}

function serialize(): LevelData {
  const serializedTiles: LevelData["tiles"] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const type = tileAt(x, y);
    if (type !== "void") serializedTiles.push({ x, y, type });
  }
  return { version: 1, name: levelName.value.trim() || "Untitled Dungeon", width, height, tiles: serializedTiles, entities: entities.map((entity) => ({ ...entity })) };
}

function snapshot(): string { return JSON.stringify(serialize()); }

function recordHistory(): void {
  const value = snapshot();
  if (history[historyIndex] === value) return;
  history.splice(historyIndex + 1);
  history.push(value);
  if (history.length > 80) history.shift();
  historyIndex = history.length - 1;
  updateButtons();
  schedulePreviewRefresh();
}

function normalizeLevel(value: unknown): LevelData {
  if (!value || typeof value !== "object") throw new Error("The JSON does not contain a level.");
  const raw = value as Partial<LevelData>;
  if (!Array.isArray(raw.tiles) || !Array.isArray(raw.entities)) {
    throw new Error("Invalid level dimensions, tiles, or entities.");
  }
  const validTiles = new Set<TileType>(["floor", "grass", "wall", "doorway"]);
  const nextTiles = raw.tiles.filter((tile): tile is LevelData["tiles"][number] =>
    !!tile && Number.isInteger(tile.x) && Number.isInteger(tile.y) && validTiles.has(tile.type));
  const nextEntities = raw.entities.filter((entity): entity is PlacedEntity =>
    !!entity && typeof entity.id === "string" && entityTypes.has(entity.type)
    && Number.isInteger(entity.x) && Number.isInteger(entity.y)
    && ((entity.type !== "gate" && entity.type !== "gate-button" && entity.type !== "portal-exit") || validLinkLabel(entity.label ?? "")));
  return { version: 1, name: typeof raw.name === "string" ? raw.name : "Imported Dungeon", width, height, tiles: nextTiles, entities: nextEntities };
}

function applyLevel(level: LevelData, addHistory = true): void {
  levelName.value = level.name;
  tiles = Array.from({ length: width * height }, () => "void" as TileType);
  for (const tile of level.tiles) if (inside(tile.x, tile.y)) tiles[tileIndex(tile.x, tile.y)] = tile.type;
  entities = level.entities.filter((entity) => inside(entity.x, entity.y)).map((entity) => ({ ...entity }));
  sequence = Math.max(sequence, ...entities.map((entity) => Number(entity.id.split("-").at(-1)) || 0)) + 1;
  resizeCanvas();
  if (addHistory) recordHistory();
}

function updateButtons(): void {
  (document.querySelector<HTMLButtonElement>("#undo")!).disabled = historyIndex <= 0;
  (document.querySelector<HTMLButtonElement>("#redo")!).disabled = historyIndex >= history.length - 1;
}

function restoreHistory(index: number): void {
  if (!history[index]) return;
  historyIndex = index;
  applyLevel(normalizeLevel(JSON.parse(history[index]!)), false);
  updateButtons();
}

function resizeCanvas(): void {
  const rect = viewport.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width));
  canvas.height = Math.max(1, Math.round(rect.height));
  canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
  context.setTransform(1, 0, 0, 1, 0, 0);
  draw();
}

function applyPan(): void {
  // The live game renderer owns camera translation.
}

const tileWidth = () => cellSize * 2;
const tileHeight = () => cellSize;
const wallHeight = () => cellSize * 1.55;
const canvasPadding = () => Math.max(40, cellSize * 2.4);
const canvasDimensions = () => ({
  width: (width + height) * tileWidth() / 2 + canvasPadding() * 2,
  height: (width + height) * tileHeight() / 2 + canvasPadding() * 2 + wallHeight(),
});
const gridOrigin = () => ({ x: canvasDimensions().width / 2, y: canvasDimensions().height / 2 + wallHeight() / 2 });
const rotateGridPoint = (x: number, y: number) => {
  const dx = x - width / 2, dy = y - height / 2;
  const cosine = Math.cos(viewRotation), sine = Math.sin(viewRotation);
  return { x: dx * cosine - dy * sine, y: dx * sine + dy * cosine };
};
const unrotateGridPoint = (x: number, y: number) => {
  const cosine = Math.cos(viewRotation), sine = Math.sin(viewRotation);
  return { x: x * cosine + y * sine + width / 2, y: -x * sine + y * cosine + height / 2 };
};
let drawOrderRotation = Number.NaN;
let drawOrder: Array<{ x: number; y: number }> = [];
function cellsInDrawOrder(): Array<{ x: number; y: number }> {
  if (drawOrderRotation === viewRotation) return drawOrder;
  const cells = Array.from({ length: width * height }, (_, index) => ({ x: index % width, y: Math.floor(index / width) }));
  cells.sort((a, b) => {
    const ar = rotateGridPoint(a.x + .5, a.y + .5), br = rotateGridPoint(b.x + .5, b.y + .5);
    return ar.x + ar.y - br.x - br.y;
  });
  drawOrderRotation = viewRotation; drawOrder = cells; return drawOrder;
}
const gridPoint = (x: number, y: number) => {
  const origin = gridOrigin();
  const rotated = rotateGridPoint(x, y);
  return { x: origin.x + (rotated.x - rotated.y) * tileWidth() / 2, y: origin.y + (rotated.x + rotated.y) * tileHeight() / 2 };
};
const diamond = (x: number, y: number, lift = 0) => {
  return [gridPoint(x, y), gridPoint(x + 1, y), gridPoint(x + 1, y + 1), gridPoint(x, y + 1)]
    .map((point) => ({ x: point.x, y: point.y - lift }));
};
function pathPolygon(points: Array<{ x: number; y: number }>): void {
  context.beginPath(); context.moveTo(points[0]!.x, points[0]!.y);
  for (let index = 1; index < points.length; index++) context.lineTo(points[index]!.x, points[index]!.y);
  context.closePath();
}
function loadedAsset(name: string): HTMLImageElement | undefined {
  const image = editorAssets.get(name); return image?.complete && image.naturalWidth > 0 ? image : undefined;
}
/** Map an image onto an isometric parallelogram while retaining the grid outline. */
function drawMappedImage(image: HTMLImageElement | HTMLCanvasElement, points: Array<{ x: number; y: number }>, shade = ""): void {
  const size = image instanceof HTMLImageElement
    ? { width: image.naturalWidth, height: image.naturalHeight }
    : { width: image.width, height: image.height };
  const [origin, across, , down] = points;
  if (!origin || !across || !down || !size.width || !size.height) return;
  context.save(); pathPolygon(points); context.clip();
  context.setTransform((across.x - origin.x) / size.width, (across.y - origin.y) / size.width,
    (down.x - origin.x) / size.height, (down.y - origin.y) / size.height, origin.x, origin.y);
  context.drawImage(image, 0, 0);
  if (shade) { context.fillStyle = shade; context.fillRect(0, 0, size.width, size.height); }
  context.restore();
}
function spriteDirection(facing: number): number {
  const cameraBearing = Math.PI * .75 - viewRotation;
  return ((Math.round((cameraBearing - facing) / (Math.PI / 4)) % 8) + 8) % 8;
}
function drawSprite(name: "player" | "spider" | "gargoyle" | "boulder", centre: { x: number; y: number }, direction: number, scale = 1): boolean {
  const image = loadedAsset(name); if (!image) return false;
  const frameSize = image.naturalWidth / 8;
  const size = tileWidth() * scale;
  context.drawImage(image, direction * frameSize, 0, frameSize, frameSize,
    centre.x - size / 2, centre.y - size * .86, size, size);
  return true;
}
function pointInPolygon(px: number, py: number, points: Array<{ x: number; y: number }>): boolean {
  let insidePolygon = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!, b = points[previous]!;
    if ((a.y > py) !== (b.y > py) && px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x) insidePolygon = !insidePolygon;
  }
  return insidePolygon;
}
function drawTile(x: number, y: number, type: TileType): void {
  const base = diamond(x, y);
  if (type === "wall") {
    const top = diamond(x, y, wallHeight());
    const visibleEdges = [0, 1, 2, 3].sort((a, b) => {
      const aNext = (a + 1) % 4, bNext = (b + 1) % 4;
      return (base[b]!.y + base[bNext]!.y) - (base[a]!.y + base[aNext]!.y);
    }).slice(0, 2);
    for (const [face, edge] of visibleEdges.entries()) {
      const next = (edge + 1) % 4;
      context.fillStyle = face ? "#343c48" : "#242a34";
      const side = [top[edge]!, top[next]!, base[next]!, base[edge]!];
      pathPolygon(side); context.fill();
      const wall = loadedAsset("wall"); if (wall) drawMappedImage(wall, side, face ? "rgba(0,0,0,.2)" : "rgba(0,0,0,.38)");
    }
    context.fillStyle = "#596372"; pathPolygon(top); context.fill();
    const floor = loadedAsset("floor"); if (floor) drawMappedImage(floor, top, "rgba(255,255,255,.08)");
    context.strokeStyle = "#737f90"; pathPolygon(top); context.stroke();
    context.strokeStyle = "rgba(10,12,16,.72)";
    for (const side of [[top[3]!, base[3]!], [top[2]!, base[2]!], [top[1]!, base[1]!]] as const) {
      context.beginPath(); context.moveTo(side[0].x, side[0].y); context.lineTo(side[1].x, side[1].y); context.stroke();
    }
    return;
  }
  context.fillStyle = type === "grass"
    ? ((x + y) % 2 ? "#334827" : "#415934")
    : type === "floor" || type === "doorway"
      ? ((x + y) % 2 ? "#323943" : "#3a424d")
      : ((x + y) % 2 ? "#080a0e" : "#0d1015");
  pathPolygon(base); context.fill();
  if (type === "grass") drawMappedImage(grassTexture, base);
  else if (type === "floor" || type === "doorway") {
    const floor = loadedAsset("floor"); if (floor) drawMappedImage(floor, base);
  }
  context.strokeStyle = type === "grass" ? "#61744c"
    : type === "floor" || type === "doorway" ? "#596474"
      : type === "void" ? "rgba(104,119,142,.22)" : "#29303a";
  pathPolygon(base); context.stroke();
}
function drawEntity(entity: PlacedEntity): void {
  const centre = gridPoint(entity.x + .5, entity.y + .5);
  if (/^rock-[1-8]$/.test(entity.type)) {
    const variant = Number(entity.type.slice("rock-".length)) - 1;
    const scale = variant < 4 ? .62 : .88;
    const direction = ((variant - Math.round(viewRotation / (Math.PI / 4))) % 8 + 8) % 8;
    if (drawSprite("boulder", centre, direction, scale * 1.3)) return;
    const angle = variant * Math.PI / 4 - viewRotation;
    context.save(); context.translate(centre.x, centre.y - cellSize * .16); context.rotate(angle);
    context.fillStyle = variant < 4 ? "#646b72" : "#737b83"; context.strokeStyle = "#a8b0b7"; context.lineWidth = Math.max(1, cellSize * .08);
    context.beginPath();
    context.moveTo(-cellSize * scale, cellSize * .2); context.lineTo(-cellSize * scale * .58, -cellSize * scale * .52);
    context.lineTo(cellSize * scale * .28, -cellSize * scale * .72); context.lineTo(cellSize * scale, -cellSize * .02);
    context.lineTo(cellSize * scale * .62, cellSize * .42); context.closePath(); context.fill(); context.stroke();
    context.restore(); return;
  }
  if (entity.type === "gate-button") {
    const base = diamond(entity.x, entity.y, cellSize * .08);
    context.save();
    context.fillStyle = "#594719"; context.strokeStyle = "#e3bd44"; context.lineWidth = Math.max(1, cellSize * .12);
    context.beginPath(); context.ellipse(centre.x, centre.y - cellSize * .08, cellSize * .55, cellSize * .27, 0, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#fff3b2"; context.font = `700 ${Math.max(10, cellSize * .85)}px ui-monospace`; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(entity.label ?? "?", centre.x, centre.y - cellSize * .13);
    context.restore(); void base; return;
  }
  if (entity.type === "gate") {
    const gate = loadedAsset("gate");
    if (gate) {
      const gateHeight = wallHeight() * 1.75, gateWidth = gateHeight * gate.naturalWidth / gate.naturalHeight;
      context.drawImage(gate, centre.x - gateWidth / 2, centre.y - gateHeight, gateWidth, gateHeight);
    }
    context.save(); context.translate(centre.x, centre.y - cellSize * .6);
    if (!gate) {
      context.strokeStyle = "#b6c0cc"; context.lineWidth = Math.max(2, cellSize * .16);
      for (let offset = -0.65; offset <= .65; offset += .325) { context.beginPath(); context.moveTo(offset * cellSize, -cellSize * .72); context.lineTo(offset * cellSize, cellSize * .65); context.stroke(); }
      context.beginPath(); context.moveTo(-cellSize * .78, -cellSize * .65); context.lineTo(cellSize * .78, -cellSize * .65); context.moveTo(-cellSize * .78, cellSize * .58); context.lineTo(cellSize * .78, cellSize * .58); context.stroke();
    }
    context.fillStyle = "#11151b"; context.strokeStyle = "#e3bd44"; context.lineWidth = 1; context.fillRect(-cellSize * .48, -cellSize * .3, cellSize * .96, cellSize * .75); context.strokeRect(-cellSize * .48, -cellSize * .3, cellSize * .96, cellSize * .75);
    context.fillStyle = "#fff3b2"; context.font = `700 ${Math.max(10, cellSize * .82)}px ui-monospace`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(entity.label ?? "?", 0, cellSize * .08);
    context.restore(); return;
  }
  if (entity.type === "portal-exit") {
    const opening = diamond(entity.x, entity.y, cellSize * .04);
    context.save(); context.fillStyle = "#020306"; context.strokeStyle = "#8b6fe8"; context.lineWidth = Math.max(1, cellSize * .12);
    pathPolygon(opening); context.fill(); context.stroke();
    context.fillStyle = "#d9ceff"; context.font = `700 ${Math.max(10, cellSize * .9)}px ui-monospace`; context.textAlign = "center"; context.textBaseline = "middle";
    context.fillText(entity.label ?? "?", centre.x, centre.y - cellSize * .08); context.restore(); return;
  }
  if (entity.type === "spider") {
    if (drawSprite("spider", centre, spriteDirection(entity.facing), 1.7)) return;
    context.save(); context.translate(centre.x, centre.y - cellSize * .28);
    context.strokeStyle = "#d9b8ff"; context.fillStyle = "#6d3f91"; context.lineWidth = Math.max(1.5, cellSize * .11);
    context.lineCap = "round";
    for (const side of [-1, 1]) for (let leg = 0; leg < 4; leg++) {
      const y = (leg - 1.5) * cellSize * .16;
      context.beginPath(); context.moveTo(side * cellSize * .16, y);
      context.lineTo(side * cellSize * (.48 + Math.abs(leg - 1.5) * .06), y + (leg - 1.5) * cellSize * .13); context.stroke();
    }
    context.beginPath(); context.ellipse(0, cellSize * .08, cellSize * .28, cellSize * .36, 0, 0, Math.PI * 2); context.fill(); context.stroke();
    context.beginPath(); context.arc(0, -cellSize * .27, cellSize * .19, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#ffcf4b";
    for (const x of [-.08, .08]) { context.beginPath(); context.arc(x * cellSize, -cellSize * .31, Math.max(1.2, cellSize * .035), 0, Math.PI * 2); context.fill(); }
    context.restore(); return;
  }
  if (entity.type === "gargoyle") {
    const facing = Number.isFinite(entity.facing) ? entity.facing : 0;
    const tip = gridPoint(entity.x + .5 + Math.cos(facing) * .58, entity.y + .5 + Math.sin(facing) * .58);
    if (!drawSprite("gargoyle", centre, spriteDirection(facing), 1.25)) {
      context.save(); context.translate(centre.x, centre.y - cellSize * .42);
      context.fillStyle = "#69717c"; context.strokeStyle = "#c0c7cf"; context.lineWidth = Math.max(1, cellSize * .08);
      context.beginPath(); context.moveTo(-cellSize * .42, cellSize * .45); context.lineTo(-cellSize * .28, -cellSize * .2);
      context.lineTo(-cellSize * .58, -cellSize * .48); context.lineTo(-cellSize * .12, -cellSize * .34);
      context.lineTo(0, -cellSize * .72); context.lineTo(cellSize * .12, -cellSize * .34);
      context.lineTo(cellSize * .58, -cellSize * .48); context.lineTo(cellSize * .28, -cellSize * .2);
      context.lineTo(cellSize * .42, cellSize * .45); context.closePath(); context.fill(); context.stroke(); context.restore();
    }
    context.save(); context.strokeStyle = "#ffd553"; context.fillStyle = "#ffd553"; context.lineWidth = Math.max(1.5, cellSize * .1);
    context.beginPath(); context.moveTo(centre.x, centre.y); context.lineTo(tip.x, tip.y); context.stroke();
    const angle = Math.atan2(tip.y - centre.y, tip.x - centre.x);
    context.translate(tip.x, tip.y); context.rotate(angle); context.beginPath(); context.moveTo(0, 0);
    context.lineTo(-cellSize * .28, -cellSize * .16); context.lineTo(-cellSize * .28, cellSize * .16); context.closePath(); context.fill(); context.restore();
    return;
  }
  if (entity.type !== "player") return;
  if (drawSprite("player", centre, spriteDirection(entity.facing), 1.15)) return;
  const size = cellSize * .48;
  context.save(); context.translate(centre.x, centre.y - cellSize * .36);
  context.fillStyle = "rgba(255,213,83,.18)"; context.strokeStyle = "#ffd553"; context.lineWidth = 2;
  context.beginPath(); context.ellipse(0, cellSize * .34, size * .9, size * .32, 0, 0, Math.PI * 2); context.fill(); context.stroke();
  context.fillStyle = "#f2f4f7";
  context.beginPath(); context.moveTo(0, -size); context.lineTo(size * .72, size * .55); context.lineTo(0, size * .25); context.lineTo(-size * .72, size * .55); context.closePath(); context.fill(); context.stroke();
  context.restore();
}
function draw(): void {
  context.clearRect(0, 0, canvas.width, canvas.height);
  const bridge = previewBridge();
  if (bridge) {
    const project = (x: number, y: number) => {
      const point = bridge.project(ARENA_X + x * editorTilePixels, ARENA_Y + y * editorTilePixels);
      return point ? { x: point.x * canvas.width, y: point.y * canvas.height } : null;
    };
    for (const entity of entities) {
      const centre = project(entity.x + .5, entity.y + .5); if (!centre) continue;
      if (entity.label) {
        context.fillStyle = "#fff3b2"; context.strokeStyle = "#17120a"; context.lineWidth = 3;
        context.font = "700 15px ui-monospace"; context.textAlign = "center"; context.textBaseline = "middle";
        context.strokeText(entity.label, centre.x, centre.y - 12); context.fillText(entity.label, centre.x, centre.y - 12);
      }
      if (entity.type === "gargoyle") {
        const tip = project(entity.x + .5 + Math.cos(entity.facing) * .65, entity.y + .5 + Math.sin(entity.facing) * .65);
        if (tip) { context.strokeStyle = "#ffd553"; context.lineWidth = 2; context.beginPath(); context.moveTo(centre.x, centre.y); context.lineTo(tip.x, tip.y); context.stroke(); }
      }
    }
  }
  const level = serialize();
  counts.textContent = `${level.tiles.length} placed tiles · ${entities.length} entities · ${entities.some(entity => entity.type === "player") ? "spawn ready" : "spawn missing"}`;
  seedLabel.textContent = String(editorDungeonSeed(level));
}
function cellFromEvent(event: Pick<MouseEvent, "clientX" | "clientY">): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const world = previewBridge()?.groundAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  if (!world) return null;
  const x = Math.floor((world.x - ARENA_X) / editorTilePixels);
  const y = Math.floor((world.y - ARENA_Y) / editorTilePixels);
  return inside(x, y) ? { x, y } : null;
}

/**
 * Actors and scenery rise above their floor cell. Projecting a click on their
 * visible body back onto the floor selects a cell behind them, so Delete needs
 * a small screen-space billboard hit test before falling back to floor picking.
 */
function entityFromEvent(event: Pick<MouseEvent, "clientX" | "clientY">): PlacedEntity | null {
  const bridge = previewBridge(); if (!bridge) return null;
  const rect = canvas.getBoundingClientRect();
  const pointerX = event.clientX - rect.left, pointerY = event.clientY - rect.top;
  const hitHeights: Partial<Record<EntityType, number>> = {
    gargoyle: 190, hellhound: 105, bat: 120, spider: 90, snake: 65, player: 130,
    gate: 190, torch: 130, boulder: 100, "angel-statue": 190,
    "rock-1": 75, "rock-2": 75, "rock-3": 75, "rock-4": 75,
    "rock-5": 115, "rock-6": 115, "rock-7": 115, "rock-8": 115,
  };
  let best: { entity: PlacedEntity; score: number } | null = null;
  for (const entity of entities) {
    const worldX = ARENA_X + (entity.x + .5) * editorTilePixels;
    const worldY = ARENA_Y + (entity.y + .5) * editorTilePixels;
    const foot = entity.type === "player" ? bridge.projectPlayer(worldX, worldY) : bridge.project(worldX, worldY);
    if (!foot) continue;
    const x = foot.x * rect.width, y = foot.y * rect.height;
    const height = hitHeights[entity.type] ?? 55;
    const halfWidth = Math.max(24, Math.min(85, height * .42));
    if (pointerX < x - halfWidth || pointerX > x + halfWidth || pointerY < y - height || pointerY > y + 24) continue;
    const centerY = y - height * .42;
    const score = Math.hypot((pointerX - x) / halfWidth, (pointerY - centerY) / (height * .58));
    if (!best || score < best.score) best = { entity, score };
  }
  return best?.entity ?? null;
}

function deleteFromEvent(event: Pick<MouseEvent, "clientX" | "clientY">): boolean {
  const entity = entityFromEvent(event);
  if (entity) {
    entities = entities.filter((candidate) => candidate.id !== entity.id);
    return true;
  }
  const cell = cellFromEvent(event);
  return !!cell && placeTool("erase", cell.x, cell.y);
}

function previewChanged(): void {
  draw();
  schedulePreviewRefresh();
}

function placeTool(tool: ToolType, x: number, y: number): boolean {
  if (tool === "erase") {
    const before = entities.length;
    entities = entities.filter((entity) => entity.x !== x || entity.y !== y);
    if (before !== entities.length) return true;
    if (tileAt(x, y) !== "void") { tiles[tileIndex(x, y)] = "void"; return true; }
    return false;
  }
  if (!entityTypes.has(tool as EntityType)) {
    if (tileAt(x, y) === tool) return false;
    tiles[tileIndex(x, y)] = tool as TileType;
    if (tool === "void" || tool === "wall") entities = entities.filter((entity) => entity.x !== x || entity.y !== y);
    return true;
  }
  const entityType = tool as EntityType;
  const isLinkedObject = entityType === "gate" || entityType === "gate-button" || entityType === "portal-exit";
  const label = linkLabel.value;
  if (isLinkedObject && !validLinkLabel(label)) {
    status.textContent = "Enter one letter or number for the link label";
    linkLabel.focus();
    return false;
  }
  if (tileAt(x, y) !== "floor" && tileAt(x, y) !== "grass" && tileAt(x, y) !== "doorway") tiles[tileIndex(x, y)] = "floor";
  if (entityType === "player") entities = entities.filter((entity) => entity.type !== "player");
  if (entityType === "portal-exit") entities = entities.filter((entity) => entity.type !== "portal-exit");
  entities = entities.filter((entity) => entity.x !== x || entity.y !== y);
  const directional = entityType === "gargoyle" || entityType === "hellhound" || entityType === "bat"
    || entityType === "spider" || entityType === "snake" || entityType === "player";
  const facing = directional ? Number(entityFacing.value) : 0;
  entities.push({ id: `${entityType}-${sequence++}`, type: entityType, x, y, facing, ...(isLinkedObject ? { label } : {}) });
  return true;
}

function selectTool(tool: ToolType): void {
  selectedTool = tool;
  document.querySelectorAll<HTMLElement>(".tool").forEach((element) => element.classList.toggle("selected", element.dataset.tool === tool));
  status.textContent = tools.find((definition) => definition.type === tool)?.label ?? tool;
  if (tool === "gate" || tool === "gate-button" || tool === "portal-exit") linkLabel.focus();
  entityFacing.disabled = !["gargoyle", "hellhound", "bat", "spider", "snake", "player"].includes(tool);
}

for (const definition of tools) {
  const button = document.createElement("button");
  button.className = "tool"; button.draggable = true; button.dataset.tool = definition.type;
  button.innerHTML = `<span class="icon">${definition.icon}</span><span class="label">${definition.label}</span>`;
  button.addEventListener("click", () => selectTool(definition.type));
  button.addEventListener("dragstart", (event) => event.dataTransfer?.setData("application/x-dungeon-tool", definition.type));
  document.querySelector(`#${definition.group}-palette`)!.appendChild(button);
}
selectTool(selectedTool);

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 2) {
    event.preventDefault(); canvas.setPointerCapture(event.pointerId); rotating = true;
    rotationDragX = rotationPressX = event.clientX; rotationPressY = event.clientY; rotationDragMoved = false;
    canvas.classList.add("panning"); status.textContent = "Rotating view"; return;
  }
  if (event.button === 1 || ((event.ctrlKey || event.metaKey) && event.button === 0)) {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    panning = true;
    panPointerX = event.clientX;
    panPointerY = event.clientY;
    canvas.classList.add("panning");
    status.textContent = "Panning view";
    return;
  }
  canvas.setPointerCapture(event.pointerId); drawing = true; changedDuringGesture = false;
  if (selectedTool === "erase") {
    changedDuringGesture = deleteFromEvent(event);
    if (changedDuringGesture) previewChanged();
    return;
  }
  const cell = cellFromEvent(event); if (!cell) { drawing = false; return; }
  const existing = [...entities].reverse().find((entity) => entity.x === cell.x && entity.y === cell.y);
  if (existing && event.button === 0) {
    draggedEntityId = existing.id;
  } else {
    changedDuringGesture = placeTool(selectedTool, cell.x, cell.y);
  }
  draw();
});

canvas.addEventListener("pointermove", (event) => {
  if (rotating) {
    const delta = event.clientX - rotationDragX; rotationDragX = event.clientX;
    if (rotationDragMoved || Math.hypot(event.clientX - rotationPressX, event.clientY - rotationPressY) >= 5) {
      rotationDragMoved = true; previewBridge()?.look(delta, 0); viewRotation -= delta * .006;
      requestAnimationFrame(draw);
    }
    return;
  }
  if (panning) {
    const dx = event.clientX - panPointerX, dy = event.clientY - panPointerY;
    panX += dx; panY += dy; previewBridge()?.pan(dx, dy);
    panPointerX = event.clientX;
    panPointerY = event.clientY;
    requestAnimationFrame(draw);
    return;
  }
  const cell = cellFromEvent(event);
  coords.textContent = cell ? `x ${cell.x}, y ${cell.y}` : "—";
  if (!drawing) return;
  if (selectedTool === "erase") {
    const changed = deleteFromEvent(event);
    changedDuringGesture = changed || changedDuringGesture;
    if (changed) previewChanged();
    return;
  }
  if (!cell) return;
  if (draggedEntityId) {
    const entity = entities.find((candidate) => candidate.id === draggedEntityId);
    if (entity && (entity.x !== cell.x || entity.y !== cell.y) && tileAt(cell.x, cell.y) !== "wall" && tileAt(cell.x, cell.y) !== "void") {
      entities = entities.filter((candidate) => candidate.id === entity.id || candidate.x !== cell.x || candidate.y !== cell.y);
      entity.x = cell.x; entity.y = cell.y; changedDuringGesture = true;
    }
  } else if (!entityTypes.has(selectedTool as EntityType)) {
    changedDuringGesture = placeTool(selectedTool, cell.x, cell.y) || changedDuringGesture;
  }
  draw();
});

const finishGesture = (event: PointerEvent) => {
  if (rotating) {
    rotating = false; canvas.classList.remove("panning");
    status.textContent = rotationDragMoved
      ? (Math.abs(viewRotation) < .001 ? "Game camera view" : `View rotated ${Math.round(viewRotation * 180 / Math.PI)}°`)
      : tools.find((definition) => definition.type === selectedTool)?.label ?? selectedTool;
    return;
  }
  if (panning) {
    panning = false;
    canvas.classList.remove("panning");
    status.textContent = tools.find((definition) => definition.type === selectedTool)?.label ?? selectedTool;
    return;
  }
  if (changedDuringGesture) recordHistory(); drawing = false; draggedEntityId = null;
};
canvas.addEventListener("pointerup", finishGesture); canvas.addEventListener("pointercancel", finishGesture);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  previewBridge()?.zoom(event.deltaY); requestAnimationFrame(draw);
  status.textContent = "Game camera zoom";
}, { passive: false });
canvas.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
canvas.addEventListener("drop", (event) => {
  event.preventDefault(); const cell = cellFromEvent(event); if (!cell) return;
  const tool = event.dataTransfer?.getData("application/x-dungeon-tool") as ToolType;
  if (tools.some((definition) => definition.type === tool) && placeTool(tool, cell.x, cell.y)) recordHistory();
  draw();
});

zoomInput.addEventListener("input", () => {
  const next = Number(zoomInput.value); previewBridge()?.zoom((cellSize - next) * 80); cellSize = next; requestAnimationFrame(draw);
});
function setViewRotation(rotation: number): void {
  const next = Math.atan2(Math.sin(rotation), Math.cos(rotation));
  previewBridge()?.look((viewRotation - next) / .006, 0); viewRotation = next;
  rotationLabel.textContent = Math.abs(viewRotation) < .001 ? "Game view" : `${Math.round(viewRotation * 180 / Math.PI)}°`;
  draw();
  status.textContent = Math.abs(viewRotation) < .001 ? "Game camera view" : `View rotated ${Math.round(viewRotation * 180 / Math.PI)}°`;
}
function rotateView(delta: number): void { setViewRotation(viewRotation + delta * Math.PI / 2); }
document.querySelector("#rotate-left")!.addEventListener("click", () => rotateView(-1));
document.querySelector("#rotate-right")!.addEventListener("click", () => rotateView(1));
document.querySelector("#full-map")!.addEventListener("click", () => {
  previewBridge()?.fullMap(); window.setTimeout(draw, 40); status.textContent = "Full map view";
});
linkLabel.addEventListener("input", () => {
  linkLabel.value = [...linkLabel.value].find((character) => /[0-9A-Za-z]/.test(character)) ?? "";
});
levelName.addEventListener("change", recordHistory);
document.querySelector("#undo")!.addEventListener("click", () => restoreHistory(historyIndex - 1));
document.querySelector("#redo")!.addEventListener("click", () => restoreHistory(historyIndex + 1));
document.querySelector("#save-room")!.addEventListener("click", async () => {
  if (await saveProject()) status.textContent = `Saved room ${activeRoomLabel} to disk`;
});
document.querySelector("#new-room")!.addEventListener("click", () => {
  if (!storeCurrentRoom(activeRoomLabel)) return;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const nextLabel = [...alphabet].find((label) => !rooms.has(label));
  if (!nextLabel) { status.textContent = "All room labels are in use"; return; }
  activeRoomLabel = nextLabel; blankLevel(); levelName.value = `Room ${nextLabel}`;
  rooms.set(nextLabel, serialize()); refreshRoomSelect(); resetRoomHistory(); draw();
  status.textContent = `Created room ${nextLabel}`;
});
roomSelect.addEventListener("change", () => {
  const target = roomSelect.value;
  rooms.set(activeRoomLabel, cloneLevel(serialize()));
  openRoom(target); status.textContent = `Editing room ${target}`;
});
roomLabel.addEventListener("input", () => {
  roomLabel.value = [...roomLabel.value].find((character) => /[0-9A-Za-z]/.test(character)) ?? "";
});
document.querySelector("#save")!.addEventListener("click", async () => { if (await saveProject()) status.textContent = `Saved ${rooms.size} room${rooms.size === 1 ? "" : "s"} to disk`; });
document.querySelector("#play")!.addEventListener("click", async () => {
  if (!await saveProject()) return;
  for (const [label, level] of rooms) {
    if (!level.entities.some((entity) => entity.type === "player")) { status.textContent = `Room ${label} needs a player spawn`; return; }
    const gateLabels = new Set(level.entities.filter((entity) => entity.type === "gate").map((entity) => entity.label));
    const buttonLabels = new Set(level.entities.filter((entity) => entity.type === "gate-button").map((entity) => entity.label));
    const orphan = [...new Set([...gateLabels, ...buttonLabels])].find((link) => !gateLabels.has(link) || !buttonLabels.has(link));
    if (orphan) { status.textContent = `Room ${label}: link ${orphan} needs both a gate and a button`; return; }
    const exit = level.entities.find((entity) => entity.type === "portal-exit");
    if (exit && !rooms.has(exit.label ?? "")) { status.textContent = `Room ${label}: exit ${exit.label} has no destination room`; return; }
  }
  const roomSeeds = new Map([...rooms].map(([label, level]) => [label, editorDungeonSeed(level)]));
  const seed = roomSeeds.get(activeRoomLabel)!;
  const gameWindow = window.open("about:blank", "_blank");
  status.textContent = `Preparing ${rooms.size} linked room${rooms.size === 1 ? "" : "s"}…`;
  try {
    for (const [label, level] of rooms) {
      const compiled = cloneLevel(level);
      for (const entity of compiled.entities) if (entity.type === "portal-exit") entity.destinationSeed = roomSeeds.get(entity.label ?? "");
      const response = await fetch("/api/editor-level", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(compiled),
      });
      if (!response.ok) throw new Error(`Could not prepare room ${label} (${response.status})`);
      const result = await response.json() as { id: string; seed: number };
      localStorage.setItem(`rpg-editor-level:${result.id}`, JSON.stringify(compiled));
    }
    const gameUrl = `/?seed=${seed}&editor=${encodeURIComponent(String(seed))}`;
    if (gameWindow) gameWindow.location.href = gameUrl;
    else window.location.href = gameUrl;
    status.textContent = `Playing room ${activeRoomLabel}`;
  } catch (error) {
    gameWindow?.close();
    status.textContent = error instanceof Error ? error.message : "Could not start game";
  }
});
document.querySelector("#load")!.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/editor-project");
    if (!response.ok) throw new Error(response.status === 404 ? "No project has been saved to disk" : `Server returned ${response.status}`);
    const raw = await response.json() as Partial<ProjectData>;
    applyProject(raw); localStorage.setItem(projectStorageKey, JSON.stringify(raw));
    status.textContent = `Loaded ${rooms.size} rooms from disk`;
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
});
document.querySelector("#export")!.addEventListener("click", () => {
  if (!storeCurrentRoom(roomLabel.value)) return;
  const blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `${(levelName.value || "dungeon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dungeon"}.json`;
  link.click(); URL.revokeObjectURL(link.href); status.textContent = "Exported JSON";
});
document.querySelector("#import")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0]; if (!file) return;
  try {
    const raw = JSON.parse(await file.text()) as Partial<ProjectData & LevelData>;
    if (raw.rooms && typeof raw.rooms === "object") {
      applyProject(raw);
    } else {
      const level = normalizeLevel(raw); activeRoomLabel = "A"; rooms = new Map([["A", level]]); refreshRoomSelect(); openRoom("A");
    }
    status.textContent = `Imported ${file.name}`;
  }
  catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  importFile.value = "";
});
document.querySelector("#clear")!.addEventListener("click", () => {
  if (!confirm("Clear the entire level?")) return;
  tiles = Array.from({ length: width * height }, () => "void" as TileType); entities = []; draw(); recordHistory(); status.textContent = "Level cleared";
});
window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key.toLowerCase() === "q") { event.preventDefault(); rotateView(-1); return; }
  if (event.key.toLowerCase() === "e") { event.preventDefault(); rotateView(1); return; }
  if (event.key.toLowerCase() === "r") {
    event.preventDefault(); previewBridge()?.reset(); viewRotation = 0; rotationLabel.textContent = "Game view";
    requestAnimationFrame(draw); status.textContent = "Game camera view restored"; return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "z") { event.preventDefault(); restoreHistory(historyIndex + (event.shiftKey ? 1 : -1)); }
  if (event.key.toLowerCase() === "y") { event.preventDefault(); restoreHistory(historyIndex + 1); }
});
gamePreview.addEventListener("load", () => {
  const redraw = () => { resizeCanvas(); draw(); };
  window.setTimeout(redraw, 100); window.setTimeout(redraw, 400);
});
window.addEventListener("resize", resizeCanvas);

const savedProject = localStorage.getItem(projectStorageKey);
if (savedProject) {
  try {
    applyProject(JSON.parse(savedProject) as Partial<ProjectData>);
  } catch { blankLevel(); rooms.set("A", serialize()); refreshRoomSelect(); resizeCanvas(); recordHistory(); }
} else {
  const legacy = localStorage.getItem("rpg-dungeon-editor-level");
  if (legacy) { try { const level = normalizeLevel(JSON.parse(legacy)); rooms.set("A", level); refreshRoomSelect(); applyLevel(level, false); resetRoomHistory(); } catch { blankLevel(); rooms.set("A", serialize()); refreshRoomSelect(); resizeCanvas(); recordHistory(); } }
  else { blankLevel(); rooms.set("A", serialize()); refreshRoomSelect(); resizeCanvas(); recordHistory(); }
}

// Disk is authoritative across browser profiles and cleared site data. Load it
// after the immediate browser cache so the editor still paints without waiting.
fetch("/api/editor-project").then(async (response) => {
  if (!response.ok) return;
  const raw = await response.json() as Partial<ProjectData>;
  applyProject(raw); localStorage.setItem(projectStorageKey, JSON.stringify(raw));
  status.textContent = `Loaded ${rooms.size} rooms from disk`;
}).catch(() => { /* The local cache remains usable when the server is unavailable. */ });
