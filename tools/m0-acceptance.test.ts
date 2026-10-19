import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

await test('M0 acceptance redacts browser failures, preserves the primary phase and joins cleanup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'tailmouse-m0-redaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, content: string) => {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  };
  write('package.json', '{"type":"module"}');
  write(
    'apps/web/dist/index.html',
    '<!doctype html><title>Synthetic fixture</title>',
  );
  write(
    'tools/process.mjs',
    `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { dirname } from 'node:path';
    export function run(_, args) {
      if (args[0] === 'tools/build-native.mjs') {
        mkdirSync(dirname(args[1]), { recursive: true });
        writeFileSync(args[1], 'synthetic binary');
      }
    }
    export function runPnpm() {}
  `,
  );
  copyFileSync(
    new URL('./m0-acceptance.mjs', import.meta.url),
    join(root, 'tools/m0-acceptance.mjs'),
  );
  write(
    'loader.mjs',
    `
    import { registerHooks } from 'node:module';
    registerHooks({resolve(specifier, context, next) {
      if (specifier === 'node:child_process' && context.parentURL?.endsWith('/tools/m0-acceptance.mjs'))
        return {url: new URL('./child.mjs', import.meta.url).href, shortCircuit: true};
      return next(specifier, context);
    }});
  `,
  );
  write(
    'child.mjs',
    `
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    export function execFileSync(command, args) {
      return command === 'go' ? 'go1.27.1' : args.includes('status') ? '' : 'a'.repeat(40);
    }
    export function spawn(_, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = child.signalCode = null;
      globalThis.m0FixtureChild = child;
      globalThis.m0FixtureBase = args[args.indexOf('--web-base-url') + 1];
      queueMicrotask(() => child.stdout.write('Open: ' + globalThis.m0FixtureBase + '#/v1/tcSyntheticPrivateMaterial\\n'));
      child.kill = (signal) => {
        if (process.env.M0_TEST_FAILURE === 'force' && signal === 'SIGTERM') return true;
        queueMicrotask(() => {
          child.signalCode = signal;
          child.emit('exit', null, signal);
          process.stdout.write('OWNED_CHILD_REAPED\\n');
        });
        return true;
      };
      return child;
    }
  `,
  );
  write(
    'node_modules/@playwright/test/package.json',
    '{"type":"module","exports":"./index.mjs"}',
  );
  write(
    'node_modules/@playwright/test/index.mjs',
    `
    const failure = () => { throw new Error('http://127.0.0.1/#/v1/tcSyntheticPrivateMaterial'); };
    export const chromium = { async launch() { return {
      async close() {
        if (['cleanup', 'browser_cleanup'].includes(process.env.M0_TEST_FAILURE)) failure();
        if (process.env.M0_TEST_FAILURE === 'stalled_cleanup') return new Promise(() => {});
      },
      async newContext() { return {
        setDefaultTimeout() {},
        async newPage() { return {
          async goto() {
            if (['navigation', 'cleanup', 'force'].includes(process.env.M0_TEST_FAILURE)) failure();
          },
          async waitForFunction() {},
          url() { return globalThis.m0FixtureBase; },
          getByRole() { return { async click() {
            const child = globalThis.m0FixtureChild;
            if (process.env.M0_TEST_FAILURE === 'overflow') child.stderr.write('x'.repeat(65537));
            if (process.env.M0_TEST_FAILURE === 'bare_token') child.stderr.write(JSON.stringify({secret: 'tc' + 'A'.repeat(80)}) + '\\n');
            child.stderr.write(['relay_selected','browser_connected','session_closed'].map(event => JSON.stringify({event})).join('\\n'));
            child.exitCode = 0;
            child.emit('exit', 0, null);
          } }; },
        }; },
        async close() { if (process.env.M0_TEST_FAILURE === 'cleanup') failure(); },
      }; },
    }; } };
  `,
  );
  for (const failure of [
    'navigation',
    'cleanup',
    'force',
    'browser_cleanup',
    'stalled_cleanup',
    'overflow',
    'bare_token',
    'none',
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(root, 'loader.mjs')).href,
        join(root, 'tools/m0-acceptance.mjs'),
        '--custom-host',
        'relay.example.invalid',
      ],
      {
        cwd: root,
        env: { ...process.env, M0_TEST_FAILURE: failure },
        encoding: 'utf8',
        timeout: 15_000,
      },
    );
    assert.ifError(result.error);
    assert.doesNotMatch(result.stderr, /tcSyntheticPrivateMaterial|#\/v1\//u);
    if (failure === 'none') {
      assert.equal(result.status, 0, result.stderr);
      const evidence = JSON.parse(result.stdout) as {
        scenarios: Array<{ result: string }>;
      };
      assert.deepEqual(
        evidence.scenarios.map((item) => item.result),
        ['passed', 'passed'],
      );
      continue;
    }
    assert.equal(result.status, 1);
    if (failure === 'overflow' || failure === 'bare_token') {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /official\/diagnostics/u);
      assert.doesNotMatch(result.stderr, /tcA{80}/u);
      continue;
    }
    if (failure === 'browser_cleanup' || failure === 'stalled_cleanup') {
      assert.equal(
        result.stdout,
        '',
        'Success must not be printed before cleanup completes',
      );
      assert.match(result.stderr, /browser_cleanup/u);
      continue;
    }
    assert.equal(result.stdout, 'OWNED_CHILD_REAPED\n');
    assert.match(result.stderr, /official\/navigation/u);
    if (failure === 'cleanup') {
      assert.match(result.stderr, /official\/context_cleanup/u);
      assert.match(result.stderr, /browser_cleanup/u);
    }
  }
});
