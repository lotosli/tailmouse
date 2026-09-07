import { expect, test as base } from '@playwright/test';
import { securityHeaders } from '../../tools/web-assets.ts';
import { staticServer } from './static-server.ts';
import {
  address,
  cardFixture,
  invitationURL,
  runtimeScript,
} from './session-fixture.ts';

const test = base.extend<{ site: Awaited<ReturnType<typeof staticServer>> }>({
  site: async ({ browserName: _browserName }, use) => {
    const site = await staticServer();
    try {
      await use(site);
    } finally {
      await site.close();
    }
  },
});

test.use({ serviceWorkers: 'allow' });

test('production headers, fixed static cache and offline assets exclude invitation material', async ({
  page,
  context,
  request,
  site,
}) => {
  const requests: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.name));
  context.on('request', (value) => requests.push(value.url()));
  // The existing protocol fixture stays in page memory. The actual worker
  // still downloads and integrity-checks the unmodified production assets.
  await page.addInitScript(
    `${runtimeScript().body}\nglobalThis.onTailcatReady = () => {}; new globalThis.Go().run();`,
  );
  const response = await page.goto(`${site.url}${invitationURL().slice(1)}`);
  for (const [name, value] of Object.entries(securityHeaders))
    expect(response!.headers()[name.toLowerCase()]).toBe(value);
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page).toHaveURL(site.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const manifest = (await (
    await request.get(`${site.url}web-manifest.json`)
  ).json()) as {
    cacheVersion: string;
    files: Record<string, { bytes: number; sha256: string }>;
  };
  const cacheName = `tailmouse-static:/:${manifest.cacheVersion}`;
  const keys = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((entry) => entry.url);
  }, cacheName);
  expect(keys.length).toBeGreaterThanOrEqual(4);
  for (const key of keys) {
    const path = new URL(key).pathname.slice(1);
    expect(manifest.files[path]).toBeDefined();
    expect(path).toMatch(
      /^(assets|tailcat)\/[\w.-]+-[\w-]{8,}\.(js|css|wasm|svg|png|webp|woff2)$/u,
    );
  }
  const stored = await page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const files: { path: string; sha256: string }[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request);
      const bytes = await crypto.subtle.digest(
        'SHA-256',
        await response!.arrayBuffer(),
      );
      files.push({
        path: new URL(request.url).pathname.slice(1),
        sha256: Array.from(new Uint8Array(bytes), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join(''),
      });
    }
    return files;
  }, cacheName);
  for (const file of stored)
    expect(file.sha256).toBe(manifest.files[file.path]!.sha256);
  await page.goto('about:blank');
  await page.goto(site.url);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return {
          controlled: navigator.serviceWorker.controller !== null,
          scope: registration.scope,
          active: registration.active?.state,
          url: location.href,
        };
      }),
    )
    .toEqual({
      controlled: true,
      scope: site.url,
      active: 'activated',
      url: site.url,
    });
  await page.evaluate(async (asset) => {
    await fetch(`${asset}?synthetic-private-query`);
  }, keys[0]!);
  const resolver = `${site.url}api/v1/short-invitations/T6wxZ8`;
  expect(
    await page.evaluate(async (url) => {
      const response = await fetch(url, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      });
      return response.status;
    }, resolver),
  ).toBe(404);
  expect(site.requests).toContain('/api/v1/short-invitations/T6wxZ8');
  const after = await page.evaluate(
    async (name) =>
      (await (await caches.open(name)).keys()).map((entry) => entry.url),
    cacheName,
  );
  expect(after).toEqual(keys);
  const lookup = await page.evaluate(
    async ({ name, asset }) => {
      const cache = await caches.open(name);
      const exact = await cache.match(asset);
      const noVary = await cache.match(asset, { ignoreVary: true });
      return {
        exact: exact !== undefined,
        noVary: noVary !== undefined,
        vary: noVary?.headers.get('vary'),
      };
    },
    { name: cacheName, asset: keys.find((key) => key.endsWith('.wasm'))! },
  );
  expect(
    lookup,
    'Stored Wasm must be reachable by the worker cache lookup',
  ).toMatchObject({ exact: true });
  await site.close();
  expect(
    await page.evaluate(async (url) => {
      try {
        await fetch(url, { cache: 'no-store' });
        return false;
      } catch {
        return true;
      }
    }, resolver),
  ).toBe(true);
  const offline = await page.evaluate(
    async (asset) => {
      const result = await fetch(asset, { cache: 'no-store' });
      return { ok: result.ok, bytes: (await result.arrayBuffer()).byteLength };
    },
    keys.find((key) => key.endsWith('.wasm'))!,
  );
  expect(offline.ok).toBe(true);
  expect(offline.bytes).toBeGreaterThan(0);
  expect(
    await page.evaluate(async (base) => {
      try {
        await fetch(`${base}web-manifest.json`, { cache: 'no-store' });
        return false;
      } catch {
        return true;
      }
    }, site.url),
  ).toBe(true);
  for (const secret of [address, cardFixture, 'synthetic-private'])
    expect(JSON.stringify({ keys, after, stored })).not.toContain(secret);
  expect(
    requests.every(
      (url) =>
        !url.includes('#') &&
        !url.includes(address) &&
        !url.includes(cardFixture),
    ),
  ).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('an update waits for live clients then deletes only its old scoped cache', async ({
  page,
  context,
  site,
}) => {
  await page.goto(site.url);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.goto('about:blank');
  await page.goto(site.url);
  const oldName = await page.evaluate(async () => {
    await caches.open('unrelated-application');
    await caches.open('tailmouse-static:/another/:old');
    return (await caches.keys()).find((name) =>
      name.startsWith('tailmouse-static:/:'),
    )!;
  });
  site.update();
  await page.evaluate(async () => {
    await (await navigator.serviceWorker.ready).update();
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await navigator.serviceWorker.ready).waiting?.state,
      ),
    )
    .toBe('installed');
  expect(await page.evaluate(async () => caches.keys())).toEqual(
    expect.arrayContaining([oldName, `${oldName}-next`]),
  );
  await page.close();
  const nextPage = await context.newPage();
  await nextPage.goto(site.url);
  await expect
    .poll(() => nextPage.evaluate(async () => (await caches.keys()).sort()))
    .toEqual(
      [
        'unrelated-application',
        'tailmouse-static:/another/:old',
        `${oldName}-next`,
      ].sort(),
    );
  await nextPage.close();
});

