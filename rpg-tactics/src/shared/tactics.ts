/**
 * The real-time skirmish: board geometry, the rules that decide what a move or
 * an attack is allowed to be, and the snapshot both sides read.
 *
 * Pure and DOM-free, exactly like `src/shared/` — the client draws the board
 * from these functions and the server rules on it with the same ones, so what
 * is shown and what is allowed can't come apart.
 *
 * **The grid is fine and invisible.** It started as a literal 3x3 of squares you
 * hopped between; each of those is now `SUBDIVISION` cells across, which makes a
 * cell about half a pace wide. Nothing is drawn on the floor to mark them and
 * nothing snaps visibly, so movement reads as walking rather than as stepping
 * from tile to tile. The grid is a lattice for navigation and floor ownership,
 * while actors move continuously between its cells.
 *
 * Because of that, **every rule is expressed as a distance in room pixels**, not
 * as a count of cells. Subdividing further changes how finely navigation can
 * place actors and nothing else about the game.
 *
 * **Positions stay in room pixels.** Nothing here needs them to be, but the 3D
 * bridge (`rpg-3d/src/client/world.ts`) divides room pixels by 30 to get scene
 * units, and the 2D UI overlay is drawn in the same 1200x900 space — so keeping
 * one unit means the models, the HUD and the damage-number projection are all
 * the imported originals, unscaled.
 */

import { WORLD_HEIGHT, WORLD_WIDTH, type RoomCoord } from "../../../src/shared/constants.js";
import type { Point } from "../../../src/shared/movement.js";
import type { GameSnapshot, InputMessage } from "../../../src/shared/protocol.js";
import { ACTIONS, type Action } from "../../../src/shared/actions.js";

/** The fifth slot is empty now that dungeon doorways are permanently open. */
export const TACTICS_ACTIONS: readonly (Action | null)[] = [
  ...ACTIONS.slice(0, 4),
  null,
];

// ------------------------------------------------------------------- board

/**
 * How many cells make up one of the original squares. The opening positions and
 * every range below are unchanged in room pixels, so raising this makes
 * placement finer and changes nothing else — which is the entire point of it.
 */
export const SUBDIVISION = 5;

/** The enlarged starting chamber: six original squares by six. */
export const SQUARES = 6;
/** The far chamber matches the enlarged starting room. */
export const FAR_SQUARES = 6;
/** One of those squares, in room pixels — three 3D units, a good stride. */
export const SQUARE_PX = 90;

export const GRID_COLS = SQUARES * SUBDIVISION; // 30
export const GRID_ROWS = SQUARES * SUBDIVISION; // 30
export const FAR_GRID_COLS = FAR_SQUARES * SUBDIVISION;
export const FAR_GRID_ROWS = FAR_SQUARES * SUBDIVISION;

/** A single cell: 18px, about 0.6 of a 3D unit. Fine enough to read as smooth. */
export const TILE_PX = SQUARE_PX / SUBDIVISION;
/**
 * Wide enough for a 90px hound body to clear both jambs, while remaining
 * visibly narrower than the 180px corridor.
 */
export const DOORWAY_WIDTH_PX = SQUARE_PX * 1.6;

export interface Cell {
  col: number;
  row: number;
}

export const ARENA_W = SQUARES * SQUARE_PX; // 540
export const ARENA_H = SQUARES * SQUARE_PX;
/** The board sits in the middle of the room so the overlay's centred UI lines up. */
export const ARENA_X = (WORLD_WIDTH - ARENA_W) / 2;
export const ARENA_Y = (WORLD_HEIGHT - ARENA_H) / 2;

/**
 * Everything reports the same room, because there is only one — the dungeon
 * grid the real-time game roams is a single arena here. The imported overlay
 * filters world labels by `sameRoom`, so this just has to be consistent.
 */
export const ARENA_ROOM: RoomCoord = { col: 2, row: 2 };

export function cellCenter(cell: Cell): Point {
  return {
    x: ARENA_X + cell.col * TILE_PX + TILE_PX / 2,
    y: ARENA_Y + cell.row * TILE_PX + TILE_PX / 2,
  };
}

// --------------------------------------------------------- beyond the board

/**
 * **The board is no longer the world.** The doorway in the south wall used to be
 * a way *out of the game* — step on it and the encounter ended — and is now
 * simply a door: the corridor behind it and the chamber at the end of that are
 * ground you can stand on, so walking through it takes you somewhere instead of
 * finishing the fight.
 *
 * That makes "on the grid" a question about three rectangles rather than about
 * one, which is the only thing the change costs. Everything downstream —
 * reachability, the pack's approach, the footfall ring — asks `inGrid` and gets
 * the same answer it always did.
 */
export interface Region {
  col: number;
  row: number;
  cols: number;
  rows: number;
  size?: RoomSize;
}

