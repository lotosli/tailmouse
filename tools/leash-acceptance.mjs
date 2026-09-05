import { run, runPnpm } from './process.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--network-matrix')) {
  throw new Error('Usage: node tools/leash-acceptance.mjs [--network-matrix]');
}
const networkMatrix = args[0] === '--network-matrix';

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error(
    'This acceptance requires a Unix PTY; it does not validate Windows ConPTY.',
  );
}

run(process.execPath, ['tools/tailcat-gate.mjs', 'build']);
runPnpm(['--filter', '@tailmouse/web', 'build']);
run('go', [
  'test',
  '-tags=tailcatintegration',
  '-count=1',
  '-failfast',
  networkMatrix ? '-timeout=3h' : '-timeout=4m',
  networkMatrix
    ? '-run=^TestHermeticLeashNetworkMatrix$'
    : '-run=^TestHermeticLeash(Browser|Network)$',
  './apps/cli/cmd/tailmouse',
]);
