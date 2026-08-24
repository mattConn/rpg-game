/**
 * Corpses and the inspect (loot) menu.
 *
 * The menu's geometry lives here rather than in the client because both sides
 * need it: the client draws it, and the server decides whether a click landed
 * on the ✕, inside the menu (swallowed), or outside it (dismisses).
 */

import { WORLD_HEIGHT, WORLD_WIDTH, type RoomCoord } from "./constants.js";
import type { Point } from "./movement.js";

/** One item on a body. Hellhounds carry none, so this is unused for now. */
export interface LootItem {
  name: string;
}

/** What a dead enemy leaves behind: its glyph, frozen where it fell. */
export interface Corpse {
  id: string;
  name: string;
  glyph: string;
  color: string;
  room: RoomCoord;
  x: number;
  y: number;
  facing: 1 | -1;
  kind?: "hellhound" | "bat" | "spider" | "gargoyle";
  /** Scene-space flight height at death; only present for flying corpses. */
  altitude?: number;
  loot: LootItem[];
}

/**
 * Build a corpse from the enemy that just died. It keeps the enemy's **id** —
 * not to hold the target (a kill drops that), but so the open inspect menu has
 * a stable thing to point at.
 */
export function corpseOf(enemy: Omit<Corpse, "loot">): Corpse {
  return {
    id: enemy.id,
    name: enemy.name,
    glyph: enemy.glyph,
    color: enemy.color,
    room: { ...enemy.room },
    x: enemy.x,
    y: enemy.y,
    facing: enemy.facing,
    kind: enemy.kind,
    altitude: enemy.altitude,
    loot: [], // hellhounds carry nothing
  };
}

/** Hover label and menu title, so the two always read the same. */
export function corpseLabel(corpse: { name: string }): string {
  return `${corpse.name} (dead)`;
}

// ---------------------------------------------------------------- menu layout

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const LOOT_MENU_WIDTH = 280;
export const LOOT_MENU_HEIGHT = 200;
export const LOOT_MENU_TITLE_HEIGHT = 26;

/** Centred in the room — the menu is modal-ish, so it sits over everything. */
export const LOOT_MENU_RECT: Rect = {
  x: (WORLD_WIDTH - LOOT_MENU_WIDTH) / 2,
  y: (WORLD_HEIGHT - LOOT_MENU_HEIGHT) / 2,
  width: LOOT_MENU_WIDTH,
  height: LOOT_MENU_HEIGHT,
};

const CLOSE_SIZE = 18;
const CLOSE_INSET = 4;

/** The ✕ in the top-right corner of the title bar. */
export const LOOT_CLOSE_RECT: Rect = {
  x: LOOT_MENU_RECT.x + LOOT_MENU_WIDTH - CLOSE_SIZE - CLOSE_INSET,
  y: LOOT_MENU_RECT.y + CLOSE_INSET,
  width: CLOSE_SIZE,
  height: CLOSE_SIZE,
};

export function hitsRect(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * A click on the menu, translated from the overlay it was drawn on into the
 * room point that makes the server reach the same verdict — ✕, inside
 * (swallowed), or outside (dismiss).
 *
 * Only the 3D front ends need this, and they both do. In 2D the menu is drawn
 * in the very space clicks arrive in, so the question doesn't come up; in 3D the
 * panel lives in overlay coordinates while a click resolves to a point on the
 * floor, and without the translation every click on the panel would read as
 * "outside".
 */
export function lootMenuProxyPoint(uiPoint: Point): Point {
  if (hitsRect(LOOT_CLOSE_RECT, uiPoint)) {
    return {
      x: LOOT_CLOSE_RECT.x + LOOT_CLOSE_RECT.width / 2,
      y: LOOT_CLOSE_RECT.y + LOOT_CLOSE_RECT.height / 2,
    };
  }
  if (hitsRect(LOOT_MENU_RECT, uiPoint)) {
    return {
      x: LOOT_MENU_RECT.x + LOOT_MENU_RECT.width / 2,
      y: LOOT_MENU_RECT.y + LOOT_MENU_RECT.height * 0.75,
    };
  }
  return { x: 1, y: 1 }; // any point outside the panel dismisses it
}
