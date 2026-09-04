import { expect, test } from '@playwright/test';
import {
  address,
  installTailcatBridge,
  invitationURL,
  runtimeScript,
} from './session-fixture.ts';

test('a mobile touch gesture scrolls terminal history without typing or moving the page', async ({
  page,
  browserName,
  isMobile,
}) => {
  test.skip(
    browserName !== 'chromium' || !isMobile,
    'Native touch injection in this test uses Chromium CDP; physical-device acceptance is separate.',
  );
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ terminal: true })),
  );
  await page.goto(invitationURL('leash'));
  const support = page.getByRole('checkbox', { name: 'Screen reader support' });
  await support.check();
  await page.evaluate(
    'globalThis.testLeashOutput(Array.from({length: 200}, (_, index) => `history-line-${index}\\r\\n`).join(""))',
  );
  const output = page.getByRole('region', { name: 'Terminal output' });
  const rows = output.getByRole('list');
  await expect(rows).toContainText('history-line-199');
  const firstRow = rows.getByRole('listitem').first();
  const before = Number(await firstRow.getAttribute('aria-posinset'));
  expect(before).toBeGreaterThan(100);
  await support.uncheck();
  await output.scrollIntoViewIfNeeded();
  const pageY = await page.evaluate(() => window.scrollY);
  const box = await output.boundingBox();
  if (box === null) throw new Error('Terminal output is not visible');
  const touch = await page.context().newCDPSession(page);
  try {
    const point = (fraction: number) => ({
      x: box.x + box.width / 2,
      y: box.y + box.height * fraction,
    });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point(0.3)],
    });
    for (const fraction of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7])
      await touch.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [point(fraction)],
      });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await touch.detach();
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(pageY);
  await support.check();
  await expect
    .poll(async () => Number(await firstRow.getAttribute('aria-posinset')))
    .toBeLessThan(before);
  expect(await page.evaluate('globalThis.testLeashInputs')).toEqual([]);
});

test('Unicode text input works by default without corrupting terminal replies under virtual modifiers', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ terminal: true })),
  );
  await page.goto(invitationURL('leash'));
  const support = page.getByRole('checkbox', { name: 'Screen reader support' });
  await expect(support).not.toBeChecked();
  await page.getByRole('button', { name: 'Open keyboard' }).click();
  await page.keyboard.insertText('Unicode 🐈');
  await page.getByRole('button', { name: 'Lock Alt' }).click();
  await page.getByRole('button', { name: 'Open keyboard' }).click();
  await page.keyboard.type('x');
  await page.evaluate('globalThis.testLeashOutput("\\u001b[5n")');
  await expect
    .poll(() =>
      page.evaluate(
        'new TextDecoder().decode(new Uint8Array(globalThis.testLeashInputs.flat()))',
      ),
    )
    .toBe('Unicode 🐈\u001bx\u001b[0n');
  await support.check();
  await expect(
    page.getByRole('region', { name: 'Terminal output' }),
  ).toContainText('TailMouse terminal generation 1');
});

