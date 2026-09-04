import { encode } from 'cborg';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { App } from './app.tsx';
import {
  dialTailcat,
  loadTailcat,
  TailcatTransportError,
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
    a: 1,
    e: 0,
    m: 'leash',
    p: 44321,
    s: new Uint8Array(16).fill(7),
    t: 'tcSyntheticCacheSchedulingCredential',
    v: 1,
    z: 1,
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
  it('explains bearer access without implying an extra password prompt', async () => {
    vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue(
      {} as ServiceWorkerRegistration,
    );
    await mount(true);
    await expect
      .element(page.getByText(/^Treat this invitation link like a password\./u))
      .toHaveTextContent(
        "Anyone with it can use the host's shared permissions until expiry or revocation; no separate password is required.",
      );
    expect(root.querySelector('input[type="password"]')).toBeNull();
    expect(root.textContent).not.toContain(
      'tcSyntheticCacheSchedulingCredential',
    );
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
