/** Values shared across the game. */

/**
 * Room size in room units. The canvas scales this 4:3 rectangle to fit the
 * window; at roughly 1200x900 of screen it renders 1:1, which is the size
 * everything was drawn at originally.
 */
export const WORLD_WIDTH = 1200;
export const WORLD_HEIGHT = 900;

/** Half-size of a player glyph, used to keep '@' fully inside the room. */
export const PLAYER_RADIUS = 10;

/** Movement speed in pixels per second. */
export const PLAYER_SPEED = 220;

/** Show the "(You)" tag when the cursor comes within this many units of the player. */
export const NAME_REVEAL_DISTANCE = 60;

/** How close to an edge the cursor must be for the exit arrow to appear. */
export const EDGE_HOVER_MARGIN = 48;

/**
 * A glyph grid laid over each room, used only for rendering — movement stays
 * pixel-based and ignores it. A cell is invisible until something places a
 * glyph in it. 30 divides both room dimensions exactly, so cells tile cleanly.
 */
export const CELL_SIZE = 30;
export const GRID_COLS = WORLD_WIDTH / CELL_SIZE; // 40
export const GRID_ROWS = WORLD_HEIGHT / CELL_SIZE; // 30

// ------------------------------------------------------------------- dungeon

export const DUNGEON_COLS = 3;
export const DUNGEON_ROWS = 3;

export interface RoomCoord {
  col: number;
  row: number;
}

/** The player spawns in the middle of the 3x3 grid. */
export const START_ROOM: RoomCoord = { col: 1, row: 1 };

export type Direction = "north" | "east" | "south" | "west";

export const DIRECTIONS: readonly Direction[] = ["north", "east", "south", "west"];

const DELTAS: Record<Direction, RoomCoord> = {
  north: { col: 0, row: -1 },
  east: { col: 1, row: 0 },
  south: { col: 0, row: 1 },
  west: { col: -1, row: 0 },
};

/** Room names, indexed as `ROOM_NAMES[row][col]`. */
const ROOM_NAMES: readonly (readonly string[])[] = [
  ["Collapsed Stair", "Hall of Echoes", "Bone Larder"],
  ["Flooded Cistern", "Chamber of the Sigil", "Rusted Armory"],
  ["Mushroom Grotto", "Old Ossuary", "Whispering Vault"],
];

export function isInsideDungeon(room: RoomCoord): boolean {
  return room.col >= 0 && room.col < DUNGEON_COLS && room.row >= 0 && room.row < DUNGEON_ROWS;
}

/** The room through the given exit, or null when that way is solid rock. */
export function neighborRoom(room: RoomCoord, direction: Direction): RoomCoord | null {
  const delta = DELTAS[direction];
  const next = { col: room.col + delta.col, row: room.row + delta.row };
  return isInsideDungeon(next) ? next : null;
}

export function sameRoom(a: RoomCoord, b: RoomCoord): boolean {
  return a.col === b.col && a.row === b.row;
}

export function roomName(room: RoomCoord): string {
  return ROOM_NAMES[room.row]?.[room.col] ?? `Room ${room.col},${room.row}`;
}

/** The player's position, room and appearance. */
export interface PlayerState {
  x: number;
  y: number;
  color: string;
  name: string;
  room: RoomCoord;
}
