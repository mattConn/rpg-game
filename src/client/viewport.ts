/** Fitting the fixed-ratio room onto whatever window the player has. */

import { WORLD_HEIGHT, WORLD_WIDTH } from "../shared/constants.js";

export interface CanvasFit {
  /** CSS size of the canvas. */
  displayWidth: number;
  displayHeight: number;
  /** Backing-store size — display size at the screen's pixel density. */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * The largest 4:3 canvas that fits the viewport. Game logic keeps working in
 * room units; only the number of real pixels those units map onto changes, so
 * text and glyphs stay sharp rather than being stretched.
 */
export function fitToViewport(viewportWidth: number, viewportHeight: number, dpr = 1): CanvasFit {
  const scale = Math.min(viewportWidth / WORLD_WIDTH, viewportHeight / WORLD_HEIGHT);
  const displayWidth = WORLD_WIDTH * scale;
  const displayHeight = WORLD_HEIGHT * scale;

  return {
    displayWidth,
    displayHeight,
    pixelWidth: Math.round(displayWidth * dpr),
    pixelHeight: Math.round(displayHeight * dpr),
  };
}
