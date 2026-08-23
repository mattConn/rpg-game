/**
 * Real-time simulation on the tactics board. The player moves continuously
 * with WASD or click-to-move, enemies chase and attack on their own clock,
 * and combat is cooldown-gated rather than turn-gated.
 *
 * The board, the grid, the rooms and the corridor are unchanged — only the
 * pacing is different.
 */

import {
  DAMAGE_NUMBER_LIFETIME,
  DAMAGE_NUMBER_SPEED,
  PROJECTILE_SPEED,
  advanceDagger,
  daggerDone,
  spawnDagger,
  type Projectile,
} from "../../../src/shared/combat.js";
import { HELLHOUND } from "../../../src/shared/enemies.js";
import {
  LOOT_CLOSE_RECT,
  LOOT_MENU_RECT,
  corpseLabel,
  corpseOf,
  hitsRect,
  type Corpse,
} from "../../../src/shared/loot.js";
import type { Point } from "../../../src/shared/movement.js";
import {
  AGGRO_RANGE,
  AGGRO_WARN_RANGE,
  ARENA_ROOM,
  ARENA_X,
  ATTACK_MS,
  AUTO_RESTART_DELAY_MS,
  BAT_REGION,
  BOARD_REGION,
  DOOR_CLEARANCE_PX,
  DOORWAY_WIDTH_PX,
  DOOR_Y,
  type DoorId,
  FAR_REGION,
  HALL_REGION,
  HOUND_MAX_HEALTH,
  HOUND_STARTS,
  LOG_LINES,
  MELEE_RANGE,
  MIN_SEPARATION,
  MOVE_RANGE,
  PLAYER_MAX_HEALTH,
  PLAYER_MAX_MANA,
  PLAYER_START,
  RANGED_DAMAGE,
  SQUARE_PX,
  TILE_PX,
  TACTICS_ACTIONS,
  canReach,
  cellAtPoint,
  cellCenter,
  regionCentre,
  clampPointToFloor,
  clampToGrid,
  distance,
  facingToward,
  inGrid,
  inRegion,
  isOver,
  stepToward,
  withinAggro,
  type Cell,
  type Phase,
  type Region,
  type TacticsInput,
  type TacticsSnapshot,
} from "../shared/tactics.js";

// ------------------------------------------------------------------ constants

const DAMAGE_COLOR_DEALT = "#ffd633";
/** A narrow 70-degree melee arc: 35 degrees either side of the muzzle. */
const ATTACK_CONE_DOT = Math.cos((35 * Math.PI) / 180);
/** The central 30 degrees earn the full direct-hit damage. */
const DIRECT_ATTACK_CONE_DOT = Math.cos((15 * Math.PI) / 180);
const SWORD_FRONT_DAMAGE = 25;
const SWORD_SIDE_DAMAGE = 20;

const MAX_CORPSES = 8;

/** Player walking speed in room pixels per second. */
const PLAYER_SPEED = 200;
const PLAYER_RUN_MULTIPLIER = 1.6;
/** Enemy chase speed in room pixels per second. */
const ENEMY_SPEED = 140;
/**
 * How far apart, as an angle about the player, two hounds sharing a side come
 * in — so a pack of two sits at ±40°, which at biting distance is 81px of
 * daylight against a `MIN_SEPARATION` of 45. That margin is the whole point:
 * aim them somewhere they *both fit* and the push-apart below never has to
 * fire, and neither ends up shoved in behind the other.
 *
 * An angle rather than a sideways offset because "side by side" is across the
 * line the pack is coming in on, and that line is wherever the player happens
 * to be. Spreading them in y reads as abreast only while the chase runs
 * east-west, and stacks them nose to tail the moment it runs north-south.
 */
const FLANK_ANGLE = (80 * Math.PI) / 180;
/**
 * How far off due east or west a hound will come at you.
 *
 * This was once a hard requirement — `canReach` carried a cone, and a goal
 * outside it was a goal the hound could not bite from. Reach is a plain circle
 * now, so nothing enforces it any more and it survives purely as *staging*: the
 * pack coming in off your shoulders reads as flanking, where hounds converging
 * from every bearing at once reads as a scrum. Widen it towards 90° and they
 * swarm; that is a look, not a bug.
 */
const APPROACH_HALF_ANGLE = (40 * Math.PI) / 180;
/**
 * How close a packmate has to be before a hound starts leaning away from it.
 * Comfortably wider than `MIN_SEPARATION` so the lean begins *before* the hard
 * push-apart has to fire, and comfortably narrower than the gap between two
 * flank slots, so a pack that has reached its places stops shoving and stands
 * still.
 */
const AVOID_RANGE = MIN_SEPARATION * 1.5;
/** How hard that lean pulls against the goal. Above 1, so it can win up close. */
const AVOID_WEIGHT = 1.5;
/** How near its slot counts as standing on it. Slack against per-tick jitter. */
const ARRIVE_SLACK = 4;
/**
 * Passes of the push-apart. Two hounds settle in one; a third shoved out of one
 * packmate and into another needs the next, and it costs nothing to be right
 * for a bigger pack than this game ships.
 */
const SEPARATION_PASSES = 3;
/** Melee cooldown in ms. */
const MELEE_COOLDOWN_MS = 600;
/** Ranged cooldown in ms. */
const RANGED_COOLDOWN_MS = 1000;
/** How often a hellhound bites, in ms. */
const ENEMY_ATTACK_INTERVAL_MS = 1500;
/** Match the imported attack clip at its configured 1.25x playback speed. */
const HOUND_ATTACK_ANIMATION_MS = 1250;
/** Slow enough that circling behind a hound creates a real attack window. */
const HOUND_TURN_SPEED = 2.2;
/** A strict frontal bite: 35 degrees to either side of the snout. */
const HOUND_ATTACK_CONE_DOT = Math.cos((35 * Math.PI) / 180);
/** Recovery after throwing a dagger, in ms. */
const THROW_RECOVER_MS = 220;
/** How fast an un-aggro'd hound patrols, in room pixels per second. */
const PATROL_SPEED = 50;
/** Width of the horizontal patrol beat, in room pixels (~1.5 squares). */
const PATROL_SPAN = SQUARE_PX * 1.5;
/** Close enough, centred enough, and faced closely enough to operate a door. */
const DOOR_INTERACT_RANGE = TILE_PX * 3;
const DOOR_FACING_DOT = Math.cos(Math.PI / 3);
const JUMP_MS = 620;
const EAT_DURATION_MS = 1000;
const EAT_HEAL = 30;
const EAT_RANGE = MIN_SEPARATION;
/** Extra contact allowance for the hellhound's visibly broad imported body. */
const HOUND_HITBOX_BONUS = SQUARE_PX * 0.2;
const JUMP_SPEED_MULTIPLIER = 1.8;
const BAT_PATROL_RADIUS = SQUARE_PX * 1.35;
const BAT_PATROL_ANGULAR_SPEED = 0.72;
const BAT_PURSUIT_SPEED = 92;
const BAT_STRIKE_AT_MS = 650;
const BAT_DIVE_LINGER_MS = 500;
const BAT_DIVE_RECOVERY_MS = 500;
const BAT_DIVE_MS = BAT_STRIKE_AT_MS + BAT_DIVE_LINGER_MS + BAT_DIVE_RECOVERY_MS;
const BAT_ATTACK_INTERVAL_MS = 1800;
const BAT_DIVE_TRIGGER_RANGE = MELEE_RANGE * 1.7;
const BAT_BITE_RANGE = MELEE_RANGE * 0.72;
const BAT_ATTACK_CONE_DOT = Math.cos(Math.PI / 4);
/** Broad ellipse covering the bat's body and extended wings. */
const BAT_BODY_HALF_LENGTH = SQUARE_PX * 1.75;
const BAT_BODY_HALF_WIDTH = SQUARE_PX * 1.5;
const BAT_CRUISE_ALTITUDE = 4.2;
const BAT_AGGRO_ALTITUDE = 2.25;
const BAT_DIVE_ALTITUDE = 0.9;

// Corridor waypoints for cross-region navigation.
const HALL_MID_COL = HALL_REGION.col + Math.floor(HALL_REGION.cols / 2);
/** Inside the board, one cell north of the hall entrance. */
const BOARD_DOORWAY = cellCenter({ col: HALL_MID_COL, row: BOARD_REGION.row + BOARD_REGION.rows - 1 });
/** Inside the far room, one cell south of the hall exit. */
const FAR_DOORWAY = cellCenter({ col: HALL_MID_COL, row: FAR_REGION.row });
/** First cell inside the hall, on the board side. */
const HALL_NORTH = cellCenter({ col: HALL_MID_COL, row: HALL_REGION.row });
/** Last cell inside the hall, on the far-room side. */
const HALL_SOUTH = cellCenter({ col: HALL_MID_COL, row: HALL_REGION.row + HALL_REGION.rows - 1 });

