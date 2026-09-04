import { chromium, expect } from '@playwright/test';
import { errorMessages } from '../../../apps/web/src/protocol/values.ts';
import { memorySample } from './startup.mjs';
import { setTimeout as delay } from 'node:timers/promises';

let stage = 'input';
class AcceptanceError extends Error {}
const check = (condition, code) => {
  if (!condition) throw new AcceptanceError(code);
};
const failureCodes = new Map([
  ...Object.entries(errorMessages).map(([code, message]) => [message, code]),
  ['The encrypted session disconnected. Retry to reconnect.', 'DISCONNECTED'],
  ['The session handshake timed out.', 'HANDSHAKE_TIMEOUT'],
  ['Tailcat connection timed out.', 'DIAL_TIMEOUT'],
  ['Tailcat connection failed.', 'DIAL_FAILED'],
  ['Tailcat stream read failed.', 'READ_FAILED'],
  ['Tailcat stream write failed.', 'WRITE_FAILED'],
  ['Tailcat stream close failed.', 'CLOSE_FAILED'],
  ['Tailcat stream is closed.', 'STREAM_CLOSED'],
  ['Tailcat operation was canceled.', 'TRANSPORT_CANCELED'],
  ['The session was canceled.', 'SESSION_CANCELED'],
  ['The terminal display failed. Reconnect to try again.', 'DISPLAY_FAILED'],
]);

