import { useEffect, useRef, useState } from 'preact/hooks';
import { BrowserHost, type BrowserHostView } from './browser-host.ts';
import { validText } from './transfers.ts';

export function BrowserShare() {
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [view, setView] = useState<BrowserHostView | null>(null);
  const [link, setLink] = useState('');
  const [status, setStatus] = useState('');
  const host = useRef<BrowserHost | null>(null);
  const active = view?.status === 'starting' || view?.status === 'sharing';
  useEffect(() => {
    const end = (): void => host.current?.close('The hosting page was closed.');
    window.addEventListener('pagehide', end);
    return () => {
      window.removeEventListener('pagehide', end);
      host.current?.close();
    };
  }, []);
  async function start(): Promise<void> {
    setStatus('');
    setLink('');
    let next: BrowserHost | undefined;
    try {
      next = new BrowserHost(files, text, (state) => {
        setView(state);
        if (state.status === 'closed') setLink('');
      });
      host.current = next;
      setView(next.view);
      // The operator may provide a custom relay map in the existing public configuration.
      const response = await fetch('/tailmouse-config.json', {
        cache: 'no-store',
        credentials: 'omit',
      });
      if (!response.ok) throw new Error('Sharing configuration unavailable.');
      const data: unknown = await response.json();
      if (data === null || typeof data !== 'object')
        throw new Error('Invalid sharing configuration.');
      const map = (data as { derpMap?: unknown }).derpMap;
      if (map !== undefined && typeof map !== 'string')
        throw new Error('Invalid relay configuration.');
      await next.start(map);
      if (next.view.status === 'sharing')
        setLink(next.invitation(location.origin));
    } catch (error) {
      next?.close();
      setStatus(
        error instanceof Error ? error.message : 'Could not start sharing.',
      );
    }
  }
  return (
    <main class="resource-shell browser-sharing">
      <a href="/">TailMouse home</a>
      <h1>Share from your browser</h1>
      <p>
        Send files or temporary text to another device. Neither side needs an
        app or account. Files travel through an encrypted Tailcat connection,
        without being stored on this website’s server.
      </p>
      <p>
        Keep both pages open. Sharing expires after one hour; locking a phone or
        closing this page can interrupt it. Files are limited to 256 MiB each
        and 1 GiB of downloads per session. Browsers without streaming save
        support can download files up to 64 MiB.
      </p>
      <label>
        Files to share
        <input
          type="file"
          multiple
          disabled={active}
          onChange={(event) =>
            setFiles(Array.from(event.currentTarget.files ?? []))
          }
        />
      </label>
      <ul>
        {files.map((file) => (
          <li key={file.name}>
            {file.name} — {file.size} bytes
          </li>
        ))}
      </ul>
      <label>
        Text to share
        <textarea
          rows={6}
          value={text}
          onInput={(event) => setText(event.currentTarget.value)}
        />
      </label>
      {!validText(text) && <p role="alert">Use plain text up to 16 KiB.</p>}
      {!active && (
        <button disabled={!validText(text)} onClick={() => void start()}>
          Start browser sharing
        </button>
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
          <button
            disabled={link === ''}
            onClick={() =>
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(link))
                .then(
                  () => setStatus('Private link copied.'),
                  () => setStatus('Select and copy the private link above.'),
                )
            }
          >
            Copy sharing link
          </button>
          <p>
            One visitor at a time. Share this private link only with the
            intended person.
          </p>
          <button
            disabled={!validText(text)}
            onClick={() => {
              host.current?.setText(text);
              setStatus('Text sent.');
            }}
          >
            Update shared text
          </button>
          <h2>Current shared text</h2>
          <pre class="shared-text">{view.text || 'No text shared yet.'}</pre>
          <button
            disabled={view.text === ''}
            onClick={() =>
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(view.text))
                .then(
                  () => setStatus('Text copied.'),
                  () => setStatus('Select and copy the text above.'),
                )
            }
          >
            Copy received text
          </button>
          <p>
            {view.visitors} visitor connected · {view.bytes} bytes sent
          </p>
        </>
      )}
      {active && (
        <button
          class="secondary"
          onClick={() => {
            host.current?.close();
            setFiles([]);
            setText('');
          }}
        >
          End browser sharing
        </button>
      )}
      <p role="status">{status || view?.message || ''}</p>
    </main>
  );
}
