import { toImpedance, type DataPoint, type Complex } from './parser';

export function findPeak(
  points: DataPoint[],
  param: number,
  valueFn: (c: Complex) => number,
): DataPoint {
  return points.reduce((a, b) => (valueFn(b.params[param]) > valueFn(a.params[param]) ? b : a));
}

export function findMin(
  points: DataPoint[],
  param: number,
  valueFn: (c: Complex) => number,
): DataPoint {
  return points.reduce((a, b) => (valueFn(b.params[param]) < valueFn(a.params[param]) ? b : a));
}

/**
 * Walks from the point nearest `fromFreq` in `direction`, looking for a local
 * maximum: a point whose value exceeds all neighbors within `window` points on
 * each side. The window guards against flagging single-sample measurement noise
 * as a peak; tune it against real sweep data if it proves too strict/loose.
 */
export function findNextPeak(
  points: DataPoint[],
  param: number,
  valueFn: (c: Complex) => number,
  fromFreq: number,
  direction: 'left' | 'right',
  window = 3,
): DataPoint | null {
  if (points.length < 2 * window + 1) return null;
  const values = points.map((p) => valueFn(p.params[param]));

  let startIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].freq - fromFreq);
    if (d < minDist) {
      minDist = d;
      startIdx = i;
    }
  }

  const step = direction === 'right' ? 1 : -1;
  const lo = window;
  const hi = points.length - 1 - window;
  // Clamp into the window-safe zone first — a starting index near either edge
  // must jump to the nearest searchable point rather than falling outside the
  // [lo, hi] bounds and terminating before the search has moved at all.
  let i = startIdx + step;
  if (direction === 'right' && i < lo) i = lo;
  if (direction === 'left' && i > hi) i = hi;

  while (i >= lo && i <= hi) {
    const v = values[i];
    let isPeak = true;
    for (let w = 1; w <= window && isPeak; w++) {
      if (values[i - w] > v || values[i + w] > v) isPeak = false;
    }
    if (isPeak) return points[i];
    i += step;
  }
  return null;
}

export interface BandwidthResult {
  centerFreq: number;
  bandwidth: number;
  lowFreq: number;
  highFreq: number;
  q: number;
}

/**
 * -N dB (default 3 dB) bandwidth around a peak: scans outward from the point
 * nearest `peakFreq` until the value drops below `peakValue - thresholdDb` on
 * each side, linearly interpolating between the bracketing samples for
 * sub-sample-step accuracy. Returns null if either side never crosses the
 * threshold within the data (peak too close to a data boundary) rather than
 * fabricating an edge value.
 */
export function findBandwidth(
  points: DataPoint[],
  param: number,
  valueFn: (c: Complex) => number,
  peakFreq: number,
  thresholdDb = 3,
): BandwidthResult | null {
  if (points.length < 2) return null;
  const values = points.map((p) => valueFn(p.params[param]));

  let peakIdx = 0;
  let minDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(points[i].freq - peakFreq);
    if (d < minDist) {
      minDist = d;
      peakIdx = i;
    }
  }

  const target = values[peakIdx] - thresholdDb;

  let lowFreq: number | null = null;
  for (let i = peakIdx; i > 0; i--) {
    if (values[i - 1] < target && values[i] >= target) {
      const frac = (target - values[i - 1]) / (values[i] - values[i - 1]);
      lowFreq = points[i - 1].freq + frac * (points[i].freq - points[i - 1].freq);
      break;
    }
  }

  let highFreq: number | null = null;
  for (let i = peakIdx; i < points.length - 1; i++) {
    if (values[i + 1] < target && values[i] >= target) {
      const frac = (values[i] - target) / (values[i] - values[i + 1]);
      highFreq = points[i].freq + frac * (points[i + 1].freq - points[i].freq);
      break;
    }
  }

  if (lowFreq === null || highFreq === null) return null;

  const bandwidth = highFreq - lowFreq;
  const centerFreq = (lowFreq + highFreq) / 2;
  return {
    centerFreq,
    bandwidth,
    lowFreq,
    highFreq,
    q: bandwidth > 0 ? centerFreq / bandwidth : Infinity,
  };
}

export interface ResonanceResult {
  freq: number;
  resistance: number;
  /** 'series' is a capacitive-to-inductive (-to-+) crossing, 'parallel' (anti-resonance) the reverse. */
  type: 'series' | 'parallel';
}

/**
 * Zero-crossing of reactance (Im{Z}) nearest `fromFreq`, for a reflection
 * param (S11/S22) only - `param` must index a Gamma, not a transmission
 * coefficient. Linearly interpolates both frequency and resistance between
 * the bracketing samples. Returns null if the data has no sign change.
 */
export function findResonance(
  points: DataPoint[],
  param: number,
  z0: number,
  fromFreq: number,
): ResonanceResult | null {
  if (points.length < 2) return null;
  const z = points.map((p) => toImpedance(p.params[param], z0));

  let best: ResonanceResult | null = null;
  let bestDist = Infinity;
  for (let i = 1; i < points.length; i++) {
    const xa = z[i - 1].im;
    const xb = z[i].im;
    if (!Number.isFinite(xa) || !Number.isFinite(xb) || (xa > 0) === (xb > 0)) continue;
    const frac = xa / (xa - xb);
    const freq = points[i - 1].freq + frac * (points[i].freq - points[i - 1].freq);
    const resistance = z[i - 1].re + frac * (z[i].re - z[i - 1].re);
    const dist = Math.abs(freq - fromFreq);
    if (dist < bestDist) {
      bestDist = dist;
      best = { freq, resistance, type: xa < 0 ? 'series' : 'parallel' };
    }
  }
  return best;
}
