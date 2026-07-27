import type { Direction } from "../shared/constants.js";

/** Cursor shown when the mouse is not offering an exit. */
export const DEFAULT_CURSOR = "crosshair";

const ROTATION: Record<Direction, number> = {
  east: 0,
  south: 90,
  west: 180,
  north: 270,
};

/**
 * An arrow cursor drawn as an inline SVG, rotated to point at the exit. It is
 * stroked black underneath and white on top so it stays visible against both
 * the black floor and a brightly coloured player standing on the threshold.
 */
function arrowCursor(degrees: number): string {
  const arrow = "M6 16 H24 M17 9 L24 16 L17 23";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    `<g transform="rotate(${degrees} 16 16)" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${arrow}" stroke="#000000" stroke-width="7"/>` +
    `<path d="${arrow}" stroke="#ffffff" stroke-width="3"/>` +
    `</g></svg>`;

  // 16 16 puts the hotspot at the middle of the arrow.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, pointer`;
}

export const EXIT_CURSORS: Record<Direction, string> = {
  north: arrowCursor(ROTATION.north),
  east: arrowCursor(ROTATION.east),
  south: arrowCursor(ROTATION.south),
  west: arrowCursor(ROTATION.west),
};
