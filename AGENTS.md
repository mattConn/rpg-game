# Repository guidance

## Main game and level editor: native C++

**`rpg-tactics-cpp/` is the main game and the default destination for all new
gameplay, rendering, UI, bug-fix, and performance work.** The project direction
changed to native C++ on October 21, 2026. When the user says "the game," assume
this Windows-native version unless they explicitly name another project.
The native C++ level editor is also the primary editor; launch `editor.cmd`
or `./editor.ps1` for level-authoring tasks.

This guidance supersedes historical descriptions in `CLAUDE.md` and older
READMEs that call the browser game the active project. The native port is still
being developed; making it the main game does not imply complete feature parity.

## Active code and assets

- `rpg-tactics-cpp/src/native.cpp`: application entry point, SDL window/input,
  C++ raycaster, sprite rendering, HUD, scanlines, blood rendering, and self-tests.
- `rpg-tactics-cpp/src/native_game.hpp`: project/room loading, simulation,
  movement/collision, enemies, combat, bat patrols, blood particles, gates, and exits.
- `rpg-tactics-cpp/src/native_editor.hpp`: native SDL editor UI, map/3D views,
  input, in-process Play mode, and UI tests.
- `rpg-tactics-cpp/src/native_editor_document.hpp`: authored JSON, editing,
  room links, undo/redo, validation, and atomic saves with `.json.bak` backups.
- `rpg-tactics-cpp/editor.ps1` / `editor.cmd`: native level editor launchers.
- `rpg-tactics-cpp/build.ps1`: active Windows C++20 release build (`-O3`).
- `rpg-tactics-cpp/run.ps1` / `run.cmd`: active launchers; configure the SDL DLL path.
- `rpg-tactics-cpp/build/rpg-tactics-native.exe`: generated executable.
- `rpg-tactics/public/`: shared sprite sheets and textures used by the native game.
- `rpg-tactics/src/client/sprite-metadata.ts`: sprite metadata currently read by
  the native asset loader. Keep its JSON-shaped metadata compatible.
- `rpg-tactics/data/editor-project.json`: saved authored rooms, loaded directly
  by the native game. Preserve user-authored maps and assets.

The native game runs its own simulation and renderer in one process. It does
not require Node, a WebSocket server, Chrome, or the browser game to be running.
SDL2 provides window/input and accelerated presentation; the raycaster itself
currently renders pixels on the CPU.

**Do not confuse `rpg-tactics-cpp/src/main.cpp` with the active entry point.**
That file and the original Makefile belong to an older macOS OpenGL/Assimp
prototype. They are retained for reference and are not used by `build.ps1`.

## Build, run, and verify

From the repository root in PowerShell:

```powershell
cd rpg-tactics-cpp
./build.ps1
./run.ps1 --self-test
./run.ps1 --smoke-test
./run.ps1
./build.ps1 -Target editor
./editor.ps1
```

The installed toolchain is MSYS2 MinGW64 at `C:/msys64/mingw64`. Dependencies
are GCC, SDL2, SDL2_image, SDL2_ttf, and nlohmann-json. `build.ps1 -Toolchain PATH`
can override the compiler location; `run.ps1` currently uses the default DLL path.
The launcher builds only if the executable is missing: **rebuild explicitly
after source changes**. Use the launcher rather than opening the executable
without its DLL search path.

For gameplay/rendering changes, build with warnings enabled, run `--self-test`,
and run `--smoke-test`. For visible changes, capture and inspect a native image:

```powershell
New-Item -ItemType Directory -Path work -Force | Out-Null
./run.ps1 --smoke-test --screenshot work/native.png
```

Other supported options: `--room B`, `--project PATH`, `--assets PATH`,
`--benchmark`, and `--frames N`. See `rpg-tactics-cpp/README.md` for details.
Run `git diff --check` before handing off changes. Put temporary test maps,
screenshots, logs, and benchmark artifacts under the ignored `work/` directory.

