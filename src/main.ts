import { parse, toDB, toPhase, toVSWR, type TouchstoneData } from './parser';
import { render, type View } from './chart';
import './style.css';

let data: TouchstoneData | null = null;
let view: View = 'db';
const markers: number[] = [];

const dropZone = document.getElementById('drop-zone')!;
const chartEl = document.getElementById('chart')!;
const viewNav = document.getElementById('views')!;
const clearBtn = document.getElementById('clear')!;
const markersEl = document.getElementById('markers')!;
const markerList = document.getElementById('marker-list')!;

function load(file: File): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    data = parse(e.target!.result as string, file.name);
    markers.length = 0;
    dropZone.hidden = true;
    chartEl.hidden = false;
    viewNav.hidden = false;
    clearBtn.hidden = false;
    markersEl.hidden = false;

    if (data.ports === 1) {
      document.querySelector<HTMLButtonElement>('[data-view="vswr"]')!.hidden = false;
    }

    renderChart();
    attachClickListener();
  };
  reader.readAsText(file);
}

let clickListenerAttached = false;

function attachClickListener(): void {
  if (clickListenerAttached) return;
  clickListenerAttached = true;

  (chartEl as any).on('plotly_click', (ev: any) => {
    if (!data) return;
    const pt = ev.points?.find(
      (p: any) => p.data.name === 'S11' || ['S11', 'S21', 'S12', 'S22'].includes(p.data.name),
    );
    if (!pt) return;

    let freqHz: number;
    if (view === 'smith') {
      const closest = data.points.reduce((a, b) =>
        (b.params[0].re - pt.x) ** 2 + (b.params[0].im - pt.y) ** 2 <
        (a.params[0].re - pt.x) ** 2 + (a.params[0].im - pt.y) ** 2
          ? b
          : a,
      );
      freqHz = closest.freq;
    } else {
      freqHz = (pt.x as number) * 1e6;
    }

    if (!markers.includes(freqHz)) {
      markers.push(freqHz);
      markers.sort((a, b) => a - b);
      renderMarkerList();
      renderChart();
    }
  });
}

function renderChart(): void {
  if (!data) return;
  render(chartEl, data, view, markers);
}

function markerValue(freqHz: number): string {
  if (!data) return '';
  const pt = data.points.reduce((a, b) =>
    Math.abs(b.freq - freqHz) < Math.abs(a.freq - freqHz) ? b : a,
  );
  if (view === 'db') return `${toDB(pt.params[0]).toFixed(2)} dB`;
  if (view === 'phase') return `${toPhase(pt.params[0]).toFixed(1)}°`;
  if (view === 'vswr') return `VSWR ${toVSWR(pt.params[0]).toFixed(2)}`;
  return '';
}

function renderMarkerList(): void {
  markerList.innerHTML = '';
  for (const freq of markers) {
    const tag = document.createElement('span');
    tag.className = 'marker-tag';
    const val = markerValue(freq);
    tag.textContent = `${(freq / 1e6).toFixed(3)} MHz${val ? ` · ${val}` : ''} ×`;
    tag.title = 'Click to remove';
    tag.onclick = () => {
      markers.splice(markers.indexOf(freq), 1);
      renderMarkerList();
      renderChart();
    };
    markerList.appendChild(tag);
  }
}

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('over');
  const file = e.dataTransfer?.files[0];
  if (file) load(file);
});
dropZone.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.s1p,.s2p';
  input.onchange = () => {
    if (input.files?.[0]) load(input.files[0]);
  };
  input.click();
});

viewNav.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view as View;
    viewNav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderMarkerList();
    renderChart();
  });
});

clearBtn.addEventListener('click', () => {
  data = null;
  markers.length = 0;
  clickListenerAttached = false;
  dropZone.hidden = false;
  chartEl.hidden = true;
  viewNav.hidden = true;
  clearBtn.hidden = true;
  markersEl.hidden = true;
  renderMarkerList();
});
