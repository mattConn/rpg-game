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

import { ACTIONS, type AttackKind } from "../../../src/shared/actions.js";
import type { GameSnapshot } from "../../../src/shared/protocol.js";
import {
  buildDagger,
  buildBat,
  buildHuman,
  buildPlayerWolf,
  buildTombstone,
  buildWolf,
  disposeObject,
  WOLF_SCALE,
  tintObject,
  type HumanRig,
  type BatRig,
  type PlayerWolfRig,
  type WolfRig,
} from "./models.js";
import { angleDelta, damp, darken, normalizeAngle, parseColor, toX, toZ, yawFor } from "./world.js";

/** Above this many px/s an actor is "moving" and its gait runs. */
const MOVING_EPSILON = 6;

/** Full-speed references, so a slow walk swings its legs less than a sprint. */
const PLAYER_FULL_SPEED = 160;
const WOLF_FULL_SPEED = 140;
const PLAYER_WOLF_STRIDE_SPEED = 200;

const SWING_MS = 320;
const LUNGE_MS = 300;
const COLLAPSE_MS = 450;
const FALL_MS = 600;
const JUMP_MS = 620;
const JUMP_HEIGHT = 1.4;

/** Quick launch, long fall: peak at 28% of the jump, then gather downward speed. */
function jumpArc(age: number): number {
  if (age >= 1) return 0;
  const t = Math.max(0, age);
  const riseEnd = 0.28;
  return t < riseEnd
    ? Math.sin((t / riseEnd) * Math.PI / 2)
    : Math.cos(((t - riseEnd) / (1 - riseEnd)) * Math.PI / 2);
}

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
  private jumpAt: number | null = null;

  constructor(_color: string) {
    this.rig = buildHuman();
    this.root.add(this.rig.model);
  }

  /** Start the swing animation for the weapon that just fired. */
  swing(now: number, _kind: AttackKind = "melee"): void {
    this.swingAt = now;
  }

  jump(now: number): void {
    if (this.jumpAt !== null) return;
    this.jumpAt = now;
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
    const jumpAge = this.jumpAt === null ? 1 : (now - this.jumpAt) / JUMP_MS;
    const jumpLift = jumpArc(jumpAge) * JUMP_HEIGHT;
    if (jumpAge >= 1) this.jumpAt = null;
    this.root.position.set(toX(x), jumpLift, toZ(y));

    const dx = this.lastX === null ? 0 : x - this.lastX;
    const dy = this.lastY === null ? 0 : y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const speed = dt > 0 ? Math.hypot(dx, dy) / dt : 0;
    const moving = speed > MOVING_EPSILON && !snap.dead;
    const playerHeading = (snap as GameSnapshot & { playerHeading?: { x: number; y: number } }).playerHeading;
    let wanted = this.yaw;
    // Tactics supplies an explicit rotation-driven heading. It takes priority
    // even while moving so backing up does not spin the model toward its travel
    // direction. Real-time snapshots omit it and retain turn-to-movement.
    if (playerHeading) wanted = yawFor(playerHeading.x, playerHeading.y);
    else if (moving) wanted = yawFor(dx, dy);
    else if (facePoint) wanted = yawFor(facePoint.x - x, facePoint.y - y);
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

class PlayerWolfActor {
  readonly root = new THREE.Group();
  private readonly rig: PlayerWolfRig;
  private yaw = 0;
  private gait = 0;
  private lastX: number | null = null;
  private lastY: number | null = null;
  private attackAt: number | null = null;
  private attackKind: AttackKind = "melee";
  private fall = 0;
  private jumpAt: number | null = null;

  constructor() {
    this.rig = buildPlayerWolf();
    this.root.add(this.rig.model);
  }

  swing(now: number, kind: AttackKind = "melee"): void {
    this.attackAt = now;
    this.attackKind = kind;
    if (kind === "melee" && this.rig.attackAction) {
      this.rig.attackAction.reset();
      this.rig.attackAction.setLoop(THREE.LoopOnce, 1);
      this.rig.attackAction.clampWhenFinished = false;
      this.rig.attackAction.timeScale = 2.5;
      this.rig.attackAction.play();
    }
  }

  jump(now: number): void {
    if (this.jumpAt !== null) return;
    this.jumpAt = now;
  }

  setWeapon(kind: AttackKind): void {
    this.rig.sword.visible = false;
    this.rig.dagger.visible = kind === "ranged";
  }

  update(snap: GameSnapshot, _facePoint: { x: number; y: number } | null, dt: number, now: number, elapsed: number): void {
    const { x, y } = snap.player;
    const jumpAge = this.jumpAt === null ? 1 : (now - this.jumpAt) / JUMP_MS;
    const jumpTuck = jumpArc(jumpAge);
    const jumpLift = jumpTuck * JUMP_HEIGHT;
    if (jumpAge >= 1) this.jumpAt = null;
    this.root.position.set(toX(x), jumpLift, toZ(y));
    const dx = this.lastX === null ? 0 : x - this.lastX;
    const dy = this.lastY === null ? 0 : y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const speed = dt > 0 ? Math.hypot(dx, dy) / dt : 0;
    const moving = speed > MOVING_EPSILON && !snap.dead;
    const playerStateFlags = snap as GameSnapshot & { playerRunning?: boolean; playerEating?: boolean };
    const sprinting = playerStateFlags.playerRunning === true;
    const eating = playerStateFlags.playerEating === true;
    this.rig.mixer?.update(dt);
    const importedMeleeAttack = this.rig.attackAction?.isRunning() ?? false;
    if (eating) {
      this.rig.idleAction?.stop();
      this.rig.runAction?.stop();
      this.rig.sprintAction?.stop();
      this.rig.attackAction?.stop();
      const eatAction = this.rig.eatAction;
      if (eatAction && !eatAction.isRunning()) {
        eatAction.reset();
        eatAction.setLoop(THREE.LoopOnce, 1);
        eatAction.clampWhenFinished = false;
        eatAction.timeScale = 1;
        eatAction.play();
      }
    } else if (importedMeleeAttack) {
      this.rig.eatAction?.stop();
      this.rig.idleAction?.stop();
      this.rig.runAction?.stop();
      this.rig.sprintAction?.stop();
    } else if (moving) {
      this.rig.eatAction?.stop();
      this.rig.idleAction?.stop();
      const movementAction = sprinting ? (this.rig.sprintAction ?? this.rig.runAction) : this.rig.runAction;
      const inactiveAction = sprinting ? this.rig.runAction : this.rig.sprintAction;
      inactiveAction?.stop();
      if (movementAction && !movementAction.isRunning()) movementAction.reset().play();
      if (movementAction) movementAction.timeScale = Math.max(0.65, speed / PLAYER_WOLF_STRIDE_SPEED);
    } else {
      this.rig.eatAction?.stop();
      this.rig.runAction?.stop();
      this.rig.sprintAction?.stop();
      if (this.rig.idleAction && !this.rig.idleAction.isRunning()) this.rig.idleAction.reset().play();
    }
    const playerState = snap as GameSnapshot & {
      playerHeading?: { x: number; y: number };
    };
    const heading = playerState.playerHeading;
    const wanted = heading ? yawFor(heading.x, heading.y) : moving ? yawFor(dx, dy) : yawFor(snap.player.facing, 0);
    this.yaw += angleDelta(this.yaw, wanted) * (1 - Math.exp(-12 * dt));

    const attack = this.attackAt === null ? null : (now - this.attackAt) / SWING_MS;
    const activeAttack = attack !== null && attack < 1;
    const easedAttack = activeAttack ? ease(Math.max(0, attack)) : 0;
    // Melee uses the imported close-left attack. The procedural sweep remains
    // only for the thrown dagger.
    const spin = activeAttack && this.attackKind === "ranged"
      ? Math.PI / 4 - easedAttack * Math.PI / 2
      : 0;
    this.root.rotation.y = this.yaw + spin;

    const amp = Math.min(1, speed / WOLF_FULL_SPEED);
    const gaitSpeed = Math.min(2, speed / PLAYER_WOLF_STRIDE_SPEED);
    if (moving) this.gait += dt * (5 + gaitSpeed * 11);
    const airborne = jumpAge < 1;
    animateWolfLegs(this.rig, moving && !airborne, this.gait, amp, dt);
    kickWolfLegsForJump(this.rig, jumpTuck);

    const daggerLunge = activeAttack && this.attackKind === "ranged" ? Math.sin(easedAttack * Math.PI) * 0.42 : 0;
    this.fall = damp(this.fall, snap.dead ? 1 : 0, 1000 / FALL_MS, dt);
    this.rig.model.rotation.z = -this.fall * (Math.PI / 2);
    this.rig.model.position.x = daggerLunge;
    this.rig.model.position.y = this.fall * 0.3
      + (moving ? 0 : Math.sin(elapsed * 1.8) * 0.012);
    if (!activeAttack) this.attackAt = null;
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

/**
 * A loose bound: rear legs follow the front pair by half a cycle, while the
 * right side lands a fraction later than the left so the gait is not robotic.
 */
const LEG_PHASE = [0, 1.4, Math.PI + 0.18, Math.PI + 1.58];
// This skeleton's leg chains are exported in a rotated parent space. Its local
// X hinge produces the visible fore/aft stride along the body.
const LEG_SWING_AXIS = new THREE.Vector3(1, 0, 0);
const LEG_SWING_QUATERNION = new THREE.Quaternion();
const SPINE_FLEX_AXIS = new THREE.Vector3(0, 0, 1);
const SPINE_FLEX_QUATERNION = new THREE.Quaternion();
const TAIL_BEND_AXIS = new THREE.Vector3(1, 0, 0);
const ATTACK_BEND_QUATERNION = new THREE.Quaternion();
// The imported wing bones run along local Z, so rotating around Z only twists
// the membrane without moving its silhouette. Local X lifts the full span.

/** Animate fallback geometry; the imported skeleton uses its `run fwd` clip. */
function animateWolfLegs(rig: WolfRig, moving: boolean, gait: number, amp: number, dt: number): void {
  rig.legs.forEach((leg, i) => {
    const target = moving ? Math.sin(gait + LEG_PHASE[i]!) * 0.45 * amp : 0;
    leg.rotation.z = damp(leg.rotation.z, target, 18, dt);
  });
}

/** Extend all four paws away from the body at the apex of the jump. */
function kickWolfLegsForJump(rig: WolfRig, amount: number): void {
  rig.legs.forEach((leg, i) => {
    const direction = i < 2 ? -1 : 1;
    leg.rotation.z += direction * amount * 0.9;
  });
  rig.importedLegs.forEach((leg, i) => {
    const upperDirection = i < 2 ? -1 : 1;
    const upper = upperDirection * amount * 0.9;
    LEG_SWING_QUATERNION.setFromAxisAngle(LEG_SWING_AXIS, upper);
    leg.bone.quaternion.multiply(LEG_SWING_QUATERNION);
    if (leg.lowerBone) {
      const lowerDirection = i < 2 ? 1 : -1;
      const lower = lowerDirection * amount * 0.28;
      LEG_SWING_QUATERNION.setFromAxisAngle(LEG_SWING_AXIS, lower);
      leg.lowerBone.quaternion.multiply(LEG_SWING_QUATERNION);
    }
  });
}
/** Enemy wolves stand just above the player without overwhelming the board. */
const HELLHOUND_SCALE = 1.95;
const HITBOX_MATERIAL = new THREE.LineBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.9 });

function hitboxOutline(radiusX: number, radiusZ: number): THREE.LineLoop {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 48; i++) {
    const angle = (i / 48) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radiusX, 0, Math.sin(angle) * radiusZ));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  return new THREE.LineLoop(geometry, HITBOX_MATERIAL);
}

