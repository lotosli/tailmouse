import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildIdentity } from './build-identity.ts';

await test('build identity verifies the gitlink and distinguishes development from clean release builds', (t) => {
  const fixture = repository(t);
  const revision = fixture.git(fixture.upstream, 'rev-parse', 'HEAD');
  const source = fixture.git(fixture.root, 'rev-parse', 'HEAD');
  assert.deepEqual(buildIdentity(fixture.root), {
    version: `0.0.0-dev.${source.slice(0, 12)}`,
    tailcatRevision: revision,
    protocols: { escape: 1, leash: 2 },
  });
  assert.equal(buildIdentity(fixture.root, '0.1.0').version, '0.1.0');
  for (const invalid of [
    'tcSyntheticSecret',
    '0.1.0\nsecret',
    '1.0.0-' + 'x'.repeat(32),
  ]) {
    assert.throws(
      () => buildIdentity(fixture.root, invalid),
      /bounded semantic version/u,
    );
  }
  writeFileSync(join(fixture.root, 'change.txt'), 'synthetic change');
  assert.equal(
    buildIdentity(fixture.root).version,
    `0.0.0-dev.${source.slice(0, 12)}.dirty`,
  );
  assert.throws(() => buildIdentity(fixture.root, '0.1.0'), /clean TailMouse/u);
  writeFileSync(
    join(fixture.upstream, 'change.txt'),
    'synthetic dependency change',
  );
  assert.throws(() => buildIdentity(fixture.root), /clean recorded Tailcat/u);
});

await test('build identity rejects missing metadata and unrecorded dependency advancement', (t) => {
  const fixture = repository(t);
  assert.throws(
    () => buildIdentity(join(fixture.root, 'missing')),
    /readable Git metadata/u,
  );
  fixture.git(
    fixture.upstream,
    'commit',
    '--allow-empty',
    '-m',
    'Advance synthetic dependency',
  );
  assert.throws(() => buildIdentity(fixture.root), /clean recorded Tailcat/u);
  fixture.git(
    fixture.root,
    'update-index',
    '--cacheinfo',
    `160000,${fixture.git(fixture.upstream, 'rev-parse', 'HEAD')},third_party/tailcat`,
  );
  writeFileSync(join(fixture.root, 'package.json'), '{}');
  assert.throws(
    () => buildIdentity(fixture.root),
    /Project version is missing/u,
  );
  fixture.git(
    fixture.root,
    'update-index',
    '--force-remove',
    '--',
    'third_party/tailcat',
  );
  assert.throws(() => buildIdentity(fixture.root), /clean recorded Tailcat/u);
});

function repository(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'tailmouse-build-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const upstream = join(root, 'third_party', 'tailcat');
  mkdirSync(upstream, { recursive: true });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Synthetic Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  for (const cwd of [root, upstream]) {
    git(cwd, 'init', '--initial-branch=main');
    git(
      cwd,
      'commit',
      '--allow-empty',
      '-m',
      'Initialize synthetic repository',
    );
  }
  writeFileSync(join(root, 'package.json'), '{"version":"0.0.0"}\n');
  git(root, 'add', '--', 'package.json');
  git(
    root,
    'update-index',
    '--add',
    '--cacheinfo',
    `160000,${git(upstream, 'rev-parse', 'HEAD')},third_party/tailcat`,
  );
  git(root, 'commit', '-m', 'Record synthetic dependency');
  return { root, upstream, git };
}

await test('the host builder preserves portable release flags and fails before claiming an invalid build', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'tailmouse-host-build-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const scripts = join(fixture, 'tools');
  mkdirSync(scripts);
  copyFileSync(
    new URL('./build-native.mjs', import.meta.url),
    join(scripts, 'build-native.mjs'),
  );
  const commands = join(fixture, 'commands.jsonl');
  writeFileSync(
    join(scripts, 'build-identity.ts'),
    `export function buildIdentity() { return { version: '0.0.0-test', tailcatRevision: '${'a'.repeat(40)}' }; }`,
  );
  for (const failure of ['none', 'compile', 'identity']) {
    writeFileSync(commands, '');
    writeFileSync(
      join(scripts, 'process.mjs'),
      `
      import { appendFileSync } from 'node:fs';
      export function run(command, args, options) {
        appendFileSync(${JSON.stringify(commands)}, JSON.stringify({ command, args, env: options.env }) + '\\n');
        if (command === 'go' && ${JSON.stringify(failure)} === 'compile') throw new Error('Synthetic compile failure');
        return { stdout: ${JSON.stringify(failure === 'identity' ? 'invalid identity' : `TailMouse 0.0.0-test\nTMOUSE Escape protocol 1\nTMOUSE Leash protocol 2\nTailcat revision ${'a'.repeat(40)}\n`)} };
      }
    `,
    );
    const result = spawnSync(
      process.execPath,
      [join(scripts, 'build-native.mjs')],
      {
        encoding: 'utf8',
        env: { ...process.env, CGO_ENABLED: '1' },
        timeout: 10_000,
      },
    );
    assert.ifError(result.error);
    const calls = readFileSync(commands, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            command: string;
            args: string[];
            env?: Record<string, string>;
          },
      );
    assert.equal(calls[0]?.command, 'go');
    assert.deepEqual(calls[0]?.env, { GOWORK: 'off', CGO_ENABLED: '0' });
    assert.ok(calls[0]?.args.includes('-trimpath'));
    assert.equal(calls.length, failure === 'compile' ? 1 : 2);
    if (failure === 'none') {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Native build verified:/);
    } else {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /Native build verified:/);
      assert.match(
        result.stderr,
        failure === 'compile'
          ? /Synthetic compile failure/
          : /Native build identity verification failed/,
      );
    }
  }
});