export type RoomSize = "small" | "medium" | "large" | "jumbo";
const ROOM_CELLS: Record<RoomSize, number> = {
  small: 20,
  medium: 30,
  large: 40,
  jumbo: 50,
};

/** The arena itself: the fight starts here and usually ends here. */
export const BOARD_REGION: Region = {
  col: 0, row: 0, cols: GRID_COLS, rows: GRID_ROWS, size: "medium",
};

/** Reproducible procedural dungeon shared verbatim by simulation and renderer. */
export let DUNGEON_SEED = 0x574f4c46;
/** One safe spawn chamber followed by six procedurally populated rooms. */
const ROOM_COUNT = 7;
const PORTAL_ROOM_INDEX = ROOM_COUNT - 1;
const HALL_COLS = SUBDIVISION * 2;
const seededRandom = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
};

export type ConnectionSide = "north" | "east" | "south" | "west";
export interface DungeonConnection { from: number; to: number; side: ConnectionSide; hall: Region }

const generateDungeon = (seed: number) => {
  const dungeonRandom = seededRandom(seed);
  const rooms: Region[] = [BOARD_REGION];
  const connections: DungeonConnection[] = [];
  const directions: readonly ConnectionSide[] = ["north", "east", "south", "west"];
  // The fixed first chamber is reserved for player spawning. Six generated
  // rooms follow it, preserving the previous combat-room count while adding a
  // safe place to enter the dungeon.
  const remainingSizes: RoomSize[] = ["small", "medium", "medium", "medium", "large", "jumbo"];
  for (let i = remainingSizes.length - 1; i > 0; i--) {
    const j = Math.floor(dungeonRandom() * (i + 1));
    [remainingSizes[i], remainingSizes[j]] = [remainingSizes[j]!, remainingSizes[i]!];
  }
  const overlaps = (a: Region, b: Region, padding = 2) =>
    a.col < b.col + b.cols + padding && a.col + a.cols + padding > b.col &&
    a.row < b.row + b.rows + padding && a.row + a.rows + padding > b.row;

  for (let index = 1; index < ROOM_COUNT; index++) {
    const current = rooms[index - 1]!;
    const size = remainingSizes[index - 1]!;
    const roomCells = ROOM_CELLS[size];
    const corridorLength = [22, 28, 34, 40][Math.floor(dungeonRandom() * 4)]!;
    const start = Math.floor(dungeonRandom() * directions.length);
    let placed = false;
    for (let attempt = 0; attempt < directions.length; attempt++) {
      const side = directions[(start + attempt) % directions.length]!;
      let room: Region;
      let hall: Region;
      if (side === "south") {
        room = { col: current.col + (current.cols - roomCells) / 2, row: current.row + current.rows + corridorLength, cols: roomCells, rows: roomCells, size };
        hall = { col: current.col + (current.cols - HALL_COLS) / 2, row: current.row + current.rows, cols: HALL_COLS, rows: corridorLength };
      } else if (side === "north") {
        room = { col: current.col + (current.cols - roomCells) / 2, row: current.row - corridorLength - roomCells, cols: roomCells, rows: roomCells, size };
        hall = { col: current.col + (current.cols - HALL_COLS) / 2, row: current.row - corridorLength, cols: HALL_COLS, rows: corridorLength };
      } else if (side === "east") {
        room = { col: current.col + current.cols + corridorLength, row: current.row + (current.rows - roomCells) / 2, cols: roomCells, rows: roomCells, size };
        hall = { col: current.col + current.cols, row: current.row + (current.rows - HALL_COLS) / 2, cols: corridorLength, rows: HALL_COLS };
      } else {
        room = { col: current.col - corridorLength - roomCells, row: current.row + (current.rows - roomCells) / 2, cols: roomCells, rows: roomCells, size };
        hall = { col: current.col - corridorLength, row: current.row + (current.rows - HALL_COLS) / 2, cols: corridorLength, rows: HALL_COLS };
      }
      if (rooms.slice(0, -1).some((existing) => overlaps(room, existing)) ||
          connections.some((existing) => overlaps(room, existing.hall))) continue;
      rooms.push(room); connections.push({ from: index - 1, to: index, side, hall });
      placed = true;
      break;
    }
    if (!placed) {
      const room: Region = { col: current.col + current.cols + corridorLength, row: current.row + (current.rows - roomCells) / 2, cols: roomCells, rows: roomCells, size };
      const hall = { col: current.col + current.cols, row: current.row + (current.rows - HALL_COLS) / 2, cols: corridorLength, rows: HALL_COLS };
      rooms.push(room); connections.push({ from: index - 1, to: index, side: "east", hall });
    }
  }
  return { rooms, connections };
};

