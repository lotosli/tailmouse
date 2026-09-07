import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decode } from 'cborg';
import { securityHeaders } from '../../tools/web-assets.ts';
import { lifecycleArguments, verifyLifecycle } from './verify-lifecycle.mjs';

function fixture(fault = '') {
  let now = Date.now();
  let sequence = 0;
  const mappings = new Map();
  const calls = [];
  const phases = [];
  const runtime = {
    now: () => now,
    wait: async (ms) => {
      if (fault !== 'frozen-clock') now += ms;
    },
    phase: (value) => phases.push(value),
    fetch: async (url, init) => {
      assert.equal(new URL(url).origin, 'https://link.tailmouse.com');
      assert.equal(init.redirect, 'error');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.referrerPolicy, 'no-referrer');
      assert.ok(init.signal instanceof AbortSignal);
      calls.push({ url, init, now });
      const headers = { ...securityHeaders, 'cache-control': 'no-store' };
      const json = (value, status = 200) =>
        Response.json(value, { status, headers });
      const code = new URL(url).pathname.split('/').at(-1);
      const entry = mappings.get(code);
      if (init.method === 'POST') {
        if (fault === 'network')
          throw new Error('SYNTHETIC_SECRET_MUST_NOT_ESCAPE');
        if (fault === 'oversized')
          return new Response('X'.repeat(2049), { headers });
        if (fault === 'redirect')
          return new Response(null, { status: 302, headers });
        const request = JSON.parse(init.body);
        assert.deepEqual(Object.keys(request).sort(), ['access', 'invitation']);
        assert.equal(request.access, 'code');
        const card = decode(
          Buffer.from(request.invitation.split('/#/v1/')[1], 'base64url'),
        );
        assert.equal(card.a, 2);
        assert.equal(card.z, 2);
        assert.equal(card.m, 'leash');
        assert.match(card.t, /^SYNTHETIC_/u);
        sequence++;
        const created = {
          code:
            fault === 'numeric-code'
              ? String(123450 + sequence)
              : fault === 'lowercase-code'
                ? `12t0${String(sequence).padStart(2, '0')}`
                : `Test0${sequence}`,
          managementToken: Buffer.alloc(32, sequence).toString('base64url'),
          expiresAt: now + 900_000,
        };
        mappings.set(created.code, {
          ...created,
          invitation: request.invitation,
        });
        if (fault === 'create-cache') headers['cache-control'] = 'public';
        return json(created, 201);
      }
      if (code === 'test01') {
        if (fault === 'wrong-case-active')
          return json({
            invitation: 'SYNTHETIC_OTHER_INVITATION',
            expiresAt: now + 900_000,
          });
        if (fault === 'wrong-case-cache') headers['cache-control'] = 'public';
        if (fault === 'wrong-case-body')
          return json({ error: 'SYNTHETIC_DIAGNOSTIC_MUST_NOT_ESCAPE' }, 404);
      }
      if (!entry || now >= entry.expiresAt) {
        mappings.delete(code);
        return json({ error: 'invitation_unavailable' }, 404);
      }
      if (init.method === 'GET') {
        assert.equal(init.headers.authorization, undefined);
        if (fault === 'resolve-renews') entry.expiresAt = now + 900_000;
        if (fault === 'resolve-security') delete headers['Referrer-Policy'];
        return json({
          invitation: entry.invitation,
          expiresAt: entry.expiresAt,
        });
      }
      assert.equal(
        init.headers.authorization,
        `Bearer ${entry.managementToken}`,
      );
      if (init.method === 'PUT') {
        if (fault !== 'renew-noop') entry.expiresAt = now + 900_000;
        return json({ expiresAt: entry.expiresAt });
      }
      assert.equal(init.method, 'DELETE');
      if (fault === 'delete-unavailable')
        return json({ error: 'service_unavailable' }, 503);
      mappings.delete(code);
      return new Response(null, { status: 204, headers });
    },
  };
  return { runtime, calls, mappings, phases };
}

await test('the lifecycle verifier requires an exact explicit production opt-in', async () => {
  assert.deepEqual(lifecycleArguments(['--production']), {
    production: true,
    abandonedLease: false,
  });
  assert.deepEqual(
    lifecycleArguments(['--', '--production', '--abandoned-lease']),
    { production: true, abandonedLease: true },
  );
  for (const args of [
    [],
    ['https://example.com'],
    ['--abandoned-lease'],
    ['--production', '--other'],
    ['--production', '--abandoned-lease', 'extra'],
  ])
    assert.throws(
      () => lifecycleArguments(args),
      /explicit_production_flag_required/u,
    );
  const local = fixture();
  await assert.rejects(
    verifyLifecycle({}, local.runtime),
    /explicit_production_flag_required/u,
  );
  await assert.rejects(
    verifyLifecycle(
      { production: true, abandonedLease: 'true' },
      local.runtime,
    ),
    /invalid_option/u,
  );
  assert.equal(local.calls.length, 0);
});

await test('a synthetic lifecycle resolves without renewal, extends, deletes and redacts evidence', async () => {
  const local = fixture();
  const evidence = await verifyLifecycle({ production: true }, local.runtime);
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.createdMappings, 1);
  assert.equal(evidence.requestCount, 8);
  assert.equal(evidence.cleanup, 'verified');
  assert.equal(local.mappings.size, 0);
  assert.equal(local.calls[1].init.method, 'GET');
  assert.ok(local.calls[1].url.endsWith('/test01'));
  assert.equal(local.calls[1].init.headers.authorization, undefined);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /Test01|SYNTHETIC_|https:|managementToken|invitation/u,
  );
});

