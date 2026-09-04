import { chromium } from '@playwright/test';

let stage = 'input';
class AcceptanceError extends Error {}
const check = (condition, code) => {
  if (!condition) throw new AcceptanceError(code);
};

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
      /^[A-Za-z0-9_-]{1,16384}$/u.test(request.fragment) &&
      typeof request.address === 'string' &&
      request.address.length > 0 &&
      request.address.length <= 16384,
    'INVALID_INVITATION',
  );
  stage = 'launch';
  const browser = await chromium.launch({
    headless: true,
    timeout: 10_000,
    args: ['--ignore-certificate-errors'],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(70_000);
    const page = await context.newPage();
    let disclosed = false;
    const fragment = request.fragment;
    const address = request.address;
    const inspect = (text) => {
      disclosed ||= text.includes(fragment) || text.includes(address);
    };
    page.on('console', (message) => inspect(message.text()));
    page.on('pageerror', (error) => inspect(error.message));
    page.on('request', (request) => inspect(request.url()));
    stage = 'client-rejection';
    await page.goto(`${base.origin}/#/v1/${fragment}`);
    request.fragment = '';
    request.address = '';
    await page
      .getByRole('alert')
      .filter({ hasText: /^Tailcat connection timed out\.$/u })
      .waitFor();
    check(page.url() === `${base.origin}/`, 'INVITATION_NOT_REMOVED');
    inspect(await page.locator('body').innerText());
    check(!disclosed, 'INVITATION_DISCLOSED');
    check(
      await page
        .getByRole('button', { name: 'Retry connection', exact: true })
        .isVisible(),
      'EXPLICIT_RETRY_MISSING',
    );
    check(
      (await page
        .getByRole('button', { name: 'Exit session', exact: true })
        .count()) === 0,
      'UNEXPECTED_SESSION',
    );
    check(
      (await page.getByRole('group', { name: 'Movement controls' }).count()) ===
        0,
      'UNEXPECTED_MODE_CONTROLS',
    );
    stage = 'cleanup';
    await context.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('client-verification browser acceptance: passed\n');
}

main().catch((error) => {
  const code = error instanceof AcceptanceError ? error.message : 'UNEXPECTED';
  process.stderr.write(
    `client-verification browser acceptance failed at ${stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
