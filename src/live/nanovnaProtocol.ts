import type { Complex, TouchstoneData } from '../parser';

export type Exec = (cmd: string, timeoutMs?: number) => Promise<string>;

export interface SweepPoint {
  freq: number;
  s11: Complex;
  s21: Complex;
}

export async function getVersion(exec: Exec): Promise<string> {
  return exec('version');
}

// `scan {startHz} {stopHz} {points} {mask}` on the edy555-lineage shell
// (original/H/H4). mask bit0=freq, bit1=S11, bit2=S21 - 7 asks for all
// three, one line per point: "<freqHz> <s11.re> <s11.im> <s21.re> <s21.im>".
// Unverified against real hardware (see live-log panel in the UI to check
// this against what your firmware actually sends back).
const SCAN_MASK = 7;

export async function sweep(exec: Exec, startHz: number, stopHz: number, points: number): Promise<SweepPoint[]> {
  const raw = await exec(`scan ${Math.round(startHz)} ${Math.round(stopHz)} ${points} ${SCAN_MASK}`, 15000);
  const result: SweepPoint[] = [];
  for (const line of raw.split('\n')) {
    const nums = line.trim().split(/\s+/).map(Number);
    if (nums.length < 5 || nums.some(Number.isNaN)) continue;
    const [freq, s11re, s11im, s21re, s21im] = nums;
    result.push({ freq, s11: { re: s11re, im: s11im }, s21: { re: s21re, im: s21im } });
  }
  return result;
}

export type CalStep = 'open' | 'short' | 'load' | 'thru' | 'isoln' | 'done';

export async function calStep(exec: Exec, step: CalStep): Promise<void> {
  await exec(`cal ${step}`);
}

export async function calSave(exec: Exec, slot: number): Promise<void> {
  await exec(`cal save ${slot}`);
}

export async function calReset(exec: Exec): Promise<void> {
  await exec('cal reset');
}

// Single-receiver hardware only ever measures S11/S21, never a real
// S22/S12 - `full: false` keeps the rest of the app from treating this as a
// complete 2-port dataset. See paramIndices() in parser.ts.
export function toTouchstoneData(points: SweepPoint[], impedance = 50): TouchstoneData {
  return {
    ports: 2,
    full: false,
    impedance,
    points: points.map((p) => ({ freq: p.freq, params: [p.s11, p.s21] })),
  };
}