let GENERATED_DUNGEON = generateDungeon(DUNGEON_SEED);
export let ROOM_REGIONS: readonly Region[] = GENERATED_DUNGEON.rooms;
export let DUNGEON_CONNECTIONS: readonly DungeonConnection[] = GENERATED_DUNGEON.connections;
export let HALL_REGIONS: readonly Region[] = DUNGEON_CONNECTIONS.map((connection) => connection.hall);

// Compatibility names retained for the existing camera and door API.
export let FAR_REGION = ROOM_REGIONS[1]!;
export let BAT_REGION = ROOM_REGIONS.at(-1)!;
export let HALL_REGION = HALL_REGIONS[0]!;
export let BAT_HALL_REGION = HALL_REGIONS[1]!;
export let HALL_ROWS = HALL_REGION.rows;
export let REGIONS: readonly Region[] = ROOM_REGIONS.flatMap((room, index) =>
  index < HALL_REGIONS.length ? [room, HALL_REGIONS[index]!] : [room]);

export interface DungeonEnemySpawn { kind: "hellhound" | "bat" | "spider"; cell: Cell; roomIndex: number }
/** One to four enemies per combat room; room zero is always the safe spawn. */
const generateEnemies = (seed: number, rooms: readonly Region[]): readonly DungeonEnemySpawn[] => {
  const enemyRandom = seededRandom(seed ^ 0x9e3779b9);
  const result: DungeonEnemySpawn[] = [];
  const spots = [[0.7, 0.7], [0.3, 0.7], [0.7, 0.3], [0.3, 0.3]] as const;
  rooms.forEach((room, roomIndex) => {
    // Room zero is the dedicated player spawn chamber and is always safe.
    if (roomIndex === 0 || roomIndex === PORTAL_ROOM_INDEX) return;
    const size = room.size ?? "medium";
    const count = size === "small" ? Math.floor(enemyRandom() * 2)
        : size === "medium" ? 1 + Math.floor(enemyRandom() * 3)
          : size === "large" ? 1 + Math.floor(enemyRandom() * 4)
            : 4;
    const families: readonly DungeonEnemySpawn["kind"][] = ["hellhound", "bat", "spider"];
    const primary = families[Math.floor(enemyRandom() * families.length)]!;
    const secondPairKind: DungeonEnemySpawn["kind"] = enemyRandom() < 0.65
      ? primary : families[(families.indexOf(primary) + 1 + Math.floor(enemyRandom() * 2)) % families.length]!;
    for (let index = 0; index < count; index++) {
      const kind = index < 2 ? primary : secondPairKind;
      const [across, down] = spots[index]!;
      result.push({
        kind, roomIndex,
        cell: {
          col: room.col + Math.floor(room.cols * across),
          row: room.row + Math.floor(room.rows * down),
        },
      });
    }
  });
  return result;
};

export let DUNGEON_ENEMIES: readonly DungeonEnemySpawn[] = generateEnemies(DUNGEON_SEED, ROOM_REGIONS);

/** Seventy percent of dungeons contain exactly two trapped, non-jumbo combat rooms. */
const generatePressurePlateRooms = (seed: number, rooms: readonly Region[]): readonly number[] => {
  const random = seededRandom(seed ^ 0x51a7e5);
  // Warm the tiny xorshift generator so adjacent numeric seeds do not share
  // the same high-level feature roll.
  random(); random(); random();
  if (random() >= 0.7) return [];
  const eligible = rooms.map((_, index) => index).filter(
    (index) => index !== 0 && index !== PORTAL_ROOM_INDEX && rooms[index]!.size !== "jumbo",
  );
  for (let index = eligible.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [eligible[index], eligible[swap]] = [eligible[swap]!, eligible[index]!];
  }
  return eligible.slice(0, 2);
};

export let PRESSURE_PLATE_ROOMS: readonly number[] = generatePressurePlateRooms(DUNGEON_SEED, ROOM_REGIONS);

export interface PressurePlateDefinition {
  id: string;
  roomIndex: number;
  connectionIndex: number;
  position: Point;
}

const generatePressurePlates = (): readonly PressurePlateDefinition[] =>
  PRESSURE_PLATE_ROOMS.flatMap((roomIndex) => {
    const room = ROOM_REGIONS[roomIndex]!;
    const centre = regionCentre(room);
    const offset = Math.min(room.cols, room.rows) * TILE_PX * 0.2;
    return DUNGEON_CONNECTIONS.flatMap((connection, connectionIndex) => {
      if (connection.from !== roomIndex && connection.to !== roomIndex) return [];
      const toward = regionCentre(connection.hall);
      const dx = toward.x - centre.x;
      const dy = toward.y - centre.y;
      const length = Math.max(0.001, Math.hypot(dx, dy));
      return [{
        id: `${roomIndex}:${connectionIndex}`,
        roomIndex,
        connectionIndex,
        position: {
          x: centre.x + (dx / length) * offset,
          y: centre.y + (dy / length) * offset,
        },
      }];
    });
  });

