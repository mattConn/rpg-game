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

export interface WideFit extends CanvasFit {
  /**
   * How many room units across this canvas covers. **Height is always
   * `WORLD_HEIGHT`** — that is the whole trick, and what everything downstream
   * relies on.
   */
  roomWidth: number;
}

/**
 * **The full width of the window, at a fixed room height.**
 *
 * `fitToViewport` above keeps the room at a hard 4:3 and letterboxes whatever
 * is left over, which on any normal monitor is a black bar down either side.
 * This instead holds the room's *height* at `WORLD_HEIGHT` and lets its width
 * follow the window, so a wider window is more room rather than a stretched
 * one. Nothing is distorted: room units stay square, the vertical scale is
 * unchanged, and a 3D camera given the same aspect simply sees further to the
 * left and right.
 *
 * That fixed height is what keeps the UI honest. Every panel is sized and
 * placed in room units, so holding the height constant means the HUD is the
 * same size on any window, and it is only the *ground between* the left-hand
 * furniture and the right-hand furniture that grows. Scale is still tied to the
 * window, so shrinking the window shrinks everything, as before.
 *
 * **It never goes narrower than 4:3.** A window taller than it is wide would
 * otherwise squeeze the room until the status panel and the enemy portrait
 * collided; past that point it letterboxes top and bottom instead, which still
 * leaves the canvas as wide as the window.
 */
export function fillViewport(viewportWidth: number, viewportHeight: number, dpr = 1): WideFit {
  const aspect = Math.max(viewportWidth / viewportHeight, WORLD_WIDTH / WORLD_HEIGHT);
  const roomWidth = WORLD_HEIGHT * aspect;

  const scale = Math.min(viewportWidth / roomWidth, viewportHeight / WORLD_HEIGHT);
  const displayWidth = roomWidth * scale;
  const displayHeight = WORLD_HEIGHT * scale;

  return {
    displayWidth,
    displayHeight,
    pixelWidth: Math.round(displayWidth * dpr),
    pixelHeight: Math.round(displayHeight * dpr),
    roomWidth,
  };
}
