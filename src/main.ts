import { parse, toDB, toPhase, toVSWR, toImpedance, groupDelay, mag, paramIndices, serialize } from './parser';
import { render, PARAM_NAMES, singleColors, theme, toImage, type View, type ChartEntry, type Marker } from './chart';
import { drawTextPanel } from './chartExport';
import { findPeak, findMin, findNextPeak, findBandwidth, type BandwidthResult } from './markers';
import { evaluateLimits, type LimitLine } from './limits';
import type { TouchstoneData, Complex } from './parser';
import { getLang, setLang, t, getTheme, setTheme, type Lang } from './prefs';
import { buildCSV, downloadBlob } from './export';
import * as storage from './storage';
import { LiveController, type LiveStatus } from './live/liveController';
import { isWebSerialSupported } from './live/serialTransport';
import type { CalStep } from './live/nanovnaProtocol';
import './style.css';

const LIVE_NAME = 'NanoVNA Live.s2p';

document.documentElement.lang = getLang();
document.documentElement.dataset.theme = getTheme();

const buildVersionEl = document.getElementById('build-version') as HTMLAnchorElement | null;
if (buildVersionEl) {
  buildVersionEl.textContent = __GIT_COMMIT__;
  buildVersionEl.href = `https://github.com/reynico/vnaview/commit/${__GIT_COMMIT__}`;
  buildVersionEl.title = `Deployed commit ${__GIT_COMMIT__}`;
}

interface LoadedFile {
  name: string;
  data: TouchstoneData;
  color: string;
  text: string;
}

const MAX_MARKERS = 6;

// Views with a Re/Im(Γ) plane instead of a linear frequency axis: no freq
// bar, no dB/DIV scale bar, marker placement snaps to nearest point in x/y
// space rather than reading frequency off the x-axis.
const POLAR_LIKE_VIEWS = new Set<View>(['smith', 'polar']);
// Views where marker peak/min/next-peak/BW search doesn't apply: the above,
// plus Group Delay, whose value is a derivative across points rather than a
// per-point transform the search helpers can evaluate directly.
const NO_SEARCH_VIEWS = new Set<View>(['smith', 'polar', 'groupdelay']);

let files: LoadedFile[] = [];
let lastChipNameClick: { name: string; time: number } | null = null;
let activeFile: string | null = null;
let compareMode = false;
let view: View = 'db';
const markers: Marker[] = [];
let nextMarkerId = 1;
let activeMarkerId: number | null = null;
let deltaRefId: number | null = null;
// Individually hidden traces, keyed by `${entryLabel}#${paramIndex}` so a
// toggle survives view switches and re-renders of the same file/param.
const hiddenTraces = new Set<string>();
function traceKey(label: string, param: number): string {
  return `${label}#${param}`;
}
// Per-trace color/width overrides set via the trace-info-bar pickers, keyed
// the same way as hiddenTraces. Absent entries fall back to the theme palette.
interface TraceStyle {
  color?: string;
  width?: number;
}
const traceOverrides = new Map<string, TraceStyle>();
type ScaleView = 'db' | 'phase' | 'vswr' | 'groupdelay';
const SCALE_UNITS: Record<ScaleView, string> = { db: 'dB', phase: '°', vswr: 'VSWR', groupdelay: 'ns' };
function defaultScaleState(): Record<ScaleView, { perDiv: number; ref: number }> {
  return {
    db: { perDiv: 10, ref: 0 },
    phase: { perDiv: 45, ref: 0 },
    vswr: { perDiv: 0.2, ref: 3 },
    groupdelay: { perDiv: 5, ref: 0 },
  };
}
let scaleState = defaultScaleState();
let dbPerDiv = 10;
let refLevel = 0;
let freqRange: [number, number] | null = null;
let xDivisions = 10;

let limitUpperEnabled = false;
let limitLowerEnabled = false;

interface MemoryTrace {
  name: string;
  data: TouchstoneData;
  text: string;
}
let memoryTrace: MemoryTrace | null = null;
let memoryVisible = false;
// Replaces the normal absolute-value display with a per-param (current -
// memory) trace; only meaningful for the rectangular views, single-file mode.
let memoryDeltaVisible = false;

