import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { firefox, expect } from '@playwright/test';

const profile = mkdtempSync(join(tmpdir(), 'tailmouse-public-transfer-'));
const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.https_proxy);
let context;
let stage = 'launch';
try {
  execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${profile}`]);
  execFileSync('certutil', ['-A', '-d', `sql:${profile}`, '-t', 'C,,', '-n', 'environment-proxy-ca', '-i', '/usr/local/share/ca-certificates/environment-proxy-ca.crt']);
  context = await firefox.launchPersistentContext(profile, {
    headless: true, ignoreHTTPSErrors: false, timeout: 15000, acceptDownloads: true,
    proxy: { server: `${proxy.protocol}//${proxy.host}`, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
  });
  await context.addInitScript(() => { Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true }); });
  const host = context.pages()[0];
  const guest = await context.newPage();
  host.setDefaultTimeout(20000); guest.setDefaultTimeout(20000);
  stage = 'host-page';
  const response = await host.goto('https://tailmouse.com/#share', { timeout: 45000 });
  assert.equal(response.status(), 200);
  const payload = Buffer.from('TailMouse public synthetic transfer acceptance.\n');
  await host.getByLabel('Files to share', { exact: true }).setInputFiles({ name: 'tailmouse-probe.txt', mimeType: 'text/plain', buffer: payload });
  await host.getByLabel('Text to share', { exact: true }).fill('Public synthetic host text');
  stage = 'public-relay-listener';
  await host.getByRole('button', { name: 'Start browser sharing', exact: true }).click();
  await host.getByLabel('Private sharing link', { exact: true }).waitFor({ timeout: 100000 });
  let invitation = await host.getByLabel('Private sharing link', { exact: true }).inputValue();
  stage = 'guest-connect';
  await guest.goto(invitation, { timeout: 45000 }); invitation = '';
  await guest.getByText('Connected · encrypted Tailcat over DERP', { exact: true }).waitFor({ timeout: 80000 });
  assert.equal(new URL(guest.url()).hash, '');
  stage = 'download';
  const downloadReady = guest.waitForEvent('download');
  await guest.getByRole('button', { name: 'Download tailmouse-probe.txt', exact: true }).click();
  const download = await downloadReady; const stream = await download.createReadStream();
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of stream) { bytes += chunk.length; assert.ok(bytes <= payload.length); hash.update(chunk); }
  assert.equal(bytes, payload.length); assert.equal(hash.digest('hex'), createHash('sha256').update(payload).digest('hex'));
  await expect(guest.getByText('Download verified.', { exact: true })).toBeVisible();
  stage = 'text-round-trip';
  await guest.getByLabel('Text to send', { exact: true }).fill('Public synthetic visitor reply');
  await guest.getByRole('button', { name: 'Send text', exact: true }).click();
  await expect(host.getByText('Public synthetic visitor reply', { exact: true })).toBeVisible();
  await host.getByLabel('Text to share', { exact: true }).fill('Public synthetic host response');
  await host.getByRole('button', { name: 'Update shared text', exact: true }).click();
  await guest.getByRole('button', { name: 'Refresh text', exact: true }).click();
  await expect(guest.getByText('Public synthetic host response', { exact: true })).toBeVisible();
  stage = 'end';
  await host.getByRole('button', { name: 'End browser sharing', exact: true }).click();
  await expect(host.getByLabel('Private sharing link', { exact: true })).toHaveCount(0);
  await expect(guest.locator('button:enabled').filter({ hasText: 'Download tailmouse-probe.txt' })).toHaveCount(0, { timeout: 25000 });
  const record = { verifiedAt: new Date().toISOString(), origin: 'https://tailmouse.com', browser: `Firefox ${context.browser().version()}`, tls: 'verified with environment proxy CA', relay: 'default public Tailcat DERP', syntheticPayloadBytes: payload.length, syntheticPayloadSha256: createHash('sha256').update(payload).digest('hex'), checks: ['browser host without installation', 'second browser connection', 'invitation fragment consumed', 'download length and SHA-256', 'text in both directions', 'host end removes access'], status: 'verified' };
  writeFileSync(join(import.meta.dirname, 'public-transfer.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify(record));
} catch (error) {
  const reason = error instanceof Error ? error.message.split('\n')[0].replace(/https?:\/\/\S+/gu, '[URL]').slice(0, 100) : 'ASSERTION';
  console.error(`Public transfer stage: ${stage}; ${reason}`); process.exitCode = 1;
} finally {
  await context?.close(); rmSync(profile, { recursive: true, force: true });
}
