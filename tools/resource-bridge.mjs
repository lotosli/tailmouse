import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { run } from './process.mjs';
import { wasmBuildTags } from './web-dependencies.ts';

const root = resolve(import.meta.dirname, '..');
const output = join(root, '.artifacts', 'resource-bridge');
const { go } = JSON.parse(
  readFileSync(join(root, 'tooling/versions.json'), 'utf8'),
);
mkdirSync(output, { recursive: true });
const tailcatRevision = run('git', ['rev-parse', 'HEAD'], {
  cwd: join(root, 'third_party/tailcat'),
  capture: true,
}).stdout.trim();
const tags = wasmBuildTags(
  readFileSync(join(root, '.artifacts/tailcat/tailcat-web.wasm')),
  tailcatRevision,
);
run(
  'go',
  [
    'build',
    '-trimpath',
    '-tags',
    tags,
    '-ldflags=-s -w',
    '-o',
    join(output, 'resource.wasm'),
    './apps/cli/internal/transport/tailcat/wasm',
  ],
  {
    cwd: root,
    env: {
      GOWORK: join(root, 'go.work'),
      GOOS: 'js',
      GOARCH: 'wasm',
      CGO_ENABLED: '0',
      GOTOOLCHAIN: `go${go}`,
    },
  },
);
const bytes = readFileSync(join(output, 'resource.wasm'));
const revision = run('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  capture: true,
}).stdout.trim();
const sourceHash = createHash('sha256');
const sources = run(
  'git',
  [
    'ls-files',
    '-co',
    '--exclude-standard',
    '--',
    'apps/cli/internal/transport/tailcat/wasm',
    'apps/cli/internal/flow',
    'go.mod',
    'go.sum',
    'go.work',
    'go.work.sum',
  ],
  { cwd: root, capture: true },
)
  .stdout.trim()
  .split('\n')
  .sort();
for (const name of new Set(sources))
  sourceHash
    .update(name)
    .update('\0')
    .update(readFileSync(join(root, name)));
writeFileSync(
  join(output, 'manifest.json'),
  JSON.stringify(
    {
      schemaVersion: 1,
      frontendMajor: 1,
      protocolMajor: 2,
      tailcatRevision,
      revision,
      sourceSha256: sourceHash.digest('hex'),
      goVersion: `go${go}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    null,
    2,
  ) + '\n',
);