interface BloodBurst {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  flash: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  velocities: THREE.Vector3[];
  age: number;
}

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
  private readonly hitbox: THREE.LineLoop;

  constructor(id: string, color: string) {
    this.accent = parseColor(color);
    this.rig = buildWolf(this.accent);
    this.root.add(this.rig.model);
    this.root.scale.setScalar(HELLHOUND_SCALE);
    this.hitbox = hitboxOutline(0.9, 0.62);
    this.hitbox.position.y = 0.04;
    this.hitbox.visible = false;
    this.root.add(this.hitbox);
    this.root.userData["entityId"] = id;
  }

  flinch(): void {
    this.hurt = 1;
  }

  lunge(now: number): void {
    this.lungeAt = now;
    const attackAction = this.rig.attackAction;
    if (attackAction) {
      attackAction.reset();
      attackAction.setLoop(THREE.LoopOnce, 1);
      attackAction.clampWhenFinished = false;
      // The source clip is about 1.56 seconds. Compressing it into the 300ms
      // damage window made the bite unreadably fast; play it near native speed.
      attackAction.timeScale = 1.25;
      attackAction.play();
    }
  }

  setHitboxVisible(visible: boolean): void { this.hitbox.visible = visible; }

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
    const aggroed = enemy.chasing;
    const attackProgress = this.lungeAt === null ? null : (now - this.lungeAt) / LUNGE_MS;
    const attacking = this.rig.attackAction?.isRunning()
      ?? (attackProgress !== null && attackProgress < 1);
    this.rig.mixer?.update(dt);
    if (attacking) {
      this.rig.idleAction?.stop();
      this.rig.runAction?.stop();
      this.rig.aggressiveAction?.stop();
    } else if (moving) {
      this.rig.idleAction?.stop();
      const movementAction = aggroed ? (this.rig.aggressiveAction ?? this.rig.runAction) : this.rig.runAction;
      const inactiveAction = aggroed ? this.rig.runAction : this.rig.aggressiveAction;
      inactiveAction?.stop();
      if (movementAction && !movementAction.isRunning()) movementAction.reset().play();
      if (movementAction) movementAction.timeScale = Math.max(0.65, speed / WOLF_FULL_SPEED);
    } else {
      this.rig.runAction?.stop();
      this.rig.aggressiveAction?.stop();
      if (this.rig.idleAction && !this.rig.idleAction.isRunning()) this.rig.idleAction.reset().play();
    }

    const quarryX = facePoint ? facePoint.x - enemy.x : 0;
    const quarryY = facePoint ? facePoint.y - enemy.y : 0;
    const backing = moving && facePoint !== null && dx * quarryX + dy * quarryY < 0;

    // Travel normally wins over the quarry. The exception is a pursuing hound
    // yielding ground to an advancing player: it keeps its teeth toward the
    // threat and backpedals instead of spinning around to flee.
    const wanted = enemy.heading
      ? yawFor(enemy.heading.x, enemy.heading.y)
      : moving && !backing
        ? yawFor(dx, dy)
        : facePoint
          ? yawFor(quarryX, quarryY)
          : yawFor(enemy.facing, 0);
    // The server already rate-limits hound turning. Follow that authoritative
    // heading closely so the visible snout and the damaging cone stay aligned.
    this.yaw += angleDelta(this.yaw, wanted) * (1 - Math.exp(-25 * dt));
    this.root.rotation.y = this.yaw;

    const amp = Math.min(1, speed / WOLF_FULL_SPEED);
    if (moving) this.gait += dt * (5 + amp * 11) * (backing ? -1 : 1);
    animateWolfLegs(this.rig, moving, this.gait, amp, dt);

    // Hunting posture: head down, tail low, eyes lit.
    //
    // **The tail does not wag.** It used to swing side to side whenever the
    // hound was not chasing, which is a dog being pleased to see you — wrong
    // for the animal, and worst exactly when it should read as dangerous. It
    // still *drops* into the hunt, because that is carriage rather than
    // greeting, and it is one of the two tells that a hound has woken.
    const hunting = aggroed;
    this.rig.tail.rotation.z = damp(this.rig.tail.rotation.z, hunting ? 0.35 : 0.95, 6, dt);
    // Lit from the rig's own eye colour, not the accent: the eyes are red on
    // every hellhound, while the accent is whatever this one happens to be.
    this.rig.eyeMaterial.color.copy(hunting ? this.rig.eyeColor : darken(this.rig.eyeColor, 0.55));

    if (attackProgress !== null && attackProgress >= 1) this.lungeAt = null;

    this.hurt = Math.max(0, this.hurt - dt * 4);

    this.rig.model.position.x = -this.hurt * 0.12;
    this.rig.model.position.y = -this.hurt * 0.06;
    this.rig.model.rotation.z = this.hurt * 0.16;
    this.rig.head.rotation.z = damp(this.rig.head.rotation.z, hunting ? -0.18 : 0, 6, dt);
    // A watchful animal keeps its mouth nearly shut. Once it hunts, the jaw
    // parts into a quiet snarl; the attack lunge drives a much wider snap.
    const jawOpen = -(hunting ? 0.22 : 0.035);
    this.rig.jaw.rotation.z = damp(this.rig.jaw.rotation.z, jawOpen, 14, dt);
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

