// Thin transport over the NanoVNA's USB-CDC shell: it echoes whatever you
// send, runs it, and prints a fresh "ch> " prompt with no trailing newline
// when it's ready for the next command. Framing a response is just "read
// until the tail of the buffer is the prompt".
const PROMPT = 'ch> ';
const POLL_MS = 15;

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && navigator.serial !== undefined;
}

export type LogDirection = 'tx' | 'rx';
export type LogListener = (direction: LogDirection, text: string) => void;

export class SerialConnection {
  private port: SerialPort;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  // TextDecoderStream's typings don't line up with SerialPort.readable's
  // Uint8Array across TS DOM lib versions, so bytes are decoded by hand with
  // a persistent streaming decoder instead of piping through it.
  private decoder = new TextDecoder();
  private buffer = '';
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private pumpError: Error | null = null;
  onLog: LogListener | null = null;

  private constructor(
    port: SerialPort,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    this.port = port;
    this.writer = writer;
    this.reader = reader;
    void this.pump();
  }

  static async open(port: SerialPort, baudRate: number, onLog: LogListener | null = null): Promise<SerialConnection> {
    await port.open({ baudRate });
    if (!port.writable || !port.readable) throw new Error('serial port has no readable/writable stream');
    const writer = port.writable.getWriter();
    const reader = port.readable.getReader();
    const conn = new SerialConnection(port, writer, reader);
    conn.onLog = onLog;
    await conn.drain();
    return conn;
  }

  // The only place that ever calls reader.read(). A read() that's still
  // pending when a caller gives up waiting can't be cancelled short of
  // tearing down the whole stream - and since reads are FIFO-queued, an
  // abandoned one would silently steal the bytes meant for whoever reads
  // next. Routing every read through one perpetual pump into `buffer`, with
  // drain()/readUntilPrompt() just polling that buffer, sidesteps the
  // problem entirely: there's only ever one outstanding read() call.
  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) return;
        if (value) this.buffer += this.decoder.decode(value, { stream: true });
      }
    } catch (err) {
      this.pumpError = err instanceof Error ? err : new Error(String(err));
    }
  }

  // Connecting can leave more than one prompt-terminated chunk already
  // queued (e.g. a boot banner immediately followed by a second spontaneous
  // prompt) - exec()'s framing assumes the buffer is empty before it writes
  // a command, so stopping at the *first* found prompt here would leave a
  // leftover prompt for the next real command to wrongly claim as its own
  // answer, shifting every response one slot late from then on. Waiting
  // until the port goes quiet (no bytes for `quietMs`) instead of until the
  // first prompt is the only way to know the buffer is actually clean.
  private async drain(maxTotalMs = 2000, quietMs = 250): Promise<void> {
    const deadline = Date.now() + maxTotalMs;
    let lastLength = -1;
    while (Date.now() < deadline) {
      if (this.buffer.length === lastLength) break; // no growth since last check -> quiet
      lastLength = this.buffer.length;
      await new Promise((resolve) => setTimeout(resolve, quietMs));
    }
    if (this.buffer) this.onLog?.('rx', `[boot noise] ${this.buffer}`);
    this.buffer = '';
  }

  /** Sends a command, resolves with everything printed before the next prompt. */
  exec(cmd: string, timeoutMs = 5000): Promise<string> {
    const run = () => this.execNow(cmd, timeoutMs);
    const result = this.queue.then(run, run);
    // Swallow rejections in the chain itself so one failed command doesn't
    // permanently wedge the queue for subsequent callers.
    this.queue = result.catch(() => {});
    return result;
  }

  private async readUntilPrompt(cmd: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.buffer.includes(PROMPT)) {
      if (this.pumpError) throw this.pumpError;
      if (Date.now() >= deadline) throw new Error(`timed out waiting for response to "${cmd}"`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async execNow(cmd: string, timeoutMs: number): Promise<string> {
    if (this.closed) throw new Error('serial connection closed');
    this.onLog?.('tx', cmd);
    await this.writer.write(new TextEncoder().encode(`${cmd}\r`));
    await this.readUntilPrompt(cmd, timeoutMs);

    const promptIdx = this.buffer.indexOf(PROMPT);
    let text = this.buffer.slice(0, promptIdx);
    this.buffer = this.buffer.slice(promptIdx + PROMPT.length);

    // First line is the echoed command; drop it (empty sync commands have
    // nothing to echo past the prompt itself, so guard for that).
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
    text = text.trim();
    this.onLog?.('rx', text);
    return text;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {
      /* already closed */
    }
    this.reader.releaseLock();
    try {
      this.writer.releaseLock();
    } catch {
      /* already released */
    }
    await this.port.close().catch(() => {});
  }
}

export async function requestNanoVNA(): Promise<SerialPort> {
  if (!navigator.serial) throw new Error('Web Serial API not available in this browser');
  // No VID/PID filter: NanoVNA forks/clones ship a handful of different USB
  // CDC chips, and an unmatched filter makes Chrome's picker show nothing
  // (worse UX than just listing every serial port).
  return navigator.serial.requestPort();
}

export async function getKnownPorts(): Promise<SerialPort[]> {
  if (!navigator.serial) return [];
  return navigator.serial.getPorts();
}
