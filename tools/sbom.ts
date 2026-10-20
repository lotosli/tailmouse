import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { BuildIdentity } from './build-identity.ts';

export interface FileIdentity {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ModuleIdentity {
  name: string;
  version: string;
  sum?: string;
  revision?: string;
}

interface Component {
  'bom-ref': string;
  type: 'application' | 'library' | 'file';
  name: string;
  version?: string;
  purl?: string;
  hashes?: { alg: 'SHA-256'; content: string }[];
  properties?: { name: string; value: string }[];
  components?: Component[];
}

const versionPattern =
  /^(?:go|v)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;

export function fileIdentity(name: string, bytes: Buffer): FileIdentity {
  const identity = {
    name,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  fileComponent(identity);
  return identity;
}

export function checksumManifest(files: FileIdentity[]): string {
  assert.ok(
    files.length > 0 && files.length <= 512,
    'Invalid checksum inventory size.',
  );
  assert.equal(
    new Set(files.map((file) => file.name)).size,
    files.length,
    'Duplicate checksum path.',
  );
  return files
    .map((file) => {
      fileComponent(file);
      assert.notEqual(
        file.name,
        'checksums.txt',
        'Checksum manifest cannot include itself.',
      );
      return `${file.sha256}  ${file.name}\n`;
    })
    .sort()
    .join('');
}

// Recognizable credential forms are a release tripwire, not proof that an
// arbitrary secret cannot be hidden in data. Inputs must also be build-owned.
export function assertNoCredentials(bytes: Buffer): void {
  const text = bytes.toString('latin1');
  assert.ok(
    !/\/#\/v1\/[A-Za-z0-9_-]{40,}/u.test(text),
    'Invitation material found in release content.',
  );
  assert.ok(
    !/(?<![A-Za-z0-9_-])tc[A-Za-z0-9_-]{64,}/u.test(text),
    'Possible ConnBlob found in release content.',
  );
  assert.ok(
    !/-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\r\n]+[A-Za-z0-9+/=\r\n]{16,}-----END \1-----/u.test(
      text,
    ),
    'Private key material found in release content.',
  );
}

export function verifySBOM(
  actual: unknown,
  expected: ReturnType<typeof nativeSBOM>,
): void {
  assert.ok(
    actual !== null && typeof actual === 'object',
    'Missing SBOM document.',
  );
  const bom = actual as ReturnType<typeof nativeSBOM>;
  assert.match(
    bom.serialNumber,
    /^urn:uuid:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
    'Invalid SBOM serial number.',
  );
  assert.equal(
    new Date(bom.metadata.timestamp).toISOString(),
    bom.metadata.timestamp,
    'Invalid SBOM timestamp.',
  );
  assert.deepEqual(
    bom,
    {
      ...expected,
      serialNumber: bom.serialNumber,
      metadata: { ...expected.metadata, timestamp: bom.metadata.timestamp },
    },
    'SBOM differs from verified artifact inventory.',
  );
}

function library(
  ecosystem: 'golang' | 'npm',
  input: ModuleIdentity,
): Component {
  assert.match(
    input.name,
    /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.~+/-]*$/u,
    'Invalid module name.',
  );
  assert.ok(
    input.name.length <= 256 && input.version.length <= 128,
    'Module identity exceeds its bound.',
  );
  assert.match(
    input.version,
    versionPattern,
    'Module has no immutable version.',
  );
  assert.ok(
    ecosystem === 'npm'
      ? /^\d/u.test(input.version)
      : input.name === 'stdlib'
        ? /^go\d/u.test(input.version)
        : /^v\d/u.test(input.version),
    'Module version has the wrong ecosystem.',
  );
  const purl = `pkg:${ecosystem}/${input.name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(input.version)}`;
  const properties: { name: string; value: string }[] = [];
  if (input.sum !== undefined) {
    assert.match(
      input.sum,
      /^h1:[A-Za-z0-9+/]{43}=$/u,
      'Invalid Go module sum.',
    );
    // A Go h1 sum describes canonical module content, not an archive's SHA-256.
    properties.push({ name: 'tailmouse:go-module-sum', value: input.sum });
  }
  if (input.revision !== undefined) {
    assert.match(input.revision, revisionPattern, 'Invalid module revision.');
    properties.push({ name: 'tailmouse:git-revision', value: input.revision });
  }
  return {
    'bom-ref': purl,
    type: 'library',
    name: input.name,
    version: input.version,
    purl,
    ...(properties.length ? { properties } : {}),
  };
}

