import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResourceSession } from './session.ts';
import {
  chooseDownload,
  downloadFile,
  exchangeText,
  listFiles,
  validText,
  type OfferedFile,
  type OfferedList,
} from './transfers.ts';

export function FilesPanel({
  session,
  enabled,
}: {
  session: ResourceSession;
  enabled: boolean;
}) {
  const [list, setList] = useState<OfferedList | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const cancellation = useRef<AbortController | null>(null);
  const navigation = useRef(0);
  async function browse(path = '', offset = 0): Promise<void> {
    const generation = ++navigation.current;
    setBusy(true);
    try {
      const next = await listFiles(session, path, offset);
      if (generation === navigation.current) {
        setList(next);
        setMessage('');
      }
    } catch {
      if (generation === navigation.current)
        setMessage('Could not read these files. Refresh or ask the host.');
    } finally {
      if (generation === navigation.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (enabled) void browse();
    return () => {
      navigation.current++;
      cancellation.current?.abort();
    };
  }, [enabled, session]);
  async function save(file: OfferedFile): Promise<void> {
    setBusy(true);
    const controller = new AbortController();
    cancellation.current = controller;
    try {
      const sink = await chooseDownload(file);
      await downloadFile(session, file, sink, controller.signal, (bytes) =>
        setMessage(`Downloading ${bytes} / ${file.size} bytes`),
      );
      setMessage('Download verified.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      cancellation.current = null;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Shared files">
      <h2>Files from host</h2>
      <p>
        Read-only downloads. Files stay on the host until you download them.
      </p>
      <p>
        <button
          disabled={!enabled || busy}
          onClick={() => void browse(list?.path)}
        >
          Refresh files
        </button>
        {list?.path && (
          <button
            disabled={busy}
            onClick={() =>
              void browse(list.path.split('/').slice(0, -1).join('/'))
            }
          >
            Parent folder
          </button>
        )}
      </p>
      <p>{list?.path || 'Shared folder'}</p>
      <ul>
        {list?.entries.map((file) => (
          <li key={file.path}>
            <button
              disabled={!enabled || busy}
              onClick={() =>
                file.dir ? void browse(file.path) : void save(file)
              }
            >
              {file.dir ? `Open folder ${file.name}` : `Download ${file.name}`}
            </button>
            {!file.dir && <span> {file.size} bytes</span>}
          </li>
        ))}
      </ul>
      {list?.entries.length === 0 && <p>No visible files on this page.</p>}
      <p>
        {list !== null && list.next > 40 && (
          <button
            disabled={busy}
            onClick={() =>
              void browse(
                list.path,
                Math.max(0, (Math.ceil(list.next / 40) - 2) * 40),
              )
            }
          >
            Previous page
          </button>
        )}
        {list?.more && (
          <button
            disabled={busy}
            onClick={() => void browse(list.path, list.next)}
          >
            Next page
          </button>
        )}
      </p>
      {busy && cancellation.current !== null && (
        <button onClick={() => cancellation.current?.abort()}>
          Cancel download
        </button>
      )}
      <p role="status">{message}</p>
    </section>
  );
}

export function TextPanel({
  session,
  enabled,
}: {
  session: ResourceSession;
  enabled: boolean;
}) {
  const [incoming, setIncoming] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  async function refresh(): Promise<void> {
    const current = ++generation.current;
    try {
      const value = await exchangeText(session);
      if (current === generation.current) {
        setIncoming(value);
        setStatus('Text refreshed.');
      }
    } catch {
      if (current === generation.current)
        setStatus('Text unavailable. Reconnect or try again.');
    }
  }
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [enabled, session]);
  async function send(): Promise<void> {
    setBusy(true);
    try {
      const value = await exchangeText(session, draft);
      setIncoming(value);
      setDraft('');
      setStatus('Text sent.');
    } catch {
      setStatus('Text was not confirmed. Refresh before sending again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Temporary text">
      <h2>Temporary text</h2>
      <p>
        Text stays in this live session. Sending replaces the shared text;
        nothing runs automatically.
      </p>
      <pre class="shared-text">{incoming || 'No text shared yet.'}</pre>
      <button disabled={!enabled} onClick={() => void refresh()}>
        Refresh text
      </button>
      <button
        disabled={incoming === ''}
        onClick={() =>
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(incoming))
            .then(
              () => setStatus('Text copied.'),
              () =>
                setStatus('Clipboard unavailable. Select and copy the text.'),
            )
        }
      >
        Copy text
      </button>
      <label>
        Text to send
        <textarea
          value={draft}
          onInput={(event) => setDraft(event.currentTarget.value)}
          rows={5}
        />
      </label>
      <button
        disabled={!enabled || busy || !validText(draft)}
        onClick={() => void send()}
      >
        Send text
      </button>
      <p role="status">
        {validText(draft) ? status : 'Use plain text up to 16 KiB.'}
      </p>
    </section>
  );
}
