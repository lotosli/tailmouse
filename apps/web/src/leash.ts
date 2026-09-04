import {
  Message,
  ProtocolError,
  type Frame,
  type Welcome,
} from './protocol/frame.ts';
import {
  decodeTermReset,
  decodeProcessState,
  decodeOutputDropped,
  encodeProcessControl,
  type ProcessAction,
  type ProcessState,
  type TermReset,
} from './protocol/terminal.ts';

export const TERMINAL_CHUNK_BYTES = 32_766;
export const TERMINAL_INPUT_BYTES = 256 * 1024;

// The volatile terminal renderer is kept outside protocol/session state. A
// resolved write means its raw bytes have been parsed, not merely queued.
export interface TerminalDisplay {
  reset(value: TermReset): void;
  write(data: Uint8Array): Promise<void>;
}

export class TerminalDisplayError extends Error {
  constructor() {
    super('The terminal display failed. Reconnect to try again.');
    this.name = 'TerminalDisplayError';
  }
}

export interface LeashState {
  readonly reset: TermReset | undefined;
  readonly process: ProcessState | undefined;
  readonly endedAt: number | undefined;
  readonly droppedBytes: number;
  readonly queuedBytes: number;
  readonly backpressure: boolean;
  readonly pendingControl: ProcessAction | undefined;
  readonly synchronizing: boolean;
  readonly stopped: boolean;
  readonly error: ProtocolError | undefined;
}

// One connection, one display, no timer or independent transport worker.
export class LeashClient {
  readonly #welcome: Welcome;
  readonly #send: (frame: Frame) => Promise<void>;
  readonly #fail: (error: unknown) => void;
  readonly #displayReady: Promise<TerminalDisplay | undefined>;
  readonly #disposed: Promise<void>;
  #resolveDisplay!: (display: TerminalDisplay | undefined) => void;
  #resolveDisposed!: () => void;
  #displayAttached = false;
  #observer: (() => void) | undefined;
  #reset: TermReset | undefined;
  #process: ProcessState | undefined;
  #endedAt: number | undefined;
  #droppedBytes = 0;
  #input: Uint8Array[] = [];
  #queuedBytes = 0;
  #inflightInputBytes = 0;
  #resize: Frame | undefined;
  #control: Frame | undefined;
  #pendingControl: ProcessAction | undefined;
  #writing = false;
  #backpressure = false;
  #synchronizing = false;
  #stopped = false;
  #error: ProtocolError | undefined;

