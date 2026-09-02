import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPnpm } from './process.mjs';

const task = process.argv[2];
const root = resolve(import.meta.dirname, '..');
const webRoot = join(root, 'apps', 'web');
const srcRoot = join(webRoot, 'src');
const supportedTasks = new Set(['build', 'coverage', 'e2e']);

if (!supportedTasks.has(task)) {
  throw new Error(`Unknown web task: ${task}`);
}

function hasSource(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && hasSource(path)) return true;
    if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:d|test|spec)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      return true;
    }
  }
  return false;
}

if (!hasSource(srcRoot)) {
  process.stdout.write(
    `[web:${task}] no coverable source files found; skipped.\n`,
  );
  process.exit(0);
}

if (task === 'coverage') {
  runPnpm(['exec', 'vitest', 'run', '--coverage'], { cwd: webRoot });
} else if (task === 'build') {
  if (!existsSync(join(webRoot, 'index.html'))) {
    throw new Error('apps/web/index.html is required once web source exists.');
  }
  runPnpm(['exec', 'vite', 'build'], { cwd: webRoot });
} else if (task === 'e2e') {
  if (!existsSync(join(webRoot, 'dist', 'index.html'))) {
    throw new Error('Build apps/web before running browser end-to-end tests.');
  }
  runPnpm(
    [
      'exec',
      'playwright',
      'test',
      '--config',
      join(webRoot, 'playwright.config.ts'),
    ],
    { cwd: root },
  );
}
