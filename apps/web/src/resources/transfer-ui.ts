import { validFilePath, MEMORY_DOWNLOAD_LIMIT } from './transfers.ts';

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GiB`;
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
export function selectionIssues(
  files: readonly Pick<File, 'name' | 'size'>[],
): string[] {
  return files.map((file, index) => {
    if (index >= 100) return 'Choose at most 100 files. Remove extra files.';
    if (!validFilePath(file.name) || file.name.includes('/'))
      return 'Use a visible filename up to 180 UTF-8 bytes, without path separators.';
    if (files.some((other, i) => i !== index && other.name === file.name))
      return 'This name appears more than once. Remove a copy or rename it locally.';
    if (file.size > 256 * 1024 * 1024) return 'This file exceeds 256 MiB.';
    return '';
  });
}
export function downloadLimit(): number | null {
  return typeof (globalThis as { showSaveFilePicker?: unknown })
    .showSaveFilePicker === 'function'
    ? null
    : MEMORY_DOWNLOAD_LIMIT;
}
