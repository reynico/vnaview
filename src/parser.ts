export interface Complex {
  re: number;
  im: number;
}

export interface DataPoint {
  freq: number;
  params: Complex[];
}

export interface TouchstoneData {
  ports: 1 | 2;
  points: DataPoint[];
  impedance: number;
}

type Format = 'RI' | 'MA' | 'DB';

const FREQ_MULTIPLIERS: Record<string, number> = {
  HZ: 1, KHZ: 1e3, MHZ: 1e6, GHZ: 1e9,
};

function toComplex(fmt: Format, a: number, b: number): Complex {
  if (fmt === 'MA') {
    const r = (b * Math.PI) / 180;
    return { re: a * Math.cos(r), im: a * Math.sin(r) };
  }
  if (fmt === 'DB') {
    const mag = 10 ** (a / 20);
    const r = (b * Math.PI) / 180;
    return { re: mag * Math.cos(r), im: mag * Math.sin(r) };
  }
  return { re: a, im: b };
}

export function parse(content: string, filename: string): TouchstoneData {
  const ports: 1 | 2 = /\.s2p$/i.test(filename) ? 2 : 1;
  let freqMul = 1;
  let fmt: Format = 'RI';
  let impedance = 50;
  const points: DataPoint[] = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!')) continue;

    if (line.startsWith('#')) {
      const parts = line.slice(1).trim().toUpperCase().split(/\s+/);
      freqMul = FREQ_MULTIPLIERS[parts[0]] ?? 1;
      fmt = (parts[2] as Format) ?? 'RI';
      impedance = parseFloat(parts[4]) || 50;
      continue;
    }

    const nums = line.split(/\s+/).map(Number);
    if (nums.length < 3 || nums.some(Number.isNaN)) continue;

    const freq = nums[0] * freqMul;
    const paramCount = ports === 1 ? 1 : 4;
    const params: Complex[] = [];

    for (let i = 0; i < paramCount; i++) {
      params.push(toComplex(fmt, nums[1 + i * 2], nums[2 + i * 2]));
    }

    points.push({ freq, params });
  }

  return { ports, points, impedance };
}

export function mag(c: Complex): number {
  return Math.sqrt(c.re ** 2 + c.im ** 2);
}

export function toDB(c: Complex): number {
  const m = mag(c);
  return m > 0 ? 20 * Math.log10(m) : -Infinity;
}

export function toPhase(c: Complex): number {
  return Math.atan2(c.im, c.re) * (180 / Math.PI);
}

export function toVSWR(c: Complex): number {
  const m = mag(c);
  return m < 1 ? (1 + m) / (1 - m) : Infinity;
}
