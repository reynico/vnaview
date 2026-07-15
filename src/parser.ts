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
  /**
   * False for a 2-port dataset where only S11/S21 were actually measured
   * (e.g. a single-receiver NanoVNA live capture) - S12/S22 don't exist and
   * must never be plotted/exported. Absent/true means all `ports` params
   * are real, as in a normal Touchstone file.
   */
  full?: boolean;
}

/**
 * Which params[] indices are real data for this dataset, given whether the
 * caller is in compare mode (which already only ever shows S11/S21 for a
 * 2-port file). Centralizes the ports/full branching that used to be
 * duplicated at every call site.
 */
export function paramIndices(data: TouchstoneData, compare: boolean): number[] {
  if (data.ports === 1) return [0];
  if (compare || data.full === false) return [0, 1];
  return [0, 1, 2, 3];
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

// Inverse of parse(): always emits a well-formed 2-port RI file so it round-trips
// through parse() for storage. S12/S22 are written as zero placeholders when
// `full` is false - callers must keep passing the original `full`-flagged
// TouchstoneData through the app rather than relying on the re-parsed copy,
// since parse() itself has no notion of "full".
export function serialize(data: TouchstoneData): string {
  const lines = [`# Hz S RI R ${data.impedance}`];
  for (const p of data.points) {
    const parts = [String(p.freq)];
    const count = data.ports === 1 ? 1 : 4;
    for (let i = 0; i < count; i++) {
      const c = p.params[i] ?? { re: 0, im: 0 };
      parts.push(String(c.re), String(c.im));
    }
    lines.push(parts.join(' '));
  }
  return lines.join('\n');
}

// S11-only Touchstone text, for exporting a partial (full:false) 2-port
// dataset - unlike serialize(), never fabricates S12/S22. A real S2P file
// with zeroed-out params would misrepresent a live capture as a complete
// 2-port measurement to any tool that opens it outside this app.
export function serializeS1P(data: TouchstoneData): string {
  const lines = [`# Hz S RI R ${data.impedance}`];
  for (const p of data.points) {
    const c = p.params[0];
    lines.push(`${p.freq} ${c.re} ${c.im}`);
  }
  return lines.join('\n');
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

// Z = Z0 * (1+Gamma) / (1-Gamma), only meaningful for a reflection
// coefficient (S11/S22), not a transmission parameter.
export function toImpedance(c: Complex, z0: number): Complex {
  const denom = (1 - c.re) ** 2 + c.im ** 2;
  return {
    re: (z0 * (1 - c.re ** 2 - c.im ** 2)) / denom,
    im: (z0 * 2 * c.im) / denom,
  };
}

function unwrapPhase(rad: number[]): number[] {
  const out = [rad[0]];
  for (let i = 1; i < rad.length; i++) {
    let d = rad[i] - rad[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out.push(out[i - 1] + d);
  }
  return out;
}

/**
 * -dPhase/dOmega in seconds, one value per point, via a centered finite
 * difference (forward/backward at the edges). Phase is unwrapped first so
 * the +/-180deg wraparound doesn't show up as a spurious delay spike.
 */
export function groupDelay(points: DataPoint[], param: number): number[] {
  if (points.length < 2) return points.map(() => NaN);
  const unwrapped = unwrapPhase(points.map((p) => Math.atan2(p.params[param].im, p.params[param].re)));
  const gd: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const lo = i === 0 ? 0 : i - 1;
    const hi = i === points.length - 1 ? points.length - 1 : i + 1;
    const dPhase = unwrapped[hi] - unwrapped[lo];
    const dFreq = points[hi].freq - points[lo].freq;
    gd[i] = dFreq !== 0 ? -dPhase / (2 * Math.PI * dFreq) : NaN;
  }
  return gd;
}
