// Release acceptance: real native Host, local DERP, and the source-built browser.
// Invitations arrive only over stdin and are never emitted in diagnostics.
import { chromium, expect } from '@playwright/test';

let input = '';
for await (const part of process.stdin) input += part;
const request = JSON.parse(input);
input = '';
let stage = 'launch';
let browser;
try {
  browser = await chromium.launch({
    args: [`--ignore-certificate-errors-spki-list=${request.spki}`],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  stage = 'navigation';
  await page.goto(request.url, { waitUntil: 'domcontentloaded' });
  request.url = '';
  stage = 'admission';
  await page
    .getByText('Connected · encrypted Tailcat over DERP', { exact: true })
    .waitFor({ timeout: 70000 });
  stage = 'terminal';
  await page
    .getByText('Connected to the same running process.', { exact: true })
    .waitFor();
  await page.getByRole('checkbox', { name: 'Screen reader mode' }).check();
  await page
    .getByLabel('Prepare terminal input')
    .fill('resource-browser-probe\n');
  await page
    .getByRole('button', { name: 'Send text without Enter', exact: true })
    .click();
  await expect(
    page.getByLabel('Shared terminal', { exact: true }),
  ).toContainText('resource-result:resource-browser-probe');
  stage = 'preview';
  const preview = page
    .frameLocator('iframe[title="Shared web preview"]')
    .frameLocator('iframe[title="Shared application"]');
  await preview
    .getByRole('heading', { name: 'Shared application', exact: true })
    .waitFor({ timeout: 40000 });
  if (!request.singleOrigin) {
    stage = 'isolation';
    await preview.getByText('Preview isolated', { exact: true }).waitFor();
  }
  stage = 'socket';
  await preview.getByText('Socket hello', { exact: true }).waitFor();
  stage = 'http-write';
  await preview.getByRole('button', { name: 'Save once', exact: true }).click();
  await preview.getByText('Saved once', { exact: true }).waitFor();
  stage = 'upload';
  await page.locator('input[type="file"]').setInputFiles({
    name: 'sample.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('resource upload\n'.repeat(10000)),
  });
  await page
    .getByRole('button', { name: 'Copy path', exact: true })
    .waitFor({ timeout: 30000 });
  stage = 'explicit-insert';
  await page
    .getByRole('button', { name: 'Insert into terminal field', exact: true })
    .click();
  await expect(page.getByLabel('Prepare terminal input')).toHaveValue(
    /sample-/,
  );
  stage = 'reload';
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page
    .getByText('Connected · encrypted Tailcat over DERP', { exact: true })
    .waitFor({ timeout: 60000 });
  await page
    .getByText('Connected to the same running process.', { exact: true })
    .waitFor();
  stage = 'revocation';
  await page.evaluate(async () => {
    await fetch('/__test/revoke', { method: 'POST' });
  });
  await page
    .getByText(/Access was revoked or the invitation is no longer valid/)
    .waitFor({ timeout: 25000 });
  await context.close();
  process.stdout.write('resource stage: complete\n');
} catch {
  process.stderr.write(`resource stage: ${stage}; code: ASSERTION\n`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