const FIRST_NAMES = ["Bran", "Kael", "Mira", "Oswin", "Tamsin", "Vek", "Yara", "Dorn", "Isolde", "Rook"];
const LAST_NAMES = ["the Bold", "Ashfoot", "Quickblade", "of Thornvale", "Emberhand", "Greycloak", "the Lost"];

const pick = <T,>(values: readonly T[]): T => values[Math.floor(Math.random() * values.length)]!;

// ------------------------------------------------------------------ types

interface Actor {
  id: string;
  name: string;
  cell: Cell;
  pos: Point;
  x: number;
  y: number;
  facing: 1 | -1;
  health: number;
  maxHealth: number;
}

interface Hound extends Actor {
  kind: "hellhound" | "bat";
  glyph: string;
  color: string;
  aggro: boolean;
  nextAttackAt: number;
  attackUntil?: number;
  patrolLeft: number;
  patrolRight: number;
  patrolDir: 1 | -1;
  heading: Point;
  patrolAngle?: number;
  diveAt?: number | null;
  diveHit?: boolean;
  diveOrigin?: Point;
  diveTarget?: Point;
  orbitAngle?: number;
}

interface DamageNumber {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
  age: number;
}

interface Thrown {
  projectile: Projectile;
  target: Point;
  enemyId: string;
  damage: number;
}

// ------------------------------------------------------------------ simulation

export class TacticsGame {
  private readonly playerName = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
  private readonly playerColor = `hsl(${Math.floor(Math.random() * 360)} 85% 65%)`;

  private player!: Actor;
  private enemies!: Hound[];
  private corpses!: Corpse[];

  private phase!: Phase;

  private targetId!: string | null;
  private targetDoor!: DoorId | null;
  private activeSlot = 0;
  private log!: string[];

  private thrown!: Thrown | null;
  private damageNumbers!: DamageNumber[];
  private tombstones!: Array<{ x: number; y: number; gameElapsedMs: number }>;
  private inspectingId!: string | null;
  /** Doorway state stays open so connected dungeon regions always render. */
  private doors!: Record<DoorId, boolean>;

  private strikes!: Array<{ enemyId: string; seq: number }>;
  private strikeSeq = 0;

  /**
   * Each pursuing hound's place in the line abreast, as an angle about the
   * player. Recomputed once at the top of every tick rather than per hound,
   * because the enemy loop moves them one at a time: worked out inside
   * `chooseGoal`, the second hound would be solving against a board the first
   * had already changed, and the two could claim the same slot on the same tick.
   */
  private flankSlot = new Map<string, number>();

  private deathAt!: number;
  private killCount!: number;
  private nextEnemySeq = 0;

  /** The direction WASD is pushing, as a unit vector or zero. */
  private moveDir: Point = { x: 0, y: 0 };
  private moveTurnsPlayer = true;
  private playerRunning = false;
  private playerHeading: Point = { x: 1, y: 0 };
  private jumpUntil = 0;
  private eatingUntil = 0;
  private eatingCorpseId: string | null = null;
  private eatenCorpseIds = new Set<string>();
  /** Click-to-move destination, cleared on arrival or when WASD overrides. */
  private moveTarget: Point | null = null;

  /** Legacy input state retained in snapshots for client compatibility. */
  private waiting = false;

  /** Player attack cooldown. */
  private nextAttackAt = 0;
  private cooldownSlot = 0;
  private cooldownStart: number | null = null;
  private cooldownTotal = 0;

  private autoRestart = false;

  private gameElapsedMs = 0;
  private lastTick = 0;

  /**
   * **The simulation's own clock, and the only one any rule reads.** It advances
   * with the tick while the world is running and simply stops while it isn't, so
   * a deadline set before a pause — a bite due in 900ms, an attack cooldown, the
   * auto-resurrect timer — is still 900ms away when the world starts again.
   *
   * Everything public still takes wall-clock ms, because `index.ts` and the
   * freeze rule itself need real time; the conversion happens here and nowhere
   * else. Deriving deadlines from `Date.now()` instead is what breaks: a minute
   * of standing still would retire every timer at once and the pack would get a
   * minute of free bites the instant you moved.
   */
  private simNow = 0;

  constructor(now: number = Date.now()) {
    this.reset(now);
  }

  // ------------------------------------------------------------------ setup

  private reset(now: number): void {
    this.player = {
      id: "player",
      name: this.playerName,
      cell: { ...PLAYER_START },
      pos: cellCenter(PLAYER_START),
      ...cellCenter(PLAYER_START),
      facing: 1,
      health: PLAYER_MAX_HEALTH,
      maxHealth: PLAYER_MAX_HEALTH,
    };

    this.enemies = HOUND_STARTS.map((cell) => {
      const center = cellCenter(cell);
      const hound: Hound = {
        id: `hound-${this.nextEnemySeq++}`,
        kind: "hellhound",
        ...HELLHOUND,
        cell: { ...cell },
        pos: center,
        ...center,
        facing: -1,
        health: HOUND_MAX_HEALTH,
        maxHealth: HOUND_MAX_HEALTH,
        aggro: false,
        nextAttackAt: 0,
        patrolLeft: center.x,
        patrolRight: center.x,
        patrolDir: -1,
        heading: { x: -1, y: 0 },
      };
      // Same seating a hound gets when it gives up on you, so a beat is laid
      // out one way and not two.
      this.seatPatrol(hound, center);
      return hound;
    });
    const batCentre = cellCenter({
      col: BAT_REGION.col + Math.floor(BAT_REGION.cols / 2),
      row: BAT_REGION.row + Math.floor(BAT_REGION.rows / 2),
    });
    this.enemies.push({
      id: "bat-0",
      kind: "bat",
      name: "Vampire Bat",
      glyph: "B",
      color: "#702020",
      cell: cellAtPoint(batCentre)!,
      pos: batCentre,
      ...batCentre,
      facing: -1,
      health: 80,
      maxHealth: 80,
      aggro: false,
      nextAttackAt: 0,
      patrolLeft: batCentre.x,
      patrolRight: batCentre.x,
      patrolDir: 1,
      heading: { x: 1, y: 0 },
      patrolAngle: 0,
      diveAt: null,
      diveHit: false,
      diveOrigin: undefined,
      diveTarget: undefined,
      orbitAngle: 0,
    });

    this.corpses = [];
    this.phase = "player";
    this.targetId = null;
    this.targetDoor = null;
    this.thrown = null;
    this.damageNumbers = [];
    this.tombstones = [];
    this.inspectingId = null;
    this.doors = { arena: true, far: true };
    this.strikes = [];
    this.moveDir = { x: 0, y: 0 };
    this.moveTurnsPlayer = true;
    this.playerRunning = false;
    this.playerHeading = { x: 1, y: 0 };
    this.moveTarget = null;
    this.jumpUntil = 0;
    this.eatingUntil = 0;
    this.eatingCorpseId = null;
    this.eatenCorpseIds.clear();
    this.nextAttackAt = 0;
    this.waiting = false;
    this.deathAt = 0;
    this.killCount = 0;
    this.cooldownStart = null;
    this.log = ["A hellhound watches you from near the vault door."];
    this.lastTick = now;
  }

  // ------------------------------------------------------------------- tick

  tick(realNow: number): void {
    const dt = Math.min((realNow - this.lastTick) / 1000, 0.1);
    // Advanced whether or not the world runs, so a resume starts from *now*
    // rather than replaying however long the pause lasted as one huge step.
    this.lastTick = realNow;

    // Real-time simulation: the world advances every server tick, regardless
    // of whether the player is moving, attacking, or standing still.
    this.simNow += dt * 1000;
    this.gameElapsedMs += dt * 1000;

    if (this.phase === "dead" && this.autoRestart && this.simNow - this.deathAt >= AUTO_RESTART_DELAY_MS) {
      this.restart(realNow);
      return;
    }

    this.completeEating();

    if (isOver(this.phase)) return;

    // Player movement — continuous, every tick.
    this.movePlayer(dt);

    // Enemy AI — woken hounds chase and attack, others patrol. The pack picks
    // its line abreast first, off one board, before any of it moves.
    this.assignFlanks();
    for (const enemy of this.enemies) {
      if (enemy.kind === "bat") {
        this.updateBat(enemy, dt, this.simNow);
        continue;
      }
      if (enemy.aggro) {
        this.updateEnemy(enemy, dt, this.simNow);
      } else {
        this.patrolEnemy(enemy, dt);
      }
    }

    this.advanceThrown(dt);
    this.updateDamageNumbers(dt);
    this.wakeAdjacent();
    this.faceThePlayer();
    this.retireDead();

    if (this.player.health <= 0) {
      this.tombstones.push({ x: this.player.x, y: this.player.y, gameElapsedMs: this.gameElapsedMs });
      this.deathAt = this.simNow;
      this.finish("dead", "The hellhound pulls you down.");
      return;
    }
  }