class BatActor {
  readonly root = new THREE.Group();
  private readonly rig: BatRig;
  private yaw = 0;
  private hurt = 0;
  private lungeAt: number | null = null;
  private lastAltitude: number | null = null;
  private readonly hitbox: THREE.LineLoop;

  constructor(id: string) {
    this.rig = buildBat();
    this.root.add(this.rig.model);
    this.hitbox = hitboxOutline(5.25, 4.5);
    this.hitbox.position.y = 0;
    this.hitbox.visible = false;
    this.root.add(this.hitbox);
    this.root.userData["entityId"] = id;
  }

  flinch(): void { this.hurt = 1; }
  lunge(now: number): void { this.lungeAt = now; }
  setHitboxVisible(visible: boolean): void { this.hitbox.visible = visible; }

  update(
    enemy: GameSnapshot["enemies"][number],
    dt: number,
    now: number,
    elapsed: number,
    _facePoint: { x: number; y: number } | null = null,
  ): void {
    this.rig.mixer?.update(dt);
    const heading = enemy.heading ?? { x: enemy.facing, y: 0 };
    const wanted = yawFor(heading.x, heading.y);
    this.yaw += angleDelta(this.yaw, wanted) * (1 - Math.exp(-8 * dt));
    this.root.rotation.y = this.yaw;
    const altitude = enemy.altitude ?? 4.2;
    const descending = this.lastAltitude !== null && altitude < this.lastAltitude - 0.001;
    this.lastAltitude = altitude;
    this.root.position.set(toX(enemy.x), altitude, toZ(enemy.y));
    this.rig.model.position.y = Math.sin(elapsed * 7) * 0.09;
    this.hurt = Math.max(0, this.hurt - dt * 5);
    this.rig.model.position.x = -this.hurt * 0.12;
    this.rig.model.rotation.z = this.hurt * 0.18;
    const lunge = this.lungeAt === null ? 1 : (now - this.lungeAt) / LUNGE_MS;
    const swoopTilt = descending ? -0.55 : 0;
    this.rig.model.rotation.x = damp(this.rig.model.rotation.x, swoopTilt
      + (lunge < 1 ? Math.sin(lunge * Math.PI) * -0.32 : 0), 14, dt);
    if (lunge >= 1) this.lungeAt = null;
  }

