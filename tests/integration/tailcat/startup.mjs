import { chromium } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

let stage = 'input';

// A page-only CDP client avoids Playwright's automatic service-worker debugger
// attachment, which prevents Chromium's normal idle worker termination.
export async function performanceBrowser(origin) {
  const directory = await mkdtemp(join(tmpdir(), 'tailmouse-performance-'));
  const child = spawn(
    chromium.executablePath(),
    [
      '--headless',
      '--remote-debugging-pipe',
      `--user-data-dir=${directory}`,
      '--no-first-run',
      '--no-startup-window',
      '--no-default-browser-check',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--ignore-certificate-errors',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  // Preserve rejection for cleanup without creating an unhandled rejection.
  void exited.catch(() => {});
  const writer = child.stdio[3];
  const reader = child.stdio[4];
  let closed = false;
  const pending = new Map();
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    writer.end();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('BROWSER_CLOSED'));
    }
    pending.clear();
    const running = () => child.exitCode === null && child.signalCode === null;
    let forced = false;
    const timer = setTimeout(() => {
      if (running()) {
        forced = true;
        child.kill('SIGKILL');
      }
    }, 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
      await rm(directory, { recursive: true, force: true });
    }
    if (forced) throw new Error('BROWSER_CLEANUP_DEADLINE');
  };
  try {
    let id = 0;
    let pageErrors = 0;
    let received = Buffer.alloc(0);
    let failure;
    const fail = (code) => {
      failure ??= new Error(code);
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(failure);
      }
      pending.clear();
    };
    child.once('error', () => fail('BROWSER_START_FAILED'));
    child.once('exit', () => fail('BROWSER_EXITED'));
    writer.on('error', () => fail('BROWSER_PIPE_FAILED'));
    reader.on('error', () => fail('BROWSER_PIPE_FAILED'));
    reader.on('data', (chunk) => {
      if (received.length + chunk.length > 1 << 20) {
        fail('BROWSER_RESPONSE_LIMIT');
        return;
      }
      received = Buffer.concat([received, chunk]);
      let end;
      while ((end = received.indexOf(0)) !== -1) {
        let message;
        try {
          message = JSON.parse(received.subarray(0, end).toString('utf8'));
        } catch {
          fail('BROWSER_RESPONSE_INVALID');
          return;
        }
        received = received.subarray(end + 1);
        if (message.method === 'Runtime.exceptionThrown') pageErrors++;
        const request = pending.get(message.id);
        if (request === undefined) continue;
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error('BROWSER_COMMAND_FAILED'));
        else request.resolve(message.result);
      }
    });
    const send = (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (failure !== undefined || closed) {
          reject(failure ?? new Error('BROWSER_CLOSED'));
          return;
        }
        const requestId = ++id;
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('BROWSER_COMMAND_DEADLINE'));
        }, 35000);
        pending.set(requestId, { resolve, reject, timer });
        writer.write(
          `${JSON.stringify({ id: requestId, method, params, sessionId })}\0`,
        );
      });
    const { product: browserVersion } = await send('Browser.getVersion');
    const { processInfo } = await send('SystemInfo.getProcessInfo');
    if (
      processInfo.filter((process) => process.type === 'browser').length !==
        1 ||
      processInfo.find((process) => process.type === 'browser').id !== child.pid
    )
      throw new Error('BROWSER_OWNERSHIP_INVALID');
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetInfos } = await send('Target.getTargets');
    if (targetInfos.some((target) => target.type !== 'browser'))
      throw new Error('UNEXPECTED_BROWSER_TARGET');
    return {
      send,
      cleanup,
      browserVersion,
      pageErrors: () => pageErrors,
      async assertIsolated() {
        const { targetInfos } = await send('Target.getTargets');
        if (
          targetInfos.some(
            (target) =>
              target.type !== 'browser' &&
              !(target.type === 'page' && target.url === 'about:blank') &&
              !(
                ['page', 'service_worker'].includes(target.type) &&
                target.url.startsWith(`${origin}/`)
              ),
          )
        )
          throw new Error('UNEXPECTED_BROWSER_TARGET');
        if (
          targetInfos.some(
            (target) => target.type === 'service_worker' && target.attached,
          )
        )
          throw new Error('WORKER_DEBUGGER_ATTACHED');
      },
      async newPage() {
        const { targetId } = await send('Target.createTarget', {
          browserContextId,
          url: 'about:blank',
        });
        const { sessionId } = await send('Target.attachToTarget', {
          targetId,
          flatten: true,
        });
        await send('Runtime.enable', {}, sessionId);
        const evaluate = async (fn, arg) => {
          const response = await send(
            'Runtime.evaluate',
            {
              expression: `(${fn.toString()})(${JSON.stringify(arg) ?? ''})`,
              awaitPromise: true,
              returnByValue: true,
            },
            sessionId,
          );
          if (response.exceptionDetails)
            throw new Error('PAGE_EVALUATION_FAILED');
          return response.result.value;
        };
        return {
          evaluate,
          send: (method, params) => send(method, params, sessionId),
          close: () => send('Target.closeTarget', { targetId }),
          async waitFor(fn) {
            const deadline = performance.now() + 35000;
            while (!(await evaluate(fn))) {
              if (performance.now() >= deadline)
                throw new Error('PAGE_STATE_DEADLINE');
              await delay(25);
            }
          },
          async click(text, selector = 'button') {
            const point = await evaluate(
              ({ text, selector }) => {
                const element = [...document.querySelectorAll(selector)].find(
                  (element) => element.textContent.trim() === text,
                );
                if (element === undefined || element.disabled) return null;
                element.scrollIntoView({ block: 'center', inline: 'center' });
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0
                  ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
                  : null;
              },
              { text, selector },
            );
            if (point === null) throw new Error('CONTROL_UNAVAILABLE');
            for (const type of ['mousePressed', 'mouseReleased'])
              await send(
                'Input.dispatchMouseEvent',
                { type, ...point, button: 'left', clickCount: 1 },
                sessionId,
              );
          },
        };
      },
    };
  } catch (error) {
    await cleanup().catch(() => {});
    throw error;
  }
}

