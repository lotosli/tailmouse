import { setTimeout as delay } from 'node:timers/promises';
import { encode } from 'cborg';
import { securityHeaders } from '../../tools/web-assets.ts';

const origin = 'https://link.tailmouse.com';
const endpoint = `${origin}/api/v1/short-invitations`;
const leaseMs = 15 * 60_000;
const requestMs = 10_000;
const maximumWaitMs = 20 * 60_000;

class VerificationFailure extends Error {}

function requireCondition(condition, classification) {
  if (!condition) throw new VerificationFailure(classification);
}

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function lifecycleArguments(args) {
  const values = args[0] === '--' ? args.slice(1) : args;
  requireCondition(
    values[0] === '--production' &&
      (values.length === 1 ||
        (values.length === 2 && values[1] === '--abandoned-lease')),
    'explicit_production_flag_required',
  );
  return { production: true, abandonedLease: values.length === 2 };
}

// The second consumer is the real local Worker integration test. It supplies
// its in-process fetch, while focused failure tests also control time.
export async function verifyLifecycle(
  options = {},
  runtime = { fetch: globalThis.fetch, now: Date.now, wait: delay },
) {
  requireCondition(
    options.production === true,
    'explicit_production_flag_required',
  );
  requireCondition(
    options.abandonedLease === undefined ||
      typeof options.abandonedLease === 'boolean',
    'invalid_option',
  );
  const started = runtime.now();
  const overall = AbortSignal.timeout(maximumWaitMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, overall])
    : overall;
  const records = [];
  let requests = 0;
  let createAttempts = 0;
  let failure;
  let cleanup = 'verified';
  const invitation = `${origin}/#/v1/${Buffer.from(
    encode({
      a: 2,
      e: 0,
      m: 'leash',
      p: 44321,
      s: new Uint8Array(16).fill(0x53),
      t: 'SYNTHETIC_RELEASE_VERIFICATION_NO_TAILCAT_HOST',
      v: 1,
      z: 2,
    }),
  ).toString('base64url')}`;

  async function request(method, record, cleanupOnly = false) {
    if (!cleanupOnly) signal.throwIfAborted();
    const controller = new AbortController();
    const requestSignal = cleanupOnly
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
    let reader;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new VerificationFailure('request_deadline_exceeded'));
      }, requestMs);
    });
    requests++;
    const operation = async () => {
      const response = await runtime.fetch(
        record ? `${endpoint}/${record.code}` : endpoint,
        {
          method,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          signal: requestSignal,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            ...(method === 'POST'
              ? { 'content-type': 'application/json' }
              : {}),
            ...(['PUT', 'DELETE'].includes(method)
              ? { authorization: `Bearer ${record.managementToken}` }
              : {}),
          },
          ...(method === 'POST'
            ? { body: JSON.stringify({ invitation, access: 'code' }) }
            : {}),
        },
      );
      requireCondition(
        !response.redirected &&
          (!response.url || new URL(response.url).origin === origin),
        'redirect_forbidden',
      );
      const length = response.headers.get('content-length');
      requireCondition(
        length === null || (/^\d+$/u.test(length) && Number(length) <= 2048),
        'response_too_large',
      );
      reader = response.body?.getReader();
      const bytes = new Uint8Array(2048);
      let used = 0;
      try {
        while (reader) {
          const part = await reader.read();
          if (part.done) break;
          requireCondition(
            used + part.value.byteLength <= bytes.length,
            'response_too_large',
          );
          bytes.set(part.value, used);
          used += part.value.byteLength;
        }
        const value =
          used === 0
            ? null
            : JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(
                  bytes.subarray(0, used),
                ),
              );
        return {
          status: response.status,
          headers: response.headers,
          value,
          bytes: used,
        };
      } finally {
        bytes.fill(0);
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Cleanup cannot extend the ten-second request deadline.
      if (reader) void reader.cancel().catch(() => {});
    }
  }

  function contract(response, status) {
    requireCondition(response.status === status, 'unexpected_status');
    requireCondition(
      response.headers.get('cache-control') === 'no-store',
      'unsafe_cache_policy',
    );
    for (const [name, value] of Object.entries(securityHeaders))
      requireCondition(
        response.headers.get(name) === value,
        'security_header_mismatch',
      );
    requireCondition(
      status === 204 ||
        response.headers.get('content-type') === 'application/json',
      'invalid_content_type',
    );
    requireCondition(
      status !== 204 || response.bytes === 0,
      'nonempty_delete_response',
    );
  }

  function lease(value, before) {
    requireCondition(
      Number.isSafeInteger(value) &&
        value >= before + leaseMs - requestMs &&
        value <= runtime.now() + leaseMs + requestMs,
      'invalid_lease',
    );
  }

  async function publish() {
    signal.throwIfAborted();
    requireCondition(createAttempts < 2, 'allocation_bound_exceeded');
    createAttempts++;
    const before = runtime.now();
    const response = await request('POST');
    const value = response.value;
    requireCondition(
      response.status === 201 &&
        exact(value, ['code', 'managementToken', 'expiresAt']) &&
        typeof value.code === 'string' &&
        /^[0-9A-Za-z]{6}$/u.test(value.code) &&
        typeof value.managementToken === 'string' &&
        /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value.managementToken),
      'invalid_creation_response',
    );
    // Preserve a usable deletion capability before rejecting headers/expiry.
    const record = { ...value, deleted: false };
    records.push(record);
    contract(response, 201);
    lease(record.expiresAt, before);
    return record;
  }

  async function resolve(record) {
    const response = await request('GET', record);
    contract(response, 200);
    requireCondition(
      exact(response.value, ['invitation', 'expiresAt']) &&
        response.value.invitation === invitation &&
        response.value.expiresAt === record.expiresAt,
      'resolution_or_nonrenewing_read_mismatch',
    );
  }

  async function unavailable(record, classification = 'unexpected_status') {
    const response = await request('GET', record);
    requireCondition(response.status === 404, classification);
    contract(response, 404);
    requireCondition(
      exact(response.value, ['error']) &&
        response.value.error === 'invitation_unavailable',
      'nongeneric_unavailable_response',
    );
  }

  const pause = (ms) => runtime.wait(ms, undefined, { signal });
  try {
    const active = await publish();
    const wrongCase = active.code.replace(/[A-Za-z]/u, (letter) =>
      letter === letter.toUpperCase()
        ? letter.toLowerCase()
        : letter.toUpperCase(),
    );
    requireCondition(wrongCase !== active.code, 'case_probe_unavailable');
    // Another exact-case locator can be independently allocated. A non-404
    // result is inconclusive, never a diagnosis of case-insensitive routing.
    await unavailable({ code: wrongCase }, 'case_probe_inconclusive');
    await resolve(active);
    await pause(100);
    await resolve(active);
    const beforeRenewal = runtime.now();
    const renewed = await request('PUT', active);
    contract(renewed, 200);
    requireCondition(
      exact(renewed.value, ['expiresAt']) &&
        renewed.value.expiresAt > active.expiresAt,
      'renewal_did_not_extend_lease',
    );
    lease(renewed.value.expiresAt, beforeRenewal);
    active.expiresAt = renewed.value.expiresAt;
    await resolve(active);
    contract(await request('DELETE', active), 204);
    active.deleted = true;
    await unavailable(active);

    if (options.abandonedLease) {
      const abandoned = await publish();
      const observationAt = abandoned.expiresAt + 180_000;
      runtime.phase?.({
        phase: 'abandoned-lease-wait',
        expiresAt: abandoned.expiresAt,
        observationAt,
      });
      // No resolve/renew/delete traffic reaches this mapping during its lease.
      // The additional three minutes permit metadata-only alarm observation
      // before the public GET can trigger request-time deletion.
      for (let tick = 0; runtime.now() < observationAt; tick++) {
        requireCondition(
          tick < 40 && runtime.now() - started < maximumWaitMs,
          'lease_wait_deadline_exceeded',
        );
        await pause(Math.min(30_000, observationAt - runtime.now()));
      }
      await unavailable(abandoned);
    }
  } catch (error) {
    failure =
      error instanceof VerificationFailure
        ? error.message
        : 'request_or_cancellation_failure';
  } finally {
    if (records.length !== createAttempts) cleanup = 'unconfirmed_creation';
    for (const record of records) {
      if (record.deleted) continue;
      try {
        const response = await request('DELETE', record, true);
        contract(response, response.status === 404 ? 404 : 204);
        if (response.status === 404)
          requireCondition(
            exact(response.value, ['error']) &&
              response.value.error === 'invitation_unavailable',
            'nongeneric_unavailable_response',
          );
        record.deleted = true;
      } catch {
        cleanup = 'unconfirmed_deletion';
      }
      record.managementToken = '';
    }
  }
  const evidence = {
    schemaVersion: 1,
    status: failure || cleanup !== 'verified' ? 'failed' : 'verified',
    classification:
      failure ??
      (cleanup === 'verified' ? 'lifecycle_verified' : 'cleanup_unconfirmed'),
    createAttempts,
    createdMappings: records.length,
    requestCount: requests,
    durationMs: Math.max(0, runtime.now() - started),
    activeLifecycle: failure ? 'not-verified' : 'verified',
    abandonedLease:
      options.abandonedLease && !failure
        ? 'api-expiry-verified'
        : 'not-verified',
    alarmStorageDeletion: 'not-independently-verified',
    providerRecoveryErasure: 'not-verified',
    cleanup,
  };
  records.length = 0;
  return evidence;
}

if (import.meta.main) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await verifyLifecycle(
      {
        ...lifecycleArguments(process.argv.slice(2)),
        signal: controller.signal,
      },
      {
        fetch: globalThis.fetch,
        now: Date.now,
        wait: delay,
        phase: (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status !== 'verified') process.exitCode = 1;
  } catch {
    process.stderr.write(
      'Lifecycle verifier requires --production and optional --abandoned-lease. No diagnostic credentials are printed.\n',
    );
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