  dispose(): void { disposeObject(this.root); }
}

/** A body: the same wolf, toppled onto its side and dimmed where it fell. */
class CorpseActor {
  readonly root = new THREE.Group();
  private readonly rig: WolfRig;
  private age = 0;

  constructor(id: string, corpse: GameSnapshot["corpses"][number]) {
    this.rig = buildWolf(darken(parseColor(corpse.color), 0.6));
    this.root.add(this.rig.model);
    this.root.scale.setScalar(HELLHOUND_SCALE);
    this.root.userData["entityId"] = id;
    this.root.position.set(toX(corpse.x), 0, toZ(corpse.y));
    this.root.rotation.y = yawFor(corpse.facing, 0);
    tintObject(this.rig.model, new THREE.Color(0x000000), 0.55);
  }

  update(dt: number): void {
    // A lightweight skeletal ragdoll: the torso topples first, then the loose
    // joints oscillate with rapidly decaying energy until the body settles.
    this.age += dt;
    const fall = Math.min(1, this.age / (COLLAPSE_MS / 1000));
    const t = 1 - Math.pow(1 - fall, 3);
    const energy = Math.exp(-this.age * 3.6);
    const impact = Math.sin(this.age * 18) * energy;
    this.rig.model.rotation.x = t * (Math.PI / 2) + impact * 0.1;
    this.rig.model.rotation.y = Math.sin(this.age * 11 + 0.8) * 0.2 * energy;
    this.rig.model.rotation.z = impact * 0.28;
    this.rig.model.position.z = t * -0.55 * WOLF_SCALE;

    const spineCount = Math.max(1, this.rig.importedSpine.length - 1);
    this.rig.importedSpine.forEach((joint, i) => {
      // Each vertebra keeps a little more bend than the one before it, so the
      // dead torso finishes as a loose curve instead of snapping straight.
      const settledSlump = 0.08 + (i / spineCount) * 0.16;
      const flex = settledSlump + Math.sin(this.age * 14 + i * 1.05) * 0.52 * energy;
      SPINE_FLEX_QUATERNION.setFromAxisAngle(SPINE_FLEX_AXIS, flex);
      joint.bone.quaternion.copy(joint.bindQuaternion).multiply(SPINE_FLEX_QUATERNION);
    });

    if (this.rig.importedHead) {
      const headFlop = 0.32 + Math.sin(this.age * 14 + 0.7) * 0.62 * energy;
      ATTACK_BEND_QUATERNION.setFromAxisAngle(TAIL_BEND_AXIS, headFlop);
      this.rig.importedHead.bone.quaternion
        .copy(this.rig.importedHead.bindQuaternion)
        .multiply(ATTACK_BEND_QUATERNION);
    }
    if (this.rig.importedTail) {
      ATTACK_BEND_QUATERNION.setFromAxisAngle(TAIL_BEND_AXIS, -0.42 + Math.sin(this.age * 17) * 0.48 * energy);
      this.rig.importedTail.bone.quaternion
        .copy(this.rig.importedTail.bindQuaternion)
        .multiply(ATTACK_BEND_QUATERNION);
    }

    // The bright combat-eye overlays do not belong on a dead animal. They are
    // separate meshes parented to the animated head bone, and during a hard
    // skeletal collapse they can otherwise appear detached from the real,
    // closed eyes in the imported skin.
    this.rig.model.getObjectsByProperty("name", "importedWolfEye")
      .forEach((eye) => { eye.visible = false; });

    // Keep the lowest rendered point on the dungeon floor throughout the
    // collapse. The old fixed lift raised a scaled corpse almost a full world
    // unit and left it visibly hovering once the ragdoll settled.
    this.rig.model.position.y = 0;
    this.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().makeEmpty();
    this.rig.model.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      if (object instanceof THREE.SkinnedMesh) {
        // Box3.setFromObject uses the undeformed geometry bounds for a skinned
        // mesh. Compute against the current bone pose so a wolf lying on its
        // side is grounded by the corpse, not by its former standing pose.
        object.skeleton.update();
        object.computeBoundingBox();
        if (object.boundingBox) bounds.union(object.boundingBox.clone().applyMatrix4(object.matrixWorld));
        return;
      }
      object.geometry.computeBoundingBox();
      if (object.geometry.boundingBox) {
        bounds.union(object.geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      }
    });
    if (Number.isFinite(bounds.min.y)) {
      const worldFloor = this.root.position.y + 0.015;
      this.rig.model.position.y = (worldFloor - bounds.min.y) / this.root.scale.y;
    }
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

/** A slain flying enemy rolls belly-up, drops, and remains where it lands. */
class BatCorpseActor {
  readonly root = new THREE.Group();
  private readonly rig: BatRig;
  private age = 0;
  private readonly startAltitude: number;