  // --------------------------------------------------------- player movement

  /**
   * Move the player each tick. WASD (moveDir) has priority over click-to-move
   * (moveTarget). Position updates are free-form — no grid snapping.
   */
  private movePlayer(dt: number): void {
    if (this.eating()) return;
    const dirLen = Math.hypot(this.moveDir.x, this.moveDir.y);

    if (dirLen > 0.001) {
      // WASD: move in the held direction, cancelling any click target.
      this.moveTarget = null;
      const nx = this.moveDir.x / dirLen;
      const ny = this.moveDir.y / dirLen;
      const movingForward = nx * this.playerHeading.x + ny * this.playerHeading.y > 0.5;
      const jumpMomentum = this.jumping() && movingForward ? JUMP_SPEED_MULTIPLIER : 1;
      const runMomentum = this.playerRunning ? PLAYER_RUN_MULTIPLIER : 1;
      const step = PLAYER_SPEED * runMomentum * jumpMomentum * dt;
      this.stepPlayer(nx * step, ny * step, this.moveTurnsPlayer);
    } else if (this.moveTarget) {
      // Click-to-move: walk toward the target.
      const from = this.playerAt();
      const remaining = distance(from, this.moveTarget);
      if (remaining < 2) {
        this.moveTarget = null;
        return;
      }
      const step = Math.min(PLAYER_SPEED * dt, remaining);
      const nx = (this.moveTarget.x - from.x) / remaining;
      const ny = (this.moveTarget.y - from.y) / remaining;
      if (!this.stepPlayer(nx * step, ny * step)) this.moveTarget = null;
    }
  }

  /** Apply a pixel displacement to the player, clamping to the floor. Returns whether it moved. */
  private stepPlayer(dx: number, dy: number, turnToTravel = true): boolean {
    const from = this.playerAt();
    const raw = { x: from.x + dx, y: from.y + dy };
    const target = this.stopAtDoor(from, clampPointToFloor(raw));
    if (distance(from, target) < 0.01) return false;

    if (turnToTravel) {
      const travel = distance(from, target);
      this.playerHeading = { x: (target.x - from.x) / travel, y: (target.y - from.y) / travel };
      if (Math.abs(this.playerHeading.x) > 0.001) this.player.facing = this.playerHeading.x >= 0 ? 1 : -1;
    }
    this.player.pos = { ...target };
    this.player.x = target.x;
    this.player.y = target.y;
    this.player.cell = clampToGrid(target);
    return true;
  }

  // --------------------------------------------------------- enemy AI

  /** Is anything else in the pack standing where this hound wants to be? */
  private crowds(enemy: Hound, point: Point): boolean {
    return this.enemies.some(
      (other) => other.id !== enemy.id && distance(point, this.at(other)) < MIN_SEPARATION,
    );
  }

  /** Is this point somewhere a hound may actually stand? */
  private onFloor(point: Point): boolean {
    return distance(clampPointToFloor(point), point) < 0.001;
  }

  /**
   * Push a hound's intended position out of any packmate it would be standing
   * in. `MIN_SEPARATION` has always been documented as "nothing may stand
   * inside anything else" and until now nothing enforced it for the pack — it
   * was only ever a click hit-radius — so two hounds converging from the same
   * side merged into a single silhouette.
   *
   * Resolved against the others' *current* positions, which is what the tick's
   * one-at-a-time loop makes available.
   */
  private separate(enemy: Hound, want: Point): Point {
    let point = want;
    for (let pass = 0; pass < SEPARATION_PASSES; pass++) {
      let pushed = false;
      for (const other of this.enemies) {
        if (other.id === enemy.id) continue;
        const at = this.at(other);
        let dx = point.x - at.x;
        let dy = point.y - at.y;
        let gap = Math.hypot(dx, dy);
        if (gap >= MIN_SEPARATION) continue;
        // Exactly coincident: there is no direction to push along, so take one
        // from the ids rather than dividing by zero and writing NaN onto the
        // wire. Which way hardly matters — that they part, and always the same
        // way for the same pair, does.
        if (gap < 0.001) {
          dx = enemy.id > other.id ? 1 : -1;
          dy = 0;
          gap = 1;
        }
        point = { x: at.x + (dx / gap) * MIN_SEPARATION, y: at.y + (dy / gap) * MIN_SEPARATION };
        pushed = true;
      }
      if (!pushed) break;
    }
    return point;
  }

  /**
   * How hard a hound is leaning away from its packmates, as a vector to blend
   * into the chase.
   *
   * The hard push-apart guarantees bodies never overlap, and on its own that is
   * what puts the pack in single file: a hound whose road is blocked presses
   * toward its goal, gets clamped back every tick, and stands there grinding
   * against the one in front for the rest of the fight — out of reach, and
   * never getting round. Leaning away *while the goal still pulls* turns the
   * press into a slide around. The two forces together are what make a pack
   * open out instead of queueing.
   */
  private avoid(enemy: Hound, at: Point): Point {
    let ax = 0;
    let ay = 0;
    for (const other of this.enemies) {
      if (other.id === enemy.id) continue;
      const there = this.at(other);
      const dx = at.x - there.x;
      const dy = at.y - there.y;
      const gap = Math.hypot(dx, dy);
      if (gap >= AVOID_RANGE || gap < 0.001) continue;
      // Hardest right up against a packmate, nothing at all at the edge of
      // notice — so arriving hounds ease apart rather than bouncing off.
      const push = (AVOID_RANGE - gap) / AVOID_RANGE;
      ax += (dx / gap) * push;
      ay += (dy / gap) * push;
    }
    return { x: ax, y: ay };
  }

  /**
   * Commit a hound's step: onto floor, and out of its packmates. Every move a
   * hound makes goes through here — patrol and chase alike — so there is one
   * place that decides where a body may end up, rather than the same six lines
   * of bookkeeping twice with the rule in neither.
   */
  private place(enemy: Hound, raw: Point): Point {
    // Hounds are much longer than the player's eye clearance. Keep their
    // centre a full body radius from a closed slab so the muzzle and lunge rig
    // cannot visually pass through while the simulation remains outside.
    const wanted = this.stopAtDoor(this.at(enemy), clampPointToFloor(raw), MIN_SEPARATION);
    let target = wanted;

    if (this.crowds(enemy, wanted)) {
      const clear = this.separate(enemy, wanted);
      // The push only counts if it lands on floor. Where it can't — the
      // corridor, which is barely two hounds wide — the one behind holds where
      // it is rather than squeezing through its packmate. That is the single
      // place the pack cannot go side by side, and queueing is what a tunnel
      // ought to force.
      target = this.onFloor(clear) ? clear : this.at(enemy);
    }

    enemy.pos = { ...target };
    enemy.x = target.x;
    enemy.y = target.y;
    enemy.cell = clampToGrid(target);
    return target;
  }

