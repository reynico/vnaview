import { parse, toDB, toPhase, toVSWR } from './parser';
import { render, PARAM_NAMES, SINGLE_COLORS, type View, type ChartEntry, type Marker } from './chart';
import type { TouchstoneData } from './parser';
import './style.css';

interface LoadedFile {
  name: string;
  data: TouchstoneData;
  color: string;
}

const FILE_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f472b6', '#a78bfa', '#34d399', '#fbbf24', '#f87171'];
const MAX_MARKERS = 6;

let files: LoadedFile[] = [];
let activeFile: string | null = null;
let compareMode = false;
let view: View = 'db';
const markers: Marker[] = [];
let nextMarkerId = 1;
let dbPerDiv = 10;
let refLevel = 0;

const mainEl = document.querySelector('main')!;
const dropZone = document.getElementById('drop-zone')!;
const scopeArea = document.getElementById('scope-area')!;
const traceInfoBar = document.getElementById('trace-info-bar')!;
const chartEl = document.getElementById('chart')!;
const viewNav = document.getElementById('views')!;
const fileBar = document.getElementById('file-bar')!;
const fileChips = document.getElementById('file-chips')!;
const compareBtn = document.getElementById('compare')!;
const clearBtn = document.getElementById('clear')!;
const markersEl = document.getElementById('markers')!;
const markerList = document.getElementById('marker-list')!;
const scaleBar = document.getElementById('scale-bar')!;
const scaleDivInput = document.getElementById('scale-div') as HTMLInputElement;
const scaleRefInput = document.getElementById('scale-ref') as HTMLInputElement;
const scaleAutoBtn = document.getElementById('scale-auto')!;

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
    scopeArea.hidden = false;
    viewNav.hidden = false;
    clearBtn.hidden = false;
    markersEl.hidden = false;

    renderFileBar();
    updateScaleBarVisibility();
    renderChart().then(attachClickListener);
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
  nextMarkerId = 1;
  dbPerDiv = 10;
  refLevel = 0;
  scaleDivInput.value = String(dbPerDiv);
  scaleRefInput.value = String(refLevel);
  dropZone.hidden = false;
  scopeArea.hidden = true;
  viewNav.hidden = true;
  fileBar.hidden = true;
  clearBtn.hidden = true;
  markersEl.hidden = true;
  compareBtn.hidden = true;
  scaleBar.hidden = true;
  traceInfoBar.innerHTML = '';
  renderMarkerList();
}

function updateScaleBarVisibility(): void {
  scaleBar.hidden = files.length === 0 || view !== 'db';
}

function autoscaleOnce(): void {
  const entries = activeEntries();
  if (entries.length === 0) return;
  let maxVal = -Infinity;
  for (const { data } of entries) {
    const count = compareMode ? (data.ports === 1 ? 1 : 2) : data.ports === 1 ? 1 : 4;
    for (let i = 0; i < count; i++) {
      for (const p of data.points) {
        const v = toDB(p.params[i]);
        if (Number.isFinite(v) && v > maxVal) maxVal = v;
      }
    }
  }
  if (!Number.isFinite(maxVal)) return;
  refLevel = Math.ceil(maxVal / dbPerDiv) * dbPerDiv;
  scaleRefInput.value = String(refLevel);
  renderChart();
}

function activeEntries(): ChartEntry[] {
  if (compareMode) {
    return files.map((f) => ({ label: f.name, color: f.color, data: f.data }));
  }
  const f = files.find((f) => f.name === activeFile);
  return f ? [{ label: f.name, color: f.color, data: f.data }] : [];
}

function renderChart(): Promise<void> {
  const entries = activeEntries();
  if (entries.length === 0) return Promise.resolve();
  renderTraceInfoBar(entries);
  return render(chartEl, entries, view, markers, dbPerDiv, refLevel);
}

function formatLabel(v: View): string {
  return v === 'db' ? 'dB Mag' : v === 'phase' ? 'Phase' : v === 'vswr' ? 'VSWR' : 'Smith Chart';
}

