type TileType = "void" | "floor" | "wall" | "doorway";
type EntityType = "player" | "hellhound" | "bat" | "spider" | "gargoyle"
  | "purple-gem" | "pressure-plate" | "portal-exit" | "torch" | "boulder" | "angel-statue";
type ToolType = TileType | EntityType | "erase";

interface PlacedEntity { id: string; type: EntityType; x: number; y: number; facing: number }
interface LevelData {
  version: 1;
  name: string;
  width: number;
  height: number;
  tiles: Array<{ x: number; y: number; type: Exclude<TileType, "void"> }>;
  entities: PlacedEntity[];
}

interface ToolDefinition { type: ToolType; label: string; icon: string; group: "tile" | "entity" | "object" }

const tools: ToolDefinition[] = [
  { type: "floor", label: "Stone floor", icon: "▦", group: "tile" },
  { type: "wall", label: "Stone wall", icon: "▩", group: "tile" },
  { type: "doorway", label: "Doorway", icon: "▯", group: "tile" },
  { type: "void", label: "Void", icon: "■", group: "tile" },
  { type: "erase", label: "Erase", icon: "⌫", group: "tile" },
  { type: "player", label: "Player spawn", icon: "◆", group: "entity" },
  { type: "hellhound", label: "Hellhound", icon: "◢", group: "entity" },
  { type: "bat", label: "Bat", icon: "⌁", group: "entity" },
  { type: "spider", label: "Spider", icon: "✳", group: "entity" },
  { type: "gargoyle", label: "Gargoyle", icon: "♜", group: "entity" },
  { type: "purple-gem", label: "Purple gem", icon: "♦", group: "object" },
  { type: "pressure-plate", label: "Pressure plate", icon: "▣", group: "object" },
  { type: "portal-exit", label: "Dungeon exit", icon: "◎", group: "object" },
  { type: "torch", label: "Wall torch", icon: "♨", group: "object" },
  { type: "boulder", label: "Boulder", icon: "●", group: "object" },
  { type: "angel-statue", label: "Angel statue", icon: "♰", group: "object" },
];

const entityTypes = new Set<EntityType>(tools.filter((tool) => tool.group !== "tile").map((tool) => tool.type as EntityType));
const canvas = document.querySelector<HTMLCanvasElement>("#editor")!;
const context = canvas.getContext("2d")!;
const levelName = document.querySelector<HTMLInputElement>("#level-name")!;
const widthInput = document.querySelector<HTMLInputElement>("#grid-width")!;
const heightInput = document.querySelector<HTMLInputElement>("#grid-height")!;
const zoomInput = document.querySelector<HTMLInputElement>("#zoom")!;
const status = document.querySelector<HTMLElement>("#status")!;
const coords = document.querySelector<HTMLElement>("#coords")!;
const counts = document.querySelector<HTMLElement>("#counts")!;
const importFile = document.querySelector<HTMLInputElement>("#import-file")!;

let width = 40;
let height = 28;
let cellSize = 28;
let tiles: TileType[] = [];
let entities: PlacedEntity[] = [];
let selectedTool: ToolType = "floor";
let drawing = false;
let changedDuringGesture = false;
let draggedEntityId: string | null = null;
let sequence = 1;
let history: string[] = [];
let historyIndex = -1;

const tileIndex = (x: number, y: number) => y * width + x;
const tileAt = (x: number, y: number) => tiles[tileIndex(x, y)] ?? "void";
const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height;

