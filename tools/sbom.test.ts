import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertNoCredentials,
  checksumManifest,
  edgeSBOM,
  fileIdentity,
  nativeSBOM,
  verifySBOM,
  webSBOM,
  type FileIdentity,
  type ModuleIdentity,
} from './sbom.ts';

const identity = {
  version: '1.0.0',
  protocols: { leash: 2, resource: 2 },
  tailcatRevision: '1'.repeat(40),
} as const;
const revision = '2'.repeat(40);
const sum = `h1:${'A'.repeat(43)}=`;
const tailcat = {
  name: 'github.com/tailscale/tailcat',
  version: 'v0.4.1-0.20260901000000-111111111111',
  revision: identity.tailcatRevision,
};
const module = {
  name: 'example.invalid/module',
  version: 'v1.2.3+incompatible',
  sum,
};
const file = (name: string): FileIdentity => ({
  name,
  bytes: 23,
  sha256: 'a'.repeat(64),
});
const nativeFiles = [file('tailmouse'), file('README.md')];
const archive = file('tailmouse_1.0.0_darwin_arm64.tar.gz');
const webFiles = [
  file('index.html'),
  file('tailcat/transport-12345678.wasm'),
  file('assets/app-12345678.js'),
];
const npm = [{ name: '@xterm/xterm', version: '6.0.0' }];
const wasm = { main: tailcat, modules: [module] };

await test('edge SBOM binds the complete bundle and current compiler/runtime identities separately', () => {
  const files = [
    'LICENSE',
    'NOTICE',
    'THIRD_PARTY_NOTICES.txt',
    'bundle-meta.json',
    'edge-manifest.json',
    'index.js',
    'index.js.map',
    'wrangler.jsonc',
  ].map(file);
  const runtime = [{ name: 'cborg', version: '6.1.2' }];
  const tools = { node: '26.8.1', wrangler: '4.129.0', esbuild: '0.28.1' };
  const bom = edgeSBOM(identity, revision, files, runtime, tools);
  assert.equal(bom.metadata.component.name, 'TailMouse Link Edge');
  assert.equal(bom.metadata.component.components.length, 8);
  assert.deepEqual(
    bom.components.map((item) => item.purl),
    ['pkg:npm/cborg@6.1.2'],
  );
  assert.deepEqual(
    bom.metadata.tools.components.slice(1),
    Object.entries(tools).map(([name, version]) => ({
      type: 'application',
      name,
      version,
    })),
  );
  assert.deepEqual(bom.dependencies, [
    { ref: 'tailmouse:edge', dependsOn: ['file:index.js'] },
    { ref: 'file:index.js', dependsOn: ['pkg:npm/cborg@6.1.2'] },
  ]);
  assert.ok(
    bom.metadata.component.properties.some(
      (item) =>
        item.name === 'tailmouse:platform-import' &&
        item.value === 'cloudflare:workers',
    ),
  );
  verifySBOM(structuredClone(bom), bom);
  const changed = structuredClone(bom);
  changed.metadata.tools.components[1]!.version = '26.8.2';
  assert.throws(() => verifySBOM(changed, bom));
  assert.throws(() =>
    edgeSBOM(identity, revision, files.slice(1), runtime, tools),
  );
  assert.throws(() => edgeSBOM(identity, revision, files, [], tools));
  assert.throws(() =>
    edgeSBOM(identity, revision, files, [...runtime, ...runtime], tools),
  );
  assert.throws(() =>
    edgeSBOM(
      identity,
      revision,
      files,
      [{ name: 'unknown', version: '1.0.0' }],
      tools,
    ),
  );
  assert.throws(() =>
    edgeSBOM(identity, revision, files, runtime, {
      ...tools,
      wrangler: 'latest',
    }),
  );
  assert.throws(() =>
    edgeSBOM(identity, revision, files, runtime, {
      ...tools,
      extra: '1.0.0',
    } as typeof tools),
  );
});

