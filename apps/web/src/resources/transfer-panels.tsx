import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResourceSession } from './session.ts';
import { formatBytes, downloadLimit } from './transfer-ui.ts';
import { ResourceError } from './wire.ts';
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
  const [transfer, setTransfer] = useState<{
    file: OfferedFile;
    bytes: number;
    state: 'downloading' | 'verified' | 'failed' | 'canceled';
  } | null>(null);
  const limit = downloadLimit();
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
    setTransfer({ file, bytes: 0, state: 'downloading' });
    const controller = new AbortController();
    cancellation.current = controller;
    try {
      const sink = await chooseDownload(file);
      await downloadFile(session, file, sink, controller.signal, (bytes) => {
        setTransfer({ file, bytes, state: 'downloading' });
        setMessage(
          `Downloading ${formatBytes(bytes)} / ${formatBytes(file.size)}`,
        );
      });
      setTransfer({ file, bytes: file.size, state: 'verified' });
      setMessage(
        'Download verified. Check your browser downloads for the saved file.',
      );
    } catch (error) {
      const canceled =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError');
      setTransfer((current) =>
        current === null
          ? null
          : { ...current, state: canceled ? 'canceled' : 'failed' },
      );
      setMessage(
        canceled
          ? 'Download canceled. You can deliberately retry.'
          : error instanceof ResourceError
            ? error.code === 'TRANSFER_LIMIT'
              ? 'The host’s transfer allowance is reached. Ask the host before retrying.'
              : error.code === 'FILE_UNAVAILABLE'
                ? 'This file is unavailable or changed. Refresh files and ask the host.'
                : 'Access is unavailable. Reconnect or ask the host for a new link.'
            : error instanceof Error
              ? error.message
              : 'Download failed. Reconnect and try again.',
      );
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
      <p class="workspace-notice">
        {limit === null
          ? 'Streaming save is available in this browser.'
          : `This browser can download files up to ${formatBytes(limit)}. Larger files need a browser with streaming save support.`}
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
              disabled={
                !enabled ||
                busy ||
                (!file.dir && limit !== null && file.size > limit)
              }
              onClick={() =>
                file.dir ? void browse(file.path) : void save(file)
              }
            >
              {file.dir ? `Open folder ${file.name}` : `Download ${file.name}`}
            </button>
            {!file.dir && (
              <span>
                {' '}
                {formatBytes(file.size)}
                {limit !== null && file.size > limit
                  ? ' · Too large for this browser; use streaming save on another browser.'
                  : ''}
              </span>
            )}
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
      {transfer && (
        <article
          class="download-result"
          aria-label={`Transfer ${transfer.file.name}`}
        >
          <strong>{transfer.file.name}</strong>
          <progress
            aria-label={`Downloading ${transfer.file.name}`}
            max={transfer.file.size || 1}
            value={
              transfer.state === 'verified'
                ? transfer.file.size || 1
                : transfer.bytes
            }
          />
          <p>
            {formatBytes(transfer.bytes)} / {formatBytes(transfer.file.size)} ·{' '}
            {transfer.state}
          </p>
          {['failed', 'canceled'].includes(transfer.state) && (
            <button
              disabled={!enabled || busy}
              onClick={() => void save(transfer.file)}
            >
              Retry download
            </button>
          )}
        </article>
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
  const sending = useRef(false);
  const [updated, setUpdated] = useState('');
  async function refresh(): Promise<void> {
    if (sending.current) return;
    const current = ++generation.current;
    try {
      const value = await exchangeText(session);
      if (current === generation.current) {
        setIncoming(value);
        setUpdated(new Date().toLocaleTimeString());
        setStatus('Shared text refreshed. Your draft is unchanged.');
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
    sending.current = true;
    generation.current++;
    const submitted = draft;
    try {
      const value = await exchangeText(session, submitted);
      setIncoming(value);
      setDraft((current) => (current === submitted ? '' : current));
      setUpdated(new Date().toLocaleTimeString());
      setStatus('Shared text updated. This replaces the previous value.');
    } catch {
      setStatus(
        'Update was not confirmed. Your draft is kept; refresh before updating again.',
      );
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="Temporary text">
      <h2>Temporary shared text</h2>
      <p>
        Text stays in this live session. Sending replaces the shared text;
        nothing runs automatically.
      </p>
      <pre class="shared-text">{incoming || 'No text shared yet.'}</pre>
      {updated && <p class="panel-status">Last refreshed: {updated}</p>}
      <button disabled={!enabled || busy} onClick={() => void refresh()}>
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
        Shared text draft
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
        Update shared text
      </button>
      <p class="panel-status">
        {new TextEncoder().encode(draft).length.toLocaleString()} / 16,384 UTF-8
        bytes. Refreshing never replaces your draft.
      </p>
      <p role="status">
        {validText(draft) ? status : 'Use plain text up to 16 KiB.'}
      </p>
    </section>
  );
}