function fileComponent(file: FileIdentity): Component {
  assert.ok(
    file.name.length <= 256 &&
      !file.name.split('/').some((part) => part === '.' || part === '..'),
    'Invalid artifact path.',
  );
  assert.match(
    file.name,
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u,
    'Unsafe artifact path.',
  );
  assert.ok(
    Number.isSafeInteger(file.bytes) &&
      file.bytes >= 0 &&
      file.bytes <= 128 * 1024 * 1024,
    'Invalid artifact size.',
  );
  assert.match(file.sha256, /^[a-f0-9]{64}$/u, 'Invalid artifact checksum.');
  return {
    'bom-ref': `file:${file.name}`,
    type: 'file',
    name: file.name,
    hashes: [{ alg: 'SHA-256', content: file.sha256 }],
    properties: [{ name: 'tailmouse:bytes', value: String(file.bytes) }],
  };
}

function document(
  identity: BuildIdentity,
  sourceRevision: string,
  target: string,
  files: FileIdentity[],
  libraries: Component[],
  dependencies: { ref: string; dependsOn: string[] }[],
  archive?: FileIdentity,
) {
  assert.match(
    identity.version,
    versionPattern,
    'Invalid application version.',
  );
  assert.match(
    identity.tailcatRevision,
    revisionPattern,
    'Missing Tailcat revision.',
  );
  assert.match(sourceRevision, revisionPattern, 'Missing source revision.');
  assert.equal(identity.protocols.leash, 2);
  assert.equal(identity.protocols.resource, 2);
  assert.ok(
    files.length > 0 &&
      files.length <= 512 &&
      libraries.length > 0 &&
      libraries.length <= 512,
    'Missing or excessive SBOM components.',
  );
  const components = files
    .map(fileComponent)
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const root = `tailmouse:${target}`;
  const refs = [
    root,
    ...components.map((item) => item['bom-ref']),
    ...libraries.map((item) => item['bom-ref']),
  ];
  assert.equal(new Set(refs).size, refs.length, 'Duplicate SBOM component.');
  assert.equal(
    new Set(dependencies.map((item) => item.ref)).size,
    dependencies.length,
    'Duplicate dependency record.',
  );
  for (const dependency of dependencies) {
    assert.ok(
      refs.includes(dependency.ref) &&
        dependency.dependsOn.every(
          (ref) => refs.includes(ref) && ref !== dependency.ref,
        ),
      'Dangling or self-referential dependency.',
    );
    assert.equal(
      new Set(dependency.dependsOn).size,
      dependency.dependsOn.length,
      'Duplicate dependency edge.',
    );
  }
  return {
    $schema: 'https://cyclonedx.org/schema/bom-1.7.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.7',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: {
        'bom-ref': root,
        type: 'application',
        name:
          target === 'web'
            ? 'TailMouse Web'
            : target === 'edge'
              ? 'TailMouse Link Edge'
              : 'TailMouse',
        version: identity.version,
        licenses: [{ license: { id: 'Apache-2.0' } }],
        ...(archive ? { hashes: fileComponent(archive).hashes } : {}),
        components,
        properties: [
          { name: 'tailmouse:target', value: target },
          { name: 'tailmouse:source-revision', value: sourceRevision },
          {
            name: 'tailmouse:tailcat-revision',
            value: identity.tailcatRevision,
          },
          { name: 'tailmouse:protocol-leash', value: '2' },
          {
            name: 'tailmouse:dependency-scope',
            value:
              'Compiled and bundled component inventory; internal library dependency edges are not asserted.',
          },
          ...(archive
            ? [{ name: 'tailmouse:archive', value: archive.name }]
            : []),
        ],
      },
      tools: {
        components: [
          {
            type: 'application',
            name: 'TailMouse release verifier',
            version: identity.version,
          },
        ],
      },
    },
    components: libraries.sort((a, b) =>
      a['bom-ref'].localeCompare(b['bom-ref'], 'en'),
    ),
    dependencies,
    // The component inventory is checked independently. Its internal graph
    // is not a call graph, and omitted library edges are unknown, not empty.
    compositions: [{ aggregate: 'incomplete', dependencies: [root] }],
  };
}

export function nativeSBOM(
  identity: BuildIdentity,
  sourceRevision: string,
  target: string,
  archive: FileIdentity,
  files: FileIdentity[],
  modules: ModuleIdentity[],
  goVersion: string,
) {
  assert.match(
    target,
    /^(darwin|linux|windows)\/(amd64|arm64)$/u,
    'Unsupported native target.',
  );
  const binary = target.startsWith('windows/') ? 'tailmouse.exe' : 'tailmouse';
  assert.ok(
    files.some((file) => file.name === binary),
    'Archive has no executable.',
  );
  const tailcat = modules.find(
    (module) => module.name === 'github.com/tailscale/tailcat',
  );
  assert.equal(
    tailcat?.revision,
    identity.tailcatRevision,
    'Native Tailcat identity is not resolved.',
  );
  for (const module of modules)
    assert.ok(
      module === tailcat || module.sum !== undefined,
      'Native dependency has no module sum.',
    );
  const libraries = [...modules, { name: 'stdlib', version: goVersion }].map(
    (module) => library('golang', module),
  );
  return document(
    identity,
    sourceRevision,
    target,
    files,
    libraries,
    [
      { ref: `tailmouse:${target}`, dependsOn: [`file:${binary}`] },
      {
        ref: `file:${binary}`,
        dependsOn: libraries.map((item) => item['bom-ref']).sort(),
      },
    ],
    archive,
  );
}

