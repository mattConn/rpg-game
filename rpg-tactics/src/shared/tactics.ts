/**
 * The turn-based skirmish: board geometry, the rules that decide what a move or
 * an attack is allowed to be, and the snapshot both sides read.
 *
 * Pure and DOM-free, exactly like `src/shared/` — the client draws the board
 * from these functions and the server rules on it with the same ones, so a
 * highlighted tile and a legal move can't come apart.
 *
 * **Positions stay in the real-time game's room pixels.** Nothing here needs
 * them to be, but the 3D bridge (`rpg-3d/src/client/world.ts`) divides room
 * pixels by 30 to get scene units, and the 2D UI overlay is drawn in the same
 * 1200x900 space — so keeping one unit means the models, the HUD and the
 * damage-number projection are all the imported originals, unscaled.
 */

import { WORLD_HEIGHT, WORLD_WIDTH, type RoomCoord } from "../../../src/shared/constants.js";
import type { Point } from "../../../src/shared/movement.js";
import type { GameSnapshot, InputMessage } from "../../../src/shared/protocol.js";

// ------------------------------------------------------------------- board

export const GRID_COLS = 3;
export const GRID_ROWS = 3;

export interface Cell {
  col: number;
  row: number;
}

/**
 * One square, in room pixels — three 3D units across. A human is 1.9 tall and a
 * hellhound about 1.5 long, so at this size two figures on neighbouring squares
 * very nearly touch: near enough that "adjacent" reads as adjacent and a bite
 * looks like a bite, with just enough stone between them to tell the squares
 * apart. Wider than this and a 3x3 board is mostly empty floor.
 *
 * The stage derives the board's extent, the camera's framing and the fog from
 * this, so changing it moves the whole scene together.
 */
export const TILE_PX = 90;

export const ARENA_W = GRID_COLS * TILE_PX;
export const ARENA_H = GRID_ROWS * TILE_PX;
/** The board sits in the middle of the room so the overlay's centred UI lines up. */
export const ARENA_X = (WORLD_WIDTH - ARENA_W) / 2;
export const ARENA_Y = (WORLD_HEIGHT - ARENA_H) / 2;

/**
 * Everything reports the same room, because there is only one — the dungeon
 * grid the real-time game roams is a single arena here. The imported overlay
 * filters world labels by `sameRoom`, so this just has to be consistent.
 */
export const ARENA_ROOM: RoomCoord = { col: 2, row: 2 };

export function cellCenter(cell: Cell): Point {
  return {
    x: ARENA_X + cell.col * TILE_PX + TILE_PX / 2,
    y: ARENA_Y + cell.row * TILE_PX + TILE_PX / 2,
  };
}

/** The square a room point falls in, or null when the point is off the board. */
export function cellAtPoint(point: Point): Cell | null {
  const col = Math.floor((point.x - ARENA_X) / TILE_PX);
  const row = Math.floor((point.y - ARENA_Y) / TILE_PX);
  const cell = { col, row };
  return inGrid(cell) ? cell : null;
}

export function inGrid(cell: Cell): boolean {
  return cell.col >= 0 && cell.col < GRID_COLS && cell.row >= 0 && cell.row < GRID_ROWS;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

export function cellKey(cell: Cell): string {
  return `${cell.col},${cell.row}`;
}

/** Every square on the board, reading order. */
export function allCells(): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) cells.push({ col, row });
  }
  return cells;
}

// ------------------------------------------------------------------- layout

/**
 * The opening position. The player stands in the left column, the pack holds
 * the right one, and the bottom row is empty ground between them:
 *
 * ```
 *   @ . h
 *   . . h
 *   . . X
 * ```
 */
export const PLAYER_START: Cell = { col: 0, row: 0 };
export const HOUND_STARTS: readonly Cell[] = [
  { col: 2, row: 0 },
  { col: 2, row: 1 },
];

/**
 * The way out, at the far end of the escape row. Stepping onto it ends the
 * fight — which means the shortest run to safety is straight through the pack's
 * own column, and the hounds are between you and it from the first turn.
 */
export const ESCAPE_CELL: Cell = { col: 2, row: 2 };

// -------------------------------------------------------------------- rules

/**
 * **Melee reaches sideways and across, never straight up or down.** A blade
 * needs a shoulder's worth of room, so a body directly above or below is not
 * something either side can swing at — step out of the column first.
 *
 * The rule is symmetric, so it gates the hellhounds' bite exactly as it gates
 * the player's sword, and the AI plans its approach with the same function.
 */
export function canMelee(a: Cell, b: Cell): boolean {
  return Math.abs(a.col - b.col) === 1 && Math.abs(a.row - b.row) <= 1;
}

/** One square in any of the eight directions — how far anything moves per turn. */
export function isStep(from: Cell, to: Cell): boolean {
  const dc = Math.abs(from.col - to.col);
  const dr = Math.abs(from.row - to.row);
  return (dc !== 0 || dr !== 0) && dc <= 1 && dr <= 1;
}

/**
 * Sharing an edge or a corner. This is what a hellhound notices you by, and it
 * is deliberately *wider* than `canMelee`: something standing directly above you
 * is close enough to wake, and then has to step aside before it can bite. Being
 * noticed and being in danger are two different things.
 */
