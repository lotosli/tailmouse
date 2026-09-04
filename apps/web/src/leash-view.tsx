import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { LeashClient, TERMINAL_INPUT_BYTES } from './leash.ts';
import type { ProcessAction } from './protocol/terminal.ts';
import type { Welcome } from './protocol/frame.ts';
import type { ConnectionMetrics } from './session.ts';

type Modifier = 'off' | 'once' | 'locked';
const keys = [
  ['Esc', '\u001b'],
  ['Tab', '\t'],
  ['Up', '\u001b[A'],
  ['Down', '\u001b[B'],
  ['Left', '\u001b[D'],
  ['Right', '\u001b[C'],
] as const;
const actions = ['interrupt', 'restart', 'terminate'] as const;
const actionNames: Record<ProcessAction, string> = {
  interrupt: 'Interrupt',
  restart: 'Restart',
  terminate: 'Terminate',
};
const confirmations: Record<ProcessAction, string> = {
  interrupt: 'Send an interrupt to the current process group?',
  restart:
    'Stop the current process and restart the original command? Pending input will be discarded.',
  terminate:
    'Terminate the current process and its descendants? Unsaved work may be lost.',
};

// Only the explicit virtual modifiers change an xterm input sequence. With no
// virtual modifier, onData is encoded as UTF-8 without newline normalization.
function modified(data: string, ctrl: boolean, alt: boolean): string {
  if (
    data.length === 3 &&
    data.startsWith('\u001b[') &&
    'ABCD'.includes(data[2]!) &&
    (ctrl || alt)
  )
    return `\u001b[1;${1 + (ctrl ? 4 : 0) + (alt ? 2 : 0)}${data.at(-1)!}`;
  if (ctrl && data.length === 1) {
    const code = data.toUpperCase().charCodeAt(0);
    if (data === '?' || data === '8') data = '\u007f';
    else if (data === ' ' || data === '2') data = '\u0000';
    else if (code >= 64 && code <= 95) data = String.fromCharCode(code & 31);
  }
  return alt ? `\u001b${data}` : data;
}

