import { resolve } from 'node:path';
import { run } from './process.mjs';

const root = resolve(import.meta.dirname, '..');
// Keep the test's 120-second bound and allow bounded runtime teardown.
// A leaked fixture must fail the gate, not leave CI running indefinitely.
run(
  process.execPath,
  ['--test', '--test-reporter=tap', 'deploy/resource/integration.test.mjs'],
  { cwd: root, timeout: 150000 },
);
