/** WebSocket message types for the server-client protocol. */

import type { RoomCoord } from "./constants.js";

/** Server -> Client: full game state snapshot sent each tick. */
export interface GameSnapshot {
  player: { x: number; y: number; color: string; name: string; room: RoomCoord; facing: 1 | -1 };
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
    /** +1 right, -1 left. The glyph is mirrored when facing right. */
    facing: 1 | -1;
  }>;
  /**
   * Dead enemies, left where they fell. Drawn dimmed, and targetable — but
   * they have no health, no AI, and never block movement.
   */
  corpses: Array<{
    id: string;
    name: string;
    glyph: string;
    color: string;
    room: RoomCoord;
    x: number;
    y: number;
    facing: 1 | -1;
  }>;
  /**
   * The open inspect menu, or null. `title` is what both the menu header and
   * the body's hover label read, so the two can't drift apart.
   */
  inspect: { corpseId: string; title: string; loot: Array<{ name: string }> } | null;
  projectiles: Array<{ x: number; y: number; vx: number; vy: number }>;
  /**
   * Floating damage numbers. Each carries an **id** so a client can pair one
   * across snapshots: they are matched to interpolate `y` and `age`, and the
   * array is not stable — numbers expire out of the middle of it while newer
   * ones are still alive. Matching by array position instead pairs a surviving
   * number with a *different* one the moment an older neighbour retires, and it
   * visibly jumps.
   */
  damageNumbers: Array<{ id: string; x: number; y: number; text: string; color: string; age: number }>;
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
  /** Engage the enemy under the point — or inspect the corpse under it. */
  | { type: "dblclick"; x: number; y: number }
  | { type: "slot"; index: number }
  | { type: "resurrect" }
  | { type: "toggleAutoResurrect" };