  constructor(id: string, corpse: GameSnapshot["corpses"][number]) {
    this.rig = buildBat();
    this.root.add(this.rig.model);
    this.root.userData["entityId"] = id;
    this.startAltitude = corpse.altitude ?? 2.25;
    this.root.position.set(toX(corpse.x), this.startAltitude, toZ(corpse.y));
    this.root.rotation.y = yawFor(corpse.facing, 0);
    tintObject(this.rig.model, new THREE.Color(0x000000), 0.28);
  }

  update(dt: number): void {
    this.age += dt;
    // A corpse must not continue playing the looping flight clip. This check
    // runs every frame because the imported rig may finish loading after death.
    this.rig.flightAction?.stop();
    this.rig.mixer?.stopAllAction();
    const fall = Math.min(1, this.age / 0.82);
    const eased = fall * fall * (3 - 2 * fall);
    const loose = Math.exp(-this.age * 3.2);
    for (const joint of this.rig.wingJoints) {
      const segment = joint.order / 5;
      const droop = joint.side * (0.32 + segment * 0.22);
      const flop = joint.side * Math.sin(this.age * (11 + joint.order) + joint.order * 0.7)
        * (0.55 - segment * 0.16) * loose;
      const ragdoll = new THREE.Quaternion().setFromEuler(new THREE.Euler(
        0.12 + segment * 0.08,
        0,
        droop + flop,
      ));
      joint.bone.quaternion.copy(joint.bindQuaternion).multiply(ragdoll);
    }
    this.rig.model.rotation.x = eased * Math.PI;
    this.rig.model.rotation.z = Math.sin(fall * Math.PI) * 0.24;
    this.root.position.y = this.startAltitude * (1 - eased);
    if (fall < 1) return;

    // The imported bat is centred around its body rather than grounded at its
    // feet. Once it lands, lift only enough for the flipped mesh to meet y=0.
    this.rig.model.position.y = 0;
    this.root.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.rig.model);
    if (Number.isFinite(bounds.min.y)) this.rig.model.position.y = 0.025 - bounds.min.y;
  }

