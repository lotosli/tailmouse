import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { buildIdentity } from './build-identity.ts';
import { verifyNativeBuild, verifyNativeMatrix } from './release-native.mjs';
import {
  assertNoCredentials,
  checksumManifest,
  edgeSBOM,
  fileIdentity,
  nativeSBOM,
  verifySBOM,
  webSBOM,
} from './sbom.ts';
import {
  wasmDependencies,
  resourceWasmDependencies,
} from './web-dependencies.ts';
import {
  distributionNotices,
  verifyNoticeCoverage,
} from './release-licenses.ts';
import {
  staticHosting,
  contentHosting,
  webObjectMetadata,
} from './web-assets.ts';
import { verifyEdgeRelease } from './link-edge-release.mjs';

const root = resolve(import.meta.dirname, '..');
const release = resolve(root, '.artifacts/release');
const distribution = resolve(root, '.artifacts/distribution');
const maxBytes = 128 * 1024 * 1024;
let stage = 'prerequisites';

function bytes(path, limit = maxBytes) {
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= limit,
    'Expected a bounded regular file.',
  );
  return readFileSync(path);
}

function json(path) {
  return JSON.parse(bytes(path, 2 * 1024 * 1024).toString('utf8'));
}

function files(directory, prefix = '') {
  assert.ok(
    lstatSync(directory).isDirectory() &&
      !lstatSync(directory).isSymbolicLink(),
    'Expected a real directory.',
  );
  assert.ok(prefix.split('/').length <= 8, 'Artifact directory is too deep.');
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    assert.match(entry.name, /^[A-Za-z0-9_.-]+$/u, 'Unsafe artifact name.');
    assert.ok(!entry.isSymbolicLink(), 'Artifact symlinks are forbidden.');
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      result.push(...files(resolve(directory, entry.name), `${name}/`));
    else {
      assert.ok(entry.isFile(), 'Unexpected artifact type.');
      result.push(name);
    }
    assert.ok(result.length <= 512, 'Too many artifact files.');
  }
  return result.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function execute(command, args, versions, input) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
    env: { ...process.env, GOWORK: 'off', GOTOOLCHAIN: `go${versions.go}` },
  });
}

function validate(bom, versions) {
  const source = Buffer.from(JSON.stringify(bom));
  assertNoCredentials(source);
  execute(
    'cyclonedx',
    [
      'validate',
      '--input-format',
      'json',
      '--input-version',
      'v1_7',
      '--fail-on-errors',
    ],
    versions,
    source,
  );
}

function checkSums(modules, sumPath) {
  const sums = new Set(
    bytes(sumPath, 2 * 1024 * 1024)
      .toString('utf8')
      .trim()
      .split(/\r?\n/u),
  );
  for (const module of modules)
    assert.ok(
      sums.has(`${module.name} ${module.version} ${module.sum}`),
      'Compiled module does not match go.sum.',
    );
}

