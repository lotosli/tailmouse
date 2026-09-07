import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from './index.ts';
import { ShortInvitation } from './short-invitation.ts';
import { API_PATH, ORIGIN, LEASE_MS } from './api.ts';
import { invitation } from '../tests/invitation.ts';
import { storageState } from '../tests/storage.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function environment() {
  const objects = new Map<
    string,
    { object: ShortInvitation; memory: ReturnType<typeof storageState> }
  >();
  const limiter = () => ({ limit: vi.fn(async () => ({ success: true })) });
  const env = {
    CREATE_IP: limiter(),
    CREATE_EDGE: limiter(),
    READ_IP: limiter(),
    READ_EDGE: limiter(),
    STATIC_ASSETS: { get: vi.fn(async () => null) },
    SHORT_INVITATIONS: {
      getByName: vi.fn((code: string) => {
        let found = objects.get(code);
        if (!found) {
          const memory = storageState();
          found = {
            memory,
            object: new ShortInvitation(memory.state, {} as Env),
          };
          objects.set(code, found);
        }
        return { fetch: (request: Request) => found.object.fetch(request) };
      }),
    },
  };
  const fetch = (
    path = API_PATH,
    method = 'POST',
    body: unknown = method === 'POST'
      ? { invitation: invitation(), access: 'code' }
      : undefined,
    headers: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(ORIGIN + path, {
        method,
        headers: {
          'content-type': 'application/json',
          'cf-connecting-ip': '192.0.2.1',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env as unknown as Env,
    );
  return { env, objects, fetch };
}

describe('bounded public short API', () => {
  it('runs all four operations without access code delivery or token persistence', async () => {
    const f = environment();
    const response = await f.fetch();
    expect(response.status).toBe(201);
    const created = await response.json<{
      code: string;
      managementToken: string;
      expiresAt: number;
    }>();
    expect(created.code).toMatch(/^[0-9A-Za-z]{6}$/u);
    expect(created.managementToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.expiresAt).toBeGreaterThan(Date.now() + LEASE_MS - 1000);
    const path = API_PATH + '/' + created.code;
    const resolved = await f.fetch(path, 'GET', undefined);
    expect(await resolved.json()).toEqual({
      invitation: invitation(),
      expiresAt: created.expiresAt,
    });
    expect(resolved.headers.get('cache-control')).toBe('no-store');
    const memory = f.objects.get(created.code)!.memory.records.get('mapping');
    expect(JSON.stringify(memory)).not.toContain(created.managementToken);
    expect(JSON.stringify(memory)).not.toContain('access');
    const auth = { authorization: 'Bearer ' + created.managementToken };
    expect((await f.fetch(path, 'PUT', undefined, auth)).status).toBe(200);
    expect((await f.fetch(path, 'DELETE', undefined, auth)).status).toBe(204);
    expect(await (await f.fetch(path, 'GET', undefined)).json()).toEqual({
      error: 'invitation_unavailable',
    });
  });
  it('keeps case exact and hides reasons for unavailable locators', async () => {
    const f = environment();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
      const data = bytes as Uint8Array;
      data.fill(10);
      return bytes;
    });
    const response = await f.fetch();
    const body = await response.json<{ code: string }>();
    expect(body.code).toBe('AAAAAA');
    for (const code of [
      'aaaaaa',
      'XXXXXX',
      'too-long',
      '%41AAAAA',
      'ABC123?x=1',
    ]) {
      const response = await f.fetch(API_PATH + '/' + code, 'GET', undefined);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'invitation_unavailable',
      });
    }
  });
  it('rejects malformed methods, unsupported invites, unknown fields, and cross-origin requests', async () => {
    const f = environment();
    for (const body of [
      {},
      { invitation: invitation(), access: 'link' },
      { invitation: invitation({ m: 'escape' }), access: 'code' },
      {
        invitation: invitation(),
        access: 'code',
        accessCode: 'synthetic-private-code',
      },
    ]) {
      expect((await f.fetch(API_PATH, 'POST', body)).status).toBe(400);
    }
    expect(
      (
        await f.fetch(API_PATH, 'POST', undefined, {
          origin: 'https://foreign.example',
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.fetch(API_PATH + '/ABC123', 'PATCH', undefined)).status,
    ).toBe(405);
    expect((await f.fetch(API_PATH + '/ABC123', 'PUT', {})).status).toBe(400);
    expect(
      (
        await f.fetch(
          API_PATH,
          'POST',
          { invitation: invitation(), access: 'code' },
          { 'content-type': 'text/plain' },
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.fetch(API_PATH, 'POST', { x: 'a'.repeat(3000) })).status,
    ).toBe(413);
    expect(f.objects.size).toBe(0);
  });
  it('fails closed on missing identity and rate bindings, with bounded recovery', async () => {
    const f = environment();
    expect(
      (await f.fetch(API_PATH, 'POST', undefined, { 'cf-connecting-ip': '' }))
        .status,
    ).toBe(503);
    expect(
      (
        await f.fetch(API_PATH, 'POST', undefined, {
          'cf-connecting-ip': 'a'.repeat(65),
        })
      ).status,
    ).toBe(503);
    for (const binding of [f.env.CREATE_IP, f.env.CREATE_EDGE]) {
      binding.limit.mockResolvedValueOnce({ success: false });
      const denied = await f.fetch();
      expect(denied.status).toBe(429);
      expect(denied.headers.get('retry-after')).toBe('60');
    }
    f.env.CREATE_IP.limit.mockRejectedValueOnce(
      new Error('synthetic-private-rate-data'),
    );
    expect(await (await f.fetch()).json()).toEqual({
      error: 'service_unavailable',
    });
    expect(f.objects.size).toBe(0);
    expect((await f.fetch()).status).toBe(201);
    for (const call of f.env.CREATE_IP.limit.mock.calls)
      expect(call).toEqual([{ key: '192.0.2.1' }]);
    for (const call of f.env.CREATE_EDGE.limit.mock.calls)
      expect(call).toEqual([{ key: 'edge' }]);
  });
  it.each(['READ_IP', 'READ_EDGE'] as const)(
    '%s rejects reads and management before storage, then recovers with non-secret keys',
    async (name) => {
      const f = environment();
      const published = await f.fetch();
      expect(published.status).toBe(201);
      const created = await published.json<{
        code: string;
        managementToken: string;
        expiresAt: number;
      }>();
      const path = API_PATH + '/' + created.code;
      const auth = { authorization: 'Bearer ' + created.managementToken };
      const records = f.objects.get(created.code)!.memory.records;
      const before = structuredClone(records);
      const binding = f.env[name];
      f.env.SHORT_INVITATIONS.getByName.mockClear();
      f.env.CREATE_IP.limit.mockClear();
      f.env.CREATE_EDGE.limit.mockClear();

      for (const method of ['GET', 'PUT', 'DELETE']) {
        for (const fault of ['denied', 'rejected', 'missing']) {
          if (fault === 'denied')
            binding.limit.mockResolvedValueOnce({ success: false });
          else if (fault === 'rejected')
            binding.limit.mockRejectedValueOnce(
              new Error('synthetic-private-read-limit'),
            );
          else Reflect.deleteProperty(f.env, name);
          const response = await f.fetch(path, method, undefined, auth);
          f.env[name] = binding;
          expect(response.status).toBe(fault === 'denied' ? 429 : 503);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(response.headers.get('referrer-policy')).toBe('no-referrer');
          expect(response.headers.get('retry-after')).toBe(
            fault === 'denied' ? '60' : null,
          );
          expect(await response.json()).toEqual({
            error: fault === 'denied' ? 'rate_limited' : 'service_unavailable',
          });
          expect(f.env.SHORT_INVITATIONS.getByName).not.toHaveBeenCalled();
          expect(records).toEqual(before);
        }
      }

      const recovered = await f.fetch(path, 'GET', undefined);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toEqual({
        invitation: invitation(),
        expiresAt: created.expiresAt,
      });
      expect(f.env.SHORT_INVITATIONS.getByName).toHaveBeenCalledExactlyOnceWith(
        created.code,
      );
      expect(f.env.CREATE_IP.limit).not.toHaveBeenCalled();
      expect(f.env.CREATE_EDGE.limit).not.toHaveBeenCalled();
      expect(f.env.READ_IP.limit).toHaveBeenCalled();
      expect(f.env.READ_EDGE.limit).toHaveBeenCalled();
      for (const call of f.env.READ_IP.limit.mock.calls)
        expect(call).toEqual([{ key: '192.0.2.1' }]);
      for (const call of f.env.READ_EDGE.limit.mock.calls)
        expect(call).toEqual([{ key: 'edge' }]);
    },
  );
  it('preserves colliding mappings and stops after exactly eight allocation attempts', async () => {
    const f = environment();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
      (bytes as Uint8Array).fill(7);
      return bytes;
    });
    expect((await f.fetch()).status).toBe(201);
    const before = structuredClone(f.objects.get('777777')!.memory.records);
    f.env.SHORT_INVITATIONS.getByName.mockClear();
    expect((await f.fetch()).status).toBe(503);
    expect(f.env.SHORT_INVITATIONS.getByName).toHaveBeenCalledTimes(8);
    expect(f.objects.get('777777')!.memory.records).toEqual(before);
  });
  it('never allocates an existing six-character static filename', async () => {
    const f = environment();
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((bytes) => {
      const data = bytes as Uint8Array;
      data.fill(255);
      data.set([23, 24, 29, 18, 12, 14]);
      return bytes;
    });
    expect((await f.fetch()).status).toBe(503);
    expect(f.env.SHORT_INVITATIONS.getByName).not.toHaveBeenCalled();
  });
  it('rejects a foreign API origin but preserves unknown-route classification', async () => {
    const f = environment();
    for (const [path, status] of [
      [API_PATH + '/ABC123', 400],
      ['/api/missing', 404],
    ] as const) {
      const response = await worker.fetch(
        new Request('https://foreign.example' + path),
        f.env as unknown as Env,
      );
      expect(response.status).toBe(status);
    }
    expect(f.env.READ_IP.limit).not.toHaveBeenCalled();
  });
  it('rejects creation when the authoritative storage fails without reflecting details', async () => {
    const f = environment();
    f.env.SHORT_INVITATIONS.getByName.mockImplementation(() => ({
      fetch: async () =>
        new Response('synthetic-private-store-error', { status: 503 }),
    }));
    expect(await (await f.fetch()).json()).toEqual({
      error: 'service_unavailable',
    });
  });
  it('returns a bounded timeout and releases the slot only when outstanding work settles', async () => {
    vi.useFakeTimers();
    const f = environment();
    let finish: (result: { success: boolean }) => void = () => {};
    const waiting = new Promise<{ success: boolean }>((resolve) => {
      finish = resolve;
    });
    f.env.CREATE_IP.limit.mockImplementation(() => waiting);
    const requests = Array.from({ length: 64 }, () => f.fetch());
    expect((await f.fetch()).status).toBe(429);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await Promise.all(requests)).every((r) => r.status === 503)).toBe(
      true,
    );
    expect((await f.fetch()).status).toBe(429);
    finish({ success: true });
    await vi.advanceTimersByTimeAsync(1);
    f.env.CREATE_IP.limit.mockResolvedValue({ success: true });
    expect((await f.fetch()).status).toBe(201);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not route static paths through the API or leak storage exceptions', async () => {
    const f = environment();
    expect((await f.fetch('/missing', 'GET', undefined)).status).toBe(404);
    f.env.STATIC_ASSETS.get.mockRejectedValueOnce(
      new Error('synthetic-private-static'),
    );
    expect((await f.fetch('/', 'GET', undefined)).status).toBe(503);
    expect(f.env.CREATE_IP.limit).not.toHaveBeenCalled();
  });
});
