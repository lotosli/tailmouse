import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  createReadStream,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';

import { run, runPnpm } from './process.mjs';

const root = resolve(import.meta.dirname, '..');
const customHost = parseCustomHost(process.argv.slice(2));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'tailmouse-m0-'));
const executable = join(
  temporaryRoot,
  'bin',
  process.platform === 'win32' ? 'tailmouse.exe' : 'tailmouse',
);
const dist = join(root, 'apps', 'web', 'dist');
let staticServer;
let browser;
let evidence;
let phase = 'build';
const failures = [];

// Only locally assigned phase labels may cross this secret-bearing boundary.
class AcceptanceFailure extends Error {
  constructor(phases) {
    super(`M0 acceptance failed: ${phases.join(', ')}. Details redacted.`);
    this.phases = phases;
  }
}

try {
  run(process.execPath, ['tools/tailcat-gate.mjs', 'build'], { cwd: root });
  runPnpm(['--filter', '@tailmouse/web', 'build'], { cwd: root });
  run(process.execPath, ['tools/build-native.mjs', executable], { cwd: root });
  if (!statSync(executable).isFile()) {
    throw new Error('The installed tailmouse executable is missing.');
  }

  const requests = [];
  phase = 'browser_start';
  staticServer = await startStaticServer(dist, requests);
  browser = await chromium.launch({ headless: true });
  const baseURL = `http://127.0.0.1:${staticServer.address().port}/`;

  phase = 'official';
  const official = await runScenario({
    baseURL,
    browser,
    executable,
    name: 'official',
  });
  phase = 'custom-host';
  const custom = await runScenario({
    baseURL,
    browser,
    executable,
    extraArgs: ['--derp-host', customHost],
    name: 'custom-host',
  });

  if (requests.some((request) => request.includes('#'))) {
    throw new Error('A static HTTP request contained an invitation fragment.');
  }

  phase = 'evidence';
  const binary = readFileSync(executable);
  evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    sourceRevision: capture('git', ['rev-parse', 'HEAD']),
    sourceTree: capture('git', ['status', '--porcelain=v1'])
      ? 'dirty'
      : 'clean',
    tailcatRevision: capture('git', [
      '-C',
      'third_party/tailcat',
      'rev-parse',
      'HEAD',
    ]),
    platform: process.platform,
    architecture: process.arch,
    goVersion: capture('go', ['env', 'GOVERSION']),
    nodeVersion: process.version,
    browser: 'chromium',
    installedBinarySha256: createHash('sha256').update(binary).digest('hex'),
    browserInstall: 'none',
    applicationBackend: 'none',
    staticRequestsExcludedFragments: true,
    scenarios: [official, custom],
  };
  binary.fill(0);
} catch (error) {
  failures.push(
    ...(error instanceof AcceptanceFailure ? error.phases : [phase]),
  );
} finally {
  if (browser) {
    try {
      await closeWithinDeadline(browser.close());
    } catch {
      failures.push('browser_cleanup');
    }
  }
  if (staticServer) {
    try {
      await closeWithinDeadline(closeServer(staticServer));
    } catch {
      staticServer.closeAllConnections();
      failures.push('static_cleanup');
    }
  }
  try {
    rmSync(temporaryRoot, { force: true, recursive: true });
  } catch {
    failures.push('temporary_cleanup');
  }
}
if (failures.length) throw new AcceptanceFailure(failures);
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function parseCustomHost(args) {
  if (args[0] === '--') args = args.slice(1);
  if (args.length !== 2 || args[0] !== '--custom-host') {
    throw new Error(
      'Usage: pnpm test:m0-acceptance -- --custom-host <DERP_HOST>',
    );
  }
  const host = args[1].toLowerCase().replace(/\.$/, '');
  if (
    host.length === 0 ||
    host.length > 253 ||
    host.includes('..') ||
    !host
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error('The custom DERP host must be a DNS hostname.');
  }
  return host;
}

