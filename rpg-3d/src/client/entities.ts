/**
 * Scene-graph bookkeeping and animation: one rig per thing in the snapshot,
 * created and destroyed as ids come and go.
 *
 * Nothing here decides anything about the game. Every rig is a pure function of
 * the snapshot plus a few client-side timers (a swing, a flinch, a collapse)
 * that exist only so state changes read as motion instead of teleporting.
 *
 * Each rig is a `root` group carrying world position and yaw, with the model as
 * its child — so an animation can lean, dip or topple the model in its own
 * local space without fighting the heading.
 */

import * as THREE from "three";

import type { GameSnapshot } from "../../../src/shared/protocol.js";
import {
  buildDagger,
  buildHuman,
  buildTombstone,
  buildWolf,
  disposeObject,
  WOLF_SCALE,
  tintObject,
  type HumanRig,
  type WolfRig,
} from "./models.js";
import { angleDelta, damp, darken, normalizeAngle, parseColor, toX, toZ, yawFor } from "./world.js";

/** Above this many px/s an actor is "moving" and its gait runs. */
const MOVING_EPSILON = 6;

/** Full-speed references, so a slow walk swings its legs less than a sprint. */
const PLAYER_FULL_SPEED = 160;
const WOLF_FULL_SPEED = 140;

const SWING_MS = 320;
const LUNGE_MS = 300;
const COLLAPSE_MS = 450;
const FALL_MS = 600;

/** Walk one id-keyed map of rigs to match the snapshot's list. */
function syncKeys<T>(
  map: Map<string, T>,
  ids: Iterable<string>,
  create: (id: string) => T,
  destroy: (rig: T) => void,
): void {
  const live = new Set(ids);
  for (const id of live) if (!map.has(id)) map.set(id, create(id));
  for (const [id, rig] of map) {
    if (!live.has(id)) {
      destroy(rig);
      map.delete(id);
    }
  }
}

/** The entity a picked mesh belongs to — rigs tag their root, meshes don't. */
export function entityIdOf(object: THREE.Object3D | null): string | null {
  let node: THREE.Object3D | null = object;
  while (node) {
    const id = node.userData["entityId"];
    if (typeof id === "string") return id;
    node = node.parent;
  }
  return null;
}

// ------------------------------------------------------------------- player

export class PlayerActor {
  readonly root = new THREE.Group();
  private readonly rig: HumanRig;
  private yaw = 0;
  private gait = 0;
  private lastX: number | null = null;
  private lastY: number | null = null;
  /** ms into the current attack animation, or null when not swinging. */
  private swingAt: number | null = null;
  private fall = 0;

  constructor(color: string) {
    this.rig = buildHuman();
    // The tunic is always brown; the player's randomised colour — the one the
    // HUD portrait is drawn in — goes on the cloak instead.
    (this.rig.cloak.material as THREE.MeshLambertMaterial).color.copy(parseColor(color));
    this.root.add(this.rig.model);
  }

  /** Start the swing animation for the weapon that just fired. */
  swing(now: number): void {
    this.swingAt = now;
  }

  /** Which blade is in the fist — follows the action bar, like the 2D glyph. */
  setWeapon(kind: "melee" | "ranged"): void {
    this.rig.sword.visible = kind === "melee";
    this.rig.dagger.visible = kind === "ranged";
  }

