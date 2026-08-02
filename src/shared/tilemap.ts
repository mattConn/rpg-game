/**
 * Pure tile-grid logic shared between server and client. No rendering — the
 * client wrapper keeps drawTiles and the TILE_FONT constant.
 */

import { CELL_SIZE, GRID_COLS, GRID_ROWS, type RoomCoord } from "./constants.js";
import type { Point } from "./movement.js";

export interface Tile {
  glyph: string;
  color: string;
  /** Solid cells are drawn as filled blocks and block movement. */
  solid?: boolean;
}

/** Centre of a cell in room (pixel) coordinates — where its glyph is drawn. */
export function cellCenter(col: number, row: number): Point {
  return { x: (col + 0.5) * CELL_SIZE, y: (row + 0.5) * CELL_SIZE };
}

/** The cell containing a room-space point, clamped to the grid. */
export function worldToCell(x: number, y: number): { col: number; row: number } {
  const col = Math.min(GRID_COLS - 1, Math.max(0, Math.floor(x / CELL_SIZE)));
  const row = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor(y / CELL_SIZE)));
  return { col, row };
}

export function inGrid(col: number, row: number): boolean {
  return col >= 0 && col < GRID_COLS && row >= 0 && row < GRID_ROWS;
}

/** One room's worth of glyph cells. Sparse — only placed cells are stored. */
export class TileLayer {
  private cells = new Map<number, Tile>();

  private index(col: number, row: number): number {
    return row * GRID_COLS + col;
  }

  get(col: number, row: number): Tile | undefined {
    return this.cells.get(this.index(col, row));
  }

  /** Placing outside the grid is a no-op rather than an error. */
  set(col: number, row: number, glyph: string, color: string): void {
    if (inGrid(col, row)) this.cells.set(this.index(col, row), { glyph, color });
  }

  /** A solid wall cell: drawn as its (thin) glyph, and blocks movement. */
  setWall(col: number, row: number, glyph: string, color: string): void {
    if (inGrid(col, row)) this.cells.set(this.index(col, row), { glyph, color, solid: true });
  }

  isSolid(col: number, row: number): boolean {
    return this.cells.get(this.index(col, row))?.solid === true;
  }

  clear(col: number, row: number): void {
    this.cells.delete(this.index(col, row));
  }

  *entries(): IterableIterator<[number, number, Tile]> {
    for (const [index, tile] of this.cells) {
      yield [index % GRID_COLS, Math.floor(index / GRID_COLS), tile];
    }
  }
}

// ------------------------------------------------------------- box-drawing walls

/**
 * Pick the single-line box-drawing glyph for a wall cell from which of its four
 * orthogonal neighbours are also walls. This is what makes a run of wall cells
 * read as connected corners and junctions rather than a field of one symbol.
 */
export function boxGlyph(north: boolean, east: boolean, south: boolean, west: boolean): string {
  const key = (north ? 1 : 0) | (east ? 2 : 0) | (south ? 4 : 0) | (west ? 8 : 0);
  // Indexed by the 4-bit N,E,S,W mask.
  return "\u25CB\u2575\u2576\u2514\u2577\u2502\u250C\u251C\u2574\u2518\u2500\u2534\u2510\u2524\u252C\u253C"[key]!;
}

/** Heavy box-drawing variant — thin but solid-looking connected walls. */
export function boxGlyphHeavy(north: boolean, east: boolean, south: boolean, west: boolean): string {
  const key = (north ? 1 : 0) | (east ? 2 : 0) | (south ? 4 : 0) | (west ? 8 : 0);
  return "\u25AA\u2579\u257A\u2517\u257B\u2503\u250F\u2523\u2578\u251B\u2501\u253B\u2513\u252B\u2533\u254B"[key]!;
}

const cellKey = (col: number, row: number) => row * GRID_COLS + col;

/**
 * Stamp a set of cells as connected walls, choosing each glyph from its
 * neighbours within the same set.
 */
export function stampWalls(layer: TileLayer, cells: Array<[number, number]>, color: string): void {
  const present = new Set(cells.map(([col, row]) => cellKey(col, row)));
  const has = (col: number, row: number) => present.has(cellKey(col, row));

  for (const [col, row] of cells) {
    layer.set(col, row, boxGlyph(has(col, row - 1), has(col + 1, row), has(col, row + 1), has(col - 1, row)), color);
  }
}

/**
 * Stamp a set of cells as solid walls, drawn as auto-tiled heavy box glyphs —
 * thin lines that still read as solid. Collision is per-cell regardless.
 */
export function fillWalls(layer: TileLayer, cells: Array<[number, number]>, color: string): void {
  const present = new Set(cells.map(([col, row]) => cellKey(col, row)));
  const has = (col: number, row: number) => present.has(cellKey(col, row));

  for (const [col, row] of cells) {
    layer.setWall(col, row, boxGlyphHeavy(has(col, row - 1), has(col + 1, row), has(col, row + 1), has(col - 1, row)), color);
  }
}

// ------------------------------------------------------------------- collision

const COLLISION_EPSILON = 0.01;

