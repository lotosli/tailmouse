import {
  Message,
  ProtocolError,
  type Frame,
  type Welcome,
} from './protocol/frame.ts';
import {
  decodeGameInit,
  decodeGameSnapshot,
  decodeGameEvent,
  decodeGameResult,
  encodeGameInput,
  type GameInit,
  type GameSnapshot,
  type GameEvent,
  type GameResult,
  type GamePoint,
} from './protocol/game.ts';
import {
  EscapePrediction,
  type EscapePredictionFrame,
} from './escape-prediction.ts';

interface Intent extends GamePoint {
  readonly dash: boolean;
}
export interface EscapeState {
  readonly init: GameInit | undefined;
  readonly snapshot: GameSnapshot | undefined;
  readonly event: GameEvent | undefined;
  readonly result: GameResult | undefined;
  readonly queued: number;
  readonly inFlight: boolean;
  readonly backpressure: boolean;
  readonly stopped: boolean;
}

// Connection-local mode state. The session owns the one stream reader/writer;
// no queue or timer in this object survives connection teardown.
export class EscapeClient {
  readonly #send: (frame: Frame) => Promise<void>;
  readonly #fail: (error: unknown) => void;
  readonly #welcome: Welcome;
  readonly #timer: ReturnType<typeof setInterval>;
  #init: GameInit | undefined;
  #snapshot: GameSnapshot | undefined;
  #event: GameEvent | undefined;
  #result: GameResult | undefined;
  #snapshotSequence = 0;
  #eventSequence = 0;
  #inputSequence = 0;
  #started = false;
  #hasRun = false;
  #inFlight = false;
  #stopped = false;
  #backpressure = false;
  #direction: GamePoint = { x: 0, y: 0 };
  #queue: Intent[] = [];
  #prediction: EscapePrediction | undefined;

  constructor(
    welcome: Welcome,
    send: (frame: Frame) => Promise<void>,
    fail: (error: unknown) => void,
  ) {
    if (welcome.mode !== 'escape') throw new ProtocolError('MODE_MISMATCH');
    this.#welcome = welcome;
    this.#send = send;
    this.#fail = fail;
    this.#timer = setInterval(() => this.#tick(), 50);
  }

  inspect(): EscapeState {
    return Object.freeze({
      init: this.#init,
      snapshot: this.#snapshot,
      event: this.#event,
      result: this.#result,
      queued: this.#queue.length,
      inFlight: this.#inFlight,
      backpressure: this.#backpressure,
      stopped: this.#stopped,
    });
  }

  predict(now = performance.now()): EscapePredictionFrame | undefined {
    return this.#prediction?.render(now);
  }

  move(x: number, y: number): boolean {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      Math.abs(x) > 1 ||
      Math.abs(y) > 1
    ) {
      throw new ProtocolError('BAD_FRAME');
    }
    if (!this.#canInput()) return false;
    const length = Math.max(1, Math.hypot(x, y));
    this.#direction = { x: x / length, y: y / length };
    this.#prediction?.move(this.#direction, performance.now());
    return true;
  }

