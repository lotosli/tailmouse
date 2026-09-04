import { expect, test } from '@playwright/test';
import {
  address,
  cardFixture,
  installTailcatBridge,
  invitationURL,
  runtimeScript,
} from './session-fixture.ts';

for (const [name, viewport] of [
  ['wide window', { width: 1280, height: 720 }],
  ['phone portrait', { width: 390, height: 844 }],
] as const) {
  test(`map and movement controls remain visible together in ${name}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await installTailcatBridge(page, (route) =>
      route.fulfill(runtimeScript({ game: true })),
    );
    await page.goto(invitationURL());
    const map = page.getByRole('img', { name: /courtyard map/u });
    const controls = page.getByRole('group', { name: 'Movement controls' });
    await expect(controls).toBeVisible();
    await controls.focus();
    await expect(map).toBeInViewport({ ratio: 1 });
    await expect(controls).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole('button', { name: 'Dash', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.screenshot({
      path: testInfo.outputPath('escape-visible-controls.png'),
    });
  });
}

test('explicit exit forgets invitation even when transport close fails', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ game: true, closeFailure: true })),
  );
  await page.goto(invitationURL());
  await expect(page.getByRole('status')).toHaveText('Connected');
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Tailcat stream close failed.',
  );
  await expect(
    page.getByRole('button', { name: 'Retry connection' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Movement controls' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exit session' })).toHaveCount(
    0,
  );
  expect(await page.locator('body').innerText()).not.toContain(address);
  expect(await page.locator('body').innerText()).not.toContain(
    'tcSyntheticCloseFailure',
  );
  await page.reload();
  await expect(page.getByRole('alert')).toHaveText(
    'This invitation is invalid or unsupported. Request a new link from the host.',
  );
});

test('full map, live HUD, captured pointer movement, dash cooldown and explicit exit', async ({
  page,
}, testInfo) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ game: true })),
  );
  await page.goto(invitationURL());
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(page.getByRole('img', { name: /courtyard map/u })).toBeVisible();
  await expect(page.getByText('Get ready: 3', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Dash', exact: true }),
  ).toBeDisabled();
  await page.evaluate(
    'globalThis.testGameSnapshot({ phase: 1, elapsed: 1000 })',
  );
  await expect(page.getByLabel('Time remaining', { exact: true })).toHaveText(
    '44.0 s',
  );
  await expect(page.getByTestId('latency')).toContainText('ms /');
  await page.screenshot({
    path: testInfo.outputPath('escape-game.png'),
    fullPage: true,
  });
  const joystick = page.getByRole('group', { name: 'Movement controls' });
  await joystick.scrollIntoViewIfNeeded();
  const bounds = await joystick.boundingBox();
  if (!bounds) throw new Error('Movement controls have no interactive area');
  const x = bounds.x + bounds.width / 2,
    y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 4 });
  await expect
    .poll(() => page.evaluate('globalThis.testGameInputs.at(-1)?.x'))
    .toBeGreaterThan(0);
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate('globalThis.testGameInputs.at(-1)?.x'))
    .toBe(0);
  await page.getByRole('button', { name: 'Dash', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Dash · 5.0 s' }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
  await expect(joystick).toHaveCount(0);
});

test('host presentation settings keep authorized controls with permission-free touch and denied tilt fallback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'DeviceOrientationEvent', {
      configurable: true,
      value: { requestPermission: () => Promise.resolve('denied') },
    });
  });
  await installTailcatBridge(page, (route) =>
    route.fulfill(
      runtimeScript({
        game: true,
        phoneRender: false,
        showNet: false,
        control: 'tilt',
      }),
    ),
  );
  await page.goto(invitationURL());
  await expect(
    page.getByText(/Phone rendering is disabled by the host/u),
  ).toBeVisible();
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.getByTestId('latency')).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Movement controls' }),
  ).toBeVisible();
  await expect(page.getByText(/The host prefers tilt/u)).toBeVisible();
  await page.getByRole('button', { name: 'Enable tilt' }).click();
  await expect(
    page.getByText('Tilt permission was denied. Touch controls are active.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Touch', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByText('Text map and positions', { exact: true }).click();
  await expect(page.getByLabel('Map walls and floor')).toBeVisible();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
});

test('Canvas predicts movement without another host snapshot and snaps back to host authority', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ game: true })),
  );
  await page.goto(invitationURL());
  const canvas = page.getByRole('img', { name: /courtyard map/u });
  await expect(canvas).toBeVisible();
  const controls = page.getByRole('group', { name: 'Movement controls' });
  await controls.focus();
  await page.evaluate(
    'globalThis.testGameSnapshot({ phase: 1, elapsed: 1000 })',
  );
  await page.keyboard.down('ArrowRight');
  // Inspect actual mouse-body pixels, not a test-only view into product state.
  const mouseX = () =>
    canvas.evaluate((element) => {
      const image = element as HTMLCanvasElement;
      const row = image
        .getContext('2d')!
        .getImageData(
          0,
          Math.round((3.4 * image.height) / 18),
          image.width,
          1,
        ).data;
      const columns: number[] = [];
      for (let x = 0; x < image.width; x++) {
        if (
          row[x * 4] === 231 &&
          row[x * 4 + 1] === 234 &&
          row[x * 4 + 2] === 241
        )
          columns.push(x);
      }
      return columns.length
        ? ((columns[0]! + columns[columns.length - 1]!) * 24) / image.width
        : -1;
    });
  await expect.poll(mouseX).toBeGreaterThan(4);
  await page.keyboard.up('ArrowRight');
  await expect(
    page.getByText('Mouse · Cat · Cheese 0/2 · Exit locked', { exact: true }),
  ).toBeVisible();
  await page.evaluate(
    'globalThis.testGameSnapshot({ mouse: { x: 10.5, y: 3.5 } })',
  );
  await expect.poll(mouseX).toBeGreaterThan(10.3);
  expect(await mouseX()).toBeLessThan(10.7);
  await page.getByText('Text map and positions', { exact: true }).click();
  await expect(page.getByText(/Mouse 10.5, 3.5/u)).toBeVisible();
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
});

test('all authoritative result summaries survive immediate host close without retaining invitation material', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ game: true })),
  );
  for (const [outcome, heading] of [
    ['escaped', 'THE MOUSE ESCAPED'],
    ['caught', 'THE CAT WON'],
    ['timeout', 'TIME RAN OUT'],
    ['connection_lost', 'CONNECTION LOST'],
  ] as const) {
    await page.goto(invitationURL());
    await expect(page.getByRole('img')).toBeVisible();
    await page.evaluate(
      `globalThis.testGameResult(${JSON.stringify(outcome)})`,
    );
    await expect(page.getByRole('status')).toHaveText('Session closed.');
    await expect(
      page.getByRole('heading', { name: heading, exact: true }),
    ).toBeVisible();
    await expect(page.getByText('1.2 s', { exact: true })).toBeVisible();
    await expect(page.getByText('63 ms', { exact: true })).toBeVisible();
    await expect(
      page.getByText('relay.example.com', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Retry connection' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('group', { name: 'Movement controls' }),
    ).toHaveCount(0);
    for (const secret of [address, cardFixture, '#/v1/'])
      await expect(page.locator('body')).not.toContainText(secret);
    await page.goto('about:blank');
  }
});

test('retained session restarts the round without old movement, dash or result state', async ({
  page,
}) => {
  await installTailcatBridge(page, (route) =>
    route.fulfill(runtimeScript({ game: true })),
  );
  await page.goto(invitationURL());
  const controls = page.getByRole('group', { name: 'Movement controls' });
  await expect(controls).toBeVisible();
  await page.evaluate(
    'globalThis.testGameSnapshot({ phase: 1, elapsed: 1000 })',
  );
  await controls.focus();
  await page.keyboard.down('ArrowRight');
  await expect
    .poll(() => page.evaluate('globalThis.testGameInputs.at(-1)?.x'))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Dash', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Dash · 5.0 s' }),
  ).toBeDisabled();
  await page.evaluate("globalThis.testGameResult('caught', false)");
  await expect(
    page.getByRole('heading', { name: 'THE CAT WON' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Connected');
  await expect(controls).toHaveCount(0);
  await page.keyboard.up('ArrowRight');
  await page.evaluate('globalThis.testGameRestart()');
  await expect(page.getByRole('heading', { name: 'THE CAT WON' })).toHaveCount(
    0,
  );
  await expect(page.getByText('Get ready: 3', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Time remaining', { exact: true })).toHaveText(
    '45.0 s',
  );
  await expect(controls).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Dash', exact: true }),
  ).toBeDisabled();
  await page.evaluate('globalThis.testGameSnapshot({ phase: 1 })');
  await expect(
    page.getByRole('button', { name: 'Dash', exact: true }),
  ).toBeEnabled();
  await expect
    .poll(() => page.evaluate('globalThis.testGameInputs.at(-1)'))
    .toEqual({ x: 0, y: 0, dash: false });
  await controls.focus();
  await page.keyboard.down('ArrowLeft');
  await expect
    .poll(() => page.evaluate('globalThis.testGameInputs.at(-1)?.x'))
    .toBeLessThan(0);
  await page.keyboard.up('ArrowLeft');
  expect(await page.evaluate('globalThis.testDialCount')).toBe(1);
  await page.getByRole('button', { name: 'Exit session' }).click();
  await expect(page.getByRole('status')).toHaveText('Session closed.');
});
