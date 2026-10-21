#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <queue>
#include <set>
#include <windows.h>

// Keep the authored JSON as the source of truth, including unknown fields.
struct EditorDocument {
  Json project, saved;
  fs::path path;
  std::vector<Json> undoStack, redoStack;
  std::string active() const {
    return project.at("activeRoom").get<std::string>();
  }
  Json &room() { return project["rooms"][active()]; }
  const Json &room() const { return project.at("rooms").at(active()); }
  static Json blank() {
    return {{"version", 1},
            {"name", "Untitled room"},
            {"width", 100},
            {"height", 100},
            {"tiles", Json::array()},
            {"entities", Json::array()},
            {"rainRegions", Json::array()},
            {"shadowRegions", Json::array()}};
  }
  static bool validLabel(const std::string &s) {
    return s.size() == 1 &&
           ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= '0' && s[0] <= '9'));
  }
  static void validate(const Json &p) {
    if (!p.contains("rooms") || !p["rooms"].is_object() || p["rooms"].empty())
      throw std::runtime_error("Project needs at least one room");
    for (const auto &[key, r] : p["rooms"].items()) {
      (void)key;
      Json test = r;
      if (!test.at("tiles").is_array() || !test.at("entities").is_array())
        throw std::runtime_error("Tiles and entities must be arrays");
      // Empty rooms are valid editor documents. Gameplay still requires a
      // spawn.
      test["entities"].push_back({{"id", "editor-validation"},
                                  {"type", "player"},
                                  {"x", 0},
                                  {"y", 0}});
      parseRoom(test);
    }
    if (!p["rooms"].contains(p.at("activeRoom").get<std::string>()))
      throw std::runtime_error("Active room does not exist");
  }
  void load(const fs::path &file) {
    std::ifstream in(file);
    if (!in)
      throw std::runtime_error("Cannot open project");
    Json next;
    in >> next;
    if (!next.contains("rooms"))
      next = {{"version", 1}, {"activeRoom", "A"}, {"rooms", {{"A", next}}}};
    if (!next.contains("activeRoom") && next.contains("rooms") &&
        !next["rooms"].empty())
      next["activeRoom"] = next["rooms"].begin().key();
    validate(next);
    project = std::move(next);
    saved = project;
    path = fs::absolute(file);
    undoStack.clear();
    redoStack.clear();
  }
  bool dirty() const { return project != saved; }
  void checkpoint() {
    if (undoStack.empty() || undoStack.back() != project) {
      undoStack.push_back(project);
      if (undoStack.size() > 48)
        undoStack.erase(undoStack.begin());
    }
    redoStack.clear();
  }
  void undo() {
    if (undoStack.empty())
      return;
    redoStack.push_back(project);
    project = std::move(undoStack.back());
    undoStack.pop_back();
  }
  void redo() {
    if (redoStack.empty())
      return;
    undoStack.push_back(project);
    project = std::move(redoStack.back());
    redoStack.pop_back();
  }
  void save(const fs::path &destination, bool adopt = true) {
    validate(project);
    auto target = fs::absolute(destination);
    auto temp = target;
    temp += ".tmp";
    auto backup = target;
    backup += ".bak";
    {
      std::ofstream out(temp, std::ios::binary | std::ios::trunc);
      if (!out || !(out << project.dump(2) << '\n') || !out.flush())
        throw std::runtime_error(
            "Could not write project; original save is unchanged");
    }
    if (fs::exists(target))
      fs::copy_file(target, backup, fs::copy_options::overwrite_existing);
    if (!MoveFileExW(temp.c_str(), target.c_str(),
                     MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
      throw std::runtime_error("Could not replace project; original save and "
                               "temporary file retained");
    if (adopt) {
      path = target;
      saved = project;
    }
  }
  bool inside(int x, int y) const {
    return x >= 0 && y >= 0 && x < room()["width"].get<int>() &&
           y < room()["height"].get<int>();
  }
  static bool at(const Json &v, int x, int y) {
    return int(std::floor(v.at("x").get<double>())) == x &&
           int(std::floor(v.at("y").get<double>())) == y;
  }
  std::string tile(int x, int y) const {
    for (const auto &t : room()["tiles"])
      if (at(t, x, y))
        return t["type"].get<std::string>();
    return "void";
  }
  void paint(int x, int y, const std::string &type) {
    if (!inside(x, y))
      return;
    auto &ts = room()["tiles"];
    ts.erase(std::remove_if(ts.begin(), ts.end(),
                            [&](const Json &t) { return at(t, x, y); }),
             ts.end());
    if (type != "void")
      ts.push_back({{"x", x}, {"y", y}, {"type", type}});
    if (type == "wall" || type == "forest-wall" || type == "void")
      eraseEntity(x, y);
  }
  bool eraseEntity(int x, int y) {
    auto &es = room()["entities"];
    auto n = es.size();
    es.erase(std::remove_if(es.begin(), es.end(),
                            [&](const Json &e) { return at(e, x, y); }),
             es.end());
    return n != es.size();
  }
  void fill(int x, int y, const std::string &type) {
    if (!inside(x, y))
      return;
    int w = room()["width"], h = room()["height"];
    std::vector<std::string> grid(w * h, "void");
    for (const auto &t : room()["tiles"]) {
      int a = t["x"], b = t["y"];
      if (inside(a, b))
        grid[b * w + a] = t["type"];
    }
    auto old = grid[y * w + x];
    if (old == type)
      return;
    std::queue<std::pair<int, int>> q;
    q.push({x, y});
    grid[y * w + x] = type;
    std::set<std::pair<int, int>> changed;
    while (!q.empty()) {
      auto [a, b] = q.front();
      q.pop();
      changed.insert({a, b});
      for (auto [dx, dy] : {std::pair{1, 0}, {-1, 0}, {0, 1}, {0, -1}})
        if (inside(a + dx, b + dy) && grid[(b + dy) * w + a + dx] == old) {
          grid[(b + dy) * w + a + dx] = type;
          q.push({a + dx, b + dy});
        }
    }
    auto &ts = room()["tiles"];
    ts.erase(std::remove_if(ts.begin(), ts.end(),
                            [&](const Json &t) {
                              return changed.contains({t["x"], t["y"]});
                            }),
             ts.end());
    if (type != "void")
      for (auto [a, b] : changed)
        ts.push_back({{"x", a}, {"y", b}, {"type", type}});
    if (type == "wall" || type == "forest-wall" || type == "void") {
      auto &es = room()["entities"];
      es.erase(std::remove_if(es.begin(), es.end(),
                              [&](const Json &e) {
                                return changed.contains(
                                    {int(std::floor(e["x"].get<double>())),
                                     int(std::floor(e["y"].get<double>()))});
                              }),
               es.end());
    }
  }
  std::string place(int x, int y, const std::string &type, double facing,
                    const std::string &link) {
    if (!inside(x, y))
      return "";
    if ((type == "gate" || type == "gate-button" || type == "portal-exit") &&
        !validLabel(link))
      throw std::runtime_error("Use one A-Z or 0-9 link label");
    auto &es = room()["entities"];
    es.erase(std::remove_if(es.begin(), es.end(),
                            [&](const Json &e) {
                              return at(e, x, y) || ((type == "player" ||
                                                      type == "portal-exit") &&
                                                     e["type"] == type);
                            }),
             es.end());
    auto ground = tile(x, y);
    if (ground == "void" || ground == "wall" || ground == "forest-wall")
      paint(x, y, "floor");
    static uint64_t serial = 0;
    std::string id = "native-" + std::to_string(GetTickCount64()) + "-" +
                     std::to_string(++serial);
    Json e = {
        {"id", id}, {"type", type}, {"x", x}, {"y", y}, {"facing", facing}};
    if (type == "gate" || type == "gate-button" || type == "portal-exit")
      e["label"] = link;
    es.push_back(e);
    return id;
  }
  void region(int x, int y, int endX, int endY, bool rain, bool erase) {
    auto key = rain ? "rainRegions" : "shadowRegions";
    // Normalize legacy rain data only when the rain layer is edited.
    if (!room().contains(key))
      room()[key] = Json::array();
    auto &rs = room()[key];
    if (rain) {
      if (room().contains("rainRegion") && !room()["rainRegion"].is_null())
        rs.push_back(room()["rainRegion"]);
      for (const auto &t : room().value("rainTiles", Json::array()))
        rs.push_back(
            {{"x", t["x"]}, {"y", t["y"]}, {"width", 1}, {"height", 1}});
      room().erase("rainRegion");
      room().erase("rainTiles");
    }
    if (erase)
      rs.erase(std::remove_if(rs.begin(), rs.end(),
                              [&](const Json &r) {
                                int a = r["x"], b = r["y"];
                                return x >= a && y >= b &&
                                       x < a + r["width"].get<int>() &&
                                       y < b + r["height"].get<int>();
                              }),
               rs.end());
    else if (inside(x, y) && inside(endX, endY))
      rs.push_back({{"x", std::min(x, endX)},
                    {"y", std::min(y, endY)},
                    {"width", std::abs(x - endX) + 1},
                    {"height", std::abs(y - endY) + 1}});
  }
  void addRoom(const std::string &label, bool copy) {
    if (!validLabel(label) || project["rooms"].contains(label))
      throw std::runtime_error("Choose an unused room label A-Z or 0-9");
    Json r = copy ? room() : blank();
    checkpoint();
    project["rooms"][label] = r;
    project["activeRoom"] = label;
  }
  void rotateRoom() {
    checkpoint();
    int w = room()["width"], h = room()["height"];
    auto cell = [&](Json &v) {
      auto x = v.at("x"), y = v.at("y");
      v["x"] = h - 1 - y.get<double>();
      v["y"] = x;
    };
    auto rect = [&](Json &v) {
      int x = v["x"], y = v["y"], rw = v["width"], rh = v["height"];
      v["x"] = h - y - rh;
      v["y"] = x;
      v["width"] = rh;
      v["height"] = rw;
    };
    for (auto &t : room()["tiles"])
      cell(t);
    for (auto &e : room()["entities"]) {
      cell(e);
      e["facing"] = std::fmod(e.value("facing", 0.0) + pi / 2, 2 * pi);
    }
    for (const auto *key : {"rainRegions", "shadowRegions"})
      if (room().contains(key))
        for (auto &r : room()[key])
          rect(r);
    if (room().contains("rainRegion") && !room()["rainRegion"].is_null())
      rect(room()["rainRegion"]);
    if (room().contains("rainTiles"))
      for (auto &t : room()["rainTiles"])
        cell(t);
    room()["width"] = h;
    room()["height"] = w;
  }
  void renameRoom(const std::string &label) {
    if (label == active())
      return;
    if (!validLabel(label) || project["rooms"].contains(label))
      throw std::runtime_error("Choose an unused room label A-Z or 0-9");
    checkpoint();
    auto old = active();
    project["rooms"][label] = room();
    project["rooms"].erase(old);
    project["activeRoom"] = label;
    for (auto &r : project["rooms"])
      for (auto &e : r["entities"])
        if (e["type"] == "portal-exit" && e.value("label", "") == old)
          e["label"] = label;
  }
  void deleteRoom() {
    if (project["rooms"].size() < 2)
      throw std::runtime_error("Keep at least one room");
    auto old = active();
    for (const auto &[label, r] : project["rooms"].items())
      if (label != old)
        for (const auto &e : r["entities"])
          if (e["type"] == "portal-exit" && e.value("label", "") == old)
            throw std::runtime_error(
                "Remove exits linking to this room before deleting it");
    checkpoint();
    project["rooms"].erase(old);
    project["activeRoom"] = project["rooms"].begin().key();
  }
  Game preview(bool play) const {
    Game g;
    g.project = project;
    if (!play) {
      auto &es = g.project["rooms"][active()]["entities"];
      if (std::none_of(es.begin(), es.end(),
                       [](const Json &e) { return e["type"] == "player"; }))
        es.push_back(
            {{"id", "preview-spawn"}, {"type", "player"}, {"x", 0}, {"y", 0}});
    } else {
      for (const auto &[key, r] : project["rooms"].items()) {
        (void)key;
        parseRoom(r);
        for (const auto &e : r["entities"])
          if (e["type"] == "portal-exit" &&
              !project["rooms"].contains(e.value("label", "")))
            throw std::runtime_error("An exit links to a missing room");
      }
    }
    g.enter(active());
    return g;
  }
};
