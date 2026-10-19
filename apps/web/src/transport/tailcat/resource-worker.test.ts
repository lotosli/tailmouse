import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function worker(ready = true) {
  let receive!: (event: MessageEvent<unknown>) => void;
  const post = vi.fn(),
    call = vi.fn(async () => null as unknown);
  vi.stubGlobal('location', new URL('https://ui.example.test/worker.js'));
  vi.stubGlobal(
    'addEventListener',
    (_name: string, handler: typeof receive) => {
      receive = handler;
    },
  );
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('tailmouseResourceCall', undefined);
  vi.stubGlobal(
    'Go',
    class {
      importObject = {};
      async run() {
        if (ready) vi.stubGlobal('tailmouseResourceCall', call);
        await new Promise(() => undefined);
      }
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array(0))),
  );
  vi.spyOn(WebAssembly, 'instantiateStreaming').mockResolvedValue({
    instance: {} as WebAssembly.Instance,
    module: {} as WebAssembly.Module,
  });
  vi.resetModules();
  const module = './resource-worker.ts';
  await import(module);
  const send = (value: unknown) =>
    receive({ data: value } as MessageEvent<unknown>);
  const load = (runtime = './fixtures/resource-runtime.mjs') =>
    send({
      id: 1,
      op: 'load',
      stream: 0,
      value: null,
      assets: { runtime, wasm: '/resource.wasm' },
    });
  return { send, load, post, call };
}
it('loads local assets once, transfers byte results and redacts bridge errors', async () => {
  const w = await worker();
  w.load();
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 1, ok: true }),
  );
  const bytes = new Uint8Array([1, 2, 3]);
  w.call.mockResolvedValueOnce(bytes);
  w.send({ id: 2, op: 'read', stream: 7, value: null });
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 2, ok: true, value: bytes }, [
      bytes.buffer,
    ]),
  );
  w.call.mockResolvedValueOnce('synthetic-key');
  w.send({ id: 3, op: 'open', stream: 0, value: null });
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({
      id: 3,
      ok: true,
      value: 'synthetic-key',
    }),
  );
  w.call.mockRejectedValueOnce(new Error('private transport error'));
  w.send({ id: 4, op: 'write', stream: 7, value: bytes });
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 4, ok: false }),
  );
  expect(JSON.stringify(w.post.mock.calls)).not.toContain(
    'private transport error',
  );
  w.load();
  await vi.waitFor(() =>
    expect(
      w.post.mock.calls.filter((c) => (c[0] as { id: number }).id === 1),
    ).toHaveLength(2),
  );
  expect(WebAssembly.instantiateStreaming).toHaveBeenCalledOnce();
});
it.each([
  'https://other.example/runtime.js',
  'https://user@ui.example.test/runtime.js',
  'blob:https://ui.example.test/id',
  '/runtime.js#fragment',
])('rejects an invalid runtime asset before loading: %s', async (url) => {
  const w = await worker();
  w.load(url);
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 1, ok: false }),
  );
  expect(WebAssembly.instantiateStreaming).not.toHaveBeenCalled();
});
it('rejects operations before loading and a runtime missing its bridge', async () => {
  const w = await worker(false);
  w.send({ id: 'bad', op: 'read' });
  expect(w.post).not.toHaveBeenCalled();
  w.send({ id: 2, op: 'read', stream: 1, value: null });
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 2, ok: false }),
  );
  w.load();
  await vi.waitFor(() =>
    expect(w.post).toHaveBeenCalledWith({ id: 1, ok: false }),
  );
});
