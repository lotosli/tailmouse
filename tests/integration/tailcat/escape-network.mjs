import { chromium } from '@playwright/test';

let stage = 'input';
class AcceptanceError extends Error {}
const check = (condition, code) => {
  if (!condition) throw new AcceptanceError(code);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks);
  chunks.forEach((chunk) => chunk.fill(0));
  const request = JSON.parse(input.toString('utf8'));
  input.fill(0);
  const base = new URL(request.baseURL);
  check(
    base.protocol === 'http:' && base.hostname === '127.0.0.1',
    'LOCAL_ONLY',
  );
  check(/^[A-Za-z0-9_-]+$/.test(request.fragment), 'INVALID_INVITATION');
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors'],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    stage = 'connect';
    await page.goto(`${base.origin}/#/v1/${request.fragment}`);
    request.fragment = '';
    await page.waitForFunction(
      () =>
        document.querySelector('[role="status"]')?.textContent === 'Connected',
    );
    check(page.url() === `${base.origin}/`, 'INVITATION_NOT_REMOVED');
    await page.getByRole('button', { name: 'Dash', exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (button) => button.textContent === 'Dash' && !button.disabled,
      ),
    );
    const state = async () => {
      const response = await fetch(`${base.origin}/__test/state`, {
        signal: AbortSignal.timeout(3000),
      });
      check(response.ok, 'OBSERVATION_FAILED');
      return response.json();
    };
    stage = 'prediction';
    const initial = await state();
    assertReachableMap(initial.view.Map);
    const control = page.getByRole('group', { name: 'Movement controls' });
    await control.focus();
    // Read the actual rendered mouse, not a mocked game/transport hook. Keyboard
    // events use the production accessible movement surface and animation loop.
    const feedbackMS = await page.evaluate(async () => {
      const area = document.querySelector('[aria-label="Movement controls"]');
      const canvas = document.querySelector('canvas[role="img"]');
      const context = canvas.getContext('2d');
      const mouseX = () => {
        const pixels = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        ).data;
        let sum = 0,
          count = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (
            pixels[index] === 231 &&
            pixels[index + 1] === 234 &&
            pixels[index + 2] === 241
          ) {
            sum += (index / 4) % canvas.width;
            count++;
          }
        }
        return count > 0 ? sum / count : NaN;
      };
      const before = mouseX(),
        start = performance.now();
      area.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      const elapsed = await new Promise((resolve) => {
        const sample = () => {
          if (mouseX() > before + 0.2)
            return resolve(performance.now() - start);
          if (performance.now() - start > 250) return resolve(Infinity);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      area.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }),
      );
      return elapsed;
    });
    check(
      Number.isFinite(feedbackMS) && feedbackMS <= 150,
      'PREDICTION_EXCEEDED_150MS',
    );
    // This is a bounded end-to-end liveness check, not the PRD's three-second
    // host receipt-silence deadline (asserted separately by verifyOutage).
    // Actual 300 ms/5%/64 Kbit/s delivery exceeded four seconds while local
    // feedback stayed immediate. Include TCP recovery and the post-gap PONG.
    await page.keyboard.down('ArrowRight');
    const movementStarted = performance.now();
    const moveDeadline = movementStarted + 10_000;
    let moved;
    const movementTrace = [];
    do {
      await delay(50);
      moved = await state();
      movementTrace.push({
        ms: Math.round(performance.now() - movementStarted),
        x: moved.view.State.Mouse.X,
        sequence: moved.view.State.AcceptedSequence,
        phase: moved.view.State.Phase,
        paused: moved.view.State.Paused,
      });
      if (movementTrace.length > 8) movementTrace.shift();
    } while (
      moved.view.State.Mouse.X <= initial.view.State.Mouse.X &&
      performance.now() < moveDeadline
    );
    if (moved.view.State.Mouse.X <= initial.view.State.Mouse.X) {
      const focus = await page.evaluate(() => ({
        movement:
          document.activeElement?.getAttribute('aria-label') ===
          'Movement controls',
        visible: document.visibilityState === 'visible',
      }));
      const observation = {
        failure: 'HELD_INPUT_NOT_APPLIED',
        profile: request.profile,
        initial: {
          x: initial.view.State.Mouse.X,
          sequence: initial.view.State.AcceptedSequence,
        },
        trace: movementTrace,
        rttMS: moved.metrics.rtt_ms,
        dropped: moved.network.map((direction) => direction.Dropped),
        focus,
      };
      process.stdout.write(`${JSON.stringify(observation)}\n`);
    }
    check(
      moved.view.State.Mouse.X > initial.view.State.Mouse.X,
      'HELD_INPUT_NOT_APPLIED',
    );
    const hostMovementMS = performance.now() - movementStarted;
    await page.keyboard.up('ArrowRight');
    stage = 'traffic-and-authority';
    let previous = await state();
    let maxBytesPerSecond = 0;
    for (let sample = 0; sample < 3; sample++) {
      await delay(1050);
      const current = await state();
      const bytes =
        current.metrics.bytes_tx +
        current.metrics.bytes_rx -
        previous.metrics.bytes_tx -
        previous.metrics.bytes_rx;
      const rate = (bytes * 1000) / (current.nowMS - previous.nowMS);
      maxBytesPerSecond = Math.max(maxBytesPerSecond, rate);
      check(rate < 20 * 1024, 'APPLICATION_TRAFFIC_EXCEEDED_20KIB');
      check(
        current.view.Queue <= 16 && current.view.State.PendingDash <= 8,
        'GAME_QUEUE_UNBOUNDED',
      );
      check(current.metrics.protocol_errors === 0, 'PROTOCOL_ERROR');
      const mouse = current.view.State.Mouse;
      check(
        current.view.Map.Rows[Math.floor(mouse.Y)][Math.floor(mouse.X)] === '.',
        'HOST_COLLISION_INVALID',
      );
      previous = current;
    }
    const final = previous;
    check(
      final.view.State.AcceptedSequence >
        initial.view.State.AcceptedSequence + 20,
      'INPUT_STREAM_STALLED',
    );
    check(
      final.view.State.Mouse.X > initial.view.State.Mouse.X,
      'HOST_IGNORED_MOVEMENT',
    );
    check(
      final.metrics.samples >= 2 &&
        final.metrics.p95_ms >= request.profile.rttMS * 0.7,
      'RTT_NOT_MEASURED',
    );
    for (const direction of final.network) {
      check(
        direction.Delivered > 20 && direction.MaxQueue <= 128,
        'IMPAIRMENT_PATH_NOT_EXERCISED',
      );
      if (request.profile.loss > 0)
        check(direction.Dropped > 0, 'PACKET_LOSS_NOT_EXERCISED');
      const minDelay = Math.max(
        0,
        (request.profile.rttMS - request.profile.jitterMS) / 2,
      );
      check(direction.DelayMinMS >= minDelay - 1, 'PROPAGATION_DELAY_BYPASSED');
    }
    const latency = await page.getByTestId('latency').textContent();
    check(latency.includes('ms /'), 'BROWSER_RTT_MISSING');
    check(
      (await page.getByRole('status').textContent()) === 'Connected',
      'SESSION_NOT_CONNECTED',
    );
    process.stdout.write(
      `${JSON.stringify({ profile: request.profile, map: initial.view.Map.Name, feedbackMS, hostMovementMS, maxBytesPerSecond, rttP95MS: final.metrics.p95_ms, network: final.network })}\n`,
    );
    if (request.scenario.startsWith('pause-')) {
      stage = request.scenario;
      const evidence = await verifyOutage(
        page,
        state,
        base.origin,
        Number(request.scenario.slice(6)),
      );
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    }
    if (request.scenario === 'reconnect') {
      stage = 'reconnect';
      await verifyReconnect(page, state, base.origin);
      process.stdout.write('escape network reconnect: passed\n');
    }
    if (request.scenario === 'relay-disconnect') {
      stage = 'relay-disconnect';
      const evidence = await verifyRelayDisconnect(page, state, base.origin);
      process.stdout.write(`${JSON.stringify(evidence)}\n`);
    }
    if (request.scenario !== 'pause-31000') {
      stage = 'visual-convergence';
      const target = (await state()).view.State.Mouse;
      await page
        .waitForFunction(
          (target) => {
            const canvas = document.querySelector('canvas[role="img"]');
            if (canvas === null) return false;
            const pixels = canvas
              .getContext('2d')
              .getImageData(0, 0, canvas.width, canvas.height).data;
            let x = 0,
              y = 0,
              count = 0;
            for (let index = 0; index < pixels.length; index += 4) {
              if (
                pixels[index] === 231 &&
                pixels[index + 1] === 234 &&
                pixels[index + 2] === 241
              ) {
                x += (index / 4) % canvas.width;
                y += Math.floor(index / 4 / canvas.width);
                count++;
              }
            }
            return (
              count > 0 &&
              Math.hypot(
                ((x / count) * 48) / canvas.width - target.X,
                ((y / count) * 18) / canvas.height - target.Y,
              ) < 0.25
            );
          },
          target,
          { timeout: 5000 },
        )
        .catch(() => {
          throw new AcceptanceError('VISUAL_DID_NOT_CONVERGE');
        });
    }
    stage = 'close';
    const closeStarted = performance.now();
    if (request.scenario !== 'pause-31000') {
      await page
        .getByRole('button', { name: 'Exit session' })
        .click({ timeout: 5000 })
        .catch(() => {
          throw new AcceptanceError('EXIT_CONTROL_UNAVAILABLE');
        });
      await page
        .waitForFunction(
          () =>
            document.querySelector('[role="status"]')?.textContent ===
              'Session closed.' ||
            [
              'The session could not close cleanly.',
              'Tailcat stream close failed.',
            ].includes(document.querySelector('[role="alert"]')?.textContent),
          undefined,
          { timeout: 7000 },
        )
        .catch(() => {
          throw new AcceptanceError('EXIT_DID_NOT_FINISH_SAFELY');
        });
    }
    check(
      (await page.getByRole('button', { name: 'Retry connection' }).count()) ===
        0,
      'EXPLICIT_EXIT_RETAINED_INVITATION',
    );
    check(
      (await page.getByRole('group', { name: 'Movement controls' }).count()) ===
        0,
      'EXPLICIT_EXIT_RETAINED_CONTROLS',
    );
    const closeFailure = await page.evaluate(
      () => document.querySelector('[role="alert"]')?.textContent ?? null,
    );
    process.stdout.write(
      `${JSON.stringify(
        request.scenario === 'pause-31000'
          ? { closeOutcome: 'loss-then-expired' }
          : {
              closeMS: performance.now() - closeStarted,
              closeOutcome:
                closeFailure === null ? 'graceful' : 'reported-bounded-failure',
            },
      )}\n`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
  process.stdout.write('escape network acceptance: passed\n');
}

