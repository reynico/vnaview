export interface PanelColors {
  bg: string;
  border: string;
  text: string;
}

export type PanelCorner = 'bottom-left' | 'bottom-right';

const PADDING = 10;
const MARGIN = 12;
const LINE_HEIGHT = 18;
const FONT_SIZE = 12;
const FONT_FAMILY = "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace";

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Draws a bordered box of monospace text lines onto the canvas, anchored to
 *  a corner - mirrors where the marker table / BW overlay sit on screen, so
 *  a PNG export composited with this looks like what the app shows live. */
export function drawTextPanel(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  lines: string[],
  corner: PanelCorner,
  scale: number,
  colors: PanelColors,
): void {
  if (lines.length === 0) return;
  const pad = PADDING * scale;
  const margin = MARGIN * scale;
  const lineH = LINE_HEIGHT * scale;
  ctx.font = `${FONT_SIZE * scale}px ${FONT_FAMILY}`;
  const textWidth = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const boxW = textWidth + pad * 2;
  const boxH = lines.length * lineH + pad * 2;
  const x = corner === 'bottom-left' ? margin : canvasWidth - margin - boxW;
  const y = canvasHeight - margin - boxH;

  ctx.fillStyle = colors.bg;
  ctx.strokeStyle = colors.border;
  ctx.lineWidth = 2 * scale;
  roundedRectPath(ctx, x, y, boxW, boxH, 4 * scale);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = colors.text;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => ctx.fillText(line, x + pad, y + pad + i * lineH));
}