function blankLevel(): void {
  tiles = Array.from({ length: width * height }, () => "void" as TileType);
  entities = [];
  const left = Math.max(2, Math.floor(width * 0.17));
  const right = Math.min(width - 3, Math.ceil(width * 0.83));
  const top = Math.max(2, Math.floor(height * 0.17));
  const bottom = Math.min(height - 3, Math.ceil(height * 0.83));
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    tiles[tileIndex(x, y)] = x === left || x === right || y === top || y === bottom ? "wall" : "floor";
  }
  tiles[tileIndex(Math.floor((left + right) / 2), bottom)] = "doorway";
  entities.push({ id: `player-${sequence++}`, type: "player", x: Math.floor(width / 2), y: Math.floor(height / 2), facing: 0 });
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
  const nextWidth = Math.max(8, Math.min(100, Math.round(Number(raw.width))));
  const nextHeight = Math.max(8, Math.min(100, Math.round(Number(raw.height))));
  if (!Number.isFinite(nextWidth) || !Number.isFinite(nextHeight) || !Array.isArray(raw.tiles) || !Array.isArray(raw.entities)) {
    throw new Error("Invalid level dimensions, tiles, or entities.");
  }
  const validTiles = new Set<TileType>(["floor", "wall", "doorway"]);
  const nextTiles = raw.tiles.filter((tile): tile is LevelData["tiles"][number] =>
    !!tile && Number.isInteger(tile.x) && Number.isInteger(tile.y) && validTiles.has(tile.type));
  const nextEntities = raw.entities.filter((entity): entity is PlacedEntity =>
    !!entity && typeof entity.id === "string" && entityTypes.has(entity.type)
    && Number.isInteger(entity.x) && Number.isInteger(entity.y));
  return { version: 1, name: typeof raw.name === "string" ? raw.name : "Imported Dungeon", width: nextWidth, height: nextHeight, tiles: nextTiles, entities: nextEntities };
}

function applyLevel(level: LevelData, addHistory = true): void {
  width = level.width; height = level.height;
  widthInput.value = String(width); heightInput.value = String(height); levelName.value = level.name;
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
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * cellSize * dpr;
  canvas.height = height * cellSize * dpr;
  canvas.style.width = `${width * cellSize}px`;
  canvas.style.height = `${height * cellSize}px`;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawTile(x: number, y: number, type: TileType): void {
  const px = x * cellSize, py = y * cellSize;
  if (type === "floor" || type === "doorway") {
    context.fillStyle = (x + y) % 2 ? "#343942" : "#30353e";
    context.fillRect(px, py, cellSize, cellSize);
    context.strokeStyle = "#484e59";
    context.strokeRect(px + 2, py + 2, cellSize - 4, cellSize - 4);
  } else if (type === "wall") {
    context.fillStyle = "#171b23";
    context.fillRect(px, py, cellSize, cellSize);
    context.fillStyle = "#4b5260";
    context.fillRect(px + 2, py + 3, cellSize - 4, cellSize - 6);
    context.strokeStyle = "#252a33";
    context.strokeRect(px + 2, py + 3, cellSize - 4, cellSize - 6);
    context.beginPath(); context.moveTo(px + cellSize / 2, py + 3); context.lineTo(px + cellSize / 2, py + cellSize - 3); context.stroke();
  } else {
    context.fillStyle = "#07090d";
    context.fillRect(px, py, cellSize, cellSize);
  }
  if (type === "doorway") {
    context.strokeStyle = "#d6a84d"; context.lineWidth = 3;
    context.strokeRect(px + 4, py + 3, cellSize - 8, cellSize - 5);
    context.lineWidth = 1;
  }
  context.strokeStyle = "rgba(138,147,164,.16)";
  context.strokeRect(px + .5, py + .5, cellSize - 1, cellSize - 1);
}

function drawEntity(entity: PlacedEntity): void {
  const cx = (entity.x + .5) * cellSize, cy = (entity.y + .5) * cellSize;
  const radius = cellSize * .3;
  context.save(); context.translate(cx, cy); context.rotate(entity.facing);
  if (entity.type === "player") {
    context.fillStyle = "#f0f2f7"; context.strokeStyle = "#ffe13b"; context.lineWidth = 2;
    context.beginPath(); context.moveTo(radius, 0); context.lineTo(-radius * .7, -radius * .72); context.lineTo(-radius * .45, 0); context.lineTo(-radius * .7, radius * .72); context.closePath(); context.fill(); context.stroke();
  } else if (entity.type === "hellhound") {
    context.fillStyle = "#25171a"; context.strokeStyle = "#ff3434"; context.lineWidth = 2;
    context.beginPath(); context.arc(0, 0, radius, 0, Math.PI * 2); context.fill(); context.stroke();
    context.fillStyle = "#ff3030"; context.fillRect(radius * .15, -radius * .45, 2, 2); context.fillRect(radius * .15, radius * .3, 2, 2);
  } else if (entity.type === "bat") {
    context.fillStyle = "#17121e"; context.strokeStyle = "#9c4fbd";
    context.beginPath(); context.moveTo(0, 0); context.lineTo(-radius * 1.4, -radius); context.lineTo(-radius, radius * .8); context.lineTo(0, radius * .25); context.lineTo(radius, radius * .8); context.lineTo(radius * 1.4, -radius); context.closePath(); context.fill(); context.stroke();
  } else if (entity.type === "spider") {
    context.strokeStyle = "#a27aad"; context.lineWidth = 2;
    for (const side of [-1, 1]) for (let leg = -2; leg <= 2; leg++) { context.beginPath(); context.moveTo(0, leg * radius * .23); context.lineTo(side * radius * 1.25, leg * radius * .42); context.stroke(); }
    context.fillStyle = "#211b24"; context.beginPath(); context.arc(0, 0, radius * .7, 0, Math.PI * 2); context.fill();
  } else if (entity.type === "gargoyle") {
    context.fillStyle = "#777b84"; context.strokeStyle = "#c1c5cc";
    context.fillRect(-radius * .65, -radius * .7, radius * 1.3, radius * 1.4); context.strokeRect(-radius * .65, -radius * .7, radius * 1.3, radius * 1.4);
    context.fillStyle = "#ff1b12"; context.fillRect(radius * .15, -radius * .34, 2, 2); context.fillRect(radius * .15, radius * .22, 2, 2);
  } else {
    const colors: Record<string, string> = { "purple-gem": "#aa3cff", "pressure-plate": "#a98c57", "portal-exit": "#9d38e8", torch: "#ff8a2c", boulder: "#737884", "angel-statue": "#c0c2c8" };
    const glyphs: Record<string, string> = { "purple-gem": "♦", "pressure-plate": "▣", "portal-exit": "◎", torch: "♨", boulder: "●", "angel-statue": "♰" };
    context.fillStyle = colors[entity.type]!; context.font = `bold ${Math.round(cellSize * .7)}px Georgia`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(glyphs[entity.type]!, 0, 1);
  }
  context.restore();
}

function draw(): void {
  context.clearRect(0, 0, width * cellSize, height * cellSize);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) drawTile(x, y, tileAt(x, y));
  for (const entity of entities) drawEntity(entity);
  const enemyCount = entities.filter((entity) => ["hellhound", "bat", "spider", "gargoyle"].includes(entity.type)).length;
  counts.textContent = `${entities.length} objects · ${enemyCount} enemies`;
}