  update(
    snap: GameSnapshot,
    facePoint: { x: number; y: number } | null,
    dt: number,
    now: number,
    elapsed: number,
  ): void {
    const { x, y } = snap.player;
    this.root.position.set(toX(x), 0, toZ(y));

    const dx = this.lastX === null ? 0 : x - this.lastX;
    const dy = this.lastY === null ? 0 : y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const speed = dt > 0 ? Math.hypot(dx, dy) / dt : 0;
    const moving = speed > MOVING_EPSILON && !snap.dead;

    // Heading: face what you're fighting, else the way you're travelling, else
    // hold — the same "facing is held when idle" rule the 2D glyph follows.
    let wanted = this.yaw;
    if (facePoint) wanted = yawFor(facePoint.x - x, facePoint.y - y);
    else if (moving) wanted = yawFor(dx, dy);
    else wanted = yawFor(snap.player.facing, 0);
    this.yaw += angleDelta(this.yaw, wanted) * (1 - Math.exp(-12 * dt));
    this.root.rotation.y = this.yaw;

    // Gait.
    const amp = Math.min(1, speed / PLAYER_FULL_SPEED);
    if (moving) this.gait += dt * (4 + amp * 8);
    const swingAmount = moving ? Math.sin(this.gait) * 0.55 * amp : 0;
    const legs = this.rig.legs;
    if (legs[0] && legs[1]) {
      legs[0].rotation.z = damp(legs[0].rotation.z, swingAmount, 18, dt);
      legs[1].rotation.z = damp(legs[1].rotation.z, -swingAmount, 18, dt);
    }

    const arms = this.rig.arms;
    if (arms[0]) arms[0].rotation.z = damp(arms[0].rotation.z, -swingAmount * 0.7, 18, dt);

    // The weapon arm: an attack overrides the gait for the length of the swing.
    const right = arms[1];
    if (right) {
      const attack = this.swingAt === null ? null : (now - this.swingAt) / SWING_MS;
      if (attack !== null && attack < 1) {
        right.rotation.z = swingAngle(attack);
      } else {
        // The arc travels a whole turn, so fold the angle back before handing it
        // to `damp` — otherwise the arm unwinds the full circle on the way to
        // its resting pose.
        if (this.swingAt !== null) right.rotation.z = normalizeAngle(right.rotation.z);
        this.swingAt = null;
        right.rotation.z = damp(right.rotation.z, swingAmount * 0.7, 18, dt);
      }
    }

    // Breathing, and the topple on death — the body stays where it fell, which
    // is where the tombstone lands.
    this.fall = damp(this.fall, snap.dead ? 1 : 0, 1000 / FALL_MS, dt);
    this.rig.model.rotation.z = -this.fall * (Math.PI / 2);
    this.rig.model.position.y = this.fall * 0.3 + (moving ? 0 : Math.sin(elapsed * 1.8) * 0.015);
  }
}

/**
 * An **overhand** swing, used by the sword and the dagger alike: the arm cocks
 * back over the shoulder, sweeps over the top, and drives down in front, ending
 * where it started.
 *
 * The arm swings about Z, where a *decreasing* angle takes it backwards and up,
 * so the arc runs from 0 down to -2PI — going the long way round the far side of
 * the circle is what makes this overhand rather than a forehand sweep through
 * the bottom. The blade sits square to the arm, so the hit lands as the arm
 * reaches forward: that is the moment the blade is pointing straight down. The
 * caller folds the final angle back into range.
 */
function swingAngle(t: number): number {
  if (t < 0.32) return lerp(0, -2.5, ease(t / 0.32)); // up and back over the shoulder
  if (t < 0.6) return lerp(-2.5, -4.9, ease((t - 0.32) / 0.28)); // over the top, chopping down
  return lerp(-4.9, -Math.PI * 2, ease((t - 0.6) / 0.4)); // follow through to hanging
}

function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// -------------------------------------------------------------------- wolves

/** Diagonal pairs move together, which is what makes a quadruped read as one. */
const LEG_PHASE = [0, Math.PI, Math.PI, 0];

class WolfActor {
  readonly root = new THREE.Group();
  readonly rig: WolfRig;
  private yaw = 0;
  private gait = 0;
  private lastX: number | null = null;
  private lastY: number | null = null;
  private hurt = 0;
  private lungeAt: number | null = null;
  private readonly accent: THREE.Color;

  constructor(id: string, color: string) {
    this.accent = parseColor(color);
    this.rig = buildWolf(this.accent);
    this.root.add(this.rig.model);
    this.root.userData["entityId"] = id;
  }

  flinch(): void {
    this.hurt = 1;
  }

  lunge(now: number): void {
    this.lungeAt = now;
  }

