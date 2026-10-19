import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './process.mjs';

const gate = resolve(import.meta.dirname, 'gate.mjs');
// Cloud snapshots can run tail as PID 1. It never reaps the orphaned process
// groups deliberately exercised by cleanup acceptance. Keep those assertions
// intact and provide the init behavior a normal OS supplies.
if (
  process.platform === 'linux' &&
  readFileSync('/proc/1/comm', 'utf8').trim() === 'tail'
) {
  run('python3', [
    resolve(import.meta.dirname, 'test-subinit.py'),
    process.execPath,
    gate,
    ...process.argv.slice(2),
  ]);
} else run(process.execPath, [gate, ...process.argv.slice(2)]);
