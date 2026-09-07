import { describe, expect, it, vi, afterEach } from 'vitest';
import { ShortInvitation } from './short-invitation.ts';
import { API_PATH, LEASE_MS, ORIGIN, base64url, tokenHash } from './api.ts';
import { invitation } from '../tests/invitation.ts';
import { storageState } from '../tests/storage.ts';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const token = base64url(new Uint8Array(32).fill(3));
const endpoint = `${ORIGIN}${API_PATH}/AbC123`;
const request = (method = 'GET', body?: unknown, auth = token) =>
  new Request(endpoint, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${auth}`,
    },
  });

async function fixture() {
  const memory = storageState();
  const object = new ShortInvitation(memory.state, {} as Env);
  const create = () =>
    object.fetch(
      request('POST', { invitation: invitation(), verifier: verifier }),
    );
  const verifier = await tokenHash(token);
  return { ...memory, object, create, verifier };
}

describe('authoritative mapping lifecycle', () => {
  it('stores only accepted fields and a hash, never renews on resolution, then deletes immediately', async () => {
    const f = await fixture();
    expect((await f.create()).status).toBe(201);
    const stored = f.records.get('mapping') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual([
      'expiresAt',
      'invitation',
      'verifier',
    ]);
    expect(stored.verifier).not.toBe(token);
    const read = await f.object.fetch(request());
    expect(await read.json()).toEqual({
      invitation: invitation(),
      expiresAt: stored.expiresAt,
    });
    expect(f.records.get('mapping')).toEqual(stored);
    expect(await f.storage.getAlarm()).toBe(stored.expiresAt);
    expect((await f.object.fetch(request('DELETE'))).status).toBe(204);
    expect(f.records.size).toBe(0);
    expect(await f.storage.getAlarm()).toBeNull();
    expect((await f.object.fetch(request())).status).toBe(404);
    expect((await f.object.fetch(request('PUT'))).status).toBe(404);
  });
  it('renews at five minutes and rejects exactly at expiry even without an alarm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100000);
    const f = await fixture();
    await f.create();
    vi.spyOn(Date, 'now').mockReturnValue(400000);
    expect(await (await f.object.fetch(request('PUT'))).json()).toEqual({
      expiresAt: 400000 + LEASE_MS,
    });
    await f.object.alarm();
    expect(f.records.size).toBe(1);
    expect(await f.storage.getAlarm()).toBe(400000 + LEASE_MS);
    vi.spyOn(Date, 'now').mockReturnValue(400000 + LEASE_MS);
    expect((await f.object.fetch(request('PUT'))).status).toBe(404);
    expect(f.records.size).toBe(0);
  });
  it('erases abandoned mappings without browser traffic and permits atomic fresh claims', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100000);
    const f = await fixture();
    await f.create();
    vi.spyOn(Date, 'now').mockReturnValue(100000 + LEASE_MS);
    await f.object.alarm();
    expect(f.records.size).toBe(0);
    expect((await f.create()).status).toBe(201);
    const pair = await Promise.all([f.create(), f.create()]);
    expect(pair.map((r) => r.status)).toEqual([409, 409]);
    expect(f.records.size).toBe(1);
  });
  it('orders simultaneous claims and delete-before-read without overwriting', async () => {
    const f = await fixture();
    expect(
      (await Promise.all([f.create(), f.create()]))
        .map((r) => r.status)
        .sort((a, b) => a - b),
    ).toEqual([201, 409]);
    await f.object.fetch(request('DELETE'));
    expect((await f.object.fetch(request())).status).toBe(404);
    await f.object.alarm();
    expect(f.records.size).toBe(0);
  });
  it('never reveals which management credential or unavailable state failed', async () => {
    const f = await fixture();
    await f.create();
    for (const auth of ['', 'AbC123', base64url(new Uint8Array(32).fill(8))]) {
      for (const method of ['PUT', 'DELETE'])
        expect(
          await (await f.object.fetch(request(method, undefined, auth))).json(),
        ).toEqual({ error: 'invitation_unavailable' });
    }
    expect(f.records.size).toBe(1);
  });
  it('fails transactionally and redacts storage failures while preserving cleanup retry', async () => {
    const f = await fixture();
    vi.spyOn(f.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('synthetic-private-storage'),
    );
    expect((await f.create()).status).toBe(503);
    expect(f.records.size).toBe(0);
    await f.create();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LEASE_MS);
    vi.spyOn(f.storage, 'deleteAll').mockRejectedValueOnce(
      new Error('synthetic-private-storage'),
    );
    await expect(f.object.alarm()).rejects.toThrow('cleanup_unavailable');
    expect(await f.storage.getAlarm()).toBe(Date.now() + 300000);
    await f.object.alarm();
    expect(f.records.size).toBe(0);
  });
  it('persists the cleanup backstop before a rejected concurrency callback can reset the object', async () => {
    const f = await fixture();
    await f.create();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + LEASE_MS);
    const block = f.state.blockConcurrencyWhile.bind(f.state);
    const setAlarm = f.storage.setAlarm.bind(f.storage);
    let reset = false;
    vi.spyOn(f.state, 'blockConcurrencyWhile').mockImplementation(
      async (callback) => {
        try {
          return await block(callback);
        } catch (error) {
          reset = true;
          throw error;
        }
      },
    );
    vi.spyOn(f.storage, 'setAlarm').mockImplementation(async (time) => {
      if (reset) throw new Error('synthetic-private-reset-context');
      await setAlarm(time);
    });
    vi.spyOn(f.storage, 'deleteAll').mockRejectedValueOnce(
      new Error('synthetic-private-storage'),
    );
    await expect(f.object.alarm()).rejects.toThrow('cleanup_unavailable');
    expect(reset).toBe(false);
    expect(await f.storage.getAlarm()).toBe(Date.now() + 300000);
    expect(f.records.size).toBe(1);
    await f.object.alarm();
    expect(f.records.size).toBe(0);
  });
  it('retains a fixed alarm failure when storage also rejects fallback scheduling', async () => {
    const f = await fixture();
    await f.create();
    const originalAlarm = await f.storage.getAlarm();
    vi.spyOn(f.storage, 'get').mockRejectedValueOnce(
      new Error('synthetic-private-storage'),
    );
    vi.spyOn(f.storage, 'setAlarm').mockRejectedValueOnce(
      new Error('synthetic-private-fallback'),
    );
    await expect(f.object.alarm()).rejects.toThrow(/^cleanup_unavailable$/u);
    expect(f.records.size).toBe(1);
    expect(await f.storage.getAlarm()).toBe(originalAlarm);
  });
  it('rejects malformed internal operations without retaining input', async () => {
    const f = await fixture();
    for (const body of [
      {},
      { invitation: invitation(), verifier: 'bad' },
      { invitation: invitation({ m: 'escape' }), verifier: f.verifier },
      {
        invitation: invitation(),
        verifier: f.verifier,
        accessCode: 'synthetic-private-code',
      },
    ])
      expect((await f.object.fetch(request('POST', body))).status).toBe(400);
    expect((await f.object.fetch(new Request(endpoint + '?x=1'))).status).toBe(
      404,
    );
    expect((await f.object.fetch(new Request(ORIGIN + '/nope'))).status).toBe(
      404,
    );
    expect((await f.object.fetch(request('PATCH'))).status).toBe(405);
    expect((await f.object.fetch(request('PUT', {}))).status).toBe(400);
    expect(f.records.size).toBe(0);
  });
});
