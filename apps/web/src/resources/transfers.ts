import type { ResourceSession } from './session.ts';
import { ResourceProtocolError } from './wire.ts';

export const MAX_TEXT = 16384;
export const MEMORY_DOWNLOAD_LIMIT = 64 * 1024 * 1024;
export interface OfferedFile {
  name: string;
  path: string;
  dir: boolean;
  size: number;
}
export interface OfferedList {
  type: 'files.list';
  path: string;
  entries: OfferedFile[];
  next: number;
  more: boolean;
}
export function validText(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    new TextEncoder().encode(text).length <= MAX_TEXT &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)
  );
}
export function validFilePath(value: unknown, root = false): value is string {
  return (
    typeof value === 'string' &&
    ((root && value === '') ||
      (value.length > 0 &&
        new TextEncoder().encode(value).length <= 1024 &&
        value
          .split('/')
          .every(
            (part) =>
              part.length > 0 &&
              !part.startsWith('.') &&
              new TextEncoder().encode(part).length <= 180 &&
              !/[\\:\u0000-\u001f\u007f-\u009f]/u.test(part),
          )))
  );
}
export function parseFileList(value: Record<string, unknown>): OfferedList {
  if (
    value.type !== 'files.list' ||
    !validFilePath(value.path, true) ||
    !Number.isSafeInteger(value.next) ||
    Number(value.next) < 0 ||
    Number(value.next) > 10000 ||
    typeof value.more !== 'boolean' ||
    !Array.isArray(value.entries) ||
    value.entries.length > 40
  )
    throw new ResourceProtocolError('Invalid directory listing.');
  for (const item of value.entries as unknown[]) {
    if (item === null || typeof item !== 'object')
      throw new ResourceProtocolError('Invalid file.');
    const file = item as OfferedFile;
    if (
      !validFilePath(file.name) ||
      file.name.includes('/') ||
      file.path !==
        (value.path === ''
          ? file.name
          : `${String(value.path)}/${file.name}`) ||
      !validFilePath(file.path) ||
      typeof file.dir !== 'boolean' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0
    )
      throw new ResourceProtocolError('Invalid file.');
  }
  return value as unknown as OfferedList;
}
type Access = Pick<ResourceSession, 'open' | 'release' | 'hash'>;
export async function listFiles(
  session: Access,
  path = '',
  offset = 0,
): Promise<OfferedList> {
  const wire = await session.open('download', 'files');
  try {
    await wire.json({ type: 'files.list', path, offset });
    const result = parseFileList(await wire.object());
    if (result.path !== path || (result.more && result.next <= offset))
      throw new ResourceProtocolError('Invalid directory cursor.');
    return result;
  } finally {
    await session.release(wire);
  }
}
export interface DownloadSink {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export async function downloadFile(
  session: Access,
  file: OfferedFile,
  sink: DownloadSink,
  signal: AbortSignal,
  progress: (bytes: number) => void,
): Promise<void> {
  let wire: Awaited<ReturnType<Access['open']>> | undefined;
  let hash: number | undefined;
  const abort = (): void => {
    void wire?.close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted || file.dir || !validFilePath(file.path))
      throw new Error('Download canceled or unavailable.');
    wire = await session.open('download', 'files');
    if (signal.aborted) throw new Error('Download canceled.');
    await wire.json({ type: 'download.begin', path: file.path });
    const ready = await wire.object();
    if (
      ready.type !== 'download.ready' ||
      ready.name !== file.name ||
      ready.size !== file.size
    )
      throw new Error('The file changed; refresh its listing.');
    const id = await session.hash('start');
    if (typeof id !== 'number') throw new Error('Hasher unavailable.');
    hash = id;
    let received = 0;
    while (true) {
      if (signal.aborted) throw new Error('Download canceled.');
      const frame = await wire.read();
      if (frame.kind === 3) break;
      if (
        frame.kind !== 2 ||
        frame.data.length === 0 ||
        received + frame.data.length > file.size
      )
        throw new Error('Invalid download data.');
      await session.hash('update', hash, frame.data);
      await sink.write(frame.data);
      received += frame.data.length;
      progress(received);
    }
    const completed = await wire.object();
    const digest = await session.hash('finish', hash);
    hash = undefined;
    if (
      signal.aborted ||
      received !== file.size ||
      completed.type !== 'download.completed' ||
      completed.size !== received ||
      typeof digest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(digest) ||
      completed.sha256 !== digest
    )
      throw new Error('Download verification failed.');
    await sink.close();
  } catch (error) {
    await sink.abort();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    if (hash !== undefined)
      await session.hash('cancel', hash).catch(() => undefined);
    if (wire !== undefined) await session.release(wire).catch(() => undefined);
  }
}
export async function exchangeText(
  session: Access,
  text?: string,
): Promise<string> {
  if (text !== undefined && !validText(text))
    throw new Error('Text must be valid plain UTF-8, at most 16 KiB.');
  const wire = await session.open('text', 'text');
  try {
    await wire.json(
      text === undefined ? { type: 'text.get' } : { type: 'text.set', text },
    );
    const result = await wire.object();
    if (result.type !== 'text.value' || !validText(result.text ?? ''))
      throw new ResourceProtocolError('Invalid text response.');
    return (result.text ?? '') as string;
  } finally {
    await session.release(wire);
  }
}

interface SavePicker {
  showSaveFilePicker?: (options: {
    suggestedName: string;
  }) => Promise<{ createWritable(): Promise<DownloadSink> }>;
}
export async function chooseDownload(file: OfferedFile): Promise<DownloadSink> {
  const picker = globalThis as typeof globalThis & SavePicker;
  if (picker.showSaveFilePicker !== undefined) {
    const handle = await picker.showSaveFilePicker({
      suggestedName: file.name,
    });
    return handle.createWritable();
  }
  if (file.size > MEMORY_DOWNLOAD_LIMIT)
    throw new Error(
      'This browser supports downloads up to 64 MiB. Use a browser with a streaming Save File picker for larger files.',
    );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  return {
    async write(data) {
      total += data.length;
      if (total > file.size || total > MEMORY_DOWNLOAD_LIMIT)
        throw new Error('Download memory limit exceeded.');
      parts.push(new Uint8Array(data));
    },
    async close() {
      const url = URL.createObjectURL(
        new Blob(parts, { type: 'application/octet-stream' }),
      );
      parts.length = 0;
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    async abort() {
      parts.length = 0;
    },
  };
}