  /**
   * Where each pursuing hound is headed, as an angle about the player.
   *
   * Every hound used to solve this alone — the direction from the player out to
   * itself, at biting distance — which is the *same answer* for any two coming
   * in from the same side. So the pack converged on one point, and once bodies
   * stopped passing through each other the one behind spent the rest of the
   * fight wedged against its packmate's back, out of reach and unable to get
   * round. Spreading the aim is what stops that happening; the push-apart is
   * only the backstop for when it isn't enough.
   *
   * **Only hounds sharing a side are spread.** Approaches are staged east and
   * west, so those are the only two sides there are, and two hounds already on
   * opposite ones are flanking properly — nothing to fix, and rotating them
   * would walk one round the player for no reason. It is a pack crowding in
   * from the *same* side that has to open out into a line abreast.
   *
   * Sorted by where they already are rather than by their place in the array:
   * the hound further round takes the slot further round, so each keeps its
   * place in the line. By array position the pack could swap ends mid-chase and
   * cross through each other to do it.
   *
   * A hound still finding its way through the corridor gets no slot — it is
   * steering by waypoints, and has no side to hold until it is in the room.
   */
  private assignFlanks(): void {
    this.flankSlot.clear();
    const player = this.playerAt();
    const playerRegion = this.regionOfCell(this.player.cell);
    const pack = this.enemies.filter(
      (enemy) => enemy.aggro && this.regionOfCell(enemy.cell) === playerRegion,
    );
    if (pack.length < 2) return;

    for (const side of [1, -1] as const) {
      const abreast = pack.filter((enemy) => (this.at(enemy).x >= player.x ? 1 : -1) === side);
      if (abreast.length < 2) continue;

      // Ascending around the arc. Screen y grows downward, so on the west side
      // that order is reversed — the same sweep seen from the other end.
      const order = [...abreast].sort((a, b) => side * (this.at(a).y - this.at(b).y));
      order.forEach((enemy, i) => {
        this.flankSlot.set(enemy.id, (i - (order.length - 1) / 2) * FLANK_ANGLE);
      });
    }
  }

  /**
   * Horizontal patrol for a hound that hasn't noticed the player yet. It walks
   * back and forth within its patrol beat, reversing at either end.
   */
  private updateBat(bat: Hound, dt: number, now: number): void {
    const player = this.playerAt();
    let gap = distance(this.at(bat), player);
    if (!bat.aggro && gap <= AGGRO_RANGE * 1.25) bat.aggro = true;

    if (!bat.aggro) {
      bat.patrolAngle = (bat.patrolAngle ?? 0) + dt * BAT_PATROL_ANGULAR_SPEED;
      const centre = regionCentre(BAT_REGION);
      const next = {
        x: centre.x + Math.cos(bat.patrolAngle) * BAT_PATROL_RADIUS,
        y: centre.y + Math.sin(bat.patrolAngle) * BAT_PATROL_RADIUS,
      };
      bat.heading = { x: -Math.sin(bat.patrolAngle), y: Math.cos(bat.patrolAngle) };
      bat.x = next.x;
      bat.y = next.y;
      bat.pos = next;
      bat.cell = cellAtPoint(next) ?? bat.cell;
      return;
    }

    if (bat.diveAt === null || bat.diveAt === undefined) {
      bat.orbitAngle = (bat.orbitAngle ?? 0) + dt * 0.9;
      const orbitRadius = MELEE_RANGE * 1.3;
      const orbitTarget = {
        x: player.x + Math.cos(bat.orbitAngle) * orbitRadius,
        y: player.y + Math.sin(bat.orbitAngle) * orbitRadius,
      };
      const dx = orbitTarget.x - bat.x;
      const dy = orbitTarget.y - bat.y;
      const len = Math.max(0.001, Math.hypot(dx, dy));
      bat.heading = { x: dx / len, y: dy / len };
      if (gap > orbitRadius * 0.9) {
        const step = Math.min(gap, BAT_PURSUIT_SPEED * dt);
        const next = { x: bat.x + bat.heading.x * step, y: bat.y + bat.heading.y * step };
        const cell = cellAtPoint(next);
        if (cell) {
          bat.x = next.x;
          bat.y = next.y;
          bat.pos = next;
          bat.cell = cell;
          gap = distance(next, player);
        }
      }
      if (now < bat.nextAttackAt || gap > BAT_DIVE_TRIGGER_RANGE) return;
      bat.diveAt = now;
      bat.diveHit = false;
      bat.diveOrigin = { x: bat.x, y: bat.y };
      bat.diveTarget = { x: player.x, y: player.y };
    }

    const age = now - bat.diveAt;
    const diveTarget = bat.diveTarget ?? player;
    const dx = diveTarget.x - bat.x;
    const dy = diveTarget.y - bat.y;
    const len = Math.max(0.001, Math.hypot(dx, dy));
    bat.heading = { x: dx / len, y: dy / len };
    if (age < BAT_STRIKE_AT_MS) {
      const origin = bat.diveOrigin ?? { x: bat.x, y: bat.y };
      const rawT = Math.max(0, Math.min(1, age / BAT_STRIKE_AT_MS));
      const t = rawT * rawT * (3 - 2 * rawT);
      const next = {
        x: origin.x + (diveTarget.x - origin.x) * t,
        y: origin.y + (diveTarget.y - origin.y) * t,
      };
      const cell = cellAtPoint(next);
      if (cell) {
        bat.x = next.x;
        bat.y = next.y;
        bat.pos = next;
        bat.cell = cell;
      }
    }
    if (!bat.diveHit && age >= BAT_STRIKE_AT_MS) {
      bat.diveHit = true;
      if (distance(this.at(bat), player) <= BAT_BITE_RANGE && this.batAttackConeContains(bat, player)) {
        this.player.health = Math.max(0, this.player.health - 10);
        if (Math.random() < 0.2) {
          bat.health = Math.min(bat.maxHealth, bat.health + 10);
          this.spawnDamageNumber(bat.x, bat.y, "+10", DAMAGE_COLOR_DEALT);
        }
        this.strikes.push({ enemyId: bat.id, seq: this.strikeSeq++ });
      }
    }
    if (age >= BAT_DIVE_MS) {
      bat.diveAt = null;
      bat.diveOrigin = undefined;
      bat.diveTarget = undefined;
      bat.nextAttackAt = now + BAT_ATTACK_INTERVAL_MS;
    }
  }

  private batAltitude(bat: Hound): number {
    if (bat.diveAt === null || bat.diveAt === undefined) {
      return bat.aggro ? BAT_AGGRO_ALTITUDE : BAT_CRUISE_ALTITUDE;
    }
    const age = this.simNow - bat.diveAt;
    const recoveryAltitude = bat.aggro ? BAT_AGGRO_ALTITUDE : BAT_CRUISE_ALTITUDE;
    if (age <= BAT_STRIKE_AT_MS) {
      return recoveryAltitude
        - (age / BAT_STRIKE_AT_MS) * (recoveryAltitude - BAT_DIVE_ALTITUDE);
    }
    if (age <= BAT_STRIKE_AT_MS + BAT_DIVE_LINGER_MS) return BAT_DIVE_ALTITUDE;
    const rise = Math.min(1,
      (age - BAT_STRIKE_AT_MS - BAT_DIVE_LINGER_MS) / BAT_DIVE_RECOVERY_MS);
    return BAT_DIVE_ALTITUDE + rise * (recoveryAltitude - BAT_DIVE_ALTITUDE);
  }

  private patrolEnemy(enemy: Hound, dt: number): void {
    const pos = this.at(enemy);
    let nx = pos.x + PATROL_SPEED * dt * enemy.patrolDir;

    if (nx <= enemy.patrolLeft) {
      nx = enemy.patrolLeft;
      enemy.patrolDir = 1;
    } else if (nx >= enemy.patrolRight) {
      nx = enemy.patrolRight;
      enemy.patrolDir = -1;
    }

    this.place(enemy, { x: nx, y: pos.y });
    enemy.facing = enemy.patrolDir;
    enemy.heading = { x: enemy.patrolDir, y: 0 };
  }

