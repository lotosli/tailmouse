// Static public UI acceptance; no invitation or native session is created.
// Usage: node verify-browser.mjs LOCAL_MANIFEST OUTPUT_JSON [TRUSTED_PROXY_CA]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox, expect } from '@playwright/test';

const [manifestPath, reportPath, trustedCA] = process.argv.slice(2);
assert.ok(manifestPath && reportPath);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const profile = mkdtempSync(join(tmpdir(), 'tailmouse-public-browser-'));
let context;
try {
  if (trustedCA) {
    execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${profile}`]);
    execFileSync('certutil', [
      '-A', '-d', `sql:${profile}`, '-t', 'C,,', '-n', 'environment-proxy-ca',
      '-i', trustedCA,
    ]);
  }
  const proxyAddress = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const proxy = proxyAddress ? new URL(proxyAddress) : undefined;
  context = await firefox.launchPersistentContext(profile, {
    headless: true,
    timeout: 15_000,
    ignoreHTTPSErrors: false,
    proxy: proxy && {
      server: `${proxy.protocol}//${proxy.host}`,
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    },
  });
  const page = context.pages()[0];
  let pageErrors = 0;
  page.on('pageerror', () => pageErrors++);
  const response = await page.goto('https://tailmouse.com/', { timeout: 30_000 });
  assert.equal(response.status(), 200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let them test your work. Skip the setup.',
    { useInnerText: true, timeout: 10_000 },
  );
  await page.getByRole('button', { name: '5 End sharing', exact: true }).click();
  await expect(page.getByRole('heading', {
    name: 'Close access when the task is done.', exact: true,
  })).toBeVisible();
  await page.getByText('Already have a local development server?', { exact: true }).click();
  await expect(page.getByText('127.0.0.1:8080', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Build from source ↗', exact: true }))
    .toHaveAttribute('href', 'https://github.com/lotosli/tailmouse/tree/codex/product-onboarding-2026-10#build-from-source');
  const publicManifest = await page.evaluate(async () => {
    const result = await fetch('/web-manifest.json', { cache: 'no-store' });
    if (!result.ok) throw new Error('Public manifest request failed.');
    return result.json();
  });
  assert.deepEqual(publicManifest, manifest);
  assert.equal(pageErrors, 0);
  const report = {
    origin: 'https://tailmouse.com',
    verifiedAt: new Date().toISOString(),
    sourceRevision: manifest.resourceProtocol.sourceRevision,
    browser: `Firefox ${context.browser().version()}`,
    tls: trustedCA ? 'verified with the environment proxy CA in an isolated profile' : 'verified with browser trust',
    checks: ['homepage', 'interactive walkthrough', 'loopback port guidance', 'source build link', 'exact public manifest', 'no page errors'],
    status: 'verified',
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (context) await context.close();
  rmSync(profile, { recursive: true, force: true });
}
