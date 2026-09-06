import { encode } from 'cborg';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { App } from './app.tsx';
import {
  authChallengeFrame,
  closeFrame,
  encodeFrame,
  errorFrame,
  Message,
  type Frame,
} from './protocol/frame.ts';
import {
  dialTailcat,
  loadTailcat,
  TailcatTransportError,
  type ByteStream,
} from './transport/tailcat/adapter.ts';

vi.mock('./transport/tailcat/adapter.ts', { spy: true });

const root = document.createElement('div');
const originalURL = location.href;

beforeEach(() => {
  vi.mocked(loadTailcat).mockResolvedValue(undefined);
  vi.mocked(dialTailcat).mockRejectedValue(
    new TailcatTransportError('DIAL_FAILED'),
  );
});

afterEach(async () => {
  await act(() => render(null, root));
  root.remove();
  root.replaceChildren();
  history.replaceState(null, '', originalURL);
  vi.mocked(loadTailcat).mockReset();
  vi.mocked(dialTailcat).mockReset();
  vi.restoreAllMocks();
});

async function mount(invited: boolean) {
  const bytes = encode({
    a: 2,
    e: 0,
    m: 'leash',
    p: 44321,
    s: new Uint8Array(16).fill(7),
    t: 'tcSyntheticCacheSchedulingCredential',
    v: 1,
    z: 2,
  });
  const fragment = btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
  history.replaceState(
    null,
    '',
    `${location.pathname}${location.search}${invited ? `#/v1/${fragment}` : ''}`,
  );
  document.body.append(root);
  await act(() => render(<App />, root));
  expect(location.hash).toBe('');
  await userEvent.click(page.getByText('About TailMouse', { exact: true }));
}