  /**
   * One enemy's per-tick behaviour: chase the player, bite when close enough.
   */
  private updateEnemy(enemy: Hound, dt: number, now: number): void {
    const enemyPos = this.at(enemy);
    const playerPos = this.playerAt();
    // Hold both position and heading until the imported bite finishes.
    if (now < (enemy.attackUntil ?? 0)) return;
    this.turnHoundToward(enemy, playerPos, dt);

    // Resolve a bite first, then keep the hound physically planted for the
    // duration of its imported attack animation.
    const toPlayerX = playerPos.x - enemyPos.x;
    const toPlayerY = playerPos.y - enemyPos.y;
    const playerGap = Math.hypot(toPlayerX, toPlayerY);
    // A broad forward cone: generous at the sides, but never through the
    // hound's flank or back while it is still trying to turn around.
    const playerInBiteCone = playerGap < 0.001 ||
      (toPlayerX * enemy.heading.x + toPlayerY * enemy.heading.y) / playerGap >= HOUND_ATTACK_CONE_DOT;
    const biting = canReach(enemyPos, playerPos) && playerInBiteCone;
    if (biting && !this.jumping() && now >= enemy.nextAttackAt) {
      const biteDamage = Math.random() < 0.5 ? 10 : 20;
      this.strikes.push({ enemyId: enemy.id, seq: ++this.strikeSeq });
      this.player.health = Math.max(0, this.player.health - biteDamage);
      this.inspectingId = null;
      enemy.nextAttackAt = now + ENEMY_ATTACK_INTERVAL_MS;
      enemy.attackUntil = now + HOUND_ATTACK_ANIMATION_MS;
    }

    if (now < (enemy.attackUntil ?? 0)) return;

    // Chase: move toward a position where the enemy could bite.
    const goal = this.chooseGoal(enemy);
    if (!goal) return;

    const gap = distance(enemyPos, goal);
    // Standing on its place already. The slack is what stops a hound shuffling
    // on the spot for the rest of the fight over a pixel of arithmetic.
    if (gap < ARRIVE_SLACK) {
      if (biting) enemy.facing = facingToward(enemyPos, playerPos, enemy.facing);
      return;
    }

    // Where it wants to go, bent by how hard it is leaning off its packmates.
    const steer = this.avoid(enemy, enemyPos);
    let nx = (goal.x - enemyPos.x) / gap + steer.x * AVOID_WEIGHT;
    let ny = (goal.y - enemyPos.y) / gap + steer.y * AVOID_WEIGHT;
    const len = Math.hypot(nx, ny);
    if (len < 0.001) return;
    nx /= len;
    ny /= len;

    const step = Math.min(ENEMY_SPEED * dt, gap);
    const target = this.place(enemy, { x: enemyPos.x + nx * step, y: enemyPos.y + ny * step });
    // Close enough to bite, it keeps its head on you while it shifts; crossing
    // the room, it looks where it is going, or it strafes.
    enemy.facing = biting
      ? facingToward(enemyPos, playerPos, enemy.facing)
      : facingToward(enemyPos, target, enemy.facing);
  }

  private turnHoundToward(enemy: Hound, target: Point, dt: number): void {
    const dx = target.x - enemy.x;
    const dy = target.y - enemy.y;
    if (Math.hypot(dx, dy) < 0.001) return;
    const current = Math.atan2(enemy.heading.y, enemy.heading.x);
    const wanted = Math.atan2(dy, dx);
    const delta = Math.atan2(Math.sin(wanted - current), Math.cos(wanted - current));
    const turn = Math.max(-HOUND_TURN_SPEED * dt, Math.min(HOUND_TURN_SPEED * dt, delta));
    const angle = current + turn;
    enemy.heading = { x: Math.cos(angle), y: Math.sin(angle) };
    if (Math.abs(enemy.heading.x) > 0.001) enemy.facing = enemy.heading.x >= 0 ? 1 : -1;
  }

  /** Which region a cell belongs to, falling back to the board. */
  private regionOfCell(cell: Cell): Region {
    if (inRegion(HALL_REGION, cell)) return HALL_REGION;
    if (inRegion(FAR_REGION, cell)) return FAR_REGION;
    return BOARD_REGION;
  }

  /**
   * When enemy and player are in different regions, return the next waypoint
   * on the path through the corridor that connects them. From a wide room
   * the enemy first walks to the doorway (staying on floor the whole way),
   * then steps across into the hall once it is close enough.
   */
  private nextWaypoint(enemy: Hound): Point | null {
    const from = this.at(enemy);
    const enemyRegion = this.regionOfCell(enemy.cell);
    const playerRegion = this.regionOfCell(this.player.cell);

    if (enemyRegion === BOARD_REGION) {
      if (distance(from, BOARD_DOORWAY) > TILE_PX) return BOARD_DOORWAY;
      return HALL_NORTH;
    }

    if (enemyRegion === FAR_REGION) {
      if (distance(from, FAR_DOORWAY) > TILE_PX) return FAR_DOORWAY;
      return HALL_SOUTH;
    }

    // In the hall: head toward whichever end leads to the player.
    if (playerRegion === BOARD_REGION) return BOARD_DOORWAY;
    return FAR_DOORWAY;
  }

  /**
   * Pick a point the enemy wants to reach — somewhere it could bite from, on
   * the side it is already approaching from so two hounds flank naturally.
   *
   * When the enemy and player are in different regions the goal is a corridor
   * doorway rather than a combat position, so the hound navigates through
   * the corridor before trying to flank.
   *
   * Worked in angles about the player, because both things acting on the goal
   * are rotations: the hound's place in the line abreast (`assignFlanks`), and
   * `APPROACH_HALF_ANGLE`, which swings one coming from nearly straight above
   * or below round towards your shoulder. That second one used to be a hard
   * requirement of `canReach` and is now only staging — reach is a circle, so
   * wherever a hound ends up within it, it can bite.
   */
  private chooseGoal(enemy: Hound): Point | null {
    const from = this.at(enemy);
    const player = this.playerAt();

    // Different region: navigate through the corridor doorways first.
    const enemyRegion = this.regionOfCell(enemy.cell);
    const playerRegion = this.regionOfCell(this.player.cell);
    if (enemyRegion !== playerRegion) {
      return this.nextWaypoint(enemy);
    }

    // Same region: come in on the side it is already on, at its place in the
    // line, and no further round than the staged approach allows.
    const toEnemy = distance(player, from);
    if (toEnemy < 1) return null;

    // The axis of the side it is approaching from — due east or due west.
    const axis = from.x >= player.x ? 0 : Math.PI;
    const bearing = Math.atan2(from.y - player.y, from.x - player.x);

    // A slot is a *place* on that axis, not a nudge from wherever the hound
    // currently stands. Adding the two pinned a hound already out near the edge
    // of the arc against the clamp, which bunched the pack onto one bearing
    // instead of spreading it. With no slot (alone on its side) it comes
    // straight in from where it is.
    const slot = this.flankSlot.get(enemy.id);
    let offset = slot ?? Math.atan2(Math.sin(bearing - axis), Math.cos(bearing - axis));
    offset = Math.max(-APPROACH_HALF_ANGLE, Math.min(APPROACH_HALF_ANGLE, offset));

    const theta = axis + offset;
    // Stop near the outside of the enlarged reach circle. The old 70% target
    // put the now-larger wolf meshes inside one another before either attacked.
    const reach = MELEE_RANGE * 0.82;
    return { x: player.x + Math.cos(theta) * reach, y: player.y + Math.sin(theta) * reach };
  }

  // --------------------------------------------------------- shared tick helpers

  /**
   * Wake anything the player has come close enough to notice them — per hound,
   * so walking up to one leaves the other watching.
   *
   * **This is the only thing that ever writes `aggro`, and it only ever writes
   * `true`.** A hellhound that has noticed you is hunting you for the rest of
   * the encounter: there is no leash, no losing your scent, and no distance at
   * which one turns back. Outrunning the pack was built and taken out again —
   * the only ways a chase ends are killing them or dying.
   *
   * Worth knowing before adding anything that assumes a fight can lapse:
   * `snapshot.aggro` goes false only when the last woken hound is dead, so the
   * hunted eye stays lit from the first bark to the end of the encounter.
   */
  private wakeAdjacent(): void {
    const player = this.playerAt();
    for (const enemy of this.enemies) {
      if (enemy.aggro) continue;
      if (withinAggro(this.at(enemy), player)) this.wake(enemy);
    }
  }

  /** Centre a hound's patrol beat on a point, clamped to the floor it's on. */
  private seatPatrol(enemy: Hound, at: Point): void {
    enemy.patrolLeft = clampPointToFloor({ x: at.x - PATROL_SPAN / 2, y: at.y }).x;
    enemy.patrolRight = clampPointToFloor({ x: at.x + PATROL_SPAN / 2, y: at.y }).x;
  }

  private faceThePlayer(): void {
    for (const enemy of this.enemies) {
      if (!enemy.aggro) continue;
      // Only face the player when standing still (not mid-chase, handled in updateEnemy).
    }
  }

  private advanceThrown(dt: number): void {
    const thrown = this.thrown;
    if (!thrown) return;

    advanceDagger(thrown.projectile, dt);
    if (!daggerDone(thrown.projectile, thrown.target)) return;

    this.thrown = null;
    const enemy = this.enemies.find((e) => e.id === thrown.enemyId);
    if (!enemy) return;
    if (!this.batAttackWindow(enemy)) return;
    this.wound(enemy, thrown.damage);
  }

  private updateDamageNumbers(dt: number): void {
    for (let i = this.damageNumbers.length - 1; i >= 0; i--) {
      const dn = this.damageNumbers[i]!;
      dn.y -= DAMAGE_NUMBER_SPEED * dt;
      dn.age += dt;
      if (dn.age >= DAMAGE_NUMBER_LIFETIME) this.damageNumbers.splice(i, 1);
    }
  }

