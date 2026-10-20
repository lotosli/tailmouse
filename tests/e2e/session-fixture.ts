import type { Page, Route } from '@playwright/test';
export const address = 'tcSyntheticPlaywrightCredential';
// Canonical CBOR for the synthetic MouseCard returned by invitationURL.
export const leashCardFixture =
  'qGFhAmFlGnE_swBhbWVsZWFzaGFwGa0hYXNQCQkJCQkJCQkJCQkJCQkJCWF0eB90Y1N5bnRoZXRpY1BsYXl3cmlnaHRDcmVkZW50aWFsYXYBYXoC';

export const cardFixture = leashCardFixture;

export async function installTailcatBridge(
  page: Page,
  runtimeHandler: (route: Route) => Promise<unknown> = (route) =>
    route.fulfill(runtimeScript()),
): Promise<void> {
  await page.route('**/tailcat/wasm_exec-*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await runtimeHandler(route);
  });
  await page.route('**/tailcat/tailcat-web-*.wasm', (route) =>
    route.fulfill({
      body: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]),
      contentType: 'application/wasm',
      status: 200,
    }),
  );
}

export function runtimeScript(
  options: {
    readonly?: boolean;
    rejection?: string;
    terminal?: boolean;
    closeFailure?: boolean;
    oversizedFrame?: 'global' | 'terminal';
    pauseDial?: boolean;
    firstHandshakeTimeout?: boolean;
    protected?: boolean;
    authRejections?: boolean;
  } = {},
) {
  return {
    body: `
      globalThis.Go = class {
        importObject = {};
        run() {
          const options = ${JSON.stringify(options)};
          globalThis.testDialCount = 0;
          globalThis.tailcatDial = async () => {
            globalThis.testDialCount++;
            if (options.pauseDial) await new Promise((resolve) => { globalThis.testReleaseDial = resolve; });
            const queue = [];
            let reader;
            let closed = false;
            let awaitingProof = false;
            globalThis.testProtocolEvents = [];
            globalThis.testProtocolNotice = undefined;
            let serverClosing = false;
            const push = (chunk) => {
              if (reader) { const resolve = reader; reader = undefined; resolve(chunk); }
              else queue.push(chunk);
            };
            const frame = (type, value) => {
              const payload = new TextEncoder().encode(JSON.stringify(value));
              const data = new Uint8Array(payload.length + 6);
              new DataView(data.buffer).setUint32(0, payload.length + 2);
              data[4] = type;
              data.set(payload, 6);
              push(data);
            };
            const raw = (type, payload) => {
              const data = new Uint8Array(payload.length + 6);
              new DataView(data.buffer).setUint32(0, payload.length + 2);
              data[4] = type; data.set(payload, 6); push(data);
            };
            let generation = globalThis.testDialCount;
            globalThis.testLeashInputs = [];
            globalThis.testLeashControls = [];
            globalThis.testLeashSizes = [];
            globalThis.testLeashBackpressure = false;
            globalThis.testLeashOutput = text => raw(0x11, new TextEncoder().encode(text));
            globalThis.testLeashState = (state = 'running', patch = {}) => frame(0x15, {
              generation, state, pid: 42, started_at: Math.floor(Date.now() / 1000) - 60,
              exit_code: null, signal: null, title: 'Example CLI 🐈', ...patch,
            });
            const terminalReset = () => {
              frame(0x10, { generation, cols: 80, rows: 24 });
              globalThis.testLeashOutput('TailMouse terminal generation ' + generation + String.fromCharCode(13, 10) + '$ ');
              globalThis.testLeashState();
              raw(4, new Uint8Array(16));
            };
            globalThis.testDisconnect = (partial = false) => {
              if (partial) push(new Uint8Array([0, 0, 0, 5, 0x11, 0, 65]));
              push(null);
            };
            return {
              port: 44321,
              read: async () => queue.length ? queue.shift() : closed ? null : new Promise((resolve) => { reader = resolve; }),
              write: async (data) => {
                if (data[4] === 1) {
                  if (options.firstHandshakeTimeout && globalThis.testDialCount === 1) return;
                  const hello = JSON.parse(new TextDecoder().decode(data.slice(6)));
                  globalThis.testHelloProtocol = { minimum: hello.protocol_min, maximum: hello.protocol_max };
                  if (options.rejection) {
                    frame(3, { code: options.rejection, message: 'tcSyntheticPeerSecret', retryable: true });
                  } else if (options.protected && hello.mode === 'leash') {
                    awaitingProof = true;
                    const challenge = crypto.getRandomValues(new Uint8Array(32));
                    const encoded = btoa(String.fromCharCode(...challenge)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
                    challenge.fill(0);
                    frame(7, { scheme: 'hmac-sha256-v1', challenge: encoded });
                  } else {
                    frame(2, { protocol: 2, mode: hello.mode, session_state: 'active', expires_at: 0,
                      relay: { mode: 'official', host: 'relay.example.com', browser_path: 'derp' },
                      capabilities: options.readonly ? ['terminal_output'] : ['interrupt', 'resize', 'restart', 'terminal_input', 'terminal_output', 'terminate'],
                      ...(hello.mode === 'leash' ? { access_mode: 'link' } : {}),
                    });

                    if (options.terminal && hello.mode === 'leash') terminalReset();
                    if (options.oversizedFrame) {
                      push(new Uint8Array(options.oversizedFrame === 'terminal' ? [0, 0, 0x80, 1, 0x11, 0] : [0, 0x10, 0, 1]));
                    }
                  }
                } else if (data[4] === 8 && options.protected && awaitingProof) {
                  awaitingProof = false;
                  const auth = JSON.parse(new TextDecoder().decode(data.slice(6)));
                  if (auth.scheme !== 'hmac-sha256-v1' || !/^[A-Za-z0-9_-]{43}$/.test(auth.proof) || Object.keys(auth).sort().join(',') !== 'proof,scheme')
                    throw new Error('INVALID_AUTH_PROOF');
                  if (options.authRejections && globalThis.testDialCount <= 2) {
                    frame(3, { code: globalThis.testDialCount === 1 ? 'AUTH_FAILED' : 'AUTH_THROTTLED',
                      message: 'tcSyntheticPeerSecret', retryable: true,
                      ...(globalThis.testDialCount === 2 ? { retry_after_ms: 1500 } : {}),
                    });
                    return;
                  }
                  frame(2, { protocol: 2, mode: 'leash', session_state: 'active', expires_at: 0,
                    relay: { mode: 'official', host: 'relay.example.com', browser_path: 'derp' },
                    capabilities: options.readonly ? ['terminal_output'] : ['interrupt', 'resize', 'restart', 'terminal_input', 'terminal_output', 'terminate'],
                    access_mode: 'code',
                  });
                  if (options.terminal) terminalReset();
                } else if (data[4] === 3) {
                  if (globalThis.testProtocolNotice) throw new Error('Repeated protocol error notification');
                  globalThis.testProtocolNotice = JSON.parse(new TextDecoder().decode(data.slice(6)));
                  globalThis.testProtocolEvents.push(globalThis.testProtocolNotice.code);
                } else if (data[4] === 6) {
                  if (!serverClosing) { serverClosing = true; frame(6, { reason: 'normal', message: 'Session closed.' }); }
                } else if (data[4] === 4) {
                  const pong = data.slice(); pong[4] = 5; push(pong);
                } else if (options.terminal && data[4] === 0x12) {
                  if (options.readonly || globalThis.testLeashBackpressure) {
                    frame(3, { code: options.readonly ? 'READONLY' : 'BACKPRESSURE', message: 'untrusted peer text', retryable: false });
                  } else {
                    globalThis.testLeashInputs.push(Array.from(data.slice(6)));
                    if (globalThis.testLeashInputs.length > 32) globalThis.testLeashInputs.shift();
                    raw(0x11, data.slice(6));
                  }
                } else if (options.terminal && data[4] === 0x13) {
                  const size = new DataView(data.buffer, data.byteOffset, data.byteLength);
                  globalThis.testLeashSizes.push([size.getUint16(6), size.getUint16(8)]);
                  if (globalThis.testLeashSizes.length > 32) globalThis.testLeashSizes.shift();
                } else if (options.terminal && data[4] === 0x14) {
                  const control = JSON.parse(new TextDecoder().decode(data.slice(6)));
                  globalThis.testLeashControls.push(control);
                  if (control.action === 'restart') { generation++; terminalReset(); }
                  else globalThis.testLeashState(control.action === 'interrupt' ? 'interrupting' : 'exited', control.action === 'terminate' ? { exit_code: 143, signal: 'SIGTERM' } : {});
                }
              },
              closeWrite: async () => { globalThis.testProtocolEvents.push('fin'); if (options.closeFailure) throw new Error('tcSyntheticCloseFailure'); closed = true; push(null); },
              close: () => { globalThis.testProtocolEvents.push('closed'); closed = true; if (reader) push(null); },
            };
          };
          globalThis.onTailcatReady();
          return new Promise(() => {});
        }
      };
    `,
    contentType: 'text/javascript',
    status: 200,
  };
}

export function invitationURL(_mode: 'leash' = 'leash'): string {
  return `/#/v1/${leashCardFixture}`;
}