describe('invitation safety notice', () => {
  it('does not claim a protection mode before the Host reports one', async () => {
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    await expect
      .element(page.getByText(/^Treat this invitation link like a password\./u))
      .toHaveTextContent('The host may also require a separate access code.');
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.textContent).not.toContain(
      'tcSyntheticCacheSchedulingCredential',
    );
  });

  it('uses a fresh protected stream only after explicit access-code submission', async () => {
    const discovery = hostPeer(authChallengeFrame(new Uint8Array(32).fill(3)));
    const admission = hostPeer(
      authChallengeFrame(new Uint8Array(32).fill(4)),
      leashWelcome('code'),
    );
    const replacement = hostPeer(
      authChallengeFrame(new Uint8Array(32).fill(8)),
      leashWelcome('code'),
    );
    vi.mocked(dialTailcat)
      .mockResolvedValueOnce(discovery.stream)
      .mockResolvedValueOnce(admission.stream)
      .mockResolvedValueOnce(replacement.stream);
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);

    await expect
      .element(page.getByRole('textbox', { name: 'Access code' }))
      .toBeVisible();
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Enter the host access code to continue.');
    expect(discovery.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
    ]);

    const field = page.getByRole('textbox', { name: 'Access code' });
    await userEvent.fill(field, '2345-6789-abcd-efgh');
    await userEvent.click(page.getByRole('button', { name: 'Connect' }));
    await expect
      .element(
        page
          .getByLabelText('Connection')
          .getByText('Connected', { exact: true }),
      )
      .toBeVisible();
    expect(admission.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
      Message.AUTH_PROOF,
    ]);
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(location.href).not.toContain('2345');
    expect(root.textContent).not.toContain('2345');
    await expect
      .element(page.getByText('Password protected', { exact: true }))
      .toBeVisible();

    admission.disconnect();
    await expect
      .element(page.getByRole('button', { name: 'Retry connection' }))
      .toBeVisible();
    await expect
      .element(page.getByText('Last observed before the connection ended'))
      .toBeVisible();
    expect(root.querySelector('input[type="password"]')).toBeNull();
    await userEvent.click(
      page.getByRole('button', { name: 'Retry connection' }),
    );
    await expect
      .element(
        page
          .getByLabelText('Connection')
          .getByText('Connected', { exact: true }),
      )
      .toBeVisible();
    expect(replacement.writes.map((bytes) => bytes[4])).toEqual([
      Message.CLIENT_HELLO,
      Message.AUTH_PROOF,
    ]);
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows Host-authoritative link-only access without a password field', async () => {
    const peer = hostPeer(leashWelcome('link'));
    vi.mocked(dialTailcat).mockResolvedValueOnce(peer.stream);
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    await expect
      .element(
        page
          .getByLabelText('Connection')
          .getByText('Connected', { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(page.getByText(/^No password — link grants access\./u))
      .toBeVisible();
    expect(root.querySelector('input[type="password"]')).toBeNull();
  });

  it('records separate startup phases through terminal readiness', async () => {
    const peer = hostPeer(leashWelcome('link'));
    vi.mocked(dialTailcat).mockResolvedValueOnce(peer.stream);
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    await expect
      .element(
        page
          .getByLabelText('Connection')
          .getByText('Connected', { exact: true }),
      )
      .toBeVisible();

    peer.send(
      jsonFrame(Message.TERM_RESET, {
        generation: 1,
        cols: 80,
        rows: 24,
      }),
    );
    peer.send(
      jsonFrame(Message.PROCESS_STATE, {
        generation: 1,
        state: 'running',
        pid: 42,
        started_at: 1,
        exit_code: null,
        signal: null,
      }),
    );
    await expect
      .element(page.getByLabelText('Process status').getByText('running'))
      .toBeVisible();

    const timing = root.querySelector('[aria-label="Startup timing"]');
    expect(timing).not.toBeNull();
    expect(
      [...timing!.querySelectorAll('dt')].map((term) => term.textContent),
    ).toEqual([
      'UI ready',
      'Code-entry wait',
      'Wasm transfer',
      'Wasm initialization',
      'Relay / Meow handshake',
      'Authentication / admission',
      'Terminal ready',
      'Startup excluding code entry',
    ]);
    expect(
      [...timing!.querySelectorAll('dd')].every(
        (value) => value.textContent !== 'Pending',
      ),
    ).toBe(true);
    await expect
      .element(page.getByTestId('startup-targets'))
      .toHaveTextContent(
        /^Warm target \(<3 s\): (?:met|missed)\. Cold target \(<15 s\): (?:met|missed)\.$/u,
      );
  });

  it('keeps failed proofs explicit and disables attempts for Host cooldown', async () => {
    const discovery = hostPeer(authChallengeFrame(new Uint8Array(32).fill(5)));
    const rejected = hostPeer(
      authChallengeFrame(new Uint8Array(32).fill(6)),
      errorFrame('AUTH_FAILED'),
    );
    const throttled = hostPeer(
      authChallengeFrame(new Uint8Array(32).fill(7)),
      errorFrame('AUTH_THROTTLED', 1500),
    );
    vi.mocked(dialTailcat)
      .mockResolvedValueOnce(discovery.stream)
      .mockResolvedValueOnce(rejected.stream)
      .mockResolvedValueOnce(throttled.stream);
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);

    const submit = async (code: string): Promise<void> => {
      await userEvent.fill(
        page.getByRole('textbox', { name: 'Access code' }),
        code,
      );
      await userEvent.click(page.getByRole('button', { name: 'Connect' }));
    };
    await submit('23456789ABCDEFGH');
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Authentication failed.');
    expect((root.querySelector('#access-code') as HTMLInputElement).value).toBe(
      '',
    );

    await submit('23456789ABCDEFGH');
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Authentication attempts are temporarily limited.');
    await expect
      .element(page.getByText(/^Retry in [12] seconds\.$/u))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Connect' }))
      .toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(dialTailcat).toHaveBeenCalledTimes(3);
  });

  it('erases form and in-memory session state before page-cache restoration', async () => {
    const discovery = hostPeer(authChallengeFrame(new Uint8Array(32).fill(9)));
    vi.mocked(dialTailcat).mockResolvedValueOnce(discovery.stream);
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    const field = page.getByRole('textbox', { name: 'Access code' });
    await userEvent.fill(field, '2345-6789-abcd-efgh');
    expect(root.innerHTML).not.toContain('2345-6789');
    expect(history.state).toBeNull();
    expect(Object.entries(localStorage)).toEqual([]);
    expect(Object.entries(sessionStorage)).toEqual([]);

    await act(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
    });
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.querySelector('[aria-label="Leash terminal"]')).toBeNull();
    expect(root.textContent).not.toContain('2345-6789');
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Request a new link from the host.');
  });
});

