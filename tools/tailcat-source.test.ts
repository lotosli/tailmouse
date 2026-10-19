import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloneTailcatBuildSource } from './tailcat-source.mjs';

await test('transport build bytes do not depend on tags in the source checkout', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tailmouse-source-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source with spaces');
  mkdirSync(source);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  git(source, 'init', '--initial-branch=main');
  writeFileSync(
    join(source, 'go.mod'),
    'module example.invalid/buildfixture\n\ngo 1.27.2\n',
  );
  writeFileSync(join(source, 'main.go'), 'package main\nfunc main() {}\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'Synthetic source');
  const revision = git(source, 'rev-parse', 'HEAD');
  const before = join(root, 'before');
  const after = join(root, 'after');
  cloneTailcatBuildSource(source, before, revision);
  git(source, 'tag', 'v0.7.0');
  cloneTailcatBuildSource(source, after, revision);
  for (const directory of [before, after]) {
    assert.equal(git(directory, 'tag', '--list'), '');
    assert.equal(git(directory, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(git(directory, 'status', '--porcelain'), '');
    execFileSync(
      'go',
      [
        'build',
        '-trimpath',
        '-o',
        join(root, `${directory === before ? 'before' : 'after'}.wasm`),
        '.',
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          GOWORK: 'off',
          GOOS: 'js',
          GOARCH: 'wasm',
          CGO_ENABLED: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      },
    );
  }
  assert.deepEqual(
    readFileSync(join(root, 'before.wasm')),
    readFileSync(join(root, 'after.wasm')),
  );
  assert.equal(git(source, 'tag', '--list'), 'v0.7.0');
  assert.equal(git(source, 'status', '--porcelain'), '');
  assert.throws(
    () =>
      cloneTailcatBuildSource(source, join(root, 'mismatch'), '0'.repeat(40)),
    /differs from its gitlink/u,
  );
  assert.throws(() => cloneTailcatBuildSource('relative', after, revision));
  assert.throws(() => cloneTailcatBuildSource(source, after, 'invalid'));
});
