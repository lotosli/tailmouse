import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firefox, expect } from '@playwright/test';

const manifest = JSON.parse(readFileSync('apps/web/dist/web-manifest.json', 'utf8'));
const profile = mkdtempSync(join(tmpdir(), 'tailmouse-layout-public-'));
const proxy = new URL(process.env.HTTPS_PROXY ?? process.env.https_proxy);
let context;
try {
  execFileSync('certutil', ['-N', '--empty-password', '-d', `sql:${profile}`]);
  execFileSync('certutil', ['-A', '-d', `sql:${profile}`, '-t', 'C,,', '-n', 'environment-proxy-ca', '-i', '/usr/local/share/ca-certificates/environment-proxy-ca.crt']);
  context = await firefox.launchPersistentContext(profile, {
    headless: true,
    ignoreHTTPSErrors: false,
    timeout: 15000,
    proxy: { server: `${proxy.protocol}//${proxy.host}`, username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) },
  });
  const page = context.pages()[0];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto('https://tailmouse.com/', { timeout: 30000 });
  assert.equal(response.status(), 200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Let them test your work. Skip the setup.', { useInnerText: true });
  await expect(page.getByRole('link', { name: 'Download v0.1.0-alpha.3 ↗', exact: true })).toHaveAttribute('href', 'https://github.com/lotosli/tailmouse/releases/tag/v0.1.0-alpha.3');
  await expect(page.getByRole('link', { name: 'Build from source ↗', exact: true })).toHaveAttribute('href', 'https://github.com/lotosli/tailmouse#build-from-source');
  await expect(page.locator('#guide pre').first()).toHaveText('mkdir -p ./tailmouse-uploads\ntailmouse receive ./tailmouse-uploads');
  await expect(page.locator('#get-started')).toContainText('No configuration file or account is needed.', { useInnerText: true });
  await expect(page.getByRole('link', { name: 'Share from your browser ↗', exact: true })).toHaveAttribute('href', '/#share');
  await expect(page.locator('a[href="/install.sh"]')).toHaveText('Read the shell installer');
  const layouts = [];
  for (const [width, height] of [[390, 844], [768, 1024], [1280, 900], [1920, 1080], [2700, 1524]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      function lineCount(node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        return new Set([...range.getClientRects()].filter((rect) => rect.width > 1).map((rect) => Math.round(rect.top))).size;
      }
      const heading = document.querySelector('#hero-title');
      return { viewport: innerWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth, firstSentenceLines: lineCount(heading.firstChild), accentLines: lineCount(heading.querySelector('span')), descriptionLines: lineCount(document.querySelector('.hero-description')) };
    });
    assert.equal(layout.horizontalOverflow, false, JSON.stringify(layout));
    if (width >= 1280) {
      assert.equal(layout.firstSentenceLines, 1, JSON.stringify(layout));
      assert.equal(layout.accentLines, 1, JSON.stringify(layout));
      assert.equal(layout.descriptionLines, 1, JSON.stringify(layout));
    }
    await page.screenshot({ path: join(import.meta.dirname, `public-${width}.png`) });
    layouts.push(layout);
  }
  await page.getByRole('button', { name: '5 End sharing', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Close access when the task is done.', exact: true })).toBeVisible();
  await page.getByText('Already have a local development server?', { exact: true }).click();
  await expect(page.getByText('127.0.0.1:8080', { exact: true })).toBeVisible();
  const published = await page.evaluate(async () => {
    const response = await fetch('/web-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Public manifest unavailable.');
    return response.json();
  });
  assert.deepEqual(published, manifest);
  assert.deepEqual(errors, []);
  const report = { origin: 'https://tailmouse.com', sourceRevision: manifest.resourceProtocol.sourceRevision, browser: `Firefox ${context.browser().version()}`, tls: 'verified with the environment proxy CA in an isolated profile', layouts, checks: ['public release link', 'configuration-free first-share command', 'main source link', 'interactive walkthrough', 'loopback port guidance', 'exact published manifest', 'no page errors', 'installer entry links'], status: 'verified' };
  writeFileSync(join(import.meta.dirname, 'public-browser.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  if (context) await context.close();
  rmSync(profile, { recursive: true, force: true });
}
