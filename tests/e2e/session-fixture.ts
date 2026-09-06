import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';

const corpus = JSON.parse(
  readFileSync(
    new URL('../../protocol/fixtures/v1/frames.json', import.meta.url),
    'utf8',
  ),
) as { cases: Array<{ id: string; wire: { hex: string } }> };
const gameInitial = JSON.parse(
  Buffer.from(
    corpus.cases.find((entry) => entry.id === 'game-init-canonical')!.wire.hex,
    'hex',
  )
    .subarray(6)
    .toString(),
) as Record<string, unknown>;

export const address = 'tcSyntheticPlaywrightCredential';
// Canonical CBOR for the synthetic MouseCard returned by invitationURL.
export const cardFixture =
  'qGFhAWFlGnE_swBhbWZlc2NhcGVhcBmtIWFzUAkJCQkJCQkJCQkJCQkJCQlhdHgfdGNTeW50aGV0aWNQbGF5d3JpZ2h0Q3JlZGVudGlhbGF2AWF6AQ';
export const leashCardFixture =
  'qGFhAmFlGnE_swBhbWVsZWFzaGFwGa0hYXNQCQkJCQkJCQkJCQkJCQkJCWF0eB90Y1N5bnRoZXRpY1BsYXl3cmlnaHRDcmVkZW50aWFsYXYBYXoC';

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
    game?: boolean;
    terminal?: boolean;
    phoneRender?: boolean;
    showNet?: boolean;
    control?: 'touch' | 'tilt';
    closeFailure?: boolean;
    oversizedFrame?: 'global' | 'terminal';
    pauseDial?: boolean;
    firstHandshakeTimeout?: boolean;
    protected?: boolean;
  } = {},
) {
  return {
    body: `
      globalThis.Go = class {
        importObject = {};
        run() {
          const options = ${JSON.stringify(options)};
          const gameInitial = ${JSON.stringify(gameInitial)};
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
            let sequence = 0;
            let eventSequence = 0;
            let accepted = 0;
            let gameState = { elapsed: 0, phase: 0, cooldown: 0, mask: 0, mouse: gameInitial.mouse };
            globalThis.testGameInputs = [];
            globalThis.testGameSnapshot = (patch = {}) => {
              gameState = { ...gameState, ...patch };
              const data = new Uint8Array(50), view = new DataView(data.buffer);
              view.setUint32(0, 46); data[4] = 0x22;
              view.setUint32(6, ++sequence); view.setUint32(10, accepted);
              view.setBigUint64(14, BigInt(gameState.elapsed));
              view.setFloat32(22, gameState.mouse.x); view.setFloat32(26, gameState.mouse.y);
              view.setFloat32(30, gameInitial.cat.x); view.setFloat32(34, gameInitial.cat.y);
              view.setUint32(38, 45000 - gameState.elapsed); view.setUint32(42, gameState.cooldown);
              data[46] = gameState.mask; data[47] = gameState.phase; data[48] = gameState.mask === 3 ? 1 : 0;
              push(data);
            };
            globalThis.testGameResult = (outcome, close = true) => {
              const messages = { caught: 'The connection was too good.', escaped: 'The cat was always 48ms too late.',
                timeout: 'The connection was too good.', connection_lost: 'Connection lost.' };
              frame(0x24, { outcome, elapsed_ms: 1200, relay: 'relay.example.com', rtt_p50_ms: 48, rtt_p95_ms: 63,
                jitter_ms: 6, message: messages[outcome] });
              if (close) { serverClosing = true; frame(6, { reason: 'normal', message: 'Session closed.' }); }
            };
            globalThis.testGameRestart = () => {
              accepted = 0;
              gameState = { elapsed: 0, phase: 0, cooldown: 0, mask: 0, mouse: gameInitial.mouse };
              frame(0x20, { ...gameInitial, presentation: { control: options.control ?? 'touch',
                phone_render: options.phoneRender ?? true, show_net: options.showNet ?? true } });
              globalThis.testGameSnapshot();
              frame(0x23, { sequence: ++eventSequence, event: 'countdown', value: 3 });
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
                    frame(2, { protocol: hello.mode === 'escape' ? 1 : 2, mode: hello.mode, session_state: 'active', expires_at: 0,
                      relay: { mode: 'official', host: 'relay.example.com', browser_path: 'derp' },
                      capabilities: hello.mode === 'escape' ? ['dash', 'game_input', 'game_view'] :
                        options.readonly ? ['terminal_output'] : ['interrupt', 'resize', 'restart', 'terminal_input', 'terminal_output', 'terminate'],
                      ...(hello.mode === 'leash' ? { access_mode: 'link' } : {}),
                    });
                    if (options.game && hello.mode === 'escape') {
                      globalThis.testGameRestart();
                    }
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
                } else if (data[4] === 0x21 && options.game) {
                  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
                  accepted = view.getUint32(6);
                  globalThis.testGameInputs.push({ x: view.getFloat32(18), y: view.getFloat32(22), dash: data[26] === 1 });
                  if (globalThis.testGameInputs.length > 128) globalThis.testGameInputs.shift();
                  if (data[26] === 1) globalThis.testGameSnapshot({ cooldown: 5000 });
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

export function invitationURL(mode: 'escape' | 'leash' = 'escape'): string {
  return `/#/v1/${mode === 'escape' ? cardFixture : leashCardFixture}`;
}