The editor is also native C++ and is the default for level-authoring work.
Build it with `-Target editor`; `-Target staged` builds `rpg-tactics-next.exe`
for verification without replacing a running executable. The editor and game
share one source entry point; the editor executable name or `--editor` selects
editor mode. Run `--editor-self-test` and `--editor-ui-test` for editor changes,
as well as the gameplay tests when changing shared code. UI tests use temporary
maps under `work/` and capture map, 3D, and Play screenshots there.
Never point automated save tests at the user's authored project. Preserve
unknown JSON fields and legacy rain formats; Play must use a separate simulation
copy. Saving requires an explicit user action inside the editor.

## Native editor controls and behavior

- Tab switches between the 3D game-renderer preview and top-down map.
- In 3D, **Shift + right mouse drag rotates the camera**. Right/middle drag
  pans, and the mouse wheel zooms. Camera rotation does not change the map.
- The **Rotate map** button changes the authored room: terrain, entities,
  facings, and regions rotate 90 degrees. It is undoable; do not confuse it
  with freely orbiting the editor camera.
- Left drag paints; Select/move selects or moves an entity. Q rotates entity
  facing, and Delete removes the selected entity. Scroll over the Objects
  palette to reveal additional objects.
- F5 starts Play using unsaved changes. Escape/F5 or the return banner returns
  to the authored map without applying simulation changes. In Play, right drag
  orbits, and normal native movement/combat controls apply.
- Ctrl+S saves, Ctrl+O opens/imports, Ctrl+Z undoes, and Ctrl+Y redoes. Export
  writes a copy. Saves keep the previous file as `.json.bak`; backups and
  temporary save files are local artifacts, not project source.
- Room renaming updates incoming exits. Rain/shadow regions can be authored;
  rainfall rendering and procedural seed editing still need porting.

Keep the running editor open during unrelated work. It can contain unsaved
user edits, so do not stop it to replace a build without preserving that work.
Editor document tests and mouse-driven UI tests passed for the initial port;
rerun them when changing editing, persistence, input, or preview behavior.

Windows locks running executables. When replacing a live build, compile and
verify a separate executable first, stop only this game's process, wait for it
to exit, then replace and relaunch. Tell the user when restarting will reset
their current room. Never stop unrelated Node, browser, editor, or game processes.

Measure performance in the native executable on representative saved rooms,
including movement and combat. Report the render width and test conditions;
short smoke tests and instrumented/headless browser FPS are not representative
native gameplay benchmarks. User-observed performance takes precedence over an
isolated benchmark result.

## Current behavior to preserve

- Gargoyles are decorative statues, not enemies: no attacks, targeting, or pursuit.
- Bats spawn airborne, flap continuously, and patrol immediately without waiting
  for player aggro. They transition into pursuit when the player approaches.
- Enemy overhead health bars are hidden; the player's health HUD remains visible.
- Combat hits produce red blood for the player/most enemies and purple for spiders.
  Particles expire quickly, are capped at 640, and clear on room changes/restarts.
- Scanlines have a top-right toggle and F2 shortcut; F3 cycles render resolution.
- Movement is camera-relative WASD/arrows, Shift runs, click/Space bites, E eats,
  mouse drag orbits, wheel zooms, and R restarts/resurrects.

## Browser projects and remaining port work

`rpg-tactics/` remains the shared asset pipeline and legacy/reference browser
game/editor. Use the native editor in `rpg-tactics-cpp/` by default. Both editors
use the same authored JSON; avoid editing the same project in both at once.
Save in the native editor, then restart the standalone native game to read
changes, or use the editor's Play mode to test unsaved changes immediately.
Do not mirror native gameplay/editor changes into TypeScript unless requested.
The root browser app and `rpg-3d/` are also legacy/reference projects.

Remaining parity work includes procedural dungeon generation, advanced
species-specific behavior, rain, purple-gem puzzles, portal fall animation,
and persistent progression/statistics. The native README records the current
boundary. Do not restore intentionally removed behavior, such as enemy
gargoyles, merely to match historical browser code.
