import { expect, test, type Page, type Route } from '@playwright/test';

const address = 'tcSyntheticPlaywrightCredential';
// Canonical CBOR for the synthetic MouseCard returned by invitationURL.
const cardFixture =
  'qGFhAWFlGnE_swBhbWZlc2NhcGVhcBmtIWFzUAkJCQkJCQkJCQkJCQkJCQlhdHgfdGNTeW50aGV0aWNQbGF5d3JpZ2h0Q3JlZGVudGlhbGF2AWF6AQ';

test('fragment stays out of requests, disappears from history, and echoes', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await installTailcatBridge(page);

  await page.goto(invitationURL());
  await expect(page.getByRole('status')).toContainText(
    'Loading Tailcat WebAssembly',
  );
  await expect(page.getByRole('status')).toContainText(
    'Meowed: TMOUSE-M0-HELLO',
  );
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  expect(requests).not.toEqual([]);
  for (const request of requests) {
    expect(request).not.toContain('#');
    expect(request).not.toContain(address);
  }
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
  await expect(page.getByRole('status')).toContainText(
    'Meowed: TMOUSE-M0-HELLO',
  );
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

async function installTailcatBridge(
  page: Page,
  runtimeHandler: (route: Route) => Promise<unknown> = (route) =>
    route.fulfill(runtimeScript()),
): Promise<void> {
  await page.route('**/tailcat/wasm_exec.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtimeHandler(route);
  });
  await page.route('**/tailcat/tailcat-web.wasm', (route) =>
    route.fulfill({
      body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      contentType: 'application/wasm',
      status: 200,
    }),
  );
}

function runtimeScript() {
  return {
    body: `
      globalThis.Go = class {
        importObject = {};
        run() {
          let echoed;
          globalThis.tailcatDial = async () => ({
            port: 44321,
            read: async () => echoed,
            write: async (data) => { echoed = data.slice(); },
            close: () => undefined,
          });
          globalThis.onTailcatReady();
          return new Promise(() => {});
        }
      };
    `,
    contentType: 'text/javascript',
    status: 200,
  };
}

function invitationURL(): string {
  return `/#/v1/${cardFixture}`;
}