async function main() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    check(length <= 32768, 'INPUT_LIMIT');
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  chunks.forEach((chunk) => chunk.fill(0));
  let request;
  try {
    request = JSON.parse(input.toString('utf8'));
  } finally {
    input.fill(0);
  }
  const base = new URL(request.baseURL);
  check(
    base.protocol === 'http:' && base.hostname === '127.0.0.1',
    'LOCAL_ONLY',
  );
  check(
    typeof request.fragment === 'string' &&
      /^[A-Za-z0-9_-]{1,16384}$/u.test(request.fragment),
    'INVALID_INVITATION',
  );
  const measureMemory = request.scenario === 'network-memory';
  check(
    (request.scenario === 'network' || measureMemory) &&
      Number.isSafeInteger(request.hostPID) &&
      request.hostPID > 0,
    'INVALID_SCENARIO',
  );
  const fixture = async (path, method = 'GET') => {
    const response = await fetch(`${base.origin}/__test/${path}`, {
      method,
      signal: AbortSignal.timeout(3000),
    });
    check(response.ok, 'FIXTURE_OPERATION_FAILED');
    return response.status === 204 ? null : response.json();
  };
  stage = 'launch';
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
    timeout: 10_000,
  });
  let result;
  try {
    const createContext = () =>
      browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
        viewport: { width: 900, height: 900 },
      });
    let context = await createContext();
    context.setDefaultTimeout(10_000);
    let page = await context.newPage();
    stage = 'connect';
    await page.goto(`${base.origin}/#/v1/${request.fragment}`);
    await expect(
      page.getByRole('region', { name: 'Connection' }).getByRole('status'),
    ).toHaveText('Connected', { timeout: 30_000 });
    check(page.url() === `${base.origin}/`, 'INVITATION_NOT_REMOVED');
    await page.getByRole('checkbox', { name: 'Screen reader support' }).check();
    let output = page.getByRole('region', { name: 'Terminal output' });
    await expect(output).toContainText('child-ready');
    const pid = await page.getByText(/^PID \d+$/u).innerText();
    const paste = async (value) => {
      await page.getByRole('textbox', { name: 'Paste text' }).fill(value);
      await page.getByRole('button', { name: 'Send paste' }).click();
    };
    stage = 'ordered-input';
    const ordered = Array.from(
      { length: 4096 },
      (_, index) => `${String(index).padStart(4, '0')}:🐈;`,
    ).join('');
    check(
      new TextEncoder().encode(ordered).length === 40960,
      'INPUT_FIXTURE_SIZE',
    );
    await fixture('pause/300', 'POST');
    await paste(ordered);
    // The native child compares every byte, including the changing record
    // indices and UTF-8 split across the production 32 KiB frame boundary.
    await expect(output).toContainText('ordered-input-ok', { timeout: 40_000 });
    stage = 'locked-modifiers';
    for (const name of ['Lock Ctrl', 'Lock Alt']) {
      await page.getByRole('button', { name, exact: true }).click();
      await expect(
        page.getByRole('button', { name, exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await page
      .getByRole('textbox', { name: 'Paste text' })
      .fill('must-not-survive-reconnect');
    stage = 'interrupted-exit';
    await fixture('pause/3000', 'POST');
    await page.getByRole('button', { name: 'Exit session' }).click();
    const closingRegion = page.getByRole('region', { name: 'Connection' });
    await expect(
      closingRegion.getByRole('status').or(closingRegion.getByRole('alert')),
    ).toHaveText(
      /^(?:Session closed\.|The session could not close cleanly\.|Tailcat stream close failed\.)$/u,
      { timeout: 7000 },
    );
    await expect(output).toHaveCount(0);
    await context.close();

    stage = 'fresh-stream';
    const reconnectRetries = { busy: 0, handshakeTimeout: 0 };
    context = await createContext();
    context.setDefaultTimeout(10_000);
    page = await context.newPage();
    await page.goto(`${base.origin}/#/v1/${request.fragment}`);
    request.fragment = '';
    await expect
      .poll(
        async () => {
          const region = page.getByRole('region', { name: 'Connection' });
          if (await region.getByRole('alert').count()) {
            const code =
              failureCodes.get(await region.getByRole('alert').textContent()) ??
              'UNKNOWN';
            check(
              code === 'SESSION_BUSY' || code === 'HANDSHAKE_TIMEOUT',
              `RECONNECT_REJECTED_${code}`,
            );
            // A locally timed-out handshake already exposes this manual
            // action. Preserve the overall recovery deadline and record it;
            // never retry malformed frames or hide a failed whole test.
            reconnectRetries[
              code === 'SESSION_BUSY' ? 'busy' : 'handshakeTimeout'
            ]++;
            check(
              reconnectRetries.busy + reconnectRetries.handshakeTimeout <= 80,
              'RECONNECT_ATTEMPT_LIMIT',
            );
            await page
              .getByRole('button', { name: 'Retry connection' })
              .click();
            return 'Retrying';
          }
          return region.getByRole('status').innerText();
        },
        // A lost close can require the Host's 30-second peer-liveness bound
        // before a fresh 10-second handshake can begin. Keep enough bounded
        // time for impaired transport setup without changing either runtime
        // deadline or retrying terminal input.
        { timeout: 60_000, intervals: [500, 1000] },
      )
      .toBe('Connected')
      .catch(async () => {
        const region = page.getByRole('region', { name: 'Connection' });
        const alert = region.getByRole('alert');
        const status = region.getByRole('status');
        let visible = 'MISSING';
        if (await alert.count()) {
          visible = `alert:${failureCodes.get(await alert.textContent()) ?? 'UNKNOWN'}`;
        } else if (await status.count()) {
          const detail = await status.textContent();
          visible = [
            'Loading Tailcat WebAssembly',
            'Connecting to relay / Meow handshake',
            'Establishing encrypted session',
            'Connected',
          ].includes(detail ?? '')
            ? `status:${detail}`
            : 'status:UNKNOWN';
        }
        process.stderr.write(
          `reconnect observation: ${JSON.stringify({ retries: reconnectRetries, visible })}\n`,
        );
        throw new AcceptanceError('RECONNECT_TIMEOUT');
      });
    check(page.url() === `${base.origin}/`, 'RECONNECT_INVITATION_NOT_REMOVED');
    await expect(page.getByText(pid, { exact: true })).toBeVisible();
    for (const name of ['Lock Ctrl', 'Lock Alt']) {
      await expect(
        page.getByRole('button', { name, exact: true }),
      ).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(page.getByRole('textbox', { name: 'Paste text' })).toHaveValue(
      '',
    );
    await page.getByRole('checkbox', { name: 'Screen reader support' }).check();
    output = page.getByRole('region', { name: 'Terminal output' });
    await expect(output).toContainText('ordered-input-ok');
    const keyboard = page.getByRole('button', { name: 'Open keyboard' });
    stage = 'fresh-input-ready';
    await expect(keyboard)
      .toBeEnabled({ timeout: 30_000 })
      .catch(() => {
        throw new AcceptanceError('FRESH_INPUT_NOT_READY');
      });
    stage = 'fresh-keys';
    await keyboard.click();
    await page.keyboard.type('az');
    stage = 'fresh-key-output';
    await expect(output)
      .toContainText('fresh-keys-ok', { timeout: 30_000 })
      .catch(() => {
        throw new AcceptanceError('FRESH_KEYS_MISSING');
      });

    stage = 'slow-consumer';
    const before = await fixture('network');
    const beforeLocal = await fixture('output');
    // Keep output unavailable beyond the native fixture's ten-second liveness
    // budget. Race instrumentation is not a PTY-throughput benchmark; the
    // required 300 ms and 3 s recovery outages are exercised separately above.
    const outageStarted = performance.now();
    await fixture('pause/15000', 'POST');
    const started = performance.now();
    await fixture('bulk', 'POST');
    stage = 'slow-consumer-local-output';
    await expect
      .poll(async () => (await fixture('output')).finished, {
        timeout: 10_000,
        intervals: [25, 50],
      })
      .toBe(true)
      .catch(async () => {
        const local = await fixture('output');
        process.stderr.write(
          `bulk observation: ${JSON.stringify({ bytes: local.bytes - beforeLocal.bytes, finished: local.finished, elapsedMS: performance.now() - started })}\n`,
        );
        throw new AcceptanceError('CHILD_OUTPUT_NOT_COMPLETE_DURING_OUTAGE');
      });
    const bulkMS = performance.now() - started;
    check(bulkMS < 10_000, 'CHILD_OUTPUT_BLOCKED_BY_BROWSER');
    stage = 'slow-consumer-loss-observation';
    await expect
      .poll(async () => (await fixture('network'))[0].Dropped, {
        timeout: 500,
        intervals: [25],
      })
      .toBeGreaterThan(before[0].Dropped);
    const impaired = await fixture('network');
    check(
      impaired.every(
        (direction) => direction.Packets > 0 && direction.MaxQueue <= 128,
      ),
      'IMPAIRMENT_PATH_INVALID',
    );
    let memory;
    if (measureMemory) {
      stage = 'slow-consumer-memory';
      const inspector = await browser.newBrowserCDPSession();
      const maximum = {};
      let memoryFailure;
      try {
        for (let sample = 0; sample < 5; sample++) {
          await delay(1000);
          const values = await memorySample(
            {
              send: (method, params) => inspector.send(method, params),
              assertIsolated: async () => {
                check(
                  browser.contexts().length === 1 &&
                    context.pages().length === 1 &&
                    page.url() === `${base.origin}/`,
                  'MEMORY_BROWSER_OWNERSHIP',
                );
                check(
                  (await page
                    .getByRole('region', { name: 'Connection' })
                    .getByRole('status')
                    .innerText()) === 'Connected' &&
                    (await page
                      .getByLabel('Process status')
                      .getByRole('status')
                      .innerText()) === 'running',
                  'MEMORY_SESSION_NOT_RUNNING',
                );
                const { targetInfos } =
                  await inspector.send('Target.getTargets');
                check(
                  targetInfos.every(
                    (target) =>
                      target.type === 'browser' ||
                      (target.type === 'page' &&
                        target.url === `${base.origin}/`),
                  ),
                  'MEMORY_UNEXPECTED_TARGET',
                );
              },
            },
            request.hostPID,
          );
          for (const [key, value] of Object.entries(values))
            maximum[key] = Math.max(maximum[key] ?? 0, value);
        }
        const elapsedMS = performance.now() - outageStarted;
        check(elapsedMS < 15_000, 'MEMORY_OUTAGE_WINDOW_EXCEEDED');
        memory = {
          ...maximum,
          samples: 5,
          elapsedMS,
          browserVersion: browser.version(),
        };
      } catch (error) {
        memoryFailure = error;
        throw error;
      } finally {
        await inspector.detach().catch((error) => {
          if (memoryFailure === undefined) throw error;
        });
      }
    }
    // The required nonblocking-output observation is complete while the link
    // is unavailable. Restore a fast link for bounded catch-up and cleanup;
    // do not label that later drain as low-bandwidth throughput evidence.
    stage = 'restored-output-marker';
    await fixture('restore', 'POST');
    let outputRecovery = 'same-stream';
    await expect
      .poll(
        async () => {
          const region = page.getByRole('region', { name: 'Connection' });
          const alert = region.getByRole('alert');
          if (await alert.count()) {
            const detail = await alert.textContent();
            // A blocked PONG write or the Host's missing-PONG deadline can
            // end this stream. Recover only through the visible Retry action;
            // protocol/display failures are not acceptable outage outcomes.
            check(
              detail ===
                'The encrypted session disconnected. Retry to reconnect.' ||
                detail === 'Tailcat stream read failed.' ||
                detail === 'Tailcat stream write failed.' ||
                (outputRecovery === 'fresh-stream' &&
                  detail === 'Another browser is controlling this session.'),
              `OUTPUT_RECOVERY_${failureCodes.get(detail) ?? 'UNKNOWN_FAILURE'}`,
            );
            await page
              .getByRole('button', { name: 'Retry connection' })
              .click();
            outputRecovery = 'fresh-stream';
            return false;
          }
          if ((await region.getByRole('status').innerText()) !== 'Connected')
            return false;
          const screenReader = page.getByRole('checkbox', {
            name: 'Screen reader support',
          });
          if (await screenReader.count()) await screenReader.check();
          return output.evaluateAll((regions) =>
            regions.some((region) =>
              region.textContent?.includes('bulk-finished'),
            ),
          );
        },
        { timeout: 45_000, intervals: [250, 500, 1000] },
      )
      .toBe(true)
      .catch(async (error) => {
        const stats = await fixture('network');
        process.stderr.write(
          `restored observation: ${JSON.stringify({
            bulkMS,
            packets: stats.map((direction) => direction.Packets),
            dropped: stats.map((direction) => direction.Dropped),
            connected: await page
              .getByRole('region', { name: 'Connection' })
              .getByRole('status')
              .filter({ hasText: /^Connected$/u })
              .count(),
            terminalMounted: await output.count(),
          })}\n`,
        );
        throw error instanceof AcceptanceError
          ? error
          : new AcceptanceError('RESTORED_OUTPUT_MISSING');
      });
    await expect(page.getByText(pid, { exact: true })).toBeVisible();
    stage = 'restored-drop-notice';
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /output bytes were dropped/u }),
    ).toBeVisible();
    stage = 'child-exit';
    await paste('x');
    await expect(page.getByLabel('Process status')).toContainText('Exit 37');
    result = {
      inputBytes: 40960,
      bulkBytes: 4 << 20,
      bulkMS,
      modifierReset: true,
      outputRecovery,
      reconnectRetries,
      ...(memory === undefined ? {} : { memory }),
    };
    // Keep the reader alive for the Host's normal post-exit CLOSE/ack. Closing
    // the context first would inject a second abrupt loss into this cleanup.
    stage = 'retention-close';
    await expect(
      page.getByText('Session closed.', { exact: true }),
    ).toBeVisible();
    await context.close();
  } finally {
    request.fragment = '';
    await browser.close();
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error instanceof AcceptanceError ? error.message : 'UNEXPECTED';
  process.stderr.write(
    `leash network acceptance failed at ${stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
