import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const forbiddenParentName = ['Knowledge', 'Base'].join('');

const required = [
  'AGENTS.md',
  'LICENSE',
  'NOTICE',
  'THIRD_PARTY_NOTICES.txt',
  'tooling/third-party-licenses.json',
  'README.md',
  '.github/workflows/gate.yml',
  '.gitmodules',
  '.node-version',
  'context.md',
  'docs/architecture.md',
  'docs/decisions/2026-001-engineering-foundation.md',
  'docs/development/engineering-practices.md',
  'docs/development/gates.md',
  'docs/development/sdd.md',
  'docs/development/tailcat-submodule.md',
  'docs/evidence/TailMouse_PRD_v1.0.zh-CN.md',
  'docs/governance/constitution.md',
  'docs/product-baseline.md',
  'apps/cli/AGENTS.md',
  'apps/cli/internal/transport/tailcat/AGENTS.md',
  'apps/web/AGENTS.md',
  'protocol/AGENTS.md',
  'tests/AGENTS.md',
  'third_party/AGENTS.md',
  'third_party/tailcat/LICENSE',
  'third_party/tailcat/go.mod',
  'openspec/config.yaml',
  'openspec/schemas/tailmouse-sdd/schema.yaml',
  'go.mod',
  'go.work',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tooling/versions.json',
];

for (const path of required) {
  try {
    if (!statSync(join(root, path)).isFile()) {
      failures.push(`${path} is not a file`);
    }
  } catch {
    failures.push(`${path} is missing`);
  }
}