function webInventory(directory, identity, versions) {
  const manifest = json(resolve(directory, 'web-manifest.json'));
  assert.equal(manifest.schemaVersion, 2, 'Unsupported Web manifest.');
  assert.deepEqual(
    Object.keys(manifest).sort(),
    [
      'cacheVersion',
      'contentHosting',
      'dependencies',
      'files',
      'protocols',
      'resourceProtocol',
      'schemaVersion',
      'staticHosting',
      'tailcatRevision',
      'toolchains',
      'version',
    ],
    'Unexpected Web manifest fields.',
  );
  assert.deepEqual(
    manifest.staticHosting,
    staticHosting,
    'Static hosting contract mismatch.',
  );
  for (const [key, value] of Object.entries(identity))
    assert.deepEqual(manifest[key], value, 'Web build identity mismatch.');
  assert.deepEqual(
    manifest.contentHosting,
    contentHosting,
    'Content hosting contract mismatch.',
  );
  assert.equal(manifest.resourceProtocol.frontendMajor, 1);
  assert.equal(manifest.resourceProtocol.protocolMajor, 2);
  const webPackage = json(resolve(root, 'apps/web/package.json'));
  const expectedNpm = [...Object.keys(webPackage.dependencies), 'vite']
    .sort()
    .map((name) => {
      const pkg = json(
        resolve(root, 'apps/web/node_modules', name, 'package.json'),
      );
      assert.equal(pkg.name, name, 'Installed npm identity mismatch.');
      return { name, version: pkg.version };
    });
  assert.deepEqual(
    manifest.dependencies.npm,
    expectedNpm,
    'Bundled npm inventory mismatch.',
  );
  const vite = expectedNpm.find((item) => item.name === 'vite');
  const require = createRequire(resolve(root, 'apps/web/package.json'));
  const rolldown = json(
    createRequire(require.resolve('vite/package.json')).resolve(
      'rolldown/package.json',
    ),
  );
  assert.deepEqual(
    manifest.toolchains,
    { go: `go${versions.go}`, vite: vite.version, rolldown: rolldown.version },
    'Web compiler identity mismatch.',
  );
  const names = files(directory);
  for (const notice of distributionNotices(root))
    assert.deepEqual(
      bytes(resolve(directory, notice.fileName)),
      notice.source,
      'Web project notice differs from verified source.',
    );
  assert.deepEqual(
    names,
    [...Object.keys(manifest.files), 'web-manifest.json'].sort(),
    'Web file coverage mismatch.',
  );
  const identities = names.map((name) => {
    const source = bytes(resolve(directory, name));
    assertNoCredentials(source);
    const identity = fileIdentity(name, source);
    if (name !== 'web-manifest.json')
      assert.deepEqual(
        manifest.files[name],
        {
          bytes: identity.bytes,
          sha256: identity.sha256,
          ...webObjectMetadata(name),
        },
        'Web content hash mismatch.',
      );
    if (name.endsWith('.gz') || name.endsWith('.br')) {
      const rawName = name.slice(0, -3);
      assert.ok(
        names.includes(rawName),
        'Compressed asset has no raw counterpart.',
      );
      const raw = name.endsWith('.gz')
        ? gunzipSync(source, { maxOutputLength: maxBytes })
        : brotliDecompressSync(source, { maxOutputLength: maxBytes });
      assert.deepEqual(
        fileIdentity(rawName, raw),
        fileIdentity(rawName, bytes(resolve(directory, rawName))),
        'Compressed asset differs from its raw counterpart.',
      );
    }
    return identity;
  });
  const wasmFiles = names.filter((name) => name.endsWith('.wasm'));
  assert.equal(
    wasmFiles.length,
    2,
    'Expected legacy and resource WebAssembly binaries.',
  );
  const resourceFile = manifest.resourceProtocol?.wasm;
  assert.ok(
    wasmFiles.includes(resourceFile) &&
      /^tailcat\/resource-[a-f0-9]{64}\.wasm$/u.test(resourceFile),
    'Resource bridge binary is missing.',
  );
  for (const suffix of ['.wasm.br', '.wasm.gz'])
    assert.equal(
      names.filter((name) => name.endsWith(suffix)).length,
      2,
      `Expected two ${suffix} WebAssembly objects.`,
    );
  const wasm = wasmDependencies(
    bytes(
      resolve(
        directory,
        wasmFiles.find((name) => name !== resourceFile),
      ),
    ),
    identity.tailcatRevision,
  );
  assert.deepEqual(
    manifest.dependencies.wasm,
    wasm,
    'Embedded Wasm module inventory mismatch.',
  );
  checkSums(wasm.modules, resolve(root, 'third_party/tailcat/go.sum'));
  const resource = resourceWasmDependencies(
    bytes(resolve(directory, resourceFile)),
    identity.tailcatRevision,
    {
      revision: manifest.resourceProtocol.sourceRevision,
      sourceSha256: manifest.resourceProtocol.sourceSha256,
      tailcatVersion: wasm.main.version,
    },
  );
  assert.deepEqual(
    manifest.dependencies.resourceWasm,
    resource,
    'Resource bridge module inventory mismatch.',
  );
  checkSums(resource.modules, resolve(root, 'go.sum'));
  return { identities, npm: expectedNpm, wasm, resource };
}