await test('native SBOM binds archive, contained bytes, resolved Tailcat and actual module inventory', () => {
  const bom = nativeSBOM(
    identity,
    revision,
    'darwin/arm64',
    archive,
    nativeFiles,
    [tailcat, module],
    'go1.27.1',
  );
  assert.equal(bom.specVersion, '1.7');
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.deepEqual(bom.metadata.component.licenses, [
    { license: { id: 'Apache-2.0' } },
  ]);
  assert.match(bom.serialNumber, /^urn:uuid:/u);
  assert.ok(Number.isFinite(Date.parse(bom.metadata.timestamp)));
  assert.deepEqual(bom.metadata.component.hashes, [
    { alg: 'SHA-256', content: archive.sha256 },
  ]);
  assert.deepEqual(
    bom.metadata.component.components.map((item) => item.name),
    ['README.md', 'tailmouse'],
  );
  assert.equal(bom.components.length, 3);
  const resolved = bom.components.find((item) => item.name === tailcat.name)!;
  assert.ok(resolved.purl?.includes(tailcat.version));
  assert.deepEqual(resolved.properties, [
    { name: 'tailmouse:git-revision', value: identity.tailcatRevision },
  ]);
  const immutable = bom.components.find((item) => item.name === module.name)!;
  assert.ok(immutable.purl?.endsWith('v1.2.3%2Bincompatible'));
  assert.equal(immutable.hashes, undefined, 'Go h1 is not an archive SHA-256');
  assert.deepEqual(immutable.properties, [
    { name: 'tailmouse:go-module-sum', value: sum },
  ]);
  assert.equal(bom.dependencies.length, 2);
  assert.ok(
    bom.dependencies.every((entry) => entry.dependsOn.length > 0),
    'Unknown library edges must not be asserted empty',
  );
  assert.equal(bom.compositions[0]?.aggregate, 'incomplete');
});

await test('Web SBOM separates npm and Wasm libraries and includes every supplied static file', () => {
  const bom = webSBOM(identity, revision, webFiles, npm, wasm, 'go1.27.1');
  assert.equal(bom.metadata.component.name, 'TailMouse Web');
  assert.deepEqual(bom.metadata.component.licenses, [
    { license: { id: 'Apache-2.0' } },
  ]);
  assert.equal(bom.metadata.component.hashes, undefined);
  assert.equal(bom.metadata.component.components.length, webFiles.length);
  assert.ok(
    bom.components.some((item) => item.purl === 'pkg:npm/%40xterm/xterm@6.0.0'),
  );
  assert.ok(
    bom.components.some((item) => item.purl === 'pkg:golang/stdlib@go1.27.1'),
  );
  assert.equal(bom.dependencies[1]?.ref, `file:${webFiles[1]!.name}`);
  assert.equal(bom.dependencies[1]?.dependsOn.length, 3);
  assert.deepEqual(
    bom.metadata.component.properties.filter(({ name }) =>
      name.startsWith('tailmouse:protocol-'),
    ),
    [
      { name: 'tailmouse:protocol-escape', value: '1' },
      { name: 'tailmouse:protocol-leash', value: '2' },
    ],
  );
  assert.ok(!JSON.stringify(bom).includes('/Users/'));
  const win = nativeSBOM(
    identity,
    revision,
    'windows/amd64',
    file('release.zip'),
    [file('tailmouse.exe')],
    [tailcat, module],
    'go1.27.1',
  );
  assert.deepEqual(win.dependencies[0]?.dependsOn, ['file:tailmouse.exe']);
});

await test('SBOM generation rejects missing, duplicate, malformed and unresolved identities', () => {
  const build = (
    modules: ModuleIdentity[] = [tailcat, module],
    files = nativeFiles,
    target = 'darwin/arm64',
  ) =>
    nativeSBOM(identity, revision, target, archive, files, modules, 'go1.27.1');
  for (const modules of [
    [module],
    [tailcat, module, module],
    [tailcat, { ...module, sum: '' }],
    [{ ...tailcat, revision: '3'.repeat(40) }, module],
    [tailcat, { ...module, version: 'UNKNOWN' }],
    [tailcat, { ...module, version: 'go1.2.3' }],
    [tailcat, { ...module, name: '/private/path' }],
    [tailcat, { ...module, name: 'x'.repeat(257) }],
  ])
    assert.throws(() => build(modules));
  assert.throws(() =>
    build([tailcat, { name: module.name, version: module.version }]),
  );
  for (const files of [
    [],
    [file('README.md')],
    [...nativeFiles, nativeFiles[0]!],
    [...nativeFiles, file('../outside')],
    [...nativeFiles, file('/absolute')],
    [...nativeFiles, { ...file('bad'), bytes: -1 }],
    [...nativeFiles, { ...file('bad'), sha256: 'unknown' }],
  ])
    assert.throws(() => build(undefined, files));
  assert.throws(() => build(undefined, undefined, 'linux/riscv64'));
  assert.throws(() =>
    nativeSBOM(
      { ...identity, version: 'unknown' },
      revision,
      'darwin/arm64',
      archive,
      nativeFiles,
      [tailcat],
      'go1.27.1',
    ),
  );
  assert.throws(() =>
    nativeSBOM(
      identity,
      'unrecorded',
      'darwin/arm64',
      archive,
      nativeFiles,
      [tailcat],
      'go1.27.1',
    ),
  );
  assert.throws(() =>
    webSBOM(identity, revision, webFiles, [], wasm, 'go1.27.1'),
  );
  assert.throws(() =>
    webSBOM(
      identity,
      revision,
      webFiles,
      npm,
      { main: tailcat, modules: [] },
      'go1.27.1',
    ),
  );
  assert.throws(() =>
    webSBOM(
      identity,
      revision,
      webFiles,
      npm,
      {
        main: tailcat,
        modules: [{ name: module.name, version: module.version }],
      },
      'go1.27.1',
    ),
  );
  assert.throws(() =>
    webSBOM(
      identity,
      revision,
      webFiles,
      [{ ...npm[0]!, version: 'v6.0.0' }],
      wasm,
      'go1.27.1',
    ),
  );
  assert.throws(() =>
    webSBOM(identity, revision, [file('index.html')], npm, wasm, 'go1.27.1'),
  );
});

