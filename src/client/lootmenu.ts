/**
 * The inspect menu: what a body is carrying. A grey panel in the middle of the
 * room with the inspected thing's name at the top and a ✕ to close it.
 *
 * Layout comes from `shared/loot.ts` — the server needs the same rectangles to
 * decide what a click landed on.
 */

import {
  LOOT_CLOSE_RECT,
  LOOT_MENU_RECT,
  LOOT_MENU_TITLE_HEIGHT,
  hitsRect,
} from "../shared/loot.js";
import type { Point } from "../shared/movement.js";
import type { GameSnapshot } from "../shared/protocol.js";

const TITLE_FONT = "14px monospace";
const ITEM_FONT = "12px monospace";

const PANEL_FILL = "#3a3a3a";
const PANEL_BORDER = "#8a8a8a";
const TITLE_FILL = "#2a2a2a";
const TITLE_COLOR = "#e8e8e8";
const EMPTY_COLOR = "#8a8a8a";
const CLOSE_COLOR = "#cccccc";
const CLOSE_HOVER_COLOR = "#ffd633";

const PADDING = 12;
const ITEM_HEIGHT = 18;

export function drawLootMenu(
  ctx: CanvasRenderingContext2D,
  inspect: NonNullable<GameSnapshot["inspect"]>,
  cursor: Point | null,
): void {
  const r = LOOT_MENU_RECT;

  ctx.setLineDash([]);
  ctx.fillStyle = PANEL_FILL;
  ctx.fillRect(r.x, r.y, r.width, r.height);
  ctx.strokeStyle = PANEL_BORDER;
  ctx.lineWidth = 2;
  ctx.strokeRect(r.x + 1, r.y + 1, r.width - 2, r.height - 2);

  // Title bar: the thing being inspected, e.g. "Hellhound (dead)".
  ctx.fillStyle = TITLE_FILL;
  ctx.fillRect(r.x + 2, r.y + 2, r.width - 4, LOOT_MENU_TITLE_HEIGHT);
  ctx.font = TITLE_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = TITLE_COLOR;
  ctx.fillText(inspect.title, r.x + PADDING, r.y + 2 + LOOT_MENU_TITLE_HEIGHT / 2);

  drawCloseButton(ctx, cursor);

  const bodyTop = r.y + 2 + LOOT_MENU_TITLE_HEIGHT;

  if (inspect.loot.length === 0) {
    // A hellhound carries nothing — say so, or the panel reads as broken.
    ctx.font = ITEM_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = EMPTY_COLOR;
    ctx.fillText("(empty)", r.x + r.width / 2, bodyTop + (r.y + r.height - bodyTop) / 2);
    return;
  }

  ctx.font = ITEM_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = TITLE_COLOR;
  inspect.loot.forEach((item, i) => {
    ctx.fillText(item.name, r.x + PADDING, bodyTop + PADDING + i * ITEM_HEIGHT);
  });
}

function drawCloseButton(ctx: CanvasRenderingContext2D, cursor: Point | null): void {
  const c = LOOT_CLOSE_RECT;
  const inset = 5;

  ctx.strokeStyle = cursor && hitsRect(c, cursor) ? CLOSE_HOVER_COLOR : CLOSE_COLOR;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(c.x + inset, c.y + inset);
  ctx.lineTo(c.x + c.width - inset, c.y + c.height - inset);
  ctx.moveTo(c.x + c.width - inset, c.y + inset);
  ctx.lineTo(c.x + inset, c.y + c.height - inset);
  ctx.stroke();
}
