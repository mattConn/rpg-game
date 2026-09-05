import { WORLD_HEIGHT } from '../../../src/shared/constants.js';
import { ARENA_X, ARENA_Y, TILE_PX, DUNGEON_PORTAL, PRESSURE_PLATES, ROOM_REGIONS, HALL_REGIONS, DUNGEON_ENEMIES, EDITOR_DUNGEON, regionCentre, type TacticsSnapshot } from '../shared/tactics.js';
import { RaycastWorld, castCameraRay, type RayHit } from './raycast-world.js';
import { playerBiteFrame } from './attack-presentation.js';
import { buildBarrierFrames, BARRIER_WIDTH, BARRIER_HEIGHT } from './barrier-texture.js';
import { SPRITE_META } from './sprite-metadata.js';
import { GRAPHICS_PRESETS, type GraphicsQuality } from './graphics.js';

// A narrower lens and distant, fixed-elevation camera give an overhead ARPG view.
const FOV = Math.tan(Math.PI * 50 / 360), WALL_HEIGHT = 168;
const CAMERA_YAW = -Math.PI / 4, CAMERA_ANGLE = Math.PI * 30 / 180;
const CAMERA_NEAR = 320, CAMERA_DEFAULT = 600, CAMERA_FAR = 1200;
const rgba = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const shade = (color: number, amount: number) => rgba(Math.min(255, (color & 255) * amount), Math.min(255, ((color >>> 8) & 255) * amount), Math.min(255, ((color >>> 16) & 255) * amount));
interface Pixels { width: number; height: number; data: Uint32Array; shades?: Uint32Array[]; bottomRows?: number[] }
interface Billboard { x: number; y: number; z: number; span: number; image: string; direction: number; frame: number; depth?: number }

/** Entire play view is Canvas2D: no WebGL context, mesh, light, or animation mixer. */
export class RaycastRenderer {
  readonly world = new RaycastWorld();
  yaw = CAMERA_YAW;
  private cameraAngle = CAMERA_ANGLE;
  private cameraDistance = CAMERA_DEFAULT;
  private width = 480; private height = 270; private viewWidth = 1600;
  private image!: ImageData; private pixels!: Uint32Array;
  private depths = new Float32Array(480);
  private wallVeils: { x: number; hit: RayHit }[] = [];
  private wallBottoms = new Float32Array(480);
  private cameraX = 0; private cameraY = 0; private eye = CAMERA_DEFAULT * Math.tan(CAMERA_ANGLE);
  private forwardX = 1; private forwardY = 0; private rightX = 0; private rightY = 1;
  private focal = 1; private horizon = 0;
  private readonly barrierFrames = buildBarrierFrames();
  private textures = new Map<string, Pixels>();
  private scenery: Billboard[] = [];
  private wallWebs: { side: number; plane: number; along: number; width: number }[] = [];
  private markers: Uint8Array;
  private markerKey = '';
  private readonly ctx: CanvasRenderingContext2D;
  readonly ready: Promise<void>;
  renderMs = 0;
  private eatingStartedAt: number | null = null;
  private spiderMotion = new Map<string, { x: number; y: number; altitude: number; movedAt: number; direction: number }>();
  private houndMotion = new Map<string, { x: number; y: number; movedAt: number }>();
  private previousPlayerX = NaN; private previousPlayerY = NaN;

