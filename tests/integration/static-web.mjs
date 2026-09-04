import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { digest, securityHeaders } from '../../tools/web-assets.ts';

// This optional native-Nginx check needs an installed nginx with gzip_static.
// It never starts Docker, uses a system daemon or requires release credentials.
const root = resolve(import.meta.dirname, '../..');
const dist = join(root, 'apps/web/dist');
const manifest = JSON.parse(
  readFileSync(join(dist, 'web-manifest.json'), 'utf8'),
);
const directory = mkdtempSync(join(tmpdir(), 'tailmouse-static-nginx-'));
let nginx;
let browser;
let failure;
try {
  for (const [file, identity] of Object.entries(manifest.files)) {
    assert.match(file, /^[\w./-]+$/u);
    assert.ok(!file.split('/').includes('..') && !file.startsWith('/'));
    const source = readFileSync(join(dist, file));
    assert.equal(source.byteLength, identity.bytes);
    assert.equal(digest(source), identity.sha256);
  }
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = readFileSync(join(root, 'apps/web/nginx.conf'), 'utf8')
    .replace('listen 8080;', `listen 127.0.0.1:${port};`)
    .replace('root /usr/share/nginx/html;', `root ${JSON.stringify(dist)};`)
    .replaceAll('/tmp/tailmouse-', `${directory}/tailmouse-`);
  mkdirSync(join(directory, 'logs'));
  const configPath = join(directory, 'nginx.conf');
  writeFileSync(configPath, config);
  const args = ['-p', `${directory}/`, '-c', configPath];
  execFileSync('nginx', ['-t', ...args], { stdio: 'pipe' });
  nginx = spawn('nginx', [...args, '-g', 'daemon off;'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let startupError;
  nginx.on('error', (error) => {
    startupError = error;
  });
  nginx.stderr.resume(); // No request/error log is persisted by this fixture.
  const base = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    assert.equal(nginx.exitCode, null, 'Nginx exited during startup.');
    try {
      ready = (await fetch(base, { signal: AbortSignal.timeout(200) })).ok;
    } catch {
      /* The bounded readiness wait permits connection refusal only during startup. */
    }
    if (ready) break;
    await delay(20);
  }
  assert.ok(ready, 'Nginx did not become ready.');
  for (const [path, status] of [
    ['', 200],
    ['service-worker.js', 200],
    ['web-manifest.json', 200],
    ['unknown', 404],
  ]) {
    const response = await fetch(base + path, {
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, status);
    for (const [name, value] of Object.entries(securityHeaders))
      assert.equal(response.headers.get(name), value);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    await response.arrayBuffer();
  }
  assert.equal(
    (await fetch(base, { method: 'POST', signal: AbortSignal.timeout(2000) }))
      .status,
    403,
  );
  const wasm = Object.keys(manifest.files).find((file) =>
    file.endsWith('.wasm'),
  );
  const runtime = Object.keys(manifest.files).find(
    (file) => file.startsWith('tailcat/wasm_exec-') && file.endsWith('.js'),
  );
  assert.ok(wasm && runtime);
  const compressed = await fetch(base + wasm, {
    headers: { 'Accept-Encoding': 'gzip' },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(compressed.headers.get('content-type'), 'application/wasm');
  assert.equal(
    compressed.headers.get('cache-control'),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    digest(new Uint8Array(await compressed.arrayBuffer())),
    manifest.files[wasm].sha256,
  );
  browser = await chromium.launch();
  const page = await browser.newPage({ serviceWorkers: 'allow' });
  page.setDefaultTimeout(10_000);
  await page.goto(base);
  await expect(
    page.getByRole('heading', { name: 'TailMouse', exact: true }),
  ).toBeVisible();
  await page.addScriptTag({ url: base + runtime });
  await page.evaluate(async (path) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Wasm initialization deadline exceeded.')),
        10_000,
      );
      globalThis.onTailcatReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const go = new globalThis.Go();
      void WebAssembly.instantiateStreaming(fetch(path), go.importObject)
        .then(({ instance }) => go.run(instance))
        .catch(() => {
          clearTimeout(timer);
          reject(new Error('Wasm initialization failed.'));
        });
    });
  }, base + wasm);
  assert.equal(
    await page.evaluate(() => typeof globalThis.tailcatDial),
    'function',
  );
} catch (error) {
  failure = error;
} finally {
  try {
    if (browser) await browser.close();
  } catch (error) {
    failure ??= error;
  }
  if (nginx && nginx.exitCode === null && nginx.signalCode === null) {
    const exited = new Promise((resolve) => nginx.once('exit', resolve));
    nginx.kill('SIGQUIT');
    const timeout = setTimeout(() => nginx.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timeout);
    if (nginx.signalCode === 'SIGKILL')
      failure ??= new Error('Nginx graceful cleanup exceeded its deadline.');
  }
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    failure ??= error;
  }
}
if (failure) throw failure;
process.stdout.write(
  'Native Nginx static headers, routing, gzip, checksums and real Tailcat Wasm startup passed.\n',
);
