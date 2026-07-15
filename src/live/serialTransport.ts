// Thin transport over the NanoVNA's USB-CDC shell: it echoes whatever you
// send, runs it, and prints a fresh "ch> " prompt with no trailing newline
// when it's ready for the next command. Framing a response is just "read
// until the tail of the buffer is the prompt".
const PROMPT = 'ch> ';

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
  onLog: LogListener | null = null;

  private constructor(
    port: SerialPort,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    this.port = port;
    this.writer = writer;
    this.reader = reader;
  }

  static async open(port: SerialPort, baudRate: number, onLog: LogListener | null = null): Promise<SerialConnection> {
    await port.open({ baudRate });
    if (!port.writable || !port.readable) throw new Error('serial port has no readable/writable stream');
    const writer = port.writable.getWriter();
    const reader = port.readable.getReader();
    const conn = new SerialConnection(port, writer, reader);
    conn.onLog = onLog;
    // Clears out any partial line/prompt left over from a previous session
    // (e.g. the on-device menu) before the first real command is sent.
    await conn.exec('', 1500).catch(() => {});
    return conn;
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

  private async readUntilPrompt(): Promise<void> {
    while (!this.buffer.includes(PROMPT)) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('serial port closed while waiting for response');
      if (value) this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  private async execNow(cmd: string, timeoutMs: number): Promise<string> {
    if (this.closed) throw new Error('serial connection closed');
    this.onLog?.('tx', cmd);
    await this.writer.write(new TextEncoder().encode(`${cmd}\r`));

    // readUntilPrompt keeps running even if it loses the race below (its
    // pending reader.read() can't be cancelled without tearing down the
    // whole stream) - the .catch keeps that eventual settlement from
    // surfacing as an unhandled rejection. Any bytes it still appends to
    // `buffer` after a timeout are harmless: they just get picked up as
    // leading context by whichever exec() call reads next.
    const readPromise = this.readUntilPrompt();
    readPromise.catch(() => {});
    await Promise.race([
      readPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for response to "${cmd}"`)), timeoutMs),
      ),
    ]);

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