const mainEl = document.querySelector('main')!;
const dropZone = document.getElementById('drop-zone')!;
const scopeArea = document.getElementById('scope-area')!;
const traceInfoBar = document.getElementById('trace-info-bar')!;
const chartEl = document.getElementById('chart')!;
const viewNav = document.getElementById('views')!;
const fileBar = document.getElementById('file-bar')!;
const fileChips = document.getElementById('file-chips')!;
const compareBtn = document.getElementById('compare')!;
const exportCsvBtn = document.getElementById('export-csv')!;
const exportTouchstoneBtn = document.getElementById('export-touchstone') as HTMLButtonElement;
const clearBtn = document.getElementById('clear')!;
const markerOverlay = document.getElementById('marker-overlay')!;
const markerTableBody = document.querySelector('#marker-table tbody')!;
const markerDeltaToggle = document.getElementById('marker-delta-toggle') as HTMLButtonElement;
const scaleBar = document.getElementById('scale-bar')!;
const scaleDivInput = document.getElementById('scale-div') as HTMLInputElement;
const scaleRefInput = document.getElementById('scale-ref') as HTMLInputElement;
const scaleDivUnitEl = document.getElementById('scale-div-unit')!;
const scaleRefUnitEl = document.getElementById('scale-ref-unit')!;
const scaleAutoBtn = document.getElementById('scale-auto')!;
const freqBar = document.getElementById('freq-bar')!;
const freqStartInput = document.getElementById('freq-start') as HTMLInputElement;
const freqStopInput = document.getElementById('freq-stop') as HTMLInputElement;
const freqCenterInput = document.getElementById('freq-center') as HTMLInputElement;
const freqSpanInput = document.getElementById('freq-span') as HTMLInputElement;
const freqDivInput = document.getElementById('freq-div') as HTMLInputElement;
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
const langToggleBtn = document.getElementById('lang-toggle') as HTMLButtonElement;
const themeToggleBtn = document.getElementById('theme-toggle') as HTMLButtonElement;
const limitUpperInput = document.getElementById('limit-upper') as HTMLInputElement;
const limitLowerInput = document.getElementById('limit-lower') as HTMLInputElement;
const limitUpperToggleBtn = document.getElementById('limit-upper-toggle') as HTMLButtonElement;
const limitLowerToggleBtn = document.getElementById('limit-lower-toggle') as HTMLButtonElement;
const memorySaveBtn = document.getElementById('memory-save') as HTMLButtonElement;
const memoryToggleBtn = document.getElementById('memory-toggle') as HTMLButtonElement;
const memoryDeltaToggleBtn = document.getElementById('memory-delta-toggle') as HTMLButtonElement;
const memoryClearBtn = document.getElementById('memory-clear') as HTMLButtonElement;
const liveConnectBtn = document.getElementById('live-connect') as HTMLButtonElement;
const liveBarEl = document.getElementById('live-bar')!;
const liveStatusEl = document.getElementById('live-status')!;
const liveStatusTextEl = document.getElementById('live-status-text')!;
const liveStartInput = document.getElementById('live-start') as HTMLInputElement;
const liveStopInput = document.getElementById('live-stop') as HTMLInputElement;
const livePointsInput = document.getElementById('live-points') as HTMLInputElement;
const liveBaudSelect = document.getElementById('live-baud') as HTMLSelectElement;
const liveSweepToggleBtn = document.getElementById('live-sweep-toggle') as HTMLButtonElement;
const liveCalOpenBtn = document.getElementById('live-cal-open') as HTMLButtonElement;
const liveLogToggleBtn = document.getElementById('live-log-toggle') as HTMLButtonElement;
const liveDisconnectBtn = document.getElementById('live-disconnect') as HTMLButtonElement;
const liveLogEl = document.getElementById('live-log')!;
const calWizardEl = document.getElementById('cal-wizard')!;
const calWizardStepLabelEl = document.getElementById('cal-wizard-step-label')!;
const calWizardInstructionsEl = document.getElementById('cal-wizard-instructions')!;
const calWizardStepsEl = document.getElementById('cal-wizard-steps')!;
const calWizardCaptureBtn = document.getElementById('cal-wizard-capture') as HTMLButtonElement;
const calWizardSkipBtn = document.getElementById('cal-wizard-skip') as HTMLButtonElement;
const calWizardCancelBtn = document.getElementById('cal-wizard-cancel') as HTMLButtonElement;
const liveErrorBanner = document.getElementById('live-error-banner')!;
const liveErrorText = document.getElementById('live-error-text')!;
const liveErrorDismissBtn = document.getElementById('live-error-dismiss') as HTMLButtonElement;

function applyI18n(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n!);
  });
  const otherLang: Lang = getLang() === 'en' ? 'es' : 'en';
  langToggleBtn.textContent = otherLang.toUpperCase();
  langToggleBtn.title = t('langToggleLabel');
  themeToggleBtn.textContent = getTheme() === 'dark' ? t('themeLight') : t('themeDark');
  themeToggleBtn.title = t('themeToggleLabel');
}

function refreshDynamicText(): void {
  renderMarkerTable();
  if (!bwOverlay.hidden) renderBwOverlay(lastBwResult, lastBwThreshold);
  renderChart();
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Read from CSS custom properties so per-file colors flip with the
// dark/light theme instead of staying fixed to whichever theme was active
// when a file was loaded.
function fileColors(): string[] {
  return Array.from({ length: 8 }, (_, i) => cssVar(`--file-${i}`));
}

function nextColor(): string {
  const colors = fileColors();
  return colors[files.length % colors.length];
}

function memoryColor(): string {
  return cssVar('--memory');
}

function currentLimits(): LimitLine[] {
  const limits: LimitLine[] = [];
  if (limitUpperEnabled) {
    const v = parseFloat(limitUpperInput.value);
    if (Number.isFinite(v)) limits.push({ kind: 'upper', value: v });
  }
  if (limitLowerEnabled) {
    const v = parseFloat(limitLowerInput.value);
    if (Number.isFinite(v)) limits.push({ kind: 'lower', value: v });
  }
  return limits;
}

// `focus` jumps the view to this entry and drops compare mode - right for a
// one-shot file load, wrong for a live sweep tick that would otherwise yank
// the user back to the live trace every second even if they'd clicked away
// to compare a reference file.
function applyData(name: string, data: TouchstoneData, text: string, focus = true): void {
  const existing = files.findIndex((f) => f.name === name);
  if (existing >= 0) {
    files[existing].data = data;
    files[existing].text = text;
  } else {
    files.push({ name, data, color: nextColor(), text });
  }
  if (focus) {
    activeFile = name;
    compareMode = false;
  }

  dropZone.hidden = true;
  scopeArea.hidden = false;
  viewNav.hidden = false;
  clearBtn.hidden = false;
  exportCsvBtn.hidden = false;
  exportTouchstoneBtn.hidden = false;
  softkeyRail.hidden = false;

  renderFileBar();
  updateScaleBarVisibility();
  applyScaleForView();
  renderMarkerTable();
  renderChart().then(() => {
    attachClickListener();
    attachRelayoutListener();
  });
}

function ingestText(name: string, text: string): void {
  applyData(name, parse(text, name), text);
}

function load(file: File): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    const text = e.target!.result as string;
    ingestText(file.name, text);
    storage.saveFile(file.name, text).catch((err) => console.error('vnaviewer: failed to persist file', err));
  };
  reader.readAsText(file);
}

function restoreFromStorage(): void {
  storage
    .loadFiles()
    .then((stored) => {
      for (const { name, text } of stored) ingestText(name, text);
    })
    .catch((err) => console.error('vnaviewer: failed to restore files', err));

  storage
    .loadMemory()
    .then((stored) => {
      if (!stored) return;
      const data = parse(stored.text, stored.name);
      if (stored.full === false) data.full = false;
      memoryTrace = { name: stored.name, data, text: stored.text };
      memoryVisible = true;
      memoryToggleBtn.classList.add('active');
      updateRailState();
      renderChart();
    })
    .catch((err) => console.error('vnaviewer: failed to restore memory trace', err));
}

