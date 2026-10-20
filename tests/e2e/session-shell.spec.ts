import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  address,
  cardFixture,
  installTailcatBridge,
  runtimeScript,
  invitationURL,
} from './session-fixture.ts';

type DownloadFixtureWindow = typeof window & {
  testWasmBody?: ReadableStreamDefaultController<Uint8Array>;
  testWasmDownloads?: number;
  testReleaseDial?: () => void;
  testDialCount?: number;
};

test('exact mode-specific MouseCard identifiers negotiate only their protocol and reject other ranges before dialing', async ({
  page,
}) => {
  const corpus = JSON.parse(
    readFileSync(
      new URL('../../protocol/fixtures/v1/mousecards.json', import.meta.url),
      'utf8',
    ),
  ) as {
    cases: Array<{
      id: string;
      accept: boolean;
      protocolMin?: number;
      protocolMax?: number;
      hex: string;
    }>;
  };
  await installTailcatBridge(page);
  for (const fixture of corpus.cases) {
    await page.goto('about:blank');
    const fragment = Buffer.from(fixture.hex, 'hex').toString('base64url');
    await page.goto(`/#/v1/${fragment}`);
    if (fixture.accept) {
      const connection = page.getByRole('region', { name: 'Connection' });
      await expect(connection.getByRole('status'), fixture.id).toHaveText(
        'Connected',
      );
      expect(
        await page.evaluate('globalThis.testHelloProtocol'),
        fixture.id,
      ).toEqual({
        minimum: fixture.protocolMin,
        maximum: fixture.protocolMax,
      });
      await page
        .getByRole('button', { name: 'Exit session', exact: true })
        .click();
      await expect(connection.getByRole('status')).toHaveText(
        'Session closed.',
      );
    } else {
      await expect(page.getByRole('alert'), fixture.id).toHaveText(
        'This invitation is invalid or unsupported. Request a new link from the host.',
      );
      expect(
        await page.evaluate('globalThis.testDialCount'),
        fixture.id,
      ).toBeUndefined();
    }
    await expect(page).toHaveURL('http://127.0.0.1:4173/');
    expect(await page.locator('body').innerText()).not.toContain(
      'tcSyntheticRangeCredential',
    );
  }
});

async function controlWasmDownload(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalFetch = globalThis.fetch.bind(globalThis);
    const fixture = window as DownloadFixtureWindow;
    fixture.testWasmDownloads = 0;
    globalThis.fetch = (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        location.href,
      );
      if (!/\/tailcat\/tailcat-web-[^/]+\.wasm$/u.test(url.pathname))
        return originalFetch(input, init);
      fixture.testWasmDownloads!++;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              fixture.testWasmBody = controller;
            },
          }),
          {
            headers: {
              'Content-Type': 'application/wasm',
              'Content-Length': '8',
            },
          },
        ),
      );
    };
  });
}

test('Wasm byte progress precedes the combined relay handshake and usable session', async ({
  page,
}, info) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ pauseDial: true })),
  );
  await controlWasmDownload(page);
  await page.goto(invitationURL());
  const progress = page.getByRole('progressbar', {
    name: 'Tailcat WebAssembly download',
  });
  await expect(progress).toHaveAttribute('value', '0');
  await page.waitForFunction(
    () => (window as DownloadFixtureWindow).testWasmBody !== undefined,
  );
  await page.evaluate(() =>
    (window as DownloadFixtureWindow).testWasmBody!.enqueue(
      new Uint8Array([0, 97, 115, 109]),
    ),
  );
  await expect(progress).toHaveAttribute('value', '50');
  await expect(page.getByText('50%', { exact: true })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  if (info.project.name === 'mobile-chrome') {
    await page.screenshot({
      path: '.artifacts/startup-download-50-mobile-chrome.png',
      fullPage: true,
    });
  }
  await page.evaluate(() => {
    const body = (window as DownloadFixtureWindow).testWasmBody!;
    body.enqueue(new Uint8Array([1, 0, 0, 0]));
    body.close();
  });
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connecting to relay / Meow handshake');
  await expect(progress).toHaveCount(0);
  await page.evaluate(() =>
    (window as DownloadFixtureWindow).testReleaseDial!(),
  );
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');
  expect(
    await page.evaluate(
      () => (window as DownloadFixtureWindow).testWasmDownloads,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as DownloadFixtureWindow).testDialCount),
  ).toBe(1);
  await page.getByRole('button', { name: 'Exit session', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Session closed.');
});

