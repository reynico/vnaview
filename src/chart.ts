import Plotly from 'plotly.js-dist-min';
import { type TouchstoneData, type DataPoint, type Complex, toDB, toPhase, toVSWR } from './parser';
import { t } from './prefs';

export type View = 'db' | 'phase' | 'vswr' | 'smith';

export interface ChartEntry {
  label: string;
  color: string;
  data: TouchstoneData;
}

export interface Marker {
  id: number;
  freq: number;
  /** Index into a point's params[] (0=S11, 1=S21, 2=S12, 3=S22). */
  param: number;
}

export const SINGLE_COLORS = ['#33ff33', '#ffb000', '#7dffb2', '#ff5533'];
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
  };
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
): Promise<void> {
  if (view === 'smith') {
    return renderSmith(el, entries, markers, activeMarkerId, deltaRefId);
  }

  const compare = entries.length > 1;
  const traces: Plotly.Data[] = [];
  const rawFn = view === 'db' ? toDB : view === 'phase' ? toPhase : toVSWR;
  const fn = view === 'vswr'
    ? (c: Parameters<typeof toVSWR>[0]) => Math.round(rawFn(c) * 100) / 100
    : rawFn;

  for (const { label, color, data } of entries) {
    const freqs = data.points.map((p) => p.freq / 1e6);
    let paramsToPlot: number[];

    if (compare) {
      // S11 solid, S21 dashed (if 2-port)
      paramsToPlot = data.ports === 1 ? [0] : [0, 1];
      for (const i of paramsToPlot) {
        const y = data.points.map((p) => fn(p.params[i]));
        traces.push(glowTrace(freqs, y, color, 1.5));
        traces.push({
          x: freqs,
          y,
          name: `${label} · ${PARAM_NAMES[i]}`,
          type: 'scatter',
          mode: 'lines',
          line: { color, width: 1.5, dash: i === 0 ? 'solid' : 'dash' },
        });
      }
    } else {
      const count = data.ports === 1 ? 1 : 4;
      paramsToPlot = [];
      for (let i = 0; i < count; i++) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
        paramsToPlot.push(i);
        const y = data.points.map((p) => fn(p.params[i]));
        traces.push(glowTrace(freqs, y, SINGLE_COLORS[i], 1.5));
        traces.push({
          x: freqs,
          y,
          name: PARAM_NAMES[i],
          type: 'scatter',
          mode: 'lines',
          line: { color: SINGLE_COLORS[i], width: 1.5 },
        });
      }
    }

    for (const i of paramsToPlot) {
      const paramMarkers = markers.filter((m) => m.param === i);
      if (paramMarkers.length === 0) continue;
      traces.push(
        markerGlyphTrace(paramMarkers, markers, data.points, fn, i, activeMarkerId, deltaRefId),
      );
    }
  }

  const yTitle =
    view === 'db' ? `${t('magnitude')} (dB)` : view === 'phase' ? `${t('phase')} (°)` : 'VSWR';

  const shapes: Partial<Plotly.Shape>[] = markers.map((m) => ({
    type: 'line',
    x0: m.freq / 1e6,
    x1: m.freq / 1e6,
    y0: 0,
    y1: 1,
    yref: 'paper' as const,
    line: { color: MARKER_COLOR, width: 1, dash: 'dot' },
  }));

  const yRange: [number, number] | undefined =
    view === 'db' ? [refLevel - dbPerDiv * 8, refLevel + dbPerDiv * 2] : undefined;
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
    { responsive: true },
  ).then(() => Plotly.Plots.resize(el));
}

const MARKER_COLOR = '#ffe14d';
const MARKER_ACTIVE_COLOR = '#f8fafc';
const MARKER_DELTA_REF_COLOR = '#ff5ec2';

function glyphColor(markerId: number, activeMarkerId: number | null, deltaRefId: number | null): string {
  if (markerId === deltaRefId) return MARKER_DELTA_REF_COLOR;
  if (markerId === activeMarkerId) return MARKER_ACTIVE_COLOR;
  return MARKER_COLOR;
}

function markerGlyphTrace(
  paramMarkers: Marker[],
  allMarkers: Marker[],
  points: DataPoint[],
  fn: (c: Complex) => number,
  param: number,
  activeMarkerId: number | null,
  deltaRefId: number | null,
): Plotly.Data {
  const x: number[] = [];
  const y: number[] = [];
  const text: string[] = [];
  const colors: string[] = [];

  for (const m of paramMarkers) {
    const pt = points.reduce((a, b) =>
      Math.abs(b.freq - m.freq) < Math.abs(a.freq - m.freq) ? b : a,
    );
    x.push(pt.freq / 1e6);
    y.push(fn(pt.params[param]));
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
): Promise<void> {
  const traces: Plotly.Data[] = [...smithGrid()];

  for (const { label, color, data } of entries) {
    const markerPoints = markers.map((m, idx) => {
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
    traces.push(glowTrace(smithX, smithY, color, 2));
    traces.push({
      x: smithX,
      y: smithY,
      text: data.points.map((p) => `${(p.freq / 1e6).toFixed(3)} MHz`),
      type: 'scatter',
      mode: 'lines',
      name: entries.length > 1 ? label : 'S11',
      line: { color, width: 2 },
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
    { responsive: true },
  ).then(() => Plotly.Plots.resize(el));
}

function plotTitle(entries: ChartEntry[], view: View) {
  const files = entries.map((e) => e.label).join(', ');

  let params: string;
  if (view === 'smith') {
    params = 'S11 · Smith Chart';
  } else {
    const viewLabel =
      view === 'db' ? `${t('magnitude')} (dB)` : view === 'phase' ? t('phase') : 'VSWR';
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
