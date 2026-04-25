import { describe, it, expect } from 'vitest';
import { parse, toDB, toPhase, toVSWR, mag } from '../src/parser';

const S1P_RI = `
!Test S1P file
# Hz S RI R 50
1000000 -0.5 0.5
2000000  0.0 0.7
3000000  0.3 0.0
`;

const S1P_MA = `
# MHz S MA R 50
7.0 0.707 45.0
14.0 0.5 90.0
`;

const S1P_DB = `
# MHz S DB R 50
7.0 -3.0 45.0
`;

const S2P_RI = `
# Hz S RI R 50
1000000 -0.5 0.1  0.01 0.0  0.0 0.01  -0.4 0.1
`;

describe('parse', () => {
  it('detects 1-port from .s1p extension', () => {
    const d = parse(S1P_RI, 'test.s1p');
    expect(d.ports).toBe(1);
  });

  it('detects 2-port from .s2p extension', () => {
    const d = parse(S2P_RI, 'test.s2p');
    expect(d.ports).toBe(2);
  });

  it('parses RI format correctly', () => {
    const d = parse(S1P_RI, 'test.s1p');
    expect(d.points).toHaveLength(3);
    expect(d.points[0].freq).toBe(1e6);
    expect(d.points[0].params[0].re).toBeCloseTo(-0.5);
    expect(d.points[0].params[0].im).toBeCloseTo(0.5);
  });

  it('parses MA format correctly', () => {
    const d = parse(S1P_MA, 'test.s1p');
    expect(d.points[0].params[0].re).toBeCloseTo(0.707 * Math.cos(Math.PI / 4), 3);
    expect(d.points[0].params[0].im).toBeCloseTo(0.707 * Math.sin(Math.PI / 4), 3);
  });

  it('parses DB format correctly', () => {
    const d = parse(S1P_DB, 'test.s1p');
    const m = mag(d.points[0].params[0]);
    expect(m).toBeCloseTo(10 ** (-3 / 20), 4);
  });

  it('parses MHz frequency unit', () => {
    const d = parse(S1P_MA, 'test.s1p');
    expect(d.points[0].freq).toBe(7e6);
    expect(d.points[1].freq).toBe(14e6);
  });

  it('skips comment and blank lines', () => {
    const d = parse(S1P_RI, 'test.s1p');
    expect(d.points).toHaveLength(3);
  });

  it('reads impedance from option line', () => {
    const d = parse(S1P_RI, 'test.s1p');
    expect(d.impedance).toBe(50);
  });

  it('parses all 4 S-params for 2-port', () => {
    const d = parse(S2P_RI, 'test.s2p');
    expect(d.points[0].params).toHaveLength(4);
    expect(d.points[0].params[0].re).toBeCloseTo(-0.5);
    expect(d.points[0].params[1].re).toBeCloseTo(0.01);
  });
});

describe('toDB', () => {
  it('returns 0 dB for unit magnitude', () => {
    expect(toDB({ re: 1, im: 0 })).toBeCloseTo(0);
  });

  it('returns -6 dB for magnitude 0.5', () => {
    expect(toDB({ re: 0.5, im: 0 })).toBeCloseTo(-6.02, 1);
  });

  it('handles complex values', () => {
    const v = Math.SQRT1_2;
    expect(toDB({ re: v, im: v })).toBeCloseTo(0);
  });
});

describe('toPhase', () => {
  it('returns 0° for positive real', () => {
    expect(toPhase({ re: 1, im: 0 })).toBeCloseTo(0);
  });

  it('returns 90° for positive imaginary', () => {
    expect(toPhase({ re: 0, im: 1 })).toBeCloseTo(90);
  });

  it('returns -90° for negative imaginary', () => {
    expect(toPhase({ re: 0, im: -1 })).toBeCloseTo(-90);
  });

  it('returns 180° for negative real', () => {
    expect(toPhase({ re: -1, im: 0 })).toBeCloseTo(180);
  });
});

describe('toVSWR', () => {
  it('returns 1 for zero reflection', () => {
    expect(toVSWR({ re: 0, im: 0 })).toBeCloseTo(1);
  });

  it('returns Infinity for unit reflection', () => {
    expect(toVSWR({ re: 1, im: 0 })).toBe(Infinity);
  });

  it('returns 3 for |Γ| = 0.5', () => {
    expect(toVSWR({ re: 0.5, im: 0 })).toBeCloseTo(3);
  });

  it('returns Infinity for |Γ| > 1', () => {
    expect(toVSWR({ re: 2, im: 0 })).toBe(Infinity);
  });
});
