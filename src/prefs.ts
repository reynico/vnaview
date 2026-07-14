export type Lang = 'en' | 'es';
export type Theme = 'dark' | 'light';

const LANG_KEY = 'vnaviewer:lang';
const THEME_KEY = 'vnaviewer:theme';

const STRINGS: Record<Lang, Record<string, string>> = {
  en: {
    compare: 'Compare',
    exportCsv: 'Export CSV',
    clearAllFiles: 'Clear all',
    dropLine1: 'Drop a .s1p or .s2p file',
    dropLine2: 'or click to browse',
    autoscale: 'Autoscale',
    freqStart: 'START',
    freqStop: 'STOP',
    freqCenter: 'CENTER',
    freqSpan: 'SPAN',
    railSearch: 'Search',
    markerToPeak: 'Marker→Peak',
    markerToMin: 'Marker→Min',
    peakSearchLeft: 'Peak Search ←',
    peakSearchRight: 'Peak Search →',
    bwSearch: 'BW Search',
    threshold: 'Threshold',
    railMarkers: 'Markers',
    deltaRef: 'Δ Ref',
    newAtCenter: 'New at Center',
    clearActive: 'Clear Active',
    clearAllMarkers: 'Clear All',
    markerTableFreq: 'Freq',
    markerTableValue: 'Value',
    phase: 'Phase',
    magnitude: 'Magnitude',
    frequency: 'Frequency',
    bwNotAvailable: 'BW: N/A (peak too close to data edge)',
    langToggleLabel: 'Language',
    themeToggleLabel: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    groupDelay: 'Group Delay',
    polar: 'Polar',
    railLimits: 'Limits',
    limitUpper: 'Upper Limit',
    limitLower: 'Lower Limit',
    limitEnable: 'Enable',
    limitPass: 'PASS',
    limitFail: 'FAIL',
    railMemory: 'Memory',
    memorySave: 'Save Memory',
    memoryShow: 'Show Memory',
    memoryClear: 'Clear Memory',
    traceToggleHint: 'Click to toggle trace on/off',
    traceColorHint: 'Choose trace color',
    traceWidthHint: 'Line width',
    renameHint: 'Double-click to rename',
  },
  es: {
    compare: 'Comparar',
    exportCsv: 'Exportar CSV',
    clearAllFiles: 'Borrar todo',
    dropLine1: 'Suelta un archivo .s1p o .s2p',
    dropLine2: 'o haz clic para explorar',
    autoscale: 'Autoescala',
    freqStart: 'INICIO',
    freqStop: 'FIN',
    freqCenter: 'CENTRO',
    freqSpan: 'SPAN',
    railSearch: 'Buscar',
    markerToPeak: 'Marcador→Pico',
    markerToMin: 'Marcador→Mín',
    peakSearchLeft: 'Buscar Pico ←',
    peakSearchRight: 'Buscar Pico →',
    bwSearch: 'Buscar BW',
    threshold: 'Umbral',
    railMarkers: 'Marcadores',
    deltaRef: 'Δ Ref',
    newAtCenter: 'Nuevo en Centro',
    clearActive: 'Borrar Activo',
    clearAllMarkers: 'Borrar Todo',
    markerTableFreq: 'Frec',
    markerTableValue: 'Valor',
    phase: 'Fase',
    magnitude: 'Magnitud',
    frequency: 'Frecuencia',
    bwNotAvailable: 'BW: N/D (el pico está demasiado cerca del borde de los datos)',
    langToggleLabel: 'Idioma',
    themeToggleLabel: 'Tema',
    themeDark: 'Oscuro',
    themeLight: 'Claro',
    groupDelay: 'Retardo de Grupo',
    polar: 'Polar',
    railLimits: 'Límites',
    limitUpper: 'Límite Superior',
    limitLower: 'Límite Inferior',
    limitEnable: 'Activar',
    limitPass: 'OK',
    limitFail: 'FALLO',
    railMemory: 'Memoria',
    memorySave: 'Guardar Memoria',
    memoryShow: 'Mostrar Memoria',
    memoryClear: 'Borrar Memoria',
    traceToggleHint: 'Clic para activar/desactivar la traza',
    traceColorHint: 'Elegir color de la traza',
    traceWidthHint: 'Ancho de línea',
    renameHint: 'Doble clic para renombrar',
  },
};

export function getLang(): Lang {
  const stored = localStorage.getItem(LANG_KEY);
  if (stored === 'en' || stored === 'es') return stored;
  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

export function setLang(lang: Lang): void {
  localStorage.setItem(LANG_KEY, lang);
  document.documentElement.lang = lang;
}

export function t(key: string): string {
  const lang = getLang();
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}

export function getTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.dataset.theme = theme;
}
