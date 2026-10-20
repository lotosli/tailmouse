import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildIdentity } from './build-identity.ts';
import { run } from './process.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(
  root,
  process.argv[2] ??
    `.artifacts/native/tailmouse${process.platform === 'win32' ? '.exe' : ''}`,
);
const identity = buildIdentity(
  root,
  process.argv[3] ?? process.env.TAILMOUSE_BUILD_VERSION,
);
mkdirSync(dirname(output), { recursive: true });
run(
  'go',
  [
    'build',
    '-trimpath',
    '-ldflags',
    `-X main.buildVersion=${identity.version} -X main.tailcatRevision=${identity.tailcatRevision}`,
    '-o',
    output,
    './apps/cli/cmd/tailmouse',
  ],
  { cwd: root, env: { GOWORK: 'off', CGO_ENABLED: '0' } },
);
const reported = run(output, ['version'], { cwd: root, capture: true }).stdout;
if (
  !reported.includes(`TailMouse ${identity.version}\n`) ||
  !reported.includes(`Tailcat revision ${identity.tailcatRevision}\n`) ||
  !reported.includes('') ||
  !reported.includes('TMOUSE Leash protocol 2\n') ||
  !reported.includes('TMOUSE Resource protocol 2\n')
) {
  throw new Error('Native build identity verification failed.');
}
process.stdout.write(
  `Native build verified: ${identity.version}, Tailcat ${identity.tailcatRevision}.\n`,
);