function removeFile(name: string): void {
  if (name === LIVE_NAME) stopLiveSweep();
  files = files.filter((f) => f.name !== name);
  for (const key of hiddenTraces) {
    if (key.startsWith(`${name}#`)) hiddenTraces.delete(key);
  }
  for (const key of Array.from(traceOverrides.keys())) {
    if (key.startsWith(`${name}#`)) traceOverrides.delete(key);
  }
  storage.deleteFile(name).catch((err) => console.error('vnaviewer: failed to remove persisted file', err));
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
  stopLiveSweep();
  files = [];
  activeFile = null;
  compareMode = false;
  markers.length = 0;
  nextMarkerId = 1;
  activeMarkerId = null;
  deltaRefId = null;
  bwLowMarkerId = null;
  bwHighMarkerId = null;
  hiddenTraces.clear();
  traceOverrides.clear();
  scaleState = defaultScaleState();
  applyScaleForView();
  freqRange = null;
  xDivisions = 10;
  freqDivInput.value = '10';
  limitUpperEnabled = false;
  limitLowerEnabled = false;
  limitUpperToggleBtn.classList.remove('active');
  limitLowerToggleBtn.classList.remove('active');
  memoryTrace = null;
  memoryVisible = false;
  memoryDeltaVisible = false;
  memoryToggleBtn.classList.remove('active');
  memoryDeltaToggleBtn.classList.remove('active');
  storage.clearFiles().catch((err) => console.error('vnaviewer: failed to clear persisted files', err));
  storage.clearMemory().catch((err) => console.error('vnaviewer: failed to clear persisted memory', err));
  dropZone.hidden = false;
  scopeArea.hidden = true;
  viewNav.hidden = true;
  fileBar.hidden = true;
  clearBtn.hidden = true;
  compareBtn.hidden = true;
  exportCsvBtn.hidden = true;
  exportTouchstoneBtn.hidden = true;
  scaleBar.hidden = true;
  freqBar.hidden = true;
  softkeyRail.hidden = true;
  bwOverlay.hidden = true;
  traceInfoBar.innerHTML = '';
  renderMarkerTable();
}

function applyScaleForView(): void {
  if (POLAR_LIKE_VIEWS.has(view)) return;
  const s = scaleState[view as ScaleView];
  dbPerDiv = s.perDiv;
  refLevel = s.ref;
  scaleDivInput.value = String(dbPerDiv);
  scaleRefInput.value = String(refLevel);
  scaleDivUnitEl.textContent = SCALE_UNITS[view as ScaleView];
  scaleRefUnitEl.textContent = SCALE_UNITS[view as ScaleView];
}

function updateScaleBarVisibility(): void {
  scaleBar.hidden = files.length === 0 || POLAR_LIKE_VIEWS.has(view);
}

function autoscaleOnce(): void {
  if (POLAR_LIKE_VIEWS.has(view)) return;
  const entries = activeEntries();
  if (entries.length === 0) return;
  const fn = currentValueFn();
  let maxVal = -Infinity;
  for (const { label, data } of entries) {
    for (const i of paramIndices(data, compareMode)) {
      if (hiddenTraces.has(traceKey(label, i))) continue;
      // groupDelay is a derivative across points, not a per-point valueFn.
      const values = view === 'groupdelay' ? groupDelay(data.points, i).map((v) => v * 1e9) : data.points.map((p) => fn(p.params[i]));
      for (const v of values) {
        if (Number.isFinite(v) && v > maxVal) maxVal = v;
      }
    }
  }
  if (!Number.isFinite(maxVal)) return;
  refLevel = Math.ceil(maxVal / dbPerDiv) * dbPerDiv;
  scaleState[view as ScaleView].ref = refLevel;
  scaleRefInput.value = String(refLevel);
  renderChart();
}

function activeEntries(): ChartEntry[] {
  if (compareMode) {
    return files.map((f) => ({ label: f.name, color: f.color, data: f.data }));
  }
  const f = files.find((f) => f.name === activeFile);
  if (!f) return [];
  const entries: ChartEntry[] = [{ label: f.name, color: f.color, data: f.data }];
  if ((memoryVisible || memoryDeltaVisible) && memoryTrace) {
    entries.push({ label: `${memoryTrace.name} (mem)`, color: memoryColor(), data: memoryTrace.data, isMemory: true });
  }
  return entries;
}

function showingMemoryDelta(): boolean {
  return memoryDeltaVisible && memoryTrace !== null && !compareMode && !POLAR_LIKE_VIEWS.has(view);
}

function renderChart(): Promise<void> {
  const entries = activeEntries();
  if (entries.length === 0) return Promise.resolve();
  const deltaMode = showingMemoryDelta();
  renderTraceInfoBar(entries, deltaMode);
  renderFreqBar(entries);
  const limitUpper = view === 'db' && limitUpperEnabled ? parseFloat(limitUpperInput.value) : NaN;
  const limitLower = view === 'db' && limitLowerEnabled ? parseFloat(limitLowerInput.value) : NaN;
  return render(
    chartEl,
    entries,
    view,
    markers,
    dbPerDiv,
    refLevel,
    freqRange,
    activeMarkerId,
    deltaRefId,
    Number.isFinite(limitUpper) ? limitUpper : null,
    Number.isFinite(limitLower) ? limitLower : null,
    hiddenTraces,
    traceOverrides,
    deltaMode,
    xDivisions,
    exportChartPng,
  );
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
  freqBar.hidden = entries.length === 0 || POLAR_LIKE_VIEWS.has(view);
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
  return v === 'db' ? 'dB Mag'
    : v === 'phase' ? t('phase')
    : v === 'vswr' ? 'VSWR'
    : v === 'groupdelay' ? t('groupDelay')
    : v === 'polar' ? t('polar')
    : 'Smith Chart';
}

