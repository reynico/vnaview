import type { DataPoint, Complex } from './parser';

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