test('partial Wasm failure is safe and explicit retry starts progress again', async ({
  page,
}) => {
  await installTailcatBridge(page);
  await controlWasmDownload(page);
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  page.on('pageerror', (error) => messages.push(error.message));
  await page.goto(invitationURL());
  const progress = page.getByRole('progressbar', {
    name: 'Tailcat WebAssembly download',
  });
  await page.waitForFunction(
    () => (window as DownloadFixtureWindow).testWasmBody !== undefined,
  );
  await page.evaluate(() =>
    (window as DownloadFixtureWindow).testWasmBody!.enqueue(
      new Uint8Array([0, 97, 115, 109]),
    ),
  );
  await expect(progress).toHaveAttribute('value', '50');
  await page.evaluate(
    (secret) =>
      (window as DownloadFixtureWindow).testWasmBody!.error(new Error(secret)),
    address,
  );
  await expect(page.getByRole('alert')).toHaveText(
    'Tailcat WebAssembly failed to initialize.',
  );
  await expect(progress).toHaveCount(0);
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  expect(
    await page.evaluate(
      () => (window as DownloadFixtureWindow).testDialCount ?? 0,
    ),
  ).toBe(0);
  await page
    .getByRole('button', { name: 'Retry connection', exact: true })
    .click();
  await expect(progress).toHaveAttribute('value', '0');
  await page.waitForFunction(
    () => (window as DownloadFixtureWindow).testWasmDownloads === 2,
  );
  await page.evaluate(() => {
    const body = (window as DownloadFixtureWindow).testWasmBody!;
    body.enqueue(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    body.close();
  });
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');
  await expect(progress).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(address);
  expect(messages.join('\n')).not.toContain(address);
  await page.getByRole('button', { name: 'Exit session', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Session closed.');
});

test('fragment stays out of requests, disappears from history, and establishes a session', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await installTailcatBridge(page);

  await page.goto(invitationURL());
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toContainText('Loading Tailcat WebAssembly');
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toContainText('Connected');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  expect(requests).not.toEqual([]);
  for (const request of requests) {
    expect(request).not.toContain('#');
    expect(request).not.toContain(address);
  }
  await expect(
    page.getByText('official: relay.example.com', { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('latency')).toContainText('ms /');
  await page.getByText('About TailMouse', { exact: true }).click();
  await expect(
    page.getByText('TMOUSE Leash protocol 2', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Tailcat revision [0-9a-f]{40}$/u),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Session closed.');
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
});

test('a redacted load failure retries only after user action', async ({
  page,
}) => {
  let failScript = true;
  await installTailcatBridge(page, (route) => {
    if (failScript) {
      return route.abort('failed');
    }
    return route.fulfill(runtimeScript());
  });

  await page.goto(invitationURL());
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('runtime script failed to load');
  await expect(alert).not.toContainText(address);
  failScript = false;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toContainText('Connected');
});

test('malformed invitation is removed and rejected without a connection attempt', async ({
  page,
}) => {
  await page.goto('/#/v1/not+base64');
  await expect(page.getByRole('alert')).toContainText('invalid or unsupported');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
});

test('invitation is memory-only across reload and stays out of storage, referrers, and logs', async ({
  page,
}) => {
  const outputs: string[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  page.on('console', (message) => outputs.push(message.text()));
  page.on('pageerror', (error) => outputs.push(error.message));
  page.on('request', (request) =>
    requests.push({ url: request.url(), headers: request.headers() }),
  );
  await installTailcatBridge(page);
  await page.goto(invitationURL());
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toContainText('Connected');

  const persistentState = await page.evaluate(async () => {
    const cacheEntries: { url: string; body: string }[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        cacheEntries.push({
          url: request.url,
          body: response ? await response.text() : '',
        });
      }
    }
    return {
      cacheEntries,
      databases: await indexedDB.databases(),
      historyState: history.state as unknown,
      localStorage: Object.entries(localStorage),
      referrer: document.referrer,
      sessionStorage: Object.entries(sessionStorage),
      visibleDocument: document.documentElement.outerHTML,
    };
  });
  expect(persistentState.historyState).toBeNull();
  expect(persistentState.localStorage).toEqual([]);
  expect(persistentState.sessionStorage).toEqual([]);
  expect(persistentState.databases).toEqual([]);
  expect(persistentState.referrer).toBe('');

  const beforeReload = requests.length;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let them test your work. Skip the setup.',
    { useInnerText: true },
  );
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
  expect(
    requests
      .slice(beforeReload)
      .some((request) => request.url.includes('/tailcat/')),
  ).toBe(false);
  for (const request of requests) {
    expect(request.headers.referer).toBeUndefined();
  }
  const inspected = JSON.stringify({ outputs, persistentState, requests });
  for (const secret of [address, cardFixture, '#/v1/']) {
    expect(inspected).not.toContain(secret);
  }
});

test('protected access stays out of durable state and page-cache restoration', async ({
  page,
}) => {
  const outputs: string[] = [];
  page.on('console', (message) => outputs.push(message.text()));
  page.on('pageerror', (error) => outputs.push(error.message));
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ protected: true, terminal: true })),
  );
  await page.goto(invitationURL('leash'));
  const code = '2345-6789-ABCD-EFGH';
  const field = page.getByLabel('Access code');
  await expect(field).toBeVisible();
  await field.fill(code);
  expect(await field.getAttribute('value')).toBeNull();
  expect(
    await page.locator('html').evaluate((node) => node.outerHTML),
  ).not.toContain(code);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');

  const persistent = await page.evaluate(async () => {
    const cacheEntries: { body: string; url: string }[] = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        cacheEntries.push({
          body: response ? await response.text() : '',
          url: request.url,
        });
      }
    }
    return {
      cacheEntries,
      databases: await indexedDB.databases(),
      historyState: history.state as unknown,
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
      visibleDocument: document.documentElement.outerHTML,
    };
  });
  expect(persistent.historyState).toBeNull();
  expect(persistent.localStorage).toEqual([]);
  expect(persistent.sessionStorage).toEqual([]);
  expect(persistent.databases).toEqual([]);
  const inspected = JSON.stringify({ outputs, persistent });
  for (const secret of [code, code.replaceAll('-', ''), address, cardFixture])
    expect(inspected).not.toContain(secret);

  await page.goto('about:blank');
  await page.goBack();
  // A bfcache restore rejects the old session; a document reload shows home.
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Request a new link from the host.' })
      .or(page.getByRole('heading', { level: 1, name: /Let them test/u })),
  ).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Connection' })
      .getByRole('status')
      .filter({ hasText: /^Connected$/u }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Access code')).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(code);
});

