import { editorDungeonSeed } from "../shared/editor-seed.js";

type TileType = "void" | "floor" | "wall" | "doorway";
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
  { type: "floor", label: "Floor tile", icon: "◇", group: "tile" },
  { type: "wall", label: "Wall block", icon: "◆", group: "tile" },
  { type: "erase", label: "Erase", icon: "⌫", group: "tile" },
  { type: "player", label: "Player spawn", icon: "▲", group: "entity" },
  { type: "gate", label: "Gate", icon: "▥", group: "object" },
  { type: "gate-button", label: "Gate button", icon: "◉", group: "object" },
  { type: "portal-exit", label: "Exit hole", icon: "▣", group: "object" },
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
const roomLabel = document.querySelector<HTMLInputElement>("#room-label")!;
const roomSelect = document.querySelector<HTMLSelectElement>("#room-select")!;
const validLinkLabel = (value: string) => /^[0-9A-Za-z]$/.test(value);
const projectStorageKey = "rpg-dungeon-editor-project";

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
}

function normalizeLevel(value: unknown): LevelData {
  if (!value || typeof value !== "object") throw new Error("The JSON does not contain a level.");
  const raw = value as Partial<LevelData>;
  if (!Array.isArray(raw.tiles) || !Array.isArray(raw.entities)) {
    throw new Error("Invalid level dimensions, tiles, or entities.");
  }
  const validTiles = new Set<TileType>(["floor", "wall", "doorway"]);
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
  // A 100×100 isometric map is already several million pixels when zoomed;
  // keep one backing pixel per CSS pixel so high-DPI screens stay responsive.
  const dpr = 1;
  const size = canvasDimensions();
  canvas.width = size.width * dpr;
  canvas.height = size.height * dpr;
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  applyPan();
  draw();
}

