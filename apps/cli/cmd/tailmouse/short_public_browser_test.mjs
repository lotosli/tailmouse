import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

let stage = 'input';

export function validatePublicShortInput(request) {
  if (
    request === null ||
    typeof request !== 'object' ||
    Object.keys(request).sort().join(',') !== 'accessCode,bitmap,url' ||
    typeof request.url !== 'string' ||
    !/^https:\/\/link\.tailmouse\.com\/[0-9A-Za-z]{6}$/u.test(request.url) ||
    typeof request.accessCode !== 'string' ||
    !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/u.test(request.accessCode) ||
    !Array.isArray(request.bitmap) ||
    request.bitmap.length !== 37 ||
    !request.bitmap.every(
      (row, y) =>
        Array.isArray(row) &&
        row.length === 37 &&
        row.every(
          (dark, x) =>
            typeof dark === 'boolean' &&
            (!(x < 4 || y < 4 || x >= 33 || y >= 33) || !dark),
        ),
    )
  )
    throw new Error('INPUT_INVALID');
  return request;
}

async function verifyDeleted(url) {
  const endpoint = new URL(url);
  endpoint.pathname = `/api/v1/short-invitations${endpoint.pathname}`;
  const deadline = performance.now() + 15_000;
  for (let attempt = 0; attempt < 12; attempt++) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    const response = await fetch(endpoint, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(Math.min(2000, remaining)),
    });
    if (
      response.headers.get('cache-control') !== 'no-store' ||
      response.headers.get('referrer-policy') !== 'no-referrer' ||
      ![200, 404].includes(response.status)
    ) {
      await response.body?.cancel();
      throw new Error('DELETE_INVALID');
    }
    if (response.status === 200) {
      await response.body?.cancel();
      if (attempt === 11 || deadline - performance.now() <= 1000) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    const reader = response.body.getReader();
    const body = new Uint8Array(2048);
    let used = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (used + value.length > body.length)
          throw new Error('DELETE_BODY_LIMIT');
        body.set(value, used);
        used += value.length;
      }
      const result = JSON.parse(
        new TextDecoder().decode(body.subarray(0, used)),
      );
      if (
        Object.keys(result).join(',') !== 'error' ||
        result.error !== 'invitation_unavailable'
      )
        throw new Error('DELETE_BODY_INVALID');
    } finally {
      body.fill(0);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return;
  }
  throw new Error('DELETE_NOT_OBSERVED');
}

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 32768) throw new Error('INPUT_LIMIT');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  let request;
  try {
    request = validatePublicShortInput(JSON.parse(input.toString('utf8')));
  } finally {
    input.fill(0);
  }
  stage = 'browser-launch';
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  try {
    let context = await browser.newContext({
      viewport: { width: 900, height: 900 },
    });
    context.setDefaultTimeout(10_000);
    let page = await context.newPage();
    stage = 'compact-qr';
    await page.route('http://127.0.0.1/qr', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>QR acceptance</title>',
      }),
    );
    await page.goto('http://127.0.0.1/qr');
    await page.evaluate(
      async ({ bitmap, url }) => {
        if (typeof BarcodeDetector === 'undefined')
          throw new Error('QR_UNAVAILABLE');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 37 * 4;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = 'white';
        drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = 'black';
        bitmap.forEach((row, y) =>
          row.forEach((dark, x) => {
            if (dark) drawing.fillRect(x * 4, y * 4, 4, 4);
          }),
        );
        const decoded = await new BarcodeDetector({
          formats: ['qr_code'],
        }).detect(canvas);
        if (decoded.length !== 1 || decoded[0].rawValue !== url)
          throw new Error('QR_MISMATCH');
      },
      { bitmap: request.bitmap, url: request.url },
    );
    request.bitmap = [];
    let resolverRequests = 0;
    let invalidResolverRequest = false;
    const connect = async () => {
      page.on('request', (operation) => {
        if (!operation.url().includes('/api/v1/short-invitations')) return;
        resolverRequests++;
        const expected = request.url.replace(
          'https://link.tailmouse.com/',
          'https://link.tailmouse.com/api/v1/short-invitations/',
        );
        if (
          operation.url() !== expected ||
          operation.method() !== 'GET' ||
          operation.postData() !== null ||
          operation.headers().authorization !== undefined
        )
          invalidResolverRequest = true;
      });
      await page.goto(request.url, { timeout: 30_000 });
      await expect(page.getByLabel('Access code')).toBeVisible({
        timeout: 30_000,
      });
      if (page.url() !== 'https://link.tailmouse.com/')
        throw new Error('URL_NOT_CLEAN');
      await expect(
        page.getByRole('region', { name: 'Terminal output' }),
      ).toHaveCount(0);
      await page.getByLabel('Access code').fill(request.accessCode);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(
        page.getByRole('region', { name: 'Connection' }).getByRole('status'),
      ).toHaveText('Connected', { timeout: 30_000 });
      await page
        .getByRole('checkbox', { name: 'Screen reader support' })
        .check();
    };
    const paste = async (value) => {
      await page.getByRole('textbox', { name: 'Paste text' }).fill(value);
      await page.getByRole('button', { name: 'Send paste' }).click();
      // Bracketed paste inserts text; zsh needs a separate terminal Enter.
      await page.getByRole('button', { name: 'Open keyboard' }).click();
      await page.keyboard.press('Enter');
    };
    stage = 'protected-public-connect';
    await connect();
    const pid = await page.getByText(/^PID \d+$/u).innerText();
    stage = 'zsh-input-output';
    await paste(
      'PUBLIC_SHORT_STATE=731; printf "public-short-%s\\n" "$((6 * 7))"; printf "public-short-unicode:%s\\n" "🐈"',
    );
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toContainText('public-short-42');
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toContainText('public-short-unicode:🐈');
    stage = 'disconnect';
    await page.getByRole('button', { name: 'Exit session' }).click();
    await expect(
      page.getByText('Session closed.', { exact: true }),
    ).toBeVisible();
    await context.close();
    context = await browser.newContext({
      viewport: { width: 900, height: 900 },
    });
    context.setDefaultTimeout(10_000);
    page = await context.newPage();
    stage = 'fresh-stream-reconnect';
    await connect();
    request.accessCode = '';
    await expect(page.getByText(pid, { exact: true })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toContainText('public-short-42');
    await paste('printf "public-short-state:%s\\n" "$PUBLIC_SHORT_STATE"');
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toContainText('public-short-state:731');
    if (resolverRequests !== 2 || invalidResolverRequest)
      throw new Error('RESOLVER_BOUNDARY');
    stage = 'host-end';
    await paste('exit 19');
    await expect(page.getByLabel('Process status')).toContainText('Exit 19');
    await expect(
      page.getByText('Session closed.', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    stage = 'host-end-deletion';
    await verifyDeleted(request.url);
    request.url = '';
    await context.close();
  } finally {
    request.accessCode = '';
    request.url = '';
    request.bitmap = [];
    await browser.close();
  }
  process.stdout.write('PUBLIC_SHORT_ACCEPTANCE_PASSED\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write(`Public short acceptance failed at ${stage}.\n`);
    process.exitCode = 1;
  });
}
