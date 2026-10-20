import { useEffect, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  ResourceSession,
  frameObject,
  type SessionView,
  type SharedResource,
  type UploadReceipt,
} from './session.ts';
import type { Recovery } from './invitation.ts';
import { bindPreview, allowedPreviewPath } from './preview.ts';
import { CHUNK, ResourceError, type ResourceWire } from './wire.ts';
import { endConsequences, Feedback } from './help.tsx';
import { formatBytes } from './transfer-ui.ts';
import { FilesPanel, TextPanel } from './transfer-panels.tsx';
import './workspace.css';
import './landing.css';

export function ResourceApp({
  recovery,
  initialError = '',
}: {
  recovery: Recovery | null;
  initialError?: string;
}) {
  const [session] = useState(() =>
    recovery === null ? null : new ResourceSession(recovery, sessionStorage),
  );
  const [view, setView] = useState<SessionView | null>(session?.view ?? null);
  const [tab, setTab] = useState<SharedResource['id']>('cli');
  const [paste, setPaste] = useState('');
  const [split, setSplit] = useState(50);
  const [filesOpen, setFilesOpen] = useState(true);
  const resourceKinds = useRef<Pick<SharedResource, 'id'>[]>([]);
  if (view?.manifest !== null && view?.manifest !== undefined)
    resourceKinds.current = view.manifest.resources.map(({ id }) => ({ id }));
  useEffect(() => {
    if (session === null) return;
    const unsubscribe = session.subscribe(setView);
    void session.connect();
    const leave = (): void => {
      session.suspend();
    };
    const resume = (event: PageTransitionEvent): void => {
      if (event.persisted) session.resume();
    };
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', leave);
    return () => {
      unsubscribe();
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('pagehide', leave);
      session.suspend();
    };
  }, [session]);
  useEffect(() => {
    const resources = view?.manifest?.resources;
    if (resources !== undefined && !resources.some((r) => r.id === tab))
      setTab(resources[0]!.id);
  }, [view?.manifest, tab]);
  if (session === null || view === null)
    return (
      <main class="resource-shell">
        <h1>TailMouse</h1>
        <p role="alert">
          {initialError ||
            'Open the sharing link from the host to join this workspace.'}
        </p>
        <p>
          Ask the host for a fresh sharing link and open the complete link in
          this browser. The host must keep TailMouse running.
        </p>
        <div class="workspace-links">
          <a href="/">TailMouse home</a> ·{' '}
          <a href="/#guide">Getting started guide</a>
        </div>
        <Feedback phase="invitation" />
      </main>
    );
  const resources = view.manifest?.resources ?? [];
  return (
    <main class="resource-shell">
      <header class="workspace-header">
        <div>
          <span class="workspace-brand">TailMouse</span>
          <h1>{view.manifest?.title || 'Live workspace'}</h1>
        </div>
        <span class={`connection-state state-${view.status}`} role="status">
          {view.message}
        </span>
        <button
          class="secondary"
          disabled={view.status === 'closed'}
          onClick={() => void session.leave()}
        >
          Leave workspace
        </button>
      </header>
      {view.runtimeProgress && (
        <label class="runtime-progress">
          Preparing secure connection ·{' '}
          {formatBytes(view.runtimeProgress.received)} /{' '}
          {formatBytes(view.runtimeProgress.total)}
          <progress
            max={view.runtimeProgress.total}
            value={view.runtimeProgress.received}
          />
        </label>
      )}
      {view.manifest?.testSingleOrigin === true &&
        resources.some((r) => r.id === 'web') && (
          <p class="workspace-notice" role="status">
            Single-origin test mode. Open only applications you trust.
          </p>
        )}
      {view.expiring && view.status !== 'closed' && (
        <p role="status" class="workspace-notice">
          This session expires in less than five minutes.{' '}
          {endConsequences(resourceKinds.current)} Save your work now;
          reconnecting will not extend the session.
        </p>
      )}
      {view.status === 'waiting' && (
        <p class="workspace-notice">
          The host needs to approve your visit in their terminal. Keep this page
          open while you contact them.
        </p>
      )}
      {view.status === 'reconnecting' && (
        <p class="workspace-notice">
          Trying to restore access for up to 60 seconds. Unsent terminal input
          and requests are discarded; unfinished files must be sent again.
        </p>
      )}
      {view.status === 'closed' && (
        <div class="workspace-notice">
          <p>{endConsequences(resourceKinds.current)}</p>
          <p>
            To join again, ask the host for a new link. For a version error, ask
            them to use a matching build.
          </p>
          <a href="/#get-started">Version and setup help</a> ·{' '}
          <a href="/">TailMouse home</a>
        </div>
      )}
      {view.status === 'disconnected' && (
        <div class="workspace-notice">
          <p>
            Check your connection and ask the host to keep TailMouse running. If
            the visitor limit is reached, another visitor must leave or the host
            must start a session with more slots.
          </p>
          <button
            onClick={() => {
              void session.connect();
            }}
          >
            Reconnect
          </button>
        </div>
      )}
      <nav class="resource-tabs" aria-label="Workspace resources">
        {resources.map((resource) => (
          <button
            key={resource.id}
            aria-pressed={tab === resource.id}
            onClick={() => setTab(resource.id)}
          >
            {resource.id === 'cli'
              ? 'Terminal'
              : resource.id === 'web'
                ? 'Preview'
                : resource.id === 'text'
                  ? 'Text'
                  : resource.id === 'files'
                    ? 'Downloads'
                    : 'Files'}
          </button>
        ))}
      </nav>
      {resources.some((r) => r.id === 'cli') &&
        resources.some((r) => r.id === 'web') && (
          <label class="split-control">
            Terminal / preview width
            <input
              type="range"
              min="25"
              max="75"
              value={split}
              onInput={(event) => setSplit(Number(event.currentTarget.value))}
            />
          </label>
        )}
      {resources.some((r) => r.id === 'receive') && resources.length > 1 && (
        <button
          class="files-toggle secondary"
          aria-expanded={filesOpen}
          onClick={() => setFilesOpen(!filesOpen)}
        >
          {filesOpen ? 'Collapse files' : 'Show files'}
        </button>
      )}
      <div
        class="resource-grid"
        data-active-tab={tab}
        style={{ '--terminal-width': `${split}%` }}
      >
        {resources.some((r) => r.id === 'files') && (
          <section class="resource-panel download-panel" data-resource="files">
            <FilesPanel session={session} enabled={view.status === 'active'} />
          </section>
        )}
        {resources.some((r) => r.id === 'text') && (
          <section class="resource-panel text-panel" data-resource="text">
            <TextPanel session={session} enabled={view.status === 'active'} />
          </section>
        )}
        {resources.some((r) => r.id === 'cli') && (
          <section class="resource-panel terminal-panel" data-resource="cli">
            <TerminalPanel
              session={session}
              status={view.status}
              controller={view.controller}
              readOnly={
                resources.find((r) => r.id === 'cli')?.readOnly === true
              }
              paste={paste}
              setPaste={setPaste}
            />
          </section>
        )}
        {resources.find((r) => r.id === 'web') !== undefined && (
          <section class="resource-panel preview-panel" data-resource="web">
            <PreviewPanel
              session={session}
              manifest={view.manifest!}
              resource={resources.find((r) => r.id === 'web')!}
            />
          </section>
        )}
        {resources.some((r) => r.id === 'receive') && (
          <section
            class={`resource-panel receive-panel ${filesOpen ? '' : 'files-collapsed'}`}
            data-resource="receive"
          >
            <ReceivePanel
              session={session}
              enabled={view.status === 'active'}
              insert={
                resources.some((r) => r.id === 'cli') && view.controller
                  ? (path) => {
                      setPaste(path);
                      setTab('cli');
                    }
                  : undefined
              }
            />
          </section>
        )}
      </div>
      <footer class="workspace-footer">
        <p>
          Leaving disconnects you and stops unfinished uploads. It does not end
          the host's session or delete confirmed files.
        </p>
        <details>
          <summary>What happens when sharing ends?</summary>
          <p>{endConsequences(resourceKinds.current)}</p>
        </details>
        <Feedback phase={view.status} />
        <p>
          Powered by Tailcat · No account · No client installation for guests.
        </p>
      </footer>
    </main>
  );
}
function TerminalPanel({
  session,
  status,
  controller,
  readOnly,
  paste,
  setPaste,
}: {
  session: ResourceSession;
  status: SessionView['status'];
  controller: boolean;
  readOnly: boolean;
  paste: string;
  setPaste: (value: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const sender = useRef<(value: string) => void>(() => undefined);
  const sizing = useRef<() => void>(() => undefined);
  const canFit = useRef(false);
  const ctrl = useRef(false);
  const [controlKey, setControlKey] = useState(false);
  const interruption = useRef<() => void>(() => undefined);
  const [notice, setNotice] = useState('Waiting for terminal…');
  const [running, setRunning] = useState(false);
  const [seat, setSeat] = useState(false);
  const [reader, setReader] = useState(false);
  useEffect(() => {
    if (mount.current === null) return;
    const display = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 4000,
      convertEol: false,
      allowProposedApi: false,
      theme: { background: '#10140f', foreground: '#f6f3e9' },
      linkHandler: {
        activate: (_event, uri) => {
          if (window.confirm('Open this terminal link in a new tab?'))
            window.open(uri, '_blank', 'noopener,noreferrer');
        },
      },
    });
    const fit = new FitAddon();
    display.loadAddon(fit);
    display.open(mount.current);
    display.parser.registerOscHandler(52, () => true);
    terminal.current = display;
    const fitScreen = (): void => {
      if (mount.current === null || mount.current.clientWidth === 0) return;
      const size = fit.proposeDimensions();
      if (
        size !== undefined &&
        Number.isFinite(size.cols) &&
        Number.isFinite(size.rows)
      )
        display.resize(
          Math.max(20, Math.min(500, size.cols)),
          Math.max(5, Math.min(200, size.rows)),
        );
    };
    sizing.current = fitScreen;
    const observer = new ResizeObserver(() => {
      if (canFit.current) fitScreen();
    });
    observer.observe(mount.current);
    fitScreen();
    const element = mount.current;
    const preparePaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData('text/plain');
      if (text === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (new TextEncoder().encode(text).length > 256 << 10) {
        setNotice('Paste exceeds the 256 KiB input budget.');
        return;
      }
      setPaste(text);
      setNotice(
        'Pasted text is ready in the input field. Review it before sending.',
      );
    };
    let touch: { id: number; y: number; remainder: number } | undefined;
    const begin = (event: TouchEvent): void => {
      const first = event.touches[0];
      touch =
        event.touches.length === 1 &&
        first !== undefined &&
        display.buffer.active.type === 'normal'
          ? { id: first.identifier, y: first.clientY, remainder: 0 }
          : undefined;
    };
    const move = (event: TouchEvent): void => {
      const first = event.touches[0];
      if (touch === undefined) return;
      if (
        event.touches.length !== 1 ||
        first?.identifier !== touch.id ||
        display.buffer.active.type !== 'normal'
      ) {
        touch = undefined;
        return;
      }
      event.preventDefault();
      touch.remainder += touch.y - first.clientY;
      touch.y = first.clientY;
      const height = Math.max(1, element.clientHeight / display.rows);
      const lines = Math.trunc(touch.remainder / height);
      display.scrollLines(lines);
      touch.remainder -= lines * height;
    };
    const end = (): void => {
      touch = undefined;
    };
    element.addEventListener('paste', preparePaste, true);
    element.addEventListener('touchstart', begin, { passive: true });
    element.addEventListener('touchmove', move, { passive: false });
    element.addEventListener('touchend', end);
    element.addEventListener('touchcancel', end);
    return () => {
      element.removeEventListener('paste', preparePaste, true);
      element.removeEventListener('touchstart', begin);
      element.removeEventListener('touchmove', move);
      element.removeEventListener('touchend', end);
      element.removeEventListener('touchcancel', end);
      observer.disconnect();
      display.dispose();
      terminal.current = undefined;
    };
  }, []);
  useEffect(() => {
    if (terminal.current !== undefined)
      terminal.current.options.screenReaderMode = reader;
  }, [reader]);
  useEffect(() => {
    if (status !== 'active' || terminal.current === undefined) return;
    const display = terminal.current;
    let wire: ResourceWire | undefined;
    let canceled = false;
    let writable = false;
    let historyLost = false;
    let pumping = false;
    let queued = 0;
    const input: Uint8Array[] = [];
    let resize: { cols: number; rows: number } | undefined;
    let interrupt = false;
    const pump = async (): Promise<void> => {
      if (pumping || wire === undefined || !writable) return;
      pumping = true;
      try {
        while (!canceled && writable) {
          if (input.length > 0) {
            const bytes = input.shift()!;
            queued -= bytes.length;
            await wire.write(2, bytes);
          } else if (interrupt) {
            interrupt = false;
            await wire.json({ type: 'interrupt' });
          } else if (resize !== undefined) {
            const size = resize;
            resize = undefined;
            await wire.json({ type: 'resize', ...size });
          } else break;
        }
      } catch {
        setNotice('Input could not be delivered. It will not be replayed.');
        input.length = 0;
        queued = 0;
        writable = false;
      } finally {
        pumping = false;
      }
    };
    sender.current = (value) => {
      if (!writable || canceled) return;
      const bytes = new TextEncoder().encode(value);
      if (queued + bytes.length > 256 << 10) {
        setNotice('Input queue is full. Wait before typing or pasting more.');
        return;
      }
      for (let i = 0; i < bytes.length; i += CHUNK)
        input.push(bytes.slice(i, i + CHUNK));
      queued += bytes.length;
      void pump();
    };
    interruption.current = () => {
      interrupt = true;
      void pump();
    };
    const data = display.onData((value) => {
      if (ctrl.current && value.length === 1) {
        const code = value.toUpperCase().charCodeAt(0);
        if (code >= 64 && code <= 95) value = String.fromCharCode(code - 64);
        ctrl.current = false;
        setControlKey(false);
      }
      sender.current(value);
    });
    const size = display.onResize((value) => {
      if (
        value.cols >= 20 &&
        value.cols <= 500 &&
        value.rows >= 5 &&
        value.rows <= 200
      ) {
        resize = value;
        void pump();
      }
    });
    void (async () => {
      try {
        wire = await session.open('terminal', 'cli');
        if (canceled) return;
        display.reset();
        while (!canceled) {
          const frame = await wire.read();
          if (frame.kind === 2) {
            await new Promise<void>((resolve) =>
              display.write(frame.data, resolve),
            );
            continue;
          }
          if (frame.kind !== 1) throw new Error('Unexpected terminal data.');
          const message = frameObject(frame.data);
          if (
            !['terminal', 'terminal.state'].includes(String(message.type)) ||
            typeof message.running !== 'boolean' ||
            typeof message.controller !== 'boolean'
          )
            throw new Error('Invalid terminal state.');
          const wasWritable = writable;
          writable = message.controller && message.running;
          canFit.current = writable;
          if (
            !writable &&
            Number.isInteger(message.cols) &&
            Number.isInteger(message.rows) &&
            Number(message.cols) >= 20 &&
            Number(message.cols) <= 500 &&
            Number(message.rows) >= 5 &&
            Number(message.rows) <= 200
          )
            display.resize(Number(message.cols), Number(message.rows));
          else if (writable && !wasWritable) sizing.current();
          setSeat(writable);
          setRunning(message.running);
          historyLost ||= message.historyLost === true;
          setNotice(
            message.running
              ? historyLost
                ? 'Earlier output exceeded the recovery budget. An application redraw was requested; use its redraw shortcut if needed.'
                : 'Connected to the same running process.'
              : `Process exited (${typeof message.exitCode === 'number' ? message.exitCode : 'unknown'}).`,
          );
          if (!writable) {
            input.length = 0;
            queued = 0;
            resize = undefined;
          } else {
            resize = { cols: display.cols, rows: display.rows };
            void pump();
          }
        }
      } catch {
        if (!canceled)
          setNotice('Terminal disconnected. Unsent input was discarded.');
      } finally {
        if (wire !== undefined)
          await session.release(wire).catch(() => undefined);
      }
    })();
    return () => {
      canceled = true;
      canFit.current = false;
      input.length = 0;
      queued = 0;
      sender.current = () => undefined;
      interruption.current = () => undefined;
      data.dispose();
      size.dispose();
      if (wire !== undefined) void session.release(wire).catch(() => undefined);
    };
  }, [session, status]);
  return (
    <>
      <div class="panel-heading">
        <h2>Terminal</h2>
        <span>{seat && controller ? 'You control input' : 'Read only'}</span>
      </div>
      <p class="panel-status" role="status">
        {notice}
      </p>
      <p class="panel-status">
        {readOnly
          ? 'The host shared a read-only terminal. Ask them to start a session with input enabled if you need to type.'
          : seat && controller
            ? 'Your input runs with the host’s permissions. Review pasted text before sending.'
            : 'You can watch output. Ask the host to give you terminal control; only one visitor can type at a time.'}
      </p>
      <div
        class="workspace-terminal"
        ref={mount}
        aria-label="Shared terminal"
      />
      <div class="terminal-shortcuts" aria-label="Terminal keys">
        <button
          disabled={!seat || !running || !controller}
          aria-pressed={controlKey}
          onClick={() => {
            ctrl.current = !ctrl.current;
            setControlKey(ctrl.current);
            terminal.current?.focus();
          }}
        >
          Ctrl
        </button>
        {[
          ['Esc', '\x1b'],
          ['Tab', '\t'],
          ['↑', '\x1b[A'],
          ['↓', '\x1b[B'],
          ['←', '\x1b[D'],
          ['→', '\x1b[C'],
          ['Ctrl+C', '\x03'],
          ['Ctrl+L', '\x0c'],
        ].map(([label, value]) => (
          <button
            key={label}
            disabled={!seat || !running || !controller}
            onClick={() => {
              sender.current(value!);
              terminal.current?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <label class="reader-option">
        <input
          type="checkbox"
          checked={reader}
          onChange={(e) => setReader(e.currentTarget.checked)}
        />{' '}
        Screen reader mode
      </label>
      <label class="paste-field">
        Prepare terminal input
        <textarea
          value={paste}
          onInput={(e) => setPaste(e.currentTarget.value)}
          placeholder="Pasted paths and text appear here before you send them."
        />
      </label>
      <div class="panel-actions">
        <button
          disabled={!seat || !running || !controller || paste === ''}
          onClick={() => {
            sender.current(paste);
            setPaste('');
          }}
        >
          Send text without Enter
        </button>
        <button
          class="secondary"
          disabled={!seat || !running || !controller}
          onClick={() => {
            if (window.confirm('Interrupt the running foreground command?'))
              interruption.current();
          }}
        >
          Interrupt
        </button>
      </div>
    </>
  );
}
function PreviewPanel({
  session,
  manifest,
  resource,
}: {
  session: ResourceSession;
  manifest: NonNullable<SessionView['manifest']>;
  resource: SharedResource;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState('Starting browser preview…');
  const [path, setPath] = useState(resource.initialPath ?? '/');
  const navigation = useRef<ReturnType<typeof bindPreview>>();
  useEffect(() => {
    if (frame.current === null) return;
    const binding = bindPreview(
      frame.current,
      manifest.contentOrigin,
      session,
      path,
      setStatus,
    );
    navigation.current = binding;
    return () => {
      binding.dispose();
      navigation.current = undefined;
    };
  }, [session, manifest.contentOrigin]);
  return (
    <>
      <div class="panel-heading">
        <h2>Web preview</h2>
        <span>{resource.origin}</span>
      </div>
      <form
        class="preview-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          if (allowedPreviewPath(path))
            navigation.current?.navigate('path', path);
          else
            setStatus('Use a path within the shared origin, beginning with /.');
        }}
      >
        <label>
          Path
          <input
            value={path}
            onInput={(e) => setPath(e.currentTarget.value)}
            aria-label="Preview path"
          />
        </label>
        <button type="submit">Go</button>
        <button
          type="button"
          onClick={() => navigation.current?.navigate('back')}
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => navigation.current?.navigate('forward')}
        >
          Forward
        </button>
        <button
          type="button"
          onClick={() => navigation.current?.navigate('reload')}
        >
          Refresh
        </button>
        {resource.state === 'UNAVAILABLE' && (
          <button
            type="button"
            onClick={() => {
              void session
                .reprobe()
                .catch(() =>
                  setStatus(
                    'Preview check failed. Ask the host to check their web server, then retry.',
                  ),
                );
            }}
          >
            Check preview again
          </button>
        )}
      </form>
      <p class="panel-status" role="status">
        {status}. The whole configured origin is shared.
      </p>
      {resource.state === 'UNAVAILABLE' && (
        <p class="workspace-notice">
          Only the web preview is unavailable. Ask the host to start or check
          the configured web server, then choose “Check preview again”. Other
          shared resources can still be used.
        </p>
      )}
      <iframe
        ref={frame}
        title="Shared web preview"
        class="workspace-preview"
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        referrerPolicy="no-referrer"
        src={`${manifest.contentOrigin}${manifest.contentPath ?? '/.tailmouse/bridge.html'}?parent=${encodeURIComponent(location.origin)}`}
      />
    </>
  );
}
interface UploadItem {
  id: number;
  file: File;
  status: string;
  received: number;
  abort: AbortController;
  receipt?: UploadReceipt;
  error?: string;
}
function ReceivePanel({
  session,
  enabled,
  insert,
}: {
  session: ResourceSession;
  enabled: boolean;
  insert: ((path: string) => void) | undefined;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const counter = useRef(0);
  const queue = useRef<UploadItem[]>([]);
  const working = useRef(0);
  const active = useRef(new Set<UploadItem>());
  const alive = useRef(true);
  const enabledNow = useRef(enabled);
  enabledNow.current = enabled;
  const continueQueue = useRef<() => void>(() => undefined);
  const [queueNotice, setQueueNotice] = useState('');
  const limits = session.view.manifest?.resources.find(
    (r) => r.id === 'receive',
  );
  const update = (item: UploadItem): void => {
    if (alive.current)
      setItems((old) =>
        old.map((value) => (value.id === item.id ? { ...item } : value)),
      );
  };
  const pump = (): void => {
    while (
      working.current < 2 &&
      queue.current.length > 0 &&
      enabledNow.current
    ) {
      const item = queue.current.shift()!;
      if (item.abort.signal.aborted) continue;
      working.current++;
      active.current.add(item);
      void session
        .upload(item.file, item.abort.signal, (status, received) => {
          item.status = status;
          item.received = received;
          update(item);
        })
        .then((receipt) => {
          item.receipt = receipt;
          item.status = 'completed';
          update(item);
        })
        .catch((error: unknown) => {
          item.status = item.abort.signal.aborted ? 'canceled' : 'failed';
          item.error = item.abort.signal.aborted
            ? 'Sending stopped. Check with the host if it was already being verified.'
            : error instanceof ResourceError && error.code === 'UPLOAD_LIMIT'
              ? 'The host’s file or traffic limit was reached. Ask the host to check the limits before sending again.'
              : error instanceof ResourceError &&
                  error.code === 'UPLOAD_STORAGE'
                ? 'The host could not save this file. Ask them to check available space and folder permissions.'
                : 'The host has not confirmed receipt. Check the host folder before retrying to avoid sending a second copy.';
          update(item);
        })
        .finally(() => {
          working.current--;
          active.current.delete(item);
          continueQueue.current();
        });
    }
  };
  continueQueue.current = pump;
  useEffect(() => {
    if (enabled) continueQueue.current();
  }, [enabled]);
  const add = (files: FileList | null): void => {
    if (files === null || !enabled) return;
    const capacity = Math.max(
      0,
      Math.min(100, limits?.maxFiles ?? 100) - counter.current,
    );
    if (files.length > capacity)
      setQueueNotice(
        'The local queue has reached the session file-attempt limit.',
      );
    const additions = [...files].slice(0, capacity).map((file) => ({
      id: ++counter.current,
      file,
      status: 'queued',
      received: 0,
      abort: new AbortController(),
    }));
    queue.current.push(...additions);
    setItems((old) => [...old, ...additions]);
    pump();
  };
  useEffect(
    () => () => {
      alive.current = false;
      for (const item of [...active.current, ...queue.current])
        item.abort.abort();
      queue.current = [];
    },
    [],
  );
  return (
    <>
      <div class="panel-heading">
        <h2>Send files to host</h2>
        <span>From your device</span>
      </div>
      <label
        class="upload-drop"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          add(event.dataTransfer?.files ?? null);
        }}
      >
        Drop files here or choose files
        <input
          type="file"
          multiple
          disabled={!enabled}
          onChange={(event) => {
            add(event.currentTarget.files);
            event.currentTarget.value = '';
          }}
        />
      </label>
      <p class="panel-status">
        Files go to the host's chosen folder. You cannot browse existing files.
        Per-file limit: {formatBytes(limits?.maxFile ?? 256 * 1024 * 1024)};
        session traffic: {formatBytes(limits?.maxTotal ?? 1024 * 1024 * 1024)};
        file attempts: {limits?.maxFiles ?? 100}.
      </p>
      {queueNotice && <p role="alert">{queueNotice}</p>}
      <p class="panel-status">
        Wait for “Received by host” before treating a file as saved. Files never
        run automatically. Failed or canceled transfers use traffic allowance,
        and unfinished files must be sent again. The host enforces the remaining
        shared allowance; this browser does not have a live total for other
        visitors.
      </p>
      <ol class="upload-list">
        {items.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.file.name}</strong>
              <span role="status">
                {(
                  {
                    queued: 'Waiting to send',
                    uploading: 'Sending',
                    verifying: 'Verifying with host',
                    completed: 'Received by host',
                    canceled: 'Canceled',
                    failed: 'Not confirmed',
                  } as Record<string, string>
                )[item.status] ?? 'Waiting for host'}{' '}
                · {formatBytes(item.received)} / {formatBytes(item.file.size)}
              </span>
            </div>
            <progress
              aria-label={`Sending ${item.file.name}`}
              max={item.file.size || 1}
              value={
                item.status === 'completed'
                  ? item.file.size || 1
                  : item.received
              }
            />
            {item.error !== undefined && <p>{item.error}</p>}
            {item.receipt !== undefined ? (
              <div class="receipt">
                <p>
                  Saved as <strong>{item.receipt.name}</strong>
                </p>
                <code>{item.receipt.path}</code>
                <button
                  class="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(item.receipt!.path)
                      .catch(() => {
                        item.error =
                          'Clipboard unavailable; select and copy the displayed path.';
                        update(item);
                      });
                  }}
                >
                  Copy path
                </button>
                {insert !== undefined && (
                  <button onClick={() => insert(item.receipt!.path)}>
                    Insert into terminal field
                  </button>
                )}
              </div>
            ) : (
              !['failed', 'canceled'].includes(item.status) && (
                <button
                  class="secondary"
                  onClick={() => {
                    item.abort.abort();
                    item.status = 'canceled';
                    update(item);
                  }}
                >
                  Cancel upload
                </button>
              )
            )}
          </li>
        ))}
      </ol>
    </>
  );
}
