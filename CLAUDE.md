# CLAUDE.md

Guidance for working in this repo.

> **Active project: `rpg-tactics/`** (port 3300). This is the main game — a
> first-person turn-based dungeon. All new work goes here unless stated
> otherwise. `cd rpg-tactics && npm install && npm start`.

## What this is

A single-player browser RPG in a dungeon, with **three front ends and two sets
of rules**. Every one of them is a thin renderer over a simulation that runs on
the server and is broadcast as a `GameSnapshot` at 20 Hz; a client sends input
and draws what comes back, and decides nothing.

| | port | renderer | rules |
|---|---|---|---|
| root (`src/`) | 3000 | 2D glyphs on a `<canvas>` | real-time |
| `rpg-3d/` | 3200 | low-poly WebGL | real-time (the *same* `GameSimulation`) |
| **`rpg-tactics/`** ★ | 3300 | first-person WebGL | **turn-based**, on a 3x3 board |

- The **real-time** game is the original: roam a 3x3 dungeon of rooms, and fight
  one hellhound at a time by engaging it and closing the distance yourself. The
  2D and 3D clients import one `GameSimulation`, so they cannot disagree.
- The **turn-based** game is a 3x3 board with two hellhounds on it, a corridor
  out of one corner and a second, identical room at the end of that. You act,
  they act, and you win by killing them — the door used to be a second way to
  win and is now only a way to leave the room, with the pack following you
  through it. Its rules are genuinely different, so it has its own simulation — but
  it reuses everything downstream of the snapshot, because `TacticsSnapshot`
  *extends* `GameSnapshot`. See [the turn-based section](#the-turn-based-front-end-rpg-tactics).

**Nothing about the rules or the UI is implemented twice.** Models, animation
rigs, snapshot playback, the HUD, the action bar and the inspect menu are
imported across project boundaries, never copied. A change to any of them lands
everywhere by construction — which is the single most important thing to know
before editing anything in here.

Historically this was forked from a sibling `multiplayer-rpg` project by
stripping the networking layer (Hocuspocus / Yjs / awareness), then given a
server simulation and a websocket again — hence `fastify` + `@fastify/static` +
`ws`, and `three` in the two 3D projects.

## Run / build

**The active game is `rpg-tactics/`** — run everything from that directory:

```bash
cd rpg-tactics
npm install
npm start              # bundles the client, then serves at http://localhost:3300
npm run dev            # same, but restarts the server on file change (tsx watch)
npm run watch:client   # rebuild the client bundle on change
npx tsc --noEmit       # typecheck
npm run build:client   # rebuild client bundle only
```

The client entry `rpg-tactics/src/client/main.ts` is bundled by esbuild to
`rpg-tactics/public/tactics.js` (IIFE). The bundle is gitignored —
`npm start`/`build:client` regenerates it.

`rpg-tactics` imports shared code from the root `src/` and models from
`rpg-3d/`, so after changing anything in those directories, typecheck and
rebuild **in all three projects**:

```bash
# from the repo root
npm run typecheck                                   # root src/
cd rpg-3d      && npx tsc --noEmit && npm run build:client
cd rpg-tactics && npx tsc --noEmit && npm run build:client
```

The two older front ends still work if needed:

```bash
npm install && npm start                             # 2D glyphs,    http://localhost:3000
cd rpg-3d      && npm install && npm start           # real-time 3D, http://localhost:3200
```

Each server listens on its own port, so nothing collides.

One thing to know before testing by hand: a server holds **one** simulation
shared by every client connected to it. Two browser tabs are two views of the
same game, and driving one headlessly will move the player in the other. Point
automated checks at a second port (`PORT=3301 npm start`) rather than at a
session someone is playing.

## Architecture

TypeScript throughout, ES modules, strict + `noUncheckedIndexedAccess`.

This section describes the **root project**; `rpg-3d/` and `rpg-tactics/` have
their own sections at the bottom of this file. Both import heavily from here, so
treat everything in `src/shared/` and `src/client/` as having three callers, not
one.

- `src/shared/` — pure, browser-agnostic logic (no DOM). Runnable under
  `tsx`/node, which is how it's tested. Also the boundary every front end talks
  across: `protocol.ts` (`GameSnapshot` / `InputMessage`), `actions.ts` (the
  action-bar slots), `combat.ts` (dagger flight, damage-number timing) and
  `loot.ts` (corpses, and the inspect menu's geometry) are all read by all
  three.
  - `constants.ts` — world/room size, dungeon layout, speeds, and the
    `PlayerState`/`RoomCoord`/`Direction` types. **Single source of truth for
    dimensions.**
  - `movement.ts` — pure room-boundary math: `exitAtPoint`, `doorwayTarget`,
    `crossEdges`, plus `MIN_X/MAX_X/MIN_Y/MAX_Y` and `clamp`.
- `src/client/` — everything that touches the canvas.
  - `main.ts` — the game loop, input handling, and all mutable state. Wires the
    other modules together. This is the only stateful module.
  - `viewport.ts` — `fitToViewport`: largest 4:3 canvas for the window.
  - `tilemap.ts` — the glyph grid, walls, and **collision**.
  - `minimap.ts`, `hud.ts`, `actionbar.ts` — the three draggable overlays.
  - `panel.ts` — shared chrome for those overlays (gold drag handle, backing,
    clamping). Reused by all three so they stay identical.
  - `enemies.ts` — enemy entities: targeting hit-tests and rendering (rings,
    hover name).
  - `combat.ts` — thrown-dagger projectiles and the rotatable `†` glyph shared
    with the action bar.
  - `cursors.ts` — the directional exit-arrow cursors (inline SVG data URIs).
- `src/server/` — where the real-time game actually runs.
  - `game.ts` — `GameSimulation`: all mutable state, the tick, and every rule.
    **Imported by `rpg-3d/`'s server too**, so the two real-time front ends
    cannot drift apart. The turn-based game does *not* use it — different rules
    — but copies nothing from it either.
  - `index.ts` — Fastify static server plus the websocket that broadcasts a
    snapshot every 50ms. Both other projects have a near-identical file.

## Core concepts

Everything from here down to the two front-end sections describes the
**real-time** game — the rooms, the roaming, the chase, the cooldown. The turn-based game shares the
coordinate system, the tile size, the glyph/facing conventions and the whole UI,
and shares none of the rest: it has no rooms, no pathing, no cooldown and no
chase. Where it deliberately breaks with something written below, its own
section says so.

### Coordinate system

Game logic works in fixed **room units**: `WORLD_WIDTH=1200 × WORLD_HEIGHT=900`
(4:3). The canvas is scaled to the largest 4:3 rectangle that fits the window
via a context transform set in `resizeCanvas()`; drawing code always uses room
units, so a bigger window renders sharper, not stretched. `toWorld(event)` in
`main.ts` converts mouse coordinates back to room units using the element's
measured size (so it's correct at any window size / DPI). **Never bake pixel
sizes that assume 800×600 or the window size — use the constants.**

### Rooms / dungeon

A 3×3 grid of rooms (`DUNGEON_COLS/ROWS`), each one screen. The player always
spawns in the center room (`START_ROOM = {1,1}`) at the middle of the vault.
Movement is pixel-based within a room; walking past an *open* edge steps into the
neighbor room entering from its far side (`crossEdges`), a *closed* edge (dungeon
border) is a wall. `neighborRoom` decides which edges are open. Only one room is
rendered/simulated at a time.

### Movement + collision

Pixel-based, `PLAYER_SPEED` px/s. WASD (diagonals normalized) or click-to-move
(`moveTarget`). `applyMovement` computes a target position, then
`resolveMove` (in `tilemap.ts`) slides the player's box against solid wall cells
one axis at a time (so you slide along walls), then `crossEdges` handles room
transitions. Collision is **per-cell** and **swept** (checks every cell the
leading edge crosses, so a fast/laggy step can't tunnel a wall). Only tiles
marked `solid` block; rendering is decoupled from collision.

### Tile grid

A `CELL_SIZE=30` px grid (40×30 cells) overlaid on each room, purely for
rendering + collision — it does not constrain movement. Cells are **sparse**
(only placed cells exist), so an empty room draws nothing. `Dungeon` holds one
`TileLayer` per room. Walls are placed with `fillWalls` (auto-tiled **heavy**
box-drawing glyphs `┏━┓┃┗┛` via `boxGlyphHeavy`, marked solid). `boxGlyph` (light
set) and `stampWalls` exist for decorative, non-solid glyph walls. Projectiles
test walls with `segmentHitsWall` / `isSolidAtPixel`.

The starting vault is a solid box in the center room with a 2-cell doorway on its
south side (`rectBorder(16,11,23,18, [[19,18],[20,18]])`).

### Realtime

The world always runs. `tick(realNow)` derives `dt` from wall time and every
timestamp — melee/fire cadence, enemy attack interval, respawn, auto-resurrect —
is plain real ms from the same clock. There is no freeze, no sim-clock domain,
and no time scaling anywhere; a turn-based layer and a 2× "wait" mode both
existed here briefly and were removed, so don't reintroduce a second time
domain. The server simulates whether or not a client is connected.

**This is still true of the root game and `rpg-3d/`, and is no longer true of
`rpg-tactics/`**, which now stops its world when nothing is happening — see
[auto-pause](#auto-pause-rpg-tactics). It has a sim clock precisely because that
feature needs one; don't copy the pattern back here without a reason to.

### Death + auto-resurrect

Dying drops a tombstone and stops the player; the world keeps running.
`resurrect()` is the single revive path, shared by the **Resurrect** button and
the timer.

The **Auto-Res** toggle sits under the HUD stats and is clickable alive or dead
(the `dead` guard in `handleInput` deliberately sits *below* the
`toggleAutoResurrect` case). When on, the player revives
`AUTO_RESURRECT_DELAY_MS` (3s) after death, and `resurrectInMs` drives a
countdown beside the label.

The delay is measured from death rather than from enabling the toggle, so
switching Auto-Res on while already dead revives you at once.

### Overlays (minimap / HUD / action bar)

All three are dragged by a gold handle at their top-left corner. `main.ts` holds
their origins in a `panels` registry `{map,hud,bar}` (origin + clamp fn) and one
drag/handle-hit system drives all of them. `clampPanelOrigin` keeps each fully
on-canvas (handle included). A mousedown on a handle sets `swallowNextClick` so
the drag doesn't also register as a game click.

- **Minimap** (top-right): 3×3 grid, current room highlighted, a dot for the
  player that moves continuously (room picks the cell, in-room position scales
  onto it).
- **HUD** (top-left): circular portrait (the player's `@` in their color), red
  health + blue mana bars, and `Name - lvl N` beneath.
- **Action bar** (bottom center): 5 squares; slots 0/1 hold the melee sword and
  ranged dagger, 2–4 are placeholders. Unselected slots have a dim border; the
  selected one is **gold when the attack would land right now and white when it
  wouldn't** (`selectedCanAttack`). That's range and target only — the cooldown
  is deliberately excluded, or the border would strobe on every swing, and the
  cooldown blind already shows it.
  - **The arrangement is a parameter, not a fork.** `ActionBarLayout`
    (orientation + square size + gap) is threaded through `actionBarSize`,
    `squareRect`, `squareAtPoint` and `drawActionBar`, all defaulting to
    `ACTION_BAR_ROW` — this strip, unchanged, in the 2D and `rpg-3d` clients.
    `rpg-tactics` passes `ACTION_BAR_COLUMN` instead and gets a stack of larger
    squares; see its own section. The icons are sized as a fraction of the
    square rather than in fixed px, so a bigger square carries a bigger sword
    instead of the same one adrift in it. One layout value reaches the drawing,
    the hit-test *and* the buttons beside it, so those three can never describe
    different rectangles.

### Enemies + combat

The game is built around **one-on-one combat**: there is exactly one enemy alive
at any moment — a Hellhound (`♞`, orange, 30 HP). It enters just inside a random
room edge (`SPAWN_INSET`, 2 cells — flush against the border left it glued
there, since patrol is horizontal and never carries it inward the way wandering
used to), **patrols left and right**, and chases once the player is within
`CHASE_RANGE` or it has been hit (`aggro`, which is permanent). Kill it and
`RESPAWN_DELAY_MS` (3s) later a fresh one walks in, so there is always something
to fight and never a second one. Wave spawning, `MAX_ENEMIES`, and the
kill-count cooldown that gated it are gone — don't add a spawner back without
changing this section.

**Patrol** (`patrol` in `enemies.ts`) is a horizontal beat `PATROL_SPAN` (12
cells) wide, fixed at spawn by `patrolBeat` and clamped so it can never leave
the screen. Near a wall the beat *slides* inward rather than shrinking, so it
keeps its full width wherever the enemy spawns. The enemy marches at
`ENEMY_SPEED_WANDER` and reverses at either end; a wall counts as an end too, so
it turns around instead of grinding into the vault. Movement is purely
horizontal — it holds whatever line it is on, which after a chase is wherever
the chase left it. A chase that ends *off* the beat walks back to it before
resuming, and the end-of-beat clamp is skipped while returning so it isn't
dragged backwards. Random wandering (`wanderTarget`, `randomRoomPoint`) is gone.

**The gesture picks the target; the action bar picks the weapon.** Combat starts
one way and one way only — **double-click an enemy** — and ends one way only —
double-click your way out. It is fought with whatever slot is selected. Nothing
engages on the player's behalf: no proactive auto-combat, and no retaliation
either, so an enemy can stand there beating on you indefinitely while you do
nothing. That is deliberate; both were tried and removed.

- **Single-click** an enemy → select it (yellow ring). No attack, no movement.
- **Double-click** an enemy → `engageEnemy`: target + `attacking`, leaving
  `activeSlot` alone. `updateCombat` then applies that weapon's range rule:
  - **melee** — strike every `MELEE_INTERVAL` while within `ATTACK_RANGE`.
  - **ranged** — a dagger every `FIRE_INTERVAL_MS` in the band **outside
    `ATTACK_RANGE` and within `RANGED_RANGE`** (45–420px; the far limit is a
    third of the room's width). Daggers have a dead zone as well as a limit:
    anything already in sword reach is too close to throw at, so a hellhound on
    top of you shuts your daggers off until you draw the sword or back away.
    Beyond the limit you just hold the target and wait — ranged never moves you.
- **Tab** → same thing on the nearest enemy in the room, with no range limit.
  Double-click and Tab both go through `toggleEngage`, so they stay identical by
  construction — including the toggle back off. The client swallows Tab's
  auto-repeat (held down it would strobe engage/disengage) and its default, so
  focus doesn't walk off the canvas.
- **Double-click the engaged enemy again** (or press Tab again) → disengage and
  untarget. Together with double-clicking a *different* enemy (which just
  switches target), that is the **only** way out of combat.
- **1–5** or clicking a slot selects the weapon, before or during a fight —
  switching mid-fight switches behaviour on the next tick.

**One shared attack cooldown**, shown on the action bar as a blind. The square
that fired goes dark (icon included — the overlay is drawn *after* the glyph),
then its shade retracts upward over the cooldown so the square refills with
colour from the bottom. `startCooldown` captures the slot at fire time, so
switching weapons mid-cooldown leaves the sweep on the square that actually
attacked. The snapshot carries `cooldown: {slot, remainingMs, totalMs} | null`,
and the client counts `remainingMs` down from snapshot arrival — at 600ms a
snapshot-stepped blind visibly stair-steps. Only the firing slot is shaded, so
the *other* square looks ready when it isn't; that's cosmetic, the gate is
`nextAttackAt` either way.

There is a single `nextAttackAt`, not a timer
per weapon, and each attack charges *its own* interval against it: a dagger
(`FIRE_INTERVAL_MS`, 1s) owes a full second even if you switch to the sword
(`MELEE_INTERVAL`, 600ms) straight after. **You can never beat the cadence of the
attack you just made.** That's what stops weapon-swapping from being a damage
multiplier — with per-weapon timers, alternating slots let each one fire off its
own stale clock. `engageEnemy` deliberately does *not* reset it either, or
double-clicking off and back on would refund the cooldown.
- **Movement never breaks combat.** A ground click or a WASD step walks you
  wherever you asked and the engagement rides along — you keep swinging at
  anything that stays inside `ATTACK_RANGE` and keep throwing at anything inside
  `RANGED_RANGE` as you go.
- **Hover** within `NAME_REVEAL_DISTANCE` → shows its name (same rule reveals the
  player's own `(You)` label).

**Neither weapon pursues.** `engageEnemy` never writes `moveTarget` and neither
does `updateCombat` — closing the distance is entirely the player's job, with
WASD or a ground click (or by letting the hellhound come to you; it chases
inside `CHASE_RANGE`). Engaging a target 300px away and standing still is a
no-op: you stay put and it takes no damage. An earlier version auto-ran you into
`ATTACK_RANGE`, which needed a whole yielding mechanism so player movement could
win — all of that is gone; don't reintroduce a chase without reading this
paragraph.

Two range constants interact awkwardly and are worth knowing before tuning:
`ENEMY_RADIUS` (45, the click hit-box) is *larger* than `ATTACK_RANGE` (44), so
a ground click near enough to leave you in sword reach is swallowed by the
enemy's hit-box and read as "select" instead. Click-to-move alone therefore
always stops a hair short — in practice the hellhound closes that gap itself, so
the fight still starts, but WASD is the reliable way in.
- **Right-click has no meaning.** The canvas `contextmenu` handler only suppresses
  the browser menu.

The double-click is the browser's own `dblclick` event. The leading `click`s that
precede it only select a target, so letting them through first is harmless —
this is why the client needs no debounce. An earlier model bound the weapon to
the gesture (click = ranged, double-click = melee) and *did* need one, to stop a
dagger flying before the melee charge; don't reintroduce it.

Enemy attacks are gated on `e.chasing`, which is only ever assigned inside
`updateEnemy` — and `tick` skips `updateEnemy` for the enemy you're meleeing so
it holds position instead of shoving you. `tick` therefore sets `chasing` itself
in that branch, or a hellhound engaged at point-blank would never swing back.

### Corpses + the inspect menu

A killed enemy leaves a **body**, not a hole: the kill sweep moves it out of
`enemies` and into `corpses` (`shared/loot.ts`), where it keeps its glyph,
colour, position and facing — and its **id**, which is what an open inspect menu
points at. Dying still **clears `targetId`**: a kill leaves you holding nothing,
and the body has to be clicked afresh to select it. Living and dead are separate arrays, so
AI, enemy attacks, `nearestEnemy` (Tab) and `combatTarget` see only the living by
construction, with no `if (dead)` guard sprinkled through the tick. Corpses never
collided with anything (nothing but tiles ever did), so you walk straight
through them. `drawCorpse` renders the glyph at `CORPSE_ALPHA` — fading against
the black room reads as darkened without a second palette per enemy type — and
draws no health bar.

Bodies are permanent, but capped at `MAX_CORPSES` (32, oldest dropped): a kill
every few seconds would otherwise grow the snapshot forever.

**The same two gestures mean different things on the dead.** Single-click
selects a corpse (living win a tie — a body can lie under one); double-click
**inspects** it instead of engaging, opening a centred grey panel titled
`"<name> (dead)"`, which is exactly what hovering the body shows (`corpseLabel`
is the single source for both). Hellhounds carry nothing, so the panel says
`(empty)`.

The menu's geometry lives in `shared/loot.ts` because **the server owns the
menu**, same as everything else — the client only draws `snapshot.inspect`, so
both sides need the rectangles. It closes on:

- the ✕ in the title bar, or any click *outside* the panel — and that click does
  nothing else, so dismissing never also walks you somewhere;
- a click *inside* the panel does nothing at all (swallowed);
- **any other input** — movement, engaging, a weapon swap, resurrect. That's one
  guard at the top of `handleInput` rather than a line per case; mouse messages
  are excluded there because they need to tell ✕ / inside / outside apart.

It also closes on things that happen *to* the player rather than because of
them: **taking a hit** and **dying**, both in `tick`. A panel parked over the
middle of the room otherwise hides the hellhound chewing on you, and it is the
one dismissal the player can't trigger themselves. Input alone was not enough —
the menu closes when the world acts on you too.

## Conventions

- **Testing.** There is no committed test suite. Pure logic (shared/, and the
  testable client modules like `tilemap`, `combat`, `actionbar`, `minimap`,
  `hud`, `viewport`) is verified with throwaway `node:assert` scripts run via
  `npx tsx`, then deleted. When adding logic, keep it pure and importable so it
  can be checked this way, and prefer moving math out of `main.ts` into a module.
  Both simulations run headless too, so drive `GameSimulation` / `TacticsGame`
  directly with a fake clock rather than testing through a browser. Always run
  `npx tsc --noEmit` and `npm run build:client`, **in all three projects**, after
  changes.
  - When a throwaway test passes first time on a bug you meant to catch,
    *revert the fix and check it fails.* Two of the bugs fixed here — the
    damage-number jitter especially — had obvious-looking probes that were
    measuring the wrong quantity and passed against the broken code.
- **Glyph facing.** The player and enemies carry a `facing` (+1 right, −1 left)
  on the snapshot, set from the sign of their actual horizontal travel. The
  glyphs (`♞`, `@`) are drawn facing left, so `drawFacingGlyph` **mirrors when
  facing right** (`scale(-1, 1)` about the glyph's own centre — it relies on
  `textAlign = "center"`). Facing is *held* through vertical-only movement and
  while standing still, so it never flickers; only a horizontal move changes it,
  which is why up-and-right reads as right.
- **Glyphs.** Rendered with the system `monospace` font. BMP, single-cell,
  grid-safe glyphs only (no emoji / wide chars). Box-drawing/heavy-box glyphs can
  show faint seams between cells in some system fonts — bundling a webfont is the
  intended fix when walls need to be pixel-perfect (not yet done).
- **Comments** explain *why*, matching the existing terse style. Match
  surrounding naming/idiom.

## Known limitations / next steps

- **No pathfinding.** Click-to-move and WASD travel in a straight line and stop
  at walls — nothing routes around the vault. The player spawns *inside* it, so
  to reach the hellhound you leave via the south doorway first. (This bites when
  writing tests too: stage the player on open floor, e.g. `(200, 800)`, or they
  walk into a wall.)
- Collision is cell-based (full 30px cell) while wall glyphs are thinner lines,
  so the player stops a few px shy of visually touching a wall.
- Player name/color are randomized per simulation (no persistence, no name
  entry). True of all three front ends.
- HUD health is live; mana is still a static placeholder. Action-bar slots 3–5
  are empty. Also true of all three.
- The turn-based game has its own list at the end of its section.

## The 3D front end (`rpg-3d/`)

A second, **low-poly 3D client** for the same game, in its own npm project with
its own `node_modules` (it adds `three`), served on **port 3200** so it can run
alongside the 2D one. `cd rpg-3d && npm install && npm start`.

**It is a renderer, not a fork.** `rpg-3d/src/server/index.ts` imports
`GameSimulation` from `../../../src/server/game.js`, and the 3D client imports
`hud.ts`, `actionbar.ts`, `lootmenu.ts`, `interpolation.ts` and `viewport.ts`
from `src/client/`. There is exactly one implementation of the rules and one of
the UI; both front ends read the same `GameSnapshot` and send the same
`InputMessage`. **Never copy simulation or UI code into `rpg-3d/` — import it.**
A rule change in `src/` must land in both clients by construction.

- **Two stacked canvases**, sharing one 4:3 letterbox: WebGL underneath, the 2D
  UI on top. The overlay still draws in 1200x900 room units, so the HUD, action
  bar, clock and inspect menu are the same code at the same coordinates. The
  overlay canvas must stay **transparent** — an opaque backing hides the world.
- **Scale.** One 30px tile = one 3D unit, so the arena is 40x30 and a human is
  1.9 tall. Room x -> scene x, room **y -> scene z**; the ground is y = 0.
- **Models are built facing +X** (the snapshot's `facing: 1`) and turned with
  `yawFor`. Limbs hang from pivot groups and swing about **Z**. Everything is
  primitives in `models.ts` — there are no asset files.
- **Screen space is not room space**, and two rules keep that from leaking into
  the game: a click is resolved to a *room point* before it is sent (an entity
  under the cursor sends its own position, so the server's `enemyAtPoint` decides
  with the radius it always used), and the UI is hit-tested on the overlay. The
  inspect menu is the exception that proves it — `lootMenuPoint` translates a
  screen click into the room point that makes the server reach the same verdict
  (✕ / inside / outside), because the panel is drawn in overlay space while
  clicks arrive in room space.
- **The camera yaw is fixed** — a 3/4 view that follows the player, zoom on the
  wheel. It is deliberately not orbitable: WASD is world-relative on the server,
  so a turnable camera would quietly change what "w" means. The eye is clamped
  inside the east/west/north walls (masonry would get in front of the player) but
  may trail past the **south wall, which is built as a low parapet** for exactly
  that reason.
- **Animation is derived, never sent.** The protocol carries state, so a swing is
  "the shared cooldown was recharged", a wound is "that enemy has less health",
  and a bite is "the player's health dropped". Those comparisons run on *raw*
  snapshots in `onSnapshot` — the interpolated ones smear the step away.
- The player's randomised colour is on the **cloak**; the tunic is always brown.
- Same testing convention as the 2D game: `three`'s scene graph runs headless, so
  models and rigs are checked with a throwaway `node:assert` script under `tsx`,
  then deleted. Run `npx tsc --noEmit` and `npm run build:client` **in
  `rpg-3d/`** — the root project's typecheck does not cover it.
- **Damage numbers carry an `id`, and every client pairs them by it** — never by
  array position. The list is not stable: one expires out of the middle while a
  newer one lives on, and an index then interpolates a survivor against a
  *different* number. Because two bites on the player spawn at the same point,
  the tell isn't the position but the **age**, which drives both the fade and the
  screen-space rise: it jumped by up to 0.8s of a 1.4s lifetime, roughly 17px up
  the screen, every frame two numbers overlapped. That is the jitter.
- **Damage numbers** float at `DAMAGE_NUMBER_HEIGHT` (2.5 units) over the room
  point they spawned at, which has to clear the *tallest* thing one can belong
  to — the 1.9-unit player — or a bite reads as a label on their chest. They are
  drawn with a dark outline and held at full alpha for most of their life:
  unoutlined 15px text that starts fading immediately was, measurably, almost
  invisible over lit stone. `DAMAGE_NUMBER_LIFETIME` / `_SPEED` live in
  `src/shared/combat.ts` because a server ages and retires them while a client
  fades and places them — they were duplicated in four files and had to agree.
- Two of its client modules exist to be shared with the turn-based front end
  rather than for its own sake, and neither should grow a dependency on this
  game's rules: `playback.ts` (`interpolateSnapshot`, generic over anything
  extending `GameSnapshot`) and `applyCues` in `entities.ts`, which is the whole
  "protocol carries state, not events" derivation in one function.

## The turn-based front end (`rpg-tactics/`)

A **third** client, again its own npm project, served on **port 3300**.
`cd rpg-tactics && npm install && npm start`. Same dungeon, same models, same UI
— but the game is a 3x3 board and the rules are a board game's.

The whole game, in one picture:

```
  @ .  h        player opens on (0,0), the pack holds the right column,
  .  .  h       and the door out of the vault is the bottom-right square.
  .  .  D       Behind D: a corridor, and a second room the size of this one.
```

Turns alternate: you take one action, then every *woken* hellhound takes one,
then it is your turn again. Your action is a **walk**, an **attack**, or a
**wait**. There is no real-time input at all.

**The sequence is in the resolution, not in the playback.** The whole round is
resolved the instant your action is committed — yours first, then each woken
hound in order, every one of them reading the board the ones before it left — and
then all of it animates *together*, in a single window as long as the slowest
thing in it. What happens is exactly what a strictly sequential round produced;
what you watch is one exchange rather than three animations end to end, and a
round costs the longest action instead of the sum of them.

**The grid is fine and invisible.** It began as a literal 3x3 of squares you
hopped between; each is now `SUBDIVISION` (5) cells across, so a cell is about
half a pace. Nothing is drawn on the floor and nothing visibly snaps, so a move
reads as walking rather than as stepping tile to tile — while the simulation
stays discrete, deterministic and strictly turn-based. The grid became a lattice
for positions to sit on instead of a board you play on.

Because of that, **every rule is a distance in room pixels, never a count of
cells** (`MOVE_RANGE`, `MELEE_RANGE`, `AGGRO_RANGE`, `MIN_SEPARATION`). Raising
`SUBDIVISION` makes placement finer and changes nothing else about the game;
that is the whole point of it, and it is why the opening positions still land on
exactly the points they did when the board was three squares wide.

| | |
|---|---|
| **W** / **S** (or **↑** / **↓**) | walk forward / backward (relative to facing) |
| **A** / **D** (or **←** / **→**) | turn left / right |
| mouse drag | look around |
| click a hellhound | mark it; click it again to unmark |
| **1** / **2**, or a bar square | choose sword / dagger. **Costs nothing** |
| **Space**, or the Attack button | swing the chosen weapon at the mark |
| **Tab** / **Esc** | cycle the mark / drop it |
| double-click a body | inspect it |
| **R** | restart the encounter |
| **V** | reset view to face the character's direction |

The three constants worth holding in your head while reading the rest: a
hellhound has 24 HP and hits for 7, the player has 100 and hits for 8 (sword) or
5 (dagger). Two hounds biting take roughly a third of you per round and a hound
takes three sword blows to kill, so standing and trading with both loses. That
arithmetic is the reason the door is open — giving ground is the answer to it,
and the corridor is somewhere to give ground *to*.

**With no grid drawn, the floor has to say what the grid used to** — and it does
it with **one mark, under the cursor rather than under the player**: a small
white **footfall ring** at the cell a click would actually land on, which goes
dark red when that cell is out of `MOVE_RANGE`, has somebody in it, or is not
floor at all. The snapshot still carries the radius (`moveRange`), so what is
allowed and what the ring says are the same number — but it is answered one click
at a time. A blue **movement disc** around the player showed the whole of it at
once and was removed: a pool of light following you around the board all game
read as something painted on the floor rather than as a statement about this
turn. The amber ring that marked the way out went with the escape rule it
belonged to — the door is walked through now, not stood on, and the light
spilling through it is mark enough.

**It is the 3D client's renderer with different rules under it.** The models,
every animation rig, `applyCues`, `interpolateSnapshot` and the entire 2D overlay
are imported from `rpg-3d/` and `src/client/`; only `src/shared/tactics.ts`
(board + rules) and `src/server/game.ts` (turns) are new. **Never copy a model,
a rig or a piece of UI in here — import it.**

The mechanism that makes that possible is one line: `TacticsSnapshot` **extends
`GameSnapshot`**. Everything downstream reads the fields it always read; the
turn-based additions (`phase`, `round`, `moveRange`/`moveFrom`, `meleeRange`,
`aggro`, `strikes`, `log`, `hint`) ride along untouched. Adding a required field to
`GameSnapshot` means filling it in here too.

- **Positions stay in room pixels.** A square is `TILE_PX = 90` (three 3D units,
  against a 1.9-unit human and a 1.5-unit hellhound — close enough that adjacent
  figures nearly touch, which is what a 3x3 board needs to read as a fight
  rather than as three acres of flagstone). The board is centred in the 1200x900
  room and everything reports `ARENA_ROOM`. Keeping room pixels as the unit is
  what leaves the imported models, HUD and damage-number projection unscaled —
  the 3D bridge still just divides by 30.
  - `stage.ts` derives the board extent, the camera's framing and the fog as
    **multiples of `BOARD_W`**, not in fixed units, so resizing the board carries
    the whole scene with it. Hard-coded distances there would quietly leave the
    view halfway across the dungeon the first time the board changed.
- **Real time only animates; it never decides.** A round is committed the instant
  it is asked for — every actor's *cell* changes immediately — and `busyUntil`
  then holds the board still while all the slides and swings play out at once.
  Death is the deliberate exception, resolved after the animation, so a
  hellhound dies at the end of the blow that killed it.
  - `endPlayerTurn` therefore does the pack's thinking as well as its own job:
    `resolvePackRound` walks the woken hounds in order and returns the longest
    animation, and the window is `max(your action, that)`. There is no queue any
    more and `tick` walks nothing — when the window closes, the next turn opens.
    The action-bar blind is exactly that window, so it is no longer an estimate
    built out of `ENEMY_ACTION_MS`, which is gone.
- **Reach is a circle** — `canReach` is `within MELEE_RANGE`, from any bearing,
  and nothing else. Symmetric, so it gates the bite exactly as it gates the
  sword. Daggers keep the real-time dead zone: in sword reach is too close to
  throw.
  - **It used to carry a cone as well** — `|dx| >= |dy|`, "reach goes sideways
    and across, never straight up or down", which on the old 3x3 read as "one
    column across, at most one row up or down". Two later changes killed it, and
    the reasoning is worth keeping because it is a lesson about board rules
    surviving into a different camera.
  - The camera came down to eye level, and there the cone is **invisible**: a
    hellhound one pace in front of you, filling the screen, marked, is a hound
    your sword passes straight through — three swings running, with nothing on
    screen saying why. It was a fact about *world axes*, and first person gives
    the player no sense of where those are.
  - Then the corridor made it not merely opaque but **unplayable**. The hall
    runs north-south and is one square wide, so every approach in it is along y
    — and along y was precisely what the cone forbade. Neither side could touch
    the other in there. Combined with time only moving when something acts, two
    actors who cannot act is a standoff that never resolves.
  - What the cone *did* buy was hounds coming at you off your shoulders rather
    than from any bearing at once. That survives as `APPROACH_HALF_ANGLE` (40°)
    in `chooseGoal` — pure staging now, enforced by nothing. Widen it towards
    90° and the pack swarms instead of flanking; that is a look, not a bug.
  - `approachCells` in `shared/tactics.ts` is **dead code** — it was the pack's
    old cone-filtered approach search and nothing imports it any more.
- **Two hounds flank rather than queue**, and it takes three things working
  together — remove any one and the pack goes back into single file.
  - **They are aimed somewhere they both fit.** `assignFlanks` runs once at the
    top of the tick, before anything moves, and hands each pursuer a place in
    the line as an *angle* about the player (`FLANK_ANGLE`, ±40° for a pair).
    Only hounds sharing a side are spread: approaches are staged east and west,
    so two already on opposite ones are flanking properly and rotating them
    would walk one round the player for nothing. An angle rather than a sideways
    offset because "side by side" is across the line the pack is coming in on,
    and spreading them in y reads as abreast only while the chase runs
    east-west. Slots go by where the hounds already are, not by their place in
    the array, or the pack could swap ends mid-chase and cross through each
    other to do it. Computed once per tick and not per hound, because the enemy
    loop moves them one at a time and the second would otherwise solve against a
    board the first had already changed.
  - **Nothing may stand inside anything else** — `place` is the one door every
    hound's every step goes through, patrol and chase alike, and `MIN_SEPARATION`
    is enforced there. It used to be enforced nowhere: the constant was only ever
    a click hit-radius, and two hounds converging from the same side merged into
    one silhouette. A push that would land in masonry is refused and the hound
    holds station instead, which is what makes the corridor queue.
  - **A blocked hound leans away rather than pressing** (`avoid`, blended into
    the chase at `AVOID_WEIGHT`). The hard clamp alone is what *creates* a conga
    line: the hound behind presses at its goal, gets clamped back every tick,
    and grinds against the one in front for the rest of the fight — out of reach
    and never getting round. Leaning off while the goal still pulls turns that
    press into a slide around.
  - **Biting and moving are not exclusive.** `updateEnemy` used to return the
    instant `canReach` went true, so a hound froze wherever it first entered
    reach — which is wide, and a slot is one point in it, so the second one
    loitered on the first's shoulder all fight. It bites from where it is and
    keeps taking its place while it does. A lone hound closes to its goal at
    0.7 of reach instead of stopping at the edge of it.
  - Measured on the live server, two hounds chasing a retreating player: 100% of
    pursuit abreast, 0% of it spent riding the separation bound, and the pair
    settling 81px apart either side of the player. The corridor is the deliberate
    exception — 90px wide against a 45px body, so there the pack files.
- **A click anywhere on the floor walks you there, and the ground is what costs
  turns.** `MOVE_RANGE` stopped being a limit on where you may go and became the
  price of getting there: `onClick` records the destination as a *journey*, and
  `advanceJourney` walks a leg of it off as each turn opens — one leg, then the
  pack's answer, then the next leg. A destination four rounds away costs four
  rounds and the pack acts in every one of them, so a walk across the room is a
  commitment you arrive from having been bitten the whole way, rather than a
  click that is simply refused. Hounds are still gated the old way, one leg per
  turn, because a turn is all they get.
  - **Asking to act is how you stop.** A journey takes its own turn the instant
    one opens, so the player never gets a gap to act in; `stopWalking` is
    therefore called by any click and by anything that would spend a turn
    (`attack`, `wait`, Space, `.`) *before* the `canAct` gate that would
    otherwise swallow it mid-window. Free actions — a weapon swap, Tab, Esc —
    deliberately do not stop you.
  - **The legs are timed to run into each other**, or a five-round walk reads as
    stop and go: step, stand, step, stand. Three separate pauses had to come out
    of a leg that has more walking after it, and `step(cell, now, more, resuming)`
    takes out all three — it drops the beat between actors (`TURN_GAP_MS`, right
    at the end of a move and wrong in the middle of one), **stretches the slide
    to the whole window** so a round in which something bites you doesn't leave
    the player standing while the bite plays (you walk a little slower instead,
    which is far less noticeable than stopping dead), and starts the slide at the
    *previous* `busyUntil` rather than at `now`, so the up-to-50ms between a
    window closing and `tick` noticing comes off the new leg instead of showing
    as a stall.
    - That last one is why `resuming` exists, and it is a real trap: before the
      first leg, `busyUntil` is whatever the last action left — **zero on a fresh
      encounter** — so starting the slide there puts its beginning at the epoch
      and snaps the player to the far end of the leg. A fake-clock probe starting
      at `t = 0` scores that as a perfect glide; it took a measurement against
      the live server to see it. Start throwaway clocks at a realistic epoch.
  - **A leg that gets no closer gives up**, with "Your way is blocked" in the
    log. Nothing routes around a corner, so a destination behind masonry (the
    far room's west side, say) would otherwise spend the rest of the fight
    grinding into a wall. This is the same limitation as ever, with a stop on it.
  - The footfall ring lost its range test with the rule: it is white over any
    floor and red only where somebody is standing, which is exactly the click
    that would mark a hound instead. `snapshot.moveRange` is still sent, now
    read only for "is it my turn" (it is zero off turn) and as what a round of
    walking buys.
- **Bodies never block the player, but hounds block each other.** Walking
  *through* another actor is fine for you — a destination that lands in someone
  is nudged to `nearestClearCell`, half a pace away on a grid this fine and
  imperceptible. The pack is the exception, and the only one: hound-against-hound
  is the single piece of actor collision in any of the three games, and it exists
  because two of them converging on you otherwise occupy the same ground and read
  as one animal. Corpses still stop nothing.
- **A walk's duration is proportional to the ground covered** (`walkTo`), floored
  at 120ms — except for a leg with more walking after it, which is stretched to
  fill its whole round (see the journey below). A constant looked right when
  every move was exactly one square; now that you can stop anywhere, it would
  make a half-pace adjustment crawl.
- **Aggro is per-hound, and permanent.** A hellhound wakes when the player comes
  within a square of it (`isAdjacent`, checked every tick, so it fires whichever
  side closed the gap) or when a thrown dagger finds it — **only** it; the other
  one goes on watching. The enemy queue is built from woken hounds alone, so an
  unprovoked one takes no turn at all and stands exactly where it started.
  `isAdjacent` is deliberately wider than `canMelee`: something directly above
  you is close enough to notice you but has to step aside before it can bite.
  `snapshot.aggro` is only "has anything started"; per-hound state is on
  `enemies[].aggro`.
  - **Waking costs no turn** — a hound roused this round moves or bites this
    round. That is an ordering constraint, not a rule: `endPlayerTurn` fixes the
    queue for the round the instant the action is committed, so **anything that
    wakes a hound must do so before then**. `move` updates the player's cell
    before committing (so `wakeAdjacent` inside `endPlayerTurn` sees it), and a
    thrown dagger wakes its target **at the throw**, not on impact — waking on
    impact is a beat later, mid-flight, by which time the queue is already
    fixed and the hound stands there for a turn.
- **A woken hound looks at you.** `faceThePlayer` turns it every tick while it is
  standing still, and the client passes a `facePointFor` resolver into
  `syncEnemies` so the 3D model turns properly rather than just flipping ±X. Mid
  step it faces its travel direction — a wolf holding its head on you while
  crossing the board strafes.
- **A round's damage to the player is one number, not one per bite.**
  `resolvePackRound` sums what the pack took off you and spawns a single
  `damageNumber` where they reached you — a **14**, not two 7s. Both blows land
  in the same instant, so per-bite numbers stacked exactly on each other and had
  to be nudged apart by 24px to be legible at all; even nudged they read as two
  separate things happening rather than as the one exchange that did. The blows
  are summed rather than the health difference, so a killing round still says
  what it hit you for instead of the sliver you had left. Nothing is lost by
  adding them up: the log still names each hound and each bite, and `strikes`
  still animates a lunge apiece.
- **Every hound that bites animates its own bite.** `snapshot.strikes` carries
  one `{ enemyId, seq }` per blow of the round just resolved, and the client
  lunges every seq above the highest it has seen. A *list* rather than a field
  because the round resolves whole: both bites land in the same snapshot, and one
  field would only ever animate the last of them. `applyCues` takes an optional
  `bitersOf` resolver for exactly this; without one it falls back to the
  real-time game's *guess*, the nearest enemy that is hunting you. That guess is
  fine when one hellhound is chasing you across a room and wrong on a board
  where two flank you and both strike in a round: it hands the animation to
  whichever is a few pixels closer, twice, while the other bites you without
  moving. It stays state rather than an event, so a repeated snapshot can't
  double-play it, and `strikeSeq` deliberately survives a restart — rolling back
  to 1 would replay a bite that never happened.
  That turn, its lit eyes and its head-down hunting posture are the *whole* tell
  that a hound has woken — there is deliberately **no marker on the floor for
  aggro**. A ring under woken hounds was tried and removed: the floor already
  carries the footfall ring and the target ring, and a third thing competing for
  it read as clutter rather than as information.
- **The door ends nothing.** Stepping through it was once the encounter's second
  ending — `pendingEscape`, an `"escaped"` phase, a free turn on the way out —
  and all of that is gone. Walking onto it is an ordinary walk that hands over
  the turn like any other, and the pack follows you down the corridor.
- **Choosing an attack and making one are separate acts.** The bar's squares and
  1–5 only put a weapon in your hand; the swing is committed by the **Attack**
  button at the foot of the stack, or by **Space**. That split is in the
  protocol too — `slot` selects and `attack` commits — because a weapon swap
  must never be an accidental swing.
  - **Attack always spends the turn**, landing or not: with nothing marked, or
    with the sword out at two columns, you swing at air and the pack still
    answers. Committing is the decision; connecting is the consequence.
  - The cooldown blind is repurposed as "waiting for your turn". It is set only
    by attacks, never by a step, because `applyCues` derives the player's swing
    from a fresh cooldown and a step would otherwise swing at nothing.
  - **The bar is a stack down the left, under the player's status panel**, not
    the strip along the bottom the other two front ends draw — `BAR_LAYOUT` in
    `chrome.ts` is `ACTION_BAR_COLUMN` (56px squares against the strip's 44),
    and `main.ts` parks `barOrigin` under `hudOrigin + HUD_HEIGHT`, with enough
    gap to clear the Auto-Res toggle hanging below the name plate. That one
    constant is passed to `drawOverlay`, to `squareAtPoint` for both the click
    and the cursor, and to `attackRect`. **Nothing is duplicated to do this** —
    it is the same shared `drawActionBar` handed a different layout.
    **Attack sits at the foot of the stack**, squared off to the column's own
    width, so the left edge reads as one object: five weapons, then the thing
    that swings the one you picked. Its label and key are stacked rather than
    side by side, because at the column's width they do not fit on one line.
  - **Wait is gone entirely** — button, `.` binding and the `wait` message. The
    server had already stopped handling it. Holding still *is* the pause; and
    now that only acts spend time, **swinging at air is the pass**, which is the
    job a Wait button would have had. It costs a turn and the pack answers it,
    which is exactly what waiting should mean — so there is nothing left for a
    separate button to do.
  - **The selected weapon is drawn in your hands**, bottom-right, in
    `viewmodel.ts` — the only part of the player's own body that survives first
    person, where the player model is hidden and nothing else on screen says
    what you are holding. It is one shape function: `drawBlade` is the sword,
    the dagger, the swing *and* the throw, so a held weapon can never turn into
    a different weapon to attack with. The dagger is that same blade, shorter
    and slimmer. The corner previously drew a tapered blade for the swing and
    nothing at all the rest of the time.
    - **Rest and attack are two poses facing opposite ways, and never share the
      screen.** At rest the blade is mirrored about the hand (`scale(-1, 1)`) so
      it points in across the view — unmirrored, the sword's tip sits at x =
      1335 in a 1200-wide room, aimed at the corner the hand already occupies.
      An attack is drawn *unmirrored*: a 120-degree sweep entering from past the
      right edge, coming over the top and carrying on **down and out through the
      bottom of the screen**, which is what makes it read as a swing. The hand
      sits below the room (`PIVOT_Y` is 1.1 of it), so the last of the stroke
      takes the blade out of frame on its own — the tip crosses the bottom edge
      at 94% of the swing. There is no fade any more for exactly that reason:
      the stroke *leaves*, and a blade dissolving in mid-air was standing in for
      an exit it never made. `SWING_DURATION` grew with the arc (250ms → 330ms)
      so the blade travels at the speed it always did rather than a third faster
      to cover a third more ground.
    - **A thrown dagger has no corner animation at all — it is simply gone,
      cut rather than faded.** The thing that left your hand is already being
      drawn: the server flies it across the room as a projectile, so a second
      dagger animating in the corner told the same throw twice. It stays gone
      for exactly as long as the ranged cooldown says it is spent, so the hand
      refills at the moment you could throw the next one. Measured against the
      live server: gone at 26ms, back at 1344ms, against a `totalMs` of 1351.
      - `spent` is read off the **live cooldown**, not a timer of the client's
        own — `interpolateSnapshot` counts `remainingMs` down in real time, so
        this tracks the server's number instead of duplicating it, and retuning
        `RANGED_COOLDOWN_MS` carries the corner with it.
      - It applies only while the dagger is selected: swapping to the sword puts
        the sword in your hand at once, because that is what drawing it means.
        The sword has no gap of its own — it returns the instant its swing ends.
    - Nothing has to reconcile rest and attack, because **an attack replaces the
      carried weapon rather than drawing over it** — `drawHeldWeapon` returns early on a
      live animation, so the resting pose is hidden for its duration and comes
      back when it ends. Exactly one blade is ever on screen. That also settles
      what happens when the player swaps weapons mid-animation: the swing
      belongs to the attack that fired it, not to whatever is selected now.
    - Both animations are stamped from a **fresh cooldown** — the protocol's way
      of saying an attack happened, the same derivation `applyCues` uses —
      rather than a new event on the wire. Which one plays is read off
      `cooldown.slot`, the slot that actually fired, not `activeSlot`: swapping
      weapons mid-cooldown would otherwise replay a swing as a throw.
  - `drawActionBar` prints the selecting key `(1)`–`(5)` in each square's corner.
    That is in the **shared** bar, so it shows in all three front ends — 1–5
    select the slot everywhere, so the label is true everywhere.
- **Clicking the mark drops it.** One gesture both ways; clicking a *different*
  hellhound switches rather than toggling.
- **The camera is first-person only.** The eye rides the player's interpolated
  position; the player's own model is hidden. WASD uses **tank controls**: W/S
  move forward/backward relative to the camera's facing, A/D turn left/right
  (with reversed steering while walking backwards). Mouse drag looks around
  (yaw + pitch). V resets the view to face the character's current direction.
  A drag past `DRAG_THRESHOLD` swallows the click that follows, or looking
  around would also order a step.
  - `project` returns a point far off-canvas for anything **behind** the
    camera — the player's own head when something bites you — so a mirrored
    projection doesn't put the damage number somewhere arbitrary on screen.
  - **The camera follows the player.** `stage.follow` sets what the camera
    looks at — the player's position. The code still has an overhead mode in
    `stage.ts` (`toggleFirstPerson`, overhead yaw/pitch storage) but nothing
    in `main.ts` binds a key to it; the game starts in first person and stays
    there.
- <a id="auto-pause-rpg-tactics"></a>**Only acts spend time, and that is what
  makes this pseudo-turn-based.** The world holds still — the pack mid-stride,
  every bite timer, the clock, every deadline — and moves only while something
  is being *done*. **In a fight exactly as much as out of one**: a hellhound a
  stride from your throat stays there for as long as you leave it, and you may
  stand and think for an hour at no cost. Nothing is scaled or skipped; time
  simply isn't spent.
  - **There is no turn structure in the code** — no queue, no phase order, no
    round counter. There is a *window*, an act opens one, and the world runs
    inside it and stops at the end of it. `shouldRun` is still the whole rule
    and still asks about movement; what changed is its last line, which used to
    be `anyAwake()`. A woken pack ran the world by merely existing, so a fight
    was continuous real time and only the lull before one was still. Aggro now
    grants no time at all on its own.
  - **Three things open a window.** Your attack, for `max(its own cooldown,
    PACK_TURN_MS)` — for the sword those are the same 600ms, so the action-bar
    blind *is* the round; a dagger's longer recovery buys the pack more ground,
    which is the trade it makes. A hellhound's bite, for `STRIKE_WINDOW_MS`, so
    the lunge answering you plays out instead of freezing in the air. And
    **coming to a halt**, which is the end of a walk and gets answered like any
    other act — checked at the top of `tick` against `wasMoving`, because the
    tick that notices you have stopped is the very tick that would otherwise
    freeze the world. Walking itself is not a window but a state: the world runs
    while you move, and stopping ends it on the next tick.
  - **A swing that finds nothing still spends the turn**, and this is now
    load-bearing rather than merely fair. `attack` used to return early on no
    mark or no reach, spending nothing — which in this regime left a player with
    the sword out and a hound just out of reach holding *no action at all*: the
    swing was refused, nothing spent time, and the world sat there looking hung.
    It is also the only way to spend a turn on purpose, which is the job the
    Wait button never managed to have.
  - **A flank slot is an absolute place on the approach axis**, not a nudge from
    wherever the hound already stands — added to its current bearing, a hound
    already out near the edge of the arc got pinned against the clamp, which
    bunched the pack onto one bearing instead of spreading it.
  - **Standoffs are the failure mode to watch for in this regime.** Any pair of
    positions where neither side can act is permanent, because waiting is what
    the game is made of. The reach cone produced exactly that and had to go; if
    you add a rule that can refuse an action, check first that the other side
    can always still do *something*.
  - **Damage numbers are no longer dropped on the way into a pause.** They were,
    because a still world never ages them and one caught mid-fade would hang at
    whatever alpha it had reached — right, when a pause meant nobody was playing.
    Now that the world stops after *every* exchange, dropping them would blink
    the round's own numbers out a few hundred ms after they appeared. They hold,
    and resume ageing when the next act spends time; a frozen number over the
    thing it came off is a report of the round just fought.
  - **`simNow` is the simulation's own clock and the only one any rule reads.**
    It advances with the tick while the world runs and stops while it doesn't,
    so a bite due in 900ms is still 900ms away afterwards. `tick`, `handleInput`
    and `index.ts` still speak wall-clock ms — the conversion happens in `tick`
    and nowhere else. Deadlines off `Date.now()` are the trap: a minute of
    standing still would retire every timer at once, and the pack would collect
    a minute of free bites the instant you moved. `lastTick` is still advanced
    on a paused tick for the same reason, or resuming would replay the whole
    pause as one enormous `dt`.
  - **Aggro is permanent, so combat alone would never let go.** Once a hound has
    noticed you it is "in combat" for the rest of the encounter, which means the
    one case an away player actually needs covering — being eaten while not at
    the keyboard — is the one case the rule above never catches. Hence
    `AFK_TIMEOUT_MS` (15s): no input of any kind for that long stops the world
    wherever it stands, mid-chase included. `keyup` counts as input, because
    letting go of a key is still a player at the keyboard.
  - Dying is deliberately *not* idle: `shouldRun` keeps running for a dead
    player with Auto-Res on, since counting down while they do nothing is
    exactly what that feature is for.
  - The client only reports it. `snapshot.paused` drives a badge high and centred
    (`drawStanding` in `chrome.ts`) plus a hint line, because a frozen hellhound
    otherwise reads as a hung server. **What the badge says depends on
    `snapshot.aggro`**: with the pack awake a still world is the player's turn,
    so it reads **YOUR TURN**, and only an idle board says **PAUSED**. Since acts
    are the only thing that spends time, a fight is still most of the time — and
    a PAUSED banner hanging over every exchange would read as the game having
    hung at the exact moments it is waiting on the player hardest. The doorway
    lamp's pulse is client-side and keeps going — it is scenery, not simulation.
- **The dark closes in near.** `scene.fog` runs `BOARD_W * 0.4` to
  `BOARD_W * 1.4` — multiples of the board's width, like the camera framing, so
  resizing the squares carries the murk with it instead of stranding it at a
  fixed distance. With `BOARD_W` at 9 units that is 3.6 to 12.6: a hound at
  melee reach or a square away is untouched, the far side of the arena is 60%
  eaten, the wall across the chamber 93%, and the corridor runs into black
  rather than showing you the room at its end. Combat stays legible because
  engagements happen inside ~3 units, which is short of the near plane. The
  near plane is worth as much thought as the far one: start it too far out and
  the fog reads as a wall of haze at a fixed distance rather than as air.
- **Lit, but unshadowed.** `renderer.shadowMap.enabled` is **false** in
  `stage.ts`, and that one line is the whole of it: three renders no shadow pass,
  and the `castShadow` / `receiveShadow` flags still set on the sun, the walls,
  the floor and the imported models simply do nothing. Illumination is
  untouched — ambient, hemisphere, the directional sun and the doorway lamp
  contribute exactly as before, because a Lambert surface's brightness is
  the light reaching it and the shadow map only ever subtracted from that. The
  rig is left standing rather than stripped, so switching shadows back on is
  that line and nothing else. `rpg-3d/` still has them on; this is a
  tactics-only choice.
- **Nothing hangs on the walls.** The chambers and the corridor carried a
  `buildTorch` bracket apiece and no longer do — the masonry is bare and the
  rooms are lit by the ambient / hemisphere / sun rig alone, with the doorway
  lamp (`archLight`) the only point light and the only thing `animateScenery`
  still has to move. `rpg-3d/` keeps its torches; `buildTorch` stays in
  `models.ts` for it.
- **No hurt flash.** The tactics client passes `hurt: 0` into the shared
  `drawOverlay` rather than tracking it. The log names what hit you.
- **Nothing is drawn on the floor.** The board was once nine raised flagstones,
  back when the grid *was* the game and you hopped between squares. Now that a
  cell is a fraction of a pace and you stop where you like, ruling the floor
  would advertise a lattice the player never has to think about — the same
  reason the real-time room leaves its tile grid undrawn. A single slightly
  lighter slab marks the fighting ground so the arena still reads as a place.
- **The door opens onto somewhere, and you can go there.** Behind the doorway in
  the south wall runs a corridor, and at the end of it a second chamber the size
  of the first. The corridor is a chamber's own depth long and about a fifth of
  one across at the same wall height — **taller than it is broad is the whole of
  what makes it read as a corridor**; shrink the height with the width and it
  becomes a crawlspace, widen it and it becomes a third room.
  - **The world is three rectangles, not one.** `REGIONS` in `shared/tactics.ts`
    — `BOARD_REGION`, `HALL_REGION`, `FAR_REGION` — is what `inGrid` asks, so
    everything downstream of it (a walk's legality, `nearestClearCell`, the
    approach search, the footfall ring) reaches the corridor without knowing the
    corridor exists. `clampToGrid` clamps into *each* region and keeps the
    nearest result, or a point in the masonry beside the hall would snap back to
    the arena a screen away.
  - **The rules own the corridor's shape; `stage.ts` only dresses it.** The
    doorway's width, the masonry either side of it and the far chamber's place
    in the world are all derived from `HALL_REGION` / `FAR_REGION`, so what you
    can walk down and what you can see are the same corridor by construction.
  - The far room is `buildChamber` called a second time, with the gap in its
    north wall instead of its south — which is what "identical" means here.
    There is one room in `stage.ts`, built twice, so anything done to the arena
    lands on the far room too.
  - **The doorways are open arches, and nothing shuts them.** Each is dressed
    with two jambs and a lintel (`addDoorFrame`) so it reads as a doorway rather
    than a hole, and that is all it is — you walk through without asking. Hinged
    doors were tried and removed: `doorsClosed[]`, `clampToDoors`,
    `blockedByDoor`, the right-click toggle and the client's blocker walls,
    ceiling occluder and `DOOR_CAM_MARGIN` camera clamp all went with them.
    Don't reintroduce a door without reading this line — the pack's corridor
    navigation (`nextWaypoint`) assumes it can always path between regions.
- Same testing convention again: the rules are pure and the simulation runs
  headless, so drive `TacticsGame` with a throwaway `node:assert` script under
  `tsx` and delete it. Typecheck and build **in `rpg-tactics/`**.

### Known limitations (turn-based)

- **No pathfinding exists, and it now shows.** A move is a straight slide to the
  cell you clicked, so leaving the room means clicking the doorway first and the
  corridor second — aim at the far end from across the board and the destination
  is simply refused, because the cells between are not floor. Corners are the
  player's problem.
- **A diagonal step can grave the doorway's masonry**, because legality is
  "is the destination floor, and within `MOVE_RANGE`" with nothing said about
  the line between. At this cell size it is a graze of a jamb for a fraction of
  a slide, which is why it is a limitation and not a bug to fix with a swept
  test.
- **A hellhound standing in the corridor mouth blocks it**, exactly as one
  standing on the old escape square did: the cells it occupies are illegal
  destinations until it moves or dies, with no warning in the UI beyond the
  footfall ring going red.
- Mana, the level number and the game clock are inherited from the real-time
  HUD and mean nothing here.
- Corpses are capped at `MAX_CORPSES` (8) and never decay, but only two
  hellhounds ever exist, so the cap is unreachable in practice.

## Git

Remote `origin` is `git@github.com:mattConn/rpg-game.git` (push over **SSH** —
HTTPS has no stored credential in this environment). Commits are co-authored with
Claude.