  // False means the new event was not accepted. Already accepted events retain
  // their order and direction, including while the stream write is blocked.
  dash(): boolean {
    if (!this.#canInput() || !this.#welcome.capabilities.includes('dash'))
      return false;
    if (this.#queue.filter((intent) => intent.dash).length >= 8) {
      this.#backpressure = true;
      return false;
    }
    this.#queue.push({ ...this.#direction, dash: true });
    return true;
  }

  receive(frame: Frame): boolean {
    if (this.#stopped) return false;
    if (frame.type === Message.GAME_INIT) {
      if (
        !this.#welcome.capabilities.includes('game_view') ||
        (this.#init !== undefined && this.#result === undefined)
      ) {
        throw new ProtocolError('BAD_FRAME');
      }
      const init = decodeGameInit(frame.payload);
      this.#clearIntent();
      this.#init = init;
      this.#prediction = new EscapePrediction(init);
      this.#snapshot = undefined;
      this.#event = undefined;
      this.#result = undefined;
      this.#started = false;
      this.#hasRun = false;
      return true;
    }
    if (
      ![Message.GAME_SNAPSHOT, Message.GAME_EVENT, Message.GAME_RESULT].some(
        (type) => frame.type === type,
      )
    )
      return false;
    const init = this.#init;
    if (init === undefined) throw new ProtocolError('BAD_FRAME');
    if (frame.type === Message.GAME_SNAPSHOT) {
      const next = decodeGameSnapshot(frame.payload);
      if (next.sequence <= this.#snapshotSequence) return true;
      const previous = this.#snapshot;
      if (
        this.#result !== undefined ||
        next.elapsedMS > BigInt(init.round_duration_ms) ||
        next.elapsedMS + BigInt(next.remainingMS) !==
          BigInt(init.round_duration_ms) ||
        ![next.mouse, next.cat].every(
          (point) =>
            init.map.rows[Math.floor(point.y)]![Math.floor(point.x)] === '.',
        ) ||
        (next.phase === 0 &&
          (this.#hasRun ||
            next.elapsedMS !== 0n ||
            next.collectedMask !== 0 ||
            next.dashCooldownMS !== 0)) ||
        (previous !== undefined &&
          (next.elapsedMS < previous.elapsedMS ||
            next.acceptedInputSequence < previous.acceptedInputSequence ||
            next.acceptedInputSequence > this.#inputSequence ||
            (next.collectedMask & previous.collectedMask) !==
              previous.collectedMask))
      ) {
        throw new ProtocolError('BAD_FRAME');
      }
      this.#snapshotSequence = next.sequence;
      this.#inputSequence = Math.max(
        this.#inputSequence,
        next.acceptedInputSequence,
      );
      this.#snapshot = next;
      this.#prediction!.receive(next, performance.now());
      this.#hasRun ||= next.phase === 1 || next.elapsedMS > 0n;
      this.#started = true;
      return true;
    }
    if (frame.type === Message.GAME_EVENT) {
      const event = decodeGameEvent(frame.payload, 'host');
      if (event.sequence <= this.#eventSequence) return true;
      if (this.#result !== undefined) throw new ProtocolError('BAD_FRAME');
      this.#eventSequence = event.sequence;
      this.#event = event;
      return true;
    }
    const result = decodeGameResult(frame.payload);
    if (
      this.#result !== undefined ||
      result.elapsed_ms > init.round_duration_ms ||
      BigInt(result.elapsed_ms) < (this.#snapshot?.elapsedMS ?? 0n) ||
      result.relay !== this.#welcome.relay.host
    )
      throw new ProtocolError('BAD_FRAME');
    this.#result = result;
    this.#clearIntent();
    return true;
  }

  dispose(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#clearIntent();
  }

  #clearIntent(): void {
    this.#queue = [];
    this.#direction = { x: 0, y: 0 };
    this.#backpressure = false;
    this.#prediction = undefined;
  }

  #canInput(): boolean {
    return (
      !this.#stopped &&
      this.#started &&
      this.#result === undefined &&
      this.#welcome.capabilities.includes('game_input')
    );
  }

  #tick(): void {
    if (!this.#canInput()) return;
    // Movement is replaceable even across discrete events. Removing it never
    // removes/reorders a dash; the newest movement follows all accepted dashes.
    this.#queue = this.#queue.filter((intent) => intent.dash);
    this.#queue.push({ ...this.#direction, dash: false });
    if (this.#inFlight) return;
    const intent = this.#queue.shift()!;
    this.#backpressure = false;
    this.#inFlight = true;
    void this.#write(intent)
      .catch((error: unknown) => {
        this.dispose();
        this.#fail(error);
      })
      .finally(() => {
        this.#inFlight = false;
      });
  }

  async #write(intent: Intent): Promise<void> {
    const payload = encodeGameInput({
      sequence: ++this.#inputSequence,
      clientTimeMS: BigInt(Math.floor(performance.now())),
      velocityX: intent.x,
      velocityY: intent.y,
      dash: intent.dash,
    });
    try {
      await this.#send({ type: Message.GAME_INPUT, payload });
    } finally {
      payload.fill(0);
    }
  }
}