function renderTraceInfoBar(entries: ChartEntry[], deltaMode = false): void {
  traceInfoBar.innerHTML = '';
  if (entries.length === 0) return;

  const addChip = (color: string, text: string, key: string | null = null, defaultWidth = 1.5) => {
    const chip = document.createElement('span');
    chip.className = 'trace-info' + (key && hiddenTraces.has(key) ? ' off' : '');

    if (!key) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = color;
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(text));
      traceInfoBar.appendChild(chip);
      return;
    }

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'trace-color';
    colorInput.value = traceOverrides.get(key)?.color ?? color;
    colorInput.title = t('traceColorHint');
    colorInput.addEventListener('click', (e) => e.stopPropagation());
    colorInput.addEventListener('input', () => {
      traceOverrides.set(key, { ...traceOverrides.get(key), color: colorInput.value });
      renderChart();
    });
    chip.appendChild(colorInput);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'trace-toggle';
    toggleBtn.textContent = text;
    toggleBtn.title = t('traceToggleHint');
    toggleBtn.addEventListener('click', () => {
      if (hiddenTraces.has(key)) hiddenTraces.delete(key);
      else hiddenTraces.add(key);
      renderChart();
    });
    chip.appendChild(toggleBtn);

    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.className = 'trace-width';
    widthInput.step = '0.5';
    widthInput.min = '0.5';
    widthInput.max = '5';
    widthInput.title = t('traceWidthHint');
    widthInput.value = String(traceOverrides.get(key)?.width ?? defaultWidth);
    widthInput.addEventListener('click', (e) => e.stopPropagation());
    widthInput.addEventListener('change', () => {
      const v = parseFloat(widthInput.value);
      traceOverrides.set(key, {
        ...traceOverrides.get(key),
        width: Number.isFinite(v) && v > 0 ? v : undefined,
      });
      renderChart();
    });
    chip.appendChild(widthInput);

    traceInfoBar.appendChild(chip);
  };

  if (deltaMode) {
    const main = entries.find((e) => !e.isMemory);
    const memEntry = entries.find((e) => e.isMemory);
    if (main && memEntry) {
      const idxs = paramIndices(main.data, false).filter((i) => paramIndices(memEntry.data, false).includes(i));
      const colors = singleColors();
      for (const i of idxs) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
        addChip(colors[i], `Δ ${PARAM_NAMES[i]} · vs ${memEntry.label}`);
      }
    }
    return;
  }

  const compare = entries.length > 1;
  const label = formatLabel(view);
  const scaleUnit = !POLAR_LIKE_VIEWS.has(view) ? SCALE_UNITS[view as ScaleView] : '';
  const scaleSuffix = !POLAR_LIKE_VIEWS.has(view) ? ` · ${dbPerDiv}${scaleUnit}/DIV · REF ${refLevel}${scaleUnit}` : '';

  for (const entry of entries) {
    if (view === 'smith') {
      const name = compare ? entry.label : 'S11';
      addChip(entry.color, `${name} · Smith Chart`, traceKey(entry.label, 0), 2);
      continue;
    }

    let paramIdxs: number[];
    if (compare) {
      paramIdxs = paramIndices(entry.data, true);
    } else {
      paramIdxs = [];
      for (const i of paramIndices(entry.data, false)) {
        if (view === 'vswr' && i !== 0 && i !== 3) continue;
        paramIdxs.push(i);
      }
    }

    for (const i of paramIdxs) {
      const name = compare ? `${entry.label} · ${PARAM_NAMES[i]}` : PARAM_NAMES[i];
      const color = compare ? entry.color : singleColors()[i];
      addChip(color, `${name} · ${label}${scaleSuffix}`, traceKey(entry.label, i));
    }
  }

  if (view === 'db') {
    const limits = currentLimits();
    if (limits.length > 0) {
      let anyFail = false;
      for (const entry of entries) {
        for (const i of paramIndices(entry.data, compare)) {
          if (!evaluateLimits(entry.data.points, i, toDB, limits).pass) anyFail = true;
        }
      }
      addChip(anyFail ? cssVar('--danger') : cssVar('--text'), anyFail ? t('limitFail') : t('limitPass'));
    }
  }
}

function renameFile(oldName: string, newInputValue: string): void {
  const file = files.find((f) => f.name === oldName);
  if (!file) return;
  const ext = oldName.slice(oldName.lastIndexOf('.'));
  let base = newInputValue.trim();
  if (base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, base.length - ext.length);
  base = base.trim();
  if (!base) {
    renderFileBar();
    return;
  }
  const newName = base + ext;
  if (newName === oldName || files.some((f) => f.name === newName)) {
    renderFileBar();
    return;
  }

  file.name = newName;
  if (activeFile === oldName) activeFile = newName;
  for (const key of Array.from(hiddenTraces)) {
    if (key.startsWith(`${oldName}#`)) {
      hiddenTraces.delete(key);
      hiddenTraces.add(`${newName}#${key.slice(oldName.length + 1)}`);
    }
  }
  for (const key of Array.from(traceOverrides.keys())) {
    if (key.startsWith(`${oldName}#`)) {
      const style = traceOverrides.get(key)!;
      traceOverrides.delete(key);
      traceOverrides.set(`${newName}#${key.slice(oldName.length + 1)}`, style);
    }
  }
  storage.renameFile(oldName, newName, file.text).catch((err) => console.error('vnaviewer: failed to persist rename', err));
  renderFileBar();
  renderChart();
}

