import { type TouchstoneData, type DataPoint, toDB, toPhase, toVSWR, mag, groupDelay, paramIndices } from './parser';
import { t } from './prefs';

export type View = 'db' | 'phase' | 'vswr' | 'groupdelay' | 'smith' | 'polar';

export interface ChartEntry {
  label: string;
  color: string;
  data: TouchstoneData;
  /** Dimmed/dashed ghost trace (trace memory), rendered but excluded from marker glyphs. */
  isMemory?: boolean;
}

export interface Marker {
  id: number;
  freq: number;
  /** Index into a point's params[] (0=S11, 1=S21, 2=S12, 3=S22). */
  param: number;
  /** Which file this marker belongs to in compare mode; unused/undefined
   *  outside compare mode, where the single active file is unambiguous. */
  fileLabel?: string;
}

export interface TraceStyle {
  color?: string;
  width?: number;
}

export interface ChartCallbacks {
  onMarkerAdd: (freqHz: number, param: number, fileLabel?: string) => void;
  onMarkerDrag: (markerId: number, rawFreqHz: number) => void;
  /** null means autorange (reset zoom). */
  onZoomChange: (range: [number, number] | null) => void;
}

export const PARAM_NAMES = ['S11', 'S21', 'S12', 'S22'];

const MONO_FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace";

// Colors are read from the CSS custom properties at render time so the
// canvas stays in sync with style.css instead of duplicating hex values
// that can drift out of sync with the theme.
export function theme() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--bg', '#050a05'),
    border: read('--border', '#1f4620'),
    muted: read('--muted', '#1f8f1f'),
    text: read('--text', '#33ff33'),
    danger: read('--danger', '#ff3b30'),
    marker: read('--marker', '#ffe14d'),
    markerActive: read('--marker-active', '#f8fafc'),
    markerDelta: read('--marker-delta', '#ff5ec2'),
    memory: read('--memory', '#7a8a99'),
    singleColors: [
      read('--trace-s11', '#33ff33'),
      read('--trace-s21', '#ffb000'),
      read('--trace-s12', '#7dffb2'),
      read('--trace-s22', '#ff5533'),
    ],
  };
}

// Per-parameter trace colors for the single-file (non-compare) views. Read
// from CSS custom properties so they flip with the dark/light theme, same as
// the rest of theme().
export function singleColors(): string[] {
  return theme().singleColors;
}

function computeYRange(view: View, perDiv: number, ref: number): [number, number] {
  switch (view) {
    case 'db':
      return [ref - perDiv * 8, ref + perDiv * 2];
    case 'phase':
      return [ref - perDiv * 5, ref + perDiv * 5];
    case 'vswr':
      return [ref - perDiv * 10, ref];
    case 'groupdelay':
      return [ref - perDiv * 5, ref + perDiv * 5];
    default:
      return [ref - perDiv * 5, ref + perDiv * 5];
  }
}

// Group Delay is a derivative across points (not a per-point transform like
// toDB/toPhase/toVSWR), so it needs its own array-level path rather than a
// single Complex->number fn.
function computeYValues(data: TouchstoneData, param: number, view: View): number[] {
  if (view === 'groupdelay') {
    return groupDelay(data.points, param).map((v) => v * 1e9);
  }
  const fn = view === 'db' ? toDB : view === 'phase' ? toPhase : toVSWR;
  const raw = data.points.map((p) => fn(p.params[param]));
  return view === 'vswr' ? raw.map((v) => Math.round(v * 100) / 100) : raw;
}

function yAxisTitle(view: View): string {
  return view === 'db' ? `${t('magnitude')} (dB)`
    : view === 'phase' ? `${t('phase')} (°)`
    : view === 'groupdelay' ? `${t('groupDelay')} (ns)`
    : 'VSWR';
}

function plotTitle(entries: ChartEntry[], view: View | 'smith' | 'polar'): string {
  const files = entries.map((e) => e.label).join(', ');

  let params: string;
  if (view === 'smith') {
    params = 'S11 · Smith Chart';
  } else if (view === 'polar') {
    if (entries.length > 1) {
      params = `S11${entries.some((e) => e.data.ports === 2) ? ', S21' : ''} · Polar`;
    } else {
      const { ports, full } = entries[0].data;
      params = `${ports === 1 ? 'S11' : full === false ? 'S11, S21' : 'S11–S22'} · Polar`;
    }
  } else {
    const viewLabel = yAxisTitle(view);
    if (entries.length > 1) {
      params = `S11${entries.some((e) => e.data.ports === 2) ? ', S21' : ''} · ${viewLabel}`;
    } else {
      const { ports, full } = entries[0].data;
      const measured =
        ports === 1 ? 'S11'
        : full === false ? (view === 'vswr' ? 'S11' : 'S11, S21')
        : view === 'vswr' ? 'S11, S22'
        : 'S11–S22';
      params = `${measured} · ${viewLabel}`;
    }
  }

  return `${files} · ${params}`;
}

function glyphColor(markerId: number, activeMarkerId: number | null, deltaRefId: number | null): string {
  const th = theme();
  if (markerId === deltaRefId) return th.markerDelta;
  if (markerId === activeMarkerId) return th.markerActive;
  return th.marker;
}