  dispose(): void { disposeObject(this.root); }
}

// ------------------------------------------------------------------ manager

/** Everything the snapshot owns, kept in step with it. */
export class Actors {
  readonly player: PlayerActor | PlayerWolfActor;
  private readonly enemies = new Map<string, WolfActor | BatActor>();
  private readonly corpses = new Map<string, CorpseActor | BatCorpseActor>();
  private readonly projectiles: THREE.Group[] = [];
  private readonly tombstones = new Map<string, THREE.Group>();
  private readonly bloodBursts: BloodBurst[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    /** Enemy and corpse roots are pushed here so one raycast picks them all. */
    private readonly pickables: THREE.Object3D[],
    playerColor: string,
    wolfPlayer = false,
  ) {
    this.player = wolfPlayer ? new PlayerWolfActor() : new PlayerActor(playerColor);
    scene.add(this.player.root);
  }

  flinch(id: string): void {
    this.enemies.get(id)?.flinch();
  }

  lunge(id: string, now: number): void {
    this.enemies.get(id)?.lunge(now);
  }

  bloodOnEnemy(id: string): void {
    const enemy = this.enemies.get(id);
    if (!enemy) return;
    this.spawnBlood(enemy.root, this.player.root, true);
  }

  bloodOnPlayer(attackerId: string | null): void {
    this.spawnBlood(this.player.root, attackerId ? this.enemies.get(attackerId)?.root : undefined);
  }