function startRenameEdit(chip: HTMLElement, nameEl: HTMLElement, file: LoadedFile): void {
  const ext = file.name.slice(file.name.lastIndexOf('.'));
  const base = file.name.slice(0, file.name.length - ext.length);
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-name-input';
  input.value = file.name;
  chip.replaceChild(input, nameEl);
  input.focus();
  input.setSelectionRange(0, base.length);

  let done = false;
  input.addEventListener('blur', () => {
    if (done) return;
    done = true;
    renameFile(file.name, input.value);
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done = true;
      renderFileBar();
    }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

function renderFileBar(): void {
  fileBar.hidden = false;
  compareBtn.hidden = files.length < 2;
  compareBtn.classList.toggle('active', compareMode);

  fileChips.innerHTML = '';
  for (const file of files) {
    const chip = document.createElement('span');
    chip.className = 'file-chip' + (file.name === activeFile && !compareMode ? ' active' : '');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = file.color;

    const nameEl = document.createElement('span');
    nameEl.className = 'chip-name';
    nameEl.textContent = file.name;
    nameEl.title = t('renameHint');
    // Renaming triggers a full renderFileBar() on the first click, which
    // replaces this element — native dblclick tracking doesn't survive that
    // mid-gesture swap, so double-clicks are detected manually by name+time.
    nameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const now = Date.now();
      if (lastChipNameClick && lastChipNameClick.name === file.name && now - lastChipNameClick.time < 400) {
        lastChipNameClick = null;
        startRenameEdit(chip, nameEl, file);
        return;
      }
      lastChipNameClick = { name: file.name, time: now };
      activeFile = file.name;
      compareMode = false;
      compareBtn.classList.remove('active');
      renderFileBar();
      renderChart();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'chip-remove';
    removeBtn.title = 'Remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFile(file.name);
    });

    chip.append(dot, nameEl, removeBtn);
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

function nearestSampledFreq(freqHz: number, marker?: Marker): number {
  const points = (markerFile(marker) ?? files.find((f) => f.name === activeFile))?.data.points;
  if (!points || points.length === 0) return freqHz;
  return points.reduce((a, b) => (Math.abs(b.freq - freqHz) < Math.abs(a.freq - freqHz) ? b : a)).freq;
}

// The file a marker's frequency/value should be read from: the marker's own
// fileLabel in compare mode (each marker belongs to one overlaid curve, see
// Marker.fileLabel), or simply the single active file otherwise.
function markerFile(marker: Marker | undefined): LoadedFile | undefined {
  if (!marker) return undefined;
  if (compareMode) return files.find((f) => f.name === marker.fileLabel);
  return files.find((f) => f.name === activeFile);
}

function markerRawValue(marker: Marker): number | null {
  const f = markerFile(marker);
  if (!f) return null;
  if (view === 'groupdelay') {
    const gd = groupDelay(f.data.points, marker.param);
    let idx = 0;
    let minDist = Infinity;
    f.data.points.forEach((p, i) => {
      const d = Math.abs(p.freq - marker.freq);
      if (d < minDist) {
        minDist = d;
        idx = i;
      }
    });
    return gd[idx] * 1e9;
  }
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
  if (view === 'groupdelay') return `${raw.toFixed(2)} ns`;
  return '';
}

function formatDeltaValue(raw: number): string {
  const sign = raw >= 0 ? '+' : '';
  if (view === 'db') return `${sign}${raw.toFixed(2)} dB`;
  if (view === 'phase') return `${sign}${raw.toFixed(1)}°`;
  if (view === 'vswr') return `${sign}${raw.toFixed(2)}`;
  if (view === 'groupdelay') return `${sign}${raw.toFixed(2)} ns`;
  return '';
}

// Smith/Polar have no single-number "value" the way dB/phase/VSWR/group
// delay do: a reflection param (S11/S22) reads as an impedance, a
// transmission param (S21/S12) as a magnitude/phase ratio.
function markerPolarValue(marker: Marker): string {
  const f = markerFile(marker);
  if (!f) return '';
  const pt = f.data.points.reduce((a, b) =>
    Math.abs(b.freq - marker.freq) < Math.abs(a.freq - marker.freq) ? b : a,
  );
  const c = pt.params[marker.param];
  if (!c) return '';
  if (marker.param === 0 || marker.param === 3) {
    const z = toImpedance(c, f.data.impedance);
    if (!Number.isFinite(z.re) || !Number.isFinite(z.im)) return '∞';
    const sign = z.im >= 0 ? '+' : '−';
    return `${z.re.toFixed(1)} ${sign} j${Math.abs(z.im).toFixed(1)} Ω`;
  }
  return `${mag(c).toFixed(3)} ∠ ${toPhase(c).toFixed(1)}°`;
}

function markerValue(marker: Marker): string {
  if (POLAR_LIKE_VIEWS.has(view)) return markerPolarValue(marker);
  return formatMarkerValue(markerRawValue(marker));
}

function activeMarkerObj(): Marker | undefined {
  return markers.find((m) => m.id === activeMarkerId);
}

function currentValueFn(): (c: Complex) => number {
  return view === 'phase' ? toPhase : view === 'vswr' ? toVSWR : toDB;
}

function addMarker(freq: number, param: number, fileLabel?: string): Marker {
  if (markers.length >= MAX_MARKERS) {
    const evicted = markers.shift()!;
    if (activeMarkerId === evicted.id) activeMarkerId = null;
    if (deltaRefId === evicted.id) deltaRefId = null;
  }
  const newMarker: Marker = { id: nextMarkerId++, freq, param, fileLabel };
  markers.push(newMarker);
  activeMarkerId = newMarker.id;
  return newMarker;
}

function updateRailState(): void {
  const hasFile = files.length > 0;
  const hasActive = activeMarkerId !== null;
  // In compare mode a marker only has a resolvable file if it was placed on
  // (or otherwise assigned to) one of the currently overlaid curves - the
  // searches below operate on that specific file's data, not "the" active
  // file, which isn't a meaningful concept while comparing.
  const activeHasFile = !!markerFile(activeMarkerObj());
  const searchEnabled = hasFile && hasActive && !NO_SEARCH_VIEWS.has(view) && activeHasFile;
  searchPeakBtn.disabled = !searchEnabled;
  searchMinBtn.disabled = !searchEnabled;
  searchNextLeftBtn.disabled = !searchEnabled;
  searchNextRightBtn.disabled = !searchEnabled;
  markerNewCenterBtn.disabled = !hasFile;
  markerClearActiveBtn.disabled = !hasActive;
  markerClearAllBtn.disabled = markers.length === 0;
  bwSearchBtn.disabled = !(hasFile && hasActive && view === 'db' && activeHasFile);
  limitUpperToggleBtn.disabled = !hasFile;
  limitLowerToggleBtn.disabled = !hasFile;
  memorySaveBtn.disabled = !hasFile || compareMode;
  exportTouchstoneBtn.disabled = !hasFile || compareMode;
  memoryToggleBtn.disabled = !memoryTrace;
  memoryDeltaToggleBtn.disabled = !memoryTrace || compareMode || POLAR_LIKE_VIEWS.has(view);
  if (memoryDeltaToggleBtn.disabled && memoryDeltaVisible) {
    memoryDeltaVisible = false;
    memoryDeltaToggleBtn.classList.remove('active');
  }
  memoryClearBtn.disabled = !memoryTrace;
}

let lastBwResult: BandwidthResult | null = null;
let lastBwThreshold = 3;
let bwLowMarkerId: number | null = null;
let bwHighMarkerId: number | null = null;

// Bandwidths span kHz (crystal filters) to hundreds of MHz (RF filters), so
// pick whichever unit keeps the mantissa readable instead of always using kHz.
function formatFreqSpan(hz: number): string {
  const abs = Math.abs(hz);
  if (abs >= 1e6) return `${(hz / 1e6).toFixed(3)} MHz`;
  if (abs >= 1e3) return `${(hz / 1e3).toFixed(1)} kHz`;
  return `${hz.toFixed(0)} Hz`;
}

function renderBwOverlay(result: BandwidthResult | null, thresholdDb: number): void {
  lastBwResult = result;
  lastBwThreshold = thresholdDb;
  bwOverlay.hidden = false;
  if (!result) {
    bwOverlay.textContent = t('bwNotAvailable');
    return;
  }
  const q = Number.isFinite(result.q) ? result.q.toFixed(1) : '—';
  bwOverlay.textContent = `BW ${formatFreqSpan(result.bandwidth)} · CTR ${(result.centerFreq / 1e6).toFixed(3)} MHz · Q ${q} · -${thresholdDb}dB`;
}

function removeMarkerById(id: number | null): void {
  if (id === null) return;
  const i = markers.findIndex((x) => x.id === id);
  if (i >= 0) markers.splice(i, 1);
  if (activeMarkerId === id) activeMarkerId = null;
  if (deltaRefId === id) deltaRefId = null;
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
      const dFreq = m.freq - ref.freq;
      freqCell.textContent = `${dFreq >= 0 ? '+' : ''}${formatFreqSpan(dFreq)}`;
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
    if (!POLAR_LIKE_VIEWS.has(view) && candidates.length > 1 && ev.event) {
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
    let fileLabel: string | undefined;
    if (POLAR_LIKE_VIEWS.has(view)) {
      const name = pt.data.name as string;
      const idx = view === 'polar' ? PARAM_NAMES.findIndex((n) => name.includes(n)) : 0;
      param = idx >= 0 ? idx : 0;
      const ref = compareMode ? files.find((f) => name.startsWith(f.name)) ?? files[0] : files.find((f) => f.name === activeFile);
      if (!ref) return;
      fileLabel = compareMode ? ref.name : undefined;
      const closest = ref.data.points.reduce((a, b) =>
        (b.params[param].re - pt.x) ** 2 + (b.params[param].im - pt.y) ** 2 <
        (a.params[param].re - pt.x) ** 2 + (a.params[param].im - pt.y) ** 2
          ? b
          : a,
      );
      freqHz = closest.freq;
    } else {
      freqHz = (pt.x as number) * 1e6;
      const name = pt.data.name as string;
      const idx = PARAM_NAMES.findIndex((n) => name.includes(n));
      param = idx >= 0 ? idx : 0;
      // Compare-mode trace names are "<file> · <param>" (see chart.ts); a
      // single-file chart's trace is just the param name, so fileLabel stays
      // undefined there (matching Marker.fileLabel's meaning).
      fileLabel = compareMode ? files.find((f) => name.startsWith(f.name))?.name : undefined;
    }

    if (!markers.some((m) => m.freq === freqHz && m.param === param && m.fileLabel === fileLabel)) {
      addMarker(freqHz, param, fileLabel);
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
    if (POLAR_LIKE_VIEWS.has(view)) return;

    const draggedShapes = new Set<number>();
    for (const key of Object.keys(ev)) {
      const match = key.match(/^shapes\[(\d+)\]\.x[01]$/);
      if (match) draggedShapes.add(Number(match[1]));
    }
    if (draggedShapes.size > 0) {
      for (const i of draggedShapes) {
        const marker = markers[i];
        if (!marker) continue;
        const x0 = ev[`shapes[${i}].x0`];
        const x1 = ev[`shapes[${i}].x1`];
        const xMHz = x0 !== undefined && x1 !== undefined ? (x0 + x1) / 2 : (x0 ?? x1);
        if (typeof xMHz !== 'number') continue;
        marker.freq = nearestSampledFreq(xMHz * 1e6, marker);
      }
      renderMarkerTable();
      renderChart();
      return;
    }

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
    applyScaleForView();
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

// Wired into chart.ts's custom modebar button (replaces Plotly's default
// camera icon, which only ever rasterizes the plot itself) so the marker
// table and BW box - separate DOM overlays Plotly never sees - end up in
// the downloaded PNG too, matching what's actually on screen.
async function exportChartPng(): Promise<void> {
  const entries = activeEntries();
  if (entries.length === 0) return;

  const scale = 2;
  let dataUrl: string;
  try {
    dataUrl = await toImage(chartEl, scale);
  } catch (err) {
    console.error('vnaviewer: failed to rasterize chart for export', err);
    return;
  }

  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('failed to load rasterized chart'));
    img.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(img, 0, 0);

  const colors = theme();
  const panelColors = { bg: colors.bg, border: colors.border, text: colors.marker };

  if (!bwOverlay.hidden && bwOverlay.textContent) {
    drawTextPanel(ctx, canvas.width, canvas.height, [bwOverlay.textContent], 'bottom-left', scale, panelColors);
  }

  if (!markerOverlay.hidden) {
    const rows = Array.from(markerTableBody.querySelectorAll('tr')).map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'))
        .slice(0, 3)
        .map((td) => td.textContent?.trim() ?? '');
      return `M${cells[0] ?? ''}  ${cells[1] ?? ''}  ${cells[2] ?? ''}`;
    });
    if (rows.length > 0) drawTextPanel(ctx, canvas.width, canvas.height, rows, 'bottom-right', scale, panelColors);
  }

  canvas.toBlob((blob) => {
    if (!blob) return;
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const base = compareMode ? 'compare' : (activeFile ?? 'trace').replace(/\.[^.]+$/, '');
    downloadBlob(`${base}_${view}_${date}.png`, blob, 'image/png');
  }, 'image/png');
}

exportCsvBtn.addEventListener('click', () => {
  const entries = activeEntries();
  if (entries.length === 0) return;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = compareMode ? 'compare' : (activeFile ?? 'trace').replace(/\.[^.]+$/, '');
  downloadBlob(`${base}_${date}.csv`, buildCSV(entries), 'text/csv');
});

exportTouchstoneBtn.addEventListener('click', () => {
  const f = files.find((f) => f.name === activeFile);
  if (!f || compareMode) return;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const base = f.name.replace(/\.[^.]+$/, '');
  // f.text is already the right shape for both cases: the original bytes
  // for a loaded file, or serialize()'s zero-filled S12/S22 for a live
  // capture - matching what the NanoVNA itself writes when it saves a 2-port
  // file from a single-receiver (S11/S21-only) measurement.
  const ext = f.data.ports === 1 ? 's1p' : 's2p';
  downloadBlob(`${base}_${date}.${ext}`, f.text, 'text/plain');
});

scaleDivInput.addEventListener('change', () => {
  const v = parseFloat(scaleDivInput.value);
  if (Number.isFinite(v) && v > 0 && !POLAR_LIKE_VIEWS.has(view)) {
    dbPerDiv = v;
    scaleState[view as ScaleView].perDiv = v;
    renderChart();
  }
});

scaleRefInput.addEventListener('change', () => {
  const v = parseFloat(scaleRefInput.value);
  if (Number.isFinite(v) && !POLAR_LIKE_VIEWS.has(view)) {
    refLevel = v;
    scaleState[view as ScaleView].ref = v;
    renderChart();
  }
});

limitUpperToggleBtn.addEventListener('click', () => {
  limitUpperEnabled = !limitUpperEnabled;
  limitUpperToggleBtn.classList.toggle('active', limitUpperEnabled);
  renderChart();
});

limitLowerToggleBtn.addEventListener('click', () => {
  limitLowerEnabled = !limitLowerEnabled;
  limitLowerToggleBtn.classList.toggle('active', limitLowerEnabled);
  renderChart();
});

limitUpperInput.addEventListener('change', () => {
  if (limitUpperEnabled) renderChart();
});

limitLowerInput.addEventListener('change', () => {
  if (limitLowerEnabled) renderChart();
});

memorySaveBtn.addEventListener('click', () => {
  const f = files.find((f) => f.name === activeFile);
  if (!f || compareMode) return;
  memoryTrace = { name: f.name, data: f.data, text: f.text };
  memoryVisible = true;
  memoryToggleBtn.classList.add('active');
  storage.saveMemory(f.name, f.text, f.data.full).catch((err) => console.error('vnaviewer: failed to persist memory trace', err));
  updateRailState();
  renderChart();
});

memoryToggleBtn.addEventListener('click', () => {
  if (!memoryTrace) return;
  memoryVisible = !memoryVisible;
  memoryToggleBtn.classList.toggle('active', memoryVisible);
  renderChart();
});

memoryDeltaToggleBtn.addEventListener('click', () => {
  if (!memoryTrace) return;
  memoryDeltaVisible = !memoryDeltaVisible;
  memoryDeltaToggleBtn.classList.toggle('active', memoryDeltaVisible);
  renderChart();
});

memoryClearBtn.addEventListener('click', () => {
  memoryTrace = null;
  memoryVisible = false;
  memoryDeltaVisible = false;
  memoryToggleBtn.classList.remove('active');
  memoryDeltaToggleBtn.classList.remove('active');
  storage.clearMemory().catch((err) => console.error('vnaviewer: failed to clear persisted memory', err));
  updateRailState();
  renderChart();
});

scaleAutoBtn.addEventListener('click', autoscaleOnce);

freqStartInput.addEventListener('change', applyStartStop);
freqStopInput.addEventListener('change', applyStartStop);
freqCenterInput.addEventListener('change', applyCenterSpan);
freqSpanInput.addEventListener('change', applyCenterSpan);

freqDivInput.addEventListener('change', () => {
  const v = Math.round(parseFloat(freqDivInput.value));
  xDivisions = Number.isFinite(v) && v >= 2 ? v : 10;
  freqDivInput.value = String(xDivisions);
  renderChart();
});

markerDeltaToggle.addEventListener('click', () => {
  if (activeMarkerId === null) return;
  deltaRefId = deltaRefId === activeMarkerId ? null : activeMarkerId;
  renderMarkerTable();
  renderChart();
});

searchPeakBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = markerFile(m);
  if (!m || !f) return;
  m.freq = findPeak(f.data.points, m.param, currentValueFn()).freq;
  renderMarkerTable();
  renderChart();
});

searchMinBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = markerFile(m);
  if (!m || !f) return;
  m.freq = findMin(f.data.points, m.param, currentValueFn()).freq;
  renderMarkerTable();
  renderChart();
});

searchNextLeftBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = markerFile(m);
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
  const f = markerFile(m);
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
  // Compare mode has no single "active" file - default to the first
  // overlaid one so the new marker still lands somewhere searchable;
  // clicking directly on a curve (see attachClickListener) targets a
  // specific one instead.
  addMarker((range[0] + range[1]) / 2, 0, compareMode ? files[0]?.name : undefined);
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
  bwLowMarkerId = null;
  bwHighMarkerId = null;
  bwOverlay.hidden = true;
  renderMarkerTable();
  renderChart();
});

bwSearchBtn.addEventListener('click', () => {
  const m = activeMarkerObj();
  const f = markerFile(m);
  if (!m || !f || view !== 'db') return;
  const threshold = parseFloat(bwThresholdInput.value);
  if (!Number.isFinite(threshold) || threshold <= 0) return;

  const param = m.param;
  // If the active marker is the seed the user placed (not a leftover edge
  // marker from a prior search), it gets replaced by the new edge pair
  // instead of sticking around as a redundant third marker.
  const seedId = m.id !== bwLowMarkerId && m.id !== bwHighMarkerId ? m.id : null;
  const peakPt = findPeak(f.data.points, param, toDB);
  const result = findBandwidth(f.data.points, param, toDB, peakPt.freq, threshold);

  if (result) {
    removeMarkerById(bwLowMarkerId);
    removeMarkerById(bwHighMarkerId);
    if (seedId !== null) removeMarkerById(seedId);

    const fileLabel = compareMode ? f.name : undefined;
    const low = addMarker(result.lowFreq, param, fileLabel);
    const high = addMarker(result.highFreq, param, fileLabel);
    bwLowMarkerId = low.id;
    bwHighMarkerId = high.id;
    deltaRefId = low.id;
    activeMarkerId = high.id;
  }

  renderBwOverlay(result, threshold);
  renderMarkerTable();
  renderChart();
});

