#pragma once
#include "native_editor_document.hpp"
#include <SDL_syswm.h>
#include <commdlg.h>
#include <functional>

struct NativeEditor {
  SDL_Window *window;
  Renderer &renderer;
  EditorDocument doc;
  Game scene;
  bool running = true, playing = false, perspective = true, refresh = true,
       dragging = false, panning = false;
  int category = 0, field = 0, scroll = 0, mx = 0, my = 0, startX = -1,
      startY = -1, lastX = -1, lastY = -1;
  double zoom = 18, facing = 0;
  double fpsSeconds = 0;
  int fpsFrames = 0;
  Point center;
  std::string tool = "floor", fillType = "floor", layer = "terrain", selected,
              link = "A", roomLabel = "B", roomName;
  std::string status =
      "Left: paint | Right: pan | Shift+right: orbit 3D | Wheel: zoom";
  struct Button {
    SDL_Rect rect;
    std::function<void()> action;
  };
  std::vector<Button> buttons;
  NativeEditor(SDL_Window *w, Renderer &r, const fs::path &p,
               const std::string &room)
      : window(w), renderer(r) {
    doc.load(p);
    if (!room.empty()) {
      if (!doc.project["rooms"].contains(room))
        throw std::runtime_error("Unknown room");
      doc.project["activeRoom"] = room;
    }
    renderer.scanlines = false;
    syncRoom();
    SDL_SetWindowMinimumSize(window, 1100, 760);
  }
  void syncRoom() {
    scene = doc.preview(false);
    center = scene.player * (1 / tileSize);
    roomName = doc.room().value("name", std::string("Untitled room"));
    selected.clear();
    refresh = false;
  }
  Json *selection() {
    for (auto &e : doc.room()["entities"])
      if (e.value("id", "") == selected)
        return &e;
    return nullptr;
  }
  void message(const std::string &s) { status = s; }
  void guarded(const std::function<void()> &fn) {
    try {
      fn();
    } catch (const std::exception &e) {
      dragging = panning = false;
      message(e.what());
      SDL_ShowSimpleMessageBox(SDL_MESSAGEBOX_ERROR, "Level editor", e.what(),
                               window);
    }
  }
  bool confirm(const char *title, const char *body) {
    SDL_MessageBoxButtonData choices[] = {
        {SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT, 0, "Cancel"},
        {SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT, 1, "Continue"}};
    SDL_MessageBoxData data{
        SDL_MESSAGEBOX_WARNING, window, title, body, 2, choices, nullptr};
    int result = 0;
    SDL_ShowMessageBox(&data, &result);
    return result == 1;
  }
  fs::path fileDialog(bool save) {
    wchar_t buffer[32768]{};
    if (save) {
      auto name = doc.path.filename().wstring();
      std::copy(name.begin(), name.end(), buffer);
    }
    SDL_SysWMinfo info{};
    SDL_VERSION(&info.version);
    SDL_GetWindowWMInfo(window, &info);
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = info.info.win.window;
    ofn.lpstrFilter = L"JSON projects\0*.json\0All files\0*.*\0\0";
    ofn.lpstrFile = buffer;
    ofn.nMaxFile = 32768;
    ofn.lpstrDefExt = L"json";
    ofn.Flags = OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR |
                (save ? OFN_OVERWRITEPROMPT : OFN_FILEMUSTEXIST);
    auto cwd = fs::current_path();
    auto ok = save ? GetSaveFileNameW(&ofn) : GetOpenFileNameW(&ofn);
    fs::current_path(cwd);
    if (!ok && CommDlgExtendedError())
      throw std::runtime_error("File dialog failed");
    return ok ? fs::path(buffer) : fs::path{};
  }
  void save(bool exportCopy = false) {
    auto p = exportCopy ? fileDialog(true) : doc.path;
    if (p.empty())
      return;
    doc.save(p, !exportCopy);
    message(exportCopy
                ? "Exported project copy."
                : "Saved project. Previous version retained in .json.bak.");
  }
  bool discard() {
    if (!doc.dirty())
      return true;
    SDL_MessageBoxButtonData choices[] = {
        {SDL_MESSAGEBOX_BUTTON_ESCAPEKEY_DEFAULT, 0, "Cancel"},
        {0, 1, "Discard"},
        {SDL_MESSAGEBOX_BUTTON_RETURNKEY_DEFAULT, 2, "Save"}};
    SDL_MessageBoxData data{SDL_MESSAGEBOX_WARNING,
                            window,
                            "Unsaved map changes",
                            "Save your changes before continuing?",
                            3,
                            choices,
                            nullptr};
    int result = 0;
    SDL_ShowMessageBox(&data, &result);
    if (result == 2) {
      save();
      return !doc.dirty();
    }
    return result == 1;
  }
  void open() {
    auto p = fileDialog(false);
    if (p.empty())
      return;
    EditorDocument candidate;
    candidate.load(p); // Validate before discarding anything.
    if (!discard())
      return;
    doc = std::move(candidate);
    syncRoom();
    message("Opened " + doc.path.filename().string());
  }
  void startPlay() {
    scene = doc.preview(true);
    playing = true;
    field = 0;
    dragging = panning = false;
    message("Play test - Escape returns to your unchanged map.");
  }
  SDL_Rect canvas() const {
    return {300, 96, renderer.windowW - 300, renderer.windowH - 132};
  }
  bool inCanvas(int x, int y) const {
    auto r = canvas();
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }
  Point worldAt(int x, int y) const {
    if (!perspective) {
      auto c = canvas();
      return {center.x + (x - c.x - c.w * .5) / zoom,
              center.y + (y - c.y - c.h * .5) / zoom};
    }
    double sx = double(x) * renderer.width / renderer.windowW,
           sy = double(y) * renderer.height / renderer.windowH;
    if (sy <= renderer.horizon + 1)
      return {-10000, -10000};
    double depth = renderer.eye * renderer.focal / (sy - renderer.horizon);
    return (renderer.camera + renderer.forward * depth +
            renderer.right *
                ((sx - renderer.width * .5) * depth / renderer.focal)) *
           (1 / tileSize);
  }
  Point screenAt(Point p) const {
    if (!perspective) {
      auto c = canvas();
      return {c.x + c.w * .5 + (p.x - center.x) * zoom,
              c.y + c.h * .5 + (p.y - center.y) * zoom};
    }
    Point delta = p * tileSize - renderer.camera;
    double depth = delta.x * renderer.forward.x + delta.y * renderer.forward.y;
    if (depth < 1)
      return {-10000, -10000};
    return {(renderer.width * .5 +
             (delta.x * renderer.right.x + delta.y * renderer.right.y) *
                 renderer.focal / depth) *
                renderer.windowW / renderer.width,
            (renderer.horizon + renderer.eye * renderer.focal / depth) *
                renderer.windowH / renderer.height};
  }
  void rectangle(SDL_Rect r, SDL_Color c, bool outline = false) {
    SDL_SetRenderDrawColor(renderer.output, c.r, c.g, c.b, c.a);
    if (outline)
      SDL_RenderDrawRect(renderer.output, &r);
    else
      SDL_RenderFillRect(renderer.output, &r);
  }
  void label(const std::string &s, int x, int y) {
    if (!s.empty())
      renderer.text(s, x, y);
  }
  void button(const std::string &s, int x, int y, int w,
              std::function<void()> fn, bool active = false) {
    SDL_Rect r{x, y, w, 28};
    rectangle(r, active ? SDL_Color{106, 79, 43, 255}
                        : SDL_Color{42, 48, 54, 255});
    rectangle(r, {75, 81, 86, 255}, true);
    label(s, x + 7, y + 5);
    buttons.push_back({r, std::move(fn)});
  }
  void input(const std::string &s, int x, int y, int w, int id) {
    SDL_Rect r{x, y, w, 28};
    rectangle(r, {14, 19, 23, 255});
    rectangle(r,
              field == id ? SDL_Color{220, 177, 93, 255}
                          : SDL_Color{75, 81, 86, 255},
              true);
    label(s + (field == id ? "|" : ""), x + 6, y + 5);
    buttons.push_back({r, [this, id] {
                         field = id;
                         SDL_StartTextInput();
                       }});
  }
  void choose(const std::string &t) {
    tool = t;
    selected.clear();
    field = 0;
    if (t == "rain" || t == "shadow")
      layer = t;
    else if (t != "erase")
      layer = "terrain";
    if (t == "floor" || t == "grass" || t == "wall" || t == "forest-wall" ||
        t == "doorway" || t == "void")
      fillType = t;
  }
  void brush(int x, int y) {
    if (!doc.inside(x, y))
      return;
    if (tool == "erase") {
      if (layer != "terrain")
        doc.region(x, y, x, y, layer == "rain", true);
      else if (!doc.eraseEntity(x, y))
        doc.paint(x, y, "void");
    } else if (tool == "fill")
      doc.fill(x, y, fillType);
    else if (tool == "floor" || tool == "grass" || tool == "wall" ||
             tool == "forest-wall" || tool == "doorway" || tool == "void")
      doc.paint(x, y, tool);
    else if (tool != "select" && tool != "rain" && tool != "shadow")
      selected = doc.place(x, y, tool, facing, link);
    refresh = true;
  }
  void stroke(int x, int y) {
    if (lastX < 0) {
      brush(x, y);
      lastX = x;
      lastY = y;
      return;
    }
    int steps = std::max(std::abs(x - lastX), std::abs(y - lastY));
    for (int i = 1; i <= steps; ++i)
      brush(int(std::round(lastX + (x - lastX) * double(i) / steps)),
            int(std::round(lastY + (y - lastY) * double(i) / steps)));
    lastX = x;
    lastY = y;
  }
  void drawCell(int x, int y, int w, int h, SDL_Color color, bool outline) {
    if (!perspective) {
      auto p = screenAt({double(x), double(y)});
      rectangle({int(p.x), int(p.y), std::max(1, int(w * zoom)),
                 std::max(1, int(h * zoom))},
                color, outline);
    } else {
      std::array<Point, 5> ps = {screenAt({double(x), double(y)}),
                                 screenAt({double(x + w), double(y)}),
                                 screenAt({double(x + w), double(y + h)}),
                                 screenAt({double(x), double(y + h)}),
                                 screenAt({double(x), double(y)})};
      SDL_SetRenderDrawColor(renderer.output, color.r, color.g, color.b,
                             color.a);
      for (int i = 0; i < 4; ++i)
        if (ps[i].x > -9999 && ps[i + 1].x > -9999)
          SDL_RenderDrawLine(renderer.output, int(ps[i].x), int(ps[i].y),
                             int(ps[i + 1].x), int(ps[i + 1].y));
    }
  }
  void drawMap() {
    if (refresh) {
      scene = doc.preview(false);
      refresh = false;
    }
    if (perspective)
      renderer.render(scene, true, center * tileSize);
    else {
      SDL_SetRenderDrawColor(renderer.output, 12, 16, 19, 255);
      SDL_RenderClear(renderer.output);
    }
    auto c = canvas();
    SDL_RenderSetClipRect(renderer.output, &c);
    SDL_SetRenderDrawBlendMode(renderer.output, SDL_BLENDMODE_BLEND);
    if (!perspective) {
      for (const auto &t : doc.room()["tiles"]) {
        std::string type = t["type"];
        SDL_Color col = type == "grass"         ? SDL_Color{51, 77, 49, 255}
                        : type == "wall"        ? SDL_Color{128, 122, 107, 255}
                        : type == "forest-wall" ? SDL_Color{26, 49, 31, 255}
                                                : SDL_Color{71, 70, 65, 255};
        drawCell(t["x"], t["y"], 1, 1, col, false);
      }
      if (zoom >= 10) {
        auto p = worldAt(c.x, c.y), q = worldAt(c.x + c.w, c.y + c.h);
        SDL_SetRenderDrawColor(renderer.output, 106, 117, 122, 35);
        for (int x = std::max(0, int(p.x));
             x <= std::min(doc.room()["width"].get<int>(), int(q.x) + 1); ++x) {
          auto a = screenAt({double(x), 0}),
               b = screenAt({double(x), doc.room()["height"].get<double>()});
          SDL_RenderDrawLine(renderer.output, int(a.x), int(a.y), int(b.x),
                             int(b.y));
        }
        for (int y = std::max(0, int(p.y));
             y <= std::min(doc.room()["height"].get<int>(), int(q.y) + 1);
             ++y) {
          auto a = screenAt({0, double(y)}),
               b = screenAt({doc.room()["width"].get<double>(), double(y)});
          SDL_RenderDrawLine(renderer.output, int(a.x), int(a.y), int(b.x),
                             int(b.y));
        }
      }
      drawCell(0, 0, doc.room()["width"], doc.room()["height"],
               {160, 146, 102, 255}, true);
    }
    // Use parsed masks so legacy rain formats remain visible without rewriting
    // them.
    if (layer != "terrain") {
      const auto &mask = layer == "rain" ? scene.room.rain : scene.room.shadows;
      for (int y = 0; y < scene.room.height; ++y)
        for (int x = 0; x < scene.room.width; ++x)
          if (mask[y * scene.room.width + x])
            drawCell(x, y, 1, 1,
                     layer == "rain" ? SDL_Color{70, 152, 225, 85}
                                     : SDL_Color{152, 86, 187, 100},
                     perspective);
    }
    for (const auto &e : doc.room()["entities"]) {
      int x = int(std::floor(e["x"].get<double>())),
          y = int(std::floor(e["y"].get<double>()));
      bool sel = e.value("id", "") == selected;
      if (!perspective) {
        std::string type = e["type"];
        SDL_Color col = type == "player" ? SDL_Color{235, 201, 113, 255}
                        : (type == "hellhound" || type == "bat" ||
                           type == "spider" || type == "snake")
                            ? SDL_Color{204, 94, 78, 255}
                        : type == "portal-exit" ? SDL_Color{171, 123, 211, 255}
                                                : SDL_Color{155, 166, 171, 255};
        auto p =
            screenAt({e["x"].get<double>() + .5, e["y"].get<double>() + .5});
        int size = std::max(3, int(zoom * .6));
        rectangle({int(p.x) - size / 2, int(p.y) - size / 2, size, size}, col);
        if (zoom >= 26)
          label(type == "player"     ? "P"
                : type == "bat"      ? "B"
                : type == "gargoyle" ? "G"
                                     : type.substr(0, 1),
                int(p.x) - 5, int(p.y) - 8);
      }
      if (sel)
        drawCell(x, y, 1, 1, {255, 210, 117, 255}, true);
    }
    if (inCanvas(mx, my)) {
      auto p = worldAt(mx, my);
      int x = int(std::floor(p.x)), y = int(std::floor(p.y));
      if (doc.inside(x, y)) {
        if (dragging && (tool == "rain" || tool == "shadow"))
          drawCell(std::min(x, startX), std::min(y, startY),
                   std::abs(x - startX) + 1, std::abs(y - startY) + 1,
                   {255, 213, 127, 255}, true);
        else
          drawCell(x, y, 1, 1, {255, 213, 127, 255}, true);
      }
    }
    SDL_RenderSetClipRect(renderer.output, nullptr);
    SDL_SetRenderDrawBlendMode(renderer.output, SDL_BLENDMODE_NONE);
  }
  void draw() {
    buttons.clear();
    if (playing) {
      renderer.render(scene, false, {}, false);
      rectangle({renderer.windowW / 2 - 160, 10, 320, 30}, {106, 79, 43, 255});
      label("ESC / F5: RETURN TO EDITOR", renderer.windowW / 2 - 150, 17);
      rectangle({0, renderer.windowH - 32, renderer.windowW, 32},
                {23, 28, 32, 255});
      label("WASD move | Shift run | Click/Space bite | E eat | Right drag "
            "orbit | Wheel zoom | R restart",
            12, renderer.windowH - 24);
      renderer.presentFrame();
      return;
    }
    drawMap();
    rectangle({0, 0, renderer.windowW, 96}, {23, 28, 32, 255});
    rectangle({0, 96, 300, renderer.windowH - 96}, {26, 32, 37, 255});
    label("WOLF DUNGEON / LEVEL EDITOR", 16, 12);
    label("Room " + doc.active() + "  |  " + roomName +
              (doc.dirty() ? "  * unsaved" : "  |  saved"),
          360, 12);
    button("Save", 16, 46, 72, [this] { save(); });
    button("Open", 96, 46, 72, [this] { open(); });
    button("Export", 176, 46, 80, [this] { save(true); });
    button("Undo", 272, 46, 72, [this] {
      doc.undo();
      syncRoom();
    });
    button("Redo", 352, 46, 72, [this] {
      doc.redo();
      syncRoom();
    });
    button(perspective ? "Map [Tab]" : "3D [Tab]", 440, 46, 110,
           [this] { perspective = !perspective; });
    button("Fit map", 558, 46, 90, [this] {
      perspective = false;
      center = {doc.room()["width"].get<double>() * .5,
                doc.room()["height"].get<double>() * .5};
      auto c = canvas();
      zoom = std::min((c.w - 40) / doc.room()["width"].get<double>(),
                      (c.h - 40) / doc.room()["height"].get<double>());
    });
    button("Spawn", 656, 46, 80, [this] {
      center = scene.player * (1 / tileSize);
      zoom = 18;
    });
    button("Rotate map", 744, 46, 116, [this] {
      doc.rotateRoom();
      syncRoom();
      message("Rotated entire room 90 degrees. Ctrl+Z to undo.");
    });
    button(
        "Play [F5]", renderer.windowW - 142, 46, 126, [this] { startPlay(); },
        true);
    label("ROOMS", 16, 108);
    button("<", 102, 102, 32, [this] { cycleRoom(-1); });
    button(doc.active(), 142, 102, 50, [this] { cycleRoom(1); });
    button(">", 200, 102, 32, [this] { cycleRoom(1); });
    input(roomLabel, 16, 140, 36, 1);
    button("New", 60, 140, 60, [this] {
      doc.addRoom(roomLabel, false);
      syncRoom();
    });
    button("Copy", 128, 140, 60, [this] {
      doc.addRoom(roomLabel, true);
      syncRoom();
    });
    button("Rename", 196, 140, 88, [this] {
      doc.renameRoom(roomLabel);
      syncRoom();
    });
    input(roomName, 16, 178, 184, 2);
    button("Set name", 208, 178, 76, [this] {
      doc.checkpoint();
      doc.room()["name"] = roomName;
    });
    button("Delete room", 16, 216, 128, [this] {
      if (confirm("Delete room", "Delete this room? This can be undone.")) {
        doc.deleteRoom();
        syncRoom();
      }
    });
    button("Clear room", 152, 216, 132, [this] {
      if (confirm("Clear room", "Remove all terrain, entities and regions? "
                                "This can be undone.")) {
        doc.checkpoint();
        auto &r = doc.room();
        r["tiles"] = Json::array();
        r["entities"] = Json::array();
        r["rainRegions"] = Json::array();
        r["shadowRegions"] = Json::array();
        r.erase("rainRegion");
        r.erase("rainTiles");
        refresh = true;
      }
    });
    button("Terrain", 16, 260, 84, [this] {
      category = 0;
      layer = "terrain";
      scroll = 0;
    });
    button("Objects", 108, 260, 84, [this] {
      category = 1;
      layer = "terrain";
      scroll = 0;
    });
    button("Regions", 200, 260, 84, [this] {
      category = 2;
      choose("rain");
      scroll = 0;
    });
    std::vector<std::pair<std::string, std::string>> palette;
    if (category == 0)
      palette = {{"Stone", "floor"},       {"Grass", "grass"},
                 {"Wall", "wall"},         {"Forest wall", "forest-wall"},
                 {"Doorway", "doorway"},   {"Void", "void"},
                 {"Fill bucket", "fill"},  {"Erase", "erase"},
                 {"Select/move", "select"}};
    if (category == 1) {
      palette = {{"Select/move", "select"},
                 {"Erase", "erase"},
                 {"Player", "player"},
                 {"Hellhound", "hellhound"},
                 {"Bat", "bat"},
                 {"Spider", "spider"},
                 {"Snake", "snake"},
                 {"Exit", "portal-exit"},
                 {"Gate", "gate"},
                 {"Gate button", "gate-button"},
                 {"Garg. statue", "gargoyle"},
                 {"Angel statue", "angel-statue"},
                 {"Spider statue", "spider-statue"},
                 {"Wall spider", "spider-wall-statue"},
                 {"Torch", "torch"},
                 {"Boulder", "boulder"},
                 {"Purple gem", "purple-gem"},
                 {"Plate", "pressure-plate"}};
      for (int i = 1; i <= 8; ++i)
        palette.push_back(
            {"Rock " + std::to_string(i), "rock-" + std::to_string(i)});
      for (int i = 1; i <= 3; ++i)
        palette.push_back({"Dead tree " + std::to_string(i),
                           "dead-tree-" + std::to_string(i)});
    }
    if (category == 2)
      palette = {{"Rain region", "rain"},
                 {"Shadow region", "shadow"},
                 {"Erase region", "erase"}};
    int rows = std::max(1, (renderer.windowH - 530) / 34),
        maxScroll = std::max(0, int((palette.size() + 1) / 2) - rows);
    scroll = std::clamp(scroll, 0, maxScroll);
    for (int i = scroll * 2;
         i < std::min(int(palette.size()), (scroll + rows) * 2); ++i) {
      auto [name, t] = palette[i];
      button(
          name, 16 + (i % 2) * 138, 302 + (i / 2 - scroll) * 34, 130,
          [this, t] { choose(t); }, tool == t);
    }
    int bottom = renderer.windowH - 210;
    label(category == 1 ? "Wheel here: more objects" : "Tool: " + tool, 16,
          bottom);
    label("Facing: " + std::to_string(int(std::round(facing * 180 / pi))) +
              " deg",
          16, bottom + 26);
    button("Rotate [Q]", 168, bottom + 20, 116, [this] { rotate(); });
    label("Link / exit room:", 16, bottom + 60);
    input(link, 200, bottom + 54, 40, 3);
    button("Apply link", 16, bottom + 92, 128, [this] {
      if (auto e = selection()) {
        if (!EditorDocument::validLabel(link))
          throw std::runtime_error("Link must be A-Z or 0-9");
        doc.checkpoint();
        (*e)["label"] = link;
        refresh = true;
      }
    });
    button("Delete [Del]", 152, bottom + 92, 132, [this] { deleteSelected(); });
    auto e = selection();
    label(e ? e->value("type", "") + " selected" : "Layer: " + layer, 16,
          bottom + 132);
    rectangle({300, renderer.windowH - 36, renderer.windowW - 300, 36},
              {23, 28, 32, 255});
    label(status.substr(0, size_t(std::max(1, (renderer.windowW - 320) / 8))),
          312, renderer.windowH - 26);
    SDL_SetWindowTitle(window, ("Wolf Dungeon - C++ Level Editor" +
                                std::string(doc.dirty() ? " *" : ""))
                                   .c_str());
    renderer.presentFrame();
  }
  void cycleRoom(int direction) {
    std::vector<std::string> names;
    for (const auto &[k, v] : doc.project["rooms"].items()) {
      (void)v;
      names.push_back(k);
    }
    auto it = std::find(names.begin(), names.end(), doc.active());
    int i = int(it - names.begin());
    doc.project["activeRoom"] =
        names[(i + direction + names.size()) % names.size()];
    syncRoom();
  }
  void rotate() {
    facing = std::fmod(facing + pi / 4, 2 * pi);
    if (auto e = selection()) {
      doc.checkpoint();
      (*e)["facing"] = facing;
      refresh = true;
    }
  }
  void deleteSelected() {
    if (auto e = selection()) {
      doc.checkpoint();
      int x = int(std::floor((*e)["x"].get<double>())),
          y = int(std::floor((*e)["y"].get<double>()));
      doc.eraseEntity(x, y);
      selected.clear();
      refresh = true;
    }
  }
  void event(const SDL_Event &e) {
    if (e.type == SDL_QUIT) {
      if (discard())
        running = false;
      return;
    }
    if (e.type == SDL_WINDOWEVENT) {
      if (e.window.event == SDL_WINDOWEVENT_SIZE_CHANGED)
        renderer.resize(e.window.data1, e.window.data2);
      if (e.window.event == SDL_WINDOWEVENT_FOCUS_LOST)
        dragging = panning = false;
    }
    if (e.type == SDL_MOUSEMOTION) {
      mx = e.motion.x;
      my = e.motion.y;
    }
    if (playing) {
      if (e.type == SDL_MOUSEBUTTONDOWN && e.button.button == SDL_BUTTON_LEFT &&
          e.button.y < 40 && e.button.x >= renderer.windowW / 2 - 160 &&
          e.button.x <= renderer.windowW / 2 + 160) {
        playing = false;
        refresh = true;
        return;
      }
      if (e.type == SDL_KEYDOWN && !e.key.repeat) {
        auto k = e.key.keysym.sym;
        if (k == SDLK_ESCAPE || k == SDLK_F5) {
          playing = false;
          refresh = true;
          message("Returned to editor. Play changes were discarded.");
        }
        if (k == SDLK_SPACE)
          scene.attack();
        if (k == SDLK_e)
          scene.eat();
        if (k == SDLK_r)
          scene.restart();
        if (k == SDLK_F2)
          renderer.scanlines = !renderer.scanlines;
        if (k == SDLK_F3) {
          renderer.width = renderer.width == 640   ? 960
                           : renderer.width == 960 ? 320
                           : renderer.width == 320 ? 480
                                                   : 640;
          renderer.resize(renderer.windowW, renderer.windowH);
        }
      }
      if (e.type == SDL_MOUSEBUTTONDOWN) {
        if (e.button.button == SDL_BUTTON_LEFT) {
          if (e.button.y < 48 && e.button.x > renderer.windowW - 210)
            renderer.scanlines = !renderer.scanlines;
          else
            scene.attack();
        }
        if (e.button.button == SDL_BUTTON_RIGHT)
          panning = true;
      }
      if (e.type == SDL_MOUSEBUTTONUP)
        panning = false;
      if (e.type == SDL_MOUSEMOTION && panning) {
        renderer.yaw -= e.motion.xrel * .006;
        renderer.angle =
            std::clamp(renderer.angle + e.motion.yrel * .003, .1, pi / 4);
      }
      if (e.type == SDL_MOUSEWHEEL)
        renderer.distance = std::clamp(
            renderer.distance * std::exp(-e.wheel.y * .1), 260.0, 1400.0);
      return;
    }
    if (e.type == SDL_TEXTINPUT && field) {
      auto &s = field == 1 ? roomLabel : field == 2 ? roomName : link;
      if (field == 2) {
        if (s.size() < 20)
          s += e.text.text;
      } else {
        char c = char(std::toupper(static_cast<unsigned char>(e.text.text[0])));
        if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
          s = std::string(1, c);
      }
      return;
    }
    if (e.type == SDL_KEYDOWN) {
      auto k = e.key.keysym.sym;
      bool ctrl = (e.key.keysym.mod & KMOD_CTRL) != 0;
      if (field) {
        auto &s = field == 1 ? roomLabel : field == 2 ? roomName : link;
        if (k == SDLK_BACKSPACE && !s.empty())
          s.pop_back();
        if (k == SDLK_RETURN || k == SDLK_ESCAPE) {
          field = 0;
          SDL_StopTextInput();
        }
        return;
      }
      if (e.key.repeat)
        return;
      if (ctrl && k == SDLK_s)
        save();
      else if (ctrl && k == SDLK_o)
        open();
      else if (ctrl && (k == SDLK_z || k == SDLK_y)) {
        if (k == SDLK_y || (e.key.keysym.mod & KMOD_SHIFT))
          doc.redo();
        else
          doc.undo();
        syncRoom();
      } else if (k == SDLK_F5)
        startPlay();
      else if (k == SDLK_TAB)
        perspective = !perspective;
      else if (k == SDLK_q)
        rotate();
      else if (k == SDLK_DELETE)
        deleteSelected();
      else if (k == SDLK_ESCAPE) {
        selected.clear();
        choose("select");
      }
    }
    if (e.type == SDL_MOUSEWHEEL) {
      if (mx < 300 && my >= 302) {
        scroll -= e.wheel.y;
        return;
      }
      if (inCanvas(mx, my)) {
        if (perspective)
          renderer.distance = std::clamp(
              renderer.distance * std::exp(-e.wheel.y * .1), 260.0, 5000.0);
        else {
          auto before = worldAt(mx, my);
          zoom = std::clamp(zoom * std::exp(e.wheel.y * .15), 2.0, 90.0);
          center = center + before - worldAt(mx, my);
        }
      }
      return;
    }
    if (e.type == SDL_MOUSEBUTTONDOWN) {
      mx = e.button.x;
      my = e.button.y;
      if (e.button.button == SDL_BUTTON_LEFT) {
        for (auto &b : buttons)
          if (mx >= b.rect.x && mx < b.rect.x + b.rect.w && my >= b.rect.y &&
              my < b.rect.y + b.rect.h) {
            auto fn = b.action;
            field = 0;
            fn();
            return;
          }
      }
      field = 0;
      SDL_StopTextInput();
      if (!inCanvas(mx, my))
        return;
      if (e.button.button == SDL_BUTTON_RIGHT ||
          e.button.button == SDL_BUTTON_MIDDLE) {
        panning = true;
        return;
      }
      if (e.button.button != SDL_BUTTON_LEFT)
        return;
      auto p = worldAt(mx, my);
      startX = int(std::floor(p.x));
      startY = int(std::floor(p.y));
      if (!doc.inside(startX, startY))
        return;
      doc.checkpoint();
      dragging = true;
      lastX = lastY = -1;
      if (tool == "select") {
        selected.clear();
        for (auto &e : doc.room()["entities"])
          if (EditorDocument::at(e, startX, startY)) {
            selected = e["id"];
            facing = e.value("facing", 0.0);
            link = e.value("label", link);
            break;
          }
      } else if (tool != "rain" && tool != "shadow") {
        stroke(startX, startY);
        if (tool == "fill")
          dragging = false;
      }
    }
    if (e.type == SDL_MOUSEMOTION) {
      if (panning) {
        if (perspective && (SDL_GetModState() & KMOD_SHIFT)) {
          renderer.yaw -= e.motion.xrel * .006;
          renderer.angle =
              std::clamp(renderer.angle + e.motion.yrel * .003, .1, pi / 4);
        } else if (perspective) {
          center = center - renderer.right * (e.motion.xrel * .03) +
                   renderer.forward * (e.motion.yrel * .03);
        } else
          center = center - Point{e.motion.xrel / zoom, e.motion.yrel / zoom};
      }
      if (dragging && inCanvas(mx, my) && tool != "select" && tool != "rain" &&
          tool != "shadow") {
        auto p = worldAt(mx, my);
        int x = int(std::floor(p.x)), y = int(std::floor(p.y));
        if (doc.inside(x, y))
          stroke(x, y);
      }
    }
    if (e.type == SDL_MOUSEBUTTONUP) {
      if (e.button.button == SDL_BUTTON_RIGHT ||
          e.button.button == SDL_BUTTON_MIDDLE)
        panning = false;
      if (e.button.button == SDL_BUTTON_LEFT && dragging) {
        auto p = worldAt(e.button.x, e.button.y);
        int x = int(std::floor(p.x)), y = int(std::floor(p.y));
        if (inCanvas(e.button.x, e.button.y) && doc.inside(x, y)) {
          if (tool == "rain" || tool == "shadow")
            doc.region(startX, startY, x, y, tool == "rain", false);
          if (tool == "select")
            if (auto ent = selection()) {
              bool occupied = false;
              for (const auto &other : doc.room()["entities"])
                if (other["id"] != selected && EditorDocument::at(other, x, y))
                  occupied = true;
              if (!occupied && doc.tile(x, y) != "wall" &&
                  doc.tile(x, y) != "forest-wall") {
                (*ent)["x"] = x;
                (*ent)["y"] = y;
              }
            }
          refresh = true;
        }
        dragging = false;
      }
    }
  }
  void update(double dt) {
    fpsSeconds += dt;
    ++fpsFrames;
    if (fpsSeconds >= .5) {
      renderer.fps = fpsFrames / fpsSeconds;
      fpsSeconds = 0;
      fpsFrames = 0;
    }
    if (!playing)
      return;
    const auto *k = SDL_GetKeyboardState(nullptr);
    Point f{-std::sin(renderer.yaw), -std::cos(renderer.yaw)},
        r{std::cos(renderer.yaw), -std::sin(renderer.yaw)};
    Point input = f * (int(k[SDL_SCANCODE_W] || k[SDL_SCANCODE_UP]) -
                       int(k[SDL_SCANCODE_S] || k[SDL_SCANCODE_DOWN])) +
                  r * (int(k[SDL_SCANCODE_D] || k[SDL_SCANCODE_RIGHT]) -
                       int(k[SDL_SCANCODE_A] || k[SDL_SCANCODE_LEFT]));
    if (!(SDL_GetWindowFlags(window) & SDL_WINDOW_INPUT_FOCUS))
      input = {};
    scene.update(dt, input, k[SDL_SCANCODE_LSHIFT] || k[SDL_SCANCODE_RSHIFT]);
  }
};

