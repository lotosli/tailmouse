import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { run, runPnpm } from './process.mjs';

const legacyRevision = '5a5b620aff7d60ead7dae52c001f8b6bafab9c3d';
const priorTailcatRevision = '4a25a91e0337252a4d16e097b03cf3cbb92c20cd';
const currentTailcatRevision = '790406204c002a6f109ef7c6a30a436601a1f6a8';
const root = resolve(import.meta.dirname, '..');
const mediaTypes = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
});

if (process.argv.length !== 2) {
  throw new Error('Usage: node tools/cross-version-acceptance.mjs');
}
if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error(
    'Cross-version acceptance requires a Unix native artifact; Windows runtime validation remains deferred / not verified.',
  );
}

const temporary = await mkdtemp(join(tmpdir(), 'tailmouse-cross-version-'));
const legacyRoot = join(temporary, 'repository');
let worktreeAdded = false;

try {
  run('git', ['worktree', 'add', '--detach', legacyRoot, legacyRevision], {
    cwd: root,
  });
  worktreeAdded = true;
  run(
    'git',
    [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--reference',
      join(root, 'third_party', 'tailcat'),
      'third_party/tailcat',
    ],
    { cwd: legacyRoot },
  );

  buildCurrent(root);
  buildLegacy(legacyRoot);

  const current = await artifactIdentity(root, 2, currentTailcatRevision);
  const legacy = await artifactIdentity(legacyRoot, 1, priorTailcatRevision);
  if (
    current.tailcatRevision !== currentTailcatRevision ||
    legacy.tailcatRevision !== priorTailcatRevision
  ) {
    throw new Error(
      'Cross-version artifacts do not use the recorded Tailcat revision.',
    );
  }

  await rejectMismatch({
    browser: legacy,
    host: current,
    name: 'old-browser/new-Host',
    protocol: 2,
  });
  await rejectMismatch({
    browser: current,
    host: legacy,
    name: 'new-browser/old-Host',
    protocol: 1,
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        schema: 'tailmouse.cross-version-acceptance/v1',
        tailcatRevisions: {
          legacy: priorTailcatRevision,
          current: currentTailcatRevision,
        },
        legacy: publicIdentity(legacy),
        current: publicIdentity(current),
        pairings: [
          {
            browser: 'legacy',
            host: 'current',
            result: 'rejected-before-wasm-dial-disclosure-startup',
          },
          {
            browser: 'current',
            host: 'legacy',
            result: 'rejected-before-wasm-dial-disclosure-startup',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (worktreeAdded) {
    run('git', ['worktree', 'remove', '--force', legacyRoot], {
      allowFailure: true,
      capture: true,
      cwd: root,
    });
  }
  await rm(temporary, { force: true, recursive: true });
}

function buildCurrent(directory) {
  run(process.execPath, ['tools/tailcat-gate.mjs', 'build'], {
    cwd: directory,
  });
  runPnpm(['--filter', '@tailmouse/web', 'build'], { cwd: directory });
  run(process.execPath, ['tools/build-native.mjs'], { cwd: directory });
}

function buildLegacy(directory) {
  runPnpm(['install', '--frozen-lockfile'], { cwd: directory });
  buildCurrent(directory);
}

async function artifactIdentity(directory, protocol, expectedTailcatRevision) {
  const sourceRevision = run('git', ['rev-parse', 'HEAD'], {
    capture: true,
    cwd: directory,
  }).stdout.trim();
  const binary = join(directory, '.artifacts', 'native', 'tailmouse');
  const dist = join(directory, 'apps', 'web', 'dist');
  const manifestPath = join(dist, 'web-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const reportedProtocol =
    manifest.schemaVersion === 1
      ? manifest.protocolMin === protocol && manifest.protocolMax === protocol
      : manifest.protocols?.leash === protocol;
  if (
    !reportedProtocol ||
    manifest.tailcatRevision !== expectedTailcatRevision ||
    typeof manifest.version !== 'string'
  ) {
    throw new Error('A Web artifact reported an unexpected build identity.');
  }
  if (
    (protocol === 1 && sourceRevision !== legacyRevision) ||
    (protocol === 2 && directory !== root)
  ) {
    throw new Error(
      'A native artifact came from an unexpected source revision.',
    );
  }
  return {
    binary,
    binarySHA256: await sha256(binary),
    dist,
    manifestSHA256: await sha256(manifestPath),
    protocol,
    sourceRevision,
    tailcatRevision: manifest.tailcatRevision,
    version: manifest.version,
  };
}

async function rejectMismatch({ browser, host, name, protocol }) {
  let stage = 'setup';
  const directory = await mkdtemp(join(tmpdir(), 'tailmouse-pair-'));
  const startedPath = join(directory, 'child-started');
  const privateTitle = `cross-version-private-${name}`;
  const web = await staticServer(browser.dist);
  const args = [
    'leash',
    '--no-qr',
    '--start-on=connect',
    '--ttl=1m',
    '--post-exit-ttl=0',
    `--web-base-url=${web.url}`,
    `--cwd=${directory}`,
    `--title=${privateTitle}`,
  ];
  if (host.protocol === 2) args.push('--no-password');
  args.push('--', '/bin/sh', '-c', `printf started > ${startedPath}`);
  const child = spawn(host.binary, args, {
    cwd: directory,
    env: { ENV: '', HOME: directory, PATH: '/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let invitation = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 32_768) child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 32_768) child.kill('SIGKILL');
  });

  try {
    stage = 'invitation';
    invitation = await waitForInvitation(child, () => stdout);
    stage = 'card-identity';
    await assertCardProtocol(invitation, protocol);
    stage = 'browser-rejection';
    await assertBrowserRejection(
      invitation,
      web.url,
      privateTitle,
      startedPath,
    );
  } catch {
    throw new Error(`${name} failed at the fixed ${stage} stage.`);
  } finally {
    invitation = '';
    stdout = '';
    stderr = '';
    await stopChild(child);
    await web.close();
    await rm(directory, { force: true, recursive: true });
  }
}

async function waitForInvitation(child, output) {
  return await Promise.race([
    new Promise((resolveInvitation, rejectInvitation) => {
      const timer = setInterval(() => {
        const matched =
          /Open: (http:\/\/127\.0\.0\.1:\d+\/#\/v1\/[A-Za-z0-9_-]+)/u.exec(
            output(),
          );
        if (matched) {
          clearInterval(timer);
          resolveInvitation(matched[1]);
        }
      }, 25);
      child.once('exit', () => {
        clearInterval(timer);
        rejectInvitation(new Error('Host exited before its invitation.'));
      });
    }),
    new Promise((_, rejectInvitation) =>
      setTimeout(
        () => rejectInvitation(new Error('Host invitation timed out.')),
        30_000,
      ),
    ),
  ]);
}

async function assertCardProtocol(invitation, protocol) {
  const cborg = await import(
    pathToFileURL(
      join(root, 'apps', 'web', 'node_modules', 'cborg', 'cborg.js'),
    ).href
  );
  const url = new URL(invitation);
  const payload = Buffer.from(url.hash.slice('#/v1/'.length), 'base64url');
  try {
    const card = cborg.decode(payload, {
      allowBigInt: false,
      allowIndefinite: false,
      allowUndefined: false,
      rejectDuplicateMapKeys: true,
      strict: true,
    });
    if (
      card.m !== 'leash' ||
      card.a !== protocol ||
      card.z !== protocol ||
      !(card.s instanceof Uint8Array)
    ) {
      throw new Error('MouseCard protocol identity mismatch.');
    }
    card.s.fill(0);
    card.t = '';
  } finally {
    payload.fill(0);
    url.hash = '';
  }
}

async function assertBrowserRejection(
  invitation,
  baseURL,
  privateTitle,
  startedPath,
) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const requests = [];
    context.on('request', (request) => {
      requests.push(new URL(request.url()).pathname);
    });
    const page = await context.newPage();
    await page.goto(invitation);
    await expect(page.getByRole('alert')).toHaveText(
      'This invitation is invalid or unsupported. Request a new link from the host.',
      { timeout: 10_000 },
    );
    if (
      page.url() !== baseURL ||
      requests.some((path) => path.endsWith('.wasm')) ||
      (await page.locator('body').innerText()).includes(privateTitle)
    ) {
      throw new Error('Browser mismatch crossed a pre-admission boundary.');
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1000));
    try {
      await stat(startedPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await context.close();
        return;
      }
      throw error;
    }
    throw new Error('Browser mismatch started the child.');
  } finally {
    await browser.close();
  }
}

async function staticServer(dist) {
  const manifest = JSON.parse(
    await readFile(join(dist, 'web-manifest.json'), 'utf8'),
  );
  const allowed = new Set([
    ...Object.keys(manifest.files),
    'web-manifest.json',
  ]);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const name =
        url.pathname === '/'
          ? 'index.html'
          : decodeURIComponent(url.pathname.slice(1));
      if (
        !['GET', 'HEAD'].includes(request.method ?? '') ||
        !allowed.has(name) ||
        name.includes('..')
      ) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(join(dist, name));
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': String(body.byteLength),
        'Content-Type':
          manifest.files[name]?.contentType ??
          mediaTypes[extname(name)] ??
          'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Cross-version static origin has no TCP port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: async () =>
      await new Promise((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      ),
  };
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child.stdin.destroy();
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function publicIdentity(identity) {
  return {
    sourceRevision: identity.sourceRevision,
    version: identity.version,
    leashProtocol: identity.protocol,
    nativeSHA256: identity.binarySHA256,
    webManifestSHA256: identity.manifestSHA256,
  };
}