test('unknown routes are not application pages and executable assets stay local', async ({
  page,
  request,
}) => {
  const unknown = await request.get('/not-a-tailmouse-route');
  expect(unknown.status()).toBe(404);
  await page.goto('/');
  const assets = await page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
        'script[src], link[href]',
      ),
    ].map((element) =>
      element instanceof HTMLScriptElement ? element.src : element.href,
    ),
  );
  expect(assets.length).toBeGreaterThan(0);
  expect(
    assets.every((url) => new URL(url).origin === 'http://127.0.0.1:4173'),
  ).toBe(true);
});

test('integrity rejects corrupted hashed assets without retaining partial worker caches', async ({
  page,
  request,
  site,
}) => {
  // A same-origin 404 is an inert document, without the application's automatic
  // worker registration. No route mocking disables the browser HTTP cache.
  await page.goto(`${site.url}unknown`);
  const manifest = (await (
    await request.get(`${site.url}web-manifest.json`)
  ).json()) as { files: Record<string, unknown> };
  const wasm = Object.keys(manifest.files).find((file) =>
    file.endsWith('.wasm'),
  )!;
  site.corruptWasm(true);
  expect(
    await page.evaluate(
      async (url) =>
        (await (
          await fetch(url, { cache: 'force-cache', credentials: 'omit' })
        ).text()) === 'corrupted synthetic Wasm',
      site.url + wasm,
    ),
  ).toBe(true);
  // Keep the corrupt source available for engines that revalidate HTTP cache.
  // Whether the bytes are retained or fetched again, SRI must reject them.
  expect(
    await page.evaluate(
      async (url) =>
        (await (
          await fetch(url, { cache: 'force-cache', credentials: 'omit' })
        ).text()) === 'corrupted synthetic Wasm',
      site.url + wasm,
    ),
  ).toBe(true);
  const state = await page.evaluate(async (url) => {
    const registration = await navigator.serviceWorker.register(url, {
      updateViaCache: 'none',
    });
    const worker = registration.installing;
    if (worker === null) throw new Error('Expected an installing worker.');
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Worker integrity decision timed out.')),
        10_000,
      );
      const check = (): void => {
        if (worker.state === 'redundant' || worker.state === 'activated') {
          clearTimeout(timeout);
          worker.removeEventListener('statechange', check);
          resolve(worker.state);
        }
      };
      worker.addEventListener('statechange', check);
      check();
    });
  }, `${site.url}service-worker.js`);
  expect(state).toBe('redundant');
  expect(await page.evaluate(async () => caches.keys())).toEqual([]);
  expect(
    await page.evaluate(() => navigator.serviceWorker.controller),
  ).toBeNull();
});
