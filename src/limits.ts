import type { DataPoint, Complex } from './parser';

export interface LimitLine {
  kind: 'upper' | 'lower';
  value: number;
}

export interface LimitResult {
  pass: boolean;
  failures: number;
}

export function evaluateLimits(
  points: DataPoint[],
  param: number,
  valueFn: (c: Complex) => number,
  limits: LimitLine[],
): LimitResult {
  let failures = 0;
  for (const p of points) {
    const v = valueFn(p.params[param]);
    for (const limit of limits) {
      if (limit.kind === 'upper' && v > limit.value) failures++;
      else if (limit.kind === 'lower' && v < limit.value) failures++;
    }
  }
  return { pass: failures === 0, failures };
}