function cellFromEvent(event: PointerEvent | DragEvent): { x: number; y: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((event.clientX - rect.left) / cellSize);
  const y = Math.floor((event.clientY - rect.top) / cellSize);
  return inside(x, y) ? { x, y } : null;
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
  if (tileAt(x, y) === "void") tiles[tileIndex(x, y)] = "floor";
  if (entityType === "player") entities = entities.filter((entity) => entity.type !== "player");
  entities = entities.filter((entity) => entity.x !== x || entity.y !== y);
  entities.push({ id: `${entityType}-${sequence++}`, type: entityType, x, y, facing: 0 });
  return true;
}

function selectTool(tool: ToolType): void {
  selectedTool = tool;
  document.querySelectorAll<HTMLElement>(".tool").forEach((element) => element.classList.toggle("selected", element.dataset.tool === tool));
  status.textContent = tools.find((definition) => definition.type === tool)?.label ?? tool;
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
  const cell = cellFromEvent(event); if (!cell) return;
  canvas.setPointerCapture(event.pointerId); drawing = true; changedDuringGesture = false;
  const existing = [...entities].reverse().find((entity) => entity.x === cell.x && entity.y === cell.y);
  if (existing && event.button === 0 && selectedTool !== "erase") {
    draggedEntityId = existing.id;
  } else {
    changedDuringGesture = placeTool(event.button === 2 ? "erase" : selectedTool, cell.x, cell.y);
  }
  draw();
});

canvas.addEventListener("pointermove", (event) => {
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
    changedDuringGesture = placeTool(event.buttons === 2 ? "erase" : selectedTool, cell.x, cell.y) || changedDuringGesture;
  }
  draw();
});

