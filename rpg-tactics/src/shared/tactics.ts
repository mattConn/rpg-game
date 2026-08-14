/**
 * The turn-based skirmish: board geometry, the rules that decide what a move or
 * an attack is allowed to be, and the snapshot both sides read.
 *
 * Pure and DOM-free, exactly like `src/shared/` — the client draws the board
 * from these functions and the server rules on it with the same ones, so what
 * is shown and what is allowed can't come apart.
 *
 * **The grid is fine and invisible.** It started as a literal 3x3 of squares you
 * hopped between; each of those is now `SUBDIVISION` cells across, which makes a
 * cell about half a pace wide. Nothing is drawn on the floor to mark them and
 * nothing snaps visibly, so movement reads as walking rather than as stepping
 * from tile to tile — but the simulation is still discrete and deterministic,
 * and it is still strictly turn-based. The grid became a lattice for positions
 * to sit on instead of a board you play on.
 *
 * Because of that, **every rule is expressed as a distance in room pixels**, not
 * as a count of cells. `MOVE_RANGE` is how far you travel in a turn, full stop;
 * subdividing further would change how finely you can place yourself and nothing
 * else about the game.
 *
 * **Positions stay in room pixels.** Nothing here needs them to be, but the 3D
 * bridge (`rpg-3d/src/client/world.ts`) divides room pixels by 30 to get scene
 * units, and the 2D UI overlay is drawn in the same 1200x900 space — so keeping
 * one unit means the models, the HUD and the damage-number projection are all
 * the imported originals, unscaled.
 */

import { WORLD_HEIGHT, WORLD_WIDTH, type RoomCoord } from "../../../src/shared/constants.js";
import type { Point } from "../../../src/shared/movement.js";
import type { GameSnapshot, InputMessage } from "../../../src/shared/protocol.js";

// ------------------------------------------------------------------- board

/**
 * How many cells make up one of the original squares. The opening positions and
 * every range below are unchanged in room pixels, so raising this makes
 * placement finer and changes nothing else — which is the entire point of it.
 */
export const SUBDIVISION = 5;

/** The original board, still the shape of the game: three squares by three. */
export const SQUARES = 3;
/** One of those squares, in room pixels — three 3D units, a good stride. */
export const SQUARE_PX = 90;

export const GRID_COLS = SQUARES * SUBDIVISION; // 15
export const GRID_ROWS = SQUARES * SUBDIVISION; // 15

/** A single cell: 18px, about 0.6 of a 3D unit. Fine enough to read as smooth. */
export const TILE_PX = SQUARE_PX / SUBDIVISION;

export interface Cell {
  col: number;
  row: number;
}

export const ARENA_W = SQUARES * SQUARE_PX; // 270
export const ARENA_H = SQUARES * SQUARE_PX;
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

/** The cell a room point falls in, or null when the point is off the board. */
export function cellAtPoint(point: Point): Cell | null {
  const cell = {
    col: Math.floor((point.x - ARENA_X) / TILE_PX),
    row: Math.floor((point.y - ARENA_Y) / TILE_PX),
  };
  return inGrid(cell) ? cell : null;
}

/** The nearest legal cell to a point, clamped onto the board rather than refused. */
export function clampToGrid(point: Point): Cell {
  return {
    col: clampInt(Math.floor((point.x - ARENA_X) / TILE_PX), 0, GRID_COLS - 1),
    row: clampInt(Math.floor((point.y - ARENA_Y) / TILE_PX), 0, GRID_ROWS - 1),
  };
}

