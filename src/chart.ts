import Plotly from 'plotly.js-dist-min';
import { type TouchstoneData, type DataPoint, type Complex, toDB, toPhase, toVSWR } from './parser';

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

export const SINGLE_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f472b6'];
export const PARAM_NAMES = ['S11', 'S21', 'S12', 'S22'];

const BASE_LAYOUT: Partial<Plotly.Layout> = {
  paper_bgcolor: '#0f0f10',
  plot_bgcolor: '#0f0f10',
  font: { color: '#e4e4e7', size: 12, family: 'system-ui, sans-serif' },
  margin: { t: 36, r: 16, b: 52, l: 68 },
  showlegend: false,
  hovermode: 'x unified',
};

const AXIS_STYLE: Partial<Plotly.LayoutAxis> = {
  gridcolor: '#27272a',
  zerolinecolor: '#3f3f46',
  tickfont: { color: '#71717a' },
  titlefont: { color: '#a1a1aa' },
};

export function render(
  el: HTMLElement,
  entries: ChartEntry[],
  view: View,
  markers: Marker[],
  dbPerDiv: number,
  refLevel: number,
  freqRange: [number, number] | null = null,
): Promise<void> {
  if (view === 'smith') {
    return renderSmith(el, entries, markers);
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
        traces.push({
          x: freqs,
          y: data.points.map((p) => fn(p.params[i])),
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
        traces.push({
          x: freqs,
          y: data.points.map((p) => fn(p.params[i])),
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
      traces.push(markerGlyphTrace(paramMarkers, markers, data.points, fn, i));
    }
  }

  const yTitle =
    view === 'db' ? 'Magnitude (dB)' : view === 'phase' ? 'Phase (°)' : 'VSWR';

  const shapes: Partial<Plotly.Shape>[] = markers.map((m) => ({
    type: 'line',
    x0: m.freq / 1e6,
    x1: m.freq / 1e6,
    y0: 0,
    y1: 1,
    yref: 'paper' as const,
    line: { color: '#facc15', width: 1, dash: 'dot' },
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
      ...BASE_LAYOUT,
      title: plotTitle(entries, view),
      xaxis: { ...AXIS_STYLE, title: { text: 'Frequency (MHz)' }, range: xRange },
      yaxis: { ...AXIS_STYLE, title: { text: yTitle }, range: yRange },
      shapes,
    },
    { responsive: true },
  ).then(() => Plotly.Plots.resize(el));
}

function markerGlyphTrace(
  paramMarkers: Marker[],
  allMarkers: Marker[],
  points: DataPoint[],
  fn: (c: Complex) => number,
  param: number,
): Plotly.Data {
  const x: number[] = [];
  const y: number[] = [];
  const text: string[] = [];

  for (const m of paramMarkers) {
    const pt = points.reduce((a, b) =>
      Math.abs(b.freq - m.freq) < Math.abs(a.freq - m.freq) ? b : a,
    );
    x.push(pt.freq / 1e6);
    y.push(fn(pt.params[param]));
    text.push(String(allMarkers.indexOf(m) + 1));
  }

  return {
    x,
    y,
    type: 'scatter',
    mode: 'text+markers',
    marker: { symbol: 'triangle-up', size: 10, color: '#facc15', line: { width: 1, color: '#000' } },
    text,
    textposition: 'top center',
    textfont: { color: '#facc15', size: 10 },
    hoverinfo: 'skip',
    showlegend: false,
  };
}

function renderSmith(
  el: HTMLElement,
  entries: ChartEntry[],
  markers: Marker[],
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
      };
    });

    traces.push({
      x: data.points.map((p) => p.params[0].re),
      y: data.points.map((p) => p.params[0].im),
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
        marker: { symbol: 'triangle-up', color: '#facc15', size: 10, line: { width: 1, color: '#000' } },
        textposition: 'top center',
        textfont: { color: '#facc15', size: 10 },
        showlegend: false,
        hoverinfo: 'text',
      });
    }
  }

  return Plotly.react(
    el,
    traces,
    {
      ...BASE_LAYOUT,
      title: plotTitle(entries, 'smith'),
      hovermode: 'closest',
      xaxis: {
        ...AXIS_STYLE,
        title: { text: 'Re(Γ)' },
        range: [-1.1, 1.1],
        scaleanchor: 'y',
        scaleratio: 1,
      },
      yaxis: { ...AXIS_STYLE, title: { text: 'Im(Γ)' }, range: [-1.1, 1.1] },
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
      view === 'db' ? 'Magnitude (dB)' : view === 'phase' ? 'Phase' : 'VSWR';
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
    font: { size: 12, color: '#52525b' },
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
    line: { color: '#27272a', width: 0.8 },
    hoverinfo: 'none',
    showlegend: false,
  };
}