const finishGesture = () => { if (changedDuringGesture) recordHistory(); drawing = false; draggedEntityId = null; };
canvas.addEventListener("pointerup", finishGesture); canvas.addEventListener("pointercancel", finishGesture);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());
canvas.addEventListener("dragover", (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"; });
canvas.addEventListener("drop", (event) => {
  event.preventDefault(); const cell = cellFromEvent(event); if (!cell) return;
  const tool = event.dataTransfer?.getData("application/x-dungeon-tool") as ToolType;
  if (tools.some((definition) => definition.type === tool) && placeTool(tool, cell.x, cell.y)) recordHistory();
  draw();
});

document.querySelector("#resize-grid")!.addEventListener("click", () => {
  const nextWidth = Math.max(8, Math.min(100, Number(widthInput.value) || width));
  const nextHeight = Math.max(8, Math.min(100, Number(heightInput.value) || height));
  const oldWidth = width, oldTiles = tiles; width = nextWidth; height = nextHeight;
  tiles = Array.from({ length: width * height }, (_, index) => {
    const x = index % width, y = Math.floor(index / width);
    return x < oldWidth && y < oldTiles.length / oldWidth ? oldTiles[y * oldWidth + x]! : "void";
  });
  entities = entities.filter((entity) => inside(entity.x, entity.y));
  resizeCanvas(); recordHistory();
});

zoomInput.addEventListener("input", () => { cellSize = Number(zoomInput.value); resizeCanvas(); });
levelName.addEventListener("change", recordHistory);
document.querySelector("#undo")!.addEventListener("click", () => restoreHistory(historyIndex - 1));
document.querySelector("#redo")!.addEventListener("click", () => restoreHistory(historyIndex + 1));
document.querySelector("#save")!.addEventListener("click", () => { localStorage.setItem("rpg-dungeon-editor-level", snapshot()); status.textContent = "Saved locally"; });
document.querySelector("#play")!.addEventListener("click", async () => {
  const level = serialize();
  const gameWindow = window.open("about:blank", "_blank");
  status.textContent = "Starting game…";
  try {
    const response = await fetch("/api/editor-level", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(level),
    });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const { id } = await response.json() as { id: string };
    localStorage.setItem(`rpg-editor-level:${id}`, JSON.stringify(level));
    if (gameWindow) gameWindow.location.href = `/?editor=${encodeURIComponent(id)}`;
    else window.location.href = `/?editor=${encodeURIComponent(id)}`;
    status.textContent = "Opened in the game";
  } catch (error) {
    gameWindow?.close();
    status.textContent = error instanceof Error ? error.message : "Could not start game";
  }
});
document.querySelector("#load")!.addEventListener("click", () => {
  const saved = localStorage.getItem("rpg-dungeon-editor-level");
  if (!saved) { status.textContent = "No local save"; return; }
  try { applyLevel(normalizeLevel(JSON.parse(saved))); status.textContent = "Loaded local save"; } catch (error) { status.textContent = String(error); }
});
document.querySelector("#export")!.addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `${(levelName.value || "dungeon").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dungeon"}.json`;
  link.click(); URL.revokeObjectURL(link.href); status.textContent = "Exported JSON";
});
document.querySelector("#import")!.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const file = importFile.files?.[0]; if (!file) return;
  try { applyLevel(normalizeLevel(JSON.parse(await file.text()))); status.textContent = `Imported ${file.name}`; }
  catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  importFile.value = "";
});
document.querySelector("#clear")!.addEventListener("click", () => {
  if (!confirm("Clear the entire level?")) return;
  tiles = Array.from({ length: width * height }, () => "void" as TileType); entities = []; draw(); recordHistory(); status.textContent = "Level cleared";
});
window.addEventListener("keydown", (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (event.key.toLowerCase() === "z") { event.preventDefault(); restoreHistory(historyIndex + (event.shiftKey ? 1 : -1)); }
  if (event.key.toLowerCase() === "y") { event.preventDefault(); restoreHistory(historyIndex + 1); }
});

blankLevel(); resizeCanvas(); recordHistory();
