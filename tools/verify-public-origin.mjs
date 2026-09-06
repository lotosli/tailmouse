import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { staticHosting } from './web-assets.ts';

const maxFileBytes = 128 * 1024 * 1024;
const maxManifestBytes = 2 * 1024 * 1024;
const maxFiles = 128;
const maxDistributionBytes = 256 * 1024 * 1024;

function boundedFile(path, limit) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    'Expected a bounded regular file.',
  );
  return readFileSync(path);
}

function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}

function header(response, name) {
  const value = response.headers[name.toLowerCase()];
  assert.ok(!Array.isArray(value), `Repeated ${name} header.`);
  return value;
}

function assertSecurityHeaders(response, expected) {
  for (const [name, value] of Object.entries(expected))
    assert.equal(header(response, name), value, `${name} mismatch.`);
}

function assertObjectResponse(response, metadata, source) {
  assert.equal(response.statusCode, 200, 'Static object request failed.');
  assert.equal(
    header(response, 'Content-Type'),
    metadata.contentType,
    'Static object MIME mismatch.',
  );
  assert.equal(
    header(response, 'Cache-Control'),
    metadata.cacheControl,
    'Static object cache policy mismatch.',
  );
  assert.equal(
    header(response, 'Content-Encoding'),
    metadata.contentEncoding,
    'Static object content encoding mismatch.',
  );
  assert.equal(
    header(response, 'Content-Length'),
    String(source.byteLength),
    'Static object length header mismatch.',
  );
  assert.equal(response.body.byteLength, source.byteLength, 'Byte mismatch.');
  assert.equal(digest(response.body), digest(source), 'Content hash mismatch.');
}

function objectURL(origin, path) {
  const target = new URL(origin);
  target.pathname = `/${path}`;
  target.search = '';
  target.hash = '';
  return target;
}

function boundedRequest(
  target,
  method,
  maximumBytes,
  agent,
  network,
  timeoutMs,
) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const started = performance.now();
    const fail = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(
      target,
      {
        method,
        agent,
        headers: {
          Accept: '*/*',
          'Accept-Encoding': 'identity',
          'User-Agent': 'TailMouse-static-origin-verifier/1',
        },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.byteLength;
          if (size > maximumBytes) {
            response.destroy(new Error('Origin response exceeds its bound.'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', fail);
        response.once('end', () => {
          if (settled) return;
          settled = true;
          resolvePromise({
            statusCode: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
            durationMs: performance.now() - started,
          });
        });
      },
    );
    request.once('socket', (socket) => {
      const capture = () => {
        if (socket.remoteAddress) network.addresses.add(socket.remoteAddress);
        if (target.protocol === 'https:' && 'getProtocol' in socket) {
          const certificate = socket.getPeerCertificate();
          network.tls = {
            status: 'verified',
            protocol: socket.getProtocol(),
            authorized: socket.authorized,
            serverName: certificate.subject?.CN ?? null,
            validTo: certificate.valid_to ?? null,
          };
        }
      };
      if (socket.connecting)
        socket.once(
          target.protocol === 'https:' ? 'secureConnect' : 'connect',
          capture,
        );
      else capture();
    });
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error('Origin request exceeded its deadline.')),
    );
    request.once('error', fail);
    request.end();
  });
}

