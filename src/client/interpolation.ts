/**
 * Snapshot playback timing. Pure so it can be checked without a canvas — the
 * bugs here are the kind that only show as "it looks jittery", which is exactly
 * what you can't eyeball reliably.
 */

/** Server tick/broadcast period (see the setInterval in `server/index.ts`). */
export const SERVER_TICK_MS = 50;

/**
 * Fold a fresh inter-snapshot gap into the smoothed playback interval.
 *
 * Using the raw last gap makes one late packet change playback speed for every
 * frame until the next lands. The bounds stop a stall or a burst from dragging
 * the estimate somewhere it can't recover from.
 */
export function smoothInterval(current: number, gap: number): number {
  if (!(gap > 0)) return current;
  const clamped = Math.max(SERVER_TICK_MS / 2, Math.min(gap, SERVER_TICK_MS * 4));
  return current * 0.8 + clamped * 0.2;
}

/**
 * How far to lerp from the previous snapshot to the current one, in [0, 1].
 *
 * `now` is the requestAnimationFrame timestamp, which marks when the frame
 * *started* — so a snapshot that arrives after that but before the callback
 * runs sits in the future relative to it. Clamping the low end matters as much
 * as the high end: a negative fraction extrapolates backwards past the previous
 * snapshot and reads on screen as a jump.
 */
export function renderFraction(
  now: number,
  currSnapshotTime: number,
  interval: number,
  hasPrev: boolean,
): number {
  if (!hasPrev) return 1;
  const elapsed = Math.max(0, now - currSnapshotTime);
  const span = interval > 0 ? interval : SERVER_TICK_MS;
  return Math.min(elapsed / span, 1);
}
