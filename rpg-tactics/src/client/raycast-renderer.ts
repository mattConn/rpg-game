import { WORLD_HEIGHT } from '../../../src/shared/constants.js';
import { ARENA_X, ARENA_Y, TILE_PX, DUNGEON_PORTAL, PRESSURE_PLATES, ROOM_REGIONS, HALL_REGIONS, EDITOR_DUNGEON, regionCentre, type TacticsSnapshot } from '../shared/tactics.js';
import { RaycastWorld } from './raycast-world.js';
import { playerBiteFrame } from './attack-presentation.js';
import { SPRITE_META } from './sprite-metadata.js';
import { GRAPHICS_PRESETS, type GraphicsQuality } from './graphics.js';

const FOV = Math.tan(Math.PI * 70 / 360), WALL_HEIGHT = 168, EYE_HEIGHT = 85;
// Start at the reference angle, with free horizontal orbit and vertical mouse-look.
const HORIZON_FRACTION = .11;
const rgba = (r: number, g: number, b: number) => (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
const shade = (color: number, amount: number) => rgba(Math.min(255, (color & 255) * amount), Math.min(255, ((color >>> 8) & 255) * amount), Math.min(255, ((color >>> 16) & 255) * amount));
interface Pixels { width: number; height: number; data: Uint32Array; shades?: Uint32Array[] }
interface Billboard { x: number; y: number; z: number; span: number; image: string; direction: number; frame: number; depth?: number }

/** Entire play view is Canvas2D: no WebGL context, mesh, light, or animation mixer. */
export class RaycastRenderer {
  readonly world = new RaycastWorld();
  yaw = -Math.PI / 2;
  private pitch = 0;
  private cameraDistance = 150;
  private width = 480; private height = 270; private viewWidth = 1600;
  private image!: ImageData; private pixels!: Uint32Array;
  private depths = new Float32Array(480);
  private wallBottoms = new Float32Array(480);
  private cameraX = 0; private cameraY = 0; private eye = EYE_HEIGHT;
  private forwardX = 1; private forwardY = 0; private rightX = 0; private rightY = 1;
  private focal = 1; private horizon = 0;
  private textures = new Map<string, Pixels>();
  private scenery: Billboard[] = [];
  private markers: Uint8Array;
  private markerKey = '';
  private readonly ctx: CanvasRenderingContext2D;
  readonly ready: Promise<void>;
  renderMs = 0;
  private eatingStartedAt: number | null = null;
  private houndMotion = new Map<string, { x: number; y: number; movedAt: number }>();
  private previousPlayerX = NaN; private previousPlayerY = NaN;

  constructor(private readonly canvas: HTMLCanvasElement, private quality: GraphicsQuality) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.markers = new Uint8Array(this.world.grid.cells.length);
    if (!EDITOR_DUNGEON && ROOM_REGIONS[0] && HALL_REGIONS[0]) {
      const start = regionCentre(ROOM_REGIONS[0]), hall = regionCentre(HALL_REGIONS[0]);
      this.yaw = Math.atan2(start.x - hall.x, start.y - hall.y);
    }
    this.proceduralSprites();
    const prop = (image: 'boulder' | 'angel', x: number, y: number, direction = 0) => {
      const meta = SPRITE_META[image];
      this.scenery.push({ x, y, z: meta.center, span: meta.span, image, direction: image === 'angel' ? (direction + 4) % 8 : direction, frame: 0 });
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
    this.textures.set(key, { width: canvas.width, height: canvas.height, data, shades });
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
    this.yaw -= dx * 8;
    this.pitch = Math.max(-1.1, Math.min(1.1, this.pitch + dy * 2));
  }
  zoom(delta: number): void {
    this.cameraDistance = Math.max(150, Math.min(220, this.cameraDistance + Math.max(-120, Math.min(120, delta)) * .15));
  }
  flip(): void { this.yaw += Math.PI; }
  resetView(): void { this.yaw = -Math.PI / 2; this.pitch = 0; this.cameraDistance = 150; }

  private updateCamera(snap: TacticsSnapshot) {
    this.forwardX = -Math.sin(this.yaw); this.forwardY = -Math.cos(this.yaw);
    this.rightX = Math.cos(this.yaw); this.rightY = -Math.sin(this.yaw);
    // Camera is a physical point behind the wolf, never beyond the nearest wall/gate.
    const back = this.world.cast(snap.player.x, snap.player.y, -this.forwardX, -this.forwardY, this.cameraDistance + 8);
    const distance = Math.max(0, Math.min(this.cameraDistance, back.distance - 7));
    this.cameraX = snap.player.x - this.forwardX * distance;
    this.cameraY = snap.player.y - this.forwardY * distance;
    this.eye = EYE_HEIGHT - snap.dungeonPortal.fallProgress * 65;
    this.focal = this.width / (2 * FOV);
    this.horizon = this.height * HORIZON_FRACTION + Math.tan(this.pitch) * this.focal;
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
    return this.world.cast(this.cameraX, this.cameraY, dx / distance, dy / distance, distance + 1).distance >= distance - 2;
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
    this.pixels.fill(rgba(20, 18, 17));
    this.drawWalls(); this.drawFloor(); this.drawSprites(snap, now);
    this.previousPlayerX = snap.player.x; this.previousPlayerY = snap.player.y;
    this.ctx.putImageData(this.image, 0, 0);
    this.renderMs = performance.now() - start;
  }
  private drawFloor() {
    const texture = this.textures.get('floor'), grid = this.world.grid;
    const w = this.width, h = this.height;
    for (let y = 0; y < h; y++) {
      const offset = y * w;
      if (y <= this.horizon || !texture) {
        continue;
      }
      const distance = this.eye * this.focal / (y - this.horizon);
      const light = Math.max(.14, Math.min(.9, 1.05 - distance / 1700));
      const shaded = texture.shades![Math.max(0, Math.min(23, Math.floor(light * 24) - 1))]!;
      const stepX = 2 * distance * this.rightX * FOV / w, stepY = 2 * distance * this.rightY * FOV / w;
      let xWorld = this.cameraX + distance * (this.forwardX - this.rightX * FOV);
      let yWorld = this.cameraY + distance * (this.forwardY - this.rightY * FOV);
      for (let x = 0; x < w; x++, xWorld += stepX, yWorld += stepY) {
        if (y < this.wallBottoms[x]!) continue;
        const tx = Math.floor(xWorld / 90 * texture.width) & (texture.width - 1);
        const ty = Math.floor(yWorld / 90 * texture.height) & (texture.height - 1);
        let color = shaded[ty * texture.width + tx]!;
        const col = Math.floor((xWorld - ARENA_X) / TILE_PX) - grid.minCol;
        const row = Math.floor((yWorld - ARENA_Y) / TILE_PX) - grid.minRow;
        const marker = col >= 0 && row >= 0 && col < grid.width && row < grid.height ? this.markers[row * grid.width + col] : 0;
        if (marker === 3) color = rgba(5, 2, 9);
        else if (marker) color = marker === 2 ? rgba(130, 77, 24) : rgba(64 + ((tx ^ ty) & 15), 69, 72);
        this.pixels[offset + x] = marker ? shade(color, light) : color;
      }
    }
  }
  private drawWalls() {
    const texture = this.textures.get('wall');
    for (let x = 0; x < this.width; x++) {
      const plane = (2 * (x + .5) / this.width - 1) * FOV;
      const hit = this.world.cast(this.cameraX, this.cameraY, this.forwardX + this.rightX * plane, this.forwardY + this.rightY * plane);
      this.depths[x] = hit.distance;
      const top = this.horizon + (this.eye - WALL_HEIGHT) * this.focal / hit.distance;
      const bottom = this.horizon + this.eye * this.focal / hit.distance;
      this.wallBottoms[x] = bottom;
      const start = Math.max(0, Math.floor(top)), end = Math.min(this.height, Math.ceil(bottom));
      const along = hit.side ? hit.x : hit.y;
      const u = ((along / 90) % 1 + 1) % 1;
      const tx = texture ? Math.min(texture.width - 1, Math.floor(u * texture.width)) : 0;
      const light = Math.max(.16, Math.min(1, 1.15 - hit.distance / 1800)) * (hit.side ? .75 : 1);
      const shaded = texture?.shades![Math.max(0, Math.min(23, Math.floor(light * 24) - 1))];
      for (let y = start; y < end; y++) {
        const v = (y - top) / (bottom - top);
        let color = rgba(99, 86, 67);
        if (texture) { const ty = Math.max(0, Math.floor(v * WALL_HEIGHT / 90 * texture.height)) & (texture.height - 1); color = shaded![ty * texture.width + tx]!; }
        if (hit.material === 1) color = Math.floor(u * 12) % 2 === 0 || Math.floor(v * 12) % 6 === 0 ? rgba(81, 88, 94) : rgba(13, 16, 19);
        if (hit.material === 2) color = shade(rgba(119, 42, 182), .65 + Math.sin(u * 40 + v * 26) * .2);
        this.pixels[y * this.width + x] = hit.material || !texture ? shade(color, light) : color;
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
      addActor(enemy, kind, moving);
    }
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
    for (const sprite of sprites) if (sprite.image in SPRITE_META && !['bat', 'angel', 'gem'].includes(sprite.image))
      this.drawBillboard({ ...sprite, image: 'shadow', span: sprite.span * .6, z: 1, frame: 0, direction: 0 });
    for (const sprite of sprites) this.drawBillboard(sprite);
  }
  private drawBillboard(sprite: Billboard) {
    const depth = sprite.image.startsWith("player") ? Math.max(120, sprite.depth!) : sprite.depth!;
    if (depth < 4 || depth > 2400) return;
    const image = this.textures.get(sprite.image); if (!image) return;
    const across = (sprite.x - this.cameraX) * this.rightX + (sprite.y - this.cameraY) * this.rightY;
    const size = sprite.span * this.focal / depth;
    const left = this.width / 2 + across * this.focal / depth - size / 2;
    const top = this.horizon + (this.eye - sprite.z) * this.focal / depth - size / 2;
    const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(this.width, Math.ceil(left + size));
    const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(this.height, Math.ceil(top + size));
    const frameSize = sprite.image in SPRITE_META ? image.width / 8 : image.width;
    const light = Math.max(.2, Math.min(1.15, 1.2 - depth / 1600));
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
    for (const kind of ['torch', 'dagger', 'spike', 'shadow']) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d')!;
      if (kind === 'shadow') { c.fillStyle = 'rgba(0,0,0,.4)'; c.beginPath(); c.ellipse(32, 32, 30, 5, 0, 0, Math.PI * 2); c.fill(); }
      else if (kind === 'torch') {
        c.fillStyle = '#4c3325'; c.fillRect(27, 29, 10, 33);
        c.fillStyle = '#ff771d'; c.beginPath(); c.moveTo(20, 34); c.lineTo(17, 19); c.lineTo(28, 3); c.lineTo(31, 19); c.lineTo(42, 10); c.lineTo(46, 31); c.closePath(); c.fill();
        c.fillStyle = '#ffe99b'; c.beginPath(); c.moveTo(25, 32); c.lineTo(31, 15); c.lineTo(38, 32); c.fill();
      } else {
        c.fillStyle = '#b4bdc7'; c.beginPath(); c.moveTo(32, 3); c.lineTo(43, 51); c.lineTo(21, 51); c.closePath(); c.fill();
        c.fillStyle = '#454d56'; c.beginPath(); c.moveTo(32, 3); c.lineTo(32, 51); c.lineTo(21, 51); c.fill();
        if (kind === 'dagger') { c.fillStyle = '#987549'; c.fillRect(20, 48, 24, 4); c.fillRect(29, 52, 6, 11); }
      }
      this.textures.set(kind, { width: 64, height: 64, data: new Uint32Array(c.getImageData(0, 0, 64, 64).data.buffer) });
    }
  }
}