langToggleBtn.addEventListener('click', () => {
  setLang(getLang() === 'en' ? 'es' : 'en');
  applyI18n();
  refreshDynamicText();
});

themeToggleBtn.addEventListener('click', () => {
  setTheme(getTheme() === 'dark' ? 'light' : 'dark');
  applyI18n();
  // Files already carry a resolved color from whichever theme was active at
  // load time; re-resolve them from the new theme's palette so traces and
  // chips flip too, not just the chart chrome.
  const colors = fileColors();
  files.forEach((f, i) => (f.color = colors[i % colors.length]));
  renderFileBar();
  renderChart();
});

let liveSweeping = false;

function stopLiveSweep(): void {
  liveController.stopSweeping();
  liveSweeping = false;
  liveSweepToggleBtn.textContent = t('liveStartSweep');
}

function handleLiveStatus(status: LiveStatus, detail?: string): void {
  liveStatusEl.className = `live-status live-${status}`;
  liveStatusTextEl.textContent =
    status === 'disconnected' ? t('liveDisconnected')
    : status === 'connecting' ? t('liveConnecting')
    : status === 'sweeping' ? t('liveSweeping')
    : status === 'error' ? `${t('liveErrorPrefix')}${detail ?? ''}`
    : detail || 'NanoVNA';

  liveConnectBtn.hidden = status !== 'disconnected';
  liveBarEl.hidden = status === 'disconnected';
  // 'error' means a sweep/cal command failed, not that the connection was
  // torn down - the port is still open, so sweeping/calibrating again (or
  // just disconnecting) both stay available rather than forcing a re-pick.
  const isConnected = status === 'connected' || status === 'sweeping' || status === 'error';
  liveSweepToggleBtn.disabled = !isConnected;
  liveCalOpenBtn.disabled = !isConnected;

  if (status === 'disconnected' || status === 'error') {
    liveSweeping = false;
    liveSweepToggleBtn.textContent = t('liveStartSweep');
    calWizardEl.hidden = true;
  }

  if (status === 'error') {
    liveErrorText.textContent = `${t('liveErrorPrefix')}${detail ?? ''}`;
    liveErrorBanner.hidden = false;
  } else {
    liveErrorBanner.hidden = true;
  }
}