export let PRESSURE_PLATES: readonly PressurePlateDefinition[] = generatePressurePlates();

const generateSpikeTrapRoom = (seed: number): number | null => {
  const random = seededRandom(seed ^ 0x5f1ce7a9);
  random(); random(); random();
  if (random() >= 0.7) return null;
  const eligible = ROOM_REGIONS.map((_, index) => index).filter(
    (index) => index !== 0 && index !== PORTAL_ROOM_INDEX
      && ROOM_REGIONS[index]!.size !== "jumbo"
      && !PRESSURE_PLATE_ROOMS.includes(index),
  );
  return eligible[Math.floor(random() * eligible.length)] ?? null;
};

export let SPIKE_TRAP_ROOM: number | null = generateSpikeTrapRoom(DUNGEON_SEED);

export interface DungeonPortalDefinition {
  roomIndex: number;
  side: ConnectionSide;
  exitRegion: Region;
  position: Point;
  holePosition: Point;
}
export interface PurpleGemDefinition { roomIndex: number; position: Point }

const generatePortalAndGem = (seed: number): { portal: DungeonPortalDefinition; gem: PurpleGemDefinition } => {
  const random = seededRandom(seed ^ 0x9a7e6d31);
  random(); random(); random();
  // The final chamber is reserved as a quiet, single-entrance portal dead end.
  const portalRoomIndex = PORTAL_ROOM_INDEX;
  const room = ROOM_REGIONS[portalRoomIndex]!;
  const entrance = DUNGEON_CONNECTIONS.find((connection) => connection.to === portalRoomIndex)!;
  const side: ConnectionSide = entrance.side === "north" ? "south"
    : entrance.side === "south" ? "north"
      : entrance.side === "east" ? "west" : "east";
  const exitRegion = entrance.hall;
  const portalPosition = regionCentre(exitRegion);
  const holePosition = regionCentre(room);

  const gemRooms = ROOM_REGIONS.map((_, index) => index).filter((index) =>
    index !== 0 && index !== portalRoomIndex && ROOM_REGIONS[index]!.size !== "jumbo"
      && index !== SPIKE_TRAP_ROOM);
  const gemRoomIndex = gemRooms[Math.floor(random() * gemRooms.length)]!;
  const gemRoom = ROOM_REGIONS[gemRoomIndex]!;
  const gemCentre = regionCentre(gemRoom);
  let gemPosition = gemCentre;
  if (random() >= 0.5) {
    const corner = Math.floor(random() * 4);
    const inset = TILE_PX * 2.2;
    gemPosition = {
      x: ARENA_X + (corner === 0 || corner === 3 ? gemRoom.col * TILE_PX + inset : (gemRoom.col + gemRoom.cols) * TILE_PX - inset),
      y: ARENA_Y + (corner < 2 ? gemRoom.row * TILE_PX + inset : (gemRoom.row + gemRoom.rows) * TILE_PX - inset),
    };
  }
  return { portal: { roomIndex: portalRoomIndex, side, exitRegion, position: portalPosition, holePosition }, gem: { roomIndex: gemRoomIndex, position: gemPosition } };
};

let GENERATED_PORTAL = generatePortalAndGem(DUNGEON_SEED);
export let DUNGEON_PORTAL = GENERATED_PORTAL.portal;
export let PURPLE_GEM = GENERATED_PORTAL.gem;

/** The one exit a room's plate may bar: always the doorway farther from spawn. */
export function pressurePlateClosedConnection(roomIndex: number): DungeonConnection | undefined {
  const spawn = cellCenter(PLAYER_START);
  return DUNGEON_CONNECTIONS
    .filter((connection) => connection.from === roomIndex || connection.to === roomIndex)
    .sort((left, right) => {
      const leftCentre = regionCentre(left.hall);
      const rightCentre = regionCentre(right.hall);
      return distance(rightCentre, spawn) - distance(leftCentre, spawn);
    })[0];
}

/** The doorway nearer spawn, which closes when the far doorway is opened. */
export function pressurePlateNearConnection(roomIndex: number): DungeonConnection | undefined {
  const far = pressurePlateClosedConnection(roomIndex);
  return DUNGEON_CONNECTIONS.find((connection) =>
    connection !== far && (connection.from === roomIndex || connection.to === roomIndex));
}

