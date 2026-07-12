import { describe, it, expect } from 'vitest';
import { evaluateLimits } from '../src/limits';
import type { DataPoint, Complex } from '../src/parser';

function pointsFromValues(values: number[]): DataPoint[] {
  return values.map((v, i) => ({
    freq: i * 1e6,
    params: [{ re: v, im: 0 }] as Complex[],
  }));
}

const valueFn = (c: Complex) => c.re;

describe('evaluateLimits', () => {
  it('passes when every point stays within the limits', () => {
    const points = pointsFromValues([-5, -8, -12, -9, -6]);
    const result = evaluateLimits(points, 0, valueFn, [
      { kind: 'upper', value: 0 },
      { kind: 'lower', value: -20 },
    ]);
    expect(result.pass).toBe(true);
    expect(result.failures).toBe(0);
  });

  it('fails and counts violations above an upper limit', () => {
    const points = pointsFromValues([-5, 2, -12, 3, -6]);
    const result = evaluateLimits(points, 0, valueFn, [{ kind: 'upper', value: 0 }]);
    expect(result.pass).toBe(false);
    expect(result.failures).toBe(2);
  });

  it('fails and counts violations below a lower limit', () => {
    const points = pointsFromValues([-5, -25, -12, -30, -6]);
    const result = evaluateLimits(points, 0, valueFn, [{ kind: 'lower', value: -20 }]);
    expect(result.pass).toBe(false);
    expect(result.failures).toBe(2);
  });

  it('passes when there are no limits to check', () => {
    const points = pointsFromValues([100, -100]);
    const result = evaluateLimits(points, 0, valueFn, []);
    expect(result.pass).toBe(true);
  });
});
