# RPG Tactics - main native C++ game

**This is the active game and the focus of future development.** See the root
[AGENTS.md](../AGENTS.md) for repository guidance. Feature parity with the older
browser game is still in progress; the port boundary is documented below.

The Windows build runs a local C++ simulation and raycaster with SDL2 presentation.
It loads the current game's sprite sheets and saved editor project directly;
it does not need Chrome, Node, or the game server.

## Run on this machine

Double-click **run.cmd**, or run `./run.ps1` from PowerShell. It opens the saved
project's active room. The launcher sets the installed MSYS2 DLL search path.
The executable is `build/rpg-tactics-native.exe`; use the launcher because its
SDL DLLs are in MSYS2.

```powershell
./build.ps1
./run.ps1
./run.ps1 --room B
./run.ps1 --project C:/path/to/editor-project.json
```

Assets default to `../rpg-tactics/public`; override with `--assets PATH`.
Save changes in the native editor, then restart the standalone native game,
or test unsaved changes directly using the editor's Play button.
The native game reads the project and never overwrites editor saves.

## Native level editor

Double-click **editor.cmd**, or run:

```powershell
./build.ps1 -Target editor
./editor.ps1
./editor.ps1 --project C:/path/to/editor-project.json
```

The editor opens the existing saved project in a 3D view using the game renderer.
Tab switches to a top-down map. Terrain, Objects, and Regions tabs contain the
painting palette; scroll over the palette to reveal more objects. Gargoyles are
statues. Bat spawns immediately fly/patrol when testing in Play.

- Left drag paints terrain/objects; Fill uses the last terrain type selected.
- Select/move picks an entity; drag it to an unoccupied, non-wall tile. Q rotates
  the selected entity or the facing used for new placements. Delete removes it.
- Right/middle drag pans. In 3D, Shift + right drag orbits; wheel zooms.
- Rain/Shadow tools draw rectangular regions. Erase region deletes the region
  under the pointer on the active layer. Rain is authored and shown as an editor
  overlay; rainfall rendering in the game remains unported.
- Gate/button links and exit destinations use one A-Z or 0-9 label. Set the link
  field before placement, or select an entity and use Apply link.
- The room-label field is the target for New, Copy, and Rename. Arrows switch
  rooms. Renaming updates incoming exit links; linked rooms cannot be deleted
  until their incoming exits are removed. Clear and Delete room are undoable.
  Rotate map turns all terrain, entities, facings, and regions 90 degrees.
- Ctrl+Z / Ctrl+Y undo/redo, with one history entry per brush stroke (48 entries).
- Save / Ctrl+S writes the opened project with a `.json.bak` previous version.
  Open / Ctrl+O imports a JSON project (or single room); Export writes a copy.
  Unsaved changes prompt before closing or replacing the document.
- Play / F5 tests unsaved rooms in the native game. Escape/F5 or the return banner
  returns to the unchanged authored map. Each room needs a player spawn, and exit
  destinations must exist. Play uses normal game controls, with right drag for
  orbiting. The standalone game can remain open alongside the editor.

The JSON schema and unknown metadata are preserved for compatibility with the
legacy browser editor. Do not edit the same file in both editors at once.
`-Target staged` builds a separate executable for testing while either app runs;
`--editor` also selects editor mode in that staged/shared executable.

## Controls

- WASD / arrows: camera-relative movement
- Shift: sprint
- Left click or Space: bite
- E: eat a nearby corpse
- Mouse drag: orbit; wheel: zoom
- R: restart the room / resurrect
- F2 or the top-right button: scanlines
- F3: cycle internal render widths (320 / 480 / 640 / 960)
- Escape: quit

The top-right FPS counter measures the native application's frame rate. The
initial internal width is 640 pixels, scaled to a resizable 1280x800 window.
Enemy overhead health bars remain hidden.
Gargoyles are decorative, non-combat statues. Bats spawn airborne with animated
wings and immediately patrol around their spawn, switching to pursuit nearby.

## Build dependencies

Windows: MSYS2 MinGW64 GCC, SDL2, SDL2_image, SDL2_ttf, and nlohmann-json.
The build defaults to `C:/msys64/mingw64`; supply `-Toolchain PATH` to use another
MinGW64 installation. The launcher currently uses the default path.

In an MSYS2 shell:

```sh
pacman -S --needed mingw-w64-x86_64-gcc mingw-w64-x86_64-SDL2 mingw-w64-x86_64-SDL2_image mingw-w64-x86_64-SDL2_ttf mingw-w64-x86_64-nlohmann-json
```

SDL: https://wiki.libsdl.org/SDL2/SDL_CreateRenderer
JSON: https://json.nlohmann.me/integration/

## Verification

```powershell
./run.ps1 --self-test
./run.ps1 --smoke-test --screenshot work/native.png
./run.ps1 --benchmark
./editor.ps1 --editor-self-test
./editor.ps1 --editor-ui-test
```

Create `work` before requesting a screenshot there. Smoke mode renders three
frames in a hidden window. Benchmark mode runs 300 frames, moves the player,
requests VSync off, and reports measured FPS and average render time. Asset
loading is excluded. `--frames N` overrides the frame limit when supplied last.
Editor UI tests exercise mouse painting, region dragging, entity movement/facing,
undo/redo, save/reload, Play/return, and 3D picking. Test saves and screenshots
(`editor-map.png`, `editor-preview.png`, `editor-play.png`) go under `work/`.

## Port boundary

Implemented: authored project/room loading, painted stone/grass and walls,
camera-side wall cutaways, directional sprites, decorations, shadow regions,
walking/sprinting, wall/scenery/gate collision, basic enemy chase/melee combat,
eating/healing, death/restart, button-linked gates, linked room exits, player
HUD, scanlines, and native FPS measurement.
Combat hits emit short-lived blood spatters: red for the player and most enemies,
purple for spiders. Particle counts are capped during crowded fights.

This is a playable performance prototype, **not full gameplay parity**. Enemy
species currently share simplified chase/combat behavior. Procedural dungeon
generation, rain rendering, detailed bat dives,
spider wall climbing, purple-gem puzzles, portal
fall animation, and persistent progression/statistics still need porting.
Scanline and resolution choices currently last for the application session.

`src/native.cpp`, `src/native_game.hpp`, and `src/native_editor*.hpp` implement
this build. The native editor covers authored rooms and in-process playtesting;
procedural seed editing remains unported. The older
macOS 3D/Assimp prototype remains in `src/main.cpp` with its original Makefile;
it is separate and is not compiled by `build.ps1`.
