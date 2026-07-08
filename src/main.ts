import { parse, toDB, toPhase, toVSWR } from './parser';
import { render, PARAM_NAMES, SINGLE_COLORS, type View, type ChartEntry, type Marker } from './chart';
import { findPeak, findMin, findNextPeak, findBandwidth, type BandwidthResult } from './markers';
import type { TouchstoneData, Complex } from './parser';
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
let activeMarkerId: number | null = null;
let deltaRefId: number | null = null;
let dbPerDiv = 10;
let refLevel = 0;
let freqRange: [number, number] | null = null;

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
const markerOverlay = document.getElementById('marker-overlay')!;
const markerTableBody = document.querySelector('#marker-table tbody')!;
const markerDeltaToggle = document.getElementById('marker-delta-toggle') as HTMLButtonElement;
const scaleBar = document.getElementById('scale-bar')!;
const scaleDivInput = document.getElementById('scale-div') as HTMLInputElement;
const scaleRefInput = document.getElementById('scale-ref') as HTMLInputElement;
const scaleAutoBtn = document.getElementById('scale-auto')!;
const freqBar = document.getElementById('freq-bar')!;
const freqStartInput = document.getElementById('freq-start') as HTMLInputElement;
const freqStopInput = document.getElementById('freq-stop') as HTMLInputElement;
const freqCenterInput = document.getElementById('freq-center') as HTMLInputElement;
const freqSpanInput = document.getElementById('freq-span') as HTMLInputElement;
const softkeyRail = document.getElementById('softkey-rail')!;
const searchPeakBtn = document.getElementById('search-peak') as HTMLButtonElement;
const searchMinBtn = document.getElementById('search-min') as HTMLButtonElement;
const searchNextLeftBtn = document.getElementById('search-next-left') as HTMLButtonElement;
const searchNextRightBtn = document.getElementById('search-next-right') as HTMLButtonElement;
const markerNewCenterBtn = document.getElementById('marker-new-center') as HTMLButtonElement;
const markerClearActiveBtn = document.getElementById('marker-clear-active') as HTMLButtonElement;
const markerClearAllBtn = document.getElementById('marker-clear-all') as HTMLButtonElement;
const bwSearchBtn = document.getElementById('bw-search') as HTMLButtonElement;
const bwThresholdInput = document.getElementById('bw-threshold') as HTMLInputElement;
const bwOverlay = document.getElementById('bw-overlay')!;

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
    softkeyRail.hidden = false;

    renderFileBar();
    updateScaleBarVisibility();
    renderMarkerTable();
    renderChart().then(() => {
      attachClickListener();
      attachRelayoutListener();
    });
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
  activeMarkerId = null;
  deltaRefId = null;
  dbPerDiv = 10;
  refLevel = 0;
  freqRange = null;
  scaleDivInput.value = String(dbPerDiv);
  scaleRefInput.value = String(refLevel);
  dropZone.hidden = false;
  scopeArea.hidden = true;
  viewNav.hidden = true;
  fileBar.hidden = true;
  clearBtn.hidden = true;
  compareBtn.hidden = true;
  scaleBar.hidden = true;
  freqBar.hidden = true;
  softkeyRail.hidden = true;
  bwOverlay.hidden = true;
  traceInfoBar.innerHTML = '';
  renderMarkerTable();
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
  renderFreqBar(entries);
  return render(chartEl, entries, view, markers, dbPerDiv, refLevel, freqRange, activeMarkerId, deltaRefId);
}

