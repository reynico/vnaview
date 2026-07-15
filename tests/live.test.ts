import { describe, it, expect } from 'vitest';
import { getVersion, sweep, calStep, calSave, calReset, toTouchstoneData, type Exec } from '../src/live/nanovnaProtocol';

function makeExec(responseFor: (cmd: string) => string): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (cmd: string) => {
    calls.push(cmd);
    return responseFor(cmd);
  };
  return { exec, calls };
}

describe('getVersion', () => {
  it('sends "version" and returns the raw banner', async () => {
    const { exec, calls } = makeExec((cmd) => (cmd === 'version' ? 'NanoVNA-H4 1.0.0' : ''));
    expect(await getVersion(exec)).toBe('NanoVNA-H4 1.0.0');
    expect(calls).toEqual(['version']);
  });
});

describe('sweep', () => {
  it('sends a scan command with mask 7 and parses freq/S11/S21 lines', async () => {
    const raw = ['1000000 0.1 0.2 0.01 0.02', '2000000 -0.1 0.05 0.02 -0.01'].join('\n');
    const { exec, calls } = makeExec((cmd) => (cmd.startsWith('scan') ? raw : ''));

    const points = await sweep(exec, 1e6, 2e6, 2);

    expect(calls).toEqual(['scan 1000000 2000000 2 7']);
    expect(points).toEqual([
      { freq: 1000000, s11: { re: 0.1, im: 0.2 }, s21: { re: 0.01, im: 0.02 } },
      { freq: 2000000, s11: { re: -0.1, im: 0.05 }, s21: { re: 0.02, im: -0.01 } },
    ]);
  });

  it('skips blank/malformed lines instead of throwing', async () => {
    const raw = '\ngarbage line\n1000000 0.1 0.2 0.01 0.02\n';
    const { exec } = makeExec(() => raw);
    const points = await sweep(exec, 1e6, 1e6, 1);
    expect(points).toHaveLength(1);
    expect(points[0].freq).toBe(1000000);
  });
});

describe('calibration commands', () => {
  it('sends the SOL(T) wizard sequence as cal subcommands', async () => {
    const { exec, calls } = makeExec(() => '');
    await calStep(exec, 'open');
    await calStep(exec, 'short');
    await calStep(exec, 'load');
    await calStep(exec, 'thru');
    await calStep(exec, 'done');
    await calSave(exec, 0);
    await calReset(exec);

    expect(calls).toEqual(['cal open', 'cal short', 'cal load', 'cal thru', 'cal done', 'cal save 0', 'cal reset']);
  });
});

describe('toTouchstoneData', () => {
  it('produces a partial 2-port dataset (full:false) with only S11/S21', () => {
    const data = toTouchstoneData([
      { freq: 1e6, s11: { re: 1, im: 0 }, s21: { re: 0, im: 0 } },
      { freq: 2e6, s11: { re: 0.5, im: 0.5 }, s21: { re: 0.1, im: -0.1 } },
    ]);
    expect(data.ports).toBe(2);
    expect(data.full).toBe(false);
    expect(data.impedance).toBe(50);
    expect(data.points).toHaveLength(2);
    expect(data.points[1].params).toEqual([
      { re: 0.5, im: 0.5 },
      { re: 0.1, im: -0.1 },
    ]);
  });
});
