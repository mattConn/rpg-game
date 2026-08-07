/** WebSocket message types for the server-client protocol. */

import type { RoomCoord } from "./constants.js";

/** Server -> Client: full game state snapshot sent each tick. */
export interface GameSnapshot {
  player: { x: number; y: number; color: string; name: string; room: RoomCoord };
  stats: { level: number; health: number; maxHealth: number; mana: number; maxMana: number };
  enemies: Array<{
    id: string;
    name: string;
    glyph: string;
    color: string;
    room: RoomCoord;
    x: number;
    y: number;
    health: number;
    maxHealth: number;
    chasing: boolean;
    aggro: boolean;
  }>;
  projectiles: Array<{ x: number; y: number; vx: number; vy: number }>;
  damageNumbers: Array<{ x: number; y: number; text: string; color: string; age: number }>;
  targetId: string | null;
  attacking: boolean;
  activeSlot: number;
  moveTarget: { x: number; y: number } | null;
  pathCells: Array<{ col: number; row: number }>;
  gameElapsedMs: number;
  killCount: number;
  dead: boolean;
  autoResurrect: boolean;
  /** Real ms left before an auto-resurrect fires, or null when none pending. */
  resurrectInMs: number | null;
  tombstones: Array<{ x: number; y: number; room: RoomCoord; gameElapsedMs: number }>;
}

/** Client -> Server: user input events. */
export type InputMessage =
  | { type: "keydown"; key: string; code: string }
  | { type: "keyup"; key: string }
  | { type: "click"; x: number; y: number }
  /** Engage the enemy under the point with the selected weapon. */
  | { type: "dblclick"; x: number; y: number }
  | { type: "slot"; index: number }
  | { type: "resurrect" }
  | { type: "toggleAutoResurrect" };