await test('the wrong-case probe changes only the first ASCII letter after a numeric prefix', async () => {
  const local = fixture('lowercase-code');
  const evidence = await verifyLifecycle({ production: true }, local.runtime);
  assert.equal(evidence.status, 'verified');
  assert.ok(local.calls[1].url.endsWith('/12T001'));
  assert.equal(evidence.createAttempts, 1);
  assert.equal(local.mappings.size, 0);
});

await test('an abandoned probe leaves a metadata-only window and proves only API expiry', async () => {
  const local = fixture();
  const evidence = await verifyLifecycle(
    { production: true, abandonedLease: true },
    local.runtime,
  );
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.createdMappings, 2);
  assert.equal(evidence.requestCount, 11);
  assert.equal(evidence.abandonedLease, 'api-expiry-verified');
  assert.equal(evidence.alarmStorageDeletion, 'not-independently-verified');
  assert.equal(local.mappings.size, 0);
  assert.equal(local.phases.length, 1);
  assert.deepEqual(Object.keys(local.phases[0]), [
    'phase',
    'expiresAt',
    'observationAt',
  ]);
  assert.equal(
    local.phases[0].observationAt - local.phases[0].expiresAt,
    180_000,
  );
  const reads = local.calls.filter(({ url }) => url.endsWith('/Test02'));
  assert.deepEqual(
    reads.map(({ init }) => init.method),
    ['GET', 'DELETE'],
  );
  assert.ok(reads.every(({ now }) => now >= local.phases[0].observationAt));
  assert.ok(evidence.durationMs < 20 * 60_000);
});

for (const [fault, classification, cleanup] of [
  ['network', 'request_or_cancellation_failure', 'unconfirmed_creation'],
  ['oversized', 'response_too_large', 'unconfirmed_creation'],
  ['redirect', 'invalid_creation_response', 'unconfirmed_creation'],
  ['create-cache', 'unsafe_cache_policy', 'verified'],
  ['numeric-code', 'case_probe_unavailable', 'verified'],
  ['wrong-case-active', 'case_probe_inconclusive', 'verified'],
  ['wrong-case-cache', 'unsafe_cache_policy', 'verified'],
  ['wrong-case-body', 'nongeneric_unavailable_response', 'verified'],
  ['resolve-security', 'security_header_mismatch', 'verified'],
  ['resolve-renews', 'resolution_or_nonrenewing_read_mismatch', 'verified'],
  ['renew-noop', 'renewal_did_not_extend_lease', 'verified'],
  ['delete-unavailable', 'unexpected_status', 'unconfirmed_deletion'],
  ['frozen-clock', 'renewal_did_not_extend_lease', 'verified'],
])
  await test(`lifecycle failure ${fault} is bounded, redacted and attempts known cleanup`, async () => {
    const local = fixture(fault);
    const evidence = await verifyLifecycle({ production: true }, local.runtime);
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.classification, classification);
    assert.equal(evidence.cleanup, cleanup);
    if (cleanup === 'verified') assert.equal(local.mappings.size, 0);
    assert.ok(
      local.calls.filter(({ init }) => init.method === 'POST').length <= 1,
    );
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /Test01|SYNTHETIC_|https:|managementToken/u,
    );
  });

await test('a stalled response cannot extend the ten-second request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const local = fixture();
  local.runtime.fetch = async () => new Promise(() => {});
  const pending = verifyLifecycle({ production: true }, local.runtime);
  t.mock.timers.tick(10_000);
  const evidence = await pending;
  assert.equal(evidence.classification, 'request_deadline_exceeded');
  assert.equal(evidence.cleanup, 'unconfirmed_creation');
});

await test('cancellation performs no new allocation and still deletes known mappings', async () => {
  const early = fixture();
  const cancelled = await verifyLifecycle(
    { production: true, signal: AbortSignal.abort() },
    early.runtime,
  );
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.requestCount, 0);
  assert.equal(cancelled.cleanup, 'verified');
  const local = fixture();
  const controller = new AbortController();
  local.runtime.wait = async () => {
    controller.abort();
    throw new Error('SYNTHETIC_CANCELLATION_SECRET');
  };
  const interrupted = await verifyLifecycle(
    { production: true, signal: controller.signal },
    local.runtime,
  );
  assert.equal(interrupted.classification, 'request_or_cancellation_failure');
  assert.equal(interrupted.cleanup, 'verified');
  assert.equal(local.mappings.size, 0);
  assert.equal(local.calls.at(-1).init.method, 'DELETE');
  assert.doesNotMatch(JSON.stringify(interrupted), /SYNTHETIC_|Test01/u);
});

await test('the abandoned observation has a finite poll bound even if the clock stops', async () => {
  const local = fixture();
  local.runtime.phase = () => {
    local.runtime.wait = async () => {};
  };
  const evidence = await verifyLifecycle(
    { production: true, abandonedLease: true },
    local.runtime,
  );
  assert.equal(evidence.classification, 'lease_wait_deadline_exceeded');
  assert.equal(evidence.createdMappings, 2);
  assert.equal(evidence.cleanup, 'verified');
  assert.equal(local.mappings.size, 0);
});