function dataExtent(entries: ChartEntry[]): [number, number] | null {
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

function renderFreqBar(entries: ChartEntry[]): void {
  freqBar.hidden = entries.length === 0 || view === 'smith';
  if (freqBar.hidden) return;
  const range = freqRange ?? dataExtent(entries);
  if (!range) return;
  const [start, stop] = range;
  freqStartInput.value = (start / 1e6).toFixed(3);
  freqStopInput.value = (stop / 1e6).toFixed(3);
  freqCenterInput.value = ((start + stop) / 2 / 1e6).toFixed(3);
  freqSpanInput.value = ((stop - start) / 1e6).toFixed(3);
}

function applyStartStop(): void {
  const startMHz = parseFloat(freqStartInput.value);
  const stopMHz = parseFloat(freqStopInput.value);
  if (!Number.isFinite(startMHz) || !Number.isFinite(stopMHz) || stopMHz <= startMHz) return;
  freqRange = [startMHz * 1e6, stopMHz * 1e6];
  renderChart();
}

function applyCenterSpan(): void {
  const centerMHz = parseFloat(freqCenterInput.value);
  const spanMHz = parseFloat(freqSpanInput.value);
  if (!Number.isFinite(centerMHz) || !Number.isFinite(spanMHz) || spanMHz <= 0) return;
  freqRange = [(centerMHz - spanMHz / 2) * 1e6, (centerMHz + spanMHz / 2) * 1e6];
  renderChart();
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

function markerRawValue(marker: Marker): number | null {
  if (compareMode) return null;
  const f = files.find((f) => f.name === activeFile);
  if (!f) return null;
  const pt = f.data.points.reduce((a, b) =>
    Math.abs(b.freq - marker.freq) < Math.abs(a.freq - marker.freq) ? b : a,
  );
  const c = pt.params[marker.param];
  if (!c) return null;
  if (view === 'db') return toDB(c);
  if (view === 'phase') return toPhase(c);
  if (view === 'vswr') return toVSWR(c);
  return null;
}

function formatMarkerValue(raw: number | null): string {
  if (raw === null) return '';
  if (view === 'db') return `${raw.toFixed(2)} dB`;
  if (view === 'phase') return `${raw.toFixed(1)}°`;
  if (view === 'vswr') return `VSWR ${raw.toFixed(2)}`;
  return '';
}

function formatDeltaValue(raw: number): string {
  const sign = raw >= 0 ? '+' : '';
  if (view === 'db') return `${sign}${raw.toFixed(2)} dB`;
  if (view === 'phase') return `${sign}${raw.toFixed(1)}°`;
  if (view === 'vswr') return `${sign}${raw.toFixed(2)}`;
  return '';
}

function markerValue(marker: Marker): string {
  return formatMarkerValue(markerRawValue(marker));
}

function activeMarkerObj(): Marker | undefined {
  return markers.find((m) => m.id === activeMarkerId);
}

function currentValueFn(): (c: Complex) => number {
  return view === 'phase' ? toPhase : view === 'vswr' ? toVSWR : toDB;
}

function addMarker(freq: number, param: number): Marker {
  if (markers.length >= MAX_MARKERS) {
    const evicted = markers.shift()!;
    if (activeMarkerId === evicted.id) activeMarkerId = null;
    if (deltaRefId === evicted.id) deltaRefId = null;
  }
  const newMarker: Marker = { id: nextMarkerId++, freq, param };
  markers.push(newMarker);
  activeMarkerId = newMarker.id;
  return newMarker;
}

function updateRailState(): void {
  const hasFile = files.length > 0;
  const hasActive = activeMarkerId !== null;
  const searchEnabled = hasFile && hasActive && view !== 'smith' && !compareMode;
  searchPeakBtn.disabled = !searchEnabled;
  searchMinBtn.disabled = !searchEnabled;
  searchNextLeftBtn.disabled = !searchEnabled;
  searchNextRightBtn.disabled = !searchEnabled;
  markerNewCenterBtn.disabled = !hasFile;
  markerClearActiveBtn.disabled = !hasActive;
  markerClearAllBtn.disabled = markers.length === 0;
  bwSearchBtn.disabled = !(hasFile && hasActive && view === 'db' && !compareMode);
}

function renderBwOverlay(result: BandwidthResult | null, thresholdDb: number): void {
  bwOverlay.hidden = false;
  if (!result) {
    bwOverlay.textContent = 'BW: N/A (peak too close to data edge)';
    return;
  }
  const q = Number.isFinite(result.q) ? result.q.toFixed(1) : '—';
  bwOverlay.textContent = `BW ${(result.bandwidth / 1e3).toFixed(1)} kHz · CTR ${(result.centerFreq / 1e6).toFixed(3)} MHz · Q ${q} · -${thresholdDb}dB`;
}

function renderMarkerTable(): void {
  markerOverlay.hidden = markers.length === 0;
  markerTableBody.innerHTML = '';

  markerDeltaToggle.disabled = activeMarkerId === null;
  markerDeltaToggle.classList.toggle('active', activeMarkerId !== null && activeMarkerId === deltaRefId);
  updateRailState();

  const ref = deltaRefId !== null ? markers.find((m) => m.id === deltaRefId) ?? null : null;

  markers.forEach((m, idx) => {
    const row = document.createElement('tr');
    row.className = [m.id === activeMarkerId ? 'active' : '', m.id === deltaRefId ? 'delta-ref' : '']
      .filter(Boolean)
      .join(' ');
    row.onclick = () => {
      activeMarkerId = m.id;
      renderMarkerTable();
      renderChart();
    };

    const numCell = document.createElement('td');
    numCell.className = 'marker-num';
    numCell.textContent = String(idx + 1);

    const freqCell = document.createElement('td');
    const valCell = document.createElement('td');

    if (ref && ref.id !== m.id) {
      const dFreqMHz = (m.freq - ref.freq) / 1e6;
      freqCell.textContent = `${dFreqMHz >= 0 ? '+' : ''}${dFreqMHz.toFixed(3)} MHz`;
      const rawM = markerRawValue(m);
      const rawRef = markerRawValue(ref);
      valCell.textContent = rawM !== null && rawRef !== null ? formatDeltaValue(rawM - rawRef) : '';
    } else {
      freqCell.textContent = `${(m.freq / 1e6).toFixed(3)} MHz`;
      valCell.textContent = markerValue(m);
    }

    const removeCell = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.className = 'marker-remove';
    removeBtn.textContent = '×';
    removeBtn.title = 'Remove marker';
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      const i = markers.findIndex((x) => x.id === m.id);
      if (i >= 0) markers.splice(i, 1);
      if (activeMarkerId === m.id) activeMarkerId = null;
      if (deltaRefId === m.id) deltaRefId = null;
      renderMarkerTable();
      renderChart();
    };
    removeCell.appendChild(removeBtn);

    row.append(numCell, freqCell, valCell, removeCell);
    markerTableBody.appendChild(row);
  });
}

let clickListenerAttached = false;

function attachClickListener(): void {
  if (clickListenerAttached) return;
  clickListenerAttached = true;

  (chartEl as any).on('plotly_click', (ev: any) => {
    const candidates = (ev.points ?? []).filter((p: any) =>
      ['S11', 'S21', 'S12', 'S22'].some((n) => (p.data.name as string)?.includes(n)),
    );
    if (candidates.length === 0) return;

    // hovermode 'x unified' returns one point per visible trace at the clicked x,
    // not necessarily ordered by proximity to the cursor — pick whichever candidate
    // is actually closest to the click in data space so markers land on the curve
    // the user visually clicked, not just the first trace Plotly happens to list.
    let pt = candidates[0];
    if (view !== 'smith' && candidates.length > 1 && ev.event) {
      const layout = (chartEl as any)._fullLayout;
      const bb = chartEl.getBoundingClientRect();
      const pixelY = ev.event.clientY - bb.top - layout.margin.t;
      const clickDataY = layout.yaxis.p2d(pixelY);
      pt = candidates.reduce((a: any, b: any) =>
        Math.abs(b.y - clickDataY) < Math.abs(a.y - clickDataY) ? b : a,
      );
    }

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
      addMarker(freqHz, param);
      renderMarkerTable();
      renderChart();
    }
  });
}