function elapsed(start: number | null | undefined, end: number): string {
  const seconds =
    start === null || start === undefined
      ? 0
      : Math.max(0, Math.floor(end / 1000 - start));
  return [
    Math.floor(seconds / 3600),
    Math.floor(seconds / 60) % 60,
    seconds % 60,
  ]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

export function LeashView({
  terminal: client,
  welcome,
  metrics,
}: {
  terminal: LeashClient;
  welcome: Welcome;
  metrics?: ConnectionMetrics | undefined;
}) {
  const [state, setState] = useState(() => client.inspect());
  const [now, setNow] = useState(Date.now);
  const [notice, setNotice] = useState('');
  const [paste, setPaste] = useState('');
  const [selected, setSelected] = useState(false);
  const [screenReader, setScreenReader] = useState(false);
  const [confirmation, setConfirmation] = useState<ProcessAction>();
  const [modifiers, setModifiers] = useState({
    ctrl: 'off' as Modifier,
    alt: 'off' as Modifier,
  });
  const modifierRef = useRef(modifiers);
  const screen = useRef<HTMLDivElement>(null);
  const display = useRef<Terminal>();
  const pasteAccepted = useRef<boolean>();
  const touchScroll = useRef<{
    identifier: number;
    y: number;
    offset: number;
  }>();
  const dialog = useRef<HTMLDialogElement>(null);
  const writable = welcome.capabilities.includes('terminal_input');
  const resizable = welcome.capabilities.includes('resize');

  function changeModifiers(next: typeof modifiers) {
    modifierRef.current = next;
    setModifiers(next);
  }
  function clearModifiers() {
    changeModifiers({ ctrl: 'off', alt: 'off' });
  }
  function beginScroll(event: TouchEvent) {
    touchScroll.current = undefined;
    if (
      event.touches.length !== 1 ||
      display.current?.buffer.active.type !== 'normal'
    )
      return;
    const touch = event.touches[0]!;
    touchScroll.current = {
      identifier: touch.identifier,
      y: touch.clientY,
      offset: 0,
    };
  }
  function moveScroll(event: TouchEvent) {
    const gesture = touchScroll.current,
      term = display.current;
    if (!gesture || !term) return;
    if (
      event.touches.length !== 1 ||
      term.buffer.active.type !== 'normal' ||
      event.touches[0]!.identifier !== gesture.identifier
    ) {
      touchScroll.current = undefined;
      return;
    }
    event.preventDefault();
    const y = event.touches[0]!.clientY;
    gesture.offset += gesture.y - y;
    gesture.y = y;
    const rowHeight = Math.max(
      1,
      (term.element?.clientHeight ?? 0) / term.rows,
    );
    const lines = Math.trunc(gesture.offset / rowHeight);
    if (lines !== 0) {
      term.scrollLines(lines);
      gesture.offset -= lines * rowHeight;
    }
  }
  function send(data: string, virtualModifiers = true) {
    const held = modifierRef.current;
    const bytes = new TextEncoder().encode(
      virtualModifiers
        ? modified(data, held.ctrl !== 'off', held.alt !== 'off')
        : data,
    );
    const accepted = client.input(bytes);
    bytes.fill(0);
    if (!accepted)
      setNotice(
        client.inspect().backpressure
          ? 'Input paused. This input was not queued.'
          : 'Input is unavailable for the current process.',
      );
    if (virtualModifiers)
      changeModifiers({
        ctrl: held.ctrl === 'locked' ? 'locked' : 'off',
        alt: held.alt === 'locked' ? 'locked' : 'off',
      });
    return accepted;
  }

  useEffect(() => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#0a100d',
        foreground: '#e4eee7',
        cursor: '#d8ff62',
      },
      disableStdin: !client.canInput(),
      cursorBlink: false,
      scrollback: 5000,
      // Never allow OSC 8 output to navigate the page or open a new origin.
      linkHandler: {
        activate: () =>
          setNotice(
            'Terminal links are not opened automatically. Copy a link to inspect it.',
          ),
      },
    });
    display.current = term;
    const fit = new FitAddon();
    const resources: Array<{ dispose(): void }> = [];
    let closed = false,
      frame: number | undefined;
    let lastSize = '';
    const fitScreen = () => {
      if (closed || !resizable) return;
      try {
        const size = fit.proposeDimensions();
        if (
          size === undefined ||
          !Number.isFinite(size.cols) ||
          !Number.isFinite(size.rows)
        )
          return;
        const cols = Math.max(20, Math.min(500, size.cols));
        const rows = Math.max(5, Math.min(200, size.rows));
        const signature = `${cols}x${rows}`;
        term.resize(cols, rows);
        if (signature !== lastSize && client.resize(cols, rows))
          lastSize = signature;
      } catch {
        client.failDisplay();
      }
    };
    const scheduleFit = () => {
      if (frame !== undefined || closed) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        fitScreen();
      });
    };
    let detach: (() => void) | undefined;
    let unobserve: (() => void) | undefined;
    let keyboardData: string | undefined;
    let textEvent: InputEvent | undefined;
    const clearTextEvent = () => {
      textEvent = undefined;
    };
    const markKeyboard = (data: string) => {
      keyboardData = data;
      queueMicrotask(() => {
        keyboardData = undefined;
      });
    };
    const textInput = (event: Event) => {
      if (
        event.target === term.textarea &&
        event instanceof InputEvent &&
        event.inputType === 'insertText' &&
        !event.isComposing &&
        event.data
      )
        textEvent = event;
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    const clear = () => {
      clearModifiers();
      touchScroll.current = undefined;
    };
    try {
      term.loadAddon(fit);
      term.open(screen.current!);
      term.textarea?.setAttribute('aria-label', 'Terminal input');
      term.textarea?.setAttribute('autocapitalize', 'off');
      term.textarea?.setAttribute('autocomplete', 'off');
      if (!writable) term.textarea?.setAttribute('tabindex', '-1');
      // onData also carries terminal replies and paste. Only a corresponding
      // user key/text event may consume or apply the virtual modifiers.
      resources.push(term.onKey(({ key }) => markKeyboard(key)));
      term.element?.addEventListener('input', textInput, true);
      term.element?.addEventListener('input', clearTextEvent);
      resources.push(
        term.onData((data) => {
          const pasting = pasteAccepted.current !== undefined;
          const keyboard =
            keyboardData === data ||
            (textEvent?.data === data && textEvent.eventPhase !== Event.NONE);
          keyboardData = undefined;
          clearTextEvent();
          const accepted = send(data, keyboard && !pasting);
          if (pasting) pasteAccepted.current = accepted;
        }),
      );
      resources.push(
        term.onBinary((data) => {
          const bytes = Uint8Array.from(
            data,
            (character) => character.charCodeAt(0) & 255,
          );
          if (!client.input(bytes))
            setNotice('Terminal input was not accepted.');
          bytes.fill(0);
        }),
      );
      resources.push(
        term.onSelectionChange(() => setSelected(term.hasSelection())),
      );
      detach = client.attachDisplay({
        reset: (reset) => {
          touchScroll.current = undefined;
          term.reset();
          term.resize(reset.cols, reset.rows);
          lastSize = '';
          clearModifiers();
          setConfirmation(undefined);
          setPaste('');
          setNotice('');
          fitScreen();
        },
        write: (data) =>
          new Promise<void>((resolve) => term.write(data, resolve)),
      });
      unobserve = client.observe(() => {
        const next = client.inspect();
        setState(next);
        term.options.disableStdin = !client.canInput();
        if (
          next.stopped ||
          (next.process !== undefined &&
            ['exited', 'failed', 'closing'].includes(next.process.state))
        ) {
          clearModifiers();
          setPaste('');
          setConfirmation(undefined);
        }
      });
      setState(client.inspect());
      resizeObserver.observe(screen.current!);
      window.addEventListener('blur', clear);
      window.visualViewport?.addEventListener('resize', scheduleFit);
      scheduleFit();
    } catch {
      client.failDisplay();
    }
    return () => {
      closed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener('blur', clear);
      window.visualViewport?.removeEventListener('resize', scheduleFit);
      unobserve?.();
      detach?.();
      term.element?.removeEventListener('input', textInput, true);
      term.element?.removeEventListener('input', clearTextEvent);
      clearTextEvent();
      for (const resource of resources) resource.dispose();
      term.dispose();
      display.current = undefined;
      touchScroll.current = undefined;
      modifierRef.current = { ctrl: 'off', alt: 'off' };
    };
    // Each connection owns one xterm instance. Event handlers read current
    // modifiers through the ref; protocol state remains in the client.
  }, [client, writable, resizable]);

  useEffect(() => {
    if (display.current)
      display.current.options.screenReaderMode = screenReader;
  }, [client, screenReader]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (confirmation !== undefined) dialog.current?.showModal();
    else dialog.current?.close();
  }, [confirmation]);

  async function copySelection() {
    const text = display.current?.getSelection();
    if (!text) {
      setNotice('Select terminal text before copying.');
      return;
    }
    try {
      if (navigator.clipboard?.writeText === undefined)
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setNotice('Selection copied.');
    } catch {
      setNotice(
        'Clipboard access is unavailable. Use your browser’s Copy action on the selection.',
      );
    }
  }
  function submitPaste() {
    // xterm owns line-ending and bracketed-paste semantics. Its synchronous
    // onData callback still enters the same atomic bounded input queue.
    pasteAccepted.current = false;
    try {
      display.current?.paste(paste);
      if (pasteAccepted.current) {
        setPaste('');
        setNotice('Paste queued.');
        display.current?.focus();
      }
    } catch {
      client.failDisplay();
    } finally {
      pasteAccepted.current = undefined;
    }
  }

  const available = client.canInput();
  return (
    <section class="leash" aria-label="Leash terminal">
      <header class="terminal-status" aria-label="Process status">
        <strong>{state.process?.title ?? 'Terminal'}</strong>
        <span role="status">{state.process?.state ?? 'Synchronizing'}</span>
        <span>
          Elapsed{' '}
          <time>
            {elapsed(state.process?.started_at, state.endedAt ?? now)}
          </time>
        </span>
        <span>
          {metrics !== undefined && metrics.samples > 0
            ? `RTT ${metrics.rttMs.toFixed(0)} ms`
            : 'RTT measuring'}
        </span>
        <span>{state.stopped ? 'Disconnected' : 'Connected'}</span>
        {state.process?.pid !== null && state.process?.pid !== undefined ? (
          <span>PID {state.process.pid}</span>
        ) : null}
        {state.process?.exit_code !== null &&
        state.process?.exit_code !== undefined ? (
          <span>Exit {state.process.exit_code}</span>
        ) : null}
        {state.process?.signal ? <span>{state.process.signal}</span> : null}
      </header>
      <div
        class="terminal-screen"
        ref={screen}
        role="region"
        aria-label="Terminal output"
        onTouchStart={beginScroll}
        onTouchMove={moveScroll}
        onTouchEnd={() => {
          touchScroll.current = undefined;
        }}
        onTouchCancel={() => {
          touchScroll.current = undefined;
        }}
      />
      <div class="terminal-tools">
        <label>
          <input
            type="checkbox"
            checked={screenReader}
            onChange={(event) => setScreenReader(event.currentTarget.checked)}
          />{' '}
          Screen reader support
        </label>
        <button
          type="button"
          disabled={!selected}
          onClick={() => {
            void copySelection();
          }}
        >
          Copy selection
        </button>
        {writable ? (
          <button
            type="button"
            disabled={!available}
            onClick={() => display.current?.focus()}
          >
            Open keyboard
          </button>
        ) : (
          <span>Read only</span>
        )}
      </div>
      {state.droppedBytes > 0 ? (
        <p role="status">
          {state.droppedBytes.toLocaleString('en-US')} output bytes were
          dropped. Earlier terminal content may be incomplete.
        </p>
      ) : null}
      {state.synchronizing ? (
        <p role="status">Synchronizing terminal input…</p>
      ) : null}
      {state.backpressure ? (
        <div class="terminal-warning" role="alert">
          <p>
            Input paused: backpressure.{' '}
            {state.queuedBytes.toLocaleString('en-US')} unsent or in-flight
            bytes. Already sent input will not be retried.
          </p>
          <button
            type="button"
            onClick={() => {
              client.resumeInput();
              setNotice(
                'Resumed unsent input. Check the terminal before pasting again.',
              );
            }}
          >
            Resume input
          </button>
        </div>
      ) : state.error !== undefined ? (
        <p role="alert">{state.error.message}</p>
      ) : null}
      {writable ? (
        <>
          <div
            class="terminal-keys"
            role="group"
            aria-label="Terminal shortcut keys"
          >
            {keys.map(([name, sequence]) => (
              <button
                type="button"
                key={name}
                disabled={!available}
                onClick={() => {
                  send(sequence);
                  display.current?.focus();
                }}
              >
                {name}
              </button>
            ))}
            {(['ctrl', 'alt'] as const).map((name) => (
              <div class="terminal-modifier" key={name}>
                <button
                  type="button"
                  disabled={!available}
                  aria-pressed={modifiers[name] !== 'off'}
                  onClick={() =>
                    changeModifiers({
                      ...modifierRef.current,
                      [name]:
                        modifierRef.current[name] === 'off' ? 'once' : 'off',
                    })
                  }
                >
                  {name === 'ctrl' ? 'Ctrl' : 'Alt'}
                </button>
                <button
                  type="button"
                  disabled={!available}
                  aria-label={`Lock ${name === 'ctrl' ? 'Ctrl' : 'Alt'}`}
                  aria-pressed={modifiers[name] === 'locked'}
                  onClick={() =>
                    changeModifiers({
                      ...modifierRef.current,
                      [name]:
                        modifierRef.current[name] === 'locked'
                          ? 'off'
                          : 'locked',
                    })
                  }
                >
                  Lock
                </button>
              </div>
            ))}
          </div>
          <form
            class="terminal-paste"
            onSubmit={(event) => {
              event.preventDefault();
              submitPaste();
            }}
          >
            <label for="terminal-paste">Paste text</label>
            <textarea
              id="terminal-paste"
              value={paste}
              disabled={!available}
              maxLength={TERMINAL_INPUT_BYTES}
              autoCapitalize="off"
              autoComplete="off"
              spellcheck={false}
              onInput={(event) => setPaste(event.currentTarget.value)}
            />
            <button type="submit" disabled={!available || paste.length === 0}>
              Send paste
            </button>
          </form>
          <div
            class="terminal-actions"
            role="group"
            aria-label="Process controls"
          >
            {actions
              .filter((action) => welcome.capabilities.includes(action))
              .map((action) => (
                <button
                  type="button"
                  key={action}
                  disabled={!client.canControl(action)}
                  onClick={() => {
                    clearModifiers();
                    setConfirmation(action);
                  }}
                >
                  {actionNames[action]}
                </button>
              ))}
          </div>
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <dialog
        ref={dialog}
        aria-labelledby="process-confirmation-title"
        onCancel={() => setConfirmation(undefined)}
        onClose={() => setConfirmation(undefined)}
      >
        <h2 id="process-confirmation-title">
          {confirmation === undefined
            ? 'Process control'
            : `Confirm ${actionNames[confirmation].toLowerCase()}`}
        </h2>
        <p>{confirmation === undefined ? '' : confirmations[confirmation]}</p>
        <div class="terminal-actions">
          <button
            type="button"
            autoFocus
            onClick={() => setConfirmation(undefined)}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={
              confirmation === undefined || !client.canControl(confirmation)
            }
            onClick={() => {
              if (confirmation !== undefined && !client.control(confirmation))
                setNotice('That process action is no longer available.');
              setConfirmation(undefined);
            }}
          >
            Confirm{' '}
            {confirmation === undefined
              ? ''
              : actionNames[confirmation].toLowerCase()}
          </button>
        </div>
      </dialog>
    </section>
  );
}