function applyPan(): void {
  canvas.style.transform = `translate(${panX}px, ${panY}px)`;
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
      pathPolygon([top[edge]!, top[next]!, base[next]!, base[edge]!]); context.fill();
    }
    context.fillStyle = "#596372"; pathPolygon(top); context.fill();
    context.strokeStyle = "#737f90"; pathPolygon(top); context.stroke();
    context.strokeStyle = "rgba(10,12,16,.72)";
    for (const side of [[top[3]!, base[3]!], [top[2]!, base[2]!], [top[1]!, base[1]!]] as const) {
      context.beginPath(); context.moveTo(side[0].x, side[0].y); context.lineTo(side[1].x, side[1].y); context.stroke();
    }
    return;
  }
  context.fillStyle = type === "floor" || type === "doorway"
    ? ((x + y) % 2 ? "#323943" : "#3a424d") : "#0b0e14";
  pathPolygon(base); context.fill();
  context.strokeStyle = type === "void" ? "rgba(104,119,142,.22)" : "#596474";
  pathPolygon(base); context.stroke();
}
function drawEntity(entity: PlacedEntity): void {
  const centre = gridPoint(entity.x + .5, entity.y + .5);
  if (/^rock-[1-8]$/.test(entity.type)) {
    const variant = Number(entity.type.slice("rock-".length)) - 1;
    const scale = variant < 4 ? .62 : .88;
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
    context.save(); context.translate(centre.x, centre.y - cellSize * .6);
    context.strokeStyle = "#b6c0cc"; context.lineWidth = Math.max(2, cellSize * .16);
    for (let offset = -0.65; offset <= .65; offset += .325) { context.beginPath(); context.moveTo(offset * cellSize, -cellSize * .72); context.lineTo(offset * cellSize, cellSize * .65); context.stroke(); }
    context.beginPath(); context.moveTo(-cellSize * .78, -cellSize * .65); context.lineTo(cellSize * .78, -cellSize * .65); context.moveTo(-cellSize * .78, cellSize * .58); context.lineTo(cellSize * .78, cellSize * .58); context.stroke();
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
  if (entity.type !== "player") return;
  const size = cellSize * .48;
  context.save(); context.translate(centre.x, centre.y - cellSize * .36);
  context.fillStyle = "rgba(255,213,83,.18)"; context.strokeStyle = "#ffd553"; context.lineWidth = 2;
  context.beginPath(); context.ellipse(0, cellSize * .34, size * .9, size * .32, 0, 0, Math.PI * 2); context.fill(); context.stroke();
  context.fillStyle = "#f2f4f7";
  context.beginPath(); context.moveTo(0, -size); context.lineTo(size * .72, size * .55); context.lineTo(0, size * .25); context.lineTo(-size * .72, size * .55); context.closePath(); context.fill(); context.stroke();
  context.restore();
}
function draw(): void {
  const size = canvasDimensions();
  context.clearRect(0, 0, size.width, size.height);
  for (const cell of cellsInDrawOrder()) drawTile(cell.x, cell.y, tileAt(cell.x, cell.y));
  for (const entity of entities) drawEntity(entity);
  const level = serialize();
  counts.textContent = `${level.tiles.length} placed tiles · ${entities.some(entity => entity.type === "player") ? "spawn ready" : "spawn missing"}`;
  seedLabel.textContent = String(editorDungeonSeed(level));
}
function cellFromEvent(event: Pick<MouseEvent, "clientX" | "clientY">): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const px = event.clientX - rect.left, py = event.clientY - rect.top;
  // Raised wall tops and faces are checked first, from front to back.
  const wallCells = cellsInDrawOrder()
    .filter((cell) => tileAt(cell.x, cell.y) === "wall")
    .reverse();
  for (const { x, y } of wallCells) {
    const top = diamond(x, y, wallHeight()), base = diamond(x, y);
    if (pointInPolygon(px, py, top)) return { x, y };
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      if (pointInPolygon(px, py, [top[edge]!, top[next]!, base[next]!, base[edge]!])) return { x, y };
    }
  }
  const origin = gridOrigin();
  const diagonalX = (px - origin.x) / (tileWidth() / 2);
  const diagonalY = (py - origin.y) / (tileHeight() / 2);
  const viewX = (diagonalX + diagonalY) / 2;
  const viewY = (diagonalY - diagonalX) / 2;
  const unrotated = unrotateGridPoint(viewX, viewY);
  const x = Math.floor(unrotated.x);
  const y = Math.floor(unrotated.y);
  return inside(x, y) && pointInPolygon(px, py, diamond(x, y)) ? { x, y } : null;
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
  if (tileAt(x, y) !== "floor" && tileAt(x, y) !== "doorway") tiles[tileIndex(x, y)] = "floor";
  if (entityType === "player") entities = entities.filter((entity) => entity.type !== "player");
  if (entityType === "portal-exit") entities = entities.filter((entity) => entity.type !== "portal-exit");
  entities = entities.filter((entity) => entity.x !== x || entity.y !== y);
  entities.push({ id: `${entityType}-${sequence++}`, type: entityType, x, y, facing: 0, ...(isLinkedObject ? { label } : {}) });
  return true;
}