function clampInt(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function inGrid(cell: Cell): boolean {
  return cell.col >= 0 && cell.col < GRID_COLS && cell.row >= 0 && cell.row < GRID_ROWS;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ------------------------------------------------------------------- layout

/**
 * The opening position, unchanged from when the board was three squares wide:
 * the player in the left column, the pack holding the right, and open ground
 * between them.
 *
 * ```
 *   @ . h
 *   . . h
 *   . . X
 * ```
 *
 * `SUBDIVISION` is odd, so the centre of each old square is still the centre of
 * a cell and these are the very same points they always were.
 */
const HALF = Math.floor(SUBDIVISION / 2);
const squareCentre = (col: number, row: number): Cell => ({
  col: col * SUBDIVISION + HALF,
  row: row * SUBDIVISION + HALF,
});

export const PLAYER_START: Cell = squareCentre(0, 0);
export const HOUND_STARTS: readonly Cell[] = [squareCentre(2, 0), squareCentre(2, 1)];

/**
 * The way out, in the far corner. Reach it and the fight is over — which means
 * the shortest run to safety goes straight past the pack, and they are between
 * you and it from the first turn.
 */
export const ESCAPE_CELL: Cell = squareCentre(2, 2);
/** How close to the arch counts as through it. */
export const ESCAPE_RADIUS = SQUARE_PX * 0.42;

// -------------------------------------------------------------------- ranges

/**
 * How far anything travels in one turn — one of the original squares' worth of
 * ground. What changed when the grid was subdivided is *where you may stop*,
 * not how far you get.
 */
export const MOVE_RANGE = SQUARE_PX;

/** How close a blade or a bite has to be. */
export const MELEE_RANGE = SQUARE_PX;

/**
 * How close you have to come before a hellhound notices you — deliberately a
 * little wider than its reach, so a hound wakes a moment before it can bite.
 */
export const AGGRO_RANGE = SQUARE_PX * 1.25;

/** Nothing may stand inside anything else. Roughly a body's width. */
export const MIN_SEPARATION = SQUARE_PX * 0.5;

// --------------------------------------------------------------------- rules

/**
 * **Reach goes sideways and across, never straight up or down.** A blade needs a
 * shoulder's worth of room, so something directly above or below is not
 * something either side can swing at — move off its line first.
 *
 * On the old 3x3 this was "one column across, at most one row up or down". The
 * generalisation to a fine grid is `|dx| >= |dy|`: a quarter-turn cone opening
 * left and right, which is exactly the set of squares the original rule allowed
 * and nothing more. It stays symmetric, so it gates the hellhounds' bite as it
 * gates the player's sword, and the pack plans its approach with the same test.
 */
export function canReach(from: Point, to: Point): boolean {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  return dx >= dy && distance(from, to) <= MELEE_RANGE;
}

/** Close enough for a hellhound to notice you. A circle, not a cone. */
export function withinAggro(a: Point, b: Point): boolean {
  return distance(a, b) <= AGGRO_RANGE;
}

/** Whether a destination is inside this turn's travel allowance. */
export function withinMove(from: Point, to: Point): boolean {
  return distance(from, to) <= MOVE_RANGE + 0.001;
}

/** Which way a model should face to look from `from` at `to`. Held on a tie. */
export function facingToward(from: Point, to: Point, held: 1 | -1): 1 | -1 {
  if (to.x > from.x + 0.001) return 1;
  if (to.x < from.x - 0.001) return -1;
  return held;
}

/**
 * The points a hellhound would like to be standing on: a ring around the player
 * at just inside biting distance, keeping only those its reach rule actually
 * allows. That filter is what pushes the pack to come at you from the sides
 * rather than from directly above or below, and it falls out of `canReach`
 * rather than being a second rule the AI has to remember.
 */
export function approachPoints(target: Point, count = 16): Point[] {
  const radius = MELEE_RANGE * 0.8;
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const point = { x: target.x + Math.cos(angle) * radius, y: target.y + Math.sin(angle) * radius };
    if (canReach(point, target)) points.push(point);
  }
  return points;
}

/** Step from `from` toward `to`, stopping at `limit` px if it is further. */
export function stepToward(from: Point, to: Point, limit: number): Point {
  const gap = distance(from, to);
  if (gap <= limit || gap === 0) return { x: to.x, y: to.y };
  const t = limit / gap;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

// ------------------------------------------------------ stats and cadence

export const PLAYER_MAX_HEALTH = 100;
export const PLAYER_MAX_MANA = 50;

export const HOUND_MAX_HEALTH = 24;

/**
 * Damage is tuned so the fight is a race the player can lose. Three sword blows
 * put a hound down; two hounds biting take a third of you every round. Standing
 * and trading with both of them does not work, which is the whole point of the
 * arch.
 */
export const MELEE_DAMAGE = 8;
export const RANGED_DAMAGE = 5;
export const HOUND_DAMAGE = 7;

/** How long a full-length walk takes to play out (ms). Short hops take less. */
export const STEP_MS = 420;
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
  /**
   * How far the player may travel this turn, in px, and from where. Zero off
   * turn. With no grid drawn this is the *only* thing telling them where they
   * can go, so the client paints it on the floor as a disc.
   */
  moveRange: number;
  moveFrom: { x: number; y: number };
  /** The arch, and how close counts as through it. */
  escapePoint: { x: number; y: number };
  escapeRadius: number;
  /** Reach, so the client can show what the selected weapon would cover. */
  meleeRange: number;
  /**
   * True once *any* hellhound is awake — they wake one at a time, so this is
   * only good for "has anything started yet". Whether a particular hound is
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