describe('application static-cache scheduling', () => {
  it('renders actual download progress and removes it after loading', async () => {
    const loaded = Promise.withResolvers<void>();
    let report: ((percent: number) => void) | undefined;
    vi.mocked(loadTailcat).mockImplementation((options) => {
      report = options?.onProgress;
      return loaded.promise;
    });
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    const progress = page.getByRole('progressbar', {
      name: 'Tailcat WebAssembly download',
    });
    await expect.element(progress).toHaveAttribute('value', '0');
    await act(() => report?.(50));
    await expect.element(progress).toHaveAttribute('value', '50');
    await expect.element(page.getByText('50%', { exact: true })).toBeVisible();
    await act(() => loaded.resolve());
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Tailcat connection failed.');
    expect(root.querySelector('progress')).toBeNull();
  });

  it('registers on an uninvited page without starting the transport', async () => {
    const register = vi
      .spyOn(navigator.serviceWorker, 'register')
      .mockResolvedValue({} as ServiceWorkerRegistration);
    await mount(false);
    await expect
      .element(page.getByText(/^Static cache registered;/u))
      .toBeVisible();
    expect(register).toHaveBeenCalledExactlyOnceWith('./service-worker.js', {
      updateViaCache: 'none',
    });
    expect(loadTailcat).not.toHaveBeenCalled();
    expect(dialTailcat).not.toHaveBeenCalled();
  });

  it('keeps precaching out of the first runtime download', async () => {
    const loaded = Promise.withResolvers<void>();
    vi.mocked(loadTailcat).mockReturnValue(loaded.promise);
    const register = vi
      .spyOn(navigator.serviceWorker, 'register')
      .mockResolvedValue({} as ServiceWorkerRegistration);
    await mount(true);
    await expect
      .element(page.getByRole('status'))
      .toHaveTextContent('Loading Tailcat WebAssembly');
    expect(register).not.toHaveBeenCalled();
    expect(dialTailcat).not.toHaveBeenCalled();
    await act(() => loaded.resolve());
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Tailcat connection failed.');
    await expect
      .element(page.getByText(/^Static cache registered;/u))
      .toBeVisible();
    expect(register).toHaveBeenCalledOnce();
  });

  it('reuses pending registration across an explicit connection retry', async () => {
    const registration = Promise.withResolvers<ServiceWorkerRegistration>();
    const register = vi
      .spyOn(navigator.serviceWorker, 'register')
      .mockReturnValue(registration.promise);
    await mount(true);
    await expect
      .element(page.getByRole('button', { name: 'Retry connection' }))
      .toBeVisible();
    expect(register).toHaveBeenCalledOnce();

    const loaded = Promise.withResolvers<void>();
    vi.mocked(loadTailcat).mockReturnValueOnce(loaded.promise);
    await userEvent.click(
      page.getByRole('button', { name: 'Retry connection' }),
    );
    await expect
      .element(page.getByRole('status'))
      .toHaveTextContent('Loading Tailcat WebAssembly');
    await act(() => registration.resolve({} as ServiceWorkerRegistration));
    await expect
      .element(page.getByText('Static cache registration pending.'))
      .toBeVisible();
    await act(() => loaded.resolve());
    await expect
      .element(page.getByText(/^Static cache registered;/u))
      .toBeVisible();
    expect(register).toHaveBeenCalledOnce();
    expect(dialTailcat).toHaveBeenCalledTimes(2);
  });

  it('reports cache failure safely and ignores completion after unmount', async () => {
    vi.mocked(loadTailcat).mockRejectedValue(
      new TailcatTransportError('WASM_FETCH_FAILED'),
    );
    const registration = Promise.withResolvers<ServiceWorkerRegistration>();
    const register = vi
      .spyOn(navigator.serviceWorker, 'register')
      .mockReturnValue(registration.promise);
    await mount(true);
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Tailcat WebAssembly failed to download.');
    expect(register).toHaveBeenCalledOnce();
    expect(dialTailcat).not.toHaveBeenCalled();
    await act(() => registration.reject(new Error('tcSyntheticDoNotDisplay')));
    await expect
      .element(
        page.getByText(
          'Static cache unavailable. This session can continue online.',
        ),
      )
      .toBeVisible();
    expect(root.textContent).not.toContain('tcSyntheticDoNotDisplay');

    await act(() => render(null, root));
    const late = Promise.withResolvers<ServiceWorkerRegistration>();
    register.mockReturnValueOnce(late.promise);
    await mount(false);
    await act(() => render(null, root));
    await act(() => late.resolve({} as ServiceWorkerRegistration));
    expect(root.childElementCount).toBe(0);
  });
});

function leashWelcome(accessMode: 'code' | 'link'): Frame {
  return {
    type: Message.SERVER_WELCOME,
    payload: new TextEncoder().encode(
      JSON.stringify({
        protocol: 2,
        mode: 'leash',
        session_state: 'active',
        expires_at: 0,
        relay: {
          mode: 'official',
          host: 'relay.example.com',
          browser_path: 'derp',
        },
        capabilities: ['terminal_input', 'terminal_output'],
        access_mode: accessMode,
      }),
    ),
  };
}

function jsonFrame(type: Frame['type'], value: unknown): Frame {
  return {
    type,
    payload: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function hostPeer(first: Frame, afterProof?: Frame) {
  const chunks: Array<Uint8Array | null> = [];
  const writes: Uint8Array[] = [];
  let reader: ((chunk: Uint8Array | null) => void) | undefined;
  const push = (chunk: Uint8Array | null): void => {
    if (reader !== undefined) {
      const resolve = reader;
      reader = undefined;
      resolve(chunk);
    } else {
      chunks.push(chunk);
    }
  };
  const stream = {
    read: async (): Promise<Uint8Array | null> => {
      if (chunks.length > 0) return chunks.shift()!;
      return new Promise((resolve) => {
        reader = resolve;
      });
    },
    write: async (bytes: Uint8Array): Promise<void> => {
      writes.push(bytes.slice());
      if (bytes[4] === Message.CLIENT_HELLO) {
        push(encodeFrame('host', 'await-server-welcome', first));
      } else if (bytes[4] === Message.AUTH_PROOF && afterProof !== undefined) {
        push(encodeFrame('host', 'await-server-welcome', afterProof));
      } else if (bytes[4] === Message.CLOSE) {
        push(encodeFrame('host', 'active-leash', closeFrame('normal')));
      }
    },
    close: vi.fn(async () => push(null)),
  } satisfies ByteStream;
  return {
    stream,
    writes,
    disconnect: () => push(null),
    send: (frame: Frame) => push(encodeFrame('host', 'active-leash', frame)),
  };
}
