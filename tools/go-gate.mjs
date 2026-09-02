import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { run } from './process.mjs';

const mode = process.argv[2] ?? 'check';
const root = resolve(import.meta.dirname, '..');
const artifacts = join(root, '.artifacts', 'coverage');
const threshold = 80;
const goEnv = { GOWORK: 'off' };
const supportedModes = new Set([
  'check',
  'coverage',
  'release',
  'full',
  'fuzz',
]);

if (!supportedModes.has(mode)) {
  throw new Error(`Unknown Go gate mode: ${mode}`);
}

if (!existsSync(join(root, 'go.mod'))) {
  throw new Error('go.mod is required.');
}

run('go', ['mod', 'verify'], { cwd: root, env: goEnv });
run('go', ['mod', 'tidy', '-diff'], { cwd: root, env: goEnv });

function goSources(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (
      ['.artifacts', '.git', 'node_modules', 'third_party'].includes(entry.name)
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...goSources(path));
    if (entry.isFile() && entry.name.endsWith('.go')) found.push(path);
  }
  return found;
}

const sources = goSources(root);
if (sources.length === 0) {
  process.stdout.write(
    `[go:${mode}] module verified; no Go source yet; source checks skipped.\n`,
  );
  process.exit(0);
}

if (mode === 'check' || mode === 'full' || mode === 'fuzz') {
  const formatted = run('gofmt', ['-l', ...sources], {
    capture: true,
  }).stdout.trim();
  if (formatted) {
    const listed = formatted
      .split('\n')
      .map((path) => relative(root, path).split(sep).join('/'))
      .join(', ');
    throw new Error(`gofmt is required: ${listed}`);
  }

  run('go', ['vet', './...'], { cwd: root, env: goEnv });
  run('go', ['tool', 'staticcheck', './...'], { cwd: root, env: goEnv });
}

if (mode === 'fuzz') {
  const packages = run('go', ['list', '-f={{.ImportPath}}', './...'], {
    capture: true,
    cwd: root,
    env: goEnv,
  })
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  let targets = 0;
  for (const packagePath of packages) {
    const listed = run('go', ['test', '-list=^Fuzz', packagePath], {
      capture: true,
      cwd: root,
      env: goEnv,
    }).stdout;
    for (const target of listed
      .split(/\r?\n/)
      .filter((line) => /^Fuzz\w+$/.test(line))) {
      run(
        'go',
        ['test', '-run=^$', `-fuzz=^${target}$`, '-fuzztime=10s', packagePath],
        { cwd: root, env: goEnv },
      );
      targets += 1;
    }
  }
  if (targets === 0) {
    process.stdout.write('[go:fuzz] no fuzz targets found; skipped.\n');
  }
  process.exit(0);
}

if (mode === 'coverage' || mode === 'full') {
  mkdirSync(artifacts, { recursive: true });
  const profile = join(artifacts, 'go.coverprofile');
  run(
    'go',
    ['test', '-covermode=atomic', `-coverprofile=${profile}`, './...'],
    {
      cwd: root,
      env: goEnv,
    },
  );
  const report = run('go', ['tool', 'cover', `-func=${profile}`], {
    capture: true,
    cwd: root,
    env: goEnv,
  }).stdout;
  process.stdout.write(report);
  const match = report.match(/^total:\s+\(statements\)\s+([\d.]+)%$/m);
  if (!match) throw new Error('Could not read total Go coverage.');
  if (Number(match[1]) < threshold) {
    throw new Error(
      `Go statement coverage ${match[1]}% is below ${threshold}%.`,
    );
  }
}

if (mode === 'release' || mode === 'full') {
  run('go', ['test', '-race', './...'], { cwd: root, env: goEnv });
  run('go', ['tool', 'govulncheck', './...'], { cwd: root, env: goEnv });
}