test('readonly capability comes from the host and is not inferred from the invitation', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ readonly: true })),
  );
  await page.goto(invitationURL('leash'));
  const connection = page.getByRole('region', { name: 'Connection' });
  await expect(connection.getByRole('status')).toHaveText('Connected');
  await expect(
    connection.getByText('Read only', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'TailMouse Leash' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Session closed.');
});

test('busy is retryable and peer details stay redacted', async ({ page }) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ rejection: 'SESSION_BUSY' })),
  );
  await page.goto(invitationURL());
  await expect(page.getByRole('alert')).toContainText('Another browser');
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText('tcSyntheticPeerSecret');
  await expect.poll(() => page.evaluate('globalThis.testDialCount')).toBe(1);
});

test('a timed-out handshake closes its stream and retries only after explicit input', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(
      runtimeScript({ firstHandshakeTimeout: true, terminal: true }),
    ),
  );
  await page.goto(invitationURL('leash'));
  const connection = page.getByRole('region', { name: 'Connection' });
  await expect(connection.getByRole('alert')).toHaveText(
    'The session handshake timed out.',
    { timeout: 15_000 },
  );
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect.poll(() => page.evaluate('globalThis.testDialCount')).toBe(1);
  await expect
    .poll(() => page.evaluate('globalThis.testProtocolEvents'))
    .toContain('closed');
  await expect(page.getByRole('textbox', { name: 'Paste text' })).toHaveCount(
    0,
  );
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected');
  await expect.poll(() => page.evaluate('globalThis.testDialCount')).toBe(2);
  await expect(page.getByRole('textbox', { name: 'Paste text' })).toHaveValue(
    '',
  );
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(connection.getByRole('status')).toHaveText('Session closed.');
});

test('protocol mismatch is terminal and peer details stay redacted', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ rejection: 'PROTOCOL_MISMATCH' })),
  );
  await page.goto(invitationURL());
  await expect(page.getByRole('alert')).toContainText(
    'protocol versions do not overlap',
  );
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('tcSyntheticPeerSecret');
});

for (const [mode, oversizedFrame] of [
  ['leash', 'global'],
  ['leash', 'terminal'],
] as const) {
  test(`${mode} rejects an oversized ${oversizedFrame} frame with one safe notification before closing`, async ({
    page,
  }) => {
    await installTailcatBridge(page, (route) =>
      route.fulfill(runtimeScript({ oversizedFrame })),
    );
    await page.goto(invitationURL(mode));
    await expect(page.getByRole('alert')).toContainText(
      'frame exceeds its limit',
    );
    await expect(
      page.getByRole('button', { name: 'Retry connection' }),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate('globalThis.testProtocolEvents'))
      .toEqual(['FRAME_TOO_LARGE', 'fin', 'closed']);
    expect(await page.evaluate('globalThis.testProtocolNotice')).toEqual({
      code: 'FRAME_TOO_LARGE',
      message: 'TMOUSE/1 frame exceeds its limit.',
      retryable: false,
    });
    expect(await page.evaluate('globalThis.testDialCount')).toBe(1);
    await expect(page).toHaveURL('http://127.0.0.1:4173/');
    for (const secret of [address, cardFixture])
      await expect(page.locator('body')).not.toContainText(secret);
  });
}

test('disconnected sessions reconnect only on explicit retry', async ({
  page,
}) => {
  await installTailcatBridge(page);
  await page.goto(invitationURL());
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');
  await page.evaluate('globalThis.testDisconnect()');
  await expect(page.getByRole('alert')).toContainText('session disconnected');
  expect(await page.evaluate('globalThis.testDialCount')).toBe(1);
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');
  expect(await page.evaluate('globalThis.testDialCount')).toBe(2);
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Session closed.');
});

test('expired invitation shows a safe terminal error before loading transport', async ({
  page,
}) => {
  const expired = Buffer.from(cardFixture, 'base64url');
  expired.writeUInt32BE(1_700_000_000, 7);
  const transportRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/tailcat/'))
      transportRequests.push(request.url());
  });
  await page.goto(`/#/v1/${expired.toString('base64url')}`);
  await expect(page.getByRole('alert')).toContainText('invitation has expired');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
  expect(transportRequests).toEqual([]);
  await expect(page.getByRole('alert')).not.toContainText(address);
});
