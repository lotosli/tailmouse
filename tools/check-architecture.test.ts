import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assertEdgeConfig, reviewedEdgeConfig } from './link-edge-config.ts';

function leafPaths(value: unknown, path: string[] = []): string[][] {
  if (typeof value !== 'object' || value === null) return [path];
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, [...path, key]),
  );
}

function objectAt(value: unknown, path: string[]): Record<string, unknown> {
  let object = value;
  for (const key of path) {
    assert.ok(typeof object === 'object' && object !== null);
    object = (object as Record<string, unknown>)[key];
  }
  assert.ok(typeof object === 'object' && object !== null);
  return object as Record<string, unknown>;
}

await test('the checked-in edge config exactly matches its reviewed deployment boundary', () => {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL('../apps/link-edge/wrangler.jsonc', import.meta.url),
      'utf8',
    ),
  );
  assert.doesNotThrow(() => assertEdgeConfig(value));
  assert.doesNotThrow(() =>
    assertEdgeConfig(structuredClone(reviewedEdgeConfig)),
  );
});

await test('every missing or changed edge config field fails closed without echoing input', () => {
  const paths = leafPaths(reviewedEdgeConfig);
  assert.ok(
    paths.length >= 30,
    'The fixture must cover nested bindings and all four rate limits.',
  );
  for (const path of paths) {
    for (const remove of [false, true]) {
      const value = structuredClone(reviewedEdgeConfig);
      const container = objectAt(value, path.slice(0, -1));
      const key = path.at(-1)!;
      if (remove) delete container[key];
      else container[key] = 'synthetic-unreviewed-private-value';
      assert.throws(
        () => assertEdgeConfig(value),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            'Edge configuration differs from the reviewed deployment boundary.',
          );
          return true;
        },
        `${path.join('.')} was not enforced`,
      );
    }
  }
});

await test('extra deployments, storage, logging and binding overrides are rejected', () => {
  for (const [path, key, extra] of [
    [[], 'kv_namespaces', []],
    [[], 'd1_databases', []],
    [[], 'queues', {}],
    [[], 'services', []],
    [[], 'env', { preview: { workers_dev: true } }],
    [[], 'vars', { PRIVATE_VALUE: 'synthetic-private-value' }],
    [[], 'tail_consumers', [{ service: 'unreviewed-logs' }]],
    [[], 'routes', ['unreviewed.example/*']],
    [[], 'migrations', [{ tag: 'unreviewed' }]],
    [['observability'], 'logs', { enabled: true }],
    [['observability'], 'traces', { enabled: true }],
    [['durable_objects', 'bindings', '0'], 'script_name', 'unreviewed-worker'],
    [['exports'], 'OtherObject', { type: 'durable-object', storage: 'sqlite' }],
    [['r2_buckets', '0'], 'jurisdiction', 'unreviewed'],
    [['route'], 'custom_domain', true],
    [['limits'], 'unknown_bound', 0],
  ] as const) {
    const value = structuredClone(reviewedEdgeConfig);
    objectAt(value, [...path])[key] = extra;
    assert.throws(
      () => assertEdgeConfig(value),
      /reviewed deployment boundary/u,
    );
  }
  for (const value of [null, [], 'invalid', {}, undefined]) {
    assert.throws(
      () => assertEdgeConfig(value),
      /reviewed deployment boundary/u,
    );
  }
});

await test('duplicate or missing rate-limit bindings cannot preserve a partial configuration', () => {
  for (const change of ['missing', 'duplicate', 'extra']) {
    const value = structuredClone(reviewedEdgeConfig);
    const root = objectAt(value, []);
    const limits = [...value.ratelimits];
    if (change === 'missing') limits.pop();
    else if (change === 'duplicate') limits[3] = limits[0]!;
    else limits.push(limits[0]!);
    root.ratelimits = limits;
    assert.throws(
      () => assertEdgeConfig(value),
      /reviewed deployment boundary/u,
    );
  }
});
