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

test('Leash acceptance preserves exact smoke and complete-matrix selection', (t) => {
  for (const matrix of [false, true]) {
    const { result, commands } = acceptance(
      t,
      matrix ? ['--network-matrix'] : [],
    );
    if (!['darwin', 'linux'].includes(process.platform)) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /requires a Unix PTY/);
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
        matrix ? '-timeout=3h' : '-timeout=3m',
        matrix
          ? '-run=^TestHermeticLeashNetworkMatrix$'
          : '-run=^TestHermeticLeash(Browser|Network)$',
        './apps/cli/cmd/tailmouse',
      ],
    ]);
  }
});

test('Leash acceptance rejects unknown or duplicate selectors before any build', (t) => {
  for (const args of [['--matrix'], ['--network-matrix', '--network-matrix']]) {
    const { result, commands } = acceptance(t, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(commands, []);
  }
});

test('Leash acceptance never proceeds after a prerequisite failure', (t) => {
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
