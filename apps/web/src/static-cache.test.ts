import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStaticCache } from './static-cache.ts';

afterEach(() => vi.unstubAllGlobals());

describe('static cache registration', () => {
  it('registers only the local worker without invitation data or cached update scripts', async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal('navigator', { serviceWorker: { register } });
    expect(await registerStaticCache()).toContain('registered');
    expect(register).toHaveBeenCalledWith('./service-worker.js', {
      updateViaCache: 'none',
    });
  });

  it('reports unsupported and blocked caching without exposing platform errors', async () => {
    vi.stubGlobal('navigator', {});
    expect(await registerStaticCache()).toContain(
      'unavailable in this browser',
    );
    vi.stubGlobal('navigator', {
      serviceWorker: {
        register: vi.fn().mockRejectedValue(new Error('private invitation')),
      },
    });
    expect(await registerStaticCache()).toBe(
      'Static cache unavailable. This session can continue online.',
    );
  });
});

describe('fixed-list service worker', () => {
  const scope = 'https://tailmouse.test/mounted/';
  const path = 'assets/app-12345678.js';
  const url = scope + path;
  const integrity = 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  const cacheName = 'tailmouse-static:/mounted/:current';

  async function worker() {
    const listeners = new Map<string, (event: unknown) => void>();
    const cache = {
      addAll: vi.fn().mockResolvedValue(undefined),
      match: vi.fn().mockResolvedValue(new Response('static bytes')),
    };
    const storage = {
      open: vi.fn().mockResolvedValue(cache),
      keys: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
    };
    vi.stubGlobal('self', {
      registration: { scope },
      addEventListener: (type: string, listener: (event: unknown) => void) =>
        listeners.set(type, listener),
    });
    vi.stubGlobal('caches', storage);
    vi.stubGlobal('__TAILMOUSE_STATIC_CACHE__', {
      version: 'current',
      assets: [{ path, integrity }],
    });
    vi.resetModules();
    const module = '../worker.ts';
    await import(module);
    const dispatch = (type: string, request?: unknown) => {
      let pending: Promise<unknown> | undefined;
      const accept = (value: Promise<unknown>) => {
        pending = value;
      };
      listeners.get(type)!({ waitUntil: accept, respondWith: accept, request });
      return pending;
    };
    return { dispatch, cache, storage };
  }

  it('precaches only integrity-checked build assets and removes a failed install', async () => {
    const { dispatch, cache, storage } = await worker();
    await dispatch('install');
    expect(storage.open).toHaveBeenCalledWith(cacheName);
    const requests = cache.addAll.mock.calls[0]![0] as Request[];
    expect(requests.map((request) => request.url)).toEqual([url]);
    expect(requests[0]).toMatchObject({
      integrity,
      credentials: 'omit',
      redirect: 'error',
      cache: 'force-cache',
      referrerPolicy: 'no-referrer',
    });
    cache.addAll.mockRejectedValueOnce(new Error('asset unavailable'));
    await expect(dispatch('install')).rejects.toThrow('asset unavailable');
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(cacheName);
  });

  it('activation deletes only obsolete TailMouse caches in this mount scope', async () => {
    const { dispatch, storage } = await worker();
    storage.keys.mockResolvedValue([
      cacheName,
      'tailmouse-static:/mounted/:old',
      'tailmouse-static:/another/:old',
      'another-application',
    ]);
    await dispatch('activate');
    expect(storage.delete).toHaveBeenCalledExactlyOnceWith(
      'tailmouse-static:/mounted/:old',
    );
  });

  it('forwards navigation without storing it', async () => {
    const { dispatch, storage } = await worker();
    const request = { url: scope, method: 'GET', mode: 'navigate' };
    const fetch = vi.fn().mockResolvedValue(new Response('network page'));
    vi.stubGlobal('fetch', fetch);
    expect(await ((await dispatch('fetch', request)) as Response).text()).toBe(
      'network page',
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('ignores credentials, query strings, foreign origins and non-build traffic', async () => {
    const { dispatch, storage } = await worker();
    for (const request of [
      { url, method: 'POST' },
      { url: `${url}?invite=synthetic`, method: 'GET' },
      { url: `${url}#synthetic`, method: 'GET' },
      { url: url.replace('tailmouse.test', 'foreign.test'), method: 'GET' },
      { url: `${scope}session`, method: 'GET' },
      { url: `${scope}index.html`, method: 'GET' },
    ])
      expect(dispatch('fetch', request)).toBeUndefined();
    expect(storage.open).not.toHaveBeenCalled();
  });

  it('serves cached bytes and does not persist a network fallback', async () => {
    const { dispatch, cache } = await worker();
    const response = (await dispatch('fetch', new Request(url))) as Response;
    expect(await response.text()).toBe('static bytes');
    cache.match.mockResolvedValueOnce(undefined);
    const fetch = vi.fn().mockResolvedValue(new Response('network bytes'));
    vi.stubGlobal('fetch', fetch);
    const missing = (await dispatch('fetch', new Request(url))) as Response;
    expect(await missing.text()).toBe('network bytes');
    expect(fetch.mock.calls[0]![0]).toMatchObject({
      url,
      integrity,
      credentials: 'omit',
      redirect: 'error',
    });
    expect(cache.addAll).not.toHaveBeenCalled();
  });
});
