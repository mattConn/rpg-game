/** Portrait, health/magic bars and name plate — draggable by its gold handle. */

import type { Point } from "../shared/movement.js";
import { clampPanelOrigin, drawHandle, drawPanelBacking } from "./panel.js";

const MARGIN = 14;

const PORTRAIT_RADIUS = 26;
const PORTRAIT_SIZE = PORTRAIT_RADIUS * 2;

const BAR_GAP = 10;
const BAR_WIDTH = 130;
const BAR_HEIGHT = 10;
const BAR_SPACING = 8;

const NAME_GAP = 6;
const NAME_HEIGHT = 14;

const PORTRAIT_FONT = "26px monospace";
const NAME_FONT = "12px monospace";

export const HUD_WIDTH = PORTRAIT_SIZE + BAR_GAP + BAR_WIDTH;
export const HUD_HEIGHT = PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT;

/** Top-left of the panel — the anchor, and where the handle sits. */
export const HUD_DEFAULT_ORIGIN: Point = { x: MARGIN, y: MARGIN };

export function clampHudOrigin(origin: Point): Point {
  return clampPanelOrigin(origin, HUD_WIDTH, HUD_HEIGHT);
}

export interface HudStats {
  name: string;
  color: string;
  level: number;
  health: number;
  maxHealth: number;
  mana: number;
  maxMana: number;
}

/** The two bars sit to the right of the portrait, vertically centred against it. */
export function barRect(origin: Point, index: 0 | 1) {
  const stackHeight = BAR_HEIGHT * 2 + BAR_SPACING;
  return {
    x: origin.x + PORTRAIT_SIZE + BAR_GAP,
    y: origin.y + (PORTRAIT_SIZE - stackHeight) / 2 + index * (BAR_HEIGHT + BAR_SPACING),
    width: BAR_WIDTH,
    height: BAR_HEIGHT,
  };
}

/** Filled portion of a bar, clamped so bad values can't overdraw the track. */
export function fillWidth(value: number, max: number, width: number): number {
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(1, value / max)) * width;
}

function drawBar(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  value: number,
  max: number,
  color: string,
) {
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, fillWidth(value, max, rect.width), rect.height);

  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
}

export function drawHud(ctx: CanvasRenderingContext2D, origin: Point, stats: HudStats) {
  ctx.setLineDash([]);

  const label = `${stats.name} - lvl ${stats.level}`;
  ctx.font = NAME_FONT;
  const backingWidth = Math.max(HUD_WIDTH, ctx.measureText(label).width);
  drawPanelBacking(ctx, origin, backingWidth, HUD_HEIGHT);

  // Portrait: the player's own glyph, ringed in their colour.
  const centerX = origin.x + PORTRAIT_RADIUS;
  const centerY = origin.y + PORTRAIT_RADIUS;

  ctx.beginPath();
  ctx.arc(centerX, centerY, PORTRAIT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0a0a";
  ctx.fill();
  ctx.strokeStyle = stats.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = PORTRAIT_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = stats.color;
  ctx.fillText("@", centerX, centerY);

  drawBar(ctx, barRect(origin, 0), stats.health, stats.maxHealth, "#c0392b");
  drawBar(ctx, barRect(origin, 1), stats.mana, stats.maxMana, "#2a6fd6");

  ctx.font = NAME_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#dddddd";
  ctx.fillText(label, origin.x, origin.y + PORTRAIT_SIZE + NAME_GAP);

  drawHandle(ctx, origin);
}