async function verifyOutage(page, state, baseURL, duration) {
  const before = await state();
  await page.getByRole('group', { name: 'Movement controls' }).focus();
  await page.keyboard.down('ArrowRight');
  const moveDeadline = performance.now() + 3000;
  let moving;
  do {
    await delay(50);
    moving = await state();
  } while (
    moving.view.State.Mouse.X <= before.view.State.Mouse.X &&
    performance.now() < moveDeadline
  );
  check(
    moving.view.State.Mouse.X > before.view.State.Mouse.X,
    'OUTAGE_PRECONDITION_NOT_MOVING',
  );
  const response = await fetch(`${baseURL}/__test/pause/${duration}`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  check(response.ok, 'OUTAGE_NOT_STARTED');
  const start = performance.now();
  // Different stale directions make a replay observable in the host's Y axis.
  await page.keyboard.up('ArrowRight');
  await page.keyboard.down('ArrowDown');
  await delay(70);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowLeft');
  await delay(70);
  await page.keyboard.up('ArrowLeft');
  let stopped, pausedAt, pauseTick, resumedAt, outcome, latest;
  let outageSequence = moving.view.State.AcceptedSequence;
  const end = start + duration + 6000;
  while (performance.now() < end) {
    await delay(25);
    latest = await state();
    const elapsed = performance.now() - start;
    const current = latest.view.State;
    if (elapsed <= duration)
      outageSequence = Math.max(outageSequence, current.AcceptedSequence);
    if (elapsed >= 750 && elapsed < duration) {
      stopped ??= current.Mouse;
      check(
        Math.hypot(current.Mouse.X - stopped.X, current.Mouse.Y - stopped.Y) <
          0.001,
        'MOUSE_DID_NOT_STOP_DURING_OUTAGE',
      );
    }
    if (current.Paused) {
      pausedAt ??= elapsed;
      pauseTick ??= current.Tick;
      check(current.Tick === pauseTick, 'PAUSED_SIMULATION_ADVANCED');
    }
    if (duration >= 3000 && elapsed >= 3250 && pausedAt === undefined) {
      throw new AcceptanceError('THREE_SECOND_PAUSE_MISSING');
    }
    if (current.Outcome === 'connection_lost') {
      outcome = current.Outcome;
      check(
        duration === 31000 && elapsed >= 29_500 && elapsed <= 30_500,
        'GRACE_OUTCOME_TIMING',
      );
      break;
    }
    check(
      current.Phase !== 'finished',
      'OUTAGE_ENDED_WITH_UNEXPECTED_GAME_RESULT',
    );
    if (
      elapsed > duration &&
      current.AcceptedSequence > outageSequence &&
      !current.Paused
    ) {
      resumedAt ??= elapsed;
      if (elapsed > resumedAt + 1000) break;
    }
  }
  if (duration === 31000) {
    check(
      outcome === 'connection_lost' && latest.view.CanRestart === false,
      'GRACE_DID_NOT_END_ROUND',
    );
    // PRD 7.4 closes the old stream after missing PONGs. Depending on the
    // last valid PONG, result transmission may precede that close or lose the
    // race. Require a visible loss and a fresh rejected handshake instead of
    // assuming the dead stream delivers a result or retains an Exit button.
    await page
      .getByRole('button', { name: 'Retry connection' })
      .waitFor({ timeout: 35_000 })
      .catch(() => {
        throw new AcceptanceError('LOST_STREAM_DID_NOT_END');
      });
    check(
      (await page.getByRole('group', { name: 'Movement controls' }).count()) ===
        0,
      'LOST_STREAM_RETAINED_CONTROLS',
    );
    await page
      .getByRole('button', { name: 'Retry connection' })
      .click({ timeout: 5000 });
    await page
      .getByRole('alert')
      .filter({ hasText: /^Session has expired\.$/u })
      .waitFor({ timeout: 10_000 })
      .catch(() => {
        throw new AcceptanceError('ENDED_HOST_ACCEPTED_RECONNECT');
      });
    check(
      (await page.getByRole('button', { name: 'Retry connection' }).count()) ===
        0 &&
        (await page.getByRole('button', { name: 'Exit session' }).count()) ===
          0,
      'EXPIRED_HOST_RETAINED_CONNECTION_ACTIONS',
    );
    check(
      (await state()).view.State.Outcome === 'connection_lost',
      'EXPIRED_ROUND_RESURRECTED',
    );
  } else {
    check(resumedAt !== undefined, 'INPUT_DID_NOT_RECOVER');
    const stable = latest.view.State.Mouse;
    await delay(500);
    const settled = (await state()).view.State.Mouse;
    process.stdout.write(
      `${JSON.stringify({ outageMS: duration, moving: moving.view.State.Mouse, stable, settled, resumedAtMS: resumedAt })}\n`,
    );
    check(
      Math.hypot(settled.X - stable.X, settled.Y - stable.Y) < 0.001,
      'STALE_INPUT_REPLAY_CONTINUED',
    );
    check(
      Math.abs(settled.Y - moving.view.State.Mouse.Y) <= 0.21,
      'STALE_DIRECTION_REPLAYED',
    );
    check(
      Math.abs(settled.X - moving.view.State.Mouse.X) <= 2.4,
      'STALE_MOVEMENT_BACKLOG',
    );
  }
  return {
    outageMS: duration,
    pausedAtMS: pausedAt ?? null,
    resumedAtMS: resumedAt ?? null,
    outcome: outcome ?? 'recovered',
  };
}

async function verifyReconnect(page, state, baseURL) {
  const before = await state();
  const response = await fetch(`${baseURL}/__test/disconnect`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  check(response.ok, 'DISCONNECT_NOT_APPLIED');
  await page.getByRole('button', { name: 'Retry connection' }).waitFor();
  await delay(3500);
  const paused = await state();
  check(
    paused.view.State.Paused && paused.metrics.active_conn === false,
    'DISCONNECTED_HOST_DID_NOT_PAUSE',
  );
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="status"]')?.textContent === 'Connected',
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent === 'Dash' && !button.disabled,
    ),
  );
  const after = await state();
  check(
    after.metrics.reconnect_count === 1 && after.metrics.active_conn,
    'FRESH_STREAM_DID_NOT_RECONNECT',
  );
  check(
    after.view.Round === before.view.Round &&
      after.view.Map.Name === before.view.Map.Name,
    'RECONNECT_REPLACED_ROUND',
  );
  check(
    after.view.State.AcceptedSequence > paused.view.State.AcceptedSequence &&
      !after.view.State.Paused,
    'FRESH_INPUT_DID_NOT_RESUME',
  );
  check(
    after.view.State.Elapsed >= paused.view.State.Elapsed &&
      after.view.State.Elapsed - paused.view.State.Elapsed < 1_000_000_000,
    'RECONNECT_REPLAYED_ELAPSED_TIME',
  );
  check(
    Math.hypot(
      after.view.State.Mouse.X - paused.view.State.Mouse.X,
      after.view.State.Mouse.Y - paused.view.State.Mouse.Y,
    ) < 0.001,
    'RECONNECT_RETAINED_MOVEMENT',
  );
}

