#pragma once
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <map>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <vector>

namespace native {
using Json = nlohmann::json;
constexpr double pi = 3.14159265358979323846, tileSize = 90;
struct Point {
  double x = 0, y = 0;
  Point operator+(Point b) const { return {x + b.x, y + b.y}; }
  Point operator-(Point b) const { return {x - b.x, y - b.y}; }
  Point operator*(double v) const { return {x * v, y * v}; }
};
inline double length(Point p) { return std::hypot(p.x, p.y); }
inline Point unit(Point p) {
  double d = length(p);
  return d > 1e-8 ? p * (1 / d) : Point{};
}
struct Entity {
  std::string id, type, label;
  Point pos, spawn;
  Point patrolCenter;
  double patrolPhase = 0;
  double facing = 0, health = 100, maxHealth = 100, cooldown = 0, altitude = 0;
  bool enemy = false, dead = false, eaten = false, aggro = false,
       moving = false, vertical = false;
};
struct Room {
  int width = 0, height = 0;
  std::vector<unsigned char> tiles, shadows, rain;
  std::vector<Entity> entities;
  Point spawn;
  double facing = 0;
  unsigned char at(int x, int y) const {
    return x < 0 || y < 0 || x >= width || y >= height ? 0
                                                       : tiles[y * width + x];
  }
  bool blocked(Point p) const {
    int x = int(std::floor(p.x / tileSize)),
        y = int(std::floor(p.y / tileSize));
    return x < 0 || y < 0 || x >= width || y >= height || at(x, y) >= 3;
  }
  bool maskAt(const std::vector<unsigned char> &mask, Point p) const {
    int x = int(std::floor(p.x / tileSize)),
        y = int(std::floor(p.y / tileSize));
    return x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x];
  }
};
inline Room parseRoom(const Json &j) {
  Room r;
  r.width = j.at("width").get<int>();
  r.height = j.at("height").get<int>();
  if (r.width < 1 || r.height < 1 || r.width > 1000 || r.height > 1000)
    throw std::runtime_error("Invalid room dimensions");
  r.tiles.resize(r.width * r.height);
  r.shadows.resize(r.tiles.size());
  r.rain.resize(r.tiles.size());
  for (const auto &t : j.at("tiles")) {
    int x = t.at("x"), y = t.at("y");
    if (x < 0 || y < 0 || x >= r.width || y >= r.height)
      continue;
    std::string type = t.at("type");
    r.tiles[y * r.width + x] = type == "wall"          ? 3
                               : type == "forest-wall" ? 4
                               : type == "grass"       ? 2
                                                       : 1;
  }
  auto regions = [&](const Json &values, std::vector<unsigned char> &mask) {
    for (const auto &v : values) {
      int x = v.at("x"), y = v.at("y"), w = v.at("width"), h = v.at("height");
      for (int yy = std::max(0, y); yy < std::min(r.height, y + h); ++yy)
        for (int xx = std::max(0, x); xx < std::min(r.width, x + w); ++xx)
          mask[yy * r.width + xx] = 1;
    }
  };
  regions(j.value("shadowRegions", Json::array()), r.shadows);
  regions(j.value("rainRegions", Json::array()), r.rain);
  if (j.contains("rainRegion") && !j["rainRegion"].is_null())
    regions(Json::array({j["rainRegion"]}), r.rain);
  for (const auto &t : j.value("rainTiles", Json::array())) {
    int x = t.at("x"), y = t.at("y");
    if (x >= 0 && y >= 0 && x < r.width && y < r.height)
      r.rain[y * r.width + x] = 1;
  }
  bool foundPlayer = false;
  for (const auto &v : j.at("entities")) {
    Entity e;
    e.id = v.at("id");
    e.type = v.at("type");
    e.label = v.value("label", "");
    e.pos = {(v.at("x").get<double>() + .5) * tileSize,
             (v.at("y").get<double>() + .5) * tileSize};
    e.spawn = e.pos;
    e.facing = v.value("facing", 0.0);
    if (e.type == "player") {
      r.spawn = e.pos;
      r.facing = e.facing;
      foundPlayer = true;
      continue;
    }
    e.enemy = e.type == "hellhound" || e.type == "bat" || e.type == "spider" ||
              e.type == "snake";
    e.health = e.maxHealth = e.type == "bat"         ? 80
                             : e.type == "hellhound" ? 150
                             : e.type == "gargoyle"  ? 250
                                                     : 100;
    if (e.type == "bat") {
      e.altitude = 126;
      e.moving = true;
      e.patrolPhase = e.facing;
      // Start on the orbit at the authored spawn, without teleporting to it.
      e.patrolCenter =
          e.spawn -
          Point{std::cos(e.patrolPhase), std::sin(e.patrolPhase)} * 120;
    }
    r.entities.push_back(e);
  }
  if (!foundPlayer)
    throw std::runtime_error("Room needs a player spawn");
  for (auto &e : r.entities)
    if (e.type == "gate") {
      int x = int(e.pos.x / tileSize), y = int(e.pos.y / tileSize);
      int vertical = 0, horizontal = 0;
      for (const auto &other : r.entities)
        if (other.type == "gate" && other.label == e.label) {
          vertical += std::abs(other.pos.x - e.pos.x) < 1 &&
                      std::abs(other.pos.y - e.pos.y) > 1;
          horizontal += std::abs(other.pos.y - e.pos.y) < 1 &&
                        std::abs(other.pos.x - e.pos.x) > 1;
        }
      e.vertical = vertical != horizontal
                       ? vertical > horizontal
                       : (r.at(x, y - 1) >= 3 || r.at(x, y + 1) >= 3);
    }
  return r;
}