export async function memorySample(inspector, hostPID) {
  await inspector.assertIsolated();
  const { processInfo } = await inspector.send('SystemInfo.getProcessInfo');
  const pids = [...new Set([hostPID, ...processInfo.map((item) => item.id)])];
  if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0))
    throw new Error('PROCESS_ID_INVALID');
  const rows = execFileSync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
    encoding: 'utf8',
    timeout: 2000,
  })
    .trim()
    .split('\n');
  const rss = new Map(
    rows.map((row) => {
      const values = row.trim().split(/\s+/u).map(Number);
      if (
        values.length !== 2 ||
        !values.every((value) => Number.isSafeInteger(value) && value > 0)
      )
        throw new Error('MEMORY_SAMPLE_INVALID');
      return [values[0], values[1] * 1024];
    }),
  );
  if (pids.some((pid) => !rss.has(pid)))
    throw new Error('MEMORY_PROCESS_EXITED');
  const total = (values, type) =>
    processInfo
      .filter((item) => type === undefined || item.type === type)
      .reduce((sum, item) => sum + values.get(item.id), 0);
  const result = {
    hostRSSBytes: rss.get(hostPID),
    browserRSSBytes: total(rss),
    rendererRSSBytes: total(rss, 'renderer'),
  };
  if (process.platform === 'darwin') {
    // macOS top's MEM is physical footprint, unlike RSS (which also counts
    // reclaimable code/shared clean pages). Its human units are approximate.
    const output = execFileSync(
      '/usr/bin/top',
      [
        '-l',
        '1',
        '-stats',
        'pid,mem',
        ...pids.flatMap((pid) => ['-pid', String(pid)]),
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    const footprint = new Map();
    for (const line of output.split('\n')) {
      const match = /^(\d+)\s+(\d+(?:\.\d+)?)([BKMG]?)\+?\s*$/u.exec(
        line.trim(),
      );
      if (match)
        footprint.set(
          Number(match[1]),
          Number(match[2]) *
            { '': 1, B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[match[3]],
        );
    }
    if (pids.some((pid) => !footprint.has(pid)))
      throw new Error('FOOTPRINT_SAMPLE_INVALID');
    result.hostFootprintBytes = footprint.get(hostPID);
    result.browserFootprintBytes = total(footprint);
    result.rendererFootprintBytes = total(footprint, 'renderer');
    result.largestRendererFootprintBytes = Math.max(
      ...processInfo
        .filter((item) => item.type === 'renderer')
        .map((item) => footprint.get(item.id)),
    );
    result.rendererProcessCount = processInfo.filter(
      (item) => item.type === 'renderer',
    ).length;
    result.browserCoreFootprintBytes = total(footprint, 'browser');
    result.gpuFootprintBytes = total(footprint, 'GPU');
  }
  return result;
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
    request = JSON.parse(input.toString('utf8'));
  } finally {
    input.fill(0);
  }
  const base = new URL(request.baseURL);
  if (
    base.protocol !== 'http:' ||
    base.hostname !== '127.0.0.1' ||
    !/^[A-Za-z0-9_-]{1,16384}$/.test(request.fragment) ||
    request.scenario !== 'startup' ||
    !Number.isSafeInteger(request.hostPID) ||
    request.hostPID <= 0
  )
    throw new Error('INPUT_INVALID');
  stage = 'browser-start';
  const browser = await performanceBrowser(base.origin);
  let result;
  let failure;
  try {
    let page = await browser.newPage();
    stage = 'baseline-memory';
    const baseline = await memorySample(browser, request.hostPID);
    const connect = async (cache) => {
      stage = `${cache}-connect`;
      // The invitation exists only in this probe's memory and the navigation
      // fragment. No trace, request/body log, screenshot or persisted profile.
      const start = performance.now();
      await page.send('Page.navigate', {
        url: `${base.origin}/#/v1/${request.fragment}`,
      });
      stage = `${cache}-session`;
      await page.waitFor(
        () =>
          document.querySelector(
            '[aria-labelledby="connection-heading"] [role="status"]',
          )?.textContent === 'Connected',
      );
      stage = `${cache}-input`;
      await page.waitFor(() =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.textContent === 'Open keyboard' && !button.disabled,
        ),
      );
      await page.click('Screen reader support', 'label');
      stage = `${cache}-output`;
      await page.waitFor(() =>
        document
          .querySelector('[role="region"][aria-label="Terminal output"]')
          ?.textContent.includes('child-ready'),
      );
      const elapsed = performance.now() - start;
      if (
        (await page.evaluate(() => location.href)) !== `${base.origin}/` ||
        browser.pageErrors() !== 0
      )
        throw new Error('BROWSER_INVARIANT');
      return elapsed;
    };
    const coldMS = await connect('cold');
    stage = 'cache-installed';
    await page.evaluate(async () => {
      await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('CACHE_DEADLINE')), 30_000),
        ),
      ]);
    });
    stage = 'cold-memory';
    const coldMemory = await memorySample(browser, request.hostPID);
    const coldHeap = await page.send('Runtime.getHeapUsage');
    stage = 'disconnect';
    await page.click('Exit session');
    await page.waitFor(
      () =>
        document.querySelector(
          '[aria-labelledby="connection-heading"] [role="status"]',
        )?.textContent === 'Session closed.',
    );
    // Destroy the old document rather than retaining a second Go/Wasm instance
    // in navigation history's back/forward cache. HTTP/worker caches survive.
    await page.close();
    page = await browser.newPage();
    const warmMS = await connect('warm');
    if (
      !(await page.evaluate(() => navigator.serviceWorker.controller !== null))
    )
      throw new Error('CACHE_NOT_CONTROLLING');
    request.fragment = '';
    const transitionMemory = await memorySample(browser, request.hostPID);
    stage = 'idle-settle';
    // Chromium normally stops idle workers after 30 seconds. Record the
    // transition separately; never stop workers or collect garbage to pass.
    await delay(35000);
    stage = 'idle-memory';
    const memory = {};
    for (let sample = 0; sample < 5; sample++) {
      await delay(1000);
      if (
        !(await page.evaluate(
          () =>
            document.querySelector(
              '[aria-labelledby="connection-heading"] [role="status"]',
            )?.textContent === 'Connected' &&
            document.querySelector(
              '[aria-label="Process status"] [role="status"]',
            )?.textContent === 'running',
        ))
      )
        throw new Error('IDLE_SESSION_NOT_RUNNING');
      for (const [key, value] of Object.entries(
        await memorySample(browser, request.hostPID),
      ))
        memory[key] = Math.max(memory[key] ?? 0, value);
    }
    const warmHeap = await page.send('Runtime.getHeapUsage');
    const { targetInfos } = await browser.send('Target.getTargets');
    const idleWorkers = targetInfos.filter(
      (target) => target.type === 'service_worker',
    );
    if (
      targetInfos.some(
        (target) =>
          target.type !== 'browser' &&
          !(
            target.url.startsWith(`${base.origin}/`) &&
            ['page', 'service_worker'].includes(target.type)
          ),
      )
    )
      throw new Error('UNEXPECTED_BROWSER_TARGET');
    if (idleWorkers.some((target) => target.attached))
      throw new Error('WORKER_DEBUGGER_ATTACHED');
    stage = 'child-exit';
    await page.evaluate(() => {
      const label = [...document.querySelectorAll('label')].find(
        (label) => label.textContent === 'Paste text',
      );
      if (
        !(label?.control instanceof HTMLTextAreaElement) ||
        label.control.disabled
      )
        throw new Error('PASTE_UNAVAILABLE');
      label.control.focus();
    });
    await page.send('Input.insertText', { text: 'x' });
    await page.click('Send paste');
    await page.waitFor(() =>
      document
        .querySelector('[aria-label="Process status"]')
        ?.textContent.includes('Exit 37'),
    );
    await page.waitFor(
      () =>
        document.querySelector(
          '[aria-labelledby="connection-heading"] [role="status"]',
        )?.textContent === 'Session closed.',
    );
    result = {
      coldMS,
      warmMS,
      ...memory,
      browserVersion: browser.browserVersion,
      idleSettleMS: 35000,
      idleWorkerCount: idleWorkers.length,
      transitionBrowserFootprintBytes: transitionMemory.browserFootprintBytes,
      baselineBrowserRSSBytes: baseline.browserRSSBytes,
      baselineBrowserFootprintBytes: baseline.browserFootprintBytes,
      coldBrowserFootprintBytes: coldMemory.browserFootprintBytes,
      coldRendererFootprintBytes: coldMemory.rendererFootprintBytes,
      coldLargestRendererFootprintBytes:
        coldMemory.largestRendererFootprintBytes,
      coldRendererProcessCount: coldMemory.rendererProcessCount,
      coldHeapBytes: coldHeap.usedSize,
      coldBackingBytes: coldHeap.backingStorageSize,
      warmHeapBytes: warmHeap.usedSize,
      warmBackingBytes: warmHeap.backingStorageSize,
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

if (import.meta.main)
  main().catch((error) => {
    const code =
      typeof error?.message === 'string' &&
      /^[A-Z][A-Z_]{0,40}$/u.test(error.message)
        ? error.message
        : 'REDACTED';
    process.stderr.write(`startup measurement failed at ${stage}: ${code}\n`);
    process.exitCode = 1;
  });
