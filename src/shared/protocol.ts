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
  /**
   * The attack cooldown in progress, for the action-bar sweep. `slot` is the
   * one that fired (it owns the cooldown, even after switching weapons); null
   * once it has elapsed.
   */
  cooldown: { slot: number; remainingMs: number; totalMs: number } | null;
  /**
   * True when the selected attack would connect right now — engaged, with a
   * live target inside that weapon's band. Colours the selected action-bar
   * square's border: gold when it would land, white when it wouldn't.
   */
  selectedCanAttack: boolean;
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
