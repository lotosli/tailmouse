import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { run } from './process.mjs';

// Go derives a main-module version from local tags and history. Give every
// upstream Wasm build the same one-commit, tag-free Git metadata without
// changing the recorded submodule or inventing compiled provenance.
export function cloneTailcatBuildSource(source, destination, revision) {
  assert.ok(isAbsolute(source) && isAbsolute(destination));
  assert.match(revision, /^[a-f0-9]{40}$/u);
  run(
    'git',
    [
      'clone',
      '--quiet',
      '--no-local',
      '--no-tags',
      '--depth=1',
      '--config',
      'core.autocrlf=false',
      '--',
      source,
      destination,
    ],
    { capture: true },
  );
  const actual = run('git', ['rev-parse', 'HEAD'], {
    cwd: destination,
    capture: true,
  }).stdout.trim();
  assert.equal(
    actual,
    revision,
    'Temporary Tailcat checkout differs from its gitlink.',
  );
}
