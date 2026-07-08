import { describe, it, expect } from 'vitest';
import { findPeak, findMin, findNextPeak, findBandwidth } from '../src/markers';
import type { DataPoint, Complex } from '../src/parser';

function pointsFromValues(values: number[]): DataPoint[] {
  return values.map((v, i) => ({
    freq: i * 1e6,
    params: [{ re: v, im: 0 }] as Complex[],
  }));
}

const valueFn = (c: Complex) => c.re;

describe('findPeak', () => {
  it('returns the point with the maximum value', () => {
    const points = pointsFromValues([1, 5, 3, 9, 2, 4]);
    expect(findPeak(points, 0, valueFn).freq).toBe(3 * 1e6);
  });
});

describe('findMin', () => {
  it('returns the point with the minimum value', () => {
    const points = pointsFromValues([5, 1, 3, -9, 2, 4]);
    expect(findMin(points, 0, valueFn).freq).toBe(3 * 1e6);
  });
});

describe('findNextPeak', () => {
  // Two clean local maxima at index 4 and 14, well clear of the window on both sides.
  const twoBumps = pointsFromValues([1, 2, 3, 4, 5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0]);

  it('finds the first peak to the right of the starting frequency', () => {
    const result = findNextPeak(twoBumps, 0, valueFn, twoBumps[0].freq, 'right');
    expect(result?.freq).toBe(4 * 1e6);
  });

  it('skips the current peak and finds the next one further right', () => {
    const result = findNextPeak(twoBumps, 0, valueFn, twoBumps[4].freq, 'right');
    expect(result?.freq).toBe(14 * 1e6);
  });

  it('finds a peak to the left of the starting frequency', () => {
    const result = findNextPeak(twoBumps, 0, valueFn, twoBumps[14].freq, 'left');
    expect(result?.freq).toBe(4 * 1e6);
  });

  it('returns null when no peak exists before the data boundary', () => {
    const result = findNextPeak(twoBumps, 0, valueFn, twoBumps[4].freq, 'left');
    expect(result).toBeNull();
  });

  it('ignores a small wiggle that is not a peak within the window', () => {
    // Overall descending slope with a tiny local wiggle at index 6 (6.05 > neighbors
    // at index 5 and 7, but index 3 three steps away is still higher).
    const wiggle = pointsFromValues([10, 9, 8, 7, 6, 5.9, 6.05, 5.8, 5, 4, 3, 2, 1, 0]);
    const result = findNextPeak(wiggle, 0, valueFn, wiggle[0].freq, 'right', 3);
    expect(result).toBeNull();
  });

  it('flags the same wiggle as a peak with a narrower window', () => {
    const wiggle = pointsFromValues([10, 9, 8, 7, 6, 5.9, 6.05, 5.8, 5, 4, 3, 2, 1, 0]);
    const result = findNextPeak(wiggle, 0, valueFn, wiggle[0].freq, 'right', 1);
    expect(result?.freq).toBe(6 * 1e6);
  });
});

describe('findBandwidth', () => {
  // Symmetric peak (value 10 at index 5) crossing -3dB (target 7) between
  // indices 3-4 on the left and 6-7 on the right — hand-computed crossings
  // below to check the linear interpolation.
  const peak = pointsFromValues([0, 0, 0, 4, 8, 10, 8, 4, 0, 0, 0]);

  it('interpolates the -3dB band edges around a peak', () => {
    const result = findBandwidth(peak, 0, valueFn, peak[5].freq, 3);
    expect(result).not.toBeNull();
    expect(result!.lowFreq).toBeCloseTo(3.75e6);
    expect(result!.highFreq).toBeCloseTo(6.25e6);
    expect(result!.centerFreq).toBeCloseTo(5e6);
    expect(result!.bandwidth).toBeCloseTo(2.5e6);
    expect(result!.q).toBeCloseTo(2);
  });

  it('widens the reported bandwidth for a larger threshold', () => {
    const narrow = findBandwidth(peak, 0, valueFn, peak[5].freq, 3)!;
    const wide = findBandwidth(peak, 0, valueFn, peak[5].freq, 6)!;
    expect(wide.bandwidth).toBeGreaterThan(narrow.bandwidth);
  });

  it('returns null when the peak is too close to a data boundary to bracket one side', () => {
    const edgePeak = pointsFromValues([10, 8, 6, 4, 2, 0]);
    const result = findBandwidth(edgePeak, 0, valueFn, edgePeak[0].freq, 3);
    expect(result).toBeNull();
  });
});
