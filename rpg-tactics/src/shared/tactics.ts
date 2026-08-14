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

// --------------------------------------------------------- beyond the board

/**
 * **The board is no longer the world.** The doorway in the south wall used to be
 * a way *out of the game* — step on it and the encounter ended — and is now
 * simply a door: the corridor behind it and the chamber at the end of that are
 * ground you can stand on, so walking through it takes you somewhere instead of
 * finishing the fight.
 *
 * That makes "on the grid" a question about three rectangles rather than about
 * one, which is the only thing the change costs. Everything downstream —
 * reachability, the pack's approach, the footfall ring — asks `inGrid` and gets
 * the same answer it always did.
 */
export interface Region {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** The arena itself: the fight starts here and usually ends here. */
export const BOARD_REGION: Region = { col: 0, row: 0, cols: GRID_COLS, rows: GRID_ROWS };

/**
 * The corridor, running south out of the doorway. It is exactly the arena's
 * bottom-right column band — one of the original squares wide — so the masonry
 * the client builds around it lands on cell boundaries rather than near them.
 */
export const HALL_ROWS = 20;
export const HALL_REGION: Region = {
  col: (SQUARES - 1) * SUBDIVISION,
  row: GRID_ROWS,
  cols: SUBDIVISION,
  rows: HALL_ROWS,
};

/** The room at the end of it, the same size as the arena and empty. */
export const FAR_REGION: Region = {
  col: 0,
  row: GRID_ROWS + HALL_ROWS,
  cols: GRID_COLS,
  rows: GRID_ROWS,
};

export const REGIONS: readonly Region[] = [BOARD_REGION, HALL_REGION, FAR_REGION];

/** A region's middle, in room pixels — where the client frames and lights it. */
export function regionCentre(region: Region): Point {
  return {
    x: ARENA_X + (region.col + region.cols / 2) * TILE_PX,
    y: ARENA_Y + (region.row + region.rows / 2) * TILE_PX,
  };
}

/** The cell a room point falls in, or null when the point is off the floor. */
export function cellAtPoint(point: Point): Cell | null {
  const cell = {
    col: Math.floor((point.x - ARENA_X) / TILE_PX),
    row: Math.floor((point.y - ARENA_Y) / TILE_PX),
  };
  return inGrid(cell) ? cell : null;
}

/**
 * The nearest standable cell to a point, clamped rather than refused. With more
 * than one rectangle to land in it is "clamp into each, keep the closest" — the
 * corridor is narrow, so a point out in the masonry beside it must not snap back
 * to the arena when the hall is a pace away.
 */
export function clampToGrid(point: Point): Cell {
  let best: Cell | null = null;
  let bestGap = Infinity;
  for (const region of REGIONS) {
    const cell = {
      col: clampInt(Math.floor((point.x - ARENA_X) / TILE_PX), region.col, region.col + region.cols - 1),
      row: clampInt(Math.floor((point.y - ARENA_Y) / TILE_PX), region.row, region.row + region.rows - 1),
    };
    const gap = distance(point, cellCenter(cell));
    if (gap < bestGap) { bestGap = gap; best = cell; }
  }
  return best!;
}

function clampInt(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function inRegion(region: Region, cell: Cell): boolean {
  return (
    cell.col >= region.col && cell.col < region.col + region.cols &&
    cell.row >= region.row && cell.row < region.row + region.rows
  );
}

export function inGrid(cell: Cell): boolean {
  return REGIONS.some((region) => inRegion(region, cell));
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
 *   . . D      D is the doorway column: the corridor runs south out of it.
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

// The doorway is not a cell any more, it is the mouth of `HALL_REGION` — see
// the regions above. It used to end the encounter; now it only leads out of the
// room, with the pack still between you and it from the first turn.

// -------------------------------------------------------------------- ranges

/**
 * How far anything travels in one turn — one of the original squares' worth of
 * ground. What changed when the grid was subdivided is *where you may stop*,
 * not how far you get.
 *
 * For the player it is **a price rather than a limit**: they may click any floor
 * there is and they will walk to it, taking a round per square's worth of ground
 * and letting the pack answer in each. A long walk is a commitment, not a
 * refused click. The hellhounds are gated by it in the old way — one leg per
 * turn, because a turn is all they get.
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

/** Which way a model should face to look from `from` at `to`. Held on a tie. */
export function facingToward(from: Point, to: Point, held: 1 | -1): 1 | -1 {
  if (to.x > from.x + 0.001) return 1;
  if (to.x < from.x - 0.001) return -1;
  return held;
}

/**
 * The cells a hellhound would like to be standing in: every one within reach of
 * the player that its own reach rule allows — which is what pushes the pack to
 * come at you from the sides rather than from directly above or below, and falls
 * out of `canReach` rather than being a second rule the AI has to remember.
 *
 * **This is a search of the floor, not a ring around the player**, and it has to
 * be, now that the floor is not one rectangle. A ring at four-fifths of biting
 * distance was the same idea while the game was played in a 9x9 room: the two
 * points on it that a hound could bite from lie a long way out to the left and
 * right, and in a room they are always floor. In the corridor they are both
 * inside the masonry, so every candidate was unstandable and the pack would
 * follow you through the door and then stand there for the rest of the game,
 * hemmed in, while you were beside them. Asking the grid instead gives the same
 * answer in the room and a real one in the hall.
 */
export function approachCells(target: Point): Cell[] {
  const centre = clampToGrid(target);
  const span = Math.ceil(MELEE_RANGE / TILE_PX);
  const cells: Cell[] = [];
  for (let dr = -span; dr <= span; dr++) {
    for (let dc = -span; dc <= span; dc++) {
      const cell = { col: centre.col + dc, row: centre.row + dr };
      if (!inGrid(cell)) continue;
      if (canReach(cellCenter(cell), target)) cells.push(cell);
    }
  }
  return cells;
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
 * and trading with both of them does not work, which is why the door is open:
 * giving ground down the corridor is the answer to it. It is no longer a way to
 * *win* — the pack follows you through — only a way to keep moving.
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

/** Delay before an auto-restart fires after death (ms), measured from the death. */
export const AUTO_RESTART_DELAY_MS = 3000;

/** How many lines of the turn log the client shows. */
export const LOG_LINES = 4;

// ----------------------------------------------------------------- protocol

/**
 * Where the encounter is. `player` and `enemy` alternate; the other three are
 * terminal and wait for a restart.
 */
export type Phase = "player" | "enemy" | "cleared" | "dead";

export function isOver(phase: Phase): boolean {
  return phase === "cleared" || phase === "dead";
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
   * How much ground a round of walking covers, in px, and where from. Zero off
   * turn, which is all the client reads it for now: a click is legal anywhere
   * there is floor, so this no longer says where the player may go — only what
   * going there will cost them per round.
   */
  moveRange: number;
  moveFrom: { x: number; y: number };
  /** Reach, so the client can show what the selected weapon would cover. */
  meleeRange: number;
  /**
   * True once *any* hellhound is awake — they wake one at a time, so this is
   * only good for "has anything started yet". Whether a particular hound is
   * hunting you is on its own entry in `enemies`.
   */
  aggro: boolean;
  /**
   * Every blow the pack landed in the round just resolved, each with a counter
   * that ticks once per blow. The client lunges every one whose seq it has not
   * seen before.
   *
   * This exists because the real-time client can afford to *guess* who bit you
   * — it picks the nearest thing hunting you — and a turn-based board cannot.
   * Two hellhounds standing either side of you both strike in the same round,
   * and a guess gives the animation to the same one twice while the other bites
   * you without moving. It is a *list* for the same reason once more: the round
   * resolves whole, so both blows land in one snapshot and a single field would
   * only ever animate the last of them. It stays state rather than events — the
   * seq is what changed, so a dropped or repeated snapshot can't double-play it.
   */
  strikes: Array<{ enemyId: string; seq: number }>;
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
