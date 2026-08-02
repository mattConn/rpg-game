/**
 * Thin client wrapper around the shared tilemap module. Re-exports all pure
 * logic and keeps only the rendering function and its font constant.
 */

import { CELL_SIZE } from "../shared/constants.js";
import { cellCenter } from "../shared/tilemap.js";
import type { TileLayer } from "../shared/tilemap.js";

// Re-export everything the rest of the client already imports from here.
export {
  cellCenter,
  worldToCell,
  inGrid,
  TileLayer,
  boxGlyph,
  boxGlyphHeavy,
  stampWalls,
  fillWalls,
  isSolidAtPixel,
  segmentHitsWall,
  resolveMove,
  rectBorder,
  Dungeon,
  type Tile,
} from "../shared/tilemap.js";

// -------------------------------------------------------------------- rendering

/** Glyphs fill most of the cell so box-drawing lines meet across borders. */
const TILE_FONT = `${Math.round(CELL_SIZE * 0.92)}px monospace`;

export function drawTiles(ctx: CanvasRenderingContext2D, layer: TileLayer | undefined): void {
  if (!layer) return;

  ctx.font = TILE_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const [col, row, tile] of layer.entries()) {
    const center = cellCenter(col, row);
    ctx.fillStyle = tile.color;
    ctx.fillText(tile.glyph, center.x, center.y);
  }
}