function sourcePath(path) {
  const resolved = resolve(root, path);
  const inside = relative(release, realpathSync(resolved));
  assert.ok(
    inside &&
      !inside.startsWith(`..${sep}`) &&
      inside !== '..' &&
      !isAbsolute(inside),
    'Release source escapes its directory.',
  );
  return resolved;
}

function main(args) {
  assert.ok(
    args.length === 1 && ['generate', 'verify'].includes(args[0]),
    'Expected generate or verify.',
  );
  const generate = args[0] === 'generate';
  const versions = json(resolve(root, 'tooling/versions.json'));
  assert.equal(
    process.versions.node,
    versions.node,
    'Node toolchain mismatch.',
  );
  assert.equal(
    execute('cyclonedx', ['--version'], versions).trim().split('+')[0],
    versions.cyclonedx,
    'CycloneDX CLI version mismatch.',
  );
  assert.ok(
    generate ? !existsSync(distribution) : existsSync(distribution),
    'Distribution output must be absent for generation and present for verification.',
  );
  const identity = buildIdentity(root, process.env.TAILMOUSE_BUILD_VERSION);
  execute(process.execPath, ['tools/release-licenses.mjs', 'check'], versions);
  const revision = execute('git', ['rev-parse', 'HEAD'], versions).trim();
  const artifacts = json(resolve(release, 'artifacts.json'));
  verifyNativeMatrix(artifacts, identity.version);
  const webDirectory = generate
    ? resolve(root, 'apps/web/dist')
    : resolve(distribution, 'web');
  stage = 'Web artifact inventory';
  const web = webInventory(webDirectory, identity, versions);
  const copies = web.identities.map((file) => ({
    from: resolve(webDirectory, file.name),
    name: `web/${file.name}`,
    identity: { ...file, name: `web/${file.name}` },
  }));
  const boms = [
    {
      name: `tailmouse_${identity.version}_web.cdx.json`,
      bom: webSBOM(
        identity,
        revision,
        web.identities,
        web.npm,
        web.wasm,
        `go${versions.go}`,
        web.resource,
      ),
    },
  ];
  stage = 'edge artifact inventory';
  const edgeDirectory = generate
    ? resolve(root, 'apps/link-edge/dist')
    : resolve(distribution, 'edge');
  const edge = verifyEdgeRelease(root, edgeDirectory);
  for (const file of edge.identities)
    copies.push({
      from: resolve(edgeDirectory, file.name),
      name: `edge/${file.name}`,
      identity: { ...file, name: `edge/${file.name}` },
    });
  boms.push({
    name: `tailmouse_${identity.version}_edge.cdx.json`,
    bom: edgeSBOM(
      identity,
      revision,
      edge.identities,
      edge.npm,
      edge.manifest.toolchains,
    ),
  });
  const archives = [];
  const readme = bytes(resolve(root, 'README.md'));
  assertNoCredentials(readme);
  const notices = distributionNotices(root).map(({ fileName, source }) =>
    fileIdentity(fileName, source),
  );
  for (const artifact of artifacts.filter((item) => item.type === 'Archive')) {
    const target = `${artifact.goos}/${artifact.goarch}`;
    stage = `native inventory ${target}`;
    const binary = artifacts.find(
      (item) =>
        item.type === 'Binary' &&
        item.goos === artifact.goos &&
        item.goarch === artifact.goarch,
    );
    const binaryPath = sourcePath(binary.path);
    const binaryBytes = bytes(binaryPath);
    assertNoCredentials(binaryBytes);
    const info = JSON.parse(
      execute('go', ['version', '-m', '-json', binaryPath], versions),
    );
    verifyNativeBuild(
      info,
      binaryBytes,
      identity,
      target,
      revision,
      versions.go,
    );
    const modules = info.Deps.map((module) => {
      if (module.Path === web.wasm.main.name) return web.wasm.main;
      assert.equal(
        module.Replace,
        undefined,
        'Unexpected native module replacement.',
      );
      return { name: module.Path, version: module.Version, sum: module.Sum };
    });
    checkSums(
      modules.filter((module) => module.name !== web.wasm.main.name),
      resolve(root, 'go.sum'),
    );
    const archivePath = generate
      ? sourcePath(artifact.path)
      : resolve(distribution, artifact.name);
    const archive = fileIdentity(artifact.name, bytes(archivePath));
    archives.push(archive);
    const contents = JSON.parse(
      execute('go', ['run', './tools/archiveinfo', archivePath], versions),
    );
    assert.deepEqual(
      contents,
      [
        ...notices,
        fileIdentity('README.md', readme),
        fileIdentity(binary.name, binaryBytes),
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      'Archive content differs from verified build outputs.',
    );
    copies.push({ from: archivePath, name: archive.name, identity: archive });
    boms.push({
      name: `${archive.name}.cdx.json`,
      bom: nativeSBOM(
        identity,
        revision,
        target,
        archive,
        contents,
        modules,
        `go${versions.go}`,
      ),
    });
  }
  // Compare sets, not GoReleaser's unspecified checksum line order.
  assert.deepEqual(
    bytes(resolve(release, 'checksums.txt'), 8192)
      .toString('utf8')
      .trim()
      .split('\n')
      .sort(),
    checksumManifest(archives).trim().split('\n').sort(),
    'Native archive checksum coverage mismatch.',
  );
  const output = copies.map((copy) => copy.identity);
  stage = 'distribution notice coverage';
  verifyNoticeCoverage(
    json(resolve(root, 'tooling/third-party-licenses.json')),
    boms.flatMap((entry) => entry.bom.components),
  );
  const serials = new Set();
  for (const entry of boms) {
    stage = `SBOM validation ${entry.name}`;
    const bom = generate ? entry.bom : json(resolve(distribution, entry.name));
    verifySBOM(bom, entry.bom);
    assert.ok(!serials.has(bom.serialNumber), 'SBOM serial number is reused.');
    serials.add(bom.serialNumber);
    validate(bom, versions);
    entry.content = generate
      ? Buffer.from(`${JSON.stringify(bom, null, 2)}\n`)
      : bytes(resolve(distribution, entry.name));
    output.push(fileIdentity(entry.name, entry.content));
  }
  const checksums = checksumManifest(output);
  stage = 'distribution file coverage and checksums';
  if (generate) {
    mkdirSync(distribution);
    for (const copy of copies) {
      const destination = resolve(distribution, copy.name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(copy.from, destination, constants.COPYFILE_EXCL);
      assert.deepEqual(
        fileIdentity(copy.name, bytes(destination)),
        copy.identity,
        'Source changed during distribution copy.',
      );
    }
    for (const entry of boms)
      writeFileSync(resolve(distribution, entry.name), entry.content, {
        flag: 'wx',
      });
    writeFileSync(resolve(distribution, 'checksums.txt'), checksums, {
      flag: 'wx',
    });
  } else {
    assert.equal(
      bytes(resolve(distribution, 'checksums.txt'), 65536).toString('utf8'),
      checksums,
      'Distribution checksums mismatch.',
    );
  }
  assert.deepEqual(
    files(distribution),
    [...output.map((file) => file.name), 'checksums.txt'].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    ),
    'Distribution contains missing or unexpected files.',
  );
  process.stdout.write(
    `Distribution ${generate ? 'generated' : 'verified'}: six native archives, ${web.identities.length} Web files, ${edge.identities.length} edge files, eight CycloneDX 1.7 SBOMs and complete SHA-256 coverage.\n`,
  );
  process.stdout.write(
    'Integrity and notice verification is not release approval: native/device acceptance, signing and publication remain separate.\n',
  );
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Do not echo parsed artifact contents, tool diagnostics or credential matches.
    process.stderr.write(
      `Distribution verification failed during ${stage}. No publication attempted.\n`,
    );
    if (error.code === 'ERR_ASSERTION' && error.generatedMessage === false)
      process.stderr.write(`${error.message.split('\n')[0]}\n`);
    process.exitCode = 1;
  }
}
