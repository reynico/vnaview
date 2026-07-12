import Plotly from 'plotly.js-dist-min';
import { type TouchstoneData, type DataPoint, toDB, toPhase, toVSWR, mag, groupDelay } from './parser';
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
}

export const PARAM_NAMES = ['S11', 'S21', 'S12', 'S22'];

const MONO_FONT = "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace";

// Colors are read from the CSS custom properties at render time so the
// Plotly canvas stays in sync with style.css instead of duplicating hex
// values that can drift out of sync with the theme.
function theme() {
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

function baseLayout(): Partial<Plotly.Layout> {
  const t = theme();
  return {
    paper_bgcolor: t.bg,
    plot_bgcolor: t.bg,
    font: { color: t.text, size: 12, family: MONO_FONT },
    margin: { t: 36, r: 16, b: 52, l: 68 },
    showlegend: false,
    hovermode: 'x unified',
  };
}

// Fakes a CRT phosphor bloom: a wider, translucent duplicate of a trace drawn
// behind it. Avoids a CSS filter/blur on the chart container, which would
// also blur tick labels and the marker table sitting in the same subtree.
function glowTrace(x: number[], y: number[], color: string, width: number): Plotly.Data {
  return {
    x,
    y,
    type: 'scatter',
    mode: 'lines',
    line: { color, width: width * 3.5 },
    opacity: 0.25,
    hoverinfo: 'skip',
    showlegend: false,
  };
}

function axisStyle(): Partial<Plotly.LayoutAxis> {
  const t = theme();
  return {
    gridcolor: t.border,
    gridwidth: 1.4,
    zerolinecolor: t.muted,
    zerolinewidth: 1.4,
    tickfont: { color: t.muted },
    titlefont: { color: t.text },
  };
}

function computeYRange(view: View, perDiv: number, ref: number): [number, number] | undefined {
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
      return undefined;
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

function exportFilename(entries: ChartEntry[], view: View): string {
  const base = entries.length > 1 ? 'compare' : entries[0]?.label.replace(/\.[^.]+$/, '') ?? 'trace';
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${base}_${view}_${date}`;
}

export function render(
  el: HTMLElement,
  entries: ChartEntry[],
  view: View,
  markers: Marker[],
  dbPerDiv: number,
  refLevel: number,
  freqRange: [number, number] | null = null,
  activeMarkerId: number | null = null,
  deltaRefId: number | null = null,
  limitUpper: number | null = null,
  limitLower: number | null = null,
  hiddenTraces: Set<string> = new Set(),
): Promise<void> {
  if (view === 'smith') {
    return renderSmith(el, entries, markers, activeMarkerId, deltaRefId, hiddenTraces);
  }
  if (view === 'polar') {
    return renderPolar(el, entries, markers, activeMarkerId, deltaRefId, hiddenTraces);
  }

  const isHidden = (label: string, i: number) => hiddenTraces.has(`${label}#${i}`);

  const compare = entries.length > 1;
  const traces: Plotly.Data[] = [];
  const colors = singleColors();

  for (const entry of entries) {
    const { label, color, data, isMemory } = entry;
    const freqs = data.points.map((p) => p.freq / 1e6);
    let paramsToPlot: number[];

    if (compare) {
      // S11 solid, S21 dashed (if 2-port); memory traces are always dotted/dimmed.
      paramsToPlot = data.ports === 1 ? [0] : [0, 1];
      for (const i of paramsToPlot) {
        if (isHidden(label, i)) continue;
        const y = computeYValues(data, i, view);
        if (!isMemory) traces.push(glowTrace(freqs, y, color, 1.5));
        traces.push({
          x: freqs,
          y,
          name: `${label} · ${PARAM_NAMES[i]}`,
          type: 'scatter',
          mode: 'lines',
          line: { color, width: 1.5, dash: isMemory ? 'dot' : i === 0 ? 'solid' : 'dash' },
          opacity: isMemory ? 0.5 : 1,
        });
      }
    } else {
      const count = data.ports === 1 ? 1 : 4;
      paramsToPlot = [];
      for (let i = 0; i < count; i++) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
        paramsToPlot.push(i);
        if (isHidden(label, i)) continue;
        const y = computeYValues(data, i, view);
        traces.push(glowTrace(freqs, y, colors[i], 1.5));
        traces.push({
          x: freqs,
          y,
          name: PARAM_NAMES[i],
          type: 'scatter',
          mode: 'lines',
          line: { color: colors[i], width: 1.5 },
        });
      }
    }

    if (isMemory) continue;
    for (const i of paramsToPlot) {
      if (isHidden(label, i)) continue;
      const paramMarkers = markers.filter((m) => m.param === i);
      if (paramMarkers.length === 0) continue;
      const yValues = computeYValues(data, i, view);
      traces.push(
        markerGlyphTrace(paramMarkers, markers, data.points, yValues, activeMarkerId, deltaRefId),
      );
    }
  }

  const yTitle =
    view === 'db' ? `${t('magnitude')} (dB)`
    : view === 'phase' ? `${t('phase')} (°)`
    : view === 'groupdelay' ? `${t('groupDelay')} (ns)`
    : 'VSWR';

  // editable so the user can drag a marker's line to reposition it (snapped
  // to the nearest sampled frequency on drop, see attachRelayoutListener).
  const shapes: Array<Partial<Plotly.Shape> & { editable?: boolean }> = markers.map((m) => ({
    type: 'line',
    x0: m.freq / 1e6,
    x1: m.freq / 1e6,
    y0: 0,
    y1: 1,
    yref: 'paper' as const,
    line: { color: theme().marker, width: 1, dash: 'dot' },
    editable: true,
  }));

  if (view === 'db') {
    for (const limitValue of [limitUpper, limitLower]) {
      if (limitValue === null) continue;
      shapes.push({
        type: 'line',
        x0: 0,
        x1: 1,
        xref: 'paper' as const,
        y0: limitValue,
        y1: limitValue,
        line: { color: theme().danger, width: 1.5, dash: 'dash' },
        editable: false,
      });
    }
  }

  const yRange = computeYRange(view, dbPerDiv, refLevel);
  const xRange: [number, number] | undefined = freqRange
    ? [freqRange[0] / 1e6, freqRange[1] / 1e6]
    : undefined;

  return Plotly.react(
    el,
    traces,
    {
      ...baseLayout(),
      title: plotTitle(entries, view),
      xaxis: { ...axisStyle(), title: { text: `${t('frequency')} (MHz)` }, range: xRange },
      yaxis: { ...axisStyle(), title: { text: yTitle }, range: yRange },
      shapes,
    },
    {
      responsive: true,
      edits: { shapePosition: true },
      toImageButtonOptions: { format: 'png', filename: exportFilename(entries, view), scale: 2 },
    },
  ).then(() => Plotly.Plots.resize(el));
}

function glyphColor(markerId: number, activeMarkerId: number | null, deltaRefId: number | null): string {
  const th = theme();
  if (markerId === deltaRefId) return th.markerDelta;
  if (markerId === activeMarkerId) return th.markerActive;
  return th.marker;
}

function markerGlyphTrace(
  paramMarkers: Marker[],
  allMarkers: Marker[],
  points: DataPoint[],
  yValues: number[],
  activeMarkerId: number | null,
  deltaRefId: number | null,
): Plotly.Data {
  const x: number[] = [];
  const y: number[] = [];
  const text: string[] = [];
  const colors: string[] = [];

  for (const m of paramMarkers) {
    let idx = 0;
    let minDist = Infinity;
    for (let k = 0; k < points.length; k++) {
      const d = Math.abs(points[k].freq - m.freq);
      if (d < minDist) {
        minDist = d;
        idx = k;
      }
    }
    x.push(points[idx].freq / 1e6);
    y.push(yValues[idx]);
    text.push(String(allMarkers.indexOf(m) + 1));
    colors.push(glyphColor(m.id, activeMarkerId, deltaRefId));
  }

  return {
    x,
    y,
    type: 'scatter',
    mode: 'text+markers',
    marker: { symbol: 'triangle-up', size: 10, color: colors, line: { width: 1, color: '#000' } },
    text,
    textposition: 'top center',
    textfont: { color: colors, size: 10 },
    hoverinfo: 'skip',
    showlegend: false,
  };
}

function renderSmith(
  el: HTMLElement,
  entries: ChartEntry[],
  markers: Marker[],
  activeMarkerId: number | null = null,
  deltaRefId: number | null = null,
  hiddenTraces: Set<string> = new Set(),
): Promise<void> {
  const traces: Plotly.Data[] = [...smithGrid()];

  for (const entry of entries) {
    const { label, color, data, isMemory } = entry;
    if (hiddenTraces.has(`${label}#0`)) continue;
    const markerPoints = isMemory
      ? []
      : markers.map((m, idx) => {
          const pt = data.points.find((p) => p.freq >= m.freq) ?? data.points[data.points.length - 1];
          return {
            x: pt.params[0].re,
            y: pt.params[0].im,
            num: String(idx + 1),
            hover: `${idx + 1} · ${(m.freq / 1e6).toFixed(3)} MHz`,
            color: glyphColor(m.id, activeMarkerId, deltaRefId),
          };
        });

    const smithX = data.points.map((p) => p.params[0].re);
    const smithY = data.points.map((p) => p.params[0].im);
    if (!isMemory) traces.push(glowTrace(smithX, smithY, color, 2));
    traces.push({
      x: smithX,
      y: smithY,
      text: data.points.map((p) => `${(p.freq / 1e6).toFixed(3)} MHz`),
      type: 'scatter',
      mode: 'lines',
      name: entries.length > 1 ? label : 'S11',
      line: { color, width: 2, dash: isMemory ? 'dot' : 'solid' },
      opacity: isMemory ? 0.5 : 1,
    });

    if (markerPoints.length > 0) {
      traces.push({
        x: markerPoints.map((p) => p.x),
        y: markerPoints.map((p) => p.y),
        text: markerPoints.map((p) => p.num),
        hovertext: markerPoints.map((p) => p.hover),
        type: 'scatter',
        mode: 'text+markers',
        marker: {
          symbol: 'triangle-up',
          color: markerPoints.map((p) => p.color),
          size: 10,
          line: { width: 1, color: '#000' },
        },
        textposition: 'top center',
        textfont: { color: markerPoints.map((p) => p.color), size: 10 },
        showlegend: false,
        hoverinfo: 'text',
      });
    }
  }

  return Plotly.react(
    el,
    traces,
    {
      ...baseLayout(),
      title: plotTitle(entries, 'smith'),
      hovermode: 'closest',
      xaxis: {
        ...axisStyle(),
        title: { text: 'Re(Γ)' },
        range: [-1.1, 1.1],
        scaleanchor: 'y',
        scaleratio: 1,
      },
      yaxis: { ...axisStyle(), title: { text: 'Im(Γ)' }, range: [-1.1, 1.1] },
    },
    {
      responsive: true,
      toImageButtonOptions: { format: 'png', filename: exportFilename(entries, 'smith'), scale: 2 },
    },
  ).then(() => Plotly.Plots.resize(el));
}

function renderPolar(
  el: HTMLElement,
  entries: ChartEntry[],
  markers: Marker[],
  activeMarkerId: number | null = null,
  deltaRefId: number | null = null,
  hiddenTraces: Set<string> = new Set(),
): Promise<void> {
  const compare = entries.length > 1;
  const isHidden = (label: string, i: number) => hiddenTraces.has(`${label}#${i}`);

  let maxR = 1;
  for (const { label, data } of entries) {
    const count = compare ? (data.ports === 1 ? 1 : 2) : data.ports === 1 ? 1 : 4;
    for (let i = 0; i < count; i++) {
      if (isHidden(label, i)) continue;
      for (const p of data.points) {
        const m = mag(p.params[i]);
        if (m > maxR) maxR = m;
      }
    }
  }
  maxR = Math.ceil(maxR * 5) / 5;

  const traces: Plotly.Data[] = [...polarGrid(maxR)];
  const colors = singleColors();

  for (const entry of entries) {
    const { label, color, data, isMemory } = entry;
    const paramIdxs = compare
      ? data.ports === 1 ? [0] : [0, 1]
      : Array.from({ length: data.ports === 1 ? 1 : 4 }, (_, i) => i);

    for (const i of paramIdxs) {
      if (isHidden(label, i)) continue;
      const traceColor = compare ? color : colors[i];
      const x = data.points.map((p) => p.params[i].re);
      const y = data.points.map((p) => p.params[i].im);
      if (!isMemory) traces.push(glowTrace(x, y, traceColor, 1.5));
      traces.push({
        x,
        y,
        text: data.points.map((p) => `${(p.freq / 1e6).toFixed(3)} MHz`),
        type: 'scatter',
        mode: 'lines',
        name: compare ? `${label} · ${PARAM_NAMES[i]}` : PARAM_NAMES[i],
        line: { color: traceColor, width: 1.5, dash: isMemory ? 'dot' : compare && i === 1 ? 'dash' : 'solid' },
        opacity: isMemory ? 0.5 : 1,
      });

      if (isMemory) continue;
      const paramMarkers = markers.filter((m) => m.param === i);
      if (paramMarkers.length === 0) continue;
      const markerPoints = paramMarkers.map((m) => {
        const pt = data.points.reduce((a, b) =>
          Math.abs(b.freq - m.freq) < Math.abs(a.freq - m.freq) ? b : a,
        );
        return {
          x: pt.params[i].re,
          y: pt.params[i].im,
          num: String(markers.indexOf(m) + 1),
          hover: `${markers.indexOf(m) + 1} · ${(m.freq / 1e6).toFixed(3)} MHz`,
          color: glyphColor(m.id, activeMarkerId, deltaRefId),
        };
      });
      traces.push({
        x: markerPoints.map((p) => p.x),
        y: markerPoints.map((p) => p.y),
        text: markerPoints.map((p) => p.num),
        hovertext: markerPoints.map((p) => p.hover),
        type: 'scatter',
        mode: 'text+markers',
        marker: {
          symbol: 'triangle-up',
          color: markerPoints.map((p) => p.color),
          size: 10,
          line: { width: 1, color: '#000' },
        },
        textposition: 'top center',
        textfont: { color: markerPoints.map((p) => p.color), size: 10 },
        showlegend: false,
        hoverinfo: 'text',
      });
    }
  }

  return Plotly.react(
    el,
    traces,
    {
      ...baseLayout(),
      title: plotTitle(entries, 'polar'),
      hovermode: 'closest',
      xaxis: {
        ...axisStyle(),
        title: { text: 'Re(Γ)' },
        range: [-maxR * 1.05, maxR * 1.05],
        scaleanchor: 'y',
        scaleratio: 1,
      },
      yaxis: { ...axisStyle(), title: { text: 'Im(Γ)' }, range: [-maxR * 1.05, maxR * 1.05] },
    },
    {
      responsive: true,
      toImageButtonOptions: { format: 'png', filename: exportFilename(entries, 'polar'), scale: 2 },
    },
  ).then(() => Plotly.Plots.resize(el));
}

function polarGrid(maxR: number): Plotly.Data[] {
  const N = 360;
  const theta = Array.from({ length: N + 1 }, (_, i) => (i * Math.PI * 2) / N);
  const traces: Plotly.Data[] = [];

  const rings = 4;
  for (let k = 1; k <= rings; k++) {
    const r = (maxR * k) / rings;
    traces.push(gridLine(theta.map((th) => r * Math.cos(th)), theta.map((th) => r * Math.sin(th))));
  }

  for (let deg = 0; deg < 360; deg += 30) {
    const rad = (deg * Math.PI) / 180;
    traces.push(gridLine([0, maxR * Math.cos(rad)], [0, maxR * Math.sin(rad)]));
  }

  return traces;
}

function plotTitle(entries: ChartEntry[], view: View) {
  const files = entries.map((e) => e.label).join(', ');

  let params: string;
  if (view === 'smith') {
    params = 'S11 · Smith Chart';
  } else if (view === 'polar') {
    if (entries.length > 1) {
      params = `S11${entries.some((e) => e.data.ports === 2) ? ', S21' : ''} · Polar`;
    } else {
      const { ports } = entries[0].data;
      params = `${ports === 1 ? 'S11' : 'S11–S22'} · Polar`;
    }
  } else {
    const viewLabel =
      view === 'db' ? `${t('magnitude')} (dB)`
      : view === 'phase' ? t('phase')
      : view === 'groupdelay' ? `${t('groupDelay')} (ns)`
      : 'VSWR';
    if (entries.length > 1) {
      params = `S11${entries.some((e) => e.data.ports === 2) ? ', S21' : ''} · ${viewLabel}`;
    } else {
      const { ports } = entries[0].data;
      const measured =
        ports === 1 ? 'S11'
        : view === 'vswr' ? 'S11, S22'
        : 'S11–S22';
      params = `${measured} · ${viewLabel}`;
    }
  }

  return {
    text: `${files} · ${params}`,
    font: { size: 12, color: theme().muted },
    x: 0.02,
    xanchor: 'left' as const,
    pad: { t: 4 },
  };
}

function smithGrid(): Plotly.Data[] {
  const N = 360;
  const theta = Array.from({ length: N + 1 }, (_, i) => (i * Math.PI * 2) / N);
  const traces: Plotly.Data[] = [];

  traces.push(gridLine(theta.map(Math.cos), theta.map(Math.sin)));

  for (const r of [0.5, 1, 2, 5]) {
    const cx = r / (1 + r);
    const rad = 1 / (1 + r);
    const pts = theta
      .map((t) => ({ x: cx + rad * Math.cos(t), y: rad * Math.sin(t) }))
      .filter((p) => p.x ** 2 + p.y ** 2 <= 1.002);
    traces.push(gridLine(pts.map((p) => p.x), pts.map((p) => p.y)));
  }

  for (const x of [0.5, 1, 2]) {
    for (const s of [1, -1]) {
      const pts = theta
        .map((t) => ({ x: 1 + (1 / x) * Math.cos(t), y: s / x + (1 / x) * Math.sin(t) }))
        .filter((p) => p.x ** 2 + p.y ** 2 <= 1.002);
      if (pts.length > 1) traces.push(gridLine(pts.map((p) => p.x), pts.map((p) => p.y)));
    }
  }

  return traces;
}

function gridLine(x: number[], y: number[]): Plotly.Data {
  return {
    x,
    y,
    type: 'scatter',
    mode: 'lines',
    line: { color: theme().border, width: 1 },
    hoverinfo: 'none',
    showlegend: false,
  };
}