void editorSelfTest() {
  auto require = [](bool ok, const char *s) {
    if (!ok)
      throw std::runtime_error(s);
  };
  EditorDocument d;
  d.project = {{"version", 1},
               {"activeRoom", "A"},
               {"custom", "preserve"},
               {"rooms", {{"A", EditorDocument::blank()}}}};
  d.saved = d.project;
  d.room()["width"] = 8;
  d.room()["height"] = 8;
  d.checkpoint();
  d.paint(2, 2, "grass");
  d.paint(3, 2, "wall");
  d.place(1, 1, "player", 0, "");
  d.place(6, 6, "bat", 0, "");
  Json authored = d.project;
  d.undo();
  require(d.room()["tiles"].empty(), "Stroke undo failed");
  d.redo();
  require(d.project == authored, "Redo failed");
  d.fill(0, 0, "floor");
  require(d.tile(7, 7) == "floor" && d.tile(3, 2) == "wall" &&
              d.tile(2, 2) == "grass",
          "Flood fill crossed boundary");
  d.region(2, 2, 4, 3, true, false);
  require(d.preview(false).room.rain[3 * 8 + 4], "Rain region missing");
  d.region(3, 2, 3, 2, true, true);
  require(d.room()["rainRegions"].empty(), "Region erasure failed");
  d.room()["rainTiles"] = Json::array({{{"x", 1}, {"y", 2}}});
  d.region(3, 3, 3, 3, true, false);
  require(d.preview(false).room.rain[2 * 8 + 1], "Legacy rain lost");
  d.addRoom("B", true);
  d.place(2, 2, "portal-exit", 0, "A");
  d.project["activeRoom"] = "A";
  d.renameRoom("C");
  require(d.project["rooms"]["B"]["entities"].back()["label"] == "C",
          "Rename lost room links");
  auto original = d.project;
  d.rotateRoom();
  d.rotateRoom();
  d.rotateRoom();
  d.rotateRoom();
  for (auto &r : d.project["rooms"])
    for (auto &e : r["entities"])
      if (e.contains("facing") && std::abs(e["facing"].get<double>()) < 1e-9)
        e["facing"] = 0;
  require(d.project == original,
          "Four map rotations did not preserve the room");
  auto play = d.preview(true);
  play.update(.05, {1, 0}, true);
  play.attack();
  require(d.project == original, "Play mutated authored room");
  fs::create_directories("work");
  auto file = fs::path("work") /
              ("editor-test-" + std::to_string(GetTickCount64()) + ".json");
  d.save(file);
  d.paint(4, 4, "grass");
  d.save(file);
  EditorDocument loaded;
  loaded.load(file);
  require(loaded.project == d.project, "JSON roundtrip failed");
  EditorDocument backup;
  backup.load(file.string() + ".bak");
  require(backup.project == original, "Save backup failed");
  require(loaded.project["custom"] == "preserve", "Unknown metadata lost");
  d.place(4, 4, "player", 0, "");
  int count = 0;
  for (const auto &e : d.room()["entities"])
    count += e["type"] == "player";
  require(count == 1, "Duplicate player spawn");
  d.paint(4, 4, "wall");
  require(!d.eraseEntity(4, 4), "Wall retained an entity");
  bool failed = false;
  try {
    d.preview(true);
  } catch (...) {
    failed = true;
  }
  require(failed, "Play accepted missing spawn");
  require(d.preview(false).room.width == 8,
          "Editor cannot preview empty spawn");
  std::cout << "PASS: editor paint/fill, undo/redo, regions, legacy rain, room "
               "links, isolated Play, JSON preservation and backup saves\n";
}

