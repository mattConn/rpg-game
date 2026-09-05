# rpg-tactics

The active game is a third-person, Doom-style raycast dungeon. Canvas2D draws textured walls and floors, with eight-direction sprites baked from the existing wolf and enemy models. The camera follows behind the whole wolf and can orbit independently. A wall or closed gate behind the player pushes the camera closer.

The server still owns movement, collisions, combat, eating, pressure plates, spikes, the gem, and dungeon progression. The client consumes the same 20 Hz snapshots. Dead enemies use static sprites and disappear as soon as eating completes.

## Run

```sh
npm install
npm start
```

Open http://localhost:3300 in your browser. The level editor remains at `/editor.html`.

## Controls

- WASD / arrow keys: move relative to the camera; the wolf turns toward travel.
- Hold right mouse and drag to orbit and look up/down. Release to stop looking; left-click bites, including while dragging.
- Left click: bite in the wolf's facing direction. The player has no visible weapon.
- E: eat a nearby corpse; Shift: run.
- 1–4: existing weapon/item actions; R: restart; V: reset camera; /: turn the camera around.
- Scroll down: zoom out a little; scroll up: return closer. V also resets zoom. Walls still limit camera distance.
- H: show/hide the FPS counter.

A pale enemy reticle indicates nearby or aligned; gold indicates both inside the facing cone and in bite range. Walls hide the indicator.

## Graphics

Low / Med / High / Max remains at the top right and is saved between visits. Switching reloads the page.

| Mode | Maximum internal width | Wall/floor textures | FPS limit |
|---|---:|---:|---:|
| Low | 320 px | 64 px | 30 |
| Med | 480 px | 128 px | 60 |
| High | 640 px | 256 px | Display refresh |
| Max | 960 px | 512 px | Display refresh |

Height follows the window's aspect ratio. The scene is scaled with nearest-neighbor sampling for the pixel-art look; the HUD remains sharp. The active game does not load Three.js, GLTF files, skeletal animations, or dynamic lights. Performance still depends on viewport, browser, and scene contents.

## Development

- `npm run typecheck` and `npm run build:client`: validate and build.
- `npm run test:raycast`: headless ray/collision-map checks.
- `node scripts/test-raycast-browser.mjs`: browser integration checks against a separate game server on port 3301 (override with `RAYCAST_TEST_URL`). Requires Google Chrome. Test screenshots go in ignored `work/`.
- `npm run build:sprites`: regenerate `public/sprites/` and `src/client/sprite-metadata.ts`. Requires the game server on port 3300 and Google Chrome; uses WebGL only during this offline bake.

Run a separate test server with PowerShell: `$env:PORT='3301'; npx tsx src/server/index.ts`.

`raycast-world.ts` builds the floor grid from the same region definitions as the simulation, traces walls with DDA, and intersects pressure-plate gates and the gem barrier. `raycast-renderer.ts` draws the scene and occludes sprites using wall depths. `main.ts` owns network input, camera controls, and the reused HUD.

The previous Three.js stage remains in `stage.ts` for reference. Shared models in `rpg-3d/` supply the offline sprite bake and the separate legacy 3D game. No simulation rules are copied into the renderer.

The camera starts farther back with a slightly elevated view. Scroll out for a wider overhead view (up to 840 world units); scroll in to return close to the wolf. The camera passes through walls and keeps its selected zoom distance. V restores the default distance.

Floor stats appear below health: kills/total for the current floor, deaths on this floor, and deaths across saved floors. Resetting or resurrecting clears the current kill count; deaths accumulate. Records are saved in browser local storage by floor seed. Export stats downloads CSV with columns `seed,deaths,enemies killed/total`. The DEAD panel offers a central Resurrect button; R also resurrects.

The camera uses a Diablo-style diagonal overhead follow view at a fixed 30-degree elevation, with the wolf centered slightly below mid-screen. Scroll zoom preserves that angle; right-drag rotates horizontally and adjusts elevation between 10 and 30 degrees; V restores the default 30-degree diagonal view. Existing sprites are reused.
