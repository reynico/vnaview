import { toDB, toPhase, paramIndices } from './parser';
import { PARAM_NAMES, type ChartEntry } from './chart';

export function buildCSV(entries: ChartEntry[]): string {
  const rows: string[] = ['File,Param,Freq_Hz,Mag_dB,Phase_deg'];

  for (const { label, data } of entries) {
    for (const point of data.points) {
      for (const i of paramIndices(data, false)) {
        const c = point.params[i];
        const db = toDB(c);
        const magDb = Number.isFinite(db) ? db.toFixed(4) : '';
        rows.push(`${label},${PARAM_NAMES[i]},${point.freq},${magDb},${toPhase(c).toFixed(4)}`);
      }
    }
  }

  return rows.join('\n');
}

export function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
