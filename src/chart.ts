import Plotly from 'plotly.js-dist-min';
import { type TouchstoneData, toDB, toPhase, toVSWR } from './parser';

export type View = 'db' | 'phase' | 'vswr' | 'smith';

export interface ChartEntry {
  label: string;
  color: string;
  data: TouchstoneData;
}

const SINGLE_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f472b6'];
const PARAM_NAMES = ['S11', 'S21', 'S12', 'S22'];

const BASE_LAYOUT: Partial<Plotly.Layout> = {
  paper_bgcolor: '#0f0f10',
  plot_bgcolor: '#0f0f10',
  font: { color: '#e4e4e7', size: 12, family: 'system-ui, sans-serif' },
  margin: { t: 16, r: 16, b: 52, l: 68 },
  legend: { bgcolor: 'transparent', bordercolor: '#27272a' },
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
  markers: number[],
): void {
  if (view === 'smith') {
    renderSmith(el, entries, markers);
    return;
  }

  const compare = entries.length > 1;
  const traces: Plotly.Data[] = [];
  const fn = view === 'db' ? toDB : view === 'phase' ? toPhase : toVSWR;

  for (const { label, color, data } of entries) {
    const freqs = data.points.map((p) => p.freq / 1e6);

    if (compare) {
      // S11 solid, S21 dashed (if 2-port)
      const params = data.ports === 1 ? [0] : [0, 1];
      for (const i of params) {
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
      for (let i = 0; i < count; i++) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
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
  }

  const yTitle =
    view === 'db' ? 'Magnitude (dB)' : view === 'phase' ? 'Phase (°)' : 'VSWR';

  const shapes: Partial<Plotly.Shape>[] = markers.map((f) => ({
    type: 'line',
    x0: f / 1e6,
    x1: f / 1e6,
    y0: 0,
    y1: 1,
    yref: 'paper' as const,
    line: { color: '#facc15', width: 1, dash: 'dot' },
  }));

  Plotly.react(
    el,
    traces,
    {
      ...BASE_LAYOUT,
      xaxis: { ...AXIS_STYLE, title: { text: 'Frequency (MHz)' } },
      yaxis: { ...AXIS_STYLE, title: { text: yTitle } },
      shapes,
    },
    { responsive: true },
  ).then(() => Plotly.Plots.resize(el));
}

function renderSmith(
  el: HTMLElement,
  entries: ChartEntry[],
  markers: number[],
): void {
  const traces: Plotly.Data[] = [...smithGrid()];

  for (const { label, color, data } of entries) {
    const markerPoints = markers.map((f) => {
      const pt = data.points.find((p) => p.freq >= f) ?? data.points[data.points.length - 1];
      return { x: pt.params[0].re, y: pt.params[0].im, label: `${(f / 1e6).toFixed(3)} MHz` };
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
        text: markerPoints.map((p) => p.label),
        type: 'scatter',
        mode: 'markers',
        marker: { color: '#facc15', size: 8 },
        showlegend: false,
        hoverinfo: 'text',
      });
    }
  }

  Plotly.react(
    el,
    traces,
    {
      ...BASE_LAYOUT,
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