async function verifyRelayDisconnect(page, state, baseURL) {
  const before = await state();
  check(
    before.network.every((direction) => direction.Connections >= 1),
    'RELAY_CONNECTIONS_MISSING',
  );
  const response = await fetch(`${baseURL}/__test/disconnect-relay`, {
    method: 'POST',
    signal: AbortSignal.timeout(3000),
  });
  check(response.ok, 'RELAY_DISCONNECT_NOT_APPLIED');
  const started = performance.now();
  const deadline = started + 15_000;
  let retried = false;
  let recovered;
  while (performance.now() < deadline) {
    const retry = page.getByRole('button', { name: 'Retry connection' });
    if (!retried && (await retry.isVisible())) {
      await retry.click({ timeout: 3000 });
      retried = true;
    }
    recovered = await state();
    if (
      recovered.network.every(
        (direction, side) =>
          direction.Connections > before.network[side].Connections &&
          direction.Delivered > before.network[side].Delivered,
      ) &&
      recovered.metrics.active_conn &&
      recovered.metrics.samples > before.metrics.samples &&
      recovered.view.State.AcceptedSequence >
        before.view.State.AcceptedSequence &&
      !recovered.view.State.Paused
    )
      break;
    await delay(50);
  }
  check(performance.now() < deadline, 'RELAY_DID_NOT_RECOVER');
  check(
    recovered.view.Round === before.view.Round &&
      recovered.view.Map.Name === before.view.Map.Name &&
      recovered.view.State.Phase !== 'finished',
    'RELAY_DISCONNECT_REPLACED_ROUND',
  );
  check(
    recovered.metrics.reconnect_count ===
      before.metrics.reconnect_count + Number(retried),
    'RELAY_RECOVERY_CHANGED_APPLICATION_LEASE',
  );
  // Exercise fresh user intent after both actual DERP sockets have changed.
  await page.getByRole('group', { name: 'Movement controls' }).focus();
  const initialX = recovered.view.State.Mouse.X;
  await page.keyboard.down('ArrowRight');
  try {
    const movementDeadline = performance.now() + 3000;
    do {
      await delay(50);
      recovered = await state();
    } while (
      recovered.view.State.Mouse.X <= initialX &&
      performance.now() < movementDeadline
    );
    check(
      recovered.view.State.Mouse.X > initialX,
      'RELAY_RECOVERY_IGNORED_FRESH_INPUT',
    );
  } finally {
    await page.keyboard.up('ArrowRight');
  }
  return {
    relayRecoveryMS: performance.now() - started,
    applicationRecovery: retried ? 'fresh-stream' : 'retained-stream',
    relayConnections: recovered.network.map(
      (direction) => direction.Connections,
    ),
  };
}

function assertReachableMap(map) {
  const cell = (point) => Math.floor(point.Y) * 48 + Math.floor(point.X);
  const seen = new Set([cell(map.Mouse)]),
    queue = [...seen];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index],
      x = current % 48,
      y = Math.floor(current / 48);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy,
        next = ny * 48 + nx;
      if (
        nx < 0 ||
        nx >= 48 ||
        ny < 0 ||
        ny >= 18 ||
        map.Rows[ny][nx] !== '.' ||
        seen.has(next)
      )
        continue;
      seen.add(next);
      queue.push(next);
    }
  }
  for (const point of [map.Cat, ...map.Cheese, map.Exit])
    check(seen.has(cell(point)), 'MAP_GOAL_UNREACHABLE');
}

main().catch((error) => {
  const code = error instanceof AcceptanceError ? error.message : 'UNEXPECTED';
  process.stderr.write(
    `escape network acceptance failed at ${stage}: ${code}\n`,
  );
  process.exitCode = 1;
});