void editorUITest(NativeEditor &editor) {
  auto require = [](bool ok, const char *s) {
    if (!ok)
      throw std::runtime_error(s);
  };
  auto original = editor.doc;
  editor.doc.project = {{"version", 1},
                        {"activeRoom", "A"},
                        {"rooms", {{"A", EditorDocument::blank()}}}};
  editor.doc.room()["width"] = 12;
  editor.doc.room()["height"] = 12;
  editor.doc.place(5, 5, "player", 0, "");
  editor.doc.place(8, 8, "bat", 0, "");
  editor.doc.undoStack.clear();
  editor.doc.redoStack.clear();
  editor.syncRoom();
  editor.perspective = false;
  editor.zoom = 30;
  auto click = [&](int x, int y) {
    SDL_Event e{};
    e.type = SDL_MOUSEBUTTONDOWN;
    e.button.button = SDL_BUTTON_LEFT;
    e.button.x = x;
    e.button.y = y;
    editor.event(e);
    e.type = SDL_MOUSEBUTTONUP;
    editor.event(e);
  };
  auto key = [&](SDL_Keycode k, Uint16 mod = 0) {
    SDL_Event e{};
    e.type = SDL_KEYDOWN;
    e.key.keysym.sym = k;
    e.key.keysym.mod = mod;
    editor.event(e);
  };
  editor.draw();
  click(180, 315); // Grass palette button.
  auto cell = editor.screenAt({3.5, 3.5});
  click(int(cell.x), int(cell.y));
  require(editor.doc.tile(3, 3) == "grass", "Mouse painting failed");
  key(SDLK_z, KMOD_CTRL);
  require(editor.doc.tile(3, 3) == "void", "Ctrl-Z failed");
  key(SDLK_y, KMOD_CTRL);
  require(editor.doc.tile(3, 3) == "grass", "Ctrl-Y failed");
  editor.draw();
  click(240, 274);
  editor.draw();
  click(50, 315); // Regions > Rain.
  auto a = editor.screenAt({2.5, 2.5}), b = editor.screenAt({4.5, 4.5});
  SDL_Event e{};
  e.type = SDL_MOUSEBUTTONDOWN;
  e.button.button = SDL_BUTTON_LEFT;
  e.button.x = int(a.x);
  e.button.y = int(a.y);
  editor.event(e);
  e.type = SDL_MOUSEBUTTONUP;
  e.button.x = int(b.x);
  e.button.y = int(b.y);
  editor.event(e);
  require(editor.doc.preview(false).room.rain[4 * 12 + 4],
          "Mouse region drag failed");
  editor.choose("select");
  a = editor.screenAt({8.5, 8.5});
  b = editor.screenAt({9.5, 8.5});
  e.type = SDL_MOUSEBUTTONDOWN;
  e.button.x = int(a.x);
  e.button.y = int(a.y);
  editor.event(e);
  e.type = SDL_MOUSEBUTTONUP;
  e.button.x = int(b.x);
  e.button.y = int(b.y);
  editor.event(e);
  require(editor.selection() && (*editor.selection())["x"] == 9,
          "Entity move failed");
  key(SDLK_q);
  require(std::abs((*editor.selection())["facing"].get<double>() - pi / 4) <
              .001,
          "Entity facing failed");
  fs::create_directories("work");
  auto testPath =
      fs::absolute(fs::path("work") /
                   ("editor-ui-" + std::to_string(GetTickCount64()) + ".json"));
  editor.doc.path = testPath;
  key(SDLK_s, KMOD_CTRL);
  EditorDocument reload;
  reload.load(testPath);
  require(reload.project == editor.doc.project, "UI save did not roundtrip");
  auto before = editor.doc.project;
  key(SDLK_F5);
  require(editor.playing, "F5 Play failed");
  editor.scene.update(.05, {1, 0}, false);
  key(SDLK_ESCAPE);
  require(!editor.playing && editor.doc.project == before,
          "Play changed authored data");
  editor.doc = original;
  editor.syncRoom();
  editor.category = 0;
  editor.choose("select");
  editor.perspective = false;
  editor.renderer.capturePath = "work/editor-map.png";
  editor.draw();
  editor.perspective = true;
  editor.renderer.capturePath = "work/editor-preview.png";
  editor.draw();
  // Inverse projection must pick the same tile that is highlighted in 3D.
  auto p = editor.center + Point{1, 1};
  auto screen = editor.screenAt(p);
  auto picked = editor.worldAt(int(screen.x), int(screen.y));
  require(length(p - picked) < .1, "3D picking projection mismatch");
  key(SDLK_F5);
  editor.renderer.capturePath = "work/editor-play.png";
  editor.draw();
  key(SDLK_ESCAPE);
  require(editor.doc.project == original.project,
          "UI test altered real project");
  std::cout << "PASS: native UI painting, undo/redo, region drag, entity "
               "move/facing, save/reload, Play/return and 3D picking\n";
}

void runEditor(SDL_Window *window, Renderer &renderer, const fs::path &project,
               const std::string &room, int frames,
               const std::string &screenshot, bool test = false) {
  NativeEditor editor(window, renderer, project, room);
  if (test)
    editorUITest(editor);
  uint64_t last = SDL_GetPerformanceCounter();
  int count = 0;
  while (editor.running) {
    auto now = SDL_GetPerformanceCounter();
    double dt =
        std::min(.05, double(now - last) / SDL_GetPerformanceFrequency());
    last = now;
    SDL_Event e;
    while (SDL_PollEvent(&e))
      editor.guarded([&] { editor.event(e); });
    editor.guarded([&] { editor.update(dt); });
    editor.draw();
    if (frames && ++count >= frames)
      break;
    if (!editor.playing && !editor.perspective)
      SDL_Delay(8);
  }
  if (!screenshot.empty()) {
    renderer.capturePath = screenshot;
    editor.draw();
  }
  std::cout << "Native editor closed; project " << editor.doc.path.string()
            << "; "
            << (editor.doc.dirty() ? "unsaved changes" : "unchanged/saved")
            << '\n';
}
