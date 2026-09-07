import { isDeepStrictEqual } from 'node:util';

// Architecture and release verification both compare deployment input against
// this reviewed boundary. Additional keys are rejected, including nested ones.
export const reviewedEdgeConfig = {
  $schema: './node_modules/wrangler/config-schema.json',
  name: 'tailmouse-link-edge',
  main: 'src/index.ts',
  compatibility_date: '2026-09-07',
  workers_dev: false,
  preview_urls: false,
  send_metrics: false,
  logpush: false,
  observability: { enabled: false },
  limits: { cpu_ms: 50, subrequests: 20 },
  ratelimits: [
    {
      name: 'CREATE_IP',
      namespace_id: '8101',
      simple: { limit: 5, period: 60 },
    },
    {
      name: 'CREATE_EDGE',
      namespace_id: '8102',
      simple: { limit: 100, period: 60 },
    },
    {
      name: 'READ_IP',
      namespace_id: '8103',
      simple: { limit: 60, period: 60 },
    },
    {
      name: 'READ_EDGE',
      namespace_id: '8104',
      simple: { limit: 1000, period: 60 },
    },
  ],
  route: { pattern: 'link.tailmouse.com/*', zone_name: 'tailmouse.com' },
  durable_objects: {
    bindings: [{ name: 'SHORT_INVITATIONS', class_name: 'ShortInvitation' }],
  },
  exports: { ShortInvitation: { type: 'durable-object', storage: 'sqlite' } },
  r2_buckets: [
    { binding: 'STATIC_ASSETS', bucket_name: 'tailmouse-link-production' },
  ],
} as const;

export function assertEdgeConfig(
  value: unknown,
): asserts value is typeof reviewedEdgeConfig {
  if (!isDeepStrictEqual(value, reviewedEdgeConfig)) {
    // Do not reflect unreviewed fields: a rejected input could contain secrets.
    throw new Error(
      'Edge configuration differs from the reviewed deployment boundary.',
    );
  }
}