test('terminal rendering, keyboard, bounded paste and confirmed controls work across browser profiles', async ({
  page,
}, testInfo) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ terminal: true })),
  );
  await page.goto(invitationURL('leash'));
  await page.getByRole('checkbox', { name: 'Screen reader support' }).check();
  const output = page.getByRole('region', { name: 'Terminal output' });
  await expect(output).toContainText('TailMouse terminal generation 1');
  await expect(page.getByText('Example CLI 🐈', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Connection' }).getByRole('status'),
  ).toHaveText('Connected');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await page.evaluate(
    'globalThis.testLeashOutput("\\u001b[?1049h\\u001b[2J\\u001b[HFull-screen TUI 🐈\\u001b[38;5;196m color\\u001b[0m")',
  );
  await expect(output).toContainText('Full-screen TUI 🐈');
  await page.screenshot({
    path: testInfo.outputPath('leash-terminal.png'),
    fullPage: true,
  });
  await page.evaluate('globalThis.testLeashOutput("\\u001b[?1049l")');
  await expect(output).toContainText('TailMouse terminal generation 1');
  await page.getByRole('button', { name: 'Open keyboard' }).click();
  await page.keyboard.type('q');
  await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
  await page.getByRole('button', { name: 'Open keyboard' }).click();
  await page.keyboard.type('c');
  await page.getByRole('button', { name: 'Up', exact: true }).click();
  await expect
    .poll(() => page.evaluate('globalThis.testLeashInputs.flat()'))
    .toEqual([113, 3, 27, 91, 65]);
  const paste = 'a'.repeat(32765) + '🐈z';
  await page.evaluate('globalThis.testLeashOutput("\\u001b[?2004h")');
  await page.getByRole('textbox', { name: 'Paste text' }).fill(paste);
  await page.getByRole('button', { name: 'Send paste' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        'globalThis.testLeashInputs.slice(3).map(bytes => bytes.length)',
      ),
    )
    .toEqual([32766, 16]);
  await expect
    .poll(() =>
      page.evaluate(
        'new TextDecoder().decode(new Uint8Array(globalThis.testLeashInputs.slice(3).flat()))',
      ),
    )
    .toBe(`\u001b[200~${paste}\u001b[201~`);
  await expect
    .poll(() => page.evaluate('globalThis.testLeashSizes.length'))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate('globalThis.testLeashControls')).toEqual([]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm restart', exact: true })
    .click();
  await expect(output).toContainText('TailMouse terminal generation 2');
  await expect(page.getByText('Example CLI 🐈', { exact: true })).toBeVisible();
  await expect
    .poll(() => page.evaluate('globalThis.testLeashControls'))
    .toEqual([{ action: 'restart', generation: 1 }]);
  await page.getByRole('button', { name: 'Terminate', exact: true }).click();
  await page
    .getByRole('button', { name: 'Confirm terminate', exact: true })
    .click();
  await expect(page.getByLabel('Process status')).toContainText('Exit 143');
  await expect(page.getByText('Example CLI 🐈', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Open keyboard' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
  await expect(output).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(address);
});

for (const partial of [false, true]) {
  test(`backpressure pauses input and reconnect discards old paste, modifiers and display (${partial ? 'partial frame' : 'frame boundary'})`, async ({
    page,
  }) => {
    await installTailcatBridge(page, (route) =>
      route.fulfill(runtimeScript({ terminal: true })),
    );
    await page.goto(invitationURL('leash'));
    await expect(
      page.getByRole('button', { name: 'Open keyboard' }),
    ).toBeEnabled();
    await page.evaluate('globalThis.testLeashBackpressure = true');
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Input paused: backpressure',
    );
    await expect(
      page.getByRole('button', { name: 'Esc', exact: true }),
    ).toBeDisabled();
    await page.evaluate('globalThis.testLeashBackpressure = false');
    await page.getByRole('button', { name: 'Resume input' }).click();
    await expect(
      page.getByRole('button', { name: 'Esc', exact: true }),
    ).toBeEnabled();
    expect(await page.evaluate('globalThis.testLeashInputs')).toEqual([]);
    await page.getByRole('button', { name: 'Lock Alt' }).click();
    await page
      .getByRole('textbox', { name: 'Paste text' })
      .fill('never send after reconnect');
    await page.evaluate(`globalThis.testDisconnect(${partial})`);
    await expect(
      page.getByRole('button', { name: 'Retry connection' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toHaveCount(0);
    expect(await page.evaluate('globalThis.testDialCount')).toBe(1);
    await page.getByRole('button', { name: 'Retry connection' }).click();
    const support = page.getByRole('checkbox', {
      name: 'Screen reader support',
    });
    await expect(support).not.toBeChecked();
    await support.check();
    await expect(
      page.getByRole('region', { name: 'Terminal output' }),
    ).toContainText('TailMouse terminal generation 2');
    await expect(page.getByRole('textbox', { name: 'Paste text' })).toHaveValue(
      '',
    );
    await expect(
      page.getByRole('button', { name: 'Lock Alt' }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(await page.evaluate('globalThis.testLeashInputs')).toEqual([]);
    expect(await page.evaluate('globalThis.testDialCount')).toBe(2);
  });
}

test('readonly terminal renders scrollback without input, resize or process controls', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ terminal: true, readonly: true })),
  );
  await page.goto(invitationURL('leash'));
  await page.getByRole('checkbox', { name: 'Screen reader support' }).check();
  await expect(
    page.getByRole('region', { name: 'Terminal output' }),
  ).toContainText('TailMouse terminal generation 1');
  for (const name of [
    'Open keyboard',
    'Esc',
    'Restart',
    'Terminate',
    'Interrupt',
    'Send paste',
  ])
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(
      0,
    );
  expect(
    await page.evaluate(
      '[globalThis.testLeashInputs, globalThis.testLeashControls, globalThis.testLeashSizes]',
    ),
  ).toEqual([[], [], []]);
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
});
