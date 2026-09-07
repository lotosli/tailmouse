import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

function acceptance(t: TestContext, args: string[], failBuild = false) {
  const fixture = mkdtempSync(join(tmpdir(), 'tailmouse-leash-gate-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  copyFileSync(
    new URL('./leash-acceptance.mjs', import.meta.url),
    join(fixture, 'leash-acceptance.mjs'),
  );
  const log = join(fixture, 'commands.jsonl');
  writeFileSync(
    join(fixture, 'process.mjs'),
    `
      import { appendFileSync } from 'node:fs';
      export function run(command, args) {
        appendFileSync(${JSON.stringify(log)}, JSON.stringify([command, ...args]) + '\\n');
        if (${JSON.stringify(failBuild)} && args.includes('build')) throw new Error('Synthetic build failure');
      }
      export function runPnpm(args) { run('pnpm', args); }
    `,
  );
  const result = spawnSync(
    process.execPath,
    [join(fixture, 'leash-acceptance.mjs'), ...args],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (result.error) throw result.error;
  const commands: string[][] = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line) as string[])
    : [];
  return { result, commands };
}

await test('Leash acceptance preserves exact smoke, matrix, AI CLI, official and Chrome selection', (t) => {
  for (const mode of [
    'smoke',
    'matrix',
    'ai-cli',
    'official',
    'chrome',
  ] as const) {
    const { result, commands } = acceptance(
      t,
      mode === 'matrix'
        ? ['--network-matrix']
        : mode === 'official'
          ? ['--official']
          : mode === 'chrome'
            ? ['--chrome']
            : mode === 'ai-cli'
              ? ['--ai-cli']
              : [],
    );
    if (
      !['darwin', 'linux'].includes(process.platform) ||
      (['official', 'chrome'].includes(mode) && process.platform !== 'darwin')
    ) {
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        ['official', 'chrome'].includes(mode) &&
          ['darwin', 'linux'].includes(process.platform)
          ? /requires macOS/
          : /requires a Unix PTY/,
      );
      assert.deepEqual(commands, []);
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commands, [
      [process.execPath, 'tools/tailcat-gate.mjs', 'build'],
      ['pnpm', '--filter', '@tailmouse/web', 'build'],
      [
        'go',
        'test',
        '-tags=tailcatintegration',
        '-count=1',
        '-failfast',
        ...(['official', 'ai-cli', 'chrome'].includes(mode) ? ['-v'] : []),
        mode === 'matrix'
          ? '-timeout=3h'
          : mode === 'official' || mode === 'chrome'
            ? '-timeout=4m'
            : mode === 'ai-cli'
              ? '-timeout=2m'
              : '-timeout=6m',
        mode === 'matrix'
          ? '-run=^TestHermeticLeashNetworkMatrix$'
          : mode === 'official'
            ? '-run=^TestOfficialLeashBrowser$'
            : mode === 'chrome'
              ? '-run=^TestOfficialChromeLeashBrowser$'
              : mode === 'ai-cli'
                ? '-run=^TestHermeticLeashAI$'
                : '-run=^TestHermeticLeash(Browser|Network)$',
        './apps/cli/cmd/tailmouse',
      ],
    ]);
  }
});

await test('Leash acceptance rejects unknown or duplicate selectors before any build', (t) => {
  for (const args of [
    ['--matrix'],
    ['--network-matrix', '--network-matrix'],
    ['--official', '--network-matrix'],
  ]) {
    const { result, commands } = acceptance(t, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(commands, []);
  }
});

await test('Leash acceptance accepts the pnpm argument separator', (t) => {
  const { result, commands } = acceptance(t, ['--', '--official']);
  if (process.platform !== 'darwin') {
    assert.notEqual(result.status, 0);
    assert.deepEqual(commands, []);
    return;
  }
  assert.equal(result.status, 0, result.stderr);
  assert.equal(commands.at(-1)?.at(-2), '-run=^TestOfficialLeashBrowser$');
});

await test('Leash acceptance never proceeds after a prerequisite failure', (t) => {
  const { result, commands } = acceptance(t, ['--network-matrix'], true);
  assert.notEqual(result.status, 0);
  if (['darwin', 'linux'].includes(process.platform)) {
    assert.match(result.stderr, /Synthetic build failure/);
    assert.deepEqual(commands, [
      [process.execPath, 'tools/tailcat-gate.mjs', 'build'],
    ]);
  } else {
    assert.match(result.stderr, /requires a Unix PTY/);
    assert.deepEqual(commands, []);
  }
});
