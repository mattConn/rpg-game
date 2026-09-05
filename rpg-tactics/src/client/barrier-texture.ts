/** Four cached pixel-art lightning frames, sampled directly by the raycaster. */
export const BARRIER_WIDTH = 32, BARRIER_HEIGHT = 64;
const color = (r: number, g: number, b: number) => (0xff000000 | b << 16 | g << 8 | r) >>> 0;
export function buildBarrierFrames(): Uint32Array[] {
  return Array.from({ length: 4 }, (_, frame) => {
    let seed = 0x51f37 + frame * 7919;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const pixels = new Uint32Array(BARRIER_WIDTH * BARRIER_HEIGHT);
    for (let y = 0; y < BARRIER_HEIGHT; y++) for (let x = 0; x < BARRIER_WIDTH; x++) {
      const noise = random();
      pixels[y * BARRIER_WIDTH + x] = noise < .55 ? color(5, 0, 10)
        : noise < .9 ? color(34, 4, 55) : color(65, 9, 96);
    }
    const set = (x: number, y: number, value: number) => {
      if (y >= 0 && y < BARRIER_HEIGHT) pixels[y * BARRIER_WIDTH + ((x % BARRIER_WIDTH + BARRIER_WIDTH) % BARRIER_WIDTH)] = value;
    };
    const bolt: [number, number][] = [];
    const line = (x: number, y: number, endX: number, endY: number) => {
      const steps = Math.max(Math.abs(endX - x), Math.abs(endY - y));
      for (let i = 0; i <= steps; i++) bolt.push([
        Math.round(x + (endX - x) * i / Math.max(1, steps)),
        Math.round(y + (endY - y) * i / Math.max(1, steps)),
      ]);
    };
    for (const start of [6, 23]) {
      let x = start + Math.floor(random() * 5), y = 0;
      while (y < BARRIER_HEIGHT) {
        const nx = x + Math.floor(random() * 13) - 6, ny = y + 5 + Math.floor(random() * 6);
        line(x, y, nx, ny);
        if (random() < .55) line(nx, ny, nx + (random() < .5 ? -8 : 8), ny + 7);
        x = nx; y = ny;
      }
    }
    // Hard pixel edges: dark violet surround, bright purple glow, white core.
    for (const [x, y] of bolt) for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) set(x + dx, y + dy, color(79, 8, 132));
    for (const [x, y] of bolt) for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) set(x + dx!, y + dy!, color(174, 54, 255));
    for (const [x, y] of bolt) set(x, y, color(247, 237, 255));
    return pixels;
  });
}