function filesBelow(directory) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (
      ['.artifacts', '.git', 'coverage', 'dist', 'node_modules'].includes(
        entry.name,
      )
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...filesBelow(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

for (const path of filesBelow(root)) {
  const projectPath = relative(root, path).split(sep).join('/');
  if (projectPath.startsWith('third_party/tailcat/')) continue;
  const extension = extname(path);
  if (
    !projectPath.startsWith('docs/evidence/') &&
    !['.gif', '.png', '.wasm'].includes(extension)
  ) {
    const harnessContent = readFileSync(path, 'utf8');
    if (/\p{Script=Han}/u.test(harnessContent)) {
      failures.push(`${projectPath}: harness text must be English`);
    }
    if (harnessContent.includes(forbiddenParentName)) {
      failures.push(`${projectPath}: parent-repository coupling is forbidden`);
    }
  }
  if (!['.go', '.js', '.mjs', '.ts', '.tsx', '.html'].includes(extension)) {
    continue;
  }
  const content = readFileSync(path, 'utf8');

  if (
    extension === '.go' &&
    content.includes('github.com/tailscale/tailcat') &&
    !projectPath.startsWith('apps/cli/internal/transport/tailcat/')
  ) {
    failures.push(`${projectPath}: Tailcat imports are adapter-only`);
  }

  if (
    projectPath.startsWith('apps/web/src/') &&
    /\btailcat(?:Dial|Listen)\b/.test(content) &&
    !projectPath.startsWith('apps/web/src/transport/tailcat/')
  ) {
    failures.push(`${projectPath}: Tailcat bridge calls are adapter-only`);
  }

  if (
    projectPath.startsWith('apps/web/') &&
    /<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\//i.test(content)
  ) {
    failures.push(`${projectPath}: remote scripts and styles are forbidden`);
  }
}

const versions = JSON.parse(
  readFileSync(join(root, 'tooling/versions.json'), 'utf8'),
);
const packageJson = JSON.parse(
  readFileSync(join(root, 'package.json'), 'utf8'),
);
for (const path of ['package.json', 'apps/web/package.json']) {
  if (
    JSON.parse(readFileSync(join(root, path), 'utf8')).license !== 'Apache-2.0'
  )
    failures.push(`${path}: project license must be Apache-2.0`);
}
const nodeVersion = readFileSync(join(root, '.node-version'), 'utf8').trim();
if (nodeVersion !== versions.node) {
  failures.push('.node-version must match tooling/versions.json');
}
if (packageJson.engines?.node !== versions.node) {
  failures.push('engines.node must exactly match tooling/versions.json');
}
if (packageJson.packageManager !== `pnpm@${versions.pnpm}`) {
  failures.push('packageManager must match tooling/versions.json');
}
if (
  packageJson.devDependencies?.['@fission-ai/openspec'] !== versions.openspec
) {
  failures.push('OpenSpec must match tooling/versions.json');
}
if (packageJson.devDependencies?.oxlint !== versions.oxlint) {
  failures.push('Oxlint must match tooling/versions.json');
}
if (
  packageJson.devDependencies?.['oxlint-tsgolint'] !== versions.oxlintTsgolint
) {
  failures.push('oxlint-tsgolint must match tooling/versions.json');
}

const goMod = readFileSync(join(root, 'go.mod'), 'utf8');
if (!goMod.includes(`go ${versions.go}`)) {
  failures.push('go.mod must match tooling/versions.json');
}

const goWork = readFileSync(join(root, 'go.work'), 'utf8');
if (!goWork.includes(`go ${versions.go}`)) {
  failures.push('go.work must match tooling/versions.json');
}
if (!goWork.includes('./third_party/tailcat')) {
  failures.push('go.work must include the Tailcat submodule');
}

const tailcat = versions.tailcat;
if (
  tailcat?.kind !== 'git-submodule' ||
  tailcat.path !== 'third_party/tailcat' ||
  tailcat.repository !== 'https://github.com/tailscale/tailcat.git' ||
  tailcat.branch !== 'main' ||
  tailcat.module !== 'github.com/tailscale/tailcat'
) {
  failures.push('Tailcat submodule metadata is invalid');
}

const gitmodules = readFileSync(join(root, '.gitmodules'), 'utf8');
for (const expected of [
  'path = third_party/tailcat',
  'url = https://github.com/tailscale/tailcat.git',
  'branch = main',
]) {
  if (!gitmodules.includes(expected)) {
    failures.push(`.gitmodules is missing: ${expected}`);
  }
}

const tailcatGoMod = readFileSync(
  join(root, 'third_party/tailcat/go.mod'),
  'utf8',
);
if (!tailcatGoMod.startsWith('module github.com/tailscale/tailcat\n')) {
  failures.push('Tailcat submodule has an unexpected Go module path');
}
const tailcatGoVersion = tailcatGoMod.match(/^go\s+(\d+)\.(\d+)(?:\.(\d+))?$/m);
const rootGoVersion = versions.go.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
const versionParts = (match) =>
  match ? match.slice(1, 4).map((part) => Number(part ?? 0)) : null;
const compareVersions = (left, right) => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};
const tailcatParts = versionParts(tailcatGoVersion);
const rootParts = versionParts(rootGoVersion);
if (!tailcatParts || !rootParts) {
  failures.push('Go versions must use numeric major.minor[.patch] syntax');
} else if (compareVersions(tailcatParts, rootParts) > 0) {
  failures.push('Tailcat requires a newer Go toolchain than the repository');
}

try {
  const indexEntry = execFileSync(
    'git',
    ['ls-files', '--stage', '--', 'third_party/tailcat'],
    { cwd: root, encoding: 'utf8' },
  ).trim();
  const fields = indexEntry.split(/\s+/);
  if (fields[0] !== '160000' || !/^[0-9a-f]{40}$/.test(fields[1] ?? '')) {
    failures.push('Tailcat must be recorded as a Git submodule gitlink');
  }

  const submoduleStatus = execFileSync(
    'git',
    ['submodule', 'status', '--', 'third_party/tailcat'],
    { cwd: root, encoding: 'utf8' },
  ).trimEnd();
  if (!submoduleStatus.startsWith(' ')) {
    failures.push(
      'Tailcat submodule must be initialized at the recorded gitlink',
    );
  }

  const checkedOutRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: join(root, 'third_party/tailcat'),
    encoding: 'utf8',
  }).trim();
  if (fields[1] && checkedOutRevision !== fields[1]) {
    failures.push('Tailcat checkout does not match the staged gitlink');
  }

  const sourceStatus = execFileSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: join(root, 'third_party/tailcat'), encoding: 'utf8' },
  ).trim();
  if (sourceStatus) {
    failures.push('Tailcat source must remain unmodified and clean');
  }
} catch (error) {
  failures.push(`Tailcat submodule inspection failed: ${error.message}`);
}

const workflow = readFileSync(join(root, '.github/workflows/gate.yml'), 'utf8');
const occurrenceCount = (content, expected) =>
  content.split(expected).length - 1;
for (const [action, pin] of Object.entries(versions.githubActions)) {
  const expected = `uses: ${action}@${pin.revision} # v${pin.version}`;
  if (occurrenceCount(workflow, expected) !== 2) {
    failures.push(
      `${action} pins must match tooling/versions.json in both jobs`,
    );
  }
}
if (occurrenceCount(workflow, `version: ${versions.pnpm}`) !== 2) {
  failures.push(
    'CI pnpm version must match tooling/versions.json in both jobs',
  );
}
if (occurrenceCount(workflow, `go-version: ${versions.go}`) !== 2) {
  failures.push('CI Go version must match tooling/versions.json in both jobs');
}
if (occurrenceCount(workflow, 'submodules: true') !== 2) {
  failures.push('CI must initialize submodules in both jobs');
}
if (failures.length > 0) {
  process.stderr.write(
    `Architecture checks failed:\n- ${failures.join('\n- ')}\n`,
  );
  process.exit(1);
}

process.stdout.write('Architecture checks passed.\n');