  constructor(
    welcome: Welcome,
    send: (frame: Frame) => Promise<void>,
    fail: (error: unknown) => void,
  ) {
    if (welcome.mode !== 'leash') throw new ProtocolError('MODE_MISMATCH');
    this.#welcome = welcome;
    this.#send = send;
    this.#fail = fail;
    this.#displayReady = new Promise((resolve) => {
      this.#resolveDisplay = resolve;
    });
    this.#disposed = new Promise((resolve) => {
      this.#resolveDisposed = resolve;
    });
  }

  inspect(): LeashState {
    return Object.freeze({
      reset: this.#reset,
      process: this.#process,
      endedAt: this.#endedAt,
      droppedBytes: this.#droppedBytes,
      queuedBytes: this.#queuedBytes,
      backpressure: this.#backpressure,
      pendingControl: this.#pendingControl,
      synchronizing: this.#synchronizing,
      stopped: this.#stopped,
      error: this.#error,
    });
  }

  observe(observer: () => void): () => void {
    if (this.#observer !== undefined) throw new TerminalDisplayError();
    this.#observer = observer;
    return () => {
      if (this.#observer === observer) this.#observer = undefined;
    };
  }

  attachDisplay(display: TerminalDisplay): () => void {
    if (this.#displayAttached || this.#stopped)
      throw new TerminalDisplayError();
    this.#displayAttached = true;
    this.#resolveDisplay(display);
    return () => this.dispose();
  }

  failDisplay(): void {
    if (!this.#stopped) {
      this.#fail(new TerminalDisplayError());
      this.dispose();
    }
  }

  canInput(): boolean {
    return (
      !this.#stopped &&
      !this.#backpressure &&
      !this.#synchronizing &&
      this.#pendingControl === undefined &&
      this.#error?.code !== 'READONLY' &&
      this.#welcome.capabilities.includes('terminal_input') &&
      (this.#process?.state === 'running' ||
        this.#process?.state === 'interrupting')
    );
  }

  canControl(action: ProcessAction): boolean {
    if (
      this.#stopped ||
      this.#synchronizing ||
      this.#pendingControl !== undefined ||
      !this.#welcome.capabilities.includes(action)
    )
      return false;
    return (
      this.#process?.state === 'running' ||
      this.#process?.state === 'interrupting' ||
      (action === 'restart' && this.#process?.state === 'exited')
    );
  }

  // Accepted bytes are copied and retain order. The budget includes the frame
  // currently in flight; a failed paste never partially enters this queue.
  input(data: Uint8Array): boolean {
    if (!this.canInput() || data.byteLength === 0) return false;
    if (data.byteLength > TERMINAL_INPUT_BYTES - this.#queuedBytes) {
      this.#backpressure = true;
      this.#error = new ProtocolError('BACKPRESSURE');
      this.#changed();
      return false;
    }
    for (
      let offset = 0;
      offset < data.byteLength;
      offset += TERMINAL_CHUNK_BYTES
    ) {
      this.#input.push(data.slice(offset, offset + TERMINAL_CHUNK_BYTES));
    }
    this.#queuedBytes += data.byteLength;
    this.#changed();
    void this.#flush();
    return true;
  }

  resize(cols: number, rows: number): boolean {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 500 ||
      rows < 5 ||
      rows > 200
    )
      throw new ProtocolError('BAD_FRAME');
    if (
      this.#stopped ||
      this.#reset === undefined ||
      !this.#welcome.capabilities.includes('resize')
    )
      return false;
    const payload = new Uint8Array(4),
      view = new DataView(payload.buffer);
    view.setUint16(0, cols);
    view.setUint16(2, rows);
    this.#resize = { type: Message.TERM_RESIZE, payload };
    void this.#flush();
    return true;
  }

  control(action: ProcessAction): boolean {
    if (!this.canControl(action) || this.#reset === undefined) return false;
    this.#control = {
      type: Message.PROCESS_CONTROL,
      payload: encodeProcessControl({
        action,
        generation: this.#reset.generation,
      }),
    };
    this.#pendingControl = action;
    this.#changed();
    void this.#flush();
    return true;
  }

  resumeInput(): boolean {
    if (!this.#backpressure || this.#stopped) return false;
    this.#backpressure = false;
    this.#error = undefined;
    this.#changed();
    void this.#flush();
    return true;
  }

  // Called only after the session's PONG write has completed. Later input uses
  // that same serialized writer, so it cannot overtake the restart boundary.
  pongSent(): void {
    if (this.#synchronizing && this.#process !== undefined) {
      this.#synchronizing = false;
      this.#changed();
      void this.#flush();
    }
  }

  reject(error: ProtocolError): boolean {
    if (
      ![
        'BACKPRESSURE',
        'READONLY',
        'PROCESS_NOT_RUNNING',
        'RESTART_DISABLED',
        'TERMINATE_DISABLED',
        'UNAUTHORIZED_CAPABILITY',
      ].includes(error.code)
    )
      return false;
    this.#error = error;
    this.#pendingControl = undefined;
    this.#control = undefined;
    this.#backpressure = error.code === 'BACKPRESSURE';
    if (!this.#backpressure) this.#clearInput();
    this.#changed();
    return true;
  }

  async receive(frame: Frame): Promise<boolean> {
    if (this.#stopped) return false;
    if (
      ![
        Message.TERM_RESET,
        Message.TERM_OUTPUT,
        Message.PROCESS_STATE,
        Message.OUTPUT_DROPPED,
      ].some((type) => type === frame.type)
    )
      return false;
    if (!this.#welcome.capabilities.includes('terminal_output'))
      throw new ProtocolError('UNAUTHORIZED_CAPABILITY');
    if (frame.type === Message.TERM_RESET) {
      const reset = decodeTermReset(frame.payload);
      if (
        this.#reset !== undefined &&
        (reset.generation < this.#reset.generation ||
          reset.generation > this.#reset.generation + 1)
      )
        throw new ProtocolError('BAD_FRAME');
      // Starting and running can each replace the snapshot in one generation.
      // A PONG for the first reset must not authorize input after the second.
      this.#synchronizing ||= this.#reset !== undefined;
      this.#reset = reset;
      this.#process = undefined;
      this.#endedAt = undefined;
      this.#droppedBytes = 0;
      this.#backpressure = false;
      this.#error = undefined;
      this.#pendingControl = undefined;
      this.#control = undefined;
      this.#resize = undefined;
      this.#clearInput();
      this.#changed();
      await this.#render((display) => display.reset(reset));
      return true;
    }
    if (this.#reset === undefined) throw new ProtocolError('BAD_FRAME');
    if (frame.type === Message.TERM_OUTPUT) {
      if (
        frame.payload.byteLength === 0 ||
        frame.payload.byteLength > TERMINAL_CHUNK_BYTES
      )
        throw new ProtocolError('BAD_FRAME');
      await this.#render((display) => display.write(frame.payload));
      return true;
    }
    if (frame.type === Message.PROCESS_STATE) {
      const state = decodeProcessState(frame.payload);
      if (state.generation !== this.#reset.generation)
        throw new ProtocolError('BAD_FRAME');
      this.#process = state;
      // A state already in flight before a control request is not its reply.
      if (
        state.state !== 'running' &&
        (state.state !== 'interrupting' || this.#pendingControl === 'interrupt')
      )
        this.#pendingControl = undefined;
      if (['exited', 'failed', 'closing'].includes(state.state)) {
        this.#endedAt ??= Date.now();
        this.#clearInput();
      }
      this.#changed();
      void this.#flush();
      return true;
    }
    const dropped = decodeOutputDropped(frame.payload);
    if (
      dropped.generation !== this.#reset.generation ||
      dropped.dropped_bytes < this.#droppedBytes
    )
      throw new ProtocolError('BAD_FRAME');
    this.#droppedBytes = dropped.dropped_bytes;
    this.#changed();
    return true;
  }

  dispose(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearInput();
    this.#queuedBytes = 0;
    this.#control = undefined;
    this.#resize = undefined;
    this.#pendingControl = undefined;
    this.#resolveDisplay(undefined);
    this.#resolveDisposed();
    this.#changed();
    this.#observer = undefined;
  }

  async #render(
    operation: (display: TerminalDisplay) => void | Promise<void>,
  ): Promise<void> {
    const display = await this.#displayReady;
    if (display === undefined || this.#stopped) return;
    try {
      await Promise.race([operation(display), this.#disposed]);
    } catch {
      throw new TerminalDisplayError();
    }
  }

  #changed(): void {
    this.#observer?.();
  }
  #clearInput(): void {
    for (const data of this.#input) data.fill(0);
    this.#input = [];
    this.#queuedBytes = this.#inflightInputBytes;
  }

  async #flush(): Promise<void> {
    if (this.#writing || this.#stopped) return;
    this.#writing = true;
    try {
      while (!this.#stopped) {
        let frame: Frame | undefined;
        if (this.#control !== undefined) {
          frame = this.#control;
          this.#control = undefined;
        } else if (this.#resize !== undefined) {
          frame = this.#resize;
          this.#resize = undefined;
        } else if (this.canInput()) {
          const data = this.#input.shift();
          if (data !== undefined) {
            frame = { type: Message.TERM_INPUT, payload: data };
            this.#inflightInputBytes = data.byteLength;
          }
        }
        if (frame === undefined) return;
        try {
          await this.#send(frame);
        } finally {
          frame.payload.fill(0);
          if (frame.type === Message.TERM_INPUT) {
            this.#queuedBytes = Math.max(
              0,
              this.#queuedBytes - this.#inflightInputBytes,
            );
            this.#inflightInputBytes = 0;
          }
          this.#changed();
        }
      }
    } catch (error) {
      if (!this.#stopped) {
        this.#fail(error);
        this.dispose();
      }
    } finally {
      this.#writing = false;
    }
  }
}
