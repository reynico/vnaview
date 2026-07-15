import type { TouchstoneData } from '../parser';
import { SerialConnection, requestNanoVNA, getKnownPorts, isWebSerialSupported, type LogListener } from './serialTransport';
import { getVersion, sweep, toTouchstoneData, calStep, calSave, calReset, type CalStep } from './nanovnaProtocol';

export type LiveStatus = 'disconnected' | 'connecting' | 'connected' | 'sweeping' | 'error';

export interface LiveCallbacks {
  onStatus: (status: LiveStatus, detail?: string) => void;
  onSweep: (data: TouchstoneData) => void;
  onLog?: LogListener;
}

export class LiveController {
  private conn: SerialConnection | null = null;
  private running = false;
  private version: string | null = null;

  constructor(private cbs: LiveCallbacks) {}

  get connected(): boolean {
    return this.conn !== null;
  }

  private async attach(port: SerialPort, baudRate: number): Promise<void> {
    this.cbs.onStatus('connecting');
    const conn = await SerialConnection.open(port, baudRate, this.cbs.onLog ?? null);
    this.version = await getVersion((cmd, t) => conn.exec(cmd, t));
    this.conn = conn;
    this.cbs.onStatus('connected', this.version);
  }

  async connect(baudRate: number): Promise<void> {
    if (!isWebSerialSupported()) throw new Error('Web Serial not supported in this browser');
    const port = await requestNanoVNA();
    await this.attach(port, baudRate);
  }

  /** Reattaches to a previously-granted port without a new picker prompt. */
  async reconnectSilently(baudRate: number): Promise<boolean> {
    const ports = await getKnownPorts();
    if (ports.length === 0) return false;
    await this.attach(ports[0], baudRate);
    return true;
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.version = null;
    const conn = this.conn;
    this.conn = null;
    await conn?.close();
    this.cbs.onStatus('disconnected');
  }

  startSweeping(startHz: number, stopHz: number, points: number): void {
    if (!this.conn || this.running) return;
    this.running = true;
    void this.sweepLoop(startHz, stopHz, points);
  }

  stopSweeping(): void {
    if (!this.running) return;
    this.running = false;
    // The sweep loop's own 'connected' transition is guarded on `running`
    // still being true (so a stop mid-tick doesn't flash back to
    // "connected" before immediately re-showing "sweeping" on the next
    // tick) - which means stopping is the only thing that will ever move
    // the status off 'sweeping' once the in-flight tick finishes. Send it
    // here instead of waiting on that tick to notice.
    if (this.conn) this.cbs.onStatus('connected', this.version ?? undefined);
  }

  // Real hardware paces itself (a sweep takes real serial-transfer time), but
  // nothing stops a very fast response - a small/point-count sweep, or a
  // future firmware - from completing quicker than the browser can paint a
  // Plotly re-render. Without a floor here that starves the main thread of
  // any chance to handle input, since each tick queues another render before
  // the previous one's had a chance to reach the screen.
  private static readonly MIN_SWEEP_INTERVAL_MS = 100;

  private async sweepLoop(startHz: number, stopHz: number, points: number): Promise<void> {
    while (this.running && this.conn) {
      const conn = this.conn;
      const tickStart = Date.now();
      this.cbs.onStatus('sweeping');
      try {
        const raw = await sweep((cmd, t) => conn.exec(cmd, t), startHz, stopHz, points);
        if (raw.length === 0) throw new Error('sweep returned no points');
        this.cbs.onSweep(toTouchstoneData(raw));
        if (this.running) this.cbs.onStatus('connected', this.version ?? undefined);
      } catch (err) {
        // A failed sweep doesn't tear down the connection: the port/prompt
        // sync is still fine, and closing it here would force the user to
        // re-pick the device (and lose the log) just to retry or inspect
        // what went wrong.
        console.error('vnaviewer: NanoVNA sweep failed', err);
        this.running = false;
        this.cbs.onStatus('error', err instanceof Error ? err.message : String(err));
        break;
      }
      const elapsed = Date.now() - tickStart;
      if (elapsed < LiveController.MIN_SWEEP_INTERVAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, LiveController.MIN_SWEEP_INTERVAL_MS - elapsed));
      }
    }
  }

  async runCalStep(step: CalStep): Promise<void> {
    if (!this.conn) throw new Error('not connected');
    await calStep((cmd, t) => this.conn!.exec(cmd, t), step);
  }

  async saveCal(slot: number): Promise<void> {
    if (!this.conn) throw new Error('not connected');
    await calSave((cmd, t) => this.conn!.exec(cmd, t), slot);
  }

  async resetCal(): Promise<void> {
    if (!this.conn) throw new Error('not connected');
    await calReset((cmd, t) => this.conn!.exec(cmd, t));
  }
}