function selectTool(tool: ToolType): void {
  selectedTool = tool;
  document.querySelectorAll<HTMLElement>(".tool").forEach((element) => element.classList.toggle("selected", element.dataset.tool === tool));
  status.textContent = tools.find((definition) => definition.type === tool)?.label ?? tool;
  if (tool === "gate" || tool === "gate-button" || tool === "portal-exit") linkLabel.focus();
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
    canvas.classList.add("panning"); status.textContent = "Right-click erases · drag rotates"; return;
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
  const cell = cellFromEvent(event); if (!cell) return;
  canvas.setPointerCapture(event.pointerId); drawing = true; changedDuringGesture = false;
  const existing = [...entities].reverse().find((entity) => entity.x === cell.x && entity.y === cell.y);
  if (existing && event.button === 0 && selectedTool !== "erase") {
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
      rotationDragMoved = true; setViewRotation(viewRotation - delta * .01);
    }
    return;
  }
  if (panning) {
    panX += event.clientX - panPointerX;
    panY += event.clientY - panPointerY;
    panPointerX = event.clientX;
    panPointerY = event.clientY;
    applyPan();
    return;
  }
  const cell = cellFromEvent(event);
  coords.textContent = cell ? `x ${cell.x}, y ${cell.y}` : "—";
  if (!drawing || !cell) return;
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
    let erased = false;
    if (!rotationDragMoved && event.type === "pointerup") {
      const cell = cellFromEvent(event);
      erased = !!cell && placeTool("erase", cell.x, cell.y);
      if (erased) { draw(); recordHistory(); }
    }
    rotating = false; canvas.classList.remove("panning");
    status.textContent = rotationDragMoved
      ? (Math.abs(viewRotation) < .001 ? "Game camera view" : `View rotated ${Math.round(viewRotation * 180 / Math.PI)}°`)
      : erased ? "Erased tile" : "Nothing to erase";
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
  const before = cellFromEvent(event);
  const beforePoint = before ? gridPoint(before.x + .5, before.y + .5) : null;
  const beforeRect = canvas.getBoundingClientRect();
  const nextSize = Math.max(Number(zoomInput.min), Math.min(Number(zoomInput.max), cellSize + (event.deltaY < 0 ? 2 : -2)));
  if (nextSize === cellSize) return;
  cellSize = nextSize;
  zoomInput.value = String(cellSize);
  resizeCanvas();
  if (before && beforePoint) {
    const afterRect = canvas.getBoundingClientRect();
    const afterPoint = gridPoint(before.x + .5, before.y + .5);
    const beforeScreenX = beforeRect.left + beforePoint.x;
    const beforeScreenY = beforeRect.top + beforePoint.y;
    const afterScreenX = afterRect.left + afterPoint.x;
    const afterScreenY = afterRect.top + afterPoint.y;
    panX += beforeScreenX - afterScreenX;
    panY += beforeScreenY - afterScreenY;
    applyPan();
  }
  status.textContent = `Zoom ${cellSize}`;
}, { passive: false });
canvas.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
canvas.addEventListener("drop", (event) => {
  event.preventDefault(); const cell = cellFromEvent(event); if (!cell) return;
  const tool = event.dataTransfer?.getData("application/x-dungeon-tool") as ToolType;
  if (tools.some((definition) => definition.type === tool) && placeTool(tool, cell.x, cell.y)) recordHistory();
  draw();
});

zoomInput.addEventListener("input", () => { cellSize = Number(zoomInput.value); resizeCanvas(); });
function setViewRotation(rotation: number): void {
  viewRotation = Math.atan2(Math.sin(rotation), Math.cos(rotation));
  rotationLabel.textContent = Math.abs(viewRotation) < .001 ? "Game view" : `${Math.round(viewRotation * 180 / Math.PI)}°`;
  draw();
  status.textContent = Math.abs(viewRotation) < .001 ? "Game camera view" : `View rotated ${Math.round(viewRotation * 180 / Math.PI)}°`;
}
function rotateView(delta: number): void { setViewRotation(viewRotation + delta * Math.PI / 2); }
document.querySelector("#rotate-left")!.addEventListener("click", () => rotateView(-1));
document.querySelector("#rotate-right")!.addEventListener("click", () => rotateView(1));
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
    if (level.tiles.length === 0) { status.textContent = `Room ${label} needs at least one floor tile`; return; }
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
  if (event.key.toLowerCase() === "r") { event.preventDefault(); setViewRotation(0); status.textContent = "Game camera view restored"; return; }
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "z") { event.preventDefault(); restoreHistory(historyIndex + (event.shiftKey ? 1 : -1)); }
  if (event.key.toLowerCase() === "y") { event.preventDefault(); restoreHistory(historyIndex + 1); }
});

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