struct BloodDrop {
  Point pos, velocity;
  double height = 0, verticalSpeed = 0, age = 0, size = 1;
  bool purple = false;
};

struct Game {
  Json project;
  Room room;
  std::string roomName;
  Point player, heading{1, 0};
  double health = 100, attackTimer = 0, eatTimer = 0, time = 0;
  int kills = 0, deaths = 0;
  bool moving = false, running = false;
  std::map<std::string, bool> gates;
  std::map<std::string, bool> buttons;
  std::vector<BloodDrop> blood;
  uint32_t bloodRandom = 0x62b15;
  void spatter(Point at, double height, bool purple = false) {
    constexpr size_t burstSize = 80, limit = 640;
    if (blood.size() + burstSize > limit)
      blood.erase(blood.begin(),
                  blood.begin() + (blood.size() + burstSize - limit));
    auto random = [&]() {
      bloodRandom ^= bloodRandom << 13;
      bloodRandom ^= bloodRandom >> 17;
      bloodRandom ^= bloodRandom << 5;
      return double(bloodRandom) / 4294967296.0;
    };
    for (size_t i = 0; i < burstSize; ++i) {
      double angle = random() * 2 * pi, speed = 24 + random() * 90;
      blood.push_back({at,
                       {std::cos(angle) * speed, std::sin(angle) * speed},
                       height,
                       60 + random() * 180,
                       0,
                       .6 + random() * .9,
                       purple});
    }
  }
  void load(const std::string &filename, const std::string &selected = "") {
    std::ifstream file(filename);
    if (!file)
      throw std::runtime_error("Cannot open project: " + filename);
    file >> project;
    if (!project.contains("rooms"))
      project = Json{{"activeRoom", "A"}, {"rooms", {{"A", project}}}};
    enter(selected.empty() ? project.value("activeRoom", std::string("A"))
                           : selected);
  }
  void enter(const std::string &label) {
    if (!project["rooms"].contains(label))
      throw std::runtime_error("Unknown destination room: " + label);
    Room next = parseRoom(project["rooms"][label]);
    room = std::move(next);
    roomName = label;
    player = room.spawn;
    heading = {std::cos(room.facing), std::sin(room.facing)};
    gates.clear();
    buttons.clear();
    blood.clear();
    for (const auto &e : room.entities)
      if (e.type == "gate")
        gates[e.label] = true;
    kills = 0;
    attackTimer = eatTimer = 0;
  }
  bool gateClosed(const Entity &e) const {
    auto it = gates.find(e.label);
    return it != gates.end() && it->second;
  }
  bool clear(Point from, Point to, double radius = 10) const {
    for (Point offset : {Point{0, 0}, Point{radius, 0}, Point{-radius, 0},
                         Point{0, radius}, Point{0, -radius}})
      if (room.blocked(to + offset))
        return false;
    for (const auto &e : room.entities) {
      if (e.type == "gate" && gateClosed(e)) {
        double a = e.vertical ? from.x : from.y, b = e.vertical ? to.x : to.y,
               plane = e.vertical ? e.pos.x : e.pos.y;
        if (std::abs(b - a) > 1e-9) {
          double t = (plane - a) / (b - a),
                 across = e.vertical ? from.y + (to.y - from.y) * t
                                     : from.x + (to.x - from.x) * t;
          if (t >= 0 && t <= 1 &&
              std::abs(across - (e.vertical ? e.pos.y : e.pos.x)) <=
                  45 + radius)
            return false;
        }
      }
      if (e.type == "boulder" || e.type.rfind("rock-", 0) == 0 ||
          e.type == "spider-statue" || e.type == "spider-wall-statue") {
        if (length(to - e.pos) < radius + 24 &&
            length(to - e.pos) < length(from - e.pos))
          return false;
      }
    }
    return true;
  }
  Point move(Point from, Point delta, double radius = 10) const {
    const int steps = std::max(1, int(std::ceil(length(delta) / 8)));
    delta = delta * (1.0 / steps);
    for (int i = 0; i < steps; ++i) {
      Point p{from.x + delta.x, from.y};
      if (clear(from, p, radius))
        from = p;
      p = {from.x, from.y + delta.y};
      if (clear(from, p, radius))
        from = p;
    }
    return from;
  }
  bool lineClear(Point from, Point to) const {
    int n = std::max(1, int(length(to - from) / 15));
    for (int i = 1; i <= n; ++i)
      if (room.blocked(from + (to - from) * (double(i) / n)))
        return false;
    return true;
  }
  void attack() {
    if (health <= 0 || attackTimer > 0 || eatTimer > 0)
      return;
    attackTimer = .6;
    Entity *target = nullptr;
    double nearest = 160;
    for (auto &e : room.entities)
      if (e.enemy && !e.dead) {
        Point d = e.pos - player;
        double gap = length(d);
        Point dir = unit(d);
        if (gap < nearest &&
            dir.x * heading.x + dir.y * heading.y > std::cos(35 * pi / 180) &&
            e.altitude < 100 && lineClear(player, e.pos)) {
          nearest = gap;
          target = &e;
        }
      }
    if (target) {
      spatter(target->pos,
              target->altitude + (target->type == "spider" ? 14 : 36),
              target->type == "spider");
      target->health -= 25;
      target->aggro = true;
      if (target->health <= 0) {
        target->dead = true;
        target->altitude = 0;
        ++kills;
      }
    }
  }
  void eat() {
    if (health <= 0 || eatTimer > 0)
      return;
    for (auto &e : room.entities)
      if (e.dead && !e.eaten && e.type != "gargoyle" &&
          length(e.pos - player) < 100) {
        e.eaten = true;
        health = std::min(100.0, health + 30);
        eatTimer = 1;
        break;
      }
  }
  void update(double dt, Point input, bool sprint) {
    time += dt;
    for (auto &drop : blood) {
      drop.age += dt;
      drop.pos = drop.pos + drop.velocity * dt;
      drop.height =
          std::max(1.0, drop.height + drop.verticalSpeed * dt - 600 * dt * dt);
      drop.verticalSpeed -= 1200 * dt;
    }
    std::erase_if(blood, [](const BloodDrop &drop) { return drop.age >= .35; });
    attackTimer = std::max(0.0, attackTimer - dt);
    eatTimer = std::max(0.0, eatTimer - dt);
    moving = false;
    running = sprint;
    if (health <= 0)
      return;
    if (length(input) > .01 && eatTimer <= 0) {
      heading = unit(input);
      Point before = player;
      player = move(player, heading * (300 * (sprint ? 1.6 : 1) * dt));
      moving = length(player - before) > .01;
    }
    for (auto &e : room.entities) {
      if (e.type == "gate-button") {
        bool on = length(player - e.pos) < 35;
        if (on && !buttons[e.id])
          gates[e.label] = !gates[e.label];
        buttons[e.id] = on;
      }
      if (e.type == "portal-exit" && length(player - e.pos) < 28 &&
          !e.label.empty()) {
        std::string next = e.label;
        enter(next);
        return;
      }
      if (!e.enemy || e.dead)
        continue;
      e.cooldown = std::max(0.0, e.cooldown - dt);
      Point d = player - e.pos;
      double distance = length(d);
      e.moving = false;
      if (distance < 420 && lineClear(e.pos, player))
        e.aggro = true;
      if (!e.aggro && e.type == "bat") {
        e.patrolPhase += dt * .72;
        Point target =
            e.patrolCenter +
            Point{std::cos(e.patrolPhase), std::sin(e.patrolPhase)} * 120;
        Point before = e.pos;
        Point travel = target - e.pos;
        e.pos =
            move(e.pos, unit(travel) * std::min(length(travel), 100 * dt), 12);
        Point actual = e.pos - before;
        if (length(actual) > .001)
          e.facing = std::atan2(actual.y, actual.x);
        e.altitude = 126 + std::sin(e.patrolPhase * 4) * 12;
        e.moving = true;
        continue;
      }
      if (!e.aggro)
        continue;
      e.facing = std::atan2(d.y, d.x);
      if (e.type == "bat")
        e.altitude = distance < 170 ? 45 : 110 + std::sin(time * 4) * 12;
      if (distance > 65) {
        Point before = e.pos;
        e.pos = move(e.pos, unit(d) * (e.type == "bat" ? 240 : 140) * dt, 12);
        e.moving = length(e.pos - before) > .01;
      } else if (e.cooldown <= 0) {
        spatter(player, 30);
        health = std::max(0.0, health - 8);
        e.cooldown = 1;
        if (health <= 0) {
          ++deaths;
          break;
        }
      }
    }
  }
  void restart() {
    health = 100;
    enter(roomName);
  }
};
} // namespace native