function renderTraceInfoBar(entries: ChartEntry[]): void {
  traceInfoBar.innerHTML = '';
  if (entries.length === 0) return;

  const addChip = (color: string, text: string) => {
    const chip = document.createElement('span');
    chip.className = 'trace-info';
    chip.innerHTML = `<span class="dot" style="background:${color}"></span>${text}`;
    traceInfoBar.appendChild(chip);
  };

  const compare = entries.length > 1;
  const label = formatLabel(view);
  const scaleSuffix = view === 'db' ? ` · ${dbPerDiv}dB/ REF ${refLevel}dB` : '';

  for (const entry of entries) {
    if (view === 'smith') {
      const name = compare ? entry.label : 'S11';
      addChip(entry.color, `${name} · Smith Chart`);
      continue;
    }

    let paramIdxs: number[];
    if (compare) {
      paramIdxs = entry.data.ports === 1 ? [0] : [0, 1];
    } else {
      const count = entry.data.ports === 1 ? 1 : 4;
      paramIdxs = [];
      for (let i = 0; i < count; i++) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
        paramIdxs.push(i);
      }
    }

    for (const i of paramIdxs) {
      const name = compare ? `${entry.label} · ${PARAM_NAMES[i]}` : PARAM_NAMES[i];
      const color = compare ? entry.color : SINGLE_COLORS[i];
      addChip(color, `${name} · ${label}${scaleSuffix}`);
    }
  }
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

function markerValue(marker: Marker): string {
  if (compareMode) return '';
  const f = files.find((f) => f.name === activeFile);
  if (!f) return '';
  const pt = f.data.points.reduce((a, b) =>
    Math.abs(b.freq - marker.freq) < Math.abs(a.freq - marker.freq) ? b : a,
  );
  const c = pt.params[marker.param];
  if (!c) return '';
  if (view === 'db') return `${toDB(c).toFixed(2)} dB`;
  if (view === 'phase') return `${toPhase(c).toFixed(1)}°`;
  if (view === 'vswr') return `VSWR ${toVSWR(c).toFixed(2)}`;
  return '';
}

function renderMarkerList(): void {
  markerList.innerHTML = '';
  for (const m of markers) {
    const tag = document.createElement('span');
    tag.className = 'marker-tag';
    const val = markerValue(m);
    tag.textContent = `${(m.freq / 1e6).toFixed(3)} MHz${val ? ` · ${val}` : ''} ×`;
    tag.title = 'Click to remove';
    tag.onclick = () => {
      const idx = markers.findIndex((x) => x.id === m.id);
      if (idx >= 0) markers.splice(idx, 1);
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
    let param = 0;
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
      const name = pt.data.name as string;
      const idx = PARAM_NAMES.findIndex((n) => name.includes(n));
      param = idx >= 0 ? idx : 0;
    }

    if (!markers.some((m) => m.freq === freqHz && m.param === param)) {
      if (markers.length >= MAX_MARKERS) markers.shift();
      markers.push({ id: nextMarkerId++, freq: freqHz, param });
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
  if (e.dataTransfer?.files) Array.from(e.dataTransfer.files).forEach(load);
});

dropZone.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.s1p,.s2p';
  input.multiple = true;
  input.onchange = () => {
    if (input.files) Array.from(input.files).forEach(load);
  };
  input.click();
});

viewNav.querySelectorAll<HTMLButtonElement>('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    view = btn.dataset.view as View;
    viewNav.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    updateScaleBarVisibility();
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

scaleDivInput.addEventListener('change', () => {
  const v = parseFloat(scaleDivInput.value);
  if (Number.isFinite(v) && v > 0) {
    dbPerDiv = v;
    renderChart();
  }
});

scaleRefInput.addEventListener('change', () => {
  const v = parseFloat(scaleRefInput.value);
  if (Number.isFinite(v)) {
    refLevel = v;
    renderChart();
  }
});

scaleAutoBtn.addEventListener('click', autoscaleOnce);