/** Rebuild every derived layout value before constructing the stage/game. */
export function configureDungeon(seed: number): void {
  DUNGEON_SEED = seed >>> 0 || 1;
  GENERATED_DUNGEON = generateDungeon(DUNGEON_SEED);
  ROOM_REGIONS = GENERATED_DUNGEON.rooms;
  DUNGEON_CONNECTIONS = GENERATED_DUNGEON.connections;
  HALL_REGIONS = DUNGEON_CONNECTIONS.map((connection) => connection.hall);
  FAR_REGION = ROOM_REGIONS[1]!;
  BAT_REGION = ROOM_REGIONS.at(-1)!;
  HALL_REGION = HALL_REGIONS[0]!;
  BAT_HALL_REGION = HALL_REGIONS[1]!;
  HALL_ROWS = HALL_REGION.rows;
  REGIONS = ROOM_REGIONS.flatMap((room, index) =>
    index < HALL_REGIONS.length ? [room, HALL_REGIONS[index]!] : [room]);
  DUNGEON_ENEMIES = generateEnemies(DUNGEON_SEED, ROOM_REGIONS);
  PRESSURE_PLATE_ROOMS = generatePressurePlateRooms(DUNGEON_SEED, ROOM_REGIONS);
  PRESSURE_PLATES = generatePressurePlates();
  SPIKE_TRAP_ROOM = generateSpikeTrapRoom(DUNGEON_SEED);
  GENERATED_PORTAL = generatePortalAndGem(DUNGEON_SEED);
  DUNGEON_PORTAL = GENERATED_PORTAL.portal;
  PURPLE_GEM = GENERATED_PORTAL.gem;
}

export type DoorId = "arena" | "far";
export type DoorStates = Record<DoorId, boolean>;

/** Chamber dressing expressed in simulation pixels so doors and collision agree. */
export const CHAMBER_MARGIN_PX = TILE_PX * 1.5;
export const WALL_THICKNESS_PX = TILE_PX * 0.7;
export const DOOR_Y: Record<DoorId, number> = {
  arena: ARENA_Y + (BOARD_REGION.row + BOARD_REGION.rows) * TILE_PX
    + CHAMBER_MARGIN_PX + WALL_THICKNESS_PX / 2,
  far: ARENA_Y + FAR_REGION.row * TILE_PX
    - CHAMBER_MARGIN_PX - WALL_THICKNESS_PX / 2,
};
/** Keep an actor's centre far enough back that its body/camera cannot enter the slab. */
export const DOOR_CLEARANCE_PX = TILE_PX * 0.75;

/** A region's middle, in room pixels — where the client frames and lights it. */
export function regionCentre(region: Region): Point {
  return {
    x: ARENA_X + (region.col + region.cols / 2) * TILE_PX,
    y: ARENA_Y + (region.row + region.rows / 2) * TILE_PX,
  };
}

/** The cell a room point falls in, or null when the point is off the floor. */
export function cellAtPoint(point: Point): Cell | null {
  const cell = {
    col: Math.floor((point.x - ARENA_X) / TILE_PX),
    row: Math.floor((point.y - ARENA_Y) / TILE_PX),
  };
  return inGrid(cell) ? cell : null;
}

/**
 * The nearest standable cell to a point, clamped rather than refused. With more
 * than one rectangle to land in it is "clamp into each, keep the closest" — the
 * corridor is narrow, so a point out in the masonry beside it must not snap back
 * to the arena when the hall is a pace away.
 */
export function clampToGrid(point: Point): Cell {
  let best: Cell | null = null;
  let bestGap = Infinity;
  for (const region of REGIONS) {
    const cell = {
      col: clampInt(Math.floor((point.x - ARENA_X) / TILE_PX), region.col, region.col + region.cols - 1),
      row: clampInt(Math.floor((point.y - ARENA_Y) / TILE_PX), region.row, region.row + region.rows - 1),
    };
    const gap = distance(point, cellCenter(cell));
    if (gap < bestGap) { bestGap = gap; best = cell; }
  }
  return best!;
}

