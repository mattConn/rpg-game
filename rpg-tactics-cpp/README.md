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
Save changes in the existing browser editor, then restart the native game.
The native game reads the project and never overwrites editor saves.

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
```

Create `work` before requesting a screenshot there. Smoke mode renders three
frames in a hidden window. Benchmark mode runs 300 frames, moves the player,
requests VSync off, and reports measured FPS and average render time. Asset
loading is excluded. `--frames N` overrides the frame limit when supplied last.

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
generation, the level editor itself, rain, detailed bat dives,
spider wall climbing, purple-gem puzzles, portal
fall animation, and persistent progression/statistics still need porting.
Scanline and resolution choices currently last for the application session.

`src/native.cpp` and `src/native_game.hpp` implement this build. The older
macOS 3D/Assimp prototype remains in `src/main.cpp` with its original Makefile;
it is separate and is not compiled by `build.ps1`.
