import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('./cross-version-acceptance.mjs', import.meta.url),
  'utf8',
);

test('cross-version acceptance fixes the phase-one baseline and both mismatch directions', () => {
  assert.match(source, /5a5b620aff7d60ead7dae52c001f8b6bafab9c3d/u);
  assert.match(source, /4a25a91e0337252a4d16e097b03cf3cbb92c20cd/u);
  assert.match(source, /790406204c002a6f109ef7c6a30a436601a1f6a8/u);
  assert.match(source, /old-browser\/new-Host/u);
  assert.match(source, /new-browser\/old-Host/u);
  assert.match(source, /protocol: 2/u);
  assert.match(source, /protocol: 1/u);
});

test('cross-version acceptance proves rejection before transport, disclosure and startup', () => {
  assert.match(
    source,
    /requests\.some\(\(path\) => path\.endsWith\('\.wasm'\)\)/u,
  );
  assert.match(source, /innerText\(\)\)\.includes\(privateTitle\)/u);
  assert.match(source, /await stat\(startedPath\)/u);
  assert.match(source, /rejected-before-wasm-dial-disclosure-startup/u);
  assert.match(source, /serviceWorkers: 'block'/u);
});

test('cross-version acceptance keeps invitation-bearing process output bounded and private', () => {
  assert.match(source, /stdout\.length > 32_768/u);
  assert.match(source, /stderr\.length > 32_768/u);
  assert.match(source, /invitation = ''/u);
  assert.doesNotMatch(source, /console\.(?:log|error)/u);
  assert.match(source, /legacy: publicIdentity\(legacy\)/u);
  assert.match(source, /current: publicIdentity\(current\)/u);
});