function clampInt(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

function clampFloat(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Clamp a point to the nearest walkable position, in room pixels. Each region
 * is tried independently and the closest result wins — so a point in the
 * masonry beside the corridor snaps into the hall rather than across the room.
 *
 * **A point already standing on floor is returned untouched, and that is what
 * makes doorways passable.** The fallback below clamps into a box running
 * centre-to-centre of a region's outermost cells, which stops half a tile short
 * of where its cells actually end — so between two regions that meet, one whole
 * cell belonged to neither box and every point in it was snapped back to one
 * side or the other. That is a wall, and it stood exactly in the doorway.
 *
 * The player crossed it only by being fast enough to jump it in a single step
 * (200px/s, 10px a tick, against the 9px needed); a hellhound at 140px/s moves
 * 7px and was thrown back to the threshold every tick, for ever. Hounds could
 * not follow you out of the room at all.
 *
 * Asking `cellAtPoint` first removes the seam rather than papering over it,
 * because a cell *is* the unit of floor — it is the same question `inGrid` and
 * `clampToGrid` already answer, and those never had the gap. The cost is that
 * an actor may now stand half a tile nearer a wall than before; against a
 * 45px-wide model that already overlaps the masonry it is not a visible change.
 */
export function clampPointToFloor(point: Point): Point {
  if (cellAtPoint(point)) return { x: point.x, y: point.y };

  let best: Point | null = null;
  let bestGap = Infinity;
  for (const region of REGIONS) {
    const minX = ARENA_X + region.col * TILE_PX + TILE_PX / 2;
    const maxX = ARENA_X + (region.col + region.cols - 1) * TILE_PX + TILE_PX / 2;
    const minY = ARENA_Y + region.row * TILE_PX + TILE_PX / 2;
    const maxY = ARENA_Y + (region.row + region.rows - 1) * TILE_PX + TILE_PX / 2;
    const clamped = {
      x: clampFloat(point.x, minX, maxX),
      y: clampFloat(point.y, minY, maxY),
    };
    const gap = distance(point, clamped);
    if (gap < bestGap) { bestGap = gap; best = clamped; }
  }
  return best!;
}

export function inRegion(region: Region, cell: Cell): boolean {
  return (
    cell.col >= region.col && cell.col < region.col + region.cols &&
    cell.row >= region.row && cell.row < region.row + region.rows
  );
}

export function inGrid(cell: Cell): boolean {
  return REGIONS.some((region) => inRegion(region, cell));
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ------------------------------------------------------------------- layout

/**
 * The player starts near the middle of the chamber; the lone hellhound waits
 * in the southeast bay beside the arena door.
 *
 * ```
 *   . . . . . .
 *   . . . . . .
 *   . . . . . .
 *   . . @ . . .
 *   . . . . . .
 *   . . . . . h  D is directly south of the hound's bay.
 * ```
 *
 * `SUBDIVISION` is odd, so the hound can remain centered in its original bay;
 * the player uses the two central grid axes directly.
 */
const HALF = Math.floor(SUBDIVISION / 2);
const squareCentre = (col: number, row: number): Cell => ({
  col: col * SUBDIVISION + HALF,
  row: row * SUBDIVISION + HALF,
});

export const PLAYER_START: Cell = {
  col: Math.floor((GRID_COLS - 1) / 2),
  row: Math.floor(GRID_ROWS / 2),
};
/** The southern hound starts closest to the arena door. */
export const HOUND_STARTS: readonly Cell[] = [squareCentre(SQUARES - 1, SQUARES - 1)];

// The doorway is not a cell any more, it is the mouth of `HALL_REGION` — see
// the regions above. It used to end the encounter; now it only leads out of the
// room, with the pack still between you and it from the first turn.

// -------------------------------------------------------------------- ranges

/**
 * How far anything travels in one turn — one of the original squares' worth of
 * ground. What changed when the grid was subdivided is *where you may stop*,
 * not how far you get.
 *
 * For the player it is **a price rather than a limit**: they may click any floor
 * there is and they will walk to it, taking a round per square's worth of ground
 * and letting the pack answer in each. A long walk is a commitment, not a
 * refused click. The hellhounds are gated by it in the old way — one leg per
 * turn, because a turn is all they get.
 */
export const MOVE_RANGE = SQUARE_PX;

/**
 * How close a blade or bite has to be. The rendered wolves are deliberately
 * larger than one original board square now, so combat needs to resolve before
 * their visible bodies overlap.
 */
export const MELEE_RANGE = SQUARE_PX * 1.5;

/**
 * How close you have to come before a hellhound notices you — deliberately a
 * little wider than its reach, so a hound wakes a moment before it can bite.
 */
export const AGGRO_RANGE = MELEE_RANGE * 1.2;

/**
 * How close you have to come before the game warns you that you are *about* to
 * be noticed. Half a square outside the wake range itself.
 *
 * Aggro is permanent and there are no second chances at it, which is what makes
 * a warning worth having: the difference between waking one hellhound and two
 * is the difference between a fight you can win and one you cannot, and without
 * this the only way to find the line was to cross it.
 *
 * **A full square was tried first and was worse.** The arena is only three
 * squares across, so a band that wide is lit before the player has moved — the
 * opening position is 180px from the nearest hound — and a warning that is
 * already on tells you nothing. Half a square puts the opening board outside
 * it, so the eye *opening* is the signal rather than the eye existing.
 */
export const AGGRO_WARN_RANGE = AGGRO_RANGE + SQUARE_PX / 2;


/** Nothing may stand inside anything else. Roughly a body's width. */
export const MIN_SEPARATION = SQUARE_PX * 0.5;

// --------------------------------------------------------------------- rules

/**
 * **Reach is a circle: anything within `MELEE_RANGE` can be hit, from any
 * direction.** Symmetric, so it gates the hellhounds' bite exactly as it gates
 * the player's sword.
 *
 * It used to carry a cone as well — `|dx| >= |dy|`, "reach goes sideways and
 * across, never straight up or down" — inherited from the 3x3 board, where it
 * read as "one column across, at most one row up or down" and made sense to
 * someone looking down at a grid. **Two later changes killed it.**
 *
 * The camera came down to eye level, where the rule is invisible: a hellhound
 * one pace in front of you, filling the screen, marked, is a hound your sword
 * passes straight through, three swings running, with nothing on screen saying
 * why. The cone was a fact about world axes, and first person gives the player
 * no sense of where those are.
 *
 * Then the corridor made it not merely opaque but unplayable. The hall runs
 * north-south and is one square wide, so *every* approach in it is along y, and
 * along y was precisely what the cone forbade. Neither side could touch the
 * other in there — and since time only moves when something acts, two actors
 * who cannot act is a standoff that never resolves.
 */
export function canReach(from: Point, to: Point): boolean {
  return distance(from, to) <= MELEE_RANGE;
}

/** Close enough for a hellhound to notice you. A circle, not a cone. */
export function withinAggro(a: Point, b: Point): boolean {
  return distance(a, b) <= AGGRO_RANGE;
}

/** Which way a model should face to look from `from` at `to`. Held on a tie. */
export function facingToward(from: Point, to: Point, held: 1 | -1): 1 | -1 {
  if (to.x > from.x + 0.001) return 1;
  if (to.x < from.x - 0.001) return -1;
  return held;
}

/**
 * The cells a hellhound would like to be standing in: every one within reach of
 * the player that its own reach rule allows — which is what pushes the pack to
 * come at you from the sides rather than from directly above or below, and falls
 * out of `canReach` rather than being a second rule the AI has to remember.
 *
 * **This is a search of the floor, not a ring around the player**, and it has to
 * be, now that the floor is not one rectangle. A ring at four-fifths of biting
 * distance was the same idea while the game was played in a 9x9 room: the two
 * points on it that a hound could bite from lie a long way out to the left and
 * right, and in a room they are always floor. In the corridor they are both
 * inside the masonry, so every candidate was unstandable and the pack would
 * follow you through the door and then stand there for the rest of the game,
 * hemmed in, while you were beside them. Asking the grid instead gives the same
 * answer in the room and a real one in the hall.
 */
export function approachCells(target: Point): Cell[] {
  const centre = clampToGrid(target);
  const span = Math.ceil(MELEE_RANGE / TILE_PX);
  const cells: Cell[] = [];
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      const cell = { col: centre.col + dc, row: centre.row + dr };
      if (!inGrid(cell)) continue;
      if (canReach(cellCenter(cell), target)) cells.push(cell);
    }
  }
  return cells;
}

/** Step from `from` toward `to`, stopping at `limit` px if it is further. */
export function stepToward(from: Point, to: Point, limit: number): Point {
  const gap = distance(from, to);
  if (gap <= limit || gap === 0) return { x: to.x, y: to.y };
  const t = limit / gap;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

// ------------------------------------------------------ stats and cadence

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_MANA = 50;

export const HOUND_MAX_HEALTH = 150;

/**
 * Damage is tuned so the fight is a race the player can lose. Three sword blows
 * put a hound down; two hounds biting take a third of you every round. Standing
 * and trading with both of them does not work, which is why the door is open:
 * giving ground down the corridor is the answer to it. It is no longer a way to
 * *win* — the pack follows you through — only a way to keep moving.
 */
export const MELEE_DAMAGE = 8;
export const RANGED_DAMAGE = 5;
export const HOUND_DAMAGE = 7;

/** How long a full-length walk takes to play out (ms). Short hops take less. */
export const STEP_MS = 420;
/** A swing, start to finish (ms). */
export const ATTACK_MS = 520;
/** After a thrown dagger lands, before the turn passes (ms). */
export const THROW_RECOVER_MS = 220;
/** A beat between one actor finishing and the next starting (ms). */
export const TURN_GAP_MS = 240;

/** Delay before an auto-restart fires after death (ms), measured from the death. */
export const AUTO_RESTART_DELAY_MS = 3000;

/** How many lines of the turn log the client shows. */
export const LOG_LINES = 4;

// ----------------------------------------------------------------- protocol

/**
 * Where the encounter is. `player` and `enemy` alternate; the other three are
 * terminal and wait for a restart.
 */
export type Phase = "player" | "enemy" | "cleared" | "dead";

export function isOver(phase: Phase): boolean {
  return phase === "cleared" || phase === "dead";
}

/**
 * The real-time game's snapshot, plus what a turn-based board needs on top.
 *
 * Extending rather than replacing is what lets the whole client stack —
 * `Actors`, `applyCues`, `interpolateSnapshot`, the entire 2D overlay — be
 * *imported* from the real-time front end instead of rewritten. They read the
 * fields they always read; the extra ones ride along untouched.
 */
export interface TacticsSnapshot extends GameSnapshot {
  pressurePlates: Array<{ id: string; roomIndex: number; connectionIndex: number; active: boolean }>;
  spikeTrap: { roomIndex: number; active: boolean } | null;
  dungeonPortal: { roomIndex: number; side: ConnectionSide; unlocked: boolean; fallProgress: number };
  purpleGem: { x: number; y: number; destroyed: boolean };
  nextDungeonSeed: number | null;
  /** Full player heading, independent of the camera's orbit. */
  playerHeading: Point;
  /** Whether Shift sprint is currently held. */
  playerRunning: boolean;
  /** True during the one-second corpse-eating action. */
  playerEating: boolean;
  /** True means open. The two corridor doors are independently operated. */
  doors: DoorStates;
  targetDoor: DoorId | null;
  /** One server-authoritative usability flag for each action-bar slot. */
  viableActions: boolean[];
  phase: Phase;
  /** 1-based, incremented when the player's turn comes back around. */
  round: number;
  /**
   * How much ground a round of walking covers, in px, and where from. Zero off
   * turn, which is all the client reads it for now: a click is legal anywhere
   * there is floor, so this no longer says where the player may go — only what
   * going there will cost them per round.
   */
  moveRange: number;
  moveFrom: { x: number; y: number };
  /** Reach, so the client can show what the selected weapon would cover. */
  meleeRange: number;
  /**
   * True once *any* hellhound is awake — they wake one at a time, so this is
   * only good for "has anything started yet". Whether a particular hound is
   * hunting you is on its own entry in `enemies`.
   */
  aggro: boolean;
  /**
   * Close enough to a *sleeping* hellhound to be about to wake it — the band
   * between `AGGRO_RANGE` and `AGGRO_WARN_RANGE`. Goes false the moment the
   * thing actually wakes, at which point `aggro` takes over saying so.
   */
  nearAggro: boolean;
  /**
   * Whether the player is holding time open. On the wire rather than tracked by
   * the client that sent it, so the button's lit state is the server's answer
   * and cannot drift from the thing actually running the world.
   */
  waiting: boolean;
  /**
   * Every blow the pack landed in the round just resolved, each with a counter
   * that ticks once per blow. The client lunges every one whose seq it has not
   * seen before.
   *
   * This exists because the real-time client can afford to *guess* who bit you
   * — it picks the nearest thing hunting you — and a turn-based board cannot.
   * Two hellhounds standing either side of you both strike in the same round,
   * and a guess gives the animation to the same one twice while the other bites
   * you without moving. It is a *list* for the same reason once more: the round
   * resolves whole, so both blows land in one snapshot and a single field would
   * only ever animate the last of them. It stays state rather than events — the
   * seq is what changed, so a dropped or repeated snapshot can't double-play it.
   */
  strikes: Array<{ enemyId: string; seq: number }>;
  /** Newest last; the client draws the tail. */
  log: string[];
  /** One contextual gameplay hint. */
  hint: string;
  /**
   * Legacy compatibility field. The real-time server always reports false
   * because its simulation advances continuously.
   */
  paused: boolean;
}

/**
 * Input messages used by the real-time tactical game.
 *
 * `slot` has *lost* meaning rather than gained it: it now only chooses a weapon.
 * Committing the turn is `attack` or `wait`, which is why they are messages of
 * their own rather than a flag on `slot` — one button ends your turn and the
 * other doesn't, and that difference should be visible in the protocol.
 *
 * `click` and `dblclick` still carry a *room point* rather than a cell: the 3D
 * client resolves what was under the cursor before it sends, so the server keeps
 * deciding what a click landed on — including the ✕ on the inspect menu, whose
 * geometry is shared in room units.
 */
export type TacticsInput =
  | InputMessage
  | { type: "restart" }
  /** Swing the selected weapon at the mark, landing or not. */
  | { type: "attack" }
  /** Activate a bar slot immediately without changing keyboard selection. */
  | { type: "useSlot"; index: number }
  /** Move along dx/dy; reverse movement can explicitly preserve facing. */
  | { type: "move"; dx: number; dy: number; turn?: boolean; run?: boolean }
  | { type: "face"; dx: number; dy: number }
  | { type: "jump" }
  | { type: "targetDoor"; door: DoorId }
  /** Use the selected action. */
  | { type: "interact"; dx: number; dy: number }
  | { type: "toggleDoor"; door: DoorId; dx: number; dy: number }
  /**
   * Hold time open. Unlike every other action this is a *state*, not a moment:
   * `held` goes true when the button or `.` goes down and false when it comes
   * back up, and the world runs for exactly as long as it is true.
   */
  | { type: "wait"; held: boolean };
