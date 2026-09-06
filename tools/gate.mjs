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
    'build identity, release and static asset tests',
    () =>
      run(process.execPath, [
        '--test',
        'tools/m0-acceptance.test.ts',
        'tools/go-gate.test.ts',
        'tools/leash-acceptance.test.ts',
        'tools/cross-version-acceptance.test.ts',
        'tools/build-identity.test.ts',
        'tools/release-native.test.ts',
        'tools/release-licenses.test.ts',
        'tools/web-assets.test.ts',
        'tools/web-dependencies.test.ts',
        'tools/sbom.test.ts',
      ]),
  ],
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
  ['build', () => runPnpm(['run', 'build'])],
  [
    'local public-origin verification',
    () =>
      run(process.execPath, ['--test', 'tools/verify-public-origin.test.ts']),
  ],
  [
    'dependency notices',
    () => run(process.execPath, ['tools/release-licenses.mjs', 'check']),
  ],
  [
    'native browser QR decoding',
    () => {
      if (process.platform !== 'darwin') {
        process.stdout.write(
          'Native BarcodeDetector acceptance is macOS-only; portable QR format and boundary tests remain required.\n',
        );
        return;
      }
      run('go', [
        'test',
        '-tags=tailcatintegration',
        '-count=1',
        '-failfast',
        '-timeout=45s',
        '-run=^TestQRBrowserDecode$',
        './apps/cli/internal/invitation',
      ]);
    },
  ],
  ['hermetic transport integration', () => runPnpm(['run', 'test:transport'])],
  [
    'Unix Leash native/browser acceptance',
    () => {
      if (process.platform === 'win32') {
        process.stdout.write(
          'Unix PTY acceptance is not applicable on Windows; ConPTY runtime acceptance is separately deferred / not verified.\n',
        );
        return;
      }
      runPnpm(['run', 'test:leash']);
    },
  ],
  [
    'Escape impairment smoke',
    () =>
      run('go', [
        'test',
        '-tags=tailcatintegration',
        '-count=1',
        '-failfast',
        '-timeout=2m',
        '-run=TestImpairment|TestEscapeNetworkRelayDisconnect|TestEscapeNetworkMatrix/rtt150-jitter30-loss0-kbit256$',
        './apps/cli/internal/transport/tailcat',
      ]),
  ],
  ['browser end-to-end tests', () => runPnpm(['run', 'e2e'])],
  ...(!quick
    ? [
        [
          'Firefox and WebKit real transport acceptance',
          () =>
            run('go', [
              'test',
              '-tags=tailcatintegration',
              '-count=1',
              '-failfast',
              '-timeout=4m',
              '-run=^TestHermeticTailcatBrowserEngines$',
              './apps/cli/internal/transport/tailcat',
            ]),
        ],
        [
          'Go race and vulnerability checks',
          () => run(process.execPath, ['tools/go-gate.mjs', 'release']),
        ],
        [
          'Escape complete network matrix and outages',
          () => runPnpm(['run', 'test:escape-network']),
        ],
        [
          'Unix Leash complete network matrix',
          () => {
            if (process.platform === 'win32') {
              process.stdout.write(
                'Unix PTY impairment acceptance is not applicable on Windows; ConPTY runtime acceptance is separately deferred / not verified.\n',
              );
              return;
            }
            runPnpm(['run', 'test:leash-network']);
          },
        ],
      ]
    : []),
];

for (const [name, execute] of phases) {
  process.stdout.write(`\n==> ${String(name)}\n`);
  execute();
}

process.stdout.write(`\nGate passed (${quick ? 'quick' : 'full'}).\n`);
