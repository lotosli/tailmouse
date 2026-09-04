import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { LeashView } from './leash-view.tsx';
import { LeashClient, TERMINAL_INPUT_BYTES } from './leash.ts';
import {
  Message,
  ProtocolError,
  type Frame,
  type Welcome,
} from './protocol/frame.ts';
import {
  decodeProcessControl,
  type ProcessState,
} from './protocol/terminal.ts';
import './style.css';

const root = document.createElement('div');
const cleanups: Array<() => void> = [];
afterEach(async () => {
  await act(() => render(null, root));
  for (const cleanup of cleanups.splice(0)) cleanup();
  root.remove();
  root.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const json = (type: Frame['type'], value: unknown): Frame => ({
  type,
  payload: new TextEncoder().encode(JSON.stringify(value)),
});
async function setup(
  options: {
    readonly?: boolean;
    disabled?: boolean;
    ready?: boolean;
    blocked?: boolean;
    metrics?: boolean;
    screenReader?: boolean;
  } = {},
) {
  root.style.width = '700px';
  document.body.append(root);
  const frames: Frame[] = [],
    releases: Array<() => void> = [];
  const fail = vi.fn();
  const welcome: Welcome = {
    mode: 'leash',
    expiresAt: 0,
    relay: {
      mode: 'custom-host',
      host: 'relay.example.test',
      browserPath: 'derp',
    },
    capabilities: options.readonly
      ? ['terminal_output']
      : [
          'interrupt',
          'resize',
          ...(options.disabled ? [] : ['restart']),
          'terminal_input',
          'terminal_output',
          ...(options.disabled ? [] : ['terminate']),
        ],
  };
  const client = new LeashClient(
    welcome,
    async (frame) => {
      frames.push({ type: frame.type, payload: frame.payload.slice() });
      if (options.blocked && frame.type === Message.TERM_INPUT)
        await new Promise<void>((resolve) => releases.push(resolve));
    },
    fail,
  );
  cleanups.push(() => {
    client.dispose();
    for (const release of releases) release();
    expect(fail).not.toHaveBeenCalled();
  });
  const open = vi.spyOn(Terminal.prototype, 'open');
  await act(() =>
    render(
      <LeashView
        terminal={client}
        welcome={welcome}
        metrics={
          options.metrics
            ? {
                samples: 1,
                rttMs: 52,
                jitterMs: 0,
                p50Ms: 52,
                p95Ms: 52,
                framesRx: 0,
                framesTx: 0,
                bytesRx: 0,
                bytesTx: 0,
              }
            : undefined
        }
      />,
      root,
    ),
  );
  expect(open).toHaveBeenCalledTimes(1);
  const terminal = open.mock.instances[0]! as Terminal;
  if (options.screenReader !== false)
    await page.getByRole('checkbox', { name: 'Screen reader support' }).click();
  const reset = async (generation = 1) => {
    await act(async () => {
      await client.receive(
        json(Message.TERM_RESET, { generation, cols: 80, rows: 24 }),
      );
    });
  };
  const state = async (patch: Partial<ProcessState> = {}) => {
    await act(async () => {
      await client.receive(
        json(Message.PROCESS_STATE, {
          generation: client.inspect().reset?.generation ?? 1,
          state: 'running',
          pid: 42,
          started_at: Math.floor(Date.now() / 1000) - 1062,
          exit_code: null,
          signal: null,
          ...patch,
        }),
      );
    });
  };
  const output = async (text: string) => {
    await act(async () => {
      await client.receive({
        type: Message.TERM_OUTPUT,
        payload: new TextEncoder().encode(text),
      });
    });
  };
  if (options.ready !== false) {
    await reset();
    await state();
  }
  const inputs = () =>
    frames.filter((frame) => frame.type === Message.TERM_INPUT);
  const data = () =>
    new TextDecoder().decode(
      Uint8Array.from(inputs().flatMap((frame) => [...frame.payload])),
    );
  return {
    client,
    terminal,
    frames,
    releases,
    reset,
    state,
    output,
    inputs,
    data,
  };
}

describe('Leash terminal in a real browser', () => {
  it.each([259, 0xc000_013a, 0xffff_ffff])(
    'displays exact native exit status %i and disables terminal input',
    async (exit_code) => {
      const f = await setup();
      await f.state({ state: 'exited', exit_code });
      await expect
        .element(page.getByLabelText('Process status'))
        .toHaveTextContent(`Exit ${exit_code}`);
      await expect
        .element(page.getByRole('button', { name: 'Open keyboard' }))
        .toBeDisabled();
      expect(f.client.inspect().process?.exit_code).toBe(exit_code);
      expect(f.client.canInput()).toBe(false);
    },
  );

  it.each([false, true])(
    'scrolls normal history by touch and clears canceled gestures (readonly=%s)',
    async (readonly) => {
      const f = await setup({ readonly, screenReader: false });
      const output = page
        .getByRole('region', { name: 'Terminal output' })
        .query()!;
      const touch = (type: string, points: Array<[number, number]>) => {
        const event = new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: points.map(
            ([identifier, clientY]) =>
              new Touch({ identifier, clientY, target: output }),
          ),
        });
        output.dispatchEvent(event);
        return event;
      };
      const history = Array.from(
        { length: 200 },
        (_, index) => `line ${index}\r\n`,
      ).join('');
      await f.output(history);
      const bottom = f.terminal.buffer.active.viewportY;
      expect(bottom).toBeGreaterThan(100);
      const height = f.terminal.element!.clientHeight / f.terminal.rows;
      touch('touchstart', [[1, 100]]);
      expect(touch('touchmove', [[1, 100 + height / 2]]).defaultPrevented).toBe(
        true,
      );
      expect(f.terminal.buffer.active.viewportY).toBe(bottom);
      touch('touchmove', [[1, 100 + height * 1.5]]);
      await vi.waitFor(() =>
        expect(f.terminal.buffer.active.viewportY).toBe(bottom - 1),
      );
      touch('touchmove', [[1, 100 - height * 2]]);
      await vi.waitFor(() =>
        expect(f.terminal.buffer.active.viewportY).toBe(bottom),
      );
      touch('touchend', []);
      expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
      for (const cancel of [
        'touchcancel',
        'second finger',
        'different finger',
        'blur',
      ]) {
        touch('touchstart', [[1, 100]]);
        if (cancel === 'touchcancel') touch('touchcancel', []);
        else if (cancel === 'second finger')
          touch('touchmove', [
            [1, 100],
            [2, 200],
          ]);
        else if (cancel === 'different finger') touch('touchmove', [[2, 200]]);
        else window.dispatchEvent(new Event('blur'));
        expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
        expect(f.terminal.buffer.active.viewportY).toBe(bottom);
      }
      touch('touchstart', [
        [1, 100],
        [2, 200],
      ]);
      expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
      touch('touchstart', [[1, 100]]);
      await f.output('\u001b[?1049h');
      expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
      touch('touchstart', [[1, 100]]);
      expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
      await f.output('\u001b[?1049l');
      touch('touchstart', [[1, 100]]);
      await f.reset(2);
      await f.output(history);
      expect(touch('touchmove', [[1, 400]]).defaultPrevented).toBe(false);
      expect(f.terminal.buffer.active.viewportY).toBe(
        f.terminal.buffer.active.baseY,
      );
      expect(f.data()).toBe('');
      expect(getComputedStyle(output).touchAction).toBe('pinch-zoom');
    },
  );

  it('accepts Unicode input by default and exposes explicit screen-reader support', async () => {
    const f = await setup({ screenReader: false });
    await page.getByRole('button', { name: 'Open keyboard' }).click();
    f.terminal.textarea!.dispatchEvent(
      new InputEvent('input', {
        data: 'Browser edit 🐈 ',
        inputType: 'insertText',
        bubbles: true,
      }),
    );
    await vi.waitFor(() => expect(f.data()).toBe('Browser edit 🐈 '));
    const support = page.getByRole('checkbox', {
      name: 'Screen reader support',
    });
    await expect.element(support).not.toBeChecked();
    await support.click();
    await expect.element(support).toBeChecked();
    await vi.waitFor(() =>
      expect(f.terminal.options.screenReaderMode).toBe(true),
    );
    await f.output('Accessible terminal output');
    await expect
      .element(page.getByRole('region', { name: 'Terminal output' }))
      .toHaveTextContent('Accessible terminal output');
    await support.click();
    await vi.waitFor(() =>
      expect(f.terminal.options.screenReaderMode).toBe(false),
    );
    expect(f.data()).toBe('Browser edit 🐈 ');
  });

  it('renders only the immutable plain-text title through waiting, restart and exit', async () => {
    const f = await setup({ ready: false });
    await expect
      .element(page.getByText('Terminal', { exact: true }))
      .toBeVisible();
    await f.reset();
    const title = '<img src=x onerror=alert(1)> 🐈';
    await f.state({ state: 'waiting', pid: null, started_at: null, title });
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    expect(root.querySelector('img')).toBeNull();
    await f.state({ title });
    await f.reset(2);
    await f.state({ title, pid: 43 });
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    await f.state({ title, state: 'exited', exit_code: 37 });
    await expect.element(page.getByText(title, { exact: true })).toBeVisible();
    expect(root.querySelector('img')).toBeNull();
  });

  it('renders ANSI 256 color, cursor movement, Unicode and alternate-screen restoration with process status', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(1_700_000_000_000);
    const f = await setup({ metrics: true });
    await f.output('normal shell\r\n\u001b[38;5;196mred🐈\u001b[0m');
    await expect
      .element(page.getByRole('region', { name: 'Terminal output' }))
      .toHaveTextContent('normal shell');
    expect(f.terminal.buffer.active.getLine(1)?.translateToString(true)).toBe(
      'red🐈',
    );
    expect(f.terminal.buffer.active.getLine(1)?.getCell(0)?.getFgColor()).toBe(
      196,
    );
    await f.output(
      '\u001b[?1049h\u001b[2J\u001b[Hfull-screen TUI\u001b[3;5Hcursor',
    );
    expect(f.terminal.buffer.active.type).toBe('alternate');
    expect(f.terminal.buffer.active.getLine(2)?.translateToString(true)).toBe(
      '    cursor',
    );
    expect(f.terminal.buffer.active.cursorX).toBe(10);
    await expect
      .element(page.getByRole('region', { name: 'Terminal output' }))
      .toHaveTextContent('full-screen TUI');
    await f.output('\u001b[?1049l');
    expect(f.terminal.buffer.active.type).toBe('normal');
    await expect
      .element(page.getByRole('region', { name: 'Terminal output' }))
      .toHaveTextContent('normal shell');
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('Elapsed 00:17:42');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('Elapsed 00:17:44');
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('RTT 52 ms');
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('PID 42');
    await f.state({
      state: 'exited',
      exit_code: 37,
      signal: 'SIGTERM',
      started_at: 1_700_000_000 - 1062,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('Elapsed 00:17:44');
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('Exit 37');
    await expect
      .element(page.getByLabelText('Process status'))
      .toHaveTextContent('SIGTERM');
    await expect
      .element(page.getByRole('button', { name: 'Open keyboard' }))
      .toBeDisabled();
    await expect
      .element(page.getByRole('button', { name: 'Restart', exact: true }))
      .toBeEnabled();
  });

  it('uses xterm keyboard input, exact shortcut bytes and one-shot/locked virtual modifiers', async () => {
    const f = await setup();
    await page.getByRole('button', { name: 'Open keyboard' }).click();
    await userEvent.keyboard('q');
    for (const name of ['Esc', 'Tab', 'Up', 'Down', 'Left', 'Right'])
      await page.getByRole('button', { name, exact: true }).click();
    await vi.waitFor(() =>
      expect(f.data()).toBe('q\u001b\t\u001b[A\u001b[B\u001b[D\u001b[C'),
    );
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await page.getByRole('button', { name: 'Open keyboard' }).click();
    await userEvent.keyboard('cc');
    await vi.waitFor(() => expect(f.data().endsWith('\u0003c')).toBe(true));
    await expect
      .element(page.getByRole('button', { name: 'Ctrl', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Lock Alt' }).click();
    await page.getByRole('button', { name: 'Open keyboard' }).click();
    await userEvent.keyboard('xy');
    await vi.waitFor(() =>
      expect(f.data().endsWith('\u001bx\u001by')).toBe(true),
    );
    await page.getByRole('button', { name: 'Lock Ctrl' }).click();
    await page.getByRole('button', { name: 'Up', exact: true }).click();
    await vi.waitFor(() => expect(f.data().endsWith('\u001b[1;7A')).toBe(true));
    await act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    for (const name of ['Lock Ctrl', 'Lock Alt'])
      await expect
        .element(page.getByRole('button', { name }))
        .toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Alt', exact: true }).click();
    await page.getByRole('button', { name: 'Alt', exact: true }).click();
    await expect
      .element(page.getByRole('button', { name: 'Alt', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
  });

  it('sends an explicit Unicode paste as ordered bounded raw frames without applying virtual modifiers', async () => {
    const f = await setup();
    const text = 'a'.repeat(32765) + '🐈\r\n' + 'z'.repeat(8000);
    await page.getByRole('button', { name: 'Lock Ctrl' }).click();
    await page.getByRole('textbox', { name: 'Paste text' }).fill(text);
    expect(f.inputs()).toHaveLength(0);
    await page.getByRole('button', { name: 'Send paste' }).click();
    // xterm prepares pasted line endings before emitting raw onData bytes.
    await vi.waitFor(() =>
      expect(f.data()).toBe(text.replaceAll('\r\n', '\r')),
    );
    expect(f.inputs().map((frame) => frame.payload.length)).toEqual([
      32766, 8004,
    ]);
    await expect
      .element(page.getByRole('textbox', { name: 'Paste text' }))
      .toHaveValue('');
    await expect
      .element(page.getByRole('button', { name: 'Send paste' }))
      .toBeDisabled();
  });

  it('preserves terminal replies without consuming modifiers intended for keyboard input', async () => {
    const f = await setup({ screenReader: false });
    await page.getByRole('button', { name: 'Lock Alt' }).click();
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await f.output('\u001b[6n');
    await vi.waitFor(() => expect(f.data()).toBe('\u001b[1;1R'));
    await expect
      .element(page.getByRole('button', { name: 'Ctrl', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Open keyboard' }).click();
    await userEvent.keyboard('x');
    await vi.waitFor(() => expect(f.data()).toBe('\u001b[1;1R\u001b\u0018'));
    await expect
      .element(page.getByRole('button', { name: 'Ctrl', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    f.terminal.textarea!.dispatchEvent(
      new InputEvent('input', {
        data: '🐈',
        inputType: 'insertText',
        bubbles: true,
      }),
    );
    await vi.waitFor(() =>
      expect(f.data()).toBe('\u001b[1;1R\u001b\u0018\u001b🐈'),
    );
    await f.output('\u001b[5n');
    await vi.waitFor(() => expect(f.data().endsWith('\u001b[0n')).toBe(true));
    expect(f.data()).not.toContain('\u001b\u001b[0n');
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    f.terminal.textarea!.dispatchEvent(
      new InputEvent('input', {
        data: 'composed text',
        inputType: 'insertText',
        isComposing: true,
        bubbles: true,
      }),
    );
    await vi.waitFor(() =>
      expect(f.data().endsWith('\u001b[0ncomposed text')).toBe(true),
    );
    await expect
      .element(page.getByRole('button', { name: 'Ctrl', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves bracketed-paste markers and retains rejected paste without partially enqueuing it', async () => {
    const f = await setup({ blocked: true });
    await f.output('\u001b[?2004h');
    await page.getByRole('button', { name: 'Lock Alt' }).click();
    await page
      .getByRole('textbox', { name: 'Paste text' })
      .fill('line one\nline two');
    await page.getByRole('button', { name: 'Send paste' }).click();
    expect(f.data()).toBe('\u001b[200~line one\rline two\u001b[201~');
    f.releases.shift()!();
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(0));
    await act(() => {
      f.client.input(new Uint8Array(TERMINAL_INPUT_BYTES).fill(65));
    });
    const before = f.inputs().length;
    await page
      .getByRole('textbox', { name: 'Paste text' })
      .fill('keep this text');
    await page.getByRole('button', { name: 'Send paste' }).click();
    await expect
      .element(page.getByRole('textbox', { name: 'Paste text' }))
      .toHaveValue('keep this text');
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Input paused: backpressure');
    expect(f.inputs()).toHaveLength(before);
    expect(f.client.inspect().queuedBytes).toBe(TERMINAL_INPUT_BYTES);
  });

  it('requires explicit confirmation, cancels without side effects and clears pending UI on restart', async () => {
    const f = await setup();
    await page.getByRole('button', { name: 'Terminate', exact: true }).click();
    await expect.element(page.getByRole('dialog')).toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Cancel', exact: true }))
      .toHaveFocus();
    expect(
      f.frames.some((frame) => frame.type === Message.PROCESS_CONTROL),
    ).toBe(false);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect
      .element(page.getByRole('dialog', { includeHidden: true }))
      .not.toBeVisible();
    await page.getByRole('button', { name: 'Interrupt', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm interrupt', exact: true })
      .click();
    await vi.waitFor(() =>
      expect(
        f.frames.filter((frame) => frame.type === Message.PROCESS_CONTROL),
      ).toHaveLength(1),
    );
    expect(
      decodeProcessControl(
        f.frames.find((frame) => frame.type === Message.PROCESS_CONTROL)!
          .payload,
      ),
    ).toEqual({ generation: 1, action: 'interrupt' });
    await f.state({ state: 'running' });
    await expect
      .element(page.getByRole('button', { name: 'Interrupt', exact: true }))
      .toBeDisabled();
    await f.state({ state: 'interrupting' });
    await f.state({ state: 'running' });
    await expect
      .element(page.getByRole('button', { name: 'Interrupt', exact: true }))
      .toBeEnabled();
    await page.getByRole('button', { name: 'Lock Ctrl' }).click();
    await page
      .getByRole('textbox', { name: 'Paste text' })
      .fill('old pending text');
    await page.getByRole('button', { name: 'Restart', exact: true }).click();
    await page
      .getByRole('button', { name: 'Confirm restart', exact: true })
      .click();
    await f.reset(2);
    await f.state();
    await expect
      .element(page.getByRole('textbox', { name: 'Paste text' }))
      .toHaveValue('');
    await expect
      .element(page.getByRole('button', { name: 'Lock Ctrl' }))
      .toHaveAttribute('aria-pressed', 'false');
    await expect
      .element(page.getByRole('button', { name: 'Open keyboard' }))
      .toBeDisabled();
    await act(() => f.client.pongSent());
    await expect
      .element(page.getByRole('button', { name: 'Open keyboard' }))
      .toBeEnabled();
    await page.getByRole('button', { name: 'Terminate', exact: true }).click();
    await userEvent.keyboard('{Escape}');
    await expect
      .element(page.getByRole('dialog', { includeHidden: true }))
      .not.toBeVisible();
  });

  it('hides readonly input and process controls, preserves output and rejects programmatic input', async () => {
    const f = await setup({ readonly: true });
    await f.output('read-only session');
    await expect
      .element(page.getByRole('region', { name: 'Terminal output' }))
      .toHaveTextContent('read-only session');
    for (const name of [
      'Open keyboard',
      'Send paste',
      'Restart',
      'Interrupt',
      'Terminate',
      'Esc',
    ])
      expect(
        page.getByRole('button', { name, exact: true }).query(),
      ).toBeNull();
    expect(
      page.getByRole('textbox', { name: 'Paste text' }).query(),
    ).toBeNull();
    f.terminal.input('unsafe');
    expect(f.frames).toEqual([]);
    expect(f.terminal.cols).toBe(80);
  });

  it('shows host denials, exact dropped bytes and backpressure with an explicit unsent-only resume', async () => {
    const f = await setup({ disabled: true, blocked: true });
    expect(
      page.getByRole('button', { name: 'Restart', exact: true }).query(),
    ).toBeNull();
    expect(
      page.getByRole('button', { name: 'Terminate', exact: true }).query(),
    ).toBeNull();
    await act(() => {
      f.client.input(new Uint8Array(40000).fill(65));
      f.client.reject(new ProtocolError('BACKPRESSURE'));
    });
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Input paused: backpressure');
    await expect
      .element(page.getByRole('button', { name: 'Esc', exact: true }))
      .toBeDisabled();
    f.releases.shift()!();
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(7234));
    expect(f.inputs()).toHaveLength(1);
    await page.getByRole('button', { name: 'Resume input' }).click();
    await vi.waitFor(() => expect(f.inputs()).toHaveLength(2));
    f.releases.shift()!();
    await vi.waitFor(() => expect(f.client.inspect().queuedBytes).toBe(0));
    await act(async () => {
      await f.client.receive(
        json(Message.OUTPUT_DROPPED, { generation: 1, dropped_bytes: 1234567 }),
      );
    });
    await expect
      .element(
        page.getByText('1,234,567 output bytes were dropped.', {
          exact: false,
        }),
      )
      .toBeVisible();
    await act(() => {
      f.client.reject(new ProtocolError('RESTART_DISABLED'));
    });
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Restart is disabled');
    await act(() => {
      f.client.input(new Uint8Array(TERMINAL_INPUT_BYTES + 1));
    });
    await expect
      .element(page.getByRole('button', { name: 'Resume input' }))
      .toBeVisible();
  });

  it('fits real viewport changes within protocol bounds and keeps timers/listeners local to the mount', async () => {
    const f = await setup();
    await vi.waitFor(() =>
      expect(f.frames.some((frame) => frame.type === Message.TERM_RESIZE)).toBe(
        true,
      ),
    );
    f.frames.length = 0;
    root.style.width = '340px';
    await vi.waitFor(() =>
      expect(f.frames.some((frame) => frame.type === Message.TERM_RESIZE)).toBe(
        true,
      ),
    );
    const frame = f.frames.find((frame) => frame.type === Message.TERM_RESIZE)!;
    const size = new DataView(frame.payload.buffer);
    expect(size.getUint16(0)).toBeGreaterThanOrEqual(20);
    expect(size.getUint16(0)).toBeLessThan(80);
    const proposed = vi
      .spyOn(FitAddon.prototype, 'proposeDimensions')
      .mockReturnValue({ cols: 1000, rows: 1000 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(f.terminal.cols).toBe(500));
    expect(f.terminal.rows).toBe(200);
    proposed.mockReturnValue(undefined);
    window.visualViewport!.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(f.terminal.cols).toBe(500);
    await act(() => render(null, root));
    expect(f.client.inspect().stopped).toBe(true);
    const count = f.frames.length;
    window.dispatchEvent(new Event('blur'));
    window.visualViewport!.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(f.frames).toHaveLength(count);
  });

  it('copies only on a user action, handles unavailable clipboard and ignores OSC clipboard sequences', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
      writeText,
    } as unknown as Clipboard);
    const f = await setup({ readonly: true });
    await f.output('copy this\r\n\u001b]52;c;cHJpdmF0ZQ==\u0007');
    expect(writeText).not.toHaveBeenCalled();
    await act(() => f.terminal.select(0, 0, 9));
    await page.getByRole('button', { name: 'Copy selection' }).click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith('copy this');
    await expect
      .element(page.getByText('Selection copied.', { exact: true }))
      .toBeVisible();
    writeText.mockRejectedValue(new Error('private clipboard details'));
    await page.getByRole('button', { name: 'Copy selection' }).click();
    await expect
      .element(
        page.getByText('Clipboard access is unavailable.', { exact: false }),
      )
      .toBeVisible();
    expect(root.textContent).not.toContain('private clipboard');
  });
});