  private retireDead(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i]!;
      if (enemy.health > 0) continue;

      if (this.targetId === enemy.id) this.targetId = null;

      this.corpses.push(corpseOf({
        id: enemy.id,
        name: enemy.name,
        glyph: enemy.glyph,
        color: enemy.color,
        room: { ...ARENA_ROOM },
        x: enemy.x,
        y: enemy.y,
        facing: enemy.facing,
        kind: enemy.kind,
        altitude: enemy.kind === "bat" ? this.batAltitude(enemy) : undefined,
      }));
      if (this.corpses.length > MAX_CORPSES) this.corpses.shift();

      this.enemies.splice(i, 1);
      this.killCount++;
      this.say(`The ${enemy.name.toLowerCase()} falls.`);
    }
  }

  private finish(phase: Phase, line: string): void {
    this.phase = phase;
    this.moveTarget = null;
    this.moveDir = { x: 0, y: 0 };
    this.cooldownStart = null;
    this.inspectingId = null;
    this.say(line);
  }

  // ----------------------------------------------------------- combat

  private selectSlot(index: number): void {
    if (!TACTICS_ACTIONS[index]) return;
    this.activeSlot = index;
  }

  /** Swing forward, hitting the nearest hound caught in the attack cone. */
  private attack(): void {
    if (isOver(this.phase)) return;
    if (this.simNow < this.nextAttackAt) return;

    const action = TACTICS_ACTIONS[this.activeSlot];
    if (action?.kind === "interact") {
      this.say("Use Interact on a targeted door.");
      return;
    }
    const target = action?.kind === "melee"
      ? this.nearestEnemyInMeleeRange()
      : this.nearestEnemyInAttackCone();
    const reach = target ? this.playerCanReach(target) : false;

    // **Committing is the decision; connecting is the consequence.** A swing
    // that finds nothing — no mark, or a hound out of reach — still costs
    // the turn, and the pack still answers it.
    //
    // This is load-bearing now rather than merely fair. Time moves only when
    // something acts, so an attack that quietly did nothing left a player with
    // the sword out and a hound just out of reach holding *no* action at all:
    // the swing was refused, nothing spent time, and the world stood there. It
    // is also the game's only way to spend a turn on purpose, which is the job
    // the Wait button used to have back when it had nothing to do.
    if (!action || !target) {
      this.say("You swing at nothing.");
      this.startCooldown(MELEE_COOLDOWN_MS);
      return;
    }

    if (action.kind === "melee") {
      if (!reach) {
        this.say(`You swing and miss the ${target.name.toLowerCase()}.`);
        this.startCooldown(MELEE_COOLDOWN_MS);
        return;
      }
      const damage = this.enemyInPlayerDirectAttackCone(target) ? SWORD_FRONT_DAMAGE : SWORD_SIDE_DAMAGE;
      this.wound(target, damage);
      this.wake(target);
      this.say(`You cut the ${target.name.toLowerCase()} for ${damage}.`);
      this.startCooldown(MELEE_COOLDOWN_MS);
      return;
    }

    // Ranged: dead zone inside melee reach — too close to get the arm back.
    // Spends the turn like any other committed attack.
    if (reach) {
      this.say("Too close to throw — draw the sword, or back away.");
      this.startCooldown(RANGED_COOLDOWN_MS);
      return;
    }

    this.wake(target);

    const from = { x: this.player.x, y: this.player.y };
    const to = this.at(target);
    this.thrown = {
      projectile: spawnDagger(from, to),
      target: to,
      enemyId: target.id,
      damage: RANGED_DAMAGE,
    };
    this.say(`You throw a dagger at the ${target.name.toLowerCase()}.`);

    const flightMs = (Math.hypot(to.x - from.x, to.y - from.y) / PROJECTILE_SPEED) * 1000;
    this.startCooldown(flightMs + THROW_RECOVER_MS + RANGED_COOLDOWN_MS);
  }

  private startCooldown(totalMs: number): void {
    this.nextAttackAt = this.simNow + totalMs;
    this.cooldownSlot = this.activeSlot;
    this.cooldownStart = this.simNow;
    this.cooldownTotal = totalMs;
  }

  private wound(enemy: Hound, amount: number): void {
    enemy.health = Math.max(0, enemy.health - amount);
  }

  private wake(enemy: Hound): void {
    if (enemy.aggro) return;
    enemy.aggro = true;
    this.say(`The ${enemy.name.toLowerCase()} fixes on you.`);
  }

  // ------------------------------------------------------------------ input

  handleInput(msg: TacticsInput, now: number = Date.now()): void {
    if (msg.type === "restart") {
      this.restart(now);
      return;
    }

    if (this.inspectingId && msg.type !== "click" && msg.type !== "dblclick") {
      this.inspectingId = null;
    }

    switch (msg.type) {
      case "keydown":
        this.onKey(msg.key, msg.code, now);
        break;
      case "click":
        this.onClick({ x: msg.x, y: msg.y }, now);
        break;
      case "dblclick":
        this.onDoubleClick({ x: msg.x, y: msg.y });
        break;
      case "slot":
        this.selectSlot(msg.index);
        break;
      case "useSlot": {
        const action = TACTICS_ACTIONS[msg.index];
        if (action?.kind === "interact") {
          this.interactWithTargetDoor();
        } else if (action?.kind === "melee" || action?.kind === "ranged") {
          const selected = this.activeSlot;
          this.activeSlot = msg.index;
          this.attack();
          this.activeSlot = selected;
        }
        break;
      }
      case "attack":
        this.attack();
        break;
      case "wait":
        // Kept for wire compatibility; waiting no longer controls simulation.
        this.waiting = msg.held;
        break;
      case "move":
        this.setMoveDir(msg.dx, msg.dy, msg.turn !== false, msg.run === true);
        break;
      case "face":
        this.setHeading(msg.dx, msg.dy);
        break;
      case "jump":
        if (!isOver(this.phase) && !this.jumping()) this.jumpUntil = this.simNow + JUMP_MS;
        break;
      case "interact": {
        if (TACTICS_ACTIONS[this.activeSlot]?.kind !== "interact") {
          this.attack();
        } else {
          this.interactWithTargetDoor();
        }
        break;
      }
      case "targetDoor":
        this.targetDoor = this.targetDoor === msg.door ? null : msg.door;
        if (this.targetDoor) this.targetId = null;
        break;
      case "toggleDoor":
        if (this.canInteractWithDoor(msg.door, { x: msg.dx, y: msg.dy })) this.toggleDoor(msg.door);
        else this.say("You need to stand in front of the door and face it.");
        break;
      case "resurrect":
        this.restart(now);
        break;
      case "toggleAutoResurrect":
        this.autoRestart = !this.autoRestart;
        break;
      default:
        break;
    }
  }

  /** Set or clear the movement direction from WASD. */
  private setMoveDir(dx: number, dy: number, turnToTravel: boolean, run: boolean): void {
    this.moveDir = { x: dx, y: dy };
    this.moveTurnsPlayer = turnToTravel;
    this.playerRunning = run;
  }

  private setHeading(dx: number, dy: number): void {
    const length = Math.hypot(dx, dy);
    if (length > 0.001) {
      this.playerHeading = { x: dx / length, y: dy / length };
      // Keep the legacy left/right field aligned with deliberate rotation only.
      if (Math.abs(dx) > 0.001) this.player.facing = dx >= 0 ? 1 : -1;
    }
  }

  private jumping(): boolean {
    return this.simNow < this.jumpUntil;
  }

  private eating(): boolean {
    return this.eatingCorpseId !== null && this.simNow < this.eatingUntil;
  }

  private startEating(): void {
    if (this.eating() || this.phase === "dead") return;
    const player = this.playerAt();
    const corpse = this.corpses
      .filter((candidate) => !this.eatenCorpseIds.has(candidate.id) && distance(player, candidate) <= EAT_RANGE)
      .sort((a, b) => distance(player, a) - distance(player, b))[0];
    if (!corpse) {
      this.say("Stand on a hellhound's body to eat it.");
      return;
    }
    this.eatingCorpseId = corpse.id;
    this.eatingUntil = this.simNow + EAT_DURATION_MS;
    this.moveTarget = null;
    this.moveDir = { x: 0, y: 0 };
    this.playerRunning = false;
  }

  private completeEating(): void {
    if (this.eatingCorpseId === null || this.simNow < this.eatingUntil) return;
    const corpseIndex = this.corpses.findIndex((corpse) => corpse.id === this.eatingCorpseId);
    this.eatingCorpseId = null;
    this.eatingUntil = 0;
    if (corpseIndex < 0) return;
    const corpse = this.corpses[corpseIndex]!;
    this.eatenCorpseIds.add(corpse.id);
    const heal = corpse.kind === "bat" ? 15 : EAT_HEAL;
    this.player.health = Math.min(this.player.maxHealth, this.player.health + heal);
    this.spawnDamageNumber(this.player.x, this.player.y, `+${heal}`, "#ffffff");
  }

  private onKey(key: string, code: string, now: number): void {
    if (code === "Tab") return;
    if (key >= "1" && key <= "5" && key.length === 1) {
      this.selectSlot(Number(key) - 1);
      return;
    }
    if (key === " ") {
      this.attack();
      return;
    }
    if (key === "r") {
      this.restart(now);
      return;
    }
    if (key === "e") {
      this.startEating();
      return;
    }
    if (key === "escape") this.targetId = null;
  }

  private onClick(point: Point, now: number): void {
    if (this.inspectingId) {
      if (hitsRect(LOOT_CLOSE_RECT, point)) this.inspectingId = null;
      else if (hitsRect(LOOT_MENU_RECT, point)) return;
      else this.inspectingId = null;
      return;
    }

    if (isOver(this.phase)) {
      if (this.phase !== "dead") this.restart(now);
      return;
    }

    // Click-to-move: walk to the clicked point (no grid snapping).
    const cell = cellAtPoint(point);
    if (cell && inGrid(cell)) {
      this.targetDoor = null;
      this.moveTarget = { ...point };
      return;
    }

  }

  /** Stop a moving actor on its current side of each closed door plane. */
  private stopAtDoor(from: Point, target: Point, clearance = DOOR_CLEARANCE_PX): Point {
    const doorwayX = cellCenter({ col: HALL_MID_COL, row: 0 }).x;
    for (const id of ["arena", "far"] as const) {
      const y = DOOR_Y[id];
      const throughOpening = Math.abs(target.x - doorwayX) <= DOORWAY_WIDTH_PX / 2 - clearance;
      if (this.doors[id] && throughOpening) continue;
      // Clamp on entry to the clearance band, not merely when the actor's
      // centre crosses the door plane. The old crossing-only test let the eye
      // get almost flush with the wood; at an oblique angle the camera's near
      // plane then cut through it even though its origin remained outside.
      if (from.y < y && target.y > y - clearance) {
        return { x: target.x, y: y - clearance };
      }
      if (from.y > y && target.y < y + clearance) {
        return { x: target.x, y: y + clearance };
      }
    }
    return target;
  }

  /** A closing slab cannot materialise through an actor already in its swing. */
  private doorwayClear(id: DoorId): boolean {
    const y = DOOR_Y[id];
    // The interaction stance is one camera-clearance away from the slab and is
    // safe to close from. Only a player actually inside the thin door plane
    // blocks it; using the full movement clearance here made Space open the
    // door but refuse to close it again from the exact same valid position.
    if (Math.abs(this.player.y - y) < DOOR_CLEARANCE_PX * 0.4) return false;
    return this.enemies.every((enemy) => Math.abs(enemy.y - y) >= MIN_SEPARATION);
  }

  private canInteractWithDoor(id: DoorId, facing: Point): boolean {
    const centre = this.doorInteractionPoint(id);
    const dx = centre.x - this.player.x;
    const dy = centre.y - this.player.y;
    const gap = Math.hypot(dx, dy);
    const facingLength = Math.hypot(facing.x, facing.y);
    // An open slab has swung roughly half a doorway away from its closed plane.
    // Add that travel to the reach so a player on either side of the opening can
    // still close it while aiming at the wood's actual position.
    const reach = DOOR_INTERACT_RANGE + (this.doors[id] ? HALL_REGION.cols * TILE_PX / 2 : 0);
    if (gap > reach || gap < 0.001 || facingLength < 0.001) return false;
    return (dx * facing.x + dy * facing.y) / (gap * facingLength) >= DOOR_FACING_DOT;
  }

  /** Centre of the wooden slab, including its swing away from the doorway. */
  private doorInteractionPoint(id: DoorId): Point {
    const doorwayX = cellCenter({ col: HALL_MID_COL, row: 0 }).x;
    if (!this.doors[id]) return { x: doorwayX, y: DOOR_Y[id] };
    const passageWidth = DOORWAY_WIDTH_PX;
    const hingeX = doorwayX - passageWidth / 2;
    const halfSlab = (passageWidth - 0.12 * 30) / 2;
    const angle = (id === "arena" ? 1 : -1) * Math.PI * 0.48;
    return {
      x: hingeX + Math.cos(angle) * halfSlab,
      y: DOOR_Y[id] - Math.sin(angle) * halfSlab,
    };
  }

  private facedDoor(facing: Point): DoorId | null {
    for (const id of ["arena", "far"] as const) {
      if (this.canInteractWithDoor(id, facing)) return id;
    }
    return null;
  }

  private toggleDoor(id: DoorId): void {
    if (this.doors[id] && !this.doorwayClear(id)) {
      this.say("Something is blocking the door.");
      return;
    }
    this.doors[id] = !this.doors[id];
    this.moveTarget = null;
    this.say(`The ${id === "arena" ? "near" : "far"} door ${this.doors[id] ? "opens" : "closes"}.`);
  }

  private interactWithTargetDoor(): void {
    if (this.targetDoor && this.canInteractWithDoor(this.targetDoor, this.playerHeading)) {
      this.toggleDoor(this.targetDoor);
    } else {
      this.say("Target a nearby door and face it to interact.");
    }
  }

  private enemyNear(point: Point): Hound | null {
    let best: Hound | null = null;
    let bestGap = MIN_SEPARATION;
    for (const enemy of this.enemies) {
      const gap = distance(point, this.at(enemy));
      if (gap < bestGap) { bestGap = gap; best = enemy; }
    }
    return best;
  }

  private corpseNear(point: Point): Corpse | null {
    let best: Corpse | null = null;
    let bestGap = MIN_SEPARATION;
    for (const corpse of this.corpses) {
      const gap = distance(point, { x: corpse.x, y: corpse.y });
      if (gap < bestGap) { bestGap = gap; best = corpse; }
    }
    return best;
  }

  private onDoubleClick(point: Point): void {
    if (this.inspectingId) return;

    const corpse = this.corpseNear(point);
    if (corpse) {
      this.inspectingId = corpse.id;
    }
  }

  private restart(now: number): void {
    this.reset(now);
    this.say("You square up again.");
  }

  // ---------------------------------------------------------------- helpers

  private at(actor: Actor): Point {
    return actor.pos;
  }

  private playerAt(): Point {
    return this.at(this.player);
  }

  private nearestEnemyInAttackCone(): Hound | null {
    let nearest: Hound | null = null;
    let nearestGap = Infinity;
    for (const enemy of this.enemies) {
      const dx = enemy.x - this.player.x;
      const dy = enemy.y - this.player.y;
      const gap = Math.hypot(dx, dy);
      if (enemy.kind === "bat" && !this.batBodyContact(enemy)) continue;
      if (!this.batAttackWindow(enemy)) continue;
      if (this.enemyInPlayerAttackCone(enemy) && gap < nearestGap) {
        nearest = enemy;
        nearestGap = gap;
      }
    }
    return nearest;
  }

  private nearestEnemyInMeleeRange(): Hound | null {
    let nearest: Hound | null = null;
    let nearestGap = Infinity;
    for (const enemy of this.enemies) {
      const gap = distance(this.playerAt(), this.at(enemy));
      if (enemy.kind === "bat" && !this.batBodyContact(enemy)) continue;
      if (!this.batAttackWindow(enemy) || !this.enemyInPlayerAttackCone(enemy)) continue;
      const reach = MELEE_RANGE + (enemy.kind === "hellhound" ? HOUND_HITBOX_BONUS : 0);
      if (gap <= reach && gap < nearestGap) {
        nearest = enemy;
        nearestGap = gap;
      }
    }
    return nearest;
  }

  private enemyInPlayerAttackCone(enemy: Hound): boolean {
    const dx = enemy.x - this.player.x;
    const dy = enemy.y - this.player.y;
    const gap = Math.hypot(dx, dy);
    return gap < 0.001 ||
      (dx * this.playerHeading.x + dy * this.playerHeading.y) / gap >= ATTACK_CONE_DOT;
  }

  private playerCanReach(enemy: Hound): boolean {
    const reach = MELEE_RANGE + (enemy.kind === "hellhound" ? HOUND_HITBOX_BONUS : 0);
    return distance(this.playerAt(), this.at(enemy)) <= reach;
  }

  private enemyInPlayerDirectAttackCone(enemy: Hound): boolean {
    const dx = enemy.x - this.player.x;
    const dy = enemy.y - this.player.y;
    const gap = Math.hypot(dx, dy);
    return gap < 0.001 ||
      (dx * this.playerHeading.x + dy * this.playerHeading.y) / gap >= DIRECT_ATTACK_CONE_DOT;
  }

  /** Bat damage is valid only during its dive or while the player is airborne. */
  private batAttackWindow(enemy: Hound): boolean {
    return enemy.kind !== "bat" || this.jumping() || (enemy.diveAt !== null && enemy.diveAt !== undefined);
  }

  /** Oriented horizontal oval around the bat's torso, aligned to its heading. */
  private batBodyContact(enemy: Hound): boolean {
    const dx = this.player.x - enemy.x;
    const dy = this.player.y - enemy.y;
    const headingLength = Math.max(0.001, Math.hypot(enemy.heading.x, enemy.heading.y));
    const hx = enemy.heading.x / headingLength;
    const hy = enemy.heading.y / headingLength;
    const along = dx * hx + dy * hy;
    const across = dx * -hy + dy * hx;
    return (along * along) / (BAT_BODY_HALF_LENGTH * BAT_BODY_HALF_LENGTH)
      + (across * across) / (BAT_BODY_HALF_WIDTH * BAT_BODY_HALF_WIDTH) <= 1;
  }

  private batAttackConeContains(bat: Hound, point: Point): boolean {
    const dx = point.x - bat.x;
    const dy = point.y - bat.y;
    const gap = Math.hypot(dx, dy);
    if (gap < 0.001) return true;
    const headingLength = Math.max(0.001, Math.hypot(bat.heading.x, bat.heading.y));
    return (dx * bat.heading.x + dy * bat.heading.y) / (gap * headingLength) >= BAT_ATTACK_CONE_DOT;
  }

  private nextDamageNumberId = 0;

  private spawnDamageNumber(x: number, y: number, amount: number | string, color: string): void {
    this.damageNumbers.push({
      id: `dn-${this.nextDamageNumberId++}`,
      x, y, text: typeof amount === "string" ? amount : String(amount), color, age: 0,
    });
  }

  private say(line: string): void {
    this.log.push(line);
    if (this.log.length > LOG_LINES * 3) this.log.splice(0, this.log.length - LOG_LINES * 3);
  }

  private selectedCanAttack(): boolean {
    return this.actionViable(this.activeSlot);
  }

  private actionViable(index: number): boolean {
    const action = TACTICS_ACTIONS[index];
    if (action?.kind === "interact") {
      return this.targetDoor !== null && this.canInteractWithDoor(this.targetDoor, this.playerHeading);
    }
    if (this.simNow < this.nextAttackAt) return false;
    const target = action?.kind === "melee"
      ? this.nearestEnemyInMeleeRange()
      : this.nearestEnemyInAttackCone();
    if (!target) return false;
    const reach = this.playerCanReach(target);
    return action?.kind === "melee" ? reach : action?.kind === "ranged" ? !reach : false;
  }

  private hint(): string {
    switch (this.phase) {
      case "cleared":
        return "The pack is dead. Click anywhere to go again.";
      case "dead":
        return "Killed. Resurrect on the HUD, or press R.";
      default:
        break;
    }

    const target = this.nearestEnemyInAttackCone();
    if (this.targetDoor) {
      return this.canInteractWithDoor(this.targetDoor, this.playerHeading)
        ? "Door ready — 5 for Interact, then Space."
        : "Move in front of the targeted door and face it.";
    }
    if (!target) {
      return this.anyAwake()
        ? "Face a hellhound and attack, or WASD to move."
        : "Nothing has noticed you yet. Face one and throw, or walk closer.";
    }
    if (this.playerCanReach(target)) {
      return "In reach — 1 for the sword, Space to swing.";
    }
    return "Out of reach — 2 for a dagger, Space to throw. Or move closer.";
  }

  private anyAwake(): boolean {
    return this.enemies.some((e) => e.aggro);
  }

  /**
   * Standing in the band outside something's wake range. Sleeping hounds only:
   * once one is awake it is `anyAwake`'s business, and a warning about a hound
   * already eating you would be saying the wrong thing loudly.
   */
  private nearlyNoticed(): boolean {
    const player = this.playerAt();
    return this.enemies.some(
      (enemy) => !enemy.aggro && distance(this.at(enemy), player) <= AGGRO_WARN_RANGE,
    );
  }

  // --------------------------------------------------------------- snapshot

  snapshot(): TacticsSnapshot {
    const inspected = this.corpses.find((c) => c.id === this.inspectingId) ?? null;
    const dead = this.phase === "dead";

    const cooldown = this.cooldownStart === null || this.cooldownTotal <= 0
      ? null
      : {
          slot: this.cooldownSlot,
          remainingMs: Math.max(0, this.cooldownStart + this.cooldownTotal - this.simNow),
          totalMs: this.cooldownTotal,
        };

    return {
      playerHeading: { ...this.playerHeading },
      playerRunning: this.playerRunning,
      playerEating: this.eating(),
      doors: { ...this.doors },
      targetDoor: this.targetDoor,
      player: {
        x: this.player.x,
        y: this.player.y,
        color: this.playerColor,
        name: this.playerName,
        room: { ...ARENA_ROOM },
        facing: this.player.facing,
      },
      stats: {
        level: 1,
        health: this.player.health,
        maxHealth: this.player.maxHealth,
        mana: PLAYER_MAX_MANA,
        maxMana: PLAYER_MAX_MANA,
      },
      enemies: this.enemies.map((e) => ({
        id: e.id,
        kind: e.kind,
        name: e.name,
        glyph: e.glyph,
        color: e.color,
        room: { ...ARENA_ROOM },
        x: e.x,
        y: e.y,
        health: e.health,
        maxHealth: e.maxHealth,
        chasing: e.aggro,
        aggro: e.aggro,
        facing: e.facing,
        heading: { ...e.heading },
        altitude: e.kind === "bat" ? this.batAltitude(e) : undefined,
      })),
      corpses: this.corpses.map((c) => ({
        id: c.id,
        name: c.name,
        glyph: c.glyph,
        color: c.color,
        room: c.room,
        x: c.x,
        y: c.y,
        facing: c.facing,
        kind: c.kind,
        altitude: c.altitude,
      })),
      inspect: inspected
        ? {
            corpseId: inspected.id,
            title: corpseLabel(inspected),
            loot: inspected.loot.map((item) => ({ name: item.name })),
          }
        : null,
      projectiles: this.thrown ? [{ ...this.thrown.projectile }] : [],
      damageNumbers: this.damageNumbers.map((dn) => ({ ...dn })),
      targetId: null,
      attacking: false,
      activeSlot: this.activeSlot,
      cooldown,
      selectedCanAttack: this.selectedCanAttack(),
      viableActions: TACTICS_ACTIONS.map((_, index) => this.actionViable(index)),
      moveTarget: this.moveTarget ? { ...this.moveTarget } : null,
      pathCells: [],
      gameElapsedMs: this.gameElapsedMs,
      killCount: this.killCount,
      dead,
      autoResurrect: this.autoRestart,
      resurrectInMs:
        dead && this.autoRestart
          ? Math.max(0, AUTO_RESTART_DELAY_MS - (this.simNow - this.deathAt))
          : null,
      tombstones: this.tombstones.map((t) => ({
        x: t.x,
        y: t.y,
        room: { ...ARENA_ROOM },
        gameElapsedMs: t.gameElapsedMs,
      })),

      // Kept for TacticsSnapshot compatibility.
      phase: this.phase,
      round: 0,
      moveRange: isOver(this.phase) ? 0 : MOVE_RANGE,
      moveFrom: this.playerAt(),
      meleeRange: MELEE_RANGE,
      aggro: this.anyAwake(),
      nearAggro: this.nearlyNoticed(),
      waiting: this.waiting,
      strikes: this.strikes.map((s) => ({ ...s })),
      log: this.log.slice(-LOG_LINES),
      hint: this.hint(),
      paused: false,
    };
  }
}
