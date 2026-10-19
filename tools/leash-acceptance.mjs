import { run, runPnpm } from './process.mjs';

let args = process.argv.slice(2);
if (args[0] === '--') args = args.slice(1);
if (
  args.length > 1 ||
  (args.length === 1 &&
    !['--network-matrix', '--official', '--ai-cli', '--chrome'].includes(
      args[0],
    ))
) {
  throw new Error(
    'Usage: node tools/leash-acceptance.mjs [--network-matrix|--official|--ai-cli|--chrome]',
  );
}
const networkMatrix = args[0] === '--network-matrix';
const official = args[0] === '--official';
const aiCLI = args[0] === '--ai-cli';
const chrome = args[0] === '--chrome';

if (!['darwin', 'linux'].includes(process.platform)) {
  throw new Error(
    'This acceptance requires a Unix PTY; it does not validate Windows ConPTY.',
  );
}
if ((official || chrome) && process.platform !== 'darwin') {
  throw new Error('Official phase-two Leash acceptance requires macOS.');
}

run(process.execPath, ['tools/tailcat-gate.mjs', 'build']);
runPnpm(['--filter', '@tailmouse/web', 'build']);
run('go', [
  'test',
  '-tags=tailcatintegration',
  '-count=1',
  '-failfast',
  ...(official || aiCLI || chrome ? ['-v'] : []),
  networkMatrix
    ? '-timeout=10m'
    : official || chrome
      ? '-timeout=4m'
      : aiCLI
        ? '-timeout=2m'
        : '-timeout=6m',
  networkMatrix
    ? '-run=^TestHermeticLeashNetworkMatrix$'
    : official
      ? '-run=^TestOfficialLeashBrowser$'
      : chrome
        ? '-run=^TestOfficialChromeLeashBrowser$'
        : aiCLI
          ? '-run=^TestHermeticLeashAI$'
          : '-run=^TestHermeticLeash(Browser|Network)$',
  './apps/cli/cmd/tailmouse',
]);