export function webSBOM(
  identity: BuildIdentity,
  sourceRevision: string,
  files: FileIdentity[],
  npm: ModuleIdentity[],
  wasm: { main: ModuleIdentity; modules: ModuleIdentity[] },
  goVersion: string,
  resource?: {
    main: ModuleIdentity;
    modules: ModuleIdentity[];
    tailcat: ModuleIdentity;
  },
) {
  assert.equal(wasm.main.name, 'github.com/tailscale/tailcat');
  assert.equal(
    wasm.main.revision,
    identity.tailcatRevision,
    'Web Tailcat identity is not resolved.',
  );
  const binaries = files.filter((file) => file.name.endsWith('.wasm'));
  assert.equal(
    binaries.length,
    resource === undefined ? 1 : 2,
    'Web release Wasm inventory is incomplete.',
  );
  if (resource !== undefined) {
    assert.equal(resource.main.name, 'tailmouse');
    assert.equal(resource.main.revision, sourceRevision);
    assert.deepEqual(resource.tailcat, wasm.main);
  }
  assert.ok(
    npm.length > 0 && wasm.modules.length > 0,
    'Web dependency inventory is empty.',
  );
  for (const module of [...wasm.modules, ...(resource?.modules ?? [])])
    assert.ok(module.sum !== undefined, 'Wasm dependency has no module sum.');
  const jsLibraries = npm.map((module) => library('npm', module));
  const legacyLibraries = [
    wasm.main,
    ...wasm.modules,
    { name: 'stdlib', version: goVersion },
  ].map((module) => library('golang', module));
  const resourceLibraries =
    resource === undefined
      ? []
      : [
          resource.tailcat,
          ...resource.modules,
          { name: 'stdlib', version: goVersion },
        ].map((module) => library('golang', module));
  const goLibraries = [
    ...new Map(
      [...legacyLibraries, ...resourceLibraries].map((item) => [
        item['bom-ref'],
        item,
      ]),
    ).values(),
  ];
  const refs = binaries.map((file) => ({
    ref: `file:${file.name}`,
    dependsOn: (file.name.includes('/resource-')
      ? resourceLibraries
      : legacyLibraries
    )
      .map((item) => item['bom-ref'])
      .sort(),
  }));
  return document(
    identity,
    sourceRevision,
    'web',
    files,
    [...jsLibraries, ...goLibraries],
    [
      {
        ref: 'tailmouse:web',
        dependsOn: [
          ...jsLibraries.map((item) => item['bom-ref']),
          ...refs.map((item) => item.ref),
        ].sort(),
      },
      ...refs,
    ],
  );
}

export function edgeSBOM(
  identity: BuildIdentity,
  sourceRevision: string,
  files: FileIdentity[],
  npm: ModuleIdentity[],
  toolchains: { node: string; wrangler: string; esbuild: string },
) {
  assert.deepEqual(
    files.map((file) => file.name).sort(),
    [
      'LICENSE',
      'NOTICE',
      'THIRD_PARTY_NOTICES.txt',
      'bundle-meta.json',
      'edge-manifest.json',
      'index.js',
      'index.js.map',
      'wrangler.jsonc',
    ].sort(),
    'Edge SBOM has an incomplete artifact inventory.',
  );
  assert.equal(
    npm.length,
    1,
    'Edge SBOM requires one bundled runtime dependency.',
  );
  assert.equal(npm[0]!.name, 'cborg', 'Unreviewed edge runtime dependency.');
  const libraries = npm.map((module) => library('npm', module));
  const bom = document(identity, sourceRevision, 'edge', files, libraries, [
    { ref: 'tailmouse:edge', dependsOn: ['file:index.js'] },
    {
      ref: 'file:index.js',
      dependsOn: libraries.map((item) => item['bom-ref']),
    },
  ]);
  for (const [name, version] of Object.entries(toolchains)) {
    assert.match(version, /^\d+\.\d+\.\d+$/u, 'Invalid edge compiler version.');
    bom.metadata.tools.components.push({ type: 'application', name, version });
  }
  assert.deepEqual(
    Object.keys(toolchains).sort(),
    ['esbuild', 'node', 'wrangler'],
    'Incomplete edge compiler identity.',
  );
  bom.metadata.component.properties.push({
    name: 'tailmouse:platform-import',
    value: 'cloudflare:workers',
  });
  return bom;
}
