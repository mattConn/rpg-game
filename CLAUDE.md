# CLAUDE.md

Guidance for working in this repo.

## What this is

A 2D single-player browser RPG rendered on an HTML `<canvas>`. All game logic
runs in the browser; a small Fastify server only serves static files (no
websocket, no shared state). It was forked from a sibling `multiplayer-rpg`
project by stripping the networking layer (Hocuspocus / Yjs / awareness) — hence
deps are just `fastify` + `@fastify/static`.

## Run / build

```bash
npm install
npm start          # esbuild-bundles the client, then serves at http://localhost:3000
npm run dev        # same, but restarts the server on change (tsx watch)
npm run watch:client   # rebuild the client bundle on change
npm run typecheck  # tsc --noEmit
```

The client entry `src/client/main.ts` is bundled by esbuild to
`public/game.js` (IIFE). `public/index.html` loads that bundle. The bundle is
gitignored — `npm start`/`build:client` regenerates it.

The dev server listens on `PORT` (default 3000). During this project a second
copy was often run with `PORT=3100` alongside the multiplayer one.

## Architecture

TypeScript throughout, ES modules, strict + `noUncheckedIndexedAccess`. Three
layers:

- `src/shared/` — pure, browser-agnostic logic (no DOM). Runnable under
  `tsx`/node, which is how it's tested.
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
- `src/server/index.ts` — Fastify static server. Nothing game-specific.

## Core concepts

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
  ranged dagger, 2–4 are placeholders. Active slot has a yellow border.

### Enemies + combat

Enemies (`enemies.ts`) are glyph tokens with identity (currently one hellhound,
a `♞` in orange, near the top-right of the start room — render-only, no stats/AI).

- **Single-click** an enemy → target it (yellow ring). Never moves you.
- **Hover** within `NAME_REVEAL_DISTANCE` → shows its name (same rule reveals the
  player's own `(You)` label).
- **Double-click** an enemy → attack (ring turns **red**). Double-clicking the
  same enemy again cancels combat (ring back to yellow, target kept).
- **Melee** selected: walk to `ATTACK_RANGE` of the enemy and hold (reuses
  `moveTarget`). **Ranged** selected: throw daggers at it every
  `FIRE_INTERVAL_MS` at `PROJECTILE_SPEED`, oriented along flight, stopped by
  walls; continues until cancelled.
- **1–5** keys or clicking a slot select the active attack.
- Clicking open ground cancels combat *and* untargets (and walks there).

There is no damage / death yet — "attack" is purely positioning + visuals.

## Conventions

- **Testing.** There is no committed test suite. Pure logic (shared/, and the
  testable client modules like `tilemap`, `combat`, `actionbar`, `minimap`,
  `hud`, `viewport`) is verified with throwaway `node:assert` scripts run via
  `npx tsx`, then deleted. When adding logic, keep it pure and importable so it
  can be checked this way, and prefer moving math out of `main.ts` into a module.
  Always run `npx tsc --noEmit` and `npm run build:client` after changes.
- **Glyphs.** Rendered with the system `monospace` font. BMP, single-cell,
  grid-safe glyphs only (no emoji / wide chars). Box-drawing/heavy-box glyphs can
  show faint seams between cells in some system fonts — bundling a webfont is the
  intended fix when walls need to be pixel-perfect (not yet done).
- **Comments** explain *why*, matching the existing terse style. Match
  surrounding naming/idiom.

## Known limitations / next steps

- **No pathfinding.** Click-to-move and melee auto-approach travel in a straight
  line and stop at walls — they don't route around the vault. To melee the
  hellhound, leave the vault (south doorway) first.
- Collision is cell-based (full 30px cell) while wall glyphs are thinner lines,
  so the player stops a few px shy of visually touching a wall.
- Player name/color are randomized per page load (no persistence, no name entry).
- HUD health/mana are static placeholders (100/100); action-bar slots 3–5 empty.

## Git

Remote `origin` is `git@github.com:mattConn/rpg-game.git` (push over **SSH** —
HTTPS has no stored credential in this environment). Commits are co-authored with
Claude.
