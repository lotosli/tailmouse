/// <reference lib="webworker" />

// Only this adapter speaks to the TailMouse-owned Go/Wasm bridge. Worker
// requests come exclusively from the trusted parent, never from preview frames.
interface ResourceRuntime {
  Go?: new () => {
    importObject: WebAssembly.Imports;
    run(instance: WebAssembly.Instance): Promise<void>;
  };
  tailmouseResourceCall?: (
    op: string,
    id: number,
    value: unknown,
  ) => Promise<unknown>;
}
const runtime = globalThis as typeof globalThis & ResourceRuntime;
const scope = globalThis as unknown as DedicatedWorkerGlobalScope;
let loading: Promise<void> | undefined;
async function load(
  assets: { runtime: string; wasm: string; bytes: number },
  id: number,
): Promise<void> {
  for (const value of [assets.runtime, assets.wasm]) {
    const url = new URL(value, scope.location.href);
    if (
      url.origin !== scope.location.origin ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username !== '' ||
      url.password !== '' ||
      url.hash !== ''
    )
      throw new Error('ASSET_ORIGIN');
  }
  await import(/* @vite-ignore */ assets.runtime);
  if (runtime.Go === undefined) throw new Error('RUNTIME_MISSING');
  const go = new runtime.Go();
  const response = await fetch(assets.wasm, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  if (
    !response.ok ||
    response.body === null ||
    !Number.isSafeInteger(assets.bytes) ||
    assets.bytes < 1 ||
    assets.bytes > 40 * 1024 * 1024
  )
    throw new Error('RUNTIME_DOWNLOAD');
  let received = 0;
  let reported = -1;
  const progress = (): void => {
    const percent = Math.min(99, Math.floor((received / assets.bytes) * 100));
    if (percent !== reported) {
      reported = percent;
      scope.postMessage({ id, progress: { received, total: assets.bytes } });
    }
  };
  progress();
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > assets.bytes) throw new Error('RUNTIME_SIZE');
        progress();
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== assets.bytes) throw new Error('RUNTIME_SIZE');
      },
    }),
  );
  const result = await WebAssembly.instantiateStreaming(
    new Response(body, { headers: { 'Content-Type': 'application/wasm' } }),
    go.importObject,
  );
  scope.postMessage({
    id,
    progress: { received: assets.bytes, total: assets.bytes },
  });
  void go.run(result.instance).catch(() => scope.postMessage({ fatal: true }));
  if (runtime.tailmouseResourceCall === undefined)
    throw new Error('BRIDGE_MISSING');
}
scope.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data as {
    id: number;
    op: string;
    stream: number;
    value: unknown;
    assets?: { runtime: string; wasm: string; bytes: number };
  };
  if (!Number.isSafeInteger(message?.id) || typeof message.op !== 'string')
    return;
  void (async () => {
    try {
      if (message.op === 'load') {
        if (message.assets === undefined) throw new Error('ASSETS_MISSING');
        loading ??= load(message.assets, message.id);
        await loading;
        scope.postMessage({ id: message.id, ok: true });
        return;
      }
      if (loading === undefined) throw new Error('RUNTIME_MISSING');
      await loading;
      if (runtime.tailmouseResourceCall === undefined)
        throw new Error('BRIDGE_MISSING');
      const value = await runtime.tailmouseResourceCall(
        message.op,
        message.stream,
        message.value,
      );
      if (value instanceof Uint8Array)
        scope.postMessage({ id: message.id, ok: true, value }, [value.buffer]);
      else scope.postMessage({ id: message.id, ok: true, value });
    } catch {
      scope.postMessage({ id: message.id, ok: false });
    } finally {
      // These are Worker-owned structured clones. Go copies their bytes before
      // completing the operation, but its JS value references can outlive that
      // completion. Release the backing store instead of waiting for two GCs.
      if (
        (message.op === 'write' || message.op === 'hash.update') &&
        message.value instanceof Uint8Array &&
        message.value.buffer instanceof ArrayBuffer &&
        message.value.buffer.byteLength !== 0
      )
        message.value.buffer.transfer(0);
    }
  })();
});