async function runScenario({
  baseURL,
  browser,
  executable,
  extraArgs = [],
  name,
}) {
  const child = spawn(
    executable,
    [
      'escape',
      '--config',
      join(root, 'tests', 'integration', 'tailcat', 'config.toml'),
      '--web-base-url',
      baseURL,
      '--ttl',
      '2m',
      '--no-qr',
      '--json',
      ...extraArgs,
    ],
    {
      cwd: root,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('TAILMOUSE_'),
        ),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stderr = collectBounded(child.stderr, 65536);
  let invitation = '';
  let context;
  let result;
  let phase = 'invitation';
  const failures = [];

  try {
    invitation = await waitForInvitation(child.stdout, 60_000);
    phase = 'context';
    context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(90_000);
    const page = await context.newPage();
    phase = 'navigation';
    await page.goto(invitation);
    phase = 'handshake';
    await page.waitForFunction(
      () =>
        document.querySelector('[role="status"]')?.textContent === 'Connected',
    );
    phase = 'session_exit';
    await page.getByRole('button', { name: 'Exit session' }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[role="status"]')?.textContent ===
        'Session closed.',
    );
    const visible = new URL(page.url());
    const expected = new URL(baseURL);
    if (
      visible.origin !== expected.origin ||
      visible.pathname !== '/' ||
      visible.search !== '' ||
      visible.hash !== ''
    ) {
      throw new Error(`${name} did not remove the invitation fragment.`);
    }

    phase = 'host_exit';
    const exit = await waitForExit(child, 15_000);
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`${name} host exited unsuccessfully.`);
    }
    phase = 'diagnostics';
    const diagnostics = stderr.value();
    if (
      diagnostics.includes('://') ||
      diagnostics.includes('#/v1/') ||
      /(?<![A-Za-z0-9_-])tc[A-Za-z0-9_-]{64,}/u.test(diagnostics)
    ) {
      throw new Error(`${name} host disclosed URL material in diagnostics.`);
    }
    const events = diagnostics
      .trim()
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(`${name} host wrote a non-JSON diagnostic.`);
        }
      });
    if (
      !events.some((event) => event.event === 'relay_selected') ||
      !events.some((event) => event.event === 'browser_connected') ||
      events.at(-1)?.event !== 'session_closed'
    ) {
      throw new Error(`${name} host diagnostics omitted a lifecycle event.`);
    }
    result = {
      name,
      installedHostBinary: true,
      staticBrowserClient: true,
      sessionHandshake: true,
      gracefulSessionClose: true,
      relayConfiguration: name,
      result: 'passed',
    };
  } catch {
    failures.push(`${name}/${phase}`);
  } finally {
    invitation = '';
    if (context) {
      try {
        await closeWithinDeadline(context.close());
      } catch {
        failures.push(`${name}/context_cleanup`);
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
        try {
          await waitForExit(child, 3_000);
        } catch {
          child.kill('SIGKILL');
          await waitForExit(child, 2_000);
        }
      } catch {
        failures.push(`${name}/host_cleanup`);
      }
    }
  }
  if (failures.length) throw new AcceptanceFailure(failures);
  return result;
}

async function closeWithinDeadline(operation) {
  let timer;
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Cleanup deadline exceeded.')),
          3_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function waitForInvitation(stream, timeoutMilliseconds) {
  return new Promise((resolvePromise, rejectPromise) => {
    let pending = '';
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(
        new Error('The host did not produce an invitation in time.'),
      );
    }, timeoutMilliseconds);
    const onData = (chunk) => {
      pending += chunk.toString('utf8');
      if (pending.length > 8192) {
        cleanup();
        rejectPromise(
          new Error('The host invitation output exceeded its bound.'),
        );
        return;
      }
      for (const line of pending.split(/\r?\n/)) {
        if (line.startsWith('Open: ')) {
          const candidate = line.slice('Open: '.length);
          try {
            const parsed = new URL(candidate);
            if (parsed.hash.startsWith('#/v1/')) {
              cleanup();
              pending = '';
              resolvePromise(candidate);
              return;
            }
          } catch {
            // Continue until the complete bounded line arrives.
          }
        }
      }
    };
    const onEnd = () => {
      cleanup();
      rejectPromise(
        new Error('The host exited before producing an invitation.'),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
    };
    stream.on('data', onData);
    stream.on('end', onEnd);
  });
}

function collectBounded(stream, maximumBytes) {
  const output = Buffer.alloc(maximumBytes);
  let size = 0;
  let overflow = false;
  stream.on('data', (chunk) => {
    if (overflow) return;
    if (size + chunk.length > maximumBytes) {
      output.fill(0);
      overflow = true;
      return;
    }
    chunk.copy(output, size);
    size += chunk.length;
  });
  return {
    value: () => {
      if (overflow)
        throw new Error('Native diagnostics exceeded their byte bound.');
      return output.toString('utf8', 0, size);
    },
  };
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error('The installed host did not exit in time.'));
    }, timeoutMilliseconds);
    const onExit = (code, signal) => {
      cleanup();
      resolvePromise({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
    };
    child.on('exit', onExit);
  });
}

function startStaticServer(directory, requests) {
  const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.wasm', 'application/wasm'],
  ]);
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      requests.push(url.pathname + url.search);
      const requested =
        url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const path = normalize(join(directory, requested));
      if (relative(directory, path).split(sep).includes('..')) {
        response.writeHead(404).end();
        return;
      }
      const stats = statSync(path);
      if (!stats.isFile()) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        'content-length': stats.size,
        'content-type':
          contentTypes.get(extname(path)) ?? 'application/octet-stream',
        'referrer-policy': 'no-referrer',
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectPromise);
      resolvePromise(server);
    });
  });
}

function closeServer(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function capture(command, args) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}