  update(
    enemy: GameSnapshot["enemies"][number],
    dt: number,
    now: number,
    elapsed: number,
    /** Something to square up to while standing still — its quarry. */
    facePoint: { x: number; y: number } | null = null,
  ): void {
    this.root.position.set(toX(enemy.x), 0, toZ(enemy.y));

    const dx = this.lastX === null ? 0 : enemy.x - this.lastX;
    const dy = this.lastY === null ? 0 : enemy.y - this.lastY;
    this.lastX = enemy.x;
    this.lastY = enemy.y;
    const speed = dt > 0 ? Math.hypot(dx, dy) / dt : 0;
    const moving = speed > MOVING_EPSILON;

    // Travel wins over the quarry, unlike the player: a wolf that held its head
    // on you while crossing the room would strafe. It turns when it arrives.
    const wanted = moving
      ? yawFor(dx, dy)
      : facePoint
        ? yawFor(facePoint.x - enemy.x, facePoint.y - enemy.y)
        : yawFor(enemy.facing, 0);
    this.yaw += angleDelta(this.yaw, wanted) * (1 - Math.exp(-10 * dt));
    this.root.rotation.y = this.yaw;

    const amp = Math.min(1, speed / WOLF_FULL_SPEED);
    if (moving) this.gait += dt * (5 + amp * 11);
    this.rig.legs.forEach((leg, i) => {
      const target = moving ? Math.sin(this.gait + LEG_PHASE[i]!) * 0.7 * amp : 0;
      leg.rotation.z = damp(leg.rotation.z, target, 18, dt);
    });

    // Hunting posture: head down, tail low, eyes lit.
    //
    // **The tail does not wag.** It used to swing side to side whenever the
    // hound was not chasing, which is a dog being pleased to see you — wrong
    // for the animal, and worst exactly when it should read as dangerous. It
    // still *drops* into the hunt, because that is carriage rather than
    // greeting, and it is one of the two tells that a hound has woken.
    const hunting = enemy.chasing;
    this.rig.tail.rotation.z = damp(this.rig.tail.rotation.z, hunting ? 0.35 : 0.95, 6, dt);
    // Lit from the rig's own eye colour, not the accent: the eyes are red on
    // every hellhound, while the accent is whatever this one happens to be.
    this.rig.eyeMaterial.color.copy(hunting ? this.rig.eyeColor : darken(this.rig.eyeColor, 0.55));

    const lunge = this.lungeAt === null ? null : (now - this.lungeAt) / LUNGE_MS;
    const thrust = lunge !== null && lunge < 1 ? Math.sin(Math.PI * lunge) : 0;
    if (lunge !== null && lunge >= 1) this.lungeAt = null;

    this.hurt = Math.max(0, this.hurt - dt * 4);

    this.rig.model.position.x = thrust * 0.3 - this.hurt * 0.12;
    this.rig.model.position.y = (moving ? Math.abs(Math.sin(this.gait)) * 0.05 * amp : 0) - this.hurt * 0.06;
    this.rig.model.rotation.z = thrust * -0.18 + this.hurt * 0.16;
    this.rig.head.rotation.z = damp(this.rig.head.rotation.z, hunting ? -0.18 : 0, 6, dt) - thrust * 0.3;
    // A watchful animal keeps its mouth nearly shut. Once it hunts, the jaw
    // parts into a quiet snarl; the attack lunge drives a much wider snap.
    const jawOpen = -(hunting ? 0.22 : 0.035) - thrust * 0.5;
    this.rig.jaw.rotation.z = damp(this.rig.jaw.rotation.z, jawOpen, 14, dt);
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

/** A body: the same wolf, toppled onto its side and dimmed where it fell. */
class CorpseActor {
  readonly root = new THREE.Group();
  private readonly rig: WolfRig;
  private age = 0;

  constructor(id: string, corpse: GameSnapshot["corpses"][number]) {
    this.rig = buildWolf(darken(parseColor(corpse.color), 0.6));
    this.root.add(this.rig.model);
    this.root.userData["entityId"] = id;
    this.root.position.set(toX(corpse.x), 0, toZ(corpse.y));
    this.root.rotation.y = yawFor(corpse.facing, 0);
    tintObject(this.rig.model, new THREE.Color(0x000000), 0.55);
  }

  update(dt: number): void {
    // Collapse onto its side over the first half second, then stay put forever.
    this.age = Math.min(1, this.age + dt * (1000 / COLLAPSE_MS));
    const t = 1 - Math.pow(1 - this.age, 3);
    this.rig.model.rotation.x = t * (Math.PI / 2);
    this.rig.model.position.y = t * 0.36 * WOLF_SCALE;
    this.rig.model.position.z = t * -0.55 * WOLF_SCALE;
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

// ------------------------------------------------------------------ manager

/** Everything the snapshot owns, kept in step with it. */
export class Actors {
  readonly player: PlayerActor;
  private readonly enemies = new Map<string, WolfActor>();
  private readonly corpses = new Map<string, CorpseActor>();
  private readonly projectiles: THREE.Group[] = [];
  private readonly tombstones = new Map<string, THREE.Group>();

  constructor(
    private readonly scene: THREE.Scene,
    /** Enemy and corpse roots are pushed here so one raycast picks them all. */
    private readonly pickables: THREE.Object3D[],
    playerColor: string,
  ) {
    this.player = new PlayerActor(playerColor);
    scene.add(this.player.root);
  }

  flinch(id: string): void {
    this.enemies.get(id)?.flinch();
  }

  lunge(id: string, now: number): void {
    this.enemies.get(id)?.lunge(now);
  }

  /**
   * `facePointFor` lets a front end say what an enemy should square up to while
   * it stands still. The real-time game passes nothing — its hounds face the way
   * they were last travelling, which is the rule its glyphs always followed. The
   * turn-based one points every woken hound at the player, because there a hound
   * spends most of the game standing on a square looking at you.
   */
  syncEnemies(
    snap: GameSnapshot,
    dt: number,
    now: number,
    elapsed: number,
    facePointFor?: (enemy: GameSnapshot["enemies"][number]) => { x: number; y: number } | null,
  ): void {
    syncKeys(
      this.enemies,
      snap.enemies.map((e) => e.id),
      (id) => {
        const enemy = snap.enemies.find((e) => e.id === id)!;
        const actor = new WolfActor(id, enemy.color);
        this.scene.add(actor.root);
        this.pickables.push(actor.root);
        return actor;
      },
      (actor) => this.remove(actor.root, () => actor.dispose()),
    );

    for (const enemy of snap.enemies) {
      this.enemies.get(enemy.id)?.update(enemy, dt, now, elapsed, facePointFor?.(enemy) ?? null);
    }
  }

  syncCorpses(snap: GameSnapshot, dt: number): void {
    syncKeys(
      this.corpses,
      snap.corpses.map((c) => c.id),
      (id) => {
        const corpse = snap.corpses.find((c) => c.id === id)!;
        const actor = new CorpseActor(id, corpse);
        this.scene.add(actor.root);
        this.pickables.push(actor.root);
        return actor;
      },
      (actor) => this.remove(actor.root, () => actor.dispose()),
    );

    for (const actor of this.corpses.values()) actor.update(dt);
  }

  /** Daggers are interchangeable, so they come from a pool rather than by id. */
  syncProjectiles(snap: GameSnapshot, elapsed: number): void {
    while (this.projectiles.length < snap.projectiles.length) {
      const dagger = buildDagger();
      const root = new THREE.Group();
      root.add(dagger);
      this.scene.add(root);
      this.projectiles.push(root);
    }

    this.projectiles.forEach((root, i) => {
      const projectile = snap.projectiles[i];
      root.visible = projectile !== undefined;
      if (!projectile) return;
      root.position.set(toX(projectile.x), 0.95, toZ(projectile.y));
      root.rotation.y = yawFor(projectile.vx, projectile.vy);
      // Tumbling about Z, which is across the blade — spinning about its own
      // long axis would just look like a drill.
      const blade = root.children[0];
      if (blade) {
        blade.rotation.z = elapsed * 16;
        blade.rotation.x = Math.sin(elapsed * 8) * 0.22;
      }
    });
  }

  syncTombstones(snap: GameSnapshot): void {
    const stones = snap.tombstones ?? [];
    syncKeys(
      this.tombstones,
      stones.map(tombstoneKey),
      (key) => {
        const stone = stones.find((t) => tombstoneKey(t) === key)!;
        const group = buildTombstone();
        group.position.set(toX(stone.x), 0, toZ(stone.y));
        // A slight turn so a row of crosses isn't identical, but only slight:
        // edge-on, a cross reads as a post. Derived from the position so it is
        // stable frame to frame rather than twitching.
        group.rotation.y = (((stone.x * 7919 + stone.y * 104729) % 100) / 100 - 0.5) * 0.5;
        this.scene.add(group);
        return group;
      },
      (group) => this.remove(group, () => disposeObject(group)),
    );
  }

  private remove(root: THREE.Object3D, dispose: () => void): void {
    this.scene.remove(root);
    const index = this.pickables.indexOf(root);
    if (index >= 0) this.pickables.splice(index, 1);
    dispose();
  }
}

/** Tombstones have no id — position plus death time is unique enough. */
function tombstoneKey(stone: { x: number; y: number; gameElapsedMs: number }): string {
  return `${Math.round(stone.x)}|${Math.round(stone.y)}|${Math.round(stone.gameElapsedMs)}`;
}

// -------------------------------------------------------------------- cues

/**
 * Turn the difference between two snapshots into animation, and report whether
 * the player was hit.
 *
 * The protocol carries state, not events, so a swing is "the shared cooldown was
 * recharged", a wound is "that enemy has less health than it did", and a bite is
 * "the player's health dropped". Both 3D front ends read their snapshots this
 * way — which is *why* this lives here rather than in either client's main loop.
 *
 * Feed it **raw** snapshots: the interpolated ones blend `remainingMs` and
 * health, and every step this looks for is smeared away.
 */
export function applyCues<T extends GameSnapshot>(
  actors: Actors,
  previous: T,
  snap: T,
  now: number,
  /**
   * Who struck the player, when the simulation is in a position to say — *all*
   * of them, because a single exchange can land more than one blow. Given an
   * answer it is taken as fact, including when no health changed.
   *
   * Without it the fallback is a *guess*: the nearest thing hunting the player,
   * which is only meaningful if they were actually bitten. That is good enough
   * for the real-time game, where whatever is closest almost certainly did it,
   * and not good enough for a board where two hellhounds flank you and both
   * bite in the same instant — the guess hands the animation to the same one
   * twice while the other tears into you without moving.
   */
  bitersOf?: (previous: T, snap: T) => string[],
): boolean {
  const before = previous.cooldown;
  const after = snap.cooldown;
  if (after && (!before || before.slot !== after.slot || after.remainingMs > before.remainingMs + 1)) {
    actors.player.swing(now);
  }

  const healthBefore = new Map(previous.enemies.map((e) => [e.id, e.health]));
  for (const enemy of snap.enemies) {
    const was = healthBefore.get(enemy.id);
    if (was !== undefined && enemy.health < was) actors.flinch(enemy.id);
  }

  const wounded = snap.stats.health < previous.stats.health;

  const biters = bitersOf ? bitersOf(previous, snap) : wounded ? [nearestHunter(snap)] : [];
  for (const biter of biters) if (biter) actors.lunge(biter, now);

  return wounded;
}

/** The closest enemy that is hunting the player — the fallback biter. */
function nearestHunter(snap: GameSnapshot): string | null {
  let biter: string | null = null;
  let nearest = Infinity;
  for (const enemy of snap.enemies) {
    if (!enemy.chasing) continue;
    const distance = Math.hypot(enemy.x - snap.player.x, enemy.y - snap.player.y);
    if (distance < nearest) {
      nearest = distance;
      biter = enemy.id;
    }
  }
  return biter;
}
