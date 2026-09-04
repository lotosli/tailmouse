import { setTimeout as delay } from 'node:timers/promises';
import { memorySample, performanceBrowser } from './startup.mjs';

let stage = 'input';

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
    request = JSON.parse(input.toString('utf8'));
  } finally {
    input.fill(0);
  }
  const base = new URL(request.baseURL);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    request.scenario !== 'escape-idle' ||
    typeof request.fragment !== 'string' ||
    !/^[A-Za-z0-9_-]{1,16384}$/u.test(request.fragment) ||
    !Number.isSafeInteger(request.hostPID) ||
    request.hostPID <= 0
  )
    throw new Error('INPUT_INVALID');

  stage = 'browser-start';
  const browser = await performanceBrowser(base.origin);
  let failure;
  let result;
  try {
    const page = await browser.newPage();
    const baseline = await memorySample(browser, request.hostPID);
    stage = 'connect';
    await page.send('Page.navigate', {
      url: `${base.origin}/#/v1/${request.fragment}`,
    });
    request.fragment = '';
    await page.waitFor(
      () =>
        document.querySelector(
          '[aria-labelledby="connection-heading"] [role="status"]',
        )?.textContent === 'Connected',
    );
    stage = 'retained-result';
    await page.waitFor(() =>
      ['THE CAT WON', 'TIME RAN OUT'].includes(
        document.getElementById('result-heading')?.textContent ?? '',
      ),
    );
    stage = 'cache-ready';
    await page.evaluate(async () => {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('CACHE_DEADLINE')), 30000),
        ),
      ]);
    });
    stage = 'idle-settle';
    await delay(35000);
    stage = 'idle-samples';
    const maximum = {};
    for (let sample = 0; sample < 5; sample++) {
      await delay(1000);
      const idle = await page.evaluate(
        () =>
          location.hash === '' &&
          location.search === '' &&
          document.querySelector(
            '[aria-labelledby="connection-heading"] [role="status"]',
          )?.textContent === 'Connected' &&
          ['THE CAT WON', 'TIME RAN OUT'].includes(
            document.getElementById('result-heading')?.textContent ?? '',
          ),
      );
      if (!idle || browser.pageErrors() !== 0)
        throw new Error('IDLE_SESSION_INVALID');
      for (const [key, value] of Object.entries(
        await memorySample(browser, request.hostPID),
      ))
        maximum[key] = Math.max(maximum[key] ?? 0, value);
    }
    stage = 'explicit-exit';
    await page.click('Exit session');
    await page.waitFor(
      () =>
        document.querySelector(
          '[aria-labelledby="connection-heading"] [role="status"]',
        )?.textContent === 'Session closed.',
    );
    result = {
      ...maximum,
      samples: 5,
      idleSettleMS: 35000,
      browserVersion: browser.browserVersion,
      baselineBrowserBytes:
        process.platform === 'darwin'
          ? baseline.browserFootprintBytes
          : baseline.browserRSSBytes,
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    request.fragment = '';
    await browser.cleanup().catch((error) => {
      if (failure === undefined) throw error;
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code =
    typeof error?.message === 'string' &&
    /^[A-Z][A-Z_]{0,40}$/u.test(error.message)
      ? error.message
      : 'REDACTED';
  process.stderr.write(
    `Escape memory measurement failed at ${stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