  private spawnBlood(target: THREE.Object3D, source?: THREE.Object3D, showImpactFlash = false): void {
    const targetWorld = target.getWorldPosition(new THREE.Vector3());
    const sourceWorld = source?.getWorldPosition(new THREE.Vector3());
    const towardSource = sourceWorld
      ? sourceWorld.sub(targetWorld).setY(0).normalize()
      : new THREE.Vector3(1, 0, 0);
    const isBat = target.position.y > 1.5;
    const origin = targetWorld.clone()
      .addScaledVector(towardSource, isBat ? 0.5 : 0.38)
      .add(new THREE.Vector3(0, isBat ? 0.05 : 0.82, 0));
    const positions = new Float32Array(14 * 3);
    const velocities: THREE.Vector3[] = [];
    for (let i = 0; i < 14; i++) {
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      velocities.push(towardSource.clone().multiplyScalar(0.7 + Math.random() * 1.1).add(new THREE.Vector3(
        (Math.random() - 0.5) * 1.2,
        0.45 + Math.random() * 1.25,
        (Math.random() - 0.5) * 1.2,
      )));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0x490006,
      size: 0.13,
      transparent: true,
      opacity: 1,
      depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geometry, material);
    this.scene.add(points);
    let flash: BloodBurst["flash"] = null;
    if (showImpactFlash) {
      flash = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0xb20b13,
          transparent: true,
          opacity: 0.3,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      flash.position.copy(origin);
      this.scene.add(flash);
    }
    this.bloodBursts.push({ points, flash, velocities, age: 0 });
  }

