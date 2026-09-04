import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

function releaseGate(t: TestContext, target: string, failRace = false) {
  const fixture = mkdtempSync(join(tmpdir(), 'tailmouse-go-gate-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'tools'));
  writeFileSync(join(fixture, 'go.mod'), 'module gatefixture\n');
  writeFileSync(join(fixture, 'main.go'), 'package gatefixture\n');
  copyFileSync(
    new URL('./go-gate.mjs', import.meta.url),
    join(fixture, 'tools/go-gate.mjs'),
  );
  writeFileSync(
    join(fixture, 'tools/process.mjs'),
    `
      import { appendFileSync } from 'node:fs';
      export function run(command, args) {
        appendFileSync(${JSON.stringify(join(fixture, 'commands.jsonl'))}, JSON.stringify([command, ...args]) + '\\n');
        if (args[0] === 'env') return { stdout: ${JSON.stringify(target)} };
        if (${JSON.stringify(failRace)} && args.includes('-race')) throw new Error('Synthetic race check failure');
        return { stdout: '' };
      }
    `,
  );
  const result = spawnSync(
    process.execPath,
    [join(fixture, 'tools/go-gate.mjs'), 'release'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  const commands: string[][] = readFileSync(
    join(fixture, 'commands.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as string[]);
  return { result, commands };
}

test('release gate runs race checks for every supported release target', (t) => {
  for (const target of [
    'darwin\namd64',
    'darwin\narm64',
    'linux\namd64',
    'linux\narm64',
    'windows\namd64',
  ]) {
    const { result, commands } = releaseGate(t, target);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commands.slice(-2), [
      ['go', 'test', '-race', './...'],
      ['go', 'tool', 'govulncheck', './...'],
    ]);
    assert.doesNotMatch(result.stdout, /skipped/);
  }
});

test('only Windows ARM64 reports its unsupported race detector and still checks vulnerabilities', (t) => {
  for (const target of ['windows\narm64\n', 'windows\r\narm64\r\n']) {
    const { result, commands } = releaseGate(t, target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Go 1\.27\.1 does not support the race detector on windows\/arm64/,
    );
    assert.equal(
      commands.some((command) => command.includes('-race')),
      false,
    );
    assert.deepEqual(commands.at(-1), ['go', 'tool', 'govulncheck', './...']);
  }
});

test('race failures and invalid target output stop before vulnerability checks', (t) => {
  for (const target of [
    '',
    'windows',
    'windows\narm64\nextra',
    'windows\narm 64',
    'darwin\narm64',
  ]) {
    const { result, commands } = releaseGate(t, target, true);
    assert.notEqual(result.status, 0);
    assert.equal(
      commands.some((command) => command.includes('govulncheck')),
      false,
    );
    assert.doesNotMatch(result.stdout, /skipped/);
  }
});
