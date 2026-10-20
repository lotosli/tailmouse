import { chromium, firefox, webkit, expect } from '@playwright/test';

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeError';
  }
}

let stage = 'startup';
let failureStage;

function enterStage(next) {
  stage = next;
  process.stderr.write(`browser transport stage: ${next}\n`);
}

async function main() {
  enterStage('input');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  for (const chunk of chunks) chunk.fill(0);
  let request;
  try {
    request = JSON.parse(input.toString('utf8'));
  } catch {
    throw new ProbeError('INPUT_INVALID');
  } finally {
    input.fill(0);
  }
  assertInput(request);

  enterStage('launch');
  const browser = await { chromium, firefox, webkit, chrome: chromium }[
    request.engine
  ].launch({
    ...(request.engine === 'chrome' ? { channel: 'chrome' } : {}),
    ...(['chromium', 'chrome'].includes(request.engine)
      ? { args: ['--ignore-certificate-errors'] }
      : {}),
    headless: true,
  });
  try {
    const version = browser.version();
    if (!/^\d+(?:\.\d+){1,3}$/.test(version) || version.length > 64) {
      throw new ProbeError('RUNTIME_VERSION_INVALID');
    }
    process.stdout.write(version);
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(90_000);

    enterStage('session');
    const validPage = await context.newPage();
    await validPage.goto(invitationURL(request.baseURL, request.validFragment));
    const connection = validPage.getByRole('region', { name: 'Connection' });
    await expect(connection.getByRole('status')).toHaveText('Connected');
    assertCleanURL(validPage.url(), request.baseURL);
    await validPage.waitForFunction(() =>
      document
        .querySelector('[data-testid="latency"]')
        ?.textContent?.includes('ms /'),
    );
    await connection
      .getByText('Read only', { exact: true })
      .waitFor({ timeout: 5000 });
    enterStage('busy');
    const busyPage = await context.newPage();
    await busyPage.goto(invitationURL(request.baseURL, request.validFragment));
    await busyPage.getByRole('alert').waitFor();
    if (
      !(await busyPage.getByRole('alert').textContent())?.includes(
        'Another browser is controlling',
      )
    ) {
      throw new ProbeError('BUSY_OUTCOME');
    }
    if (
      !(await busyPage
        .getByRole('button', { name: 'Retry connection' })
        .isVisible())
    ) {
      throw new ProbeError('BUSY_RETRY_MISSING');
    }
    assertCleanURL(busyPage.url(), request.baseURL);
    await busyPage.close();

    enterStage('session-close');
    await validPage.getByRole('button', { name: 'Exit session' }).click();
    await expect(connection.getByRole('status')).toHaveText('Session closed.');
    await validPage.close();

    enterStage('incorrect-token');
    const invalidPage = await context.newPage();
    await invalidPage.goto(
      invitationURL(request.baseURL, request.invalidFragment),
    );
    const alert = invalidPage.locator('[role="alert"]');
    await alert.waitFor({ state: 'visible' });
    const invalidDetail = await alert.textContent();
    const incorrectTokenOutcome =
      invalidDetail === 'Tailcat connection timed out.'
        ? 'DIAL_TIMEOUT'
        : invalidDetail === 'Tailcat connection failed.'
          ? 'DIAL_FAILED'
          : undefined;
    if (incorrectTokenOutcome === undefined)
      throw new ProbeError('INCORRECT_TOKEN_OUTCOME_UNKNOWN');
    process.stdout.write(`\n${incorrectTokenOutcome}`);
    const visibleText = await invalidPage.locator('body').innerText();
    if (visibleText.includes(request.incorrectAddress)) {
      throw new ProbeError('TOKEN_DISCLOSED');
    }
    assertCleanURL(invalidPage.url(), request.baseURL);
    await invalidPage.close();
    enterStage('context-close');
    await context.close();

    request.validFragment = '';
    request.invalidFragment = '';
    request.incorrectAddress = '';
  } catch (error) {
    failureStage = stage;
    throw error;
  } finally {
    enterStage('browser-close');
    await browser.close();
  }
  enterStage('done');
}

function assertInput(request) {
  if (
    typeof request !== 'object' ||
    request === null ||
    !['chromium', 'firefox', 'webkit', 'chrome'].includes(request.engine) ||
    typeof request.baseURL !== 'string' ||
    typeof request.validFragment !== 'string' ||
    typeof request.invalidFragment !== 'string' ||
    typeof request.incorrectAddress !== 'string' ||
    !/^[A-Za-z0-9_-]+$/.test(request.validFragment) ||
    !/^[A-Za-z0-9_-]+$/.test(request.invalidFragment)
  ) {
    throw new ProbeError('INPUT_INVALID');
  }
  const base = new URL(request.baseURL);
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1') {
    throw new ProbeError('INPUT_INVALID');
  }
}

function invitationURL(baseURL, fragment) {
  return `${baseURL}/#/v1/${fragment}`;
}

function assertCleanURL(actual, baseURL) {
  const value = new URL(actual);
  const expected = new URL(baseURL);
  if (
    value.origin !== expected.origin ||
    value.pathname !== '/' ||
    value.search !== '' ||
    value.hash !== ''
  ) {
    throw new ProbeError('URL_NOT_CLEAN');
  }
}

main().catch((error) => {
  const code =
    error instanceof ProbeError
      ? error.message
      : error instanceof Error && error.name === 'TimeoutError'
        ? 'OPERATION_TIMEOUT'
        : error instanceof Error &&
            error.message.includes(
              'Target page, context or browser has been closed',
            )
          ? 'BROWSER_CLOSED'
          : 'UNEXPECTED';
  process.stderr.write(
    `browser transport probe failed at ${failureStage ?? stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