function readManifest(manifestPath) {
  const path = resolve(manifestPath);
  const source = boundedFile(path, maxManifestBytes);
  const manifest = JSON.parse(source.toString('utf8'));
  assert.equal(manifest.schemaVersion, 2, 'Unsupported Web manifest.');
  assert.deepEqual(
    manifest.staticHosting,
    staticHosting,
    'Static hosting contract mismatch.',
  );
  assert.equal(
    manifest.staticHosting.applicationBackend,
    false,
    'An application backend is forbidden.',
  );
  const entries = Object.entries(manifest.files ?? {}).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  );
  assert.ok(
    entries.length > 0 && entries.length <= maxFiles,
    'Static manifest file count exceeds its bound.',
  );
  const directory = dirname(path);
  let totalBytes = source.byteLength;
  const files = entries.map(([name, identity]) => {
    assert.match(name, /^[A-Za-z0-9_./-]+$/u, 'Unsafe static object name.');
    assert.ok(
      !name.startsWith('/') && !name.split('/').includes('..'),
      'Static object escapes its distribution.',
    );
    const filePath = resolve(directory, name);
    const inside = relative(directory, filePath);
    assert.ok(
      inside &&
        !inside.startsWith(`..${sep}`) &&
        inside !== '..' &&
        !isAbsolute(inside),
      'Static object escapes its distribution.',
    );
    assert.ok(
      Number.isSafeInteger(identity.bytes) &&
        identity.bytes >= 0 &&
        identity.bytes <= maxFileBytes &&
        /^[0-9a-f]{64}$/u.test(identity.sha256),
      'Invalid static object identity.',
    );
    const bytes = boundedFile(filePath, maxFileBytes);
    assert.equal(
      bytes.byteLength,
      identity.bytes,
      'Local object size mismatch.',
    );
    assert.equal(digest(bytes), identity.sha256, 'Local object hash mismatch.');
    totalBytes += bytes.byteLength;
    assert.ok(
      totalBytes <= maxDistributionBytes,
      'Static distribution exceeds its byte bound.',
    );
    return { name, identity, bytes };
  });
  const wasm = files.filter(({ name }) => name.endsWith('.wasm'));
  assert.equal(wasm.length, 1, 'Expected one raw WebAssembly object.');
  for (const suffix of ['.wasm.br', '.wasm.gz'])
    assert.equal(
      files.filter(({ name }) => name.endsWith(suffix)).length,
      1,
      `Expected one ${suffix} WebAssembly object.`,
    );
  return { path, source, manifest, files, wasm: wasm[0] };
}