let relayoutListenerAttached = false;

function attachRelayoutListener(): void {
  if (relayoutListenerAttached) return;
  relayoutListenerAttached = true;

  (chartEl as any).on('plotly_relayout', (ev: any) => {
    if (view === 'smith') return;
    if (ev['xaxis.autorange']) {
      freqRange = null;
      renderFreqBar(activeEntries());
      return;
    }
    const x0 = ev['xaxis.range[0]'];
    const x1 = ev['xaxis.range[1]'];
    if (typeof x0 === 'number' && typeof x1 === 'number') {
      freqRange = [x0 * 1e6, x1 * 1e6];
      renderFreqBar(activeEntries());
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
    bwOverlay.hidden = true;
    renderMarkerTable();
    renderChart();
  });
});

compareBtn.addEventListener('click', () => {
  compareMode = !compareMode;
  compareBtn.classList.toggle('active', compareMode);
  bwOverlay.hidden = true;
  renderFileBar();
  renderMarkerTable();
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

freqStartInput.addEventListener('change', applyStartStop);
freqStopInput.addEventListener('change', applyStartStop);
freqCenterInput.addEventListener('change', applyCenterSpan);
freqSpanInput.addEventListener('change', applyCenterSpan);

markerDeltaToggle.addEventListener('click', () => {
  if (activeMarkerId === null) return;
  deltaRefId = deltaRefId === activeMarkerId ? null : activeMarkerId;
  renderMarkerTable();
  renderChart();
});

searchPeakBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = files.find((f) => f.name === activeFile);
  if (!m || !f) return;
  m.freq = findPeak(f.data.points, m.param, currentValueFn()).freq;
  renderMarkerTable();
  renderChart();
});

searchMinBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = files.find((f) => f.name === activeFile);
  if (!m || !f) return;
  m.freq = findMin(f.data.points, m.param, currentValueFn()).freq;
  renderMarkerTable();
  renderChart();
});

searchNextLeftBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = files.find((f) => f.name === activeFile);
  if (!m || !f) return;
  const pt = findNextPeak(f.data.points, m.param, currentValueFn(), m.freq, 'left');
  if (pt) {
    m.freq = pt.freq;
    renderMarkerTable();
    renderChart();
  }
});

searchNextRightBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = files.find((f) => f.name === activeFile);
  if (!m || !f) return;
  const pt = findNextPeak(f.data.points, m.param, currentValueFn(), m.freq, 'right');
  if (pt) {
    m.freq = pt.freq;
    renderMarkerTable();
    renderChart();
  }
});

markerNewCenterBtn.addEventListener('click', () => {
  const entries = activeEntries();
  if (entries.length === 0) return;
  const range = freqRange ?? dataExtent(entries);
  if (!range) return;
  addMarker((range[0] + range[1]) / 2, 0);
  renderMarkerTable();
  renderChart();
});

markerClearActiveBtn.addEventListener('click', () => {
  if (activeMarkerId === null) return;
  const i = markers.findIndex((m) => m.id === activeMarkerId);
  if (i >= 0) markers.splice(i, 1);
  if (deltaRefId === activeMarkerId) deltaRefId = null;
  activeMarkerId = null;
  renderMarkerTable();
  renderChart();
});

markerClearAllBtn.addEventListener('click', () => {
  markers.length = 0;
  activeMarkerId = null;
  deltaRefId = null;
  bwOverlay.hidden = true;
  renderMarkerTable();
  renderChart();
});

bwSearchBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = files.find((f) => f.name === activeFile);
  if (!m || !f || view !== 'db') return;
  const threshold = parseFloat(bwThresholdInput.value);
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  const peakPt = findPeak(f.data.points, m.param, toDB);
  m.freq = peakPt.freq;
  const result = findBandwidth(f.data.points, m.param, toDB, peakPt.freq, threshold);
  renderBwOverlay(result, threshold);
  renderMarkerTable();
  renderChart();
});
