import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

function releaseGate(t: TestContext, target: string, failRace = false) {
  const fixture = mkdtempSync(join(tmpdir(), 'tailmouse-go-gate-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'tools'));
  writeFileSync(join(fixture, 'go.mod'), 'module gatefixture\n');
  writeFileSync(join(fixture, 'main.go'), 'package gatefixture\n');
  copyFileSync(
    new URL('./go-gate.mjs', import.meta.url),
    join(fixture, 'tools/go-gate.mjs'),
  );
  writeFileSync(
    join(fixture, 'tools/process.mjs'),
    `
      import { appendFileSync } from 'node:fs';
      export function run(command, args) {
        appendFileSync(${JSON.stringify(join(fixture, 'commands.jsonl'))}, JSON.stringify([command, ...args]) + '\\n');
        if (args[0] === 'env') return { stdout: ${JSON.stringify(target)} };
        if (${JSON.stringify(failRace)} && args.includes('-race')) throw new Error('Synthetic race check failure');
        return { stdout: '' };
      }
    `,
  );
  const result = spawnSync(
    process.execPath,
    [join(fixture, 'tools/go-gate.mjs'), 'release'],
    {
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
  if (result.error) throw result.error;
  const commands: string[][] = readFileSync(
    join(fixture, 'commands.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line) as string[]);
  return { result, commands };
}

test('release gate runs race checks for every supported release target', (t) => {
  for (const target of [
    'darwin\namd64',
    'darwin\narm64',
    'linux\namd64',
    'linux\narm64',
    'windows\namd64',
  ]) {
    const { result, commands } = releaseGate(t, target);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(commands.slice(-2), [
      ['go', 'test', '-race', './...'],
      ['go', 'tool', 'govulncheck', './...'],
    ]);
    assert.doesNotMatch(result.stdout, /skipped/);
  }
});

test('only Windows ARM64 reports its unsupported race detector and still checks vulnerabilities', (t) => {
  for (const target of ['windows\narm64\n', 'windows\r\narm64\r\n']) {
    const { result, commands } = releaseGate(t, target);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /Go 1\.27\.1 does not support the race detector on windows\/arm64/,
    );
    assert.equal(
      commands.some((command) => command.includes('-race')),
      false,
    );
    assert.deepEqual(commands.at(-1), ['go', 'tool', 'govulncheck', './...']);
  }
});

test('race failures and invalid target output stop before vulnerability checks', (t) => {
  for (const target of [
    '',
    'windows',
    'windows\narm64\nextra',
    'windows\narm 64',
    'darwin\narm64',
  ]) {
    const { result, commands } = releaseGate(t, target, true);
    assert.notEqual(result.status, 0);
    assert.equal(
      commands.some((command) => command.includes('govulncheck')),
      false,
    );
    assert.doesNotMatch(result.stdout, /skipped/);
  }
});

test('CI keeps the complete fail-fast matrix ahead of packaging and fuzzing', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gate.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /strategy:\n      fail-fast: true/u);
  assert.match(
    workflow,
    /os: \[ubuntu-latest, macos-latest, windows-latest, windows-11-arm\]/u,
  );
  assert.equal(workflow.match(/submodules: true/gu)?.length, 2);
  assert.equal(workflow.match(/persist-credentials: false/gu)?.length, 2);
  assert.equal(workflow.match(/pnpm install --frozen-lockfile/gu)?.length, 2);
  assert.doesNotMatch(workflow, /continue-on-error:/u);

  const fuzzBoundary = '\n  fuzz:\n';
  assert.equal(workflow.split(fuzzBoundary).length, 2);
  const [matrixJob, fuzzJob] = workflow.split(fuzzBoundary);
  const requiredMatrixOrder = [
    'run: pnpm gate',
    'name: Install verified release tools',
    'run: pnpm release:snapshot',
    'run: pnpm release:sbom',
    'pnpm release:verify',
    'sha256sum --check --strict checksums.txt',
    'name: Check source and submodule cleanliness',
  ];
  let preceding = -1;
  for (const step of requiredMatrixOrder) {
    const index = matrixJob.indexOf(step);
    assert.ok(index > preceding, `${step} is missing or out of order`);
    preceding = index;
  }
  assert.match(fuzzJob, /^    name: Go fuzz smoke\n    needs: gate/mu);
  assert.match(fuzzJob, /run: pnpm fuzz:smoke/u);

  const gate = readFileSync(new URL('./gate.mjs', import.meta.url), 'utf8');
  for (const phase of [
    'hermetic transport integration',
    'Unix Leash native/browser acceptance',
    'Escape impairment smoke',
    'browser end-to-end tests',
    'Firefox and WebKit real transport acceptance',
    'Go race and vulnerability checks',
    'Escape complete network matrix and outages',
    'Unix Leash complete network matrix',
  ]) {
    assert.match(gate, new RegExp(`'${phase.replace('/', '\\/')}'`, 'u'));
  }
  assert.match(gate, /tools\/release-licenses\.mjs', 'check'/u);
});

test('root build prepares Tailcat artifacts before Native and Web builds', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts?: { build?: string } };
  assert.equal(
    packageJson.scripts?.build,
    'node tools/tailcat-gate.mjs build && node tools/build-native.mjs && pnpm --recursive --if-present run build',
  );
});
