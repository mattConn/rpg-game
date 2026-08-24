/** Portrait, health/magic bars and name plate. */

import type { Point } from "../shared/movement.js";
import { clampPanelOrigin, drawPanelBacking } from "./panel.js";

const MARGIN = 14;

const PORTRAIT_RADIUS = 26;
export const PORTRAIT_SIZE = PORTRAIT_RADIUS * 2;

const BAR_GAP = 10;
const BAR_WIDTH = 130;
const BAR_HEIGHT = 10;
const BAR_SPACING = 8;

export const NAME_GAP = 6;
export const NAME_HEIGHT = 14;

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
  dead?: boolean;
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
  showValue = false,
) {
  ctx.fillStyle = "#1b1b1b";
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, fillWidth(value, max, rect.width), rect.height);

  ctx.strokeStyle = "#3a3a3a";
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

  if (showValue) {
    ctx.font = `bold ${Math.max(9, rect.height - 2)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.fillStyle = "#ffffff";
    const label = `${Math.ceil(value)}/${Math.ceil(max)}`;
    const labelX = rect.x + rect.width / 2;
    const labelY = rect.y + rect.height / 2 + 0.5;
    ctx.strokeText(label, labelX, labelY);
    ctx.fillText(label, labelX, labelY);
  }
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
  const portraitColor = stats.dead ? "#444444" : stats.color;

  ctx.beginPath();
  ctx.arc(centerX, centerY, PORTRAIT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0a0a";
  ctx.fill();
  ctx.strokeStyle = portraitColor;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = PORTRAIT_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = portraitColor;
  ctx.fillText("@", centerX, centerY);

  drawBar(ctx, barRect(origin, 0), stats.health, stats.maxHealth, "#c0392b");
  drawBar(ctx, barRect(origin, 1), stats.mana, stats.maxMana, "#2a6fd6");

  ctx.font = NAME_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = stats.dead ? "#444444" : "#dddddd";
  ctx.fillText(label, origin.x, origin.y + PORTRAIT_SIZE + NAME_GAP);
}

/** Compact corner status: health only, with no portrait, mana, or name. */
export function drawBarsOnlyHud(ctx: CanvasRenderingContext2D, origin: Point, stats: HudStats) {
  const width = 230;
  const barHeight = 18;
  ctx.setLineDash([]);
  drawPanelBacking(ctx, origin, width, barHeight);
  drawBar(ctx, { x: origin.x, y: origin.y, width, height: barHeight },
    stats.health, stats.maxHealth, "#c0392b", true);
}

// ----------------------------------------------------------- enemy portrait

export interface EnemyHudInfo {
  name: string;
  glyph: string;
  color: string;
  health: number;
  maxHealth: number;
}

const ENEMY_PORTRAIT_RADIUS = 20;
const ENEMY_PORTRAIT_SIZE = ENEMY_PORTRAIT_RADIUS * 2;
const ENEMY_BAR_WIDTH = 100;
const ENEMY_HUD_WIDTH = ENEMY_PORTRAIT_SIZE + BAR_GAP + ENEMY_BAR_WIDTH;
const ENEMY_HUD_HEIGHT = ENEMY_PORTRAIT_SIZE + NAME_GAP + NAME_HEIGHT;
const ENEMY_PORTRAIT_FONT = "22px monospace";

/** Draw the targeted enemy's portrait to the right of the player HUD. */
export function drawEnemyHud(
  ctx: CanvasRenderingContext2D,
  origin: Point,
  enemy: EnemyHudInfo,
): void {
  ctx.setLineDash([]);
  drawPanelBacking(ctx, origin, ENEMY_HUD_WIDTH, ENEMY_HUD_HEIGHT);

  // Portrait circle with enemy glyph.
  const cx = origin.x + ENEMY_PORTRAIT_RADIUS;
  const cy = origin.y + ENEMY_PORTRAIT_RADIUS;

  ctx.beginPath();
  ctx.arc(cx, cy, ENEMY_PORTRAIT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = "#0a0a0a";
  ctx.fill();
  ctx.strokeStyle = enemy.color;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.font = ENEMY_PORTRAIT_FONT;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = enemy.color;
  ctx.fillText(enemy.glyph, cx, cy);

  // Health bar to the right of the portrait, vertically centred.
  const barX = origin.x + ENEMY_PORTRAIT_SIZE + BAR_GAP;
  const barY = origin.y + (ENEMY_PORTRAIT_SIZE - BAR_HEIGHT) / 2;
  drawBar(ctx, { x: barX, y: barY, width: ENEMY_BAR_WIDTH, height: BAR_HEIGHT },
    enemy.health, enemy.maxHealth, "#c0392b");

  // Name below.
  ctx.font = NAME_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#dddddd";
  ctx.fillText(enemy.name, origin.x, origin.y + ENEMY_PORTRAIT_SIZE + NAME_GAP);
}
