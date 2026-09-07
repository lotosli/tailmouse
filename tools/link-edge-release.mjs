import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { buildIdentity } from './build-identity.ts';
import { assertEdgeConfig } from './link-edge-config.ts';
import { distributionNotices } from './release-licenses.ts';
import { assertNoCredentials, fileIdentity } from './sbom.ts';

const ownedInputs = [
  '.artifacts/static-manifest.json',
  'src/api.ts',
  'src/index.ts',
  'src/short-invitation.ts',
  'src/static.ts',
];
const bundleFiles = ['index.js', 'index.js.map'];
const releaseFiles = [
  ...bundleFiles,
  'bundle-meta.json',
  'edge-manifest.json',
  'wrangler.jsonc',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
].sort();
const cloudflareImport = {
  path: 'cloudflare:workers',
  kind: 'import-statement',
  external: true,
};
const maximumBytes = 2 * 1024 * 1024;

function bytes(path) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximumBytes,
    'Expected bounded regular edge artifact.',
  );
  const source = readFileSync(path);
  assertNoCredentials(source);
  return source;
}

function json(path) {
  return JSON.parse(bytes(path).toString('utf8'));
}

function normalizeInput(path, version) {
  if (ownedInputs.includes(path)) return path;
  const prefix = `../../node_modules/.pnpm/cborg@${version}/node_modules/cborg/`;
  assert.ok(
    path.startsWith(prefix) &&
      /^(?:cborg\.js|lib\/[A-Za-z0-9-]+\.js)$/u.test(path.slice(prefix.length)),
    'Unreviewed edge bundle input.',
  );
  return `npm/cborg/${path.slice(prefix.length)}`;
}