function handleLiveSweep(data: TouchstoneData): void {
  const isFirst = !files.some((f) => f.name === LIVE_NAME);
  applyData(LIVE_NAME, data, serialize(data), isFirst);
}

function handleLiveLog(direction: 'tx' | 'rx', text: string): void {
  const line = `${direction === 'tx' ? '>' : '<'} ${text.replace(/\n/g, '\\n')}`;
  const lines = `${liveLogEl.textContent ?? ''}\n${line}`.split('\n').filter(Boolean);
  liveLogEl.textContent = lines.slice(-200).join('\n');
  liveLogEl.scrollTop = liveLogEl.scrollHeight;
}

const liveController = new LiveController({
  onStatus: handleLiveStatus,
  onSweep: handleLiveSweep,
  onLog: handleLiveLog,
});

if (!isWebSerialSupported()) {
  liveConnectBtn.disabled = true;
  liveConnectBtn.title = t('liveUnsupported');
}

liveConnectBtn.addEventListener('click', () => {
  liveController.connect(Number(liveBaudSelect.value)).catch((err) => {
    if (err instanceof DOMException && err.name === 'NotFoundError') return; // user cancelled the picker
    console.error('vnaviewer: NanoVNA connect failed', err);
  });
});

liveDisconnectBtn.addEventListener('click', () => {
  liveController.disconnect();
});

liveSweepToggleBtn.addEventListener('click', () => {
  if (liveSweeping) {
    stopLiveSweep();
    return;
  }
  const start = parseFloat(liveStartInput.value) * 1e6;
  const stop = parseFloat(liveStopInput.value) * 1e6;
  const points = Math.round(parseFloat(livePointsInput.value));
  if (!Number.isFinite(start) || !Number.isFinite(stop) || stop <= start || !Number.isFinite(points) || points < 11) return;
  liveSweeping = true;
  liveSweepToggleBtn.textContent = t('liveStopSweep');
  liveController.startSweeping(start, stop, points);
});

liveLogToggleBtn.addEventListener('click', () => {
  liveLogEl.hidden = !liveLogEl.hidden;
});

const CAL_STEPS: Array<{ step: CalStep; instructionKey: string; skippable?: boolean }> = [
  { step: 'open', instructionKey: 'calStepOpen' },
  { step: 'short', instructionKey: 'calStepShort' },
  { step: 'load', instructionKey: 'calStepLoad' },
  { step: 'isoln', instructionKey: 'calStepIsoln', skippable: true },
  { step: 'thru', instructionKey: 'calStepThru', skippable: true },
];
let calStepIndex = 0;

function renderCalWizard(): void {
  const current = CAL_STEPS[calStepIndex];
  calWizardStepLabelEl.textContent = `${calStepIndex + 1}/${CAL_STEPS.length}`;
  calWizardInstructionsEl.textContent = t(current.instructionKey);
  calWizardSkipBtn.hidden = !current.skippable;
  calWizardStepsEl.innerHTML = '';
  CAL_STEPS.forEach((s, i) => {
    const li = document.createElement('li');
    li.textContent = s.step.toUpperCase();
    li.className = i < calStepIndex ? 'done' : i === calStepIndex ? 'active' : '';
    calWizardStepsEl.appendChild(li);
  });
}

async function advanceCalStep(skip: boolean): Promise<void> {
  const current = CAL_STEPS[calStepIndex];
  calWizardCaptureBtn.disabled = true;
  calWizardSkipBtn.disabled = true;
  try {
    if (!skip) await liveController.runCalStep(current.step);
    calStepIndex++;
    if (calStepIndex >= CAL_STEPS.length) {
      await liveController.runCalStep('done');
      await liveController.saveCal(0);
      calWizardEl.hidden = true;
    } else {
      renderCalWizard();
    }
  } catch (err) {
    console.error('vnaviewer: calibration step failed', err);
  } finally {
    calWizardCaptureBtn.disabled = false;
    calWizardSkipBtn.disabled = false;
  }
}

liveErrorDismissBtn.addEventListener('click', () => {
  liveErrorBanner.hidden = true;
});

liveCalOpenBtn.addEventListener('click', () => {
  calStepIndex = 0;
  calWizardEl.hidden = false;
  renderCalWizard();
});

calWizardCaptureBtn.addEventListener('click', () => advanceCalStep(false));
calWizardSkipBtn.addEventListener('click', () => advanceCalStep(true));
calWizardCancelBtn.addEventListener('click', () => {
  calWizardEl.hidden = true;
});

applyI18n();
restoreFromStorage();
