import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { run } from './process.mjs';

const mode = process.argv[2] ?? 'full';
const root = resolve(import.meta.dirname, '..');
const tailcat = join(root, 'third_party', 'tailcat');
const goEnv = { GOWORK: 'off' };
const supportedModes = new Set(['check', 'test', 'build', 'full']);

if (!supportedModes.has(mode)) {
  throw new Error(`Unknown Tailcat gate mode: ${mode}`);
}
if (!existsSync(join(tailcat, 'go.mod'))) {
  throw new Error(
    'Tailcat submodule is not initialized; run git submodule update --init -- third_party/tailcat.',
  );
}

function assertClean() {
  const status = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { capture: true, cwd: tailcat },
  ).stdout.trim();
  if (status) {
    throw new Error(`Tailcat source must remain clean:\n${status}`);
  }
}

assertClean();

if (mode === 'check' || mode === 'full') {
  run('go', ['mod', 'verify'], { cwd: tailcat, env: goEnv });
  run('go', ['mod', 'tidy', '-diff'], { cwd: tailcat, env: goEnv });

  const sources = run('git', ['ls-files', '--', '*.go'], {
    capture: true,
    cwd: tailcat,
  })
    .stdout.trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const formatted = run('gofmt', ['-l', ...sources], {
    capture: true,
    cwd: tailcat,
  }).stdout.trim();
  if (formatted) {
    const listed = formatted
      .split(/\r?\n/)
      .map((path) =>
        relative(tailcat, join(tailcat, path)).split(sep).join('/'),
      )
      .join(', ');
    throw new Error(`Upstream Tailcat source is not gofmt-clean: ${listed}`);
  }
  run('go', ['vet', './...'], { cwd: tailcat, env: goEnv });
}

if (mode === 'test' || mode === 'full') {
  run('go', ['test', '-count=1', '-timeout=600s', './...'], {
    cwd: tailcat,
    env: goEnv,
  });
}

if (mode === 'build' || mode === 'full') {
  run('go', ['build', './...'], { cwd: tailcat, env: goEnv });
  const artifactDirectory = join(root, '.artifacts', 'tailcat');
  mkdirSync(artifactDirectory, { recursive: true });
  run(
    'go',
    ['build', '-o', join(artifactDirectory, 'tailcat-web.wasm'), './web'],
    {
      cwd: tailcat,
      env: { ...goEnv, GOARCH: 'wasm', GOOS: 'js' },
    },
  );
}

assertClean();
process.stdout.write(`[tailcat:${mode}] passed with an unchanged submodule.\n`);