// The compiler metadata and embedded source map must both match the actual
// build inputs. Only the current application files and cborg may be bundled.
export function edgeBundleInventory(meta, sourceMap, sources, cborgVersion) {
  assert.match(
    cborgVersion,
    /^\d+\.\d+\.\d+$/u,
    'Invalid edge runtime version.',
  );
  assert.deepEqual(
    Object.keys(meta).sort(),
    ['inputs', 'outputs'],
    'Invalid edge compiler metadata.',
  );
  const names = Object.keys(meta.inputs);
  assert.ok(
    names.length > ownedInputs.length && names.length <= 64,
    'Invalid edge input count.',
  );
  for (const path of ownedInputs)
    assert.ok(names.includes(path), 'Missing owned edge input.');
  assert.equal(sources.size, names.length, 'Edge source inventory mismatch.');
  const inventory = names
    .map((path) => {
      const normalized = normalizeInput(path, cborgVersion);
      const input = meta.inputs[path];
      const source = sources.get(path);
      assert.ok(
        Buffer.isBuffer(source) && source.length <= maximumBytes,
        'Missing bounded edge input.',
      );
      assertNoCredentials(source);
      assert.equal(
        input.bytes,
        source.byteLength,
        'Compiler input differs from source.',
      );
      assert.ok(
        input.format === undefined || input.format === 'esm',
        'Unsupported edge input format.',
      );
      assert.ok(
        Array.isArray(input.imports) && input.imports.length <= 64,
        'Invalid edge input imports.',
      );
      for (const imported of input.imports) {
        assert.equal(
          imported.kind,
          'import-statement',
          'Unexpected edge import kind.',
        );
        if (imported.external)
          assert.ok(
            imported.path === '<runtime>' ||
              imported.path === 'cloudflare:workers',
            'Unreviewed external edge import.',
          );
        else
          assert.ok(
            names.includes(imported.path),
            'Unresolved edge bundle input.',
          );
      }
      return fileIdentity(normalized, source);
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  assert.deepEqual(
    Object.keys(meta.outputs).sort(),
    ['dist/index.js', 'dist/index.js.map'],
    'Unexpected edge output files.',
  );
  const output = meta.outputs['dist/index.js'];
  assert.equal(
    output.entryPoint,
    'src/index.ts',
    'Unexpected edge entry point.',
  );
  assert.deepEqual(
    output.exports,
    ['ShortInvitation', 'default'],
    'Missing edge exports.',
  );
  assert.deepEqual(
    output.imports,
    [cloudflareImport],
    'Unreviewed edge runtime import.',
  );
  const included = Object.keys(output.inputs);
  assert.ok(
    included.length > ownedInputs.length && included.length <= names.length,
    'Invalid included edge inputs.',
  );
  for (const path of ownedInputs)
    assert.ok(included.includes(path), 'Owned edge input was not bundled.');
  for (const path of included)
    assert.ok(
      names.includes(path) &&
        Number.isSafeInteger(output.inputs[path].bytesInOutput) &&
        output.inputs[path].bytesInOutput > 0,
      'Invalid edge included-byte inventory.',
    );
  const mapOutput = meta.outputs['dist/index.js.map'];
  assert.deepEqual(mapOutput.imports, [], 'Source map imports are forbidden.');
  assert.deepEqual(mapOutput.exports, [], 'Source map exports are forbidden.');
  assert.deepEqual(mapOutput.inputs, {}, 'Unexpected source map metadata.');
  assert.deepEqual(
    Object.keys(sourceMap).sort(),
    ['mappings', 'names', 'sourceRoot', 'sources', 'sourcesContent', 'version'],
    'Unexpected edge source-map fields.',
  );
  assert.equal(sourceMap.version, 3, 'Unsupported edge source map.');
  assert.equal(sourceMap.sourceRoot, 'dist', 'Unexpected edge source root.');
  assert.equal(typeof sourceMap.mappings, 'string', 'Invalid source mappings.');
  assert.ok(
    Array.isArray(sourceMap.names) &&
      sourceMap.names.every((name) => typeof name === 'string'),
    'Invalid source-map names.',
  );
  assert.ok(
    Array.isArray(sourceMap.sources) &&
      sourceMap.sources.every((path) => typeof path === 'string'),
    'Invalid source-map paths.',
  );
  assert.deepEqual(
    [...sourceMap.sources].sort((left, right) =>
      left.localeCompare(right, 'en'),
    ),
    included
      .map((path) => `../${path}`)
      .sort((left, right) => left.localeCompare(right, 'en')),
    'Source map and bundled inventory differ.',
  );
  assert.equal(
    sourceMap.sourcesContent.length,
    sourceMap.sources.length,
    'Source map content is incomplete.',
  );
  sourceMap.sources.forEach((path, index) => {
    assert.equal(
      sourceMap.sourcesContent[index],
      sources.get(path.slice(3)).toString('utf8'),
      'Bundled source differs from current source.',
    );
  });
  return inventory;
}

export function edgeCompilerIdentity(root) {
  const versions = json(resolve(root, 'tooling/versions.json'));
  const application = resolve(root, 'apps/link-edge');
  const wranglerPath = realpathSync(
    resolve(application, 'node_modules/wrangler/package.json'),
  );
  const wrangler = json(wranglerPath);
  const esbuild = json(
    createRequire(wranglerPath).resolve('esbuild/package.json'),
  );
  const cborg = json(resolve(application, 'node_modules/cborg/package.json'));
  assert.equal(
    process.versions.node,
    versions.node,
    'Node toolchain mismatch.',
  );
  assert.equal(wrangler.name, 'wrangler', 'Invalid edge compiler package.');
  assert.equal(
    wrangler.version,
    versions.wrangler,
    'Wrangler toolchain mismatch.',
  );
  assert.equal(esbuild.name, 'esbuild', 'Invalid bundler package.');
  assert.equal(
    esbuild.version,
    wrangler.dependencies.esbuild,
    'Bundler version mismatch.',
  );
  assert.equal(cborg.name, 'cborg', 'Invalid edge runtime package.');
  for (const version of [wrangler.version, esbuild.version, cborg.version])
    assert.match(version, /^\d+\.\d+\.\d+$/u, 'Unpinned edge dependency.');
  return {
    toolchains: {
      node: versions.node,
      wrangler: wrangler.version,
      esbuild: esbuild.version,
    },
    npm: [{ name: 'cborg', version: cborg.version }],
  };
}

function manifestFor(root, directory, configSource, metaSource) {
  const application = resolve(root, 'apps/link-edge');
  const identity = buildIdentity(root, process.env.TAILMOUSE_BUILD_VERSION);
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.match(
    sourceRevision,
    /^[a-f0-9]{40}$/u,
    'Invalid edge source revision.',
  );
  const configuration = JSON.parse(configSource.toString('utf8'));
  assertEdgeConfig(configuration);
  assert.deepEqual(
    configSource,
    bytes(resolve(application, 'wrangler.jsonc')),
    'Edge configuration differs from source.',
  );
  const compiler = edgeCompilerIdentity(root);
  const meta = JSON.parse(metaSource.toString('utf8'));
  const sourceMap = json(resolve(directory, 'index.js.map'));
  const sources = new Map(
    Object.keys(meta.inputs).map((path) => {
      normalizeInput(path, compiler.npm[0].version);
      return [path, bytes(resolve(application, path))];
    }),
  );
  const inputs = edgeBundleInventory(
    meta,
    sourceMap,
    sources,
    compiler.npm[0].version,
  );
  const webSource = bytes(resolve(root, 'apps/web/dist/web-manifest.json'));
  const web = JSON.parse(webSource.toString('utf8'));
  assert.equal(web.schemaVersion, 2, 'Unsupported Web manifest.');
  for (const [key, value] of Object.entries(identity))
    assert.deepEqual(web[key], value, 'Edge and Web build identities differ.');
  assert.deepEqual(
    web.dependencies.npm.filter((dependency) => dependency.name === 'cborg'),
    compiler.npm,
    'Edge and Web codec inventories differ.',
  );
  const staticManifest = JSON.parse(
    sources.get('.artifacts/static-manifest.json').toString('utf8'),
  );
  const webManifestSha256 = fileIdentity('web-manifest.json', webSource).sha256;
  assert.equal(
    staticManifest.webManifestSha256,
    webManifestSha256,
    'Edge embeds a different Web manifest.',
  );
  const files = bundleFiles.map((name) => {
    const identity = fileIdentity(name, bytes(resolve(directory, name)));
    assert.equal(
      meta.outputs[`dist/${name}`].bytes,
      identity.bytes,
      'Compiler output differs from artifact.',
    );
    return identity;
  });
  files.push(
    fileIdentity('wrangler.jsonc', configSource),
    fileIdentity('bundle-meta.json', metaSource),
  );
  for (const notice of distributionNotices(root))
    files.push(fileIdentity(notice.fileName, notice.source));
  return {
    schemaVersion: 1,
    ...identity,
    sourceRevision,
    role: 'protected-short-invitation-and-static-edge',
    configuration,
    webManifestSha256,
    toolchains: compiler.toolchains,
    dependencies: {
      npm: compiler.npm,
      platformImports: ['cloudflare:workers'],
    },
    inputs,
    files: Object.fromEntries(
      files
        .sort((left, right) => left.name.localeCompare(right.name, 'en'))
        .map(({ name, ...identity }) => [name, identity]),
    ),
  };
}

export function generateEdgeRelease(root) {
  const application = resolve(root, 'apps/link-edge');
  const directory = resolve(application, 'dist');
  const configSource = bytes(resolve(application, 'wrangler.jsonc'));
  const metaSource = bytes(resolve(application, '.artifacts/bundle-meta.json'));
  const manifest = manifestFor(root, directory, configSource, metaSource);
  writeFileSync(resolve(directory, 'wrangler.jsonc'), configSource);
  writeFileSync(resolve(directory, 'bundle-meta.json'), metaSource);
  for (const notice of distributionNotices(root))
    writeFileSync(resolve(directory, notice.fileName), notice.source);
  const source = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  assertNoCredentials(source);
  writeFileSync(resolve(directory, 'edge-manifest.json'), source);
  return verifyEdgeRelease(root, directory);
}

export function verifyEdgeRelease(
  root,
  directory = resolve(root, 'apps/link-edge/dist'),
) {
  const buildDirectory = resolve(root, 'apps/link-edge/dist');
  const buildOutput = resolve(directory) === buildDirectory;
  const names = readdirSync(directory)
    .filter((name) => !buildOutput || name !== 'README.md')
    .sort();
  if (buildOutput)
    assert.match(
      bytes(resolve(directory, 'README.md')).toString('utf8'),
      /^This folder contains the built output assets for the worker "tailmouse-link-edge" generated at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\.$/u,
      'Unexpected Wrangler build-only notice.',
    );
  assert.deepEqual(
    names,
    releaseFiles,
    'Edge release contains missing or unexpected files.',
  );
  const manifestSource = bytes(resolve(directory, 'edge-manifest.json'));
  const manifest = JSON.parse(manifestSource.toString('utf8'));
  const expected = manifestFor(
    root,
    buildDirectory,
    bytes(resolve(root, 'apps/link-edge/wrangler.jsonc')),
    bytes(resolve(root, 'apps/link-edge/.artifacts/bundle-meta.json')),
  );
  assert.deepEqual(
    manifest,
    expected,
    'Edge release identity or inventory mismatch.',
  );
  const identities = names.map((name) => {
    const identity = fileIdentity(name, bytes(resolve(directory, name)));
    if (name !== 'edge-manifest.json') {
      const { name: _name, ...value } = identity;
      assert.deepEqual(
        value,
        manifest.files[name],
        'Edge artifact checksum mismatch.',
      );
    }
    return identity;
  });
  return { manifest, identities, npm: manifest.dependencies.npm };
}

if (import.meta.main) {
  try {
    assert.ok(
      process.argv.length === 3 &&
        ['generate', 'verify'].includes(process.argv[2]),
      'Expected generate or verify.',
    );
    const root = resolve(import.meta.dirname, '..');
    const result =
      process.argv[2] === 'generate'
        ? generateEdgeRelease(root)
        : verifyEdgeRelease(root);
    process.stdout.write(
      `Edge release ${process.argv[2]} passed: ${result.identities.length} files, one bundled runtime dependency.\n`,
    );
  } catch {
    process.stderr.write(
      'Edge release verification failed. No publication attempted.\n',
    );
    process.exitCode = 1;
  }
}