export function isAdjacent(a: Cell, b: Cell): boolean {
  return isStep(a, b);
}

/** The eight neighbours of a square that are still on the board. */
export function neighbors(cell: Cell): Cell[] {
  const out: Cell[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dc === 0 && dr === 0) continue;
      const next = { col: cell.col + dc, row: cell.row + dr };
      if (inGrid(next)) out.push(next);
    }
  }
  return out;
}

/** Chebyshev distance — one diagonal step covers a rank and a file at once. */
export function stepDistance(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.col - b.col), Math.abs(a.row - b.row));
}

/** Which way a glyph/model should face to look from `from` at `to`. Held on a tie. */
export function facingToward(from: Cell, to: Cell, held: 1 | -1): 1 | -1 {
  if (to.col > from.col) return 1;
  if (to.col < from.col) return -1;
  return held;
}

// ------------------------------------------------------ stats and cadence

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_MANA = 50;

export const HOUND_MAX_HEALTH = 24;

/**
 * Damage is tuned so the fight is a race the player can lose. Three sword blows
 * put a hound down; two hounds biting take a third of you every round. Standing
 * and trading with both of them does not work, which is the whole point of the
 * escape square.
 */
export const MELEE_DAMAGE = 8;
export const RANGED_DAMAGE = 5;
export const HOUND_DAMAGE = 7;

/** How long a single step across a square takes to play out (ms). */
export const STEP_MS = 380;
/** A swing, start to finish (ms). */
export const ATTACK_MS = 520;
/** After a thrown dagger lands, before the turn passes (ms). */
export const THROW_RECOVER_MS = 220;
/** A beat between one actor finishing and the next starting (ms). */
export const TURN_GAP_MS = 240;

/**
 * The longest a single hellhound's turn can take. Used to predict when the
 * player's turn comes back, which is what the action bar's blind counts down.
 */
export const ENEMY_ACTION_MS = Math.max(STEP_MS, ATTACK_MS);

/** Delay before an auto-restart fires after death (ms), measured from the death. */
export const AUTO_RESTART_DELAY_MS = 3000;

/** How many lines of the turn log the client shows. */
export const LOG_LINES = 4;

// ----------------------------------------------------------------- protocol

/**
 * Where the encounter is. `player` and `enemy` alternate; the other three are
 * terminal and wait for a restart.
 */
export type Phase = "player" | "enemy" | "escaped" | "cleared" | "dead";

export function isOver(phase: Phase): boolean {
  return phase === "escaped" || phase === "cleared" || phase === "dead";
}

/**
 * The real-time game's snapshot, plus what a turn-based board needs on top.
 *
 * Extending rather than replacing is what lets the whole client stack —
 * `Actors`, `applyCues`, `interpolateSnapshot`, the entire 2D overlay — be
 * *imported* from the real-time front end instead of rewritten. They read the
 * fields they always read; the extra ones ride along untouched.
 */
export interface TacticsSnapshot extends GameSnapshot {
  phase: Phase;
  /** 1-based, incremented when the player's turn comes back around. */
  round: number;
  playerCell: Cell;
  /** Squares the player may step onto right now — the lit tiles. Empty off-turn. */
  legalMoves: Cell[];
  escapeCell: Cell;
  /**
   * True once *any* hellhound is awake — they wake one at a time now, so this
   * is only good for "has anything started yet". Whether a particular hound is
   * hunting you is on its own entry in `enemies`.
   */
  aggro: boolean;
  /**
   * The most recent blow landed on the player, and a counter that ticks with
   * each one. The client lunges `enemyId` whenever `seq` changes.
   *
   * This exists because the real-time client can afford to *guess* who bit you
   * — it picks the nearest thing hunting you — and a turn-based board cannot.
   * Two hellhounds standing either side of you both strike in the same round,
   * and a guess gives the animation to the same one twice while the other bites
   * you without moving. It stays a piece of state rather than an event: the seq
   * is what changed, so a dropped or repeated snapshot can't double-play it.
   */
  strike: { enemyId: string; seq: number } | null;
  /** Newest last; the client draws the tail. */
  log: string[];
  /** One line telling the player what the board is waiting for. */
  hint: string;
}

/**
 * The real-time input messages, all of which still mean something here, plus the
 * three a game with turns needs.
 *
 * `slot` has *lost* meaning rather than gained it: it now only chooses a weapon.
 * Committing the turn is `attack` or `wait`, which is why they are messages of
 * their own rather than a flag on `slot` — one button ends your turn and the
 * other doesn't, and that difference should be visible in the protocol.
 *
 * `click` and `dblclick` still carry a *room point* rather than a cell: the 3D
 * client resolves what was under the cursor before it sends, so the server keeps
 * deciding what a click landed on — including the ✕ on the inspect menu, whose
 * geometry is shared in room units.
 */
export type TacticsInput =
  | InputMessage
  | { type: "restart" }
  /** Swing the selected weapon at the mark. Spends the turn either way. */
  | { type: "attack" }
  /** Spend the turn doing nothing. */
  | { type: "wait" };
