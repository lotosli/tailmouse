import { afterEach, expect, it, vi } from 'vitest';
import { downloadLimit, formatBytes, selectionIssues } from './transfer-ui.ts';
afterEach(() => vi.unstubAllGlobals());
it('formats transfer sizes and detects actual streaming capability', () => {
  expect([0, 2048, 3 * 1024 * 1024, 1024 ** 3].map(formatBytes)).toEqual([
    '0 B',
    '2.0 KiB',
    '3.0 MiB',
    '1.0 GiB',
  ]);
  vi.stubGlobal('showSaveFilePicker', undefined);
  expect(downloadLimit()).toBe(64 * 1024 * 1024);
  vi.stubGlobal('showSaveFilePicker', () => undefined);
  expect(downloadLimit()).toBeNull();
});
it('identifies exactly which selected files need correction before sharing', () => {
  const files = [
    { name: 'same.txt', size: 1 },
    { name: 'same.txt', size: 2 },
    { name: '.hidden', size: 1 },
    { name: 'huge.bin', size: 256 * 1024 * 1024 + 1 },
    { name: 'ok.txt', size: 3 },
  ];
  const issues = selectionIssues(files);
  expect(issues[0]).toContain('more than once');
  expect(issues[1]).toContain('more than once');
  expect(issues[2]).toContain('visible filename');
  expect(issues[3]).toContain('256 MiB');
  expect(issues[4]).toBe('');
  expect(
    selectionIssues(
      Array.from({ length: 101 }, (_, i) => ({ name: `${i}.txt`, size: 0 })),
    ).filter(Boolean),
  ).toEqual(['Choose at most 100 files. Remove extra files.']);
});
