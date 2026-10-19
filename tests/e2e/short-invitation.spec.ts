import { expect, test, type Page } from '@playwright/test';
import {
  installTailcatBridge,
  leashCardFixture,
  runtimeScript,
} from './session-fixture.ts';

const origin = 'https://link.tailmouse.com';
const code = 'T6wxZ8';
const accessCode = '2345-6789-ABCD-EFGH';

// All official-origin requests are fulfilled from the local production build
// or synthetic lease state. No request reaches Cloudflare or a public relay.
async function shortSite(page: Page, authRejections = false) {
  let active = true;
  const requests: {
    path: string;
    method: string;
    body: string | null;
    headers: Record<string, string>;
  }[] = [];
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      requests.push({
        path: url.pathname,
        method: request.method(),
        body: request.postData(),
        headers: await request.allHeaders(),
      });
      await route.fulfill({
        status:
          active && url.pathname === `/api/v1/short-invitations/${code}`
            ? 200
            : 404,
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        },
        body: JSON.stringify(
          active && url.pathname === `/api/v1/short-invitations/${code}`
            ? {
                invitation: `${origin}/#/v1/${leashCardFixture}`,
                expiresAt: Date.now() + 900_000,
              }
            : { error: 'unavailable' },
        ),
      });
      return;
    }
    const path = /^\/[0-9A-Za-z]{6}$/u.test(url.pathname) ? '/' : url.pathname;
    const response = await route.fetch({
      url: `http://127.0.0.1:4173${path}${url.search}`,
      headers: { Host: '127.0.0.1:4173' },
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
  await installTailcatBridge(page, (route) =>
    route.fulfill(
      runtimeScript({ protected: true, terminal: true, authRejections }),
    ),
  );
  return {
    requests,
    delete: () => {
      active = false;
    },
  };
}

test('short invitations prompt separately before dialing, reconnect explicitly and clear on reload', async ({
  page,
}) => {
  const site = await shortSite(page);
  const output: string[] = [];
  page.on('console', (entry) => output.push(entry.text()));
  page.on('pageerror', (error) => output.push(error.message));
  await page.goto(`${origin}/${code}`);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByLabel('Access code')).toBeVisible();
  expect(await page.evaluate('globalThis.testDialCount')).toBeUndefined();
  await page.getByLabel('Access code').fill(accessCode);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByLabel('Connection').getByRole('status')).toHaveText(
    'Connected',
  );
  await expect(
    page.getByLabel('Process status').getByText('running', { exact: true }),
  ).toBeVisible();
  await page.evaluate('globalThis.testDisconnect()');
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByLabel('Connection').getByRole('status')).toHaveText(
    'Connected',
  );
  await expect(page.getByLabel('Access code')).toHaveCount(0);
  expect(site.requests).toHaveLength(1);
  expect(site.requests[0]).toMatchObject({
    path: `/api/v1/short-invitations/${code}`,
    method: 'GET',
    body: null,
  });
  expect(site.requests[0]!.headers.referer).toBeUndefined();
  expect(site.requests[0]!.headers.authorization).toBeUndefined();
  const state = await page.evaluate(async () => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    history: history.state as unknown,
    databases: await indexedDB.databases(),
    timing: performance.getEntriesByType('resource').map((entry) => entry.name),
    cacheKeys: await caches.keys(),
    document: document.documentElement.outerHTML,
  }));
  expect(state).toMatchObject({
    local: [],
    session: [],
    history: null,
    databases: [],
    cacheKeys: [],
  });
  expect(state.timing.some((url) => url.includes('/api/'))).toBe(false);
  for (const secret of [
    accessCode,
    accessCode.replaceAll('-', ''),
    leashCardFixture,
    'tcSyntheticPlaywrightCredential',
  ])
    expect(
      JSON.stringify({ state, requests: site.requests, output }),
    ).not.toContain(secret);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let them test your work. Skip the setup.',
    { useInnerText: true },
  );
  await expect(page.getByLabel('Access code')).toHaveCount(0);
  expect(site.requests).toHaveLength(1);
});

test('wrong-case, deleted and offline locators remain unavailable without a connection action', async ({
  page,
}) => {
  const site = await shortSite(page);
  await page.goto(`${origin}/t6wxz8`);
  await expect(page.getByRole('alert')).toHaveText(
    'This invitation is unavailable. Request a new link from the host.',
  );
  await expect(page.getByLabel('Access code')).toHaveCount(0);
  await expect(page).toHaveURL(`${origin}/`);
  site.delete();
  await page.goto(`${origin}/${code}`);
  await expect(page.getByRole('alert')).toHaveText(
    'This invitation is unavailable. Request a new link from the host.',
  );
  await page.route(`${origin}/api/**`, (route) =>
    route.abort('internetdisconnected'),
  );
  await page.goto(`${origin}/${code}`);
  await expect(page.getByRole('alert')).toHaveText(
    'This invitation is unavailable. Request a new link from the host.',
  );
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
  expect(await page.evaluate('globalThis.testDialCount')).toBeUndefined();
});

test('short-link authentication reports rejected proofs and honors Host cooldown before a fresh attempt', async ({
  page,
}) => {
  const site = await shortSite(page, true);
  await page.goto(`${origin}/${code}`);
  const field = page.getByLabel('Access code');
  const connect = page.getByRole('button', { name: 'Connect', exact: true });
  await field.fill(accessCode);
  await connect.click();
  await expect(page.getByRole('alert')).toHaveText('Authentication failed.');
  await expect(field).toHaveValue('');
  await field.fill(accessCode);
  await connect.click();
  await expect(page.getByRole('alert')).toHaveText(
    'Authentication attempts are temporarily limited.',
  );
  await expect(connect).toBeDisabled();
  await expect(connect).toBeEnabled({ timeout: 4000 });
  await field.fill(accessCode);
  await connect.click();
  await expect(page.getByLabel('Connection').getByRole('status')).toHaveText(
    'Connected',
  );
  expect(site.requests).toHaveLength(1);
  expect(JSON.stringify(site.requests)).not.toContain(accessCode);
});

test('short-path and fragment ambiguity is rejected and page restoration cannot reuse a resolved invitation', async ({
  page,
}) => {
  const site = await shortSite(page);
  await page.goto(`${origin}/${code}#/v1/${leashCardFixture}`);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByRole('alert')).toContainText('unavailable');
  expect(site.requests).toEqual([]);
  await page.goto(`${origin}/${code}`);
  await page.getByLabel('Access code').fill(accessCode);
  await page.goto('about:blank');
  await page.goBack();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Request a new link' })
      .or(page.getByRole('heading', { level: 1, name: /Let them test/u })),
  ).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: /^Connected$/u }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Access code')).toHaveCount(0);
  expect(site.requests).toHaveLength(1);
  expect(await page.locator('body').innerText()).not.toContain(accessCode);
});