  constructor(private readonly canvas: HTMLCanvasElement, private quality: GraphicsQuality) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.markers = new Uint8Array(this.world.grid.cells.length);
    this.proceduralSprites();
    // Spawn-room decoration persists after its spiders die. Sample it on wall
    // surfaces, so webs share the wall perspective and never float across doors.
    for (const index of new Set(DUNGEON_ENEMIES.filter(e => e.kind === 'spider').map(e => e.roomIndex))) {
      const room = ROOM_REGIONS[index]; if (!room) continue;
      const west = ARENA_X + room.col * TILE_PX, north = ARENA_Y + room.row * TILE_PX;
      const east = west + room.cols * TILE_PX, south = north + room.rows * TILE_PX;
      for (const plane of [north, south]) for (const along of [west + 100, east - 100])
        this.wallWebs.push({ side: 1, plane, along, width: 180 });
      for (const plane of [west, east]) for (const along of [north + 100, south - 100])
        this.wallWebs.push({ side: 0, plane, along, width: 180 });
    }
    const prop = (image: 'boulder' | 'angel', x: number, y: number, direction = 0) => {
      const meta = SPRITE_META[image];
      this.scenery.push({ x, y, z: meta.center - (image === 'boulder' ? 6 : 0), span: meta.span, image, direction: image === 'angel' ? (direction + 4) % 8 : direction, frame: 0 });
    };
    if (EDITOR_DUNGEON) {
      for (const entity of EDITOR_DUNGEON.entities) {
        if (entity.type === 'boulder' || entity.type === 'angel-statue')
          prop(entity.type === 'boulder' ? 'boulder' : 'angel', ARENA_X + (entity.x + .5) * 90, ARENA_Y + (entity.y + .5) * 90);
      }
    } else ROOM_REGIONS.forEach((room, i) => {
      prop('boulder', ARENA_X + (room.col + 2) * TILE_PX, ARENA_Y + (room.row + 2) * TILE_PX, i % 8);
      prop('boulder', ARENA_X + (room.col + room.cols - 2) * TILE_PX, ARENA_Y + (room.row + room.rows - 2) * TILE_PX, (i + 3) % 8);
      if (room.size === 'jumbo' && i !== DUNGEON_PORTAL.roomIndex) { const center = regionCentre(room); prop('angel', center.x, center.y); }
    });
    const size = GRAPHICS_PRESETS[quality].textureSize;
    this.ready = Promise.all([
      this.load('wall', `/graphics/${quality === 'high' || quality === 'max' ? 'med' : quality}/textures/dungeon-wall-stone.png`, size),
      this.load('floor', `/graphics/${quality === 'high' || quality === 'max' ? 'med' : quality}/textures/dungeon-floor-stone.png`, size),
      ...Object.keys(SPRITE_META).map(name => this.load(name, `/sprites/${name}.png`)),
    ]).then(() => undefined);
  }
  private async load(key: string, path: string, size?: number): Promise<void> {
    const img = new Image(); img.src = path;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size ?? img.width; canvas.height = size ?? img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = new Uint32Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
    const shades = size ? Array.from({ length: 24 }, (_, level) => data.map(pixel => shade(pixel, (level + 1) / 24))) : undefined;
    const bottomRows = key === 'boulder' ? Array.from({ length: 8 }, (_, direction) => {
      const frame = canvas.width / 8;
      for (let y = frame - 1; y >= 0; y--) for (let x = 0; x < frame; x++)
        if ((data[y * canvas.width + direction * frame + x]! >>> 24) > 100) return y + 1;
      return frame;
    }) : undefined;
    this.textures.set(key, { width: canvas.width, height: canvas.height, data, shades, bottomRows });
  }
  resize(w: number, h: number, viewWidth: number): void {
    this.viewWidth = viewWidth;
    this.width = Math.max(160, Math.min(GRAPHICS_PRESETS[this.quality].renderWidth, Math.round(w)));
    this.height = Math.max(120, Math.round(this.width * h / w));
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
    this.image = this.ctx.createImageData(this.width, this.height);
    this.pixels = new Uint32Array(this.image.data.buffer);
    this.depths = new Float32Array(this.width);
    this.wallBottoms = new Float32Array(this.width);
  }
  setQuality(quality: GraphicsQuality): void { this.quality = quality; }
  look(dx: number, dy: number): void {
    this.yaw -= dx * 4;
    this.cameraAngle = Math.max(Math.PI * 10 / 180, Math.min(CAMERA_ANGLE,
      this.cameraAngle - dy * 1.5));
  }
  zoom(delta: number): void {
    this.cameraDistance = Math.max(CAMERA_NEAR, Math.min(CAMERA_FAR, this.cameraDistance + Math.max(-120, Math.min(120, delta)) * .3));
  }
  flip(): void { this.yaw += Math.PI; }
  resetView(): void { this.yaw = CAMERA_YAW; this.cameraAngle = CAMERA_ANGLE; this.cameraDistance = CAMERA_DEFAULT; }

  private updateCamera(snap: TacticsSnapshot) {
    this.forwardX = -Math.sin(this.yaw); this.forwardY = -Math.cos(this.yaw);
    this.rightX = Math.cos(this.yaw); this.rightY = -Math.sin(this.yaw);
    // Camera freely passes through geometry; player collision remains server-controlled.
    const distance = this.cameraDistance;
    this.cameraX = snap.player.x - this.forwardX * distance;
    this.cameraY = snap.player.y - this.forwardY * distance;
    // Preserve the selected viewing angle across zoom levels.
    const slope = Math.tan(this.cameraAngle);
    this.eye = distance * slope + 25 - snap.dungeonPortal.fallProgress * 65;
    this.focal = this.width / (2 * FOV);
    this.horizon = this.height * .58 - slope * this.focal;
  }
  project(x: number, y: number, height: number): { x: number; y: number } {
    const dx = x - this.cameraX, dy = y - this.cameraY;
    const depth = dx * this.forwardX + dy * this.forwardY;
    if (depth < 1 || !this.isPointVisible(x, y)) return { x: -10000, y: -10000 };
    return { x: (this.width / 2 + (dx * this.rightX + dy * this.rightY) * this.focal / depth) / this.width * this.viewWidth,
      y: (this.horizon + (this.eye - height * 30) * this.focal / depth) / this.height * WORLD_HEIGHT };
  }
  isPointVisible(x: number, y: number): boolean {
    const dx = x - this.cameraX, dy = y - this.cameraY;
    const depth = dx * this.forwardX + dy * this.forwardY;
    if (depth < 1 || Math.abs(dx * this.rightX + dy * this.rightY) > depth * FOV) return false;
    const distance = Math.hypot(dx, dy);
    return castCameraRay(this.world.grid, this.cameraX, this.cameraY, dx / distance, dy / distance,
      this.world.gates, this.cameraDistance * distance / depth, distance + 1).distance >= distance - 2;
  }
  private updateMarkers(snap: TacticsSnapshot) {
    const key = snap.pressurePlates.map(p => +p.active).join('') + ':' + snap.spikeTrap?.active + ':' + snap.purpleGem.destroyed;
    if (key === this.markerKey) return; this.markerKey = key; this.markers.fill(0);
    const grid = this.world.grid;
    const mark = (x: number, y: number, radius: number, type: number) => {
      const c0 = Math.floor((x - radius - ARENA_X) / TILE_PX), c1 = Math.ceil((x + radius - ARENA_X) / TILE_PX);
      const r0 = Math.floor((y - radius - ARENA_Y) / TILE_PX), r1 = Math.ceil((y + radius - ARENA_Y) / TILE_PX);
      for (let row = r0; row < r1; row++) for (let col = c0; col < c1; col++) {
        if (grid.at(col, row)) this.markers[(row - grid.minRow) * grid.width + col - grid.minCol] = type;
      }
    };
    if (!EDITOR_DUNGEON) mark(DUNGEON_PORTAL.holePosition.x, DUNGEON_PORTAL.holePosition.y, 37.8, 3);
    for (const plate of PRESSURE_PLATES) mark(plate.position.x, plate.position.y, 12, snap.pressurePlates.find(p => p.id === plate.id)?.active ? 2 : 1);
    if (snap.spikeTrap) {
      const room = ROOM_REGIONS[snap.spikeTrap.roomIndex];
      if (room) { const center = regionCentre(room); mark(center.x, center.y, 14, snap.spikeTrap.active ? 2 : 1); }
    }
  }
  render(snap: TacticsSnapshot, now: number): void {
    const start = performance.now();
    this.world.update(snap); this.updateCamera(snap); this.updateMarkers(snap);
    this.pixels.fill(rgba(0, 0, 0));
    this.drawFloor(); this.drawWalls(now); this.drawSprites(snap, now); this.drawWallVeils();
    this.previousPlayerX = snap.player.x; this.previousPlayerY = snap.player.y;
    this.ctx.putImageData(this.image, 0, 0);
    this.drawRain(snap, now);
    this.renderMs = performance.now() - start;
  }
  private drawRain(snap: TacticsSnapshot, now: number) {
    const ctx = this.ctx;
    const cellSize = 160, radius = 1800;
    const density = { low: .25, med: .45, high: .7, max: 1 }[this.quality];
    const hash = (col: number, row: number, salt: number) => {
      let value = Math.imul(col, 374761393) ^ Math.imul(row, 668265263) ^ salt;
      value = Math.imul(value ^ (value >>> 13), 1274126177);
      return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
    };
    ctx.save(); ctx.lineWidth = .45;
    ctx.strokeStyle = 'rgba(182, 205, 222, .42)';
    // Each cell has a fixed world position and phase. Moving/orbiting only
    // changes projection, never translates the rain with the camera.
    for (let row = Math.floor((snap.player.y - radius) / cellSize); row <= Math.ceil((snap.player.y + radius) / cellSize); row++) {
      for (let col = Math.floor((snap.player.x - radius) / cellSize); col <= Math.ceil((snap.player.x + radius) / cellSize); col++) {
        if (hash(col, row, 7) > density) continue;
        const wx = (col + hash(col, row, 19)) * cellSize;
        const wy = (row + hash(col, row, 43)) * cellSize;
        const dx = wx - this.cameraX, dy = wy - this.cameraY;
        const depth = dx * this.forwardX + dy * this.forwardY;
        if (depth < 70 || depth > 3600) continue;
        const x = this.width / 2 + (dx * this.rightX + dy * this.rightY) * this.focal / depth;
        if (x < 0 || x >= this.width) continue;
        const scale = this.focal / depth;
        const phase = (now / 1000 * (1.8 + hash(col, row, 71) * .6) + hash(col, row, 101)) % 1;
        const groundY = this.horizon + this.eye * scale;
        const height = Math.max(0, 1 - phase / .88) * 420;
        const bottom = groundY - height * scale;
        const top = bottom - (32 + hash(col, row, 131) * 24) * scale;
        // Keep rain behind opaque walls hidden, while foreground rain remains visible.
        const wallDepth = this.depths[Math.floor(x)]!;
        const wallTop = this.horizon + (this.eye - WALL_HEIGHT) * this.focal / wallDepth;
        if (depth > wallDepth && bottom >= wallTop) continue;
        ctx.globalAlpha = Math.min(1, (3600 - depth) / 800);
        if (phase < .88) {
          if (bottom < 0 || top > this.height) continue;
          ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
        } else if (groundY >= 0 && groundY < this.height) {
          const age = (phase - .88) / .12;
          ctx.globalAlpha *= 1 - age;
          ctx.beginPath(); ctx.ellipse(x, groundY, (1 + age * 5) * scale,
            (1 + age * 2) * scale, 0, 0, Math.PI * 2); ctx.stroke();
        }
      }
    }
    ctx.restore();
  }
  private drawFloor() {
    const texture = this.textures.get('floor'), grass = this.textures.get('grass'), grid = this.world.grid;
    const w = this.width, h = this.height;
    for (let y = 0; y < h; y++) {
      const offset = y * w;
      if (!texture || !grass || y <= this.horizon) {
        continue;
      }
      const distance = this.eye * this.focal / (y - this.horizon);
      // Fade out before the ray limit instead of stretching its last texture row
      // across the horizon. Nearby grass stays visible when zoomed out.
      if (distance >= 6000) continue;
      const fogStart = this.cameraDistance + 2400;
      const fog = Math.max(0, Math.min(1, (distance - fogStart) / (6000 - fogStart)));
      const visibility = 1 - fog * fog * (3 - 2 * fog);
      const light = Math.max(.35, Math.min(.9, 1.05 - Math.max(0, distance - this.cameraDistance) / 5000));
      const level = Math.max(0, Math.min(23, Math.floor(light * 24) - 1));
      const stoneShades = texture.shades![level]!, grassShades = grass.shades![level]!;
      const stepX = 2 * distance * this.rightX * FOV / w, stepY = 2 * distance * this.rightY * FOV / w;
      let xWorld = this.cameraX + distance * (this.forwardX - this.rightX * FOV);
      let yWorld = this.cameraY + distance * (this.forwardY - this.rightY * FOV);
      for (let x = 0; x < w; x++, xWorld += stepX, yWorld += stepY) {
        const col = Math.floor((xWorld - ARENA_X) / TILE_PX) - grid.minCol;
        const row = Math.floor((yWorld - ARENA_Y) / TILE_PX) - grid.minRow;
        const inside = col >= 0 && row >= 0 && col < grid.width && row < grid.height
          && grid.cells[row * grid.width + col] === 1;
        const ground = inside ? texture : grass;
        const tx = Math.floor(xWorld / 90 * ground.width) & (ground.width - 1);
        const ty = Math.floor(yWorld / 90 * ground.height) & (ground.height - 1);
        let color = (inside ? stoneShades : grassShades)[ty * ground.width + tx]!;
        const marker = col >= 0 && row >= 0 && col < grid.width && row < grid.height ? this.markers[row * grid.width + col] : 0;
        if (marker === 3) color = rgba(5, 2, 9);
        else if (marker) color = marker === 2 ? rgba(130, 77, 24) : rgba(20 + ((tx ^ ty) & 7), 23, 26);
        const groundColor = marker ? shade(color, light) : color;
        this.pixels[offset + x] = fog > 0 ? shade(groundColor, visibility) : groundColor;
      }
    }
  }
  private drawWalls(now: number) {
    this.wallVeils = [];
    const barrier = this.barrierFrames[Math.floor(now / 140) % 4]!;
    const texture = this.textures.get('wall');
    const webTexture = this.textures.get('web');
    for (let x = 0; x < this.width; x++) {
      const plane = (2 * (x + .5) / this.width - 1) * FOV;
      const hit = castCameraRay(this.world.grid, this.cameraX, this.cameraY,
        this.forwardX + this.rightX * plane, this.forwardY + this.rightY * plane, this.world.gates, this.cameraDistance);
      for (const veil of hit.veils) this.wallVeils.push({ x, hit: veil });
      this.depths[x] = hit.distance >= 6000 ? Infinity : hit.distance;
      if (hit.distance >= 6000) continue;
      const top = this.horizon + (this.eye - WALL_HEIGHT) * this.focal / hit.distance;
      const bottom = this.horizon + this.eye * this.focal / hit.distance;
      this.wallBottoms[x] = bottom;
      const start = Math.max(0, Math.floor(top)), end = Math.min(this.height, Math.ceil(bottom));
      const along = hit.side ? hit.x : hit.y;
      const u = ((along / 90) % 1 + 1) % 1;
      const tx = texture ? Math.min(texture.width - 1, Math.floor(u * texture.width)) : 0;
      const light = Math.max(.4, Math.min(1, 1.15 - Math.max(0, hit.distance - this.cameraDistance) / 5500)) * (hit.side ? .75 : 1);
      const shaded = texture?.shades![Math.max(0, Math.min(23, Math.floor(light * 24) - 1))];
      const web = hit.material === 0 ? this.wallWebs.find(web => web.side === hit.side
        && Math.abs(web.plane - (hit.side ? hit.y : hit.x)) < 1
        && Math.abs(along - web.along) < web.width / 2) : undefined;
      const webX = web ? Math.floor((along - web.along + web.width / 2) / web.width * 64) : 0;
      for (let y = start; y < end; y++) {
        const v = (y - top) / (bottom - top);
        let color = rgba(99, 86, 67);
        if (texture) { const ty = Math.max(0, Math.floor(v * WALL_HEIGHT / 90 * texture.height)) & (texture.height - 1); color = shaded![ty * texture.width + tx]!; }
        if (hit.material === 1) color = Math.floor(u * 12) % 2 === 0 || Math.floor(v * 12) % 6 === 0 ? rgba(81, 88, 94) : rgba(13, 16, 19);
        if (hit.material === 2) color = barrier[Math.min(BARRIER_HEIGHT - 1, Math.max(0, Math.floor(v * BARRIER_HEIGHT))) * BARRIER_WIDTH + Math.floor(u * BARRIER_WIDTH)]!;
        if (web && webTexture) {
          const worldHeight = WALL_HEIGHT * (1 - v);
          const webY = Math.floor((160 - worldHeight) / 140 * 64);
          if (webY >= 0 && webY < 64) {
            const alpha = (webTexture.data[webY * 64 + webX]! >>> 24) / 255 * .8;
            const strand = 205 * light;
            color = rgba((color & 255) * (1 - alpha) + strand * alpha,
              ((color >>> 8) & 255) * (1 - alpha) + strand * alpha,
              ((color >>> 16) & 255) * (1 - alpha) + strand * alpha);
          }
        }
        this.pixels[y * this.width + x] = hit.material === 2 ? shade(color, Math.max(.7, light))
          : hit.material || !texture ? shade(color, light) : color;
      }
    }
  }
  private drawWallVeils() {
    for (const { x, hit } of this.wallVeils) {
      const depth = Math.max(1, hit.distance);
      const top = this.horizon + (this.eye - WALL_HEIGHT) * this.focal / depth;
      const bottom = this.horizon + this.eye * this.focal / depth;
      for (let y = Math.max(0, Math.floor(top)); y < Math.min(this.height, Math.ceil(bottom)); y++) {
        const grey = 15, alpha = .45;
        const pixel = this.pixels[y * this.width + x]!;
        this.pixels[y * this.width + x] = rgba((pixel & 255) * (1 - alpha) + grey * alpha,
          ((pixel >>> 8) & 255) * (1 - alpha) + grey * alpha,
          ((pixel >>> 16) & 255) * (1 - alpha) + grey * alpha);
      }
    }
  }
  private drawSprites(snap: TacticsSnapshot, now: number) {
    const sprites: Billboard[] = this.scenery.map(sprite => ({ ...sprite }));
    const addActor = (actor: { x: number; y: number; facing: number; heading?: { x: number; y: number }; altitude?: number }, name: keyof typeof SPRITE_META, moving: boolean) => {
      const meta = SPRITE_META[name];
      const angle = Math.atan2(this.cameraY - actor.y, this.cameraX - actor.x) - Math.atan2(actor.heading?.y ?? 0, actor.heading?.x ?? actor.facing);
      const direction = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
      sprites.push({ x: actor.x, y: actor.y, z: meta.center + (actor.altitude ?? 0) * 30, span: meta.span, image: name, direction, frame: moving ? 1 + Math.floor(now / 130) % 3 : 0 });
    };
    const houndIds = new Set<string>();
    const spiderIds = new Set<string>();
    for (const enemy of snap.enemies) {
      const kind = enemy.kind ?? 'hellhound';
      let moving = enemy.aggro || kind === 'bat';
      if (kind === 'hellhound') {
        houndIds.add(enemy.id);
        const previous = this.houndMotion.get(enemy.id);
        const moved = previous && Math.hypot(enemy.x - previous.x, enemy.y - previous.y) > .01;
        const movedAt = moved ? now : previous?.movedAt ?? -Infinity;
        // Bridge snapshot gaps, then return to idle when the hound actually stops.
        moving = now - movedAt < 100;
        this.houndMotion.set(enemy.id, { x: enemy.x, y: enemy.y, movedAt });
      }
      if (kind === 'spider' && enemy.surface && enemy.surface !== 'floor') {
        spiderIds.add(enemy.id);
        const altitude = enemy.altitude ?? 0;
        const previous = this.spiderMotion.get(enemy.id);
        const dx = enemy.x - (previous?.x ?? enemy.x), dy = enemy.y - (previous?.y ?? enemy.y);
        const dz = (altitude - (previous?.altitude ?? altitude)) * 30;
        const moved = Math.hypot(dx, dy, dz) > .01;
        const movedAt = moved ? now : previous?.movedAt ?? -Infinity;
        const across = dx * this.rightX + dy * this.rightY;
        const direction = moved ? ((Math.round(Math.atan2(-across, dz) / (Math.PI / 4)) % 8) + 8) % 8
          : previous?.direction ?? 0;
        this.spiderMotion.set(enemy.id, { x: enemy.x, y: enemy.y, altitude, movedAt, direction });
        const meta = SPRITE_META['spider-wall'];
        sprites.push({ x: enemy.x, y: enemy.y, z: (altitude + .45) * 30, span: meta.span,
          image: 'spider-wall', direction,
          frame: !enemy.movementPaused && now - movedAt < 100 ? 1 + Math.floor(now / 80) % 8 : 0 });
      } else addActor(enemy, kind, moving);
    }
    for (const id of this.spiderMotion.keys()) if (!spiderIds.has(id)) this.spiderMotion.delete(id);
    for (const id of this.houndMotion.keys()) if (!houndIds.has(id)) this.houndMotion.delete(id);
    for (const corpse of snap.corpses) if (!corpse.eaten) addActor({ ...corpse, altitude: 0 }, `${corpse.kind ?? 'hellhound'}-dead` as keyof typeof SPRITE_META, false);
    if (!snap.dead) addActor({ ...snap.player, heading: snap.playerHeading }, 'player', Math.hypot(snap.player.x - this.previousPlayerX, snap.player.y - this.previousPlayerY) > .05);
    else addActor({ ...snap.player, altitude: 0 }, 'player-dead', false);
    if (snap.playerEating && !snap.dead) {
      this.eatingStartedAt ??= now;
      const player = sprites.find(sprite => sprite.image === 'player');
      if (player) {
        const meta = SPRITE_META['player-eat'];
        player.image = 'player-eat'; player.span = meta.span; player.z = meta.center;
        player.frame = Math.min(7, Math.floor((now - this.eatingStartedAt) / 125));
      }
    } else this.eatingStartedAt = null;
    const bite = playerBiteFrame(snap);
    if (bite !== null) {
      const player = sprites.find(sprite => sprite.image === 'player');
      if (player) { player.image = 'player-bite'; player.frame = bite; }
    }

    if (!snap.purpleGem.destroyed) sprites.push({ x: snap.purpleGem.x, y: snap.purpleGem.y, z: 32 + Math.sin(now / 400) * 3, span: SPRITE_META.gem.span, image: 'gem', direction: Math.floor(now / 180) % 8, frame: 0 });
    for (const p of snap.projectiles) sprites.push({ x: p.x, y: p.y, z: 35, span: 28, image: 'dagger', direction: 0, frame: 0 });
    for (const stone of snap.tombstones) sprites.push({ x: stone.x, y: stone.y, z: SPRITE_META.cross.center - 3.6, span: SPRITE_META.cross.span, image: 'cross', direction: 0, frame: 0 });
    if (snap.spikeTrap?.active) {
      const room = ROOM_REGIONS[snap.spikeTrap.roomIndex];
      if (room) { const center = regionCentre(room);
        for (let row = room.row + 3; row < room.row + room.rows - 2; row += 4) for (let col = room.col + 3; col < room.col + room.cols - 2; col += 4) {
          const x = ARENA_X + col * TILE_PX, y = ARENA_Y + row * TILE_PX;
          if (Math.hypot(x - center.x, y - center.y) > TILE_PX * 2.35) sprites.push({ x, y, z: 30, span: 68, image: 'spike', direction: 0, frame: 0 });
        }
      }
    }
    // Torches are cheap cached sprites, not dynamic lights.
    for (const room of ROOM_REGIONS) {
      const y = ARENA_Y + (room.row + 1) * TILE_PX;
      for (const col of [room.col + room.cols * .25, room.col + room.cols * .75])
        sprites.push({ x: ARENA_X + col * TILE_PX, y, z: 95, span: 46, image: 'torch', direction: 0, frame: 0 });
    }
    for (const sprite of sprites) sprite.depth = (sprite.x - this.cameraX) * this.forwardX + (sprite.y - this.cameraY) * this.forwardY;
    sprites.sort((a, b) => b.depth! - a.depth!);
    // Ground shadows are flattened cached sprites; they do not cast extra rays.
    for (const sprite of sprites) if (sprite.image in SPRITE_META && !['angel', 'gem', 'spider-wall'].includes(sprite.image))
      this.drawBillboard({ ...sprite, image: 'shadow', span: sprite.span * .6, z: 1, frame: 0, direction: 0 });
    for (const sprite of sprites) this.drawBillboard(sprite);
  }
  private drawBillboard(sprite: Billboard) {
    const depth = sprite.image.startsWith("player") ? Math.max(120, sprite.depth!) : sprite.depth!;
    if (depth < 4 || depth > 6000) return;
    const image = this.textures.get(sprite.image); if (!image) return;
    const across = (sprite.x - this.cameraX) * this.rightX + (sprite.y - this.cameraY) * this.rightY;
    const size = sprite.span * this.focal / depth;
    const left = this.width / 2 + across * this.focal / depth - size / 2;
    const groundY = this.horizon + this.eye * this.focal / depth;
    // Anchor the visible rock silhouette, not the padded atlas or 3D bounds.
    // Push it below that ground line, then let the floor hide the buried pixels.
    const rockBottom = image.bottomRows?.[sprite.direction];
    const top = rockBottom !== undefined
      ? groundY - rockBottom / (image.width / 8) * size + 6 * this.focal / depth
      : this.horizon + (this.eye - sprite.z) * this.focal / depth - size / 2;
    const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(this.width, Math.ceil(left + size));
    const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(this.height, Math.ceil(top + size), rockBottom !== undefined ? Math.ceil(groundY) : this.height);
    const frameSize = sprite.image in SPRITE_META ? image.width / 8 : image.width;
    const light = Math.max(.45, Math.min(1.15, 1.2 - Math.max(0, depth - this.cameraDistance) / 5000));
    for (let x = x0; x < x1; x++) {
      if (!sprite.image.startsWith("player") && depth > this.depths[x]!) continue;
      const sx = sprite.direction * frameSize + Math.min(frameSize - 1, Math.max(0, Math.floor((x - left) / size * frameSize)));
      for (let y = y0; y < y1; y++) {
        const sy = sprite.frame * frameSize + Math.min(frameSize - 1, Math.max(0, Math.floor((y - top) / size * frameSize)));
        const pixel = image.data[sy * image.width + sx]!;
        if ((pixel >>> 24) > 100) this.pixels[y * this.width + x] = sprite.image === 'shadow'
          ? shade(this.pixels[y * this.width + x]!, .6) : shade(pixel, light);
      }
    }
  }
  private proceduralSprites() {
    for (const kind of ['torch', 'dagger', 'spike', 'shadow', 'web', 'grass']) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d')!;
      if (kind === 'grass') {
        let state = 0x6a55;
        const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
        c.fillStyle = '#35472a'; c.fillRect(0, 0, 64, 64);
        for (let i = 0; i < 2400; i++) {
          const x = Math.floor(random() * 64), y = Math.floor(random() * 64);
          c.fillStyle = ['#293820', '#465834', '#55643b', '#687047', '#3a4b29', '#49472f'][Math.floor(random() * 6)]!;
          c.fillRect(x, y, 1, 1 + Math.floor(random() * 3));
        }
      } else if (kind === 'web') {
        c.strokeStyle = '#dddcd0'; c.lineWidth = .65;
        const cx = 29, cy = 27, spokes = 12;
        for (let i = 0; i < spokes; i++) {
          const angle = i * Math.PI * 2 / spokes;
          c.beginPath(); c.moveTo(cx, cy);
          c.lineTo(cx + Math.cos(angle) * 48, cy + Math.sin(angle) * 48); c.stroke();
        }
        for (const radius of [5, 10, 16, 23, 31, 40]) {
          c.beginPath();
          for (let i = 0; i <= spokes; i++) {
            const angle = i * Math.PI * 2 / spokes;
            const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
          }
          c.stroke();
        }
      } else if (kind === 'shadow') { c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.ellipse(32, 32, 30, 5, 0, 0, Math.PI * 2); c.fill(); }
      else if (kind === 'torch') {
        c.fillStyle = '#4c3325'; c.fillRect(27, 29, 10, 33);
        c.fillStyle = '#ff771d'; c.beginPath(); c.moveTo(20, 34); c.lineTo(17, 19); c.lineTo(28, 3); c.lineTo(31, 19); c.lineTo(42, 10); c.lineTo(46, 31); c.closePath(); c.fill();
        c.fillStyle = '#ffe99b'; c.beginPath(); c.moveTo(25, 32); c.lineTo(31, 15); c.lineTo(38, 32); c.fill();
      } else {
        c.fillStyle = '#b4bdc7'; c.beginPath(); c.moveTo(32, 3); c.lineTo(43, 51); c.lineTo(21, 51); c.closePath(); c.fill();
        c.fillStyle = '#454d56'; c.beginPath(); c.moveTo(32, 3); c.lineTo(32, 51); c.lineTo(21, 51); c.fill();
        if (kind === 'dagger') { c.fillStyle = '#987549'; c.fillRect(20, 48, 24, 4); c.fillRect(29, 52, 6, 11); }
      }
      const data = new Uint32Array(c.getImageData(0, 0, 64, 64).data.buffer);
      const shades = kind === 'grass' ? Array.from({ length: 24 }, (_, level) => data.map(pixel => shade(pixel, (level + 1) / 24))) : undefined;
      this.textures.set(kind, { width: 64, height: 64, data, shades });
    }
  }
}
