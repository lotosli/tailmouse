import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
input = '';
let stage = 'launch';
let browser;
async function downloadBytes(page, name) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name, exact: true }).click();
  const download = await event;
  const stream = await download.createReadStream();
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    assert.ok(bytes <= 1024 * 1024);
    hash.update(chunk);
  }
  await expect(
    page.getByText('Download verified.', { exact: true }),
  ).toBeVisible();
  return hash.digest('hex');
}
try {
  browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${request.spki}`],
  });
  const options = { ignoreHTTPSErrors: true, acceptDownloads: true };
  const nativeContext = await browser.newContext(options);
  await nativeContext.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    });
  });
  const native = await nativeContext.newPage();
  native.setDefaultTimeout(20000);
  stage = 'native-connect';
  await native.goto(request.nativeURL);
  request.nativeURL = '';
  await native
    .getByText('Connected · encrypted Tailcat over DERP', { exact: true })
    .waitFor({ timeout: 70000 });
  stage = 'native-directory';
  await native
    .getByRole('button', { name: 'Open folder nested', exact: true })
    .click();
  const expected = createHash('sha256')
    .update('native download\n'.repeat(1000))
    .digest('hex');
  stage = 'native-download';
  assert.equal(await downloadBytes(native, 'Download report.txt'), expected);
  stage = 'native-text';
  await native.setViewportSize({ width: 768, height: 1024 });
  await expect(
    native.getByRole('heading', { name: 'Temporary text', exact: true }),
  ).toBeVisible();
  await native
    .getByLabel('Text to send', { exact: true })
    .fill('native visitor reply');
  await native.getByRole('button', { name: 'Send text', exact: true }).click();
  await expect(native.getByText('Text sent.', { exact: true })).toBeVisible();
  await nativeContext.close();

  const hostContext = await browser.newContext(options);
  const guestContext = await browser.newContext(options);
  await guestContext.addInitScript(() => {
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    });
  });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  host.setDefaultTimeout(20000);
  guest.setDefaultTimeout(20000);
  stage = 'browser-host';
  await host.goto(request.origin + '/#share');
  const content = Buffer.from('browser transfer\n'.repeat(4000));
  const filename = 'browser-' + 'long-'.repeat(30) + '.txt';
  await host.getByLabel('Files to share', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: content,
  });
  await host
    .getByLabel('Text to share', { exact: true })
    .fill('browser host text');
  await host
    .getByRole('button', { name: 'Start browser sharing', exact: true })
    .click();
  await host
    .getByLabel('Private sharing link', { exact: true })
    .waitFor({ timeout: 70000 });
  let link = await host
    .getByLabel('Private sharing link', { exact: true })
    .inputValue();
  stage = 'browser-guest';
  await guest.goto(link);
  link = '';
  await guest
    .getByText('Connected · encrypted Tailcat over DERP', { exact: true })
    .waitFor({ timeout: 70000 });
  assert.equal(new URL(guest.url()).hash, '');
  stage = 'browser-download';
  assert.equal(
    await downloadBytes(guest, 'Download ' + filename),
    createHash('sha256').update(content).digest('hex'),
  );
  await guest.setViewportSize({ width: 390, height: 844 });
  await guest.getByRole('button', { name: 'Text', exact: true }).click();
  assert.equal(
    await guest.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  stage = 'browser-text';
  await expect(
    guest.getByText('browser host text', { exact: true }),
  ).toBeVisible();
  await guest
    .getByLabel('Text to send', { exact: true })
    .fill('browser visitor reply');
  await guest.getByRole('button', { name: 'Send text', exact: true }).click();
  await expect(
    host.getByText('browser visitor reply', { exact: true }),
  ).toBeVisible();
  await host.getByLabel('Text to share', { exact: true }).fill('host response');
  await host
    .getByRole('button', { name: 'Update shared text', exact: true })
    .click();
  await guest
    .getByRole('button', { name: 'Refresh text', exact: true })
    .click();
  await expect(guest.getByText('host response', { exact: true })).toBeVisible();
  stage = 'browser-end';
  await host
    .getByRole('button', { name: 'End browser sharing', exact: true })
    .click();
  await expect(
    host.getByLabel('Private sharing link', { exact: true }),
  ).toHaveCount(0);
  await expect(host.getByLabel('Files to share', { exact: true })).toHaveValue(
    '',
  );
  await expect(
    guest.locator('button:enabled').filter({ hasText: 'Download ' + filename }),
  ).toHaveCount(0, { timeout: 25000 });
  await hostContext.close();
  await guestContext.close();
  process.stdout.write('sharing stage: complete\n');
} catch (error) {
  const reason =
    error instanceof Error
      ? error.message
          .split('\n')[0]
          .replace(/https?:\/\/\S+/gu, '[URL]')
          .slice(0, 90)
      : 'ASSERTION';
  process.stderr.write(`sharing stage: ${stage}; code: ${reason}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
