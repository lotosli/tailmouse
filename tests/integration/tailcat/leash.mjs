import { chromium, expect } from '@playwright/test';

let stage = 'input';
const measuredSizes = [];
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
  if (
    typeof request?.baseURL !== 'string' ||
    typeof request.fragment !== 'string' ||
    !['chromium', 'chrome'].includes(request.engine) ||
    !Number.isSafeInteger(request.hostPID) ||
    request.hostPID <= 0 ||
    !/^[A-Za-z0-9_-]{1,16384}$/.test(request.fragment) ||
    ![
      'cli',
      'protected',
      'readonly',
      'ai-cli',
      'ai-cli-codex',
      'ai-cli-claude',
      'ai-agent-codex',
      'ai-agent-claude',
      'old-peer',
      'vim',
      'shell',
      'long-task',
      'htop',
      'reconnect',
      'retained-exit',
      'expiry',
      'revocation',
      'browser-crash',
      'browser-crash-kill',
    ].includes(request.scenario)
  )
    throw new Error('INPUT_INVALID');
  const protectedAccess = request.accessMode === 'code';
  if (
    !['code', 'link'].includes(request.accessMode) ||
    protectedAccess !==
      (typeof request.accessCode === 'string' &&
        /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{16}$/.test(request.accessCode))
  )
    throw new Error('INPUT_INVALID');
  const expectedPattern = ['ai-cli', 'ai-cli-codex', 'ai-agent-codex'].includes(
    request.scenario,
  )
    ? /^codex-cli [0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/
    : ['ai-cli-claude', 'ai-agent-claude'].includes(request.scenario)
      ? /^[0-9]+(?:\.[0-9]+){2} \(Claude Code\)$/
      : null;
  if (
    (expectedPattern !== null) !==
    (typeof request.expectedOutput === 'string' &&
      expectedPattern?.test(request.expectedOutput))
  )
    throw new Error('INPUT_INVALID');
  const base = new URL(request.baseURL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1')
    throw new Error('INPUT_INVALID');

  stage = 'launch';
  const launch = () =>
    chromium.launchServer({
      args: ['--ignore-certificate-errors'],
      ...(request.engine === 'chrome' ? { channel: 'chrome' } : {}),
      headless: true,
      host: '127.0.0.1',
      timeout: 10_000,
    });
  let server;
  let failure;
  let browserVersion = '';
  try {
    server = await launch();
    let browser = await chromium.connect(server.wsEndpoint(), {
      timeout: 10_000,
    });
    browserVersion = browser.version();
    if (
      !/^\d+(?:\.\d+){1,3}$/.test(browserVersion) ||
      browserVersion.length > 64
    )
      throw new Error('BROWSER_VERSION_INVALID');
    let context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
      viewport: { width: 900, height: 900 },
    });
    context.setDefaultTimeout(10_000);
    let page = await context.newPage();
    const interactiveAI = request.scenario.startsWith('ai-agent-');
    const reconnect =
      interactiveAI ||
      [
        'protected',
        'long-task',
        'reconnect',
        'retained-exit',
        'browser-crash',
      ].includes(request.scenario);
    const retainedExit = request.scenario === 'retained-exit';
    const longTask = request.scenario === 'long-task';
    const killOnDisconnect = request.scenario === 'browser-crash-kill';
    const hostEndsSession = ['expiry', 'revocation'].includes(request.scenario);
    const invitationURL = `${request.baseURL}/#/v1/${request.fragment}`;
    let code = protectedAccess ? request.accessCode : '';
    request.accessCode = '';
    stage = 'connect';
    await page.goto(invitationURL);
    if (protectedAccess) {
      stage = 'protected-code-entry';
      const connection = page.getByRole('region', { name: 'Connection' });
      const accessAlert = connection.getByRole('alert');
      const expectCodeEntry = () =>
        expect(accessAlert).toHaveText(
          'Enter the host access code to continue.',
          { timeout: 30_000 },
        );
      await expectCodeEntry();
      await page.getByLabel('Access code').fill(code);
      await page.getByRole('button', { name: 'Connect' }).click();
      if (!reconnect) code = '';
    }
    // Only reconnect scenarios keep the externally supplied invitation in memory
    // for a second explicit scan; the PWA never stores or recovers it.
    if (!reconnect) request.fragment = '';
    await expect(
      page.getByRole('region', { name: 'Connection' }).getByRole('status'),
    ).toHaveText('Connected', { timeout: 30_000 });
    if (page.url() !== `${request.baseURL}/`) throw new Error('URL_NOT_CLEAN');
    if (request.scenario === 'protected') {
      stage = 'protected-busy-peer';
      const busyContext = await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
        viewport: { width: 900, height: 900 },
      });
      busyContext.setDefaultTimeout(10_000);
      try {
        const busyPage = await busyContext.newPage();
        await busyPage.goto(invitationURL);
        await expect(
          busyPage
            .getByRole('region', { name: 'Connection' })
            .getByRole('alert'),
        ).toHaveText('Enter the host access code to continue.', {
          timeout: 30_000,
        });
        await busyPage.getByLabel('Access code').fill(code);
        await busyPage.getByRole('button', { name: 'Connect' }).click();
        await expect(
          busyPage
            .getByRole('region', { name: 'Connection' })
            .getByRole('alert'),
        ).toHaveText('Another browser is controlling this session.', {
          timeout: 30_000,
        });
        await expect(
          busyPage.getByRole('region', { name: 'Terminal output' }),
        ).toHaveCount(0);
        await expect(
          page.getByRole('region', { name: 'Connection' }).getByRole('status'),
        ).toHaveText('Connected');
      } finally {
        await busyContext.close();
      }
    }
    let output = page.getByRole('region', { name: 'Terminal output' });
    const title =
      {
        vim: 'Native Vim acceptance',
        shell: 'Native Shell acceptance',
        'long-task': 'Native long task acceptance',
        readonly: 'Native readonly acceptance',
        'ai-cli': 'Installed Codex CLI acceptance',
        'ai-cli-codex': 'Installed Codex CLI acceptance',
        'ai-cli-claude': 'Installed Claude Code acceptance',
        'ai-agent-codex': 'Installed Codex CLI acceptance',
        'ai-agent-claude': 'Installed Claude Code acceptance',
        htop: 'Native htop acceptance',
      }[request.scenario] ?? 'Native CLI acceptance';
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    const support = page.getByRole('checkbox', {
      name: 'Screen reader support',
    });
    await expect(support).not.toBeChecked();
    await support.check();

    const paste = async (text) => {
      await page.getByRole('textbox', { name: 'Paste text' }).fill(text);
      await page.getByRole('button', { name: 'Send paste' }).click();
    };
    const crash = async () => {
      stage = 'native-browser-crash';
      // Kill only this test's owned browser, without page unload, CLOSE,
      // context.close() or a graceful application disconnect.
      const crashed = server.process();
      await server.kill();
      if (crashed.signalCode !== 'SIGKILL')
        throw new Error('BROWSER_DID_NOT_CRASH');
      await expect.poll(() => browser.isConnected()).toBe(false);
    };
    if (hostEndsSession) {
      await expect(output).toContainText('child-ready');
      if (request.scenario === 'revocation') {
        stage = 'native-revocation';
        const response = await fetch(`${base.origin}/__test/revoke`, {
          method: 'POST',
          signal: AbortSignal.timeout(2000),
        });
        if (response.status !== 204) throw new Error('REVOCATION_FAILED');
        await response.arrayBuffer();
      } else {
        stage = 'native-expiry';
      }
      await expect(
        page.getByText(
          request.scenario === 'expiry'
            ? 'Session has expired.'
            : 'Session closed.',
          { exact: true },
        ),
      ).toBeVisible({ timeout: 8000 });
      await context.close();
    } else if (killOnDisconnect) {
      await expect(output).toContainText('child-ready');
      await crash();
      // The Go owner must now observe heartbeat loss and child exit 143.
      // No browser shutdown or application CLOSE can trigger that policy.
    } else if (request.scenario.startsWith('ai-cli')) {
      stage = 'ai-cli-version';
      await expect(output).toContainText(request.expectedOutput);
      request.expectedOutput = '';
      await expect(page.getByLabel('Process status')).toContainText('Exit 0');
    } else if (request.scenario === 'readonly') {
      stage = 'readonly-terminal-output';
      await expect(output).toContainText('readonly-ready');
      stage = 'readonly-authority-label';
      await expect(
        page
          .getByRole('region', { name: 'Connection' })
          .getByText('Read only', { exact: true }),
      ).toBeVisible();
      stage = 'readonly-terminal-label';
      await expect(
        page
          .getByRole('region', { name: 'Leash terminal' })
          .getByText('Read only', { exact: true }),
      ).toBeVisible();
      stage = 'readonly-keyboard';
      await expect(
        page.getByRole('button', { name: 'Open keyboard' }),
      ).toHaveCount(0);
      stage = 'readonly-paste';
      await expect(
        page.getByRole('textbox', { name: 'Paste text' }),
      ).toHaveCount(0);
      stage = 'readonly-process-controls';
      await expect(
        page.getByRole('group', { name: 'Process controls' }),
      ).toHaveCount(0);
      stage = 'readonly-exit';
      await expect(page.getByLabel('Process status')).toContainText('Exit 23');
    } else if (request.scenario === 'htop') {
      stage = 'htop-render';
      const ownedPID = new RegExp(`\\b${request.hostPID}\\b`);
      const screen = output.getByRole('list');
      const rows = screen.getByRole('listitem');
      await expect(screen).toContainText(ownedPID);
      await expect(screen).toContainText('Command');
      await expect(rows.last()).toContainText('Help');
      const originalRows = await rows.count();
      stage = 'htop-help';
      await page.getByRole('button', { name: 'Open keyboard' }).click();
      await page.keyboard.press('h');
      await expect(screen).toContainText('CPU usage bar:');
      stage = 'htop-resize';
      await page.setViewportSize({ width: 620, height: 700 });
      await expect(screen).toContainText('CPU usage bar:');
      await page.getByRole('button', { name: 'Esc', exact: true }).click();
      await expect(screen).not.toContainText('CPU usage bar:');
      await expect.poll(() => rows.count()).not.toBe(originalRows);
      await expect(screen).toContainText(ownedPID);
      // htop must redraw its footer at the new PTY bottom, not leave an
      // old screen or accessibility announcement satisfying the assertion.
      await expect(rows.last()).toContainText('Help');
      await page.screenshot({
        path: '.artifacts/leash-browser-htop.png',
        fullPage: true,
      });
      stage = 'htop-exit';
      await page.getByRole('button', { name: 'Open keyboard' }).click();
      await page.keyboard.press('q');
      await expect(page.getByLabel('Process status')).toContainText('Exit 0');
    } else if (request.scenario === 'shell') {
      stage = 'shell-prompt';
      await expect(output).toContainText('tailmouse-fixture>');
      const pid = await page.getByText(/^PID \d+$/).innerText();
      stage = 'shell-calculation';
      await paste('printf "shell-%s\\n" "$((6 * 7))"\n');
      await expect(output).toContainText('shell-42');
      stage = 'shell-unicode';
      await paste('printf "unicode:%s\\n" "🐈"\n');
      await expect(output).toContainText('unicode:🐈');

      stage = 'shell-foreground-task';
      await paste('sh -c \'printf "long-task-%s\\n" ready; exec sleep 30\'\n');
      await expect(output).toContainText('long-task-ready');
      await page
        .getByRole('button', { name: 'Interrupt', exact: true })
        .click();
      await page.getByRole('button', { name: 'Confirm interrupt' }).click();
      stage = 'shell-after-interrupt';
      await paste('printf "after-interrupt:%s\\n" "$?"\n');
      await expect(output).toContainText('after-interrupt:130');
      await expect(page.getByText(pid, { exact: true })).toBeVisible();
      await page.screenshot({
        path: '.artifacts/leash-browser-shell.png',
        fullPage: true,
      });
      stage = 'shell-exit';
      await paste('exit 19\n');
      await expect(page.getByLabel('Process status')).toContainText('Exit 19');
    } else if (request.scenario !== 'vim') {
      stage = 'native-output';
      let progressBeforeDisconnect = 0;
      const latestProgress = async () => {
        const matches = [
          ...(await output.innerText()).matchAll(/long-task-progress:(\d+)/g),
        ];
        return Math.max(0, ...matches.map((match) => Number(match[1])));
      };
      if (interactiveAI) {
        stage = 'ai-agent-process-state';
        await expect
          .poll(async () => {
            const value = await page.getByLabel('Process status').innerText();
            const state = value.includes('running')
              ? 'running'
              : value.includes('starting')
                ? 'starting'
                : /Exit \d+/u.test(value)
                  ? 'exited'
                  : 'other';
            stage = `ai-agent-process-${state}`;
            return state;
          })
          .toBe('running');
        stage = 'ai-agent-screen';
        await expect
          .poll(() => output.getByRole('listitem').count())
          .toBeGreaterThan(0);
        stage = 'ai-agent-input';
        const beforeInput = await output.innerText();
        await page.getByRole('button', { name: 'Open keyboard' }).click();
        await page.keyboard.press('ArrowDown');
        await expect.poll(() => output.innerText()).not.toBe(beforeInput);
      } else if (longTask) {
        await expect(output).toContainText('long-task-ready');
        await expect.poll(latestProgress).toBeGreaterThan(0);
        progressBeforeDisconnect = await latestProgress();
      } else {
        await expect(output).toContainText('child-ready');
        await paste('q🐈');
        await expect(output).toContainText('q🐈');
      }
      if (reconnect) {
        const pid = await page.getByText(/^PID \d+$/).innerText();
        if (retainedExit) {
          stage = 'native-retained-exit';
          await paste('x');
          await expect(page.getByLabel('Process status')).toContainText(
            'Exit 37',
          );
        }
        stage = 'native-disconnect';
        if (request.scenario === 'browser-crash') {
          await crash();
          stage = 'native-local-input-after-crash';
          // No browser is alive and no replacement handshake has started.
          // The loopback fixture supplies only its fixed synthetic marker.
          const localResponse = await fetch(
            `${base.origin}/__test/local-after-crash`,
            { method: 'POST', signal: AbortSignal.timeout(2000) },
          );
          if (localResponse.status !== 204)
            throw new Error('LOCAL_INPUT_FAILED');
          await expect
            .poll(
              async () => {
                const response = await fetch(
                  `${base.origin}/__test/local-after-crash`,
                  { signal: AbortSignal.timeout(1000) },
                );
                if (![202, 204].includes(response.status))
                  throw new Error('LOCAL_OUTPUT_CHECK_FAILED');
                await response.arrayBuffer();
                return response.status;
              },
              { timeout: 3000, intervals: [25, 100] },
            )
            .toBe(204);
          server = await launch();
          browser = await chromium.connect(server.wsEndpoint(), {
            timeout: 10_000,
          });
        } else {
          await page.getByRole('button', { name: 'Exit session' }).click();
          await expect(
            page.getByText('Session closed.', { exact: true }),
          ).toBeVisible();
          await expect(output).toHaveCount(0);
          await context.close();
        }
        if (longTask) {
          // Exceed the removed 30-second reconnect grace with no browser.
          await new Promise((resolve) => setTimeout(resolve, 31_000));
        }
        context = await browser.newContext({
          ignoreHTTPSErrors: true,
          serviceWorkers: 'block',
          viewport: { width: 900, height: 900 },
        });
        context.setDefaultTimeout(10_000);
        page = await context.newPage();
        stage = 'native-reconnect';
        await page.goto(`${request.baseURL}/#/v1/${request.fragment}`);
        request.fragment = '';
        if (protectedAccess) {
          await expect(
            page.getByRole('region', { name: 'Connection' }).getByRole('alert'),
          ).toHaveText('Enter the host access code to continue.', {
            timeout: 30_000,
          });
          await page.getByLabel('Access code').fill(code);
          code = '';
          await page.getByRole('button', { name: 'Connect' }).click();
        }
        await expect
          .poll(
            async () => {
              const region = page.getByRole('region', { name: 'Connection' });
              if (await region.getByRole('alert').count()) {
                const busy = await region
                  .getByText('Another browser is controlling this session.', {
                    exact: true,
                  })
                  .count();
                stage = busy
                  ? 'native-reconnect-busy'
                  : 'native-reconnect-error';
                if (busy && request.scenario === 'browser-crash') {
                  // A crashed TCP peer need not be detected before the first
                  // replacement HELLO. Use the explicit UI retry only within
                  // this assertion's fixed recovery budget.
                  await page
                    .getByRole('button', { name: 'Retry connection' })
                    .click();
                  return 'Retrying';
                }
                throw new Error('RECONNECT_REJECTED');
              }
              return region.getByRole('status').innerText();
            },
            {
              // The accepted 30-second loss detector precedes reconnect. Allow
              // bounded teardown, UI retry and handshake time separately;
              // native virtual-time tests enforce the exact loss boundary.
              timeout: request.scenario === 'browser-crash' ? 40_000 : 30_000,
              intervals: [250, 500, 1000],
            },
          )
          .toBe('Connected');
        stage = 'native-reconnect-history';
        if (page.url() !== `${request.baseURL}/`)
          throw new Error('URL_NOT_CLEAN');
        await expect(page.getByText(pid, { exact: true })).toBeVisible();
        await page
          .getByRole('checkbox', { name: 'Screen reader support' })
          .check();
        output = page.getByRole('region', { name: 'Terminal output' });
        if (!longTask && !interactiveAI)
          await expect(output).toContainText('q🐈');
        if (request.scenario === 'browser-crash')
          await expect(output).toContainText('local-alive🐈');
        await expect(output).not.toContainText('restarted process');
        if (interactiveAI) {
          stage = 'ai-agent-reconnected';
          await expect(page.getByLabel('Process status')).toContainText(
            'running',
          );
          await expect(page.getByText(title, { exact: true })).toBeVisible();
          await expect
            .poll(() => output.getByRole('listitem').count())
            .toBeGreaterThan(0);
          await page.setViewportSize({ width: 620, height: 850 });
          await expect(page.getByText(pid, { exact: true })).toBeVisible();
          stage = 'ai-agent-input-after-reconnect';
          const beforeReconnectInput = await output.innerText();
          await page.getByRole('button', { name: 'Open keyboard' }).click();
          await page.keyboard.press('ArrowUp');
          await expect
            .poll(() => output.innerText())
            .not.toBe(beforeReconnectInput);
          stage = 'ai-agent-terminate';
          await page
            .getByRole('button', { name: 'Terminate', exact: true })
            .click();
          await page
            .getByRole('button', { name: 'Confirm terminate', exact: true })
            .click();
          await expect(page.getByLabel('Process status')).toContainText(
            'Exit 143',
          );
        } else if (longTask) {
          stage = 'long-task-progress-after-reconnect';
          await expect
            .poll(latestProgress)
            .toBeGreaterThan(progressBeforeDisconnect);
          // Also observe a new live update after catch-up, before asking this
          // owned fixture to finish its work and expose the interactive prompt.
          const recoveredProgress = await latestProgress();
          await expect.poll(latestProgress).toBeGreaterThan(recoveredProgress);
          stage = 'long-task-finish-work';
          const finished = await fetch(
            `${base.origin}/__test/finish-long-task`,
            {
              method: 'POST',
              signal: AbortSignal.timeout(2000),
            },
          );
          if (finished.status !== 204)
            throw new Error('LONG_TASK_FINISH_FAILED');
          await finished.arrayBuffer();
          await expect(output).toContainText('long-task-input', {
            timeout: 25_000,
          });
          stage = 'long-task-input';
          await paste('approved\n');
          stage = 'long-task-exit';
          await expect(page.getByLabel('Process status')).toContainText(
            'Exit 0',
          );
        } else if (retainedExit) {
          stage = 'native-retained-restart';
          await expect(page.getByLabel('Process status')).toContainText(
            'Exit 37',
          );
          await expect(
            page.getByRole('button', { name: 'Open keyboard' }),
          ).toBeDisabled();
          await page
            .getByRole('button', { name: 'Restart', exact: true })
            .click();
          await page.getByRole('button', { name: 'Confirm restart' }).click();
          await expect(output).toContainText(
            'TailMouse restarted process · generation 2',
          );
          await expect(output).toContainText('child-ready');
          await expect(page.getByText(pid, { exact: true })).toHaveCount(0);
          await expect(
            page.getByRole('button', { name: 'Open keyboard' }),
          ).toBeEnabled();
        }
        if (!longTask && !interactiveAI) {
          await paste('r🐈');
          await expect(output).toContainText('r🐈');
        }
      }
      if (!longTask && !interactiveAI) {
        stage = 'native-initial-size';
        let sizeSample = 0;
        const size = async () => {
          const sample = ++sizeSample;
          const pattern = new RegExp(`size (\\d+x\\d+) sample ${sample}\\b`);
          await paste('s');
          await expect(output).toContainText(pattern);
          const value = (await output.innerText()).match(pattern)[1];
          measuredSizes.push(value);
          if (measuredSizes.length > 8) measuredSizes.shift();
          return value;
        };
        const original = await size();
        await page.setViewportSize({ width: 420, height: 800 });
        stage = 'native-resized-size';
        await expect
          .poll(size, { intervals: [100], timeout: 5000 })
          .not.toBe(original);
        stage = 'native-restart';
        await page
          .getByRole('button', { name: 'Restart', exact: true })
          .click();
        await page.getByRole('button', { name: 'Confirm restart' }).click();
        await expect(output).toContainText(
          `TailMouse restarted process · generation ${retainedExit ? 3 : 2}`,
        );
        await expect(output).toContainText('child-ready');
        await expect(page.getByText(title, { exact: true })).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Open keyboard' }),
        ).toBeEnabled();
        stage = 'native-exit';
        await paste('x');
        await expect(page.getByLabel('Process status')).toContainText(
          'Exit 37',
        );
      }
    } else {
      stage = 'vim-render';
      await expect(output).toContainText('Native Vim fixture 🐈');
      await page.setViewportSize({ width: 620, height: 850 });
      await expect(output).toContainText('Second fixture line');
      stage = 'vim-edit';
      await support.uncheck();
      await page.getByRole('button', { name: 'Open keyboard' }).click();
      await page.keyboard.press('i');
      await page.keyboard.insertText('Browser edit 🐈 ');
      await support.check();
      await expect(output).toContainText('Browser edit 🐈');
      await page.screenshot({
        path: '.artifacts/leash-browser-vim.png',
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Esc', exact: true }).click();
      await page.getByRole('button', { name: 'Open keyboard' }).click();
      stage = 'vim-exit';
      await page.keyboard.type(':q!');
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Process status')).toContainText('Exit 0');
    }
    if (!killOnDisconnect && !hostEndsSession) {
      stage = 'retention-close';
      await expect(
        page.getByText('Session closed.', { exact: true }),
      ).toBeVisible({
        timeout:
          ['retained-exit', 'readonly'].includes(request.scenario) ||
          request.scenario.startsWith('ai-')
            ? 8_000
            : 5_000,
      });
      await context.close();
    }
  } catch (error) {
    failure = error;
  }
  request.fragment = '';
  if (server !== undefined) {
    if (failure === undefined) stage = 'browser-cleanup';
    try {
      await server.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
  process.stdout.write(
    `${JSON.stringify({
      result: 'passed',
      scenario: request.scenario,
      engine: request.engine,
      browserVersion,
    })}\n`,
  );
}

main().catch(() => {
  process.stderr.write(
    `leash browser acceptance failed at ${stage}; measured sizes: ${JSON.stringify(measuredSizes)}\n`,
  );
  process.exitCode = 1;
});