/** Whether a pixel point lies in a solid cell. */
export function isSolidAtPixel(layer: TileLayer | undefined, x: number, y: number): boolean {
  if (!layer) return false;
  const { col, row } = worldToCell(x, y);
  return layer.isSolid(col, row);
}

/**
 * Whether the segment (x0,y0)->(x1,y1) passes through any solid cell. Sampled
 * finer than a cell so a fast projectile can't tunnel a one-cell-thick wall.
 */
export function segmentHitsWall(
  layer: TileLayer | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  if (!layer) return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (CELL_SIZE / 2)));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (isSolidAtPixel(layer, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)) return true;
  }
  return false;
}

/** Any solid cell in column `col` across rows `r0..r1`. */
function columnBlocked(layer: TileLayer, col: number, r0: number, r1: number): boolean {
  for (let row = r0; row <= r1; row++) if (layer.isSolid(col, row)) return true;
  return false;
}

/** Any solid cell in row `row` across columns `c0..c1`. */
function rowBlocked(layer: TileLayer, row: number, c0: number, c1: number): boolean {
  for (let col = c0; col <= c1; col++) if (layer.isSolid(col, row)) return true;
  return false;
}

/**
 * Slide a `half`-sized square from (x0,y0) toward (x1,y1) against the layer's
 * solid cells, one axis at a time so the player slips along walls instead of
 * sticking. The leading edge is swept across every cell it crosses, so a large
 * step can't tunnel through a wall. Movement stays pixel-based; only wall cells
 * block. A tiny epsilon keeps the box just shy of a wall so resting against one
 * doesn't falsely block the perpendicular axis.
 */
export function resolveMove(
  layer: TileLayer | undefined,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  half: number,
): { x: number; y: number } {
  if (!layer) return { x: x1, y: y1 };

  // X first, against the span the player occupies vertically before moving.
  let x = x1;
  if (x1 > x0) {
    const r0 = Math.floor((y0 - half) / CELL_SIZE);
    const r1 = Math.floor((y0 + half) / CELL_SIZE);
    const from = Math.floor((x0 + half) / CELL_SIZE);
    const to = Math.floor((x1 + half) / CELL_SIZE);
    for (let col = from; col <= to; col++) {
      if (columnBlocked(layer, col, r0, r1)) {
        x = col * CELL_SIZE - half - COLLISION_EPSILON;
        break;
      }
    }
  } else if (x1 < x0) {
    const r0 = Math.floor((y0 - half) / CELL_SIZE);
    const r1 = Math.floor((y0 + half) / CELL_SIZE);
    const from = Math.floor((x0 - half) / CELL_SIZE);
    const to = Math.floor((x1 - half) / CELL_SIZE);
    for (let col = from; col >= to; col--) {
      if (columnBlocked(layer, col, r0, r1)) {
        x = (col + 1) * CELL_SIZE + half + COLLISION_EPSILON;
        break;
      }
    }
  }

  // Then Y, against the already-resolved horizontal span.
  let y = y1;
  const c0 = Math.floor((x - half) / CELL_SIZE);
  const c1 = Math.floor((x + half) / CELL_SIZE);
  if (y1 > y0) {
    const from = Math.floor((y0 + half) / CELL_SIZE);
    const to = Math.floor((y1 + half) / CELL_SIZE);
    for (let row = from; row <= to; row++) {
      if (rowBlocked(layer, row, c0, c1)) {
        y = row * CELL_SIZE - half - COLLISION_EPSILON;
        break;
      }
    }
  } else if (y1 < y0) {
    const from = Math.floor((y0 - half) / CELL_SIZE);
    const to = Math.floor((y1 - half) / CELL_SIZE);
    for (let row = from; row >= to; row--) {
      if (rowBlocked(layer, row, c0, c1)) {
        y = (row + 1) * CELL_SIZE + half + COLLISION_EPSILON;
        break;
      }
    }
  }

  return { x, y };
}

/** The border cells of a rectangle, minus any cells listed as gaps (doorways). */
export function rectBorder(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  gaps: Array<[number, number]> = [],
): Array<[number, number]> {
  const skip = new Set(gaps.map(([col, row]) => cellKey(col, row)));
  const out: Array<[number, number]> = [];

  for (let col = x0; col <= x1; col++) {
    for (let row = y0; row <= y1; row++) {
      const onBorder = col === x0 || col === x1 || row === y0 || row === y1;
      if (onBorder && !skip.has(cellKey(col, row))) out.push([col, row]);
    }
  }

  return out;
}

/** Per-room tile layers, keyed by room coordinate. */
export class Dungeon {
  private rooms = new Map<string, TileLayer>();

  private key(room: RoomCoord): string {
    return `${room.col},${room.row}`;
  }

  get(room: RoomCoord): TileLayer | undefined {
    return this.rooms.get(this.key(room));
  }

  /** Get the room's layer, creating an empty one on first use. */
  layer(room: RoomCoord): TileLayer {
    const existing = this.get(room);
    if (existing) return existing;
    const created = new TileLayer();
    this.rooms.set(this.key(room), created);
    return created;
  }
}
