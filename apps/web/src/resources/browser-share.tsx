import { useEffect, useRef, useState } from 'preact/hooks';
import { BrowserHost, type BrowserHostView } from './browser-host.ts';
import { validText } from './transfers.ts';
import { formatBytes, selectionIssues } from './transfer-ui.ts';

export function BrowserShare() {
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [view, setView] = useState<BrowserHostView | null>(null);
  const [link, setLink] = useState('');
  const [matrix, setMatrix] = useState('');
  const [status, setStatus] = useState('');
  const [now, setNow] = useState(Date.now());
  const host = useRef<BrowserHost | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const active = view?.status === 'starting' || view?.status === 'sharing';
  const issues = selectionIssues(files);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  const tooLarge = total > 1024 * 1024 * 1024;
  const textBytes = new TextEncoder().encode(text).length;
  useEffect(() => {
    const end = (): void => host.current?.close('The hosting page was closed.');
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      host.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!active) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    const timer = setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener('beforeunload', warn);
    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
    };
  }, [active]);
  useEffect(() => {
    if (status === '') return;
    const timer = setTimeout(() => setStatus(''), 5000);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    const target = canvas.current;
    if (target === null || matrix === '') return;
    const rows = matrix.trim().split('\n');
    target.width = rows.length * 4;
    target.height = rows.length * 4;
    const context = target.getContext('2d');
    if (context === null) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, target.width, target.height);
    context.fillStyle = '#000';
    for (const [y, row] of rows.entries())
      for (const [x, cell] of Array.from(row).entries())
        if (cell === '1') context.fillRect(x * 4, y * 4, 4, 4);
  }, [matrix]);
  function add(selected: FileList | null): void {
    if (!active && selected !== null)
      setFiles((current) => [
        ...current,
        ...Array.from(selected).slice(0, Math.max(0, 101 - current.length)),
      ]);
  }
  async function copy(
    value: string,
    confirmation: string,
    fallback: string,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(confirmation);
    } catch {
      setStatus(fallback);
    }
  }
  async function start(): Promise<void> {
    if (tooLarge || issues.some(Boolean) || !validText(text)) return;
    setStatus('');
    setLink('');
    setMatrix('');
    let next: BrowserHost | undefined;
    try {
      next = new BrowserHost(files, text, (state) => {
        setView(state);
        if (state.status === 'closed') {
          setLink('');
          setMatrix('');
        }
      });
      host.current = next;
      setView(next.view);
      const response = await fetch('/tailmouse-config.json', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok)
        throw new Error(
          'Sharing configuration unavailable. Try loading this page again.',
        );
      const data: unknown = await response.json();
      if (data === null || typeof data !== 'object')
        throw new Error('Invalid sharing configuration.');
      const map = (data as { derpMap?: unknown }).derpMap;
      if (map !== undefined && typeof map !== 'string')
        throw new Error('Invalid relay configuration.');
      await next.start(map);
      if (host.current !== next || next.view.status !== 'sharing') return;
      setLink(next.invitation(location.origin));
      setNow(Date.now());
      try {
        const qr = await next.qr(location.origin);
        if (host.current === next && next.view.status === 'sharing')
          setMatrix(qr);
      } catch {
        if (host.current === next && next.view.status === 'sharing')
          setStatus('QR unavailable. Copy the private link instead.');
      }
    } catch (error) {
      if (next !== undefined && host.current !== next) return;
      next?.close();
      setView({
        status: 'closed',
        text: '',
        bytes: 0,
        visitors: 0,
        message:
          error instanceof Error && error.message !== 'BROWSER_UNSUPPORTED'
            ? error.message
            : 'Use a current browser with WebAssembly and Workers.',
      });
    }
  }
  return (
    <main class="resource-shell browser-sharing">
      <a href="/">TailMouse home</a>
      <p class="eyebrow">No installation · No account</p>
      <h1>Send a file. Share a thought.</h1>
      <p>
        Select files or temporary text, create a private link, then open it on
        the other device.
      </p>
      <p class="workspace-notice">
        Keep this page open until the other device finishes. Locking a phone or
        closing this page can interrupt sharing.
      </p>
      <section aria-label="Choose content" class="share-card">
        <h2>1. Choose what to share</h2>
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
            ref={picker}
            type="file"
            aria-label="Files to share"
            multiple
            disabled={active}
            onChange={(event) => {
              add(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <ul class="selection-list">
          {files.map((file, index) => (
            <li key={index}>
              <div>
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)}</span>
                {issues[index] && <p role="alert">{issues[index]}</p>}
              </div>
              <button
                class="secondary"
                disabled={active}
                aria-label={`Remove ${file.name}, item ${index + 1}`}
                onClick={() =>
                  setFiles((current) => current.filter((_, i) => i !== index))
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {files.length > 0 && (
          <p>
            {files.length} files · {formatBytes(total)}{' '}
            <button
              class="secondary"
              disabled={active}
              onClick={() => setFiles([])}
            >
              Clear files
            </button>
          </p>
        )}
        {tooLarge && (
          <p role="alert">
            Selected files exceed 1 GiB. Remove files before starting.
          </p>
        )}
        <label>
          Text to share
          <textarea
            rows={4}
            value={text}
            onInput={(event) => setText(event.currentTarget.value)}
          />
        </label>
        <p class="panel-status">
          {textBytes.toLocaleString()} / 16,384 UTF-8 bytes. One shared text
          value; updates replace it. An empty session lets the visitor write
          first.
        </p>
        {!validText(text) && <p role="alert">Use plain text up to 16 KiB.</p>}
        {view?.status === 'sharing' ? (
          <button
            disabled={!validText(text)}
            onClick={() => {
              host.current?.setText(text);
              setStatus(
                'Shared text updated. The visitor refreshes automatically.',
              );
            }}
          >
            Update shared text
          </button>
        ) : (
          !active && (
            <button
              disabled={tooLarge || issues.some(Boolean) || !validText(text)}
              onClick={() => void start()}
            >
              Start browser sharing
            </button>
          )
        )}
        <details>
          <summary>File limits and privacy</summary>
          <p>
            Up to 100 files, 256 MiB each and 1 GiB of downloads per session.
            Browsers without streaming save support can download files up to 64
            MiB. Files travel through encrypted Tailcat transport and are not
            stored on this website’s server. Only selected files are shared.
          </p>
        </details>
      </section>
      <section class="share-card" aria-label="Sharing session">
        <h2>2. Connect the other device</h2>
        <p role="status" aria-label="Session status">
          {view?.message || 'Start sharing to create your private link.'}
        </p>
        {view?.runtimeProgress && (
          <label>
            Preparing secure connection ·{' '}
            {formatBytes(view.runtimeProgress.received)} /{' '}
            {formatBytes(view.runtimeProgress.total)}
            <progress
              max={view.runtimeProgress.total}
              value={view.runtimeProgress.received}
            />
          </label>
        )}
        {view?.status === 'sharing' && (
          <>
            <label>
              Private sharing link
              <input
                readOnly
                value={link}
                onFocus={(event) => event.currentTarget.select()}
              />
            </label>
            <div class="share-actions">
              <button
                disabled={link === ''}
                onClick={() =>
                  void copy(
                    link,
                    'Private link copied.',
                    'Select and copy the private link above.',
                  )
                }
              >
                Copy sharing link
              </button>
              {typeof navigator.share === 'function' && (
                <button
                  class="secondary"
                  onClick={() =>
                    void navigator
                      .share({ title: 'TailMouse private sharing', url: link })
                      .then(
                        () =>
                          setStatus(
                            'Sharing sheet closed. Wait for the other device to connect.',
                          ),
                        (error: unknown) =>
                          setStatus(
                            error instanceof DOMException &&
                              error.name === 'AbortError'
                              ? 'Sharing canceled. Your session is still open.'
                              : 'System sharing unavailable. Copy the private link instead.',
                          ),
                      )
                  }
                >
                  Share link…
                </button>
              )}
            </div>
            {matrix && (
              <figure class="share-qr">
                <canvas
                  ref={canvas}
                  role="img"
                  aria-label="Private sharing QR code"
                />
                <figcaption>
                  Scan on the other device. Keep this link private.
                </figcaption>
              </figure>
            )}
            <p>
              {view.visitors
                ? 'Visitor connected'
                : 'Waiting for the other device'}{' '}
              ·{' '}
              {view.expiresAt
                ? `${Math.max(0, Math.ceil((view.expiresAt - now) / 60000))} minutes remaining`
                : 'Expires after one hour'}{' '}
              · One visitor at a time
            </p>
            <p>
              {formatBytes(view.bytes)} sent · {view.activeDownloads ?? 0}{' '}
              active downloads · {view.sentFiles ?? 0} files sent. The receiving
              device confirms verification; sent bytes do not prove a saved
              file.
            </p>
            <h3>Current shared text</h3>
            <pre class="shared-text">{view.text || 'No text shared yet.'}</pre>
            <button
              class="secondary"
              disabled={view.text === ''}
              onClick={() =>
                void copy(
                  view.text,
                  'Text copied.',
                  'Select and copy the text above.',
                )
              }
            >
              Copy received text
            </button>
          </>
        )}
        {active && (
          <button
            class="secondary end-sharing"
            onClick={() => {
              const current = host.current;
              host.current = null;
              current?.close();
              setFiles([]);
              setText('');
              setStatus('');
              if (picker.current !== null) picker.current.value = '';
            }}
          >
            End browser sharing
          </button>
        )}
        <p role="status" aria-label="Action notice">
          {status}
        </p>
      </section>
    </main>
  );
}