function nearestIndex(points: DataPoint[], freq: number): number {
  let idx = 0;
  let minDist = Infinity;
  for (let k = 0; k < points.length; k++) {
    const d = Math.abs(points[k].freq - freq);
    if (d < minDist) {
      minDist = d;
      idx = k;
    }
  }
  return idx;
}

function nearestArrIndex(values: number[], v: number): number {
  let idx = 0;
  let minDist = Infinity;
  for (let k = 0; k < values.length; k++) {
    const d = Math.abs(values[k] - v);
    if (d < minDist) {
      minDist = d;
      idx = k;
    }
  }
  return idx;
}

function dataExtentOf(entries: ChartEntry[]): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const e of entries) {
    for (const p of e.data.points) {
      if (p.freq < min) min = p.freq;
      if (p.freq > max) max = p.freq;
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

// Shared by wheel-zoom, the zoom in/out/reset buttons, and drag-select: keeps
// the visible span from collapsing to nothing (a floor relative to the full
// sweep, so it scales with however wide the loaded data actually is) and
// from growing past the full sweep (so "zoom out" naturally bottoms out at
// the same view Reset gives you, instead of drifting into empty space).
export function clampFreqRangeHz(min: number, max: number, dataExtentHz: [number, number] | null): [number, number] {
  if (!dataExtentHz || !(max > min)) return min < max ? [min, max] : [min, min + 1];
  const [dMin, dMax] = dataExtentHz;
  const fullSpan = Math.max(dMax - dMin, 1);
  const minSpan = Math.max(fullSpan * 0.002, 1);
  const span = Math.min(Math.max(max - min, minSpan), fullSpan);
  const center = (min + max) / 2;
  let newMin = center - span / 2;
  let newMax = center + span / 2;
  if (newMin < dMin) {
    newMax += dMin - newMin;
    newMin = dMin;
  }
  if (newMax > dMax) {
    newMin -= newMax - dMax;
    newMax = dMax;
  }
  return [Math.max(newMin, dMin), Math.min(newMax, dMax)];
}

function trimTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

function formatFreqTick(mhz: number): string {
  return trimTrailingZeros(mhz.toFixed(3)) || '0';
}

function formatYTick(v: number): string {
  return Math.abs(v) < 1 && v !== 0 ? v.toFixed(2) : v.toFixed(1);
}

function formatHoverValue(v: number, view: View): string {
  if (view === 'db') return `${v.toFixed(2)} dB`;
  if (view === 'phase') return `${v.toFixed(1)}°`;
  if (view === 'groupdelay') return `${v.toFixed(2)} ns`;
  return v.toFixed(2);
}

// "Nice" round-number tick generator (1/2/5 x 10^n steps) - Plotly did this
// automatically; canvas needs it hand-rolled.
function niceTicks(min: number, max: number, targetCount: number): number[] {
  if (!(max > min) || targetCount < 1) return [min];
  const rawStep = (max - min) / targetCount;
  const mag10 = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag10;
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * mag10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

interface RectTrace {
  label: string;
  param: number;
  fileLabel?: string;
  freqsMHz: number[];
  values: number[];
}

interface PolarTrace {
  label: string;
  param: number;
  fileLabel?: string;
  re: number[];
  im: number[];
  freqsHz: number[];
}

interface Frame {
  view: View | 'smith' | 'polar';
  plotL: number;
  plotT: number;
  plotR: number;
  plotB: number;
  xMin: number;
  xMax: number;
  x: (dataX: number) => number;
  y: (dataY: number) => number;
  xInv: (px: number) => number;
  rectTraces: RectTrace[];
  polarTraces: PolarTrace[];
  markerLines: Array<{ id: number; x: number }>;
  /** Full sweep range in Hz, for clamping wheel/pan/button zoom - null for
   *  Smith/Polar (no frequency axis to clamp). */
  dataExtentHz: [number, number] | null;
}

interface RenderArgs {
  entries: ChartEntry[];
  view: View;
  markers: Marker[];
  dbPerDiv: number;
  refLevel: number;
  freqRange: [number, number] | null;
  activeMarkerId: number | null;
  deltaRefId: number | null;
  limitUpper: number | null;
  limitLower: number | null;
  hiddenTraces: Set<string>;
  traceOverrides: Map<string, TraceStyle>;
  showMemoryDelta: boolean;
  xDivisions: number;
}

type DragMode = 'none' | 'marker' | 'zoom-select' | 'pan';

/** Owns a <canvas>, its HiDPI sizing/resize, and all pointer/wheel
 *  interaction. Every draw call and every hit-test read/write the same
 *  `frame` transform, so clicks always land exactly on what's drawn. */
export class ChartCanvas {
  private canvas: HTMLCanvasElement;
  private wrapEl: HTMLElement;
  private ctx: CanvasRenderingContext2D;
  private ro: ResizeObserver;
  private cb: ChartCallbacks;
  private dpr = 1;

  private lastArgs: RenderArgs | null = null;
  private frame: Frame | null = null;

  private downPix: { x: number; y: number } | null = null;
  private pendingClickTimer: number | null = null;
  private dragMode: DragMode = 'none';
  private dragMarkerId = -1;
  private livePreviewMarkerId: number | null = null;
  private livePreviewFreqHz: number | null = null;
  private dragStartX = 0;
  private dragCurrentX = 0;
  private panStartX = 0;
  private panStartRangeMHz: [number, number] | null = null;
  private livePanRangeMHz: [number, number] | null = null;
  private hoverPix: { x: number; y: number } | null = null;

  constructor(canvas: HTMLCanvasElement, wrapEl: HTMLElement, callbacks: ChartCallbacks) {
    this.canvas = canvas;
    this.wrapEl = wrapEl;
    this.cb = callbacks;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('vnaviewer: canvas 2d context unavailable');
    this.ctx = ctx;
    this.resize();
    this.ro = new ResizeObserver(() => {
      this.resize();
      this.draw();
    });
    this.ro.observe(wrapEl);
    this.attachInteractions();
  }

  render(
    entries: ChartEntry[],
    view: View,
    markers: Marker[],
    dbPerDiv: number,
    refLevel: number,
    freqRange: [number, number] | null,
    activeMarkerId: number | null,
    deltaRefId: number | null,
    limitUpper: number | null,
    limitLower: number | null,
    hiddenTraces: Set<string>,
    traceOverrides: Map<string, TraceStyle>,
    showMemoryDelta: boolean,
    xDivisions: number,
  ): void {
    this.lastArgs = {
      entries, view, markers, dbPerDiv, refLevel, freqRange, activeMarkerId, deltaRefId,
      limitUpper, limitLower, hiddenTraces, traceOverrides, showMemoryDelta, xDivisions,
    };
    this.draw();
  }

  /** Redraws the last render onto a fresh offscreen canvas at `scale`x, for
   *  compositing into a PNG export - doesn't touch the live on-screen frame. */
  exportPng(scale = 2): HTMLCanvasElement {
    const off = document.createElement('canvas');
    if (!this.lastArgs) {
      off.width = 1;
      off.height = 1;
      return off;
    }
    const rect = this.wrapEl.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    off.width = Math.round(cssW * scale);
    off.height = Math.round(cssH * scale);
    const offCtx = off.getContext('2d')!;
    offCtx.setTransform(scale, 0, 0, scale, 0, 0);

    const prevCtx = this.ctx;
    const prevFrame = this.frame;
    this.ctx = offCtx;
    const view = this.lastArgs.view;
    if (view === 'smith') this.drawRadial(cssW, cssH, 'smith');
    else if (view === 'polar') this.drawRadial(cssW, cssH, 'polar');
    else this.drawRectangular(cssW, cssH);
    this.ctx = prevCtx;
    this.frame = prevFrame;
    // Reset to the identity transform so callers compositing on top (marker
    // table / BW box, see chartExport.ts) can draw in plain device-pixel
    // coordinates matching off.width/off.height, same contract as any other
    // freshly-created canvas.
    offCtx.setTransform(1, 0, 0, 1, 0, 0);

    return off;
  }

  private resize(): void {
    const rect = this.wrapEl.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    const wantW = Math.round(w * this.dpr);
    const wantH = Math.round(h * this.dpr);
    if (this.canvas.width !== wantW) this.canvas.width = wantW;
    if (this.canvas.height !== wantH) this.canvas.height = wantH;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private draw(): void {
    if (!this.lastArgs) return;
    const rect = this.wrapEl.getBoundingClientRect();
    const cssW = Math.max(1, rect.width);
    const cssH = Math.max(1, rect.height);
    const wantW = Math.round(cssW * this.dpr);
    const wantH = Math.round(cssH * this.dpr);
    if (this.canvas.width !== wantW || this.canvas.height !== wantH) this.resize();

    const view = this.lastArgs.view;
    if (view === 'smith') this.drawRadial(cssW, cssH, 'smith');
    else if (view === 'polar') this.drawRadial(cssW, cssH, 'polar');
    else this.drawRectangular(cssW, cssH);
  }

  private strokeTrace(
    freqsMHz: number[],
    values: number[],
    xf: (v: number) => number,
    yf: (v: number) => number,
    color: string,
    width: number,
    dashed: boolean,
  ): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = dashed ? 0.5 : 1;
    ctx.setLineDash(dashed ? [4, 3] : []);
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        started = false;
        continue;
      }
      const px = xf(freqsMHz[i]);
      const py = yf(v);
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else {
        ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  private drawMarkerGlyph(px: number, py: number, color: string, label: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(px, py - 6);
    ctx.lineTo(px - 6, py + 4);
    ctx.lineTo(px + 6, py + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = `10px ${MONO_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, px, py - 8);
  }

  private drawRectangular(cssW: number, cssH: number): void {
    const a = this.lastArgs!;
    const th = theme();
    const ctx = this.ctx;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const pad = { top: 30, right: 18, bottom: 46, left: 60 };
    const plotL = pad.left;
    const plotT = pad.top;
    const plotR = cssW - pad.right;
    const plotB = cssH - pad.bottom;
    const plotW = Math.max(1, plotR - plotL);
    const plotH = Math.max(1, plotB - plotT);

    const compare = a.entries.length > 1;
    const dataExtentHz = dataExtentOf(a.entries);
    const range = this.dragMode === 'pan' && this.livePanRangeMHz
      ? [this.livePanRangeMHz[0] * 1e6, this.livePanRangeMHz[1] * 1e6]
      : a.freqRange ?? dataExtentHz ?? [0, 1];
    const xMinMHz = range[0] / 1e6;
    const xMaxMHz = range[1] / 1e6;

    let yMin: number;
    let yMax: number;
    let yTicks: number[];
    let titleText: string;
    let yTitle: string;

    const memMain = a.showMemoryDelta ? a.entries.find((e) => !e.isMemory) : undefined;
    const memGhost = a.showMemoryDelta ? a.entries.find((e) => e.isMemory) : undefined;
    const deltaSpecs: Array<{ param: number; delta: number[]; color: string }> = [];

    if (a.showMemoryDelta && memMain && memGhost) {
      const colors = singleColors();
      const idxs = paramIndices(memMain.data, false).filter((i) => paramIndices(memGhost.data, false).includes(i));
      let maxAbs = 0;
      for (const i of idxs) {
        if (a.view === 'vswr' && i !== 0 && i !== 3) continue;
        if (a.hiddenTraces.has(`${memMain.label}#${i}`)) continue;
        const curY = computeYValues(memMain.data, i, a.view);
        const memY = computeYValues(memGhost.data, i, a.view);
        const delta = memMain.data.points.map((p, idx) => curY[idx] - memY[nearestIndex(memGhost.data.points, p.freq)]);
        for (const d of delta) if (Number.isFinite(d)) maxAbs = Math.max(maxAbs, Math.abs(d));
        deltaSpecs.push({ param: i, delta, color: colors[i] });
      }
      const padY = maxAbs > 0 ? maxAbs * 1.15 : 1;
      yMin = -padY;
      yMax = padY;
      yTicks = niceTicks(yMin, yMax, 8);
      titleText = `${memMain.label} − ${memGhost.label}`;
      yTitle = `Δ ${yAxisTitle(a.view)}`;
    } else {
      [yMin, yMax] = computeYRange(a.view, a.dbPerDiv, a.refLevel);
      const yDivs = 10;
      const yStep = (yMax - yMin) / yDivs;
      yTicks = Array.from({ length: yDivs + 1 }, (_, i) => yMin + i * yStep);
      titleText = plotTitle(a.entries, a.view);
      yTitle = yAxisTitle(a.view);
    }

    const xScale = plotW / Math.max(1e-9, xMaxMHz - xMinMHz);
    const yScale = plotH / Math.max(1e-9, yMax - yMin);
    const xf = (mhz: number) => plotL + (mhz - xMinMHz) * xScale;
    const yf = (v: number) => plotB - (v - yMin) * yScale;
    const xInv = (px: number) => xMinMHz + (px - plotL) / xScale;

    // grid
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotW, plotH);
    ctx.clip();
    const xTicks = niceTicks(xMinMHz, xMaxMHz, a.xDivisions);
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    for (const tx of xTicks) {
      const px = Math.round(xf(tx)) + 0.5;
      ctx.moveTo(px, plotT);
      ctx.lineTo(px, plotB);
    }
    for (const ty of yTicks) {
      const py = Math.round(yf(ty)) + 0.5;
      ctx.moveTo(plotL, py);
      ctx.lineTo(plotR, py);
    }
    ctx.stroke();
    ctx.restore();

    // tick labels
    ctx.fillStyle = th.muted;
    ctx.font = `11px ${MONO_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const tx of xTicks) {
      if (xf(tx) < plotL - 1 || xf(tx) > plotR + 1) continue;
      ctx.fillText(formatFreqTick(tx), xf(tx), plotB + 6);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const ty of yTicks) {
      ctx.fillText(formatYTick(ty), plotL - 8, yf(ty));
    }

    // axis titles
    ctx.fillStyle = th.text;
    ctx.font = `12px ${MONO_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${t('frequency')} (MHz)`, plotL + plotW / 2, cssH - 6);
    ctx.save();
    ctx.translate(14, plotT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(yTitle, 0, 0);
    ctx.restore();

    // traces
    const rectTraces: RectTrace[] = [];
    ctx.save();
    ctx.beginPath();
    ctx.rect(plotL, plotT, plotW, plotH);
    ctx.clip();

    if (a.showMemoryDelta && memMain) {
      const freqsMHz = memMain.data.points.map((p) => p.freq / 1e6);
      for (const spec of deltaSpecs) {
        this.strokeTrace(freqsMHz, spec.delta, xf, yf, spec.color, 1.5, false);
        rectTraces.push({ label: memMain.label, param: spec.param, fileLabel: undefined, freqsMHz, values: spec.delta });
      }
    } else {
      const colors = singleColors();
      for (const entry of a.entries) {
        const { label, color, data, isMemory } = entry;
        const freqsMHz = data.points.map((p) => p.freq / 1e6);
        if (compare) {
          for (const i of paramIndices(data, true)) {
            if (a.hiddenTraces.has(`${label}#${i}`)) continue;
            const ov = a.traceOverrides.get(`${label}#${i}`);
            const traceColor = ov?.color ?? color;
            const width = ov?.width ?? 1.5;
            const values = computeYValues(data, i, a.view);
            this.strokeTrace(freqsMHz, values, xf, yf, traceColor, width, !!isMemory);
            rectTraces.push({ label, param: i, fileLabel: label, freqsMHz, values });
          }
        } else {
          for (const i of paramIndices(data, false)) {
            if (a.view === 'vswr' && i !== 0 && i !== 3) continue;
            if (a.hiddenTraces.has(`${label}#${i}`)) continue;
            const ov = a.traceOverrides.get(`${label}#${i}`);
            const traceColor = ov?.color ?? colors[i];
            const width = ov?.width ?? 1.5;
            const values = computeYValues(data, i, a.view);
            this.strokeTrace(freqsMHz, values, xf, yf, traceColor, width, false);
            rectTraces.push({ label, param: i, fileLabel: undefined, freqsMHz, values });
          }
        }
      }
    }
    ctx.restore();

    const markerLines: Array<{ id: number; x: number }> = [];

    if (!a.showMemoryDelta) {
      // limit lines (dB view only)
      if (a.view === 'db') {
        ctx.strokeStyle = th.danger;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        for (const lv of [a.limitUpper, a.limitLower]) {
          if (lv === null) continue;
          const py = yf(lv);
          ctx.beginPath();
          ctx.moveTo(plotL, py);
          ctx.lineTo(plotR, py);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      // marker lines
      ctx.strokeStyle = th.marker;
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      for (const m of a.markers) {
        const freqMHz = this.livePreviewMarkerId === m.id && this.livePreviewFreqHz !== null
          ? this.livePreviewFreqHz / 1e6
          : m.freq / 1e6;
        const px = xf(freqMHz);
        markerLines.push({ id: m.id, x: px });
        ctx.beginPath();
        ctx.moveTo(px, plotT);
        ctx.lineTo(px, plotB);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // marker glyphs
      for (const entry of a.entries) {
        if (entry.isMemory) continue;
        const { label, data } = entry;
        const paramsToPlot = compare
          ? paramIndices(data, true)
          : paramIndices(data, false).filter((i) => !(a.view === 'vswr' && i !== 0 && i !== 3));
        for (const i of paramsToPlot) {
          if (a.hiddenTraces.has(`${label}#${i}`)) continue;
          const paramMarkers = a.markers.filter((m) => m.param === i && (!compare || m.fileLabel === label));
          if (paramMarkers.length === 0) continue;
          const values = computeYValues(data, i, a.view);
          for (const m of paramMarkers) {
            const idx = nearestIndex(data.points, m.freq);
            const px = xf(data.points[idx].freq / 1e6);
            const py = yf(values[idx]);
            const color = glyphColor(m.id, a.activeMarkerId, a.deltaRefId);
            this.drawMarkerGlyph(px, py, color, String(a.markers.indexOf(m) + 1));
          }
        }
      }
    }

    // title
    ctx.fillStyle = th.muted;
    ctx.font = `12px ${MONO_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(titleText, plotL, 8);

    // zoom-select overlay
    if (this.dragMode === 'zoom-select') {
      const x0 = Math.min(this.dragStartX, this.dragCurrentX);
      const x1 = Math.max(this.dragStartX, this.dragCurrentX);
      ctx.fillStyle = 'rgba(255, 225, 77, 0.15)';
      ctx.fillRect(x0, plotT, x1 - x0, plotH);
      ctx.strokeStyle = th.marker;
      ctx.lineWidth = 1;
      ctx.strokeRect(x0, plotT, x1 - x0, plotH);
    }

    // hover crosshair + nearest-value readout
    if (
      this.hoverPix && this.dragMode === 'none' &&
      this.hoverPix.x >= plotL && this.hoverPix.x <= plotR &&
      this.hoverPix.y >= plotT && this.hoverPix.y <= plotB
    ) {
      this.drawHoverReadout(rectTraces, xf, xInv, plotT, plotB, plotL, plotR, a.view, compare);
    }

    this.frame = {
      view: a.view,
      plotL, plotT, plotR, plotB,
      xMin: xMinMHz, xMax: xMaxMHz,
      x: xf, y: yf, xInv,
      rectTraces, polarTraces: [], markerLines,
      dataExtentHz,
    };
  }

  private drawHoverReadout(
    rectTraces: RectTrace[],
    xf: (v: number) => number,
    xInv: (px: number) => number,
    plotT: number,
    plotB: number,
    plotL: number,
    plotR: number,
    view: View,
    compare: boolean,
  ): void {
    const ctx = this.ctx;
    const th = theme();
    const hoverFreqMHz = xInv(this.hoverPix!.x);
    let nearest: { tr: RectTrace; idx: number; dist: number } | null = null;
    for (const tr of rectTraces) {
      const idx = nearestArrIndex(tr.freqsMHz, hoverFreqMHz);
      const dist = Math.abs(tr.freqsMHz[idx] - hoverFreqMHz);
      if (!nearest || dist < nearest.dist) nearest = { tr, idx, dist };
    }
    if (!nearest || !Number.isFinite(nearest.tr.values[nearest.idx])) return;

    const px = xf(nearest.tr.freqsMHz[nearest.idx]);
    ctx.strokeStyle = th.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(px, plotT);
    ctx.lineTo(px, plotB);
    ctx.stroke();
    ctx.setLineDash([]);

    const prefix = compare ? `${nearest.tr.label} · ${PARAM_NAMES[nearest.tr.param]}` : PARAM_NAMES[nearest.tr.param];
    const label = `${prefix}  ${nearest.tr.freqsMHz[nearest.idx].toFixed(3)} MHz  ${formatHoverValue(nearest.tr.values[nearest.idx], view)}`;
    ctx.font = `10px ${MONO_FONT}`;
    const textW = ctx.measureText(label).width;
    let boxX = px + 8;
    if (boxX + textW + 10 > plotR) boxX = px - textW - 18;
    const boxY = plotT + 4;
    ctx.fillStyle = th.bg;
    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.fillRect(boxX, boxY, textW + 10, 16);
    ctx.strokeRect(boxX, boxY, textW + 10, 16);
    ctx.fillStyle = th.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, boxX + 5, boxY + 8);
  }

  private strokePoly(xs: number[], ys: number[], xf: (v: number) => number, yf: (v: number) => number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      const px = xf(xs[i]);
      const py = yf(ys[i]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  private drawSmithGrid(xf: (v: number) => number, yf: (v: number) => number): void {
    const N = 360;
    const theta = Array.from({ length: N + 1 }, (_, i) => (i * Math.PI * 2) / N);

    this.strokePoly(theta.map(Math.cos), theta.map(Math.sin), xf, yf);

    for (const r of [0.5, 1, 2, 5]) {
      const cx = r / (1 + r);
      const rad = 1 / (1 + r);
      const pts = theta
        .map((th) => ({ x: cx + rad * Math.cos(th), y: rad * Math.sin(th) }))
        .filter((p) => p.x ** 2 + p.y ** 2 <= 1.002);
      this.strokePoly(pts.map((p) => p.x), pts.map((p) => p.y), xf, yf);
    }

    for (const x of [0.5, 1, 2]) {
      for (const s of [1, -1]) {
        const pts = theta
          .map((th) => ({ x: 1 + (1 / x) * Math.cos(th), y: s / x + (1 / x) * Math.sin(th) }))
          .filter((p) => p.x ** 2 + p.y ** 2 <= 1.002);
        if (pts.length > 1) this.strokePoly(pts.map((p) => p.x), pts.map((p) => p.y), xf, yf);
      }
    }
  }

  private drawPolarGrid(maxR: number, xf: (v: number) => number, yf: (v: number) => number): void {
    const N = 360;
    const theta = Array.from({ length: N + 1 }, (_, i) => (i * Math.PI * 2) / N);

    const rings = 4;
    for (let k = 1; k <= rings; k++) {
      const r = (maxR * k) / rings;
      this.strokePoly(theta.map((th) => r * Math.cos(th)), theta.map((th) => r * Math.sin(th)), xf, yf);
    }

    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      this.strokePoly([0, maxR * Math.cos(rad)], [0, maxR * Math.sin(rad)], xf, yf);
    }
  }

  private drawRadial(cssW: number, cssH: number, mode: 'smith' | 'polar'): void {
    const a = this.lastArgs!;
    const th = theme();
    const ctx = this.ctx;
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const pad = { top: 30, right: 16, bottom: 16, left: 16 };
    const plotL = pad.left;
    const plotT = pad.top;
    const plotR = cssW - pad.right;
    const plotB = cssH - pad.bottom;
    const plotW = Math.max(1, plotR - plotL);
    const plotH = Math.max(1, plotB - plotT);

    const compare = a.entries.length > 1;
    let dataMaxR = 1;
    if (mode === 'polar') {
      for (const { label, data } of a.entries) {
        for (const i of paramIndices(data, compare)) {
          if (a.hiddenTraces.has(`${label}#${i}`)) continue;
          for (const p of data.points) {
            const m = mag(p.params[i]);
            if (m > dataMaxR) dataMaxR = m;
          }
        }
      }
      dataMaxR = Math.ceil(dataMaxR * 5) / 5;
    }
    const R = mode === 'smith' ? 1.1 : dataMaxR * 1.05;

    const scale = Math.min(plotW, plotH) / (2 * R);
    const cx = plotL + plotW / 2;
    const cy = plotT + plotH / 2;
    const xf = (re: number) => cx + re * scale;
    const yf = (im: number) => cy - im * scale;
    const xInv = (px: number) => (px - cx) / scale;

    ctx.strokeStyle = th.border;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    if (mode === 'smith') this.drawSmithGrid(xf, yf);
    else this.drawPolarGrid(dataMaxR, xf, yf);

    const polarTraces: PolarTrace[] = [];
    const colors = singleColors();

    for (const entry of a.entries) {
      const { label, color, data, isMemory } = entry;
      const paramIdxs = mode === 'smith' ? [0] : paramIndices(data, compare);
      for (const i of paramIdxs) {
        if (a.hiddenTraces.has(`${label}#${i}`)) continue;
        const ov = a.traceOverrides.get(`${label}#${i}`);
        const traceColor = ov?.color ?? (mode === 'smith' ? color : compare ? color : colors[i]);
        const width = ov?.width ?? (mode === 'smith' ? 2 : 1.5);
        const re = data.points.map((p) => p.params[i].re);
        const im = data.points.map((p) => p.params[i].im);
        const freqsHz = data.points.map((p) => p.freq);

        ctx.strokeStyle = traceColor;
        ctx.lineWidth = width;
        ctx.globalAlpha = isMemory ? 0.5 : 1;
        ctx.setLineDash(isMemory ? [4, 3] : []);
        this.strokePoly(re, im, xf, yf);
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        polarTraces.push({ label, param: i, fileLabel: compare ? label : undefined, re, im, freqsHz });

        if (isMemory) continue;
        const paramMarkers = a.markers.filter((m) => m.param === i && (!compare || m.fileLabel === label));
        for (const m of paramMarkers) {
          const idx = nearestIndex(data.points, m.freq);
          const px = xf(re[idx]);
          const py = yf(im[idx]);
          const color = glyphColor(m.id, a.activeMarkerId, a.deltaRefId);
          this.drawMarkerGlyph(px, py, color, String(a.markers.indexOf(m) + 1));
        }
      }
    }

    ctx.fillStyle = th.muted;
    ctx.font = `12px ${MONO_FONT}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(plotTitle(a.entries, mode), plotL, 8);

    this.frame = {
      view: mode,
      plotL, plotT, plotR, plotB,
      xMin: -R, xMax: R,
      x: xf, y: yf, xInv,
      rectTraces: [], polarTraces, markerLines: [],
      dataExtentHz: null,
    };
  }

  private pixelPos(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private inPlotArea(p: { x: number; y: number }, f: Frame): boolean {
    return p.x >= f.plotL && p.x <= f.plotR && p.y >= f.plotT && p.y <= f.plotB;
  }

  // Rectangular views also treat double-click as "reset zoom" - each click of
  // that gesture fires its own pointerup first, so placing a marker
  // immediately would drop a stray one before the browser recognizes the
  // dblclick. Deferring long enough for a second click to cancel it keeps
  // single-click-to-mark and double-click-to-reset from stepping on each
  // other. Smith/Polar have no dblclick behavior, so no need to wait there.
  private scheduleClick(px: number, py: number): void {
    this.cancelPendingClick();
    if (!this.frame || this.frame.view === 'smith' || this.frame.view === 'polar') {
      this.handleClick(px, py);
      return;
    }
    this.pendingClickTimer = window.setTimeout(() => {
      this.pendingClickTimer = null;
      this.handleClick(px, py);
    }, 250);
  }

  private cancelPendingClick(): void {
    if (this.pendingClickTimer !== null) {
      window.clearTimeout(this.pendingClickTimer);
      this.pendingClickTimer = null;
    }
  }

  private handleClick(px: number, py: number): void {
    const f = this.frame;
    if (!f || !this.inPlotArea({ x: px, y: py }, f)) return;

    if (f.view === 'smith' || f.view === 'polar') {
      let best: { freqHz: number; param: number; fileLabel?: string } | null = null;
      let bestDist = Infinity;
      for (const tr of f.polarTraces) {
        for (let i = 0; i < tr.re.length; i++) {
          const tx = f.x(tr.re[i]);
          const ty = f.y(tr.im[i]);
          const d = (tx - px) ** 2 + (ty - py) ** 2;
          if (d < bestDist) {
            bestDist = d;
            best = { freqHz: tr.freqsHz[i], param: tr.param, fileLabel: tr.fileLabel };
          }
        }
      }
      if (best) this.cb.onMarkerAdd(best.freqHz, best.param, best.fileLabel);
      return;
    }

    const clickFreqMHz = f.xInv(px);
    let best: { freqHz: number; param: number; fileLabel?: string } | null = null;
    let bestDy = Infinity;
    for (const tr of f.rectTraces) {
      const idx = nearestArrIndex(tr.freqsMHz, clickFreqMHz);
      const val = tr.values[idx];
      if (!Number.isFinite(val)) continue;
      const dy = Math.abs(f.y(val) - py);
      if (dy < bestDy) {
        bestDy = dy;
        best = { freqHz: tr.freqsMHz[idx] * 1e6, param: tr.param, fileLabel: tr.fileLabel };
      }
    }
    if (best) this.cb.onMarkerAdd(best.freqHz, best.param, best.fileLabel);
  }

  private updateCursor(p: { x: number; y: number }): void {
    const f = this.frame;
    if (!f) {
      this.canvas.style.cursor = 'default';
      return;
    }
    if (f.view !== 'smith' && f.view !== 'polar') {
      const nearMarker = f.markerLines.some((ml) => Math.abs(ml.x - p.x) <= 6 && p.y >= f.plotT && p.y <= f.plotB);
      if (nearMarker) {
        this.canvas.style.cursor = 'ew-resize';
        return;
      }
      this.canvas.style.cursor = this.inPlotArea(p, f) ? 'grab' : 'default';
      return;
    }
    this.canvas.style.cursor = this.inPlotArea(p, f) ? 'crosshair' : 'default';
  }

  private attachInteractions(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', () => this.cancelDrag());
    canvas.addEventListener('pointerleave', () => {
      this.hoverPix = null;
      if (this.dragMode === 'none') this.draw();
    });
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('dblclick', () => this.onDblClick());
  }

  private onPointerDown(e: PointerEvent): void {
    this.cancelPendingClick();
    const p = this.pixelPos(e);
    this.downPix = p;
    this.dragMode = 'none';
    const f = this.frame;
    if (!f || f.view === 'smith' || f.view === 'polar') return;

    const hit = f.markerLines.find((ml) => Math.abs(ml.x - p.x) <= 6);
    if (hit && p.y >= f.plotT && p.y <= f.plotB) {
      this.dragMode = 'marker';
      this.dragMarkerId = hit.id;
      this.livePreviewMarkerId = hit.id;
      this.livePreviewFreqHz = null;
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (this.inPlotArea(p, f)) {
      // Shift+drag draws a rectangle to zoom into; a plain drag pans the
      // current view instead, matching drag-to-pan/shift-drag-to-zoom
      // conventions from other RF chart tools.
      if (e.shiftKey) {
        this.dragMode = 'zoom-select';
        this.dragStartX = p.x;
        this.dragCurrentX = p.x;
      } else {
        this.dragMode = 'pan';
        this.panStartX = p.x;
        this.panStartRangeMHz = [f.xMin, f.xMax];
        this.livePanRangeMHz = this.panStartRangeMHz;
        this.canvas.style.cursor = 'grabbing';
      }
      this.canvas.setPointerCapture(e.pointerId);
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const p = this.pixelPos(e);
    if (this.dragMode === 'marker' && this.frame) {
      this.livePreviewFreqHz = this.frame.xInv(p.x) * 1e6;
      this.draw();
      return;
    }
    if (this.dragMode === 'zoom-select') {
      this.dragCurrentX = p.x;
      this.draw();
      return;
    }
    if (this.dragMode === 'pan' && this.frame && this.panStartRangeMHz) {
      const pxPerMHz = (this.frame.plotR - this.frame.plotL) / (this.frame.xMax - this.frame.xMin);
      const deltaMHz = (p.x - this.panStartX) / pxPerMHz;
      let newMin = this.panStartRangeMHz[0] - deltaMHz;
      let newMax = this.panStartRangeMHz[1] - deltaMHz;
      const dataExtentHz = this.frame.dataExtentHz;
      if (dataExtentHz) {
        const span = newMax - newMin;
        const dMinMHz = dataExtentHz[0] / 1e6;
        const dMaxMHz = dataExtentHz[1] / 1e6;
        if (newMin < dMinMHz) {
          newMin = dMinMHz;
          newMax = dMinMHz + span;
        }
        if (newMax > dMaxMHz) {
          newMax = dMaxMHz;
          newMin = dMaxMHz - span;
        }
      }
      this.livePanRangeMHz = [newMin, newMax];
      this.draw();
      return;
    }
    this.hoverPix = p;
    this.updateCursor(p);
    this.draw();
  }

  private onPointerUp(e: PointerEvent): void {
    const p = this.pixelPos(e);
    if (this.dragMode === 'marker') {
      const id = this.dragMarkerId;
      const freqHz = this.livePreviewFreqHz;
      this.dragMode = 'none';
      this.livePreviewMarkerId = null;
      this.livePreviewFreqHz = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (freqHz !== null) this.cb.onMarkerDrag(id, freqHz);
      this.draw();
      return;
    }
    if (this.dragMode === 'zoom-select') {
      const dx = Math.abs(this.dragCurrentX - this.dragStartX);
      this.dragMode = 'none';
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (dx > 4 && this.frame) {
        const f1 = this.frame.xInv(this.dragStartX);
        const f2 = this.frame.xInv(this.dragCurrentX);
        const lo = Math.min(f1, f2) * 1e6;
        const hi = Math.max(f1, f2) * 1e6;
        this.cb.onZoomChange(clampFreqRangeHz(lo, hi, this.frame.dataExtentHz));
      } else {
        this.scheduleClick(p.x, p.y);
      }
      this.draw();
      return;
    }
    if (this.dragMode === 'pan') {
      const dx = Math.abs(p.x - this.panStartX);
      const range = this.livePanRangeMHz;
      this.dragMode = 'none';
      this.panStartRangeMHz = null;
      this.livePanRangeMHz = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      if (dx > 4 && range) {
        this.cb.onZoomChange([range[0] * 1e6, range[1] * 1e6]);
      } else {
        this.scheduleClick(p.x, p.y);
      }
      this.updateCursor(p);
      this.draw();
      return;
    }
    if (this.downPix && Math.abs(p.x - this.downPix.x) <= 4 && Math.abs(p.y - this.downPix.y) <= 4) {
      this.scheduleClick(p.x, p.y);
    }
    this.downPix = null;
  }

  private cancelDrag(): void {
    this.dragMode = 'none';
    this.panStartRangeMHz = null;
    this.livePanRangeMHz = null;
    this.livePreviewMarkerId = null;
    this.livePreviewFreqHz = null;
    this.draw();
  }

  private onWheel(e: WheelEvent): void {
    const f = this.frame;
    if (!f || f.view === 'smith' || f.view === 'polar') return;
    e.preventDefault();
    const p = this.pixelPos(e);
    const cursorFreq = f.xInv(p.x);
    // Scale the step with the actual scroll delta instead of a fixed
    // per-event jump - a fast wheel click and a light trackpad tick (which
    // can fire many small-delta events per second) both feel proportional
    // instead of the trackpad case blowing past several zoom levels at once.
    const clampedDelta = Math.max(-400, Math.min(400, e.deltaY));
    const factor = Math.exp(clampedDelta * 0.0015);
    const newMin = cursorFreq - (cursorFreq - f.xMin) * factor;
    const newMax = cursorFreq + (f.xMax - cursorFreq) * factor;
    this.cb.onZoomChange(clampFreqRangeHz(newMin * 1e6, newMax * 1e6, f.dataExtentHz));
  }

  private onDblClick(): void {
    this.cancelPendingClick();
    if (!this.frame || this.frame.view === 'smith' || this.frame.view === 'polar') return;
    this.cb.onZoomChange(null);
  }
}