await test('checksum manifest binds actual bytes and rejects unsafe, duplicate or self paths', () => {
  const first = fileIdentity('web/index.html', Buffer.from('abc'));
  assert.deepEqual(first, {
    name: 'web/index.html',
    bytes: 3,
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  });
  const second = fileIdentity('release.zip', Buffer.from('different'));
  const manifest = checksumManifest([first, second]);
  assert.ok(manifest.includes(`${first.sha256}  web/index.html\n`));
  assert.equal(manifest, checksumManifest([second, first]));
  assert.notEqual(first.sha256, second.sha256);
  for (const files of [
    [],
    [first, first],
    [file('checksums.txt')],
    [file('../outside')],
    [file('bad\npath')],
    [file('C:/outside')],
  ])
    assert.throws(() => checksumManifest(files));
});

await test('release content rejects recognizable invitations, ConnBlobs and private keys without echoing them', () => {
  const candidates = [
    `https://example.invalid/#/v1/${'A'.repeat(80)}`,
    `tc${'A'.repeat(80)}`,
    `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(80)}\n-----END PRIVATE KEY-----`,
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${'A'.repeat(80)}\n-----END OPENSSH PRIVATE KEY-----`,
  ];
  for (const candidate of candidates) {
    assert.throws(
      () => assertNoCredentials(Buffer.from(candidate)),
      (error: unknown) =>
        error instanceof Error && !error.message.includes(candidate),
    );
  }
  assertNoCredentials(
    Buffer.from('Treat this link like a password. /#/v1/REDACTED'),
  );
  assertNoCredentials(Buffer.from('-----BEGIN PRIVATE KEY-----'));
  assertNoCredentials(Buffer.from([0, 255, 128, 10]));
});

await test('SBOM verification permits generation metadata but rejects inventory and identity tampering', () => {
  const expected = nativeSBOM(
    identity,
    revision,
    'darwin/arm64',
    archive,
    nativeFiles,
    [tailcat, module],
    'go1.27.1',
  );
  const another = nativeSBOM(
    identity,
    revision,
    'darwin/arm64',
    archive,
    nativeFiles,
    [tailcat, module],
    'go1.27.1',
  );
  verifySBOM(another, expected);
  for (const change of [
    (bom: typeof expected) => {
      bom.components.pop();
    },
    (bom: typeof expected) => {
      bom.metadata.component.components.pop();
    },
    (bom: typeof expected) => {
      bom.components[0]!.version = 'v9.9.9';
    },
    (bom: typeof expected) => {
      bom.metadata.component.hashes![0]!.content = 'b'.repeat(64);
    },
    (bom: typeof expected) => {
      bom.metadata.component.properties[1]!.value = '3'.repeat(40);
    },
    (bom: typeof expected) => {
      bom.dependencies[0]!.dependsOn = [];
    },
    (bom: typeof expected) => {
      bom.serialNumber = 'urn:uuid:invalid';
    },
    (bom: typeof expected) => {
      bom.metadata.timestamp = 'invalid';
    },
    (bom: typeof expected) => {
      Object.assign(bom, { unknown: true });
    },
  ]) {
    const altered = structuredClone(expected);
    change(altered);
    assert.throws(() => verifySBOM(altered, expected));
  }
  assert.throws(() => verifySBOM(null, expected));
});