  private updateBlood(dt: number): void {
    for (let i = this.bloodBursts.length - 1; i >= 0; i--) {
      const burst = this.bloodBursts[i]!;
      burst.age += dt;
      const positions = burst.points.geometry.getAttribute("position") as THREE.BufferAttribute;
      for (let p = 0; p < burst.velocities.length; p++) {
        const velocity = burst.velocities[p]!;
        velocity.y -= 4.5 * dt;
        positions.setXYZ(
          p,
          positions.getX(p) + velocity.x * dt,
          positions.getY(p) + velocity.y * dt,
          positions.getZ(p) + velocity.z * dt,
        );
      }
      positions.needsUpdate = true;
      burst.points.material.opacity = Math.max(0, 1 - burst.age / 0.56);
      if (burst.flash) {
        const flashT = Math.min(1, burst.age / 0.3);
        const flashScale = 1 + flashT * 6.5;
        burst.flash.scale.setScalar(flashScale);
        burst.flash.material.opacity = 0.3 * (1 - flashT);
      }
      if (burst.age < 0.56) continue;
      this.scene.remove(burst.points);
      burst.points.geometry.dispose();
      burst.points.material.dispose();
      if (burst.flash) {
        this.scene.remove(burst.flash);
        burst.flash.geometry.dispose();
        burst.flash.material.dispose();
      }
      this.bloodBursts.splice(i, 1);
    }
  }

  setHitboxesVisible(visible: boolean): void {
    for (const enemy of this.enemies.values()) enemy.setHitboxVisible(visible);
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
    this.updateBlood(dt);
    syncKeys(
      this.enemies,
      snap.enemies.map((e) => e.id),
      (id) => {
        const enemy = snap.enemies.find((e) => e.id === id)!;
        const actor = enemy.kind === "bat" ? new BatActor(id) : new WolfActor(id, enemy.color);
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
        const actor = corpse.kind === "bat" ? new BatCorpseActor(id, corpse) : new CorpseActor(id, corpse);
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
    const kind = ACTIONS[after.slot]?.kind;
    actors.player.swing(now, kind === "ranged" ? "ranged" : "melee");
  }

  const healthBefore = new Map(previous.enemies.map((e) => [e.id, e.health]));
  for (const enemy of snap.enemies) {
    const was = healthBefore.get(enemy.id);
    if (was !== undefined && enemy.health < was) {
      actors.flinch(enemy.id);
      actors.bloodOnEnemy(enemy.id);
    }
  }
  // A lethal blow removes an enemy before this snapshot is emitted. Its actor
  // still exists until the render loop syncs the new state, so burst at that
  // last confirmed contact point too.
  const livingIds = new Set(snap.enemies.map((enemy) => enemy.id));
  for (const enemy of previous.enemies) {
    if (!livingIds.has(enemy.id)) actors.bloodOnEnemy(enemy.id);
  }

  const wounded = snap.stats.health < previous.stats.health;

  const biters = bitersOf ? bitersOf(previous, snap) : wounded ? [nearestHunter(snap)] : [];
  for (const biter of biters) {
    if (!biter) continue;
    actors.lunge(biter, now);
    actors.bloodOnPlayer(biter);
  }
  if (wounded && biters.length === 0) actors.bloodOnPlayer(null);

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
