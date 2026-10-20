import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installRecipes } from './install-recipes.mjs';

await test('package-manager recipes pin all six published target digests', () => {
  const files = ['darwin', 'linux', 'windows'].flatMap((os) =>
    ['amd64', 'arm64'].map((arch) => ({
      name: `tailmouse_1.2.3_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`,
      sha256: (os === 'windows' ? 'b' : 'a').repeat(64),
    })),
  );
  const result = installRecipes({ version: '1.2.3', tag: 'v1.2.3', files });
  assert.match(result.formula, /version "1\.2\.3"/u);
  assert.equal((result.formula.match(/sha256 "a{64}"/gu) ?? []).length, 4);
  assert.equal(result.bucket.architecture['64bit'].hash, 'b'.repeat(64));
  assert.match(result.bucket.architecture.arm64.url, /windows_arm64\.zip$/u);
  assert.throws(() => installRecipes({ version: '../', tag: 'v../', files }));
  assert.throws(() =>
    installRecipes({ version: '1.2.3', tag: 'v1.2.3', files: [] }),
  );
});
