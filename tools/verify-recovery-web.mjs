import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from '@playwright/test';

const root = resolve(import.meta.dirname, '../.artifacts/web-recovery');
const evidence = resolve(
  import.meta.dirname,
  '../.artifacts/web-recovery-checks',
);
const manifest = JSON.parse(
  await readFile(resolve(root, 'web-manifest.json'), 'utf8'),
);
const assets = new Map();
for (const [name, metadata] of Object.entries(manifest.files)) {
  const body = await readFile(resolve(root, name));
  assert.equal(body.length, metadata.bytes, `Length: ${name}`);
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    metadata.sha256,
    `Integrity: ${name}`,
  );
  assets.set('/' + name, { body, metadata });
}
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const path = ['/', '/.tailmouse/workspace/'].includes(url.pathname)
    ? '/index.html'
    : url.pathname;
  const asset = assets.get(path);
  if (!asset || request.method !== 'GET') {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, {
    ...manifest.staticHosting.requiredHeaders,
    'Content-Type': asset.metadata.contentType,
    'Cache-Control': 'no-store',
    ...(asset.metadata.contentEncoding
      ? { 'Content-Encoding': asset.metadata.contentEncoding }
      : {}),
  });
  response.end(asset.body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(evidence, { recursive: true });
const results = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    const browser = await engine.launch(
      name === 'chromium' ? { chromiumSandbox: true } : {},
    );
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
        });
        try {
          const page = await context.newPage();
          const errors = [];
          const external = [];
          page.on('pageerror', (error) => errors.push(error.message));
          page.on('request', (request) => {
            if (!request.url().startsWith(origin)) external.push(request.url());
          });
          await page.goto(origin);
          await page.getByRole('heading', { name: /Let them test/ }).waitFor();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth,
            ),
            false,
            'Landing overflow',
          );
          await page.screenshot({
            path: resolve(evidence, `${name}-${width}.png`),
          });
          for (const section of [
            'get-started',
            'workflow',
            'guide',
            'permissions',
            'compatibility',
            'escape',
          ]) {
            await page.goto(`${origin}/#${section}`);
            await page.reload();
            await page
              .getByRole('heading', { name: /Let them test/ })
              .waitFor();
            assert.equal(await page.locator(`#${section}`).count(), 1);
          }
          await page.getByRole('button', { name: /5 End sharing/ }).click();
          await page
            .getByRole('heading', {
              name: 'Close access when the task is done.',
            })
            .waitFor();
          await page.goto(`${origin}/.tailmouse/workspace/`);
          await page
            .getByRole('link', { name: 'TailMouse home', exact: true })
            .waitFor();
          await page.getByText('Help & feedback', { exact: true }).click();
          await page
            .getByRole('button', { name: 'Prepare a safe report' })
            .click();
          assert.match(
            await page.getByLabel('Feedback report').innerText(),
            /Stage: invitation/u,
          );
          await page.goto(
            `${origin}/.tailmouse/workspace/#tm=synthetic-invalid`,
          );
          await page.getByRole('alert').waitFor();
          await page.waitForFunction(() => location.hash === '');
          assert.equal(new URL(page.url()).hash, '');
          await page.goto(`${origin}/#/v1/synthetic-invalid`);
          await page.getByText(/invalid or unsupported/).waitFor();
          await page.waitForFunction(() => location.hash === '');
          assert.equal(new URL(page.url()).hash, '');
          assert.equal(
            await page
              .locator('meta[property="og:title"]')
              .getAttribute('content'),
            'TailMouse — Your machine. Their browser.',
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
          results.push({
            browser: name,
            version: browser.version(),
            width,
            checks:
              'landing, sections/reload, workflow, missing invitation, malformed resource and legacy invitation erasure, generic metadata, no external requests',
            passed: true,
          });
          console.log(`${name} ${width}px passed`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    resolve(evidence, 'results.json'),
    JSON.stringify({ version: manifest.version, results }, null, 2) + '\n',
  );
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
