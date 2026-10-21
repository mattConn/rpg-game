#define SDL_MAIN_HANDLED
#include "native_game.hpp"
#include <SDL.h>
#include <SDL_image.h>
#include <SDL_ttf.h>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <memory>
#include <numeric>
#include <sstream>

namespace fs = std::filesystem;
using namespace native;
constexpr double fov = .4663076581549986, wallHeight = 336;
using Color = uint32_t;
Color rgb(int r, int g, int b) {
  return 0xff000000u | (uint32_t(std::clamp(b, 0, 255)) << 16) |
         (uint32_t(std::clamp(g, 0, 255)) << 8) |
         uint32_t(std::clamp(r, 0, 255));
}
Color shade(Color c, double l) {
  return rgb(int((c & 255) * l), int(((c >> 8) & 255) * l),
             int(((c >> 16) & 255) * l));
}
struct Image {
  int width = 0, height = 0;
  std::vector<Color> pixels;
  double span = 120, center = 30;
  Color at(int x, int y) const {
    return x >= 0 && y >= 0 && x < width && y < height ? pixels[y * width + x]
                                                       : 0;
  }
};
Image loadImage(const fs::path &path) {
  SDL_Surface *raw = IMG_Load(path.string().c_str());
  if (!raw)
    throw std::runtime_error("Image " + path.string() + ": " + IMG_GetError());
  SDL_Surface *surface =
      SDL_ConvertSurfaceFormat(raw, SDL_PIXELFORMAT_ABGR8888, 0);
  SDL_FreeSurface(raw);
  if (!surface)
    throw std::runtime_error(SDL_GetError());
  Image image;
  image.width = surface->w;
  image.height = surface->h;
  image.pixels.resize(image.width * image.height);
  for (int y = 0; y < image.height; ++y)
    std::copy_n(
        reinterpret_cast<Color *>(
            static_cast<unsigned char *>(surface->pixels) + y * surface->pitch),
        image.width, image.pixels.data() + y * image.width);
  SDL_FreeSurface(surface);
  return image;
}
struct Renderer {
  SDL_Renderer *output = nullptr;
  SDL_Texture *frame = nullptr;
  SDL_Texture *scanlineTexture = nullptr;
  TTF_Font *font = nullptr;
  struct Label {
    SDL_Texture *texture;
    int width, height;
  };
  std::map<std::string, Label> labels;
  int width = 640, height = 400, windowW = 1280, windowH = 800;
  double yaw = -pi / 4, angle = pi / 6, distance = 600, focal = 1, horizon = 0,
         eye = 0, renderMs = 0;
  Point camera, forward, right;
  std::vector<Color> pixels;
  std::vector<double> depths, gateDepths;
  std::vector<unsigned char> gateMask;
  std::map<std::string, Image> images;
  bool scanlines = true;
  double fps = 0;
  explicit Renderer(SDL_Window *window, const fs::path &assets) {
    output = SDL_CreateRenderer(
        window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!output)
      throw std::runtime_error(SDL_GetError());
    SDL_RendererInfo info{};
    SDL_GetRendererInfo(output, &info);
    std::cout << "SDL renderer: " << info.name << '\n';
    images["floor"] =
        loadImage(assets / "graphics/med/textures/dungeon-floor-stone.png");
    images["wall"] =
        loadImage(assets / "graphics/med/textures/dungeon-wall-stone.png");
    images["forest-wall"] = loadImage(assets / "textures/forest-wall.png");
    images["gate"] = loadImage(assets / "textures/gate-weathered-iron.png");
    std::ifstream metaFile(assets.parent_path() /
                           "src/client/sprite-metadata.ts");
    std::string text((std::istreambuf_iterator<char>(metaFile)), {});
    auto first = text.find('{'), last = text.rfind('}');
    if (first == std::string::npos)
      throw std::runtime_error("Sprite metadata missing");
    Json metadata = Json::parse(text.substr(first, last - first + 1));
    for (auto it = metadata.begin(); it != metadata.end(); ++it) {
      Image image = loadImage(assets / "sprites" / (it.key() + ".png"));
      image.span = it.value().at("span");
      image.center = it.value().at("center");
      images.emplace(it.key(), std::move(image));
    }
    Image grass;
    grass.width = grass.height = 64;
    grass.pixels.resize(4096);
    uint32_t random = 0x6a55;
    for (auto &p : grass.pixels) {
      random ^= random << 13;
      random ^= random >> 17;
      random ^= random << 5;
      int v = int(random % 28);
      p = rgb(39 + v, 53 + v, 29 + v / 2);
    }
    images["grass"] = std::move(grass);
    for (const auto &path :
         {fs::path("C:/Windows/Fonts/consola.ttf"),
          fs::path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")})
      if (fs::exists(path)) {
        font = TTF_OpenFont(path.string().c_str(), 16);
        if (font)
          break;
      }
    resize(windowW, windowH);
  }
  ~Renderer() {
    for (auto &[key, label] : labels)
      SDL_DestroyTexture(label.texture);
    if (font)
      TTF_CloseFont(font);
    if (scanlineTexture)
      SDL_DestroyTexture(scanlineTexture);
    if (frame)
      SDL_DestroyTexture(frame);
    if (output)
      SDL_DestroyRenderer(output);
  }
  void resize(int w, int h) {
    windowW = std::max(1, w);
    windowH = std::max(1, h);
    height = std::max(1, int(double(width) * windowH / windowW));
    pixels.resize(width * height);
    depths.resize(width);
    gateDepths.resize(width);
    gateMask.resize(width * height);
    if (frame)
      SDL_DestroyTexture(frame);
    frame = SDL_CreateTexture(output, SDL_PIXELFORMAT_ABGR8888,
                              SDL_TEXTUREACCESS_STREAMING, width, height);
    if (!frame)
      throw std::runtime_error(SDL_GetError());
    if (scanlineTexture)
      SDL_DestroyTexture(scanlineTexture);
    scanlineTexture = SDL_CreateTexture(output, SDL_PIXELFORMAT_ABGR8888,
                                        SDL_TEXTUREACCESS_STATIC, 1, windowH);
    std::vector<Color> lines(windowH);
    for (int y = 0; y < windowH; ++y)
      lines[y] = y % 4 >= 2 ? 0x3c000000u : 0;
    SDL_UpdateTexture(scanlineTexture, nullptr, lines.data(), 4);
    SDL_SetTextureBlendMode(scanlineTexture, SDL_BLENDMODE_BLEND);
  }
  struct Hit {
    double depth = 6000;
    Point pos;
    int side = 0, material = 0;
  };
  Hit cast(const Room &room, Point ray) const {
    int col = int(std::floor(camera.x / tileSize)),
        row = int(std::floor(camera.y / tileSize));
    int sx = ray.x < 0 ? -1 : 1, sy = ray.y < 0 ? -1 : 1;
    double dx = std::abs(tileSize / ray.x), dy = std::abs(tileSize / ray.y);
    double tx =
        ray.x == 0 ? 1e30 : ((col + (sx > 0)) * tileSize - camera.x) / ray.x;
    double ty =
        ray.y == 0 ? 1e30 : ((row + (sy > 0)) * tileSize - camera.y) / ray.y;
    bool wasFloor = room.at(col, row) < 3;
    Hit hit;
    for (int i = 0; i < 220; ++i) {
      double d;
      int side;
      if (tx < ty) {
        d = tx;
        tx += dx;
        col += sx;
        side = 0;
      } else {
        d = ty;
        ty += dy;
        row += sy;
        side = 1;
      }
      if (d >= 6000)
        break;
      int material = room.at(col, row);
      bool floor = material < 3;
      if (wasFloor && !floor) {
        Point p = camera + ray * d, focus = camera + forward * distance;
        bool near =
            side ? (p.y - focus.y) * ray.y < 0 : (p.x - focus.x) * ray.x < 0;
        if (!near) {
          hit = {d, p, side, material};
          break;
        }
      }
      wasFloor = floor;
    }
    return hit;
  }
  void floor(const Game &game) {
    const auto &room = game.room;
    const auto &stone = images.at("floor");
    const auto &grass = images.at("grass");
    for (int y = std::max(0, int(horizon) + 1); y < height; ++y) {
      double depth = eye * focal / (y - horizon);
      if (depth >= 6000)
        continue;
      double fog = std::clamp(
          (depth - distance - 2400) / (6000 - distance - 2400), 0.0, 1.0);
      double light =
          std::clamp(1.05 - std::max(0.0, depth - distance) / 5000, .35, .9) *
          (1 - fog * fog * (3 - 2 * fog));
      Point p = camera + (forward - right * fov) * depth,
            step = right * (2 * depth * fov / width);
      for (int x = 0; x < width; ++x, p = p + step) {
        int tx = int(std::floor(p.x / 90)), ty = int(std::floor(p.y / 90));
        int material = room.at(tx, ty);
        if (material < 1 || material > 2)
          continue;
        const Image &tex = material == 2 ? grass : stone;
        int u = int(std::floor(p.x / 90 * tex.width)) & (tex.width - 1),
            v = int(std::floor(p.y / 90 * tex.height)) & (tex.height - 1);
        double shadow = room.shadows[ty * room.width + tx] ? .52 : 1;
        pixels[y * width + x] = shade(tex.at(u, v), light * shadow);
      }
    }
  }
  void walls(const Game &game) {
    for (int x = 0; x < width; ++x) {
      Point ray = forward + right * ((2 * (x + .5) / width - 1) * fov);
      Hit hit = cast(game.room, ray);
      depths[x] = hit.depth;
      if (hit.depth >= 6000)
        continue;
      double top = horizon + (eye - wallHeight) * focal / hit.depth,
             bottom = horizon + eye * focal / hit.depth;
      const Image &tex = images.at(hit.material == 4 ? "forest-wall" : "wall");
      double along = hit.side ? hit.pos.x : hit.pos.y;
      double u = along / 90 - std::floor(along / 90);
      int tx = std::min(tex.width - 1, int(u * tex.width));
      double light =
          std::clamp(1.15 - std::max(0.0, hit.depth - distance) / 5500, .4,
                     1.0) *
          (hit.side ? .75 : 1);
      for (int y = std::max(0, int(top));
           y < std::min(height, int(std::ceil(bottom))); ++y) {
        double v = (y - top) / (bottom - top);
        int ty = hit.material == 4
                     ? std::clamp(int(v * tex.height), 0, tex.height - 1)
                     : int(std::max(0.0, v * wallHeight / 90 * tex.height)) &
                           (tex.height - 1);
        pixels[y * width + x] = shade(tex.at(tx, ty), light);
      }
    }
  }
  struct Sprite {
    Point pos;
    std::string image;
    double scale = 1, altitude = 0, facing = 0, depth = 0;
    int frame = 0;
    bool player = false, anchored = false;
  };
  void billboard(const Game &game, const Sprite &s) {
    auto found = images.find(s.image);
    if (found == images.end())
      return;
    const auto &image = found->second;
    double depth = s.player ? std::max(120.0, s.depth) : s.depth;
    if (depth < 4 || depth > 6000)
      return;
    Point d = s.pos - camera;
    double size = image.span * s.scale * focal / depth,
           left = width * .5 + (d.x * right.x + d.y * right.y) * focal / depth -
                  size * .5;
    double z = image.center * s.scale + s.altitude,
           top = horizon + (eye - z) * focal / depth - size * .5;
    int direction =
        (int(std::round(
             (std::atan2(camera.y - s.pos.y, camera.x - s.pos.x) - s.facing) /
             (pi / 4))) %
             8 +
         8) %
        8;
    int frameSize = image.width / 8,
        animation =
            std::clamp(s.frame, 0, std::max(0, image.height / frameSize - 1));
    if (s.anchored) {
      int bottom = frameSize;
      bool done = false;
      for (int y = frameSize - 1; y >= 0 && !done; --y)
        for (int x = 0; x < frameSize; ++x)
          if ((image.at(direction * frameSize + x, y) >> 24) > 100) {
            bottom = y + 1;
            done = true;
            break;
          }
      top = horizon + (eye - s.altitude) * focal / depth -
            double(bottom) / frameSize * size;
    }
    double light =
        std::clamp(1.2 - std::max(0.0, depth - distance) / 5000, .45, 1.15) *
        (game.room.maskAt(game.room.shadows, s.pos) ? .52 : 1);
    if (s.image.rfind("dead-tree-", 0) == 0)
      light *= .72;
    for (int x = std::max(0, int(left));
         x < std::min(width, int(std::ceil(left + size))); ++x) {
      if (!s.player && depth > depths[x])
        continue;
      int sx = direction * frameSize +
               std::clamp(int((x - left) / size * frameSize), 0, frameSize - 1);
      for (int y = std::max(0, int(top));
           y < std::min(height, int(std::ceil(top + size))); ++y) {
        if (s.depth > gateDepths[x] && gateMask[y * width + x])
          continue;
        int sy =
            animation * frameSize +
            std::clamp(int((y - top) / size * frameSize), 0, frameSize - 1);
        Color c = image.at(sx, sy);
        if ((c >> 24) > 100)
          pixels[y * width + x] = shade(c, light);
      }
    }
  }
  void actors(const Game &game) {
    std::vector<Sprite> list;
    auto add = [&](Point pos, std::string image, double facing,
                   int animation = 0, double scale = 1, double altitude = 0,
                   bool player = false, bool anchored = false) {
      Point d = pos - camera;
      double depth = d.x * forward.x + d.y * forward.y;
      if (depth > 0 && length(pos - (camera + forward * distance)) < 3000)
        list.push_back({pos, std::move(image), scale, altitude, facing, depth,
                        animation, player, anchored});
    };
    for (const auto &e : game.room.entities) {
      if (e.eaten)
        continue;
      std::string image = e.type;
      double scale = 1, altitude = e.altitude;
      bool anchored = false;
      if (e.enemy) {
        if (e.dead)
          image += "-dead";
        else if (e.type == "snake" && e.cooldown > .5)
          image = "snake-attack";
      } else if (e.type == "gate" || e.type == "gate-button" ||
                 e.type == "pressure-plate" || e.type == "portal-exit" ||
                 e.type == "torch")
        continue;
      else if (e.type == "purple-gem")
        image = "gem";
      else if (e.type == "angel-statue") {
        image = "angel";
        scale = 1.5;
      } else if (e.type.rfind("rock-", 0) == 0) {
        image = "boulder";
        scale = e.type.back() < '5' ? .72 : 1.08;
        anchored = true;
      } else if (e.type == "boulder")
        anchored = true;
      else if (e.type.rfind("dead-tree-", 0) == 0) {
        scale = 2;
        anchored = true;
      } else if (e.type == "spider-statue" || e.type == "spider-wall-statue") {
        add(e.pos, "spider-pedestal", e.facing, 0, 1, 0, false, true);
        scale = e.type == "spider-statue" ? 3 : 2;
        altitude = 34.5;
        anchored = e.type == "spider-wall-statue";
      }
      int animation = !e.dead && (e.moving || e.type == "bat")
                          ? 1 + int(game.time / .13) % 3
                          : 0;
      add(e.pos, image, e.facing, animation, scale, altitude, false, anchored);
    }
    std::string player = game.health <= 0         ? "player-dead"
                         : game.eatTimer > 0      ? "player-eat"
                         : game.attackTimer > .28 ? "player-bite"
                                                  : "player";
    int animation =
        player == "player" ? (game.moving ? 1 + int(game.time / .13) % 3 : 0)
        : player == "player-bite"
            ? std::min(7, int((.6 - game.attackTimer) / .32 * 8))
        : player == "player-eat" ? std::min(7, int((1 - game.eatTimer) * 8))
                                 : 0;
    add(game.player, player, std::atan2(game.heading.y, game.heading.x),
        animation, 1, 0, true);
    std::sort(list.begin(), list.end(), [](const Sprite &a, const Sprite &b) {
      return a.depth > b.depth;
    });
    for (const auto &s : list)
      billboard(game, s);
  }
  void gates(const Game &game) {
    const auto &texture = images.at("gate");
    for (const auto &e : game.room.entities)
      if (e.type == "gate" && game.gateClosed(e)) {
        for (int x = 0; x < width; ++x) {
          Point ray = forward + right * ((2 * (x + .5) / width - 1) * fov);
          double axis = e.vertical ? ray.x : ray.y;
          if (std::abs(axis) < 1e-8)
            continue;
          double depth = ((e.vertical ? e.pos.x : e.pos.y) -
                          (e.vertical ? camera.x : camera.y)) /
                         axis;
          if (depth <= 0 || depth > depths[x])
            continue;
          Point hit = camera + ray * depth;
          double across = e.vertical ? hit.y - e.pos.y : hit.x - e.pos.x;
          if (std::abs(across) > 45)
            continue;
          double top = horizon + (eye - wallHeight) * focal / depth,
                 bottom = horizon + eye * focal / depth;
          int u = std::clamp(int((across + 45) / 90 * texture.width), 0,
                             texture.width - 1);
          gateDepths[x] = std::min(gateDepths[x], depth);
          for (int y = std::max(0, int(top));
               y < std::min(height, int(std::ceil(bottom))); ++y) {
            int v = std::clamp(int((y - top) / (bottom - top) * texture.height),
                               0, texture.height - 1);
            Color c = texture.at(u, v);
            if ((c >> 24) > 100) {
              pixels[y * width + x] = shade(c, .75);
              gateMask[y * width + x] = 1;
            }
          }
        }
      }
  }
  void markers(const Game &game) {
    for (const auto &e : game.room.entities)
      if (e.type == "portal-exit" || e.type == "gate-button") {
        Point d = e.pos - camera;
        double depth = d.x * forward.x + d.y * forward.y;
        if (depth < 4)
          continue;
        int cx = int(width * .5 +
                     (d.x * right.x + d.y * right.y) * focal / depth),
            cy = int(horizon + eye * focal / depth),
            r = std::max(
                2, int((e.type == "portal-exit" ? 38 : 14) * focal / depth));
        for (int y = std::max(0, cy - r / 2);
             y < std::min(height, cy + r / 2 + 1); ++y)
          for (int x = std::max(0, cx - r); x < std::min(width, cx + r + 1);
               ++x)
            if (depth < depths[x] &&
                ((x - cx) * (x - cx) + 4 * (y - cy) * (y - cy) < r * r))
              pixels[y * width + x] =
                  e.type == "portal-exit" ? rgb(38, 8, 65) : rgb(145, 85, 25);
      }
  }
  void text(const std::string &label, int x, int y,
            SDL_Color color = {230, 220, 196, 255}) {
    if (!font)
      return;
    auto it = labels.find(label);
    if (it == labels.end()) {
      if (labels.size() > 512) {
        for (auto &[key, cached] : labels)
          SDL_DestroyTexture(cached.texture);
        labels.clear();
      }
      SDL_Surface *surface = TTF_RenderUTF8_Blended(font, label.c_str(), color);
      if (!surface)
        return;
      Label cached{SDL_CreateTextureFromSurface(output, surface), surface->w,
                   surface->h};
      SDL_FreeSurface(surface);
      it = labels.emplace(label, cached).first;
    }
    SDL_Rect r{x, y, it->second.width, it->second.height};
    SDL_RenderCopy(output, it->second.texture, nullptr, &r);
  }
  void bloodSpatters(const Game &game) {
    for (const auto &drop : game.blood) {
      Point relative = drop.pos - camera;
      double depth = relative.x * forward.x + relative.y * forward.y;
      if (depth < 4 || depth > 6000)
        continue;
      double scale = focal / depth;
      int cx = int(width * .5 +
                   (relative.x * right.x + relative.y * right.y) * scale);
      int cy = int(horizon + (eye - drop.height) * scale);
      int radius = std::clamp(int(std::ceil(drop.size * scale)), 1, 3);
      double alpha = .9 * std::clamp((.35 - drop.age) / .12, 0.0, 1.0);
      Color color = drop.purple ? rgb(145, 24, 173) : rgb(185, 15, 29);
      for (int y = std::max(0, cy - radius); y < std::min(height, cy + radius);
           ++y)
        for (int x = std::max(0, cx - radius); x < std::min(width, cx + radius);
             ++x) {
          if (depth > depths[x] ||
              (depth > gateDepths[x] && gateMask[y * width + x]))
            continue;
          Color under = pixels[y * width + x];
          pixels[y * width + x] =
              rgb(int((under & 255) * (1 - alpha) + (color & 255) * alpha),
                  int(((under >> 8) & 255) * (1 - alpha) +
                      ((color >> 8) & 255) * alpha),
                  int(((under >> 16) & 255) * (1 - alpha) +
                      ((color >> 16) & 255) * alpha));
        }
    }
  }
  void render(const Game &game, bool editor = false, Point focus = {},
              bool present = true) {
    auto start = std::chrono::steady_clock::now();
    forward = {-std::sin(yaw), -std::cos(yaw)};
    right = {std::cos(yaw), -std::sin(yaw)};
    camera = (editor ? focus : game.player) - forward * distance;
    eye = distance * std::tan(angle) + 25;
    focal = width / (2 * fov);
    horizon = height * .58 - std::tan(angle) * focal;
    std::fill(pixels.begin(), pixels.end(), rgb(0, 0, 0));
    std::fill(gateDepths.begin(), gateDepths.end(), 1e30);
    std::fill(gateMask.begin(), gateMask.end(), 0);
    floor(game);
    walls(game);
    markers(game);
    gates(game);
    actors(game);
    bloodSpatters(game);
    SDL_UpdateTexture(frame, nullptr, pixels.data(), width * 4);
    SDL_RenderCopy(output, frame, nullptr, nullptr);
    if (scanlines)
      SDL_RenderCopy(output, scanlineTexture, nullptr, nullptr);
    if (editor)
      return;
    SDL_SetRenderDrawColor(output, 22, 20, 17, 255);
    SDL_Rect hud{12, 12, 220, 28};
    SDL_RenderFillRect(output, &hud);
    SDL_SetRenderDrawColor(output, 180, 45, 35, 255);
    SDL_Rect hp{16, 16, int(212 * game.health / 100), 20};
    SDL_RenderFillRect(output, &hp);
    text(std::to_string(int(game.health)) + "/100", 82, 17);
    text("Room " + game.roomName + " | Kills " + std::to_string(game.kills) +
             " | Deaths " + std::to_string(game.deaths),
         12, 48);
    SDL_Rect toggle{windowW - 205, 12, 193, 34};
    SDL_SetRenderDrawColor(output, 34, 29, 20, 255);
    SDL_RenderFillRect(output, &toggle);
    text(scanlines ? "Scanlines: On [F2]" : "Scanlines: Off [F2]",
         windowW - 198, 20);
    text(std::to_string(int(std::round(fps))) + " FPS | " +
             std::to_string(width) + "px [F3]",
         windowW - 205, 54);
    text("WASD move | Shift run | Click/Space bite | E eat | Drag orbit | "
         "Wheel zoom | R restart",
         12, windowH - 26);
    if (game.health <= 0)
      text("YOU DIED - press R to resurrect", windowW / 2 - 155, windowH / 2);
    renderMs = std::chrono::duration<double, std::milli>(
                   std::chrono::steady_clock::now() - start)
                   .count();
    if (present)
      presentFrame();
  }
  std::string capturePath;
  void presentFrame() {
    if (!capturePath.empty()) {
      screenshot(capturePath);
      capturePath.clear();
    }
    SDL_RenderPresent(output);
  }
  void screenshot(const std::string &path) {
    SDL_Surface *surface = SDL_CreateRGBSurfaceWithFormat(
        0, windowW, windowH, 32, SDL_PIXELFORMAT_ABGR8888);
    if (!surface)
      throw std::runtime_error(SDL_GetError());
    if (SDL_RenderReadPixels(output, nullptr, surface->format->format,
                             surface->pixels, surface->pitch) != 0) {
      SDL_FreeSurface(surface);
      throw std::runtime_error(SDL_GetError());
    }
    if (IMG_SavePNG(surface, path.c_str()) != 0) {
      SDL_FreeSurface(surface);
      throw std::runtime_error(IMG_GetError());
    }
    SDL_FreeSurface(surface);
  }
};

#include "native_editor.hpp"

void selfTest() {
  Json room = {{"width", 8},
               {"height", 8},
               {"tiles", Json::array({{{"x", 4}, {"y", 3}, {"type", "wall"}}})},
               {"entities", Json::array({{{"id", "p"},
                                          {"type", "player"},
                                          {"x", 3},
                                          {"y", 3},
                                          {"facing", 0}}})}};
  Game game;
  game.project = {{"rooms", {{"A", room}, {"B", room}}}};
  game.enter("A");
  Point before = game.player;
  game.update(.1, {-1, 0}, false);
  if (game.player.x >= before.x)
    throw std::runtime_error("Movement test failed");
  for (int i = 0; i < 60; ++i)
    game.update(1.0 / 60, {1, 0}, true);
  if (game.player.x >= 360)
    throw std::runtime_error("Wall collision test failed");
  Entity enemy;
  enemy.id = "hound";
  enemy.type = "hellhound";
  enemy.enemy = true;
  enemy.health = 25;
  enemy.pos = game.player + Point{-50, 0};
  game.room.entities.push_back(enemy);
  game.heading = {-1, 0};
  game.attack();
  if (!game.room.entities.back().dead || game.kills != 1)
    throw std::runtime_error("Combat test failed");
  if (game.blood.size() != 80 || game.blood.front().purple)
    throw std::runtime_error("Lethal enemy hit needs red blood");
  game.attack();
  if (game.blood.size() != 80)
    throw std::runtime_error("Attack cooldown duplicated blood");
  game.health = 50;
  game.eat();
  if (game.health != 80 || !game.room.entities.back().eaten)
    throw std::runtime_error("Eating test failed");
  game.enter("B");
  if (!game.blood.empty())
    throw std::runtime_error("Blood leaked into the next room");
  if (game.roomName != "B")
    throw std::runtime_error("Room loading test failed");
  Entity gate;
  gate.id = "gate";
  gate.type = "gate";
  gate.label = "G";
  gate.vertical = true;
  gate.pos = {270, 225};
  game.room.entities.push_back(gate);
  game.gates["G"] = true;
  if (game.clear({250, 225}, {290, 225}, 0))
    throw std::runtime_error("Closed gate collision test failed");
  Entity button;
  button.id = "button";
  button.type = "gate-button";
  button.label = "G";
  button.pos = game.player;
  game.room.entities.push_back(button);
  game.update(.01, {}, false);
  if (!game.clear({250, 225}, {290, 225}, 0))
    throw std::runtime_error("Button-linked gate test failed");
  game.update(.01, {}, false);
  if (game.gates["G"])
    throw std::runtime_error("Held button toggled twice");
  Entity portal;
  portal.id = "exit";
  portal.type = "portal-exit";
  portal.label = "A";
  portal.pos = game.player;
  game.room.entities.push_back(portal);
  game.update(.01, {}, false);
  if (game.roomName != "A")
    throw std::runtime_error("Portal transition test failed");
  Json patrolRoom = {
      {"width", 30},
      {"height", 30},
      {"tiles", Json::array()},
      {"entities",
       Json::array(
           {{{"id", "player"}, {"type", "player"}, {"x", 1}, {"y", 1}},
            {{"id", "statue"}, {"type", "gargoyle"}, {"x", 2}, {"y", 1}},
            {{"id", "bat"}, {"type", "bat"}, {"x", 20}, {"y", 20}}})}};
  Game patrol;
  patrol.project = {{"rooms", {{"A", patrolRoom}}}};
  patrol.enter("A");
  auto &statue = patrol.room.entities[0];
  auto &bat = patrol.room.entities[1];
  Point statueSpawn = statue.pos, batSpawn = bat.pos;
  double statueHealth = statue.health;
  if (statue.enemy || !bat.moving || bat.altitude <= 0)
    throw std::runtime_error("Statue/bat spawn classification failed");
  patrol.heading = {1, 0};
  patrol.attack();
  if (statue.health != statueHealth || statue.dead || patrol.kills != 0)
    throw std::runtime_error("Decorative gargoyle can be attacked");
  patrol.update(1.0 / 60, {}, false);
  if (length(bat.pos - batSpawn) <= .01 || bat.aggro || bat.altitude < 100)
    throw std::runtime_error(
        "Bat must patrol immediately without player aggro");
  for (int i = 0; i < 600; ++i) {
    Point before = bat.pos;
    patrol.update(1.0 / 60, {}, false);
    if (length(bat.pos - before) > 2 || patrol.room.blocked(bat.pos))
      throw std::runtime_error("Bat patrol teleported or crossed a wall");
  }
  if (length(statue.pos - statueSpawn) > .001 || statue.aggro ||
      patrol.health != 100)
    throw std::runtime_error("Gargoyle statue moved or attacked");
  patrol.player = bat.pos + Point{100, 0};
  patrol.update(1.0 / 60, {}, false);
  if (!bat.aggro)
    throw std::runtime_error("Patrolling bat cannot enter combat");
  bat.dead = true;
  Point deadPosition = bat.pos;
  patrol.update(.1, {}, false);
  if (length(bat.pos - deadPosition) > .001)
    throw std::runtime_error("Dead bat kept patrolling");
  patrol.restart();
  if (!patrol.room.entities[1].moving || patrol.room.entities[1].dead)
    throw std::runtime_error("Restarted bat did not spawn flying");
  Game impacts;
  impacts.project = {{"rooms", {{"A", room}}}};
  impacts.enter("A");
  impacts.attack();
  if (!impacts.blood.empty())
    throw std::runtime_error("Missed attacks must not create blood");
  impacts.attackTimer = 0;
  enemy.type = "spider";
  enemy.health = 100;
  enemy.pos = impacts.player + Point{-50, 0};
  impacts.room.entities.push_back(enemy);
  impacts.heading = {-1, 0};
  impacts.attack();
  if (impacts.blood.size() != 80 || !impacts.blood.front().purple)
    throw std::runtime_error("Spider hits need purple blood");
  Point firstDrop = impacts.blood.front().pos;
  impacts.update(.05, {}, false);
  if (impacts.health != 92 || impacts.blood.size() != 160 ||
      impacts.blood.back().purple)
    throw std::runtime_error("Player damage needs red blood");
  if (length(impacts.blood.front().pos - firstDrop) <= 0)
    throw std::runtime_error("Blood particles did not move");
  impacts.health = 0;
  impacts.update(.5, {}, false);
  if (!impacts.blood.empty())
    throw std::runtime_error("Blood must expire even after player death");
  for (int i = 0; i < 20; ++i)
    impacts.spatter(impacts.player, 30);
  if (impacts.blood.size() != 640)
    throw std::runtime_error("Blood particle limit failed");
  impacts.restart();
  if (!impacts.blood.empty())
    throw std::runtime_error("Restart did not clear blood");
  std::cout
      << "PASS: movement, walls, combat, eating, gates/buttons, and "
         "portal transitions; statues, bat patrol, and combat blood effects\n";
}
int main(int argc, char **argv) {
  try {
    fs::path assets = fs::path("../rpg-tactics/public"),
             project = fs::path("../rpg-tactics/data/editor-project.json");
    std::string room, screenshot;
    bool hidden = false, benchmark = false, editorTest = false;
    bool editor =
        fs::path(argv[0]).stem().string().find("editor") != std::string::npos;
    int frames = 0;
    for (int i = 1; i < argc; ++i) {
      std::string arg = argv[i];
      auto value = [&]() {
        if (i + 1 >= argc)
          throw std::runtime_error("Missing argument for " + arg);
        return std::string(argv[++i]);
      };
      if (arg == "--editor") {
        editor = true;
      } else if (arg == "--editor-ui-test") {
        editor = true;
        editorTest = true;
        hidden = true;
        frames = 3;
      } else if (arg == "--editor-self-test") {
        editorSelfTest();
        return 0;
      } else if (arg == "--self-test") {
        selfTest();
        return 0;
      } else if (arg == "--assets")
        assets = value();
      else if (arg == "--project")
        project = value();
      else if (arg == "--room")
        room = value();
      else if (arg == "--frames")
        frames = std::stoi(value());
      else if (arg == "--screenshot")
        screenshot = value();
      else if (arg == "--smoke-test") {
        hidden = true;
        frames = 3;
      } else if (arg == "--benchmark") {
        hidden = true;
        benchmark = true;
        frames = 300;
      } else
        throw std::runtime_error("Unknown argument: " + arg);
    }
    Game game;
    if (!editor)
      game.load(project.string(), room);
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0)
      throw std::runtime_error(SDL_GetError());
    if (!(IMG_Init(IMG_INIT_PNG) & IMG_INIT_PNG) || TTF_Init() != 0)
      throw std::runtime_error("Image/font initialization failed");
    SDL_Window *window = SDL_CreateWindow(
        "Wolf Dungeon - Native C++", SDL_WINDOWPOS_CENTERED,
        SDL_WINDOWPOS_CENTERED, 1280, 800,
        SDL_WINDOW_RESIZABLE | (hidden ? SDL_WINDOW_HIDDEN : SDL_WINDOW_SHOWN));
    if (!window)
      throw std::runtime_error(SDL_GetError());
    {
      Renderer renderer(window, assets);
      if (editor) {
        runEditor(window, renderer, project, room, frames, screenshot,
                  editorTest);
      } else {
        if (benchmark)
          SDL_RenderSetVSync(renderer.output, 0);
        bool running = true, drag = false, moved = false;
        int count = 0, fpsCount = 0;
        double fpsSeconds = 0, renderTotal = 0;
        uint64_t last = SDL_GetPerformanceCounter(), started = last;
        while (running) {
          uint64_t now = SDL_GetPerformanceCounter();
          double dt =
              std::min(.05, double(now - last) / SDL_GetPerformanceFrequency());
          last = now;
          SDL_Event event;
          while (SDL_PollEvent(&event)) {
            if (event.type == SDL_QUIT)
              running = false;
            else if (event.type == SDL_KEYDOWN && !event.key.repeat) {
              switch (event.key.keysym.sym) {
              case SDLK_ESCAPE:
                running = false;
                break;
              case SDLK_e:
                game.eat();
                break;
              case SDLK_SPACE:
                game.attack();
                break;
              case SDLK_r:
                game.restart();
                break;
              case SDLK_F2:
                renderer.scanlines = !renderer.scanlines;
                break;
              case SDLK_F3:
                renderer.width = renderer.width == 640   ? 960
                                 : renderer.width == 960 ? 320
                                 : renderer.width == 320 ? 480
                                                         : 640;
                renderer.resize(renderer.windowW, renderer.windowH);
                break;
              default:
                break;
              }
            } else if (event.type == SDL_WINDOWEVENT &&
                       event.window.event == SDL_WINDOWEVENT_SIZE_CHANGED)
              renderer.resize(event.window.data1, event.window.data2);
            else if (event.type == SDL_MOUSEBUTTONDOWN) {
              if (event.button.y < 48 &&
                  event.button.x > renderer.windowW - 210) {
                renderer.scanlines = !renderer.scanlines;
              } else {
                drag = true;
                moved = false;
              }
            } else if (event.type == SDL_MOUSEMOTION && drag) {
              moved |=
                  std::abs(event.motion.xrel) + std::abs(event.motion.yrel) > 1;
              renderer.yaw -= event.motion.xrel * .006;
              renderer.angle =
                  std::clamp(renderer.angle + event.motion.yrel * .003,
                             5 * pi / 180, pi / 4);
            } else if (event.type == SDL_MOUSEBUTTONUP) {
              if (drag && !moved && event.button.button == SDL_BUTTON_LEFT)
                game.attack();
              drag = false;
            } else if (event.type == SDL_MOUSEWHEEL)
              renderer.distance =
                  std::clamp(renderer.distance * std::exp(-event.wheel.y * .1),
                             260.0, 1400.0);
          }
          const Uint8 *keys = SDL_GetKeyboardState(nullptr);
          Point f{-std::sin(renderer.yaw), -std::cos(renderer.yaw)},
              r{std::cos(renderer.yaw), -std::sin(renderer.yaw)};
          Point input =
              f * (int(keys[SDL_SCANCODE_W] || keys[SDL_SCANCODE_UP]) -
                   int(keys[SDL_SCANCODE_S] || keys[SDL_SCANCODE_DOWN])) +
              r * (int(keys[SDL_SCANCODE_D] || keys[SDL_SCANCODE_RIGHT]) -
                   int(keys[SDL_SCANCODE_A] || keys[SDL_SCANCODE_LEFT]));
          if (!(SDL_GetWindowFlags(window) & SDL_WINDOW_INPUT_FOCUS) && !hidden)
            input = {};
          if (benchmark)
            input = r * (count % 120 < 60 ? 1 : -1);
          game.update(benchmark ? 1.0 / 60 : dt, input,
                      keys[SDL_SCANCODE_LSHIFT] || keys[SDL_SCANCODE_RSHIFT]);
          renderer.render(game);
          renderTotal += renderer.renderMs;
          ++count;
          ++fpsCount;
          fpsSeconds += dt;
          if (fpsSeconds >= .5) {
            renderer.fps = fpsCount / fpsSeconds;
            fpsCount = 0;
            fpsSeconds = 0;
          }
          if (frames && count >= frames)
            running = false;
        }
        if (!screenshot.empty()) {
          renderer.capturePath = screenshot;
          renderer.render(game);
        }
        double seconds = double(SDL_GetPerformanceCounter() - started) /
                         SDL_GetPerformanceFrequency();
        std::cout << "Frames: " << count
                  << "; measured FPS: " << count / seconds
                  << "; average render: " << renderTotal / std::max(1, count)
                  << " ms; room: " << game.roomName
                  << "; health: " << game.health << '\n';
      }
    }
    SDL_DestroyWindow(window);
    TTF_Quit();
    IMG_Quit();
    SDL_Quit();
    return 0;
  } catch (const std::exception &error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}
