import { parse, toDB, toPhase, toVSWR } from './parser';
import { render, type View, type ChartEntry } from './chart';
import type { TouchstoneData } from './parser';
import './style.css';

interface LoadedFile {
  name: string;
  data: TouchstoneData;
  color: string;
}

const FILE_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];

let files: LoadedFile[] = [];
let activeFile: string | null = null;
let compareMode = false;
let view: View = 'db';
const markers: number[] = [];

const mainEl = document.querySelector('main')!;
const dropZone = document.getElementById('drop-zone')!;
const chartEl = document.getElementById('chart')!;
const viewNav = document.getElementById('views')!;
const fileBar = document.getElementById('file-bar')!;
const fileChips = document.getElementById('file-chips')!;
const compareBtn = document.getElementById('compare')!;
const clearBtn = document.getElementById('clear')!;
const markersEl = document.getElementById('markers')!;
const markerList = document.getElementById('marker-list')!;

function nextColor(): string {
  return FILE_COLORS[files.length % FILE_COLORS.length];
}

function load(file: File): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    const data = parse(e.target!.result as string, file.name);
    const existing = files.findIndex((f) => f.name === file.name);
    if (existing >= 0) {
      files[existing].data = data;
    } else {
      files.push({ name: file.name, data, color: nextColor() });
    }
    activeFile = file.name;
    compareMode = false;

    dropZone.hidden = true;
    chartEl.hidden = false;
    viewNav.hidden = false;
    clearBtn.hidden = false;
    markersEl.hidden = false;

    attachClickListener();
    renderFileBar();
    // Defer one frame so the browser lays out chartEl before Plotly measures it
    requestAnimationFrame(renderChart);
  };
  reader.readAsText(file);
}

function removeFile(name: string): void {
  files = files.filter((f) => f.name !== name);
  if (files.length === 0) {
    reset();
    return;
  }
  if (activeFile === name) activeFile = files[0].name;
  if (compareMode && files.length < 2) compareMode = false;
  renderFileBar();
  renderChart();
}

function reset(): void {
  files = [];
  activeFile = null;
  compareMode = false;
  markers.length = 0;
  dropZone.hidden = false;
  chartEl.hidden = true;
  viewNav.hidden = true;
  fileBar.hidden = true;
  clearBtn.hidden = true;
  markersEl.hidden = true;
  compareBtn.hidden = true;
  renderMarkerList();
}

function activeEntries(): ChartEntry[] {
  if (compareMode) {
    return files.map((f) => ({ label: f.name, color: f.color, data: f.data }));
  }
  const f = files.find((f) => f.name === activeFile);
  return f ? [{ label: f.name, color: f.color, data: f.data }] : [];
}

function renderChart(): void {
  const entries = activeEntries();
  if (entries.length === 0) return;
  render(chartEl, entries, view, markers);
}

function renderFileBar(): void {
  fileBar.hidden = false;
  compareBtn.hidden = files.length < 2;
  compareBtn.classList.toggle('active', compareMode);

  fileChips.innerHTML = '';
  for (const file of files) {
    const chip = document.createElement('span');
    chip.className = 'file-chip' + (file.name === activeFile && !compareMode ? ' active' : '');
    chip.innerHTML = `
      <span class="dot" style="background:${file.color}"></span>
      <span class="chip-name">${file.name}</span>
      <button class="chip-remove" title="Remove">×</button>
    `;
    chip.querySelector('.chip-remove')!.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(file.name);
    });
    chip.addEventListener('click', () => {
      activeFile = file.name;
      compareMode = false;
      compareBtn.classList.remove('active');
      renderFileBar();
      renderChart();
    });
    fileChips.appendChild(chip);
  }
}

function markerValue(freqHz: number): string {
  if (compareMode) return '';
  const f = files.find((f) => f.name === activeFile);
  if (!f) return '';
  const pt = f.data.points.reduce((a, b) =>
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

let clickListenerAttached = false;

function attachClickListener(): void {
  if (clickListenerAttached) return;
  clickListenerAttached = true;

  (chartEl as any).on('plotly_click', (ev: any) => {
    const pt = ev.points?.find((p: any) =>
      ['S11', 'S21', 'S12', 'S22'].some((n) => (p.data.name as string).includes(n)),
    );
    if (!pt) return;

    let freqHz: number;
    if (view === 'smith') {
      const ref = compareMode ? files[0] : files.find((f) => f.name === activeFile);
      if (!ref) return;
      const closest = ref.data.points.reduce((a, b) =>
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

// Drop on entire main area (works whether drop zone or chart is visible)
mainEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (files.length > 0) {
    mainEl.classList.add('dropping');
  } else {
    dropZone.classList.add('over');
  }
});
mainEl.addEventListener('dragleave', (e) => {
  if (!mainEl.contains(e.relatedTarget as Node)) {
    mainEl.classList.remove('dropping');
    dropZone.classList.remove('over');
  }
});
mainEl.addEventListener('drop', (e) => {
  e.preventDefault();
  mainEl.classList.remove('dropping');
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

compareBtn.addEventListener('click', () => {
  compareMode = !compareMode;
  compareBtn.classList.toggle('active', compareMode);
  renderFileBar();
  renderMarkerList();
  renderChart();
});

clearBtn.addEventListener('click', reset);