export async function verifyPublicOrigin(
  originInput,
  manifestPath,
  options = {},
) {
  const origin = new URL(originInput);
  assert.ok(
    ['http:', 'https:'].includes(origin.protocol),
    'Origin must use HTTP or HTTPS.',
  );
  assert.equal(origin.username, '', 'Origin credentials are forbidden.');
  assert.equal(origin.password, '', 'Origin credentials are forbidden.');
  assert.equal(origin.hash, '', 'Origin fragments are forbidden.');
  assert.equal(origin.search, '', 'Origin query strings are forbidden.');
  assert.equal(origin.pathname, '/', 'Origin URL must use the root path.');
  if (origin.protocol === 'http:')
    assert.ok(
      ['127.0.0.1', '[::1]', 'localhost'].includes(origin.hostname),
      'A non-loopback origin must use HTTPS.',
    );
  const local = readManifest(manifestPath);
  const timeoutMs = options.timeoutMs ?? 30_000;
  assert.ok(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000,
    'Invalid request deadline.',
  );
  const network = {
    addresses: new Set(),
    tls: { status: 'not-applicable' },
  };
  const agent =
    origin.protocol === 'https:'
      ? new HttpsAgent({ keepAlive: true, maxSockets: 1 })
      : new HttpAgent({ keepAlive: true, maxSockets: 1 });
  try {
    const rootMetadata = local.manifest.files['index.html'];
    const index = local.files.find(({ name }) => name === 'index.html');
    assert.ok(index && rootMetadata, 'Static entry document is missing.');
    const rootHead = await boundedRequest(
      origin,
      'HEAD',
      0,
      agent,
      network,
      timeoutMs,
    );
    assert.equal(rootHead.statusCode, 200, 'Root HEAD request failed.');
    assert.equal(rootHead.body.byteLength, 0, 'HEAD returned a response body.');
    assert.equal(
      header(rootHead, 'Content-Length'),
      String(index.bytes.byteLength),
      'Root HEAD length mismatch.',
    );
    assertSecurityHeaders(rootHead, staticHosting.requiredHeaders);

    const rootGet = await boundedRequest(
      origin,
      'GET',
      index.bytes.byteLength,
      agent,
      network,
      timeoutMs,
    );
    assertObjectResponse(rootGet, rootMetadata, index.bytes);
    assertSecurityHeaders(rootGet, staticHosting.requiredHeaders);

    const manifestResponse = await boundedRequest(
      objectURL(origin, staticHosting.manifestObject.path),
      'GET',
      local.source.byteLength,
      agent,
      network,
      timeoutMs,
    );
    assertObjectResponse(
      manifestResponse,
      staticHosting.manifestObject.metadata,
      local.source,
    );
    assertSecurityHeaders(manifestResponse, staticHosting.requiredHeaders);

    let coldWasm;
    let transferredBytes = manifestResponse.body.byteLength;
    for (const file of local.files) {
      const response = await boundedRequest(
        objectURL(origin, file.name),
        'GET',
        file.bytes.byteLength,
        agent,
        network,
        timeoutMs,
      );
      assertObjectResponse(response, file.identity, file.bytes);
      assertSecurityHeaders(response, staticHosting.requiredHeaders);
      transferredBytes += response.body.byteLength;
      if (file.name === local.wasm.name) coldWasm = response;
    }
    assert.ok(coldWasm, 'Raw WebAssembly transfer is missing.');
    const warmWasm = await boundedRequest(
      objectURL(origin, local.wasm.name),
      'GET',
      local.wasm.bytes.byteLength,
      agent,
      network,
      timeoutMs,
    );
    assertObjectResponse(warmWasm, local.wasm.identity, local.wasm.bytes);
    assertSecurityHeaders(warmWasm, staticHosting.requiredHeaders);

    for (const path of [
      '.tailmouse-origin-verifier-not-found',
      'api/.tailmouse-origin-verifier-no-backend',
    ]) {
      const response = await boundedRequest(
        objectURL(origin, path),
        'GET',
        64 * 1024,
        agent,
        network,
        timeoutMs,
      );
      assert.equal(
        response.statusCode,
        404,
        'Unknown route did not return 404.',
      );
      assertSecurityHeaders(response, staticHosting.requiredHeaders);
    }

    assert.ok(network.addresses.size > 0, 'Origin address was not observed.');
    if (origin.protocol === 'https:') {
      assert.equal(network.tls.status, 'verified', 'TLS was not verified.');
      assert.equal(network.tls.authorized, true, 'TLS peer is unauthorized.');
      assert.ok(
        ['TLSv1.2', 'TLSv1.3'].includes(network.tls.protocol),
        'TLS protocol is below 1.2.',
      );
    }
    return {
      schemaVersion: 1,
      origin: origin.origin,
      manifest: {
        path: local.path,
        sha256: digest(local.source),
        objectCount: local.files.length + 1,
        objectBytes: local.files.reduce(
          (total, file) => total + file.bytes.byteLength,
          local.source.byteLength,
        ),
      },
      dns: {
        hostname: origin.hostname,
        addresses: [...network.addresses].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      },
      tls: network.tls,
      routing: {
        root: staticHosting.rootRoute,
        unknownPathStatus: 404,
        applicationBackend: false,
      },
      transfer: {
        inspectedBytes: transferredBytes,
        coldWasm: {
          path: local.wasm.name,
          bytes: coldWasm.body.byteLength,
          durationMs: Number(coldWasm.durationMs.toFixed(3)),
        },
        warmWasm: {
          path: local.wasm.name,
          bytes: warmWasm.body.byteLength,
          durationMs: Number(warmWasm.durationMs.toFixed(3)),
        },
      },
    };
  } finally {
    agent.destroy();
  }
}

if (import.meta.main) {
  try {
    assert.equal(
      process.argv.length,
      4,
      'Expected an origin URL and local Web manifest path.',
    );
    const result = await verifyPublicOrigin(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      'Public-origin verification failed. No invitation or external mutation was sent.\n',
    );
    if (error.code === 'ERR_ASSERTION' && error.generatedMessage === false)
      process.stderr.write(`${error.message.split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
