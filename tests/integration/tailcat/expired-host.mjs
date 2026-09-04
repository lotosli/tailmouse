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
      /^[A-Za-z0-9_-]{1,16384}$/u.test(request.fragment),
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
    context.setDefaultTimeout(10_000);
    const page = await context.newPage();
    stage = 'expired-handshake';
    await page.goto(`${base.origin}/#/v1/${request.fragment}`);
    request.fragment = '';
    await page
      .getByRole('alert')
      .filter({ hasText: /^Session has expired\.$/u })
      .waitFor();
    check(page.url() === `${base.origin}/`, 'INVITATION_NOT_REMOVED');
    for (const name of ['Retry connection', 'Exit session', 'Dash']) {
      check(
        (await page.getByRole('button', { name, exact: true }).count()) === 0,
        'EXPIRED_HOST_RETAINED_ACTIONS',
      );
    }
    check(
      (await page.getByRole('group', { name: 'Movement controls' }).count()) ===
        0,
      'EXPIRED_HOST_RETAINED_CONTROLS',
    );
    stage = 'cleanup';
    await context.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('expired-host browser acceptance: passed\n');
}

main().catch((error) => {
  const code = error instanceof AcceptanceError ? error.message : 'UNEXPECTED';
  process.stderr.write(
    `expired-host browser acceptance failed at ${stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
