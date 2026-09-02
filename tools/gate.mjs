import { run, runPnpm } from './process.mjs';

const quick = process.argv.includes('--quick');

const phases = [
  [
    'architecture',
    () => run(process.execPath, ['tools/check-architecture.mjs']),
  ],
  [
    'OpenSpec',
    () => {
      runPnpm([
        'exec',
        'openspec',
        'validate',
        '--all',
        '--strict',
        '--no-interactive',
      ]);
      runPnpm(['exec', 'openspec', 'schema', 'validate', 'tailmouse-sdd']);
    },
  ],
  [
    'format',
    () => runPnpm(['exec', 'prettier', '--check', '.', '--ignore-unknown']),
  ],
  ['lint', () => runPnpm(['run', 'lint'])],
  [
    'typecheck',
    () => runPnpm(['--recursive', '--if-present', 'run', 'typecheck']),
  ],
  [
    'Go static checks',
    () => run(process.execPath, ['tools/go-gate.mjs', 'check']),
  ],
  [
    'Tailcat static checks',
    () => run(process.execPath, ['tools/tailcat-gate.mjs', 'check']),
  ],
  ['unit tests', () => runPnpm(['--recursive', '--if-present', 'run', 'test'])],
  [
    'Tailcat tests',
    () => run(process.execPath, ['tools/tailcat-gate.mjs', 'test']),
  ],
  [
    'web coverage',
    () => runPnpm(['--recursive', '--if-present', 'run', 'coverage']),
  ],
  [
    'Go coverage',
    () => run(process.execPath, ['tools/go-gate.mjs', 'coverage']),
  ],
  [
    'Tailcat native and WebAssembly builds',
    () => run(process.execPath, ['tools/tailcat-gate.mjs', 'build']),
  ],
  ['build', () => runPnpm(['--recursive', '--if-present', 'run', 'build'])],
  ['browser end-to-end tests', () => runPnpm(['run', 'e2e'])],
  ...(!quick
    ? [
        [
          'Go race and vulnerability checks',
          () => run(process.execPath, ['tools/go-gate.mjs', 'release']),
        ],
      ]
    : []),
];

for (const [name, execute] of phases) {
  process.stdout.write(`\n==> ${String(name)}\n`);
  execute();
}

process.stdout.write(`\nGate passed (${quick ? 'quick' : 'full'}).\n`);
