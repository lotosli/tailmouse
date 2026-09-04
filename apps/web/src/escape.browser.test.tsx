import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { EscapeClient } from './escape.ts';
import { EscapeView, EscapeResult } from './escape-view.tsx';
import { EscapeInput } from './escape-input.ts';
import { drawEscape } from './escape-canvas.ts';
import { Message, type Frame } from './protocol/frame.ts';
import {
  decodeGameInit,
  decodeGameInput,
  encodeGameInit,
  encodeGameSnapshot,
  encodeGameEvent,
  encodeGameResult,
  gameResultMessage,
  type GameInit,
  type GameSnapshot,
  type GameResult,
  type GameInput,
} from './protocol/game.ts';
import fixtureText from '../../../protocol/fixtures/v1/frames.json?raw';

const corpus = JSON.parse(fixtureText) as {
  cases: Array<{ id: string; wire: { hex: string } }>;
};
const hex = corpus.cases.find((entry) => entry.id === 'game-init-canonical')!
  .wire.hex;
const bytes = Uint8Array.from(
  hex.match(/../gu)!.map((part) => parseInt(part, 16)),
);
const initial = decodeGameInit(bytes.slice(6));
const root = document.createElement('div');
const cleanups: Array<() => void> = [];
const last = <T,>(values: readonly T[]): T => values[values.length - 1]!;
afterEach(async () => {
  await act(() => render(null, root));
  for (const cleanup of cleanups.splice(0)) cleanup();
  root.remove();
  root.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(
  options: {
    presentation?: GameInit['presentation'];
    input?: boolean;
    dash?: boolean;
    start?: boolean;
    blocked?: boolean;
  } = {},
) {
  document.body.append(root);
  const frames: GameInput[] = [];
  const releases: Array<() => void> = [];
  const fail = vi.fn();
  const client = new EscapeClient(
    {
      mode: 'escape',
      expiresAt: 0,
      relay: {
        mode: 'custom-host',
        host: 'relay.example.test',
        browserPath: 'derp',
      },
      capabilities: [
        'game_view',
        ...(options.input === false ? [] : ['game_input']),
        ...(options.dash === false ? [] : ['dash']),
      ],
    },
    async (frame: Frame) => {
      frames.push(decodeGameInput(frame.payload));
      if (options.blocked)
        await new Promise<void>((resolve) => releases.push(resolve));
    },
    fail,
  );
  cleanups.push(() => {
    client.dispose();
    for (const release of releases) release();
    expect(fail).not.toHaveBeenCalled();
  });
  const init = {
    ...initial,
    presentation: options.presentation ?? initial.presentation,
  };
  let sequence = 0;
  const snapshot = (patch: Partial<GameSnapshot> = {}) =>
    client.receive({
      type: Message.GAME_SNAPSHOT,
      payload: encodeGameSnapshot({
        sequence: ++sequence,
        acceptedInputSequence: 0,
        elapsedMS: 0n,
        mouse: initial.mouse,
        cat: initial.cat,
        remainingMS: 45000,
        dashCooldownMS: 0,
        collectedMask: 0,
        phase: 0,
        exitOpen: false,
        ...patch,
      }),
    });
  const initialize = () =>
    client.receive({ type: Message.GAME_INIT, payload: encodeGameInit(init) });
  if (options.start !== false) {
    initialize();
    snapshot();
  }
  await act(() =>
    render(
      <EscapeView
        game={client}
        canInput={options.input !== false}
        canDash={options.dash !== false}
      />,
      root,
    ),
  );
  return { client, frames, snapshot, initialize };
}
function key(
  element: Element,
  type: 'keydown' | 'keyup',
  name: string,
  extra: KeyboardEventInit = {},
) {
  element.dispatchEvent(
    new KeyboardEvent(type, {
      key: name,
      bubbles: true,
      cancelable: true,
      ...extra,
    }),
  );
}

describe('Escape presentation in a real browser', () => {
  it('accepts the first key as soon as controls mount and releases held input on unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const game = await setup();
    game.snapshot({ phase: 1 });
    await act(() => render(null, root));
    let controls!: HTMLElement;
    await act(() => {
      render(<EscapeView game={game.client} canInput canDash />, root);
      controls = page
        .getByRole('group', { name: 'Movement controls' })
        .element() as HTMLElement;
      controls.focus();
      // Input can arrive before passive effects, once this control is exposed.
      key(controls, 'keydown', 'ArrowRight');
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(last(game.frames).velocityX).toBe(1);
    await act(() => render(null, root));
    key(controls, 'keydown', 'ArrowLeft');
    await vi.advanceTimersByTimeAsync(50);
    expect(last(game.frames).velocityX).toBe(0);
    expect(last(game.frames).velocityY).toBe(0);
  });

  it('paints local movement before sending input and draws dust for a large authoritative correction', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    let scheduled!: FrameRequestCallback;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const arcs = vi.spyOn(CanvasRenderingContext2D.prototype, 'arc');
    const game = await setup();
    game.snapshot({ phase: 1 });
    await act(() => scheduled(now));
    const controls = page
      .getByRole('group', { name: 'Movement controls' })
      .element();
    key(controls, 'keydown', 'ArrowRight');
    now = 1000 / 60;
    await act(() => scheduled(now));
    const lastMouse = () =>
      last(arcs.mock.calls.filter((args) => args[2] === 0.36));
    expect(lastMouse()[0]).toBeCloseTo(initial.mouse.x + 0.1);
    expect(game.frames).toHaveLength(0);
    expect(game.client.inspect().snapshot?.mouse).toEqual(initial.mouse);
    key(controls, 'keyup', 'ArrowRight');
    const target = { x: 10.5, y: 3.5 };
    game.snapshot({ phase: 1, mouse: target });
    arcs.mockClear();
    now += 1000 / 60;
    await act(() => scheduled(now));
    expect(lastMouse().slice(0, 2)).toEqual([target.x, target.y]);
    expect(
      arcs.mock.calls.filter((args) => args[2] >= 0.13 && args[2] < 0.18),
    ).toHaveLength(6);
    arcs.mockClear();
    now = 300;
    await act(() => scheduled(now));
    expect(
      arcs.mock.calls.filter((args) => args[2] >= 0.13 && args[2] < 0.18),
    ).toHaveLength(0);
  });

  it.each([60, 90, 120])(
    'targets 60 draws per second on a %i Hz display without a render backlog',
    async (refresh) => {
      let scheduled!: FrameRequestCallback;
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
        (callback) => {
          scheduled = callback;
          return 1;
        },
      );
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
      const fills = vi.spyOn(CanvasRenderingContext2D.prototype, 'fillRect');
      await setup();
      await act(() => {
        for (let index = 0; index < refresh; index++)
          scheduled((index * 1000) / refresh);
      });
      const backgrounds = () =>
        fills.mock.calls.filter((args) => args.join(',') === '0,0,48,18')
          .length;
      expect(backgrounds()).toBe(60);
      await act(() => scheduled(10_000));
      expect(backgrounds()).toBe(61);
    },
  );

  it('renders RTT-shaped scent from visible movement, updates jitter and clears a paused path', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    let scheduled!: FrameRequestCallback;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      scheduled = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const arcs = vi.spyOn(CanvasRenderingContext2D.prototype, 'arc');
    const game = await setup();
    const setMetrics = async (rttMs: number, jitterMs: number) =>
      act(() =>
        render(
          <EscapeView
            game={game.client}
            canInput
            canDash
            metrics={{
              samples: 1,
              rttMs,
              jitterMs,
              p50Ms: rttMs,
              p95Ms: rttMs,
              bytesRx: 0,
              bytesTx: 0,
              framesRx: 0,
              framesTx: 0,
            }}
          />,
          root,
        ),
      );
    await setMetrics(40, 0);
    game.snapshot({ phase: 1 });
    await act(() => scheduled(now));
    const controls = page
      .getByRole('group', { name: 'Movement controls' })
      .element();
    key(controls, 'keydown', 'ArrowRight');
    for (now = 40; now <= 480; now += 40) {
      arcs.mockClear();
      await act(() => scheduled(now));
    }
    const dots = () =>
      arcs.mock.calls.filter((args) => args[2] === 0.1).map((args) => args[0]);
    expect(dots()).toHaveLength(1);
    await setMetrics(250, 0);
    arcs.mockClear();
    now = 500;
    await act(() => scheduled(now));
    const uniform = dots();
    expect(uniform.length).toBeGreaterThan(4);
    expect(uniform[0]! - uniform[1]!).toBeCloseTo(0.48);
    await setMetrics(250, 50);
    arcs.mockClear();
    now = 520;
    await act(() => scheduled(now));
    const irregular = dots();
    expect(irregular[0]! - irregular[1]!).toBeCloseTo(0.24);
    expect(irregular[1]! - irregular[2]!).toBeCloseTo(0.48);
    expect(game.frames).toHaveLength(0);
    expect(game.client.inspect().snapshot?.mouse).toEqual(initial.mouse);
    await page.screenshot();
    game.snapshot({ phase: 2 });
    arcs.mockClear();
    now = 560;
    await act(() => scheduled(now));
    expect(dots()).toEqual([]);
    game.snapshot({ phase: 1 });
    arcs.mockClear();
    now = 600;
    await act(() => scheduled(now));
    expect(dots()).toEqual([]);
  });

  it('waits for initialization and snapshot, then renders entities and emits keyboard/dash intent', async () => {
    const game = await setup({ start: false });
    await expect
      .element(page.getByText("Waiting for the host's game state."))
      .toBeVisible();
    game.initialize();
    await expect
      .element(page.getByText("Waiting for the host's game state."))
      .toBeVisible();
    game.snapshot();
    await expect
      .element(page.getByRole('img', { name: /courtyard map/u }))
      .toBeVisible();
    await expect
      .element(page.getByText('Get ready', { exact: true }))
      .toBeVisible();
    game.client.receive({
      type: Message.GAME_EVENT,
      payload: encodeGameEvent(
        { sequence: 1, event: 'countdown', value: 3 },
        'host',
      ),
    });
    await expect.element(page.getByText('Get ready: 3')).toBeVisible();
    game.snapshot({ phase: 1 });
    const controls = page.getByRole('group', { name: 'Movement controls' });
    await controls.click();
    key(controls.element(), 'keydown', 'ArrowRight');
    await vi.waitFor(() => expect(last(game.frames).velocityX).toBe(1));
    key(controls.element(), 'keydown', 'ArrowUp');
    await vi.waitFor(() =>
      expect(last(game.frames).velocityY).toBeCloseTo(-Math.SQRT1_2),
    );
    key(controls.element(), 'keyup', 'ArrowRight');
    key(controls.element(), 'keyup', 'ArrowUp');
    await vi.waitFor(() => expect(last(game.frames).velocityX).toBe(0));
    await page.getByRole('button', { name: 'Dash', exact: true }).click();
    await vi.waitFor(() =>
      expect(game.frames.some((frame) => frame.dash)).toBe(true),
    );
    game.snapshot({ phase: 1, dashCooldownMS: 4900 });
    await expect
      .element(page.getByRole('button', { name: 'Dash · 4.9 s' }))
      .toBeDisabled();
    game.snapshot({ phase: 2, collectedMask: 3, exitOpen: true });
    await expect
      .element(page.getByText(/Connection lost — game paused/u))
      .toBeVisible();
    await expect
      .element(page.getByRole('img', { name: /open exit/u }))
      .toBeVisible();
    await page.getByText('Text map and positions', { exact: true }).click();
    await expect.element(page.getByText(/Mouse 3.5, 3.5/u)).toBeVisible();
    const canvas = page.getByRole('img').element() as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(48);
    expect(canvas.height / canvas.width).toBeCloseTo(18 / 48, 2);
  });

  it('honors phone-disabled policy while keeping touch and host-preferred tilt accessible', async () => {
    await setup({
      presentation: { control: 'tilt', phone_render: false, show_net: false },
      dash: false,
    });
    await expect
      .element(page.getByText(/Phone rendering is disabled/u))
      .toBeVisible();
    await expect
      .element(page.getByRole('group', { name: 'Movement controls' }))
      .toBeVisible();
    await expect
      .element(page.getByText(/The host prefers tilt/u))
      .toBeVisible();
    expect(page.getByRole('img').elements()).toHaveLength(0);
    expect(
      page.getByRole('button', { name: 'Dash', exact: true }).elements(),
    ).toHaveLength(0);
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    await page.getByRole('button', { name: 'Enable tilt' }).click();
    await expect
      .element(
        page.getByText('Tilt is unavailable. Touch controls are active.'),
      )
      .toBeVisible();
    await page.getByRole('button', { name: 'Touch', exact: true }).click();
    await expect
      .element(page.getByRole('button', { name: 'Touch', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    vi.stubGlobal('AudioContext', undefined);
    await page.getByRole('button', { name: 'Unmute' }).click();
    await expect
      .element(page.getByText('Sound is unavailable. The game remains muted.'))
      .toBeVisible();
  });

  it('reports unavailable Canvas and enforces read-only capability', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    await setup({ input: false, dash: false });
    await expect
      .element(page.getByText(/Canvas is unavailable/u))
      .toBeVisible();
    await expect.element(page.getByText(/Read only —/u)).toBeVisible();
    expect(
      page.getByRole('group', { name: 'Movement controls' }).elements(),
    ).toHaveLength(0);
  });

  it('starts sound only on unmute, plays bounded local cues and closes its context', async () => {
    const contexts: AudioContext[] = [];
    const NativeAudioContext = AudioContext;
    vi.stubGlobal(
      'AudioContext',
      class extends NativeAudioContext {
        constructor() {
          // Render with Chromium's real audio engine but no host output
          // device. A headless hardware sink can report running at time 0.
          const options: AudioContextOptions & {
            sinkId: { type: 'none' };
          } = { sinkId: { type: 'none' } };
          super(options);
          contexts.push(this);
        }
      },
    );
    const game = await setup();
    expect(contexts).toHaveLength(0);
    await page.getByRole('button', { name: 'Unmute' }).click();
    await expect
      .element(page.getByRole('button', { name: 'Mute', exact: true }))
      .toBeVisible();
    const context = contexts[0]!;
    expect(context).toHaveProperty('sinkId.type', 'none');
    const ended = vi.fn();
    const createOscillator = context.createOscillator.bind(context);
    const tones = vi
      .spyOn(context, 'createOscillator')
      .mockImplementation(() => {
        const tone = createOscillator();
        // Register before start/stop: this real 80 ms cue can finish while an
        // asynchronous assertion is waiting to observe its creation.
        tone.addEventListener('ended', ended, { once: true });
        return tone;
      });
    game.client.receive({
      type: Message.GAME_EVENT,
      payload: encodeGameEvent(
        { sequence: 1, event: 'countdown', value: 2 },
        'host',
      ),
    });
    await vi.waitFor(() => expect(tones).toHaveBeenCalledOnce());
    const first = tones.mock.results[0]!.value as OscillatorNode;
    expect(first.frequency.value).toBe(660);
    await vi.waitFor(() =>
      expect(
        ended,
        `Audio clock ${context.currentTime}, state ${context.state}, page ${document.visibilityState}`,
      ).toHaveBeenCalledOnce(),
    );
    game.client.receive({
      type: Message.GAME_EVENT,
      payload: encodeGameEvent(
        { sequence: 2, event: 'dash_rejected', value: 1000 },
        'host',
      ),
    });
    await vi.waitFor(() => expect(tones).toHaveBeenCalledTimes(2));
    expect(
      (tones.mock.results[1]!.value as OscillatorNode).frequency.value,
    ).toBe(180);
    await page.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect
      .element(page.getByRole('button', { name: 'Unmute' }))
      .toHaveAttribute('aria-pressed', 'true');
    game.client.receive({
      type: Message.GAME_EVENT,
      payload: encodeGameEvent(
        { sequence: 3, event: 'countdown', value: 1 },
        'host',
      ),
    });
    await expect.element(page.getByText('Get ready: 1')).toBeVisible();
    expect(tones).toHaveBeenCalledTimes(2);
    await act(() => render(null, root));
    await vi.waitFor(() => expect(context.state).toBe('closed'));
  });

  it('renders authoritative results and stops controls without changing the outcome', async () => {
    const game = await setup();
    const result: GameResult = {
      outcome: 'caught',
      elapsed_ms: 1000,
      relay: 'relay.example.test',
      rtt_p50_ms: 48,
      rtt_p95_ms: 63,
      jitter_ms: 6,
      message: gameResultMessage('caught', 48),
    };
    game.client.receive({
      type: Message.GAME_RESULT,
      payload: encodeGameResult(result),
    });
    await expect
      .element(page.getByRole('heading', { name: 'THE CAT WON' }))
      .toBeVisible();
    await expect
      .element(page.getByText('relay.example.test', { exact: true }))
      .toBeVisible();
    expect(
      page.getByRole('group', { name: 'Movement controls' }).elements(),
    ).toHaveLength(0);
    for (const [outcome, title] of [
      ['escaped', 'THE MOUSE ESCAPED'],
      ['timeout', 'TIME RAN OUT'],
      ['connection_lost', 'CONNECTION LOST'],
    ] as const) {
      await act(() =>
        render(
          <EscapeResult
            result={{
              outcome,
              elapsed_ms: 1200,
              relay: result.relay,
              rtt_p50_ms: 48,
              rtt_p95_ms: 63,
              jitter_ms: null,
              message: gameResultMessage(outcome, 48),
            }}
          />,
          root,
        ),
      );
      await expect
        .element(page.getByRole('heading', { name: title }))
        .toBeVisible();
      expect(page.getByText('Jitter', { exact: true }).elements()).toHaveLength(
        0,
      );
    }
  });

  it('shows bounded discrete backpressure rather than dropping accepted dash requests', async () => {
    const game = await setup({ blocked: true });
    game.snapshot({ phase: 1 });
    const button = page.getByRole('button', { name: 'Dash', exact: true });
    await expect.element(button).toBeEnabled();
    for (let index = 0; index < 10; index++) await button.click();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent(
        'Input queue is full. Release movement and try again.',
      );
    expect(game.client.inspect().queued).toBeLessThanOrEqual(9);
  });

  it('draws walls, distinct mouse/cat/cheese and host collection/exit state on Canvas', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 180;
    const context = canvas.getContext('2d')!;
    context.scale(10, 10);
    const state: GameSnapshot = {
      sequence: 1,
      acceptedInputSequence: 0,
      elapsedMS: 0n,
      remainingMS: 45000,
      mouse: initial.mouse,
      cat: initial.cat,
      dashCooldownMS: 0,
      collectedMask: 0,
      phase: 1,
      exitOpen: false,
    };
    const pixel = (x: number, y: number) =>
      Array.from(
        context.getImageData(Math.round(x * 10), Math.round(y * 10), 1, 1).data,
      ).slice(0, 3);
    drawEscape(context, initial, state);
    expect(pixel(0.4, 0.4)).toEqual([38, 60, 44]);
    expect(pixel(5, 5)).toEqual([20, 32, 25]);
    expect(pixel(3.5, 3.4)).toEqual([231, 234, 241]);
    expect(pixel(40.5, 14.3)).toEqual([255, 171, 112]);
    expect(pixel(41.5, 3.7)).toEqual([255, 225, 129]);
    drawEscape(context, initial, {
      ...state,
      collectedMask: 3,
      exitOpen: true,
    });
    expect(pixel(41.5, 3.7)).toEqual([20, 32, 25]);
    drawEscape(
      context,
      initial,
      state,
      { x: 8.5, y: 3.5 },
      {
        point: { x: 5, y: 5 },
        progress: 0,
      },
    );
    expect(pixel(5.5, 5)).toEqual([233, 212, 167]);
    expect(pixel(3.5, 3.4)).toEqual([20, 32, 25]);
    expect(pixel(8.5, 3.4)).toEqual([231, 234, 241]);
    expect(context.globalAlpha).toBe(1);
    drawEscape(context, initial, state, state.mouse, undefined, [
      { x: 5.05, y: 5.05 },
    ]);
    expect(pixel(5, 5)).toEqual([164, 200, 120]);
    drawEscape(context, initial, state);
    expect(pixel(5, 5)).toEqual([20, 32, 25]);
  });
});

function controls() {
  document.body.append(root);
  const area = document.createElement('div');
  area.tabIndex = 0;
  root.append(area);
  const move = vi.fn();
  const input = new EscapeInput(area, move);
  cleanups.push(() => input.dispose());
  return { input, move, area };
}
function orientation(beta: number | null, gamma: number | null) {
  const event = new Event('deviceorientation');
  Object.assign(event, { beta, gamma });
  window.dispatchEvent(event);
}

describe('browser input boundary', () => {
  it('uses gesture-centered touch radius, pointer identity and cancel-to-zero with capture cleanup', () => {
    const { input, move, area } = controls();
    const capture = vi
      .spyOn(area, 'setPointerCapture')
      .mockImplementation(() => {});
    vi.spyOn(area, 'hasPointerCapture').mockReturnValue(true);
    const release = vi
      .spyOn(area, 'releasePointerCapture')
      .mockImplementation(() => {});
    const pointer = (type: string, x: number, y: number, id = 1, button = 0) =>
      area.dispatchEvent(
        new PointerEvent(type, {
          clientX: x,
          clientY: y,
          pointerId: id,
          button,
          bubbles: true,
          cancelable: true,
        }),
      );
    pointer('pointerdown', 100, 100, 1, 2);
    expect(capture).not.toHaveBeenCalled();
    pointer('pointerdown', 100, 100);
    pointer('pointerdown', 500, 500, 2);
    pointer('pointermove', 999, 999, 2);
    expect(input.inspect().direction).toEqual({ x: 0, y: 0 });
    const radius = Math.min(innerWidth, innerHeight) * 0.18;
    pointer('pointermove', 100 + radius / 2, 100);
    expect(input.inspect().direction.x).toBeCloseTo(0.5);
    pointer('pointerup', 0, 0, 2);
    expect(input.inspect().pointer).toBeDefined();
    pointer('pointercancel', 0, 0);
    expect(last(move.mock.calls)).toEqual([0, 0]);
    expect(release).toHaveBeenCalledWith(1);
    pointer('pointerdown', 100, 100);
    pointer('lostpointercapture', 0, 0);
    expect(input.inspect().pointer).toBeUndefined();
    pointer('pointerdown', 100, 100);
    key(area, 'keydown', 'W');
    expect(input.inspect().pointer).toBeUndefined();
    key(area, 'keydown', 'constructor');
    key(area, 'keydown', 's', { ctrlKey: true });
    expect(input.inspect().direction).toEqual({ x: 0, y: -1 });
    key(area, 'keyup', 'unused');
    key(area, 'keyup', 'W');
    expect(input.inspect().direction).toEqual({ x: 0, y: 0 });
    key(area, 'keydown', 'a');
    area.dispatchEvent(new FocusEvent('blur'));
    expect(last(move.mock.calls)).toEqual([0, 0]);
    key(area, 'keydown', 'd');
    window.dispatchEvent(new Event('blur'));
    expect(last(move.mock.calls)).toEqual([0, 0]);
    key(area, 'keydown', 'd');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(last(move.mock.calls)).toEqual([0, 0]);
    input.dispose();
    move.mockClear();
    pointer('pointerdown', 0, 0);
    key(area, 'keydown', 'w');
    expect(move).not.toHaveBeenCalled();
  });

  it('requests tilt synchronously on gesture and calibrates for one second before filtered movement', async () => {
    vi.useFakeTimers({
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'performance',
      ],
    });
    const { input, move, area } = controls();
    const permission = vi.fn(async () => 'granted');
    vi.stubGlobal('DeviceOrientationEvent', { requestPermission: permission });
    const enabling = input.enableTilt();
    expect(permission).toHaveBeenCalledOnce();
    await enabling;
    expect(input.inspect().tilt).toBe('calibrating');
    orientation(null, 10);
    orientation(200, 10);
    orientation(30, NaN);
    orientation(30, 10);
    await vi.advanceTimersByTimeAsync(900);
    orientation(30, 10);
    expect(last(move.mock.calls)).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(100);
    expect(input.inspect().tilt).toBe('active');
    orientation(30, 40);
    expect(input.inspect().direction.x).toBeCloseTo(0.2);
    vi.spyOn(screen.orientation, 'angle', 'get').mockReturnValue(90);
    orientation(30, 40);
    expect(input.inspect().direction.y).toBeLessThan(-0.3);
    await vi.advanceTimersByTimeAsync(750);
    expect(input.inspect().tilt).toBe('unavailable');
    expect(last(move.mock.calls)).toEqual([0, 0]);
    vi.stubGlobal('DeviceOrientationEvent', {});
    await input.enableTilt();
    key(area, 'keydown', 's');
    expect(input.inspect().mode).toBe('touch');
    expect(last(move.mock.calls)).toEqual([0, 1]);
  });

  it('falls back on denied/absent/missing sensors and discards late permission after switch or unmount', async () => {
    vi.useFakeTimers();
    const { input, move } = controls();
    for (const permission of [
      async () => 'denied',
      () => Promise.reject(new Error('sensor denied')),
    ]) {
      vi.stubGlobal('DeviceOrientationEvent', {
        requestPermission: permission,
      });
      await input.enableTilt();
      expect(input.inspect().tilt).toBe('denied');
      expect(last(move.mock.calls)).toEqual([0, 0]);
    }
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    await input.enableTilt();
    expect(input.inspect().tilt).toBe('unavailable');
    vi.stubGlobal('DeviceOrientationEvent', {});
    await input.enableTilt();
    await vi.advanceTimersByTimeAsync(1000);
    expect(input.inspect().tilt).toBe('unavailable');
    let resolve!: (value: string) => void;
    vi.stubGlobal('DeviceOrientationEvent', {
      requestPermission: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });
    let pending = input.enableTilt();
    input.touch();
    resolve('granted');
    await pending;
    expect(input.inspect().tilt).toBe('off');
    pending = input.enableTilt();
    input.dispose();
    resolve('granted');
    await pending;
    expect(input.inspect().tilt).toBe('off');
    await input.enableTilt();
    expect(vi.getTimerCount()).toBe(0);
  });
});
