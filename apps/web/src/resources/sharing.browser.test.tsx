import { render } from 'preact';
import { act } from 'preact/test-utils';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { BrowserShare } from './browser-share.tsx';
import { BrowserHost, type BrowserHostView } from './browser-host.ts';
import { ResourceError } from './wire.ts';
import { FilesPanel, TextPanel } from './transfer-panels.tsx';
import * as transfers from './transfers.ts';
import type { ResourceSession } from './session.ts';

vi.mock('./transfers.ts', { spy: true });
const state = vi.hoisted(() => ({
  failure: false,
  current: undefined as
    { text: (value: string) => void; end: () => void } | undefined,
}));
vi.mock('./browser-host.ts', () => ({
  BrowserHost: class {
    view: BrowserHostView;
    change: (view: BrowserHostView) => void;
    constructor(
      _files: File[],
      text: string,
      change: (view: BrowserHostView) => void,
    ) {
      this.view = {
        status: 'starting',
        text,
        bytes: 0,
        visitors: 0,
        message: 'Starting…',
      };
      this.change = change;
      state.current = {
        text: (value) => this.setText(value),
        end: () => this.close(),
      };
    }
    async start() {
      if (state.failure) throw new Error('Connection failed.');
      this.view = {
        ...this.view,
        status: 'sharing',
        message: 'Keep this page open.',
      };
      this.change(this.view);
    }
    async qr() {
      return ('1' + '0'.repeat(20) + '\n').repeat(21);
    }
    invitation() {
      return 'https://example.invalid/.tailmouse/workspace/#synthetic';
    }
    setText(text: string) {
      this.view = { ...this.view, text };
      this.change(this.view);
    }
    close() {
      this.view = {
        ...this.view,
        status: 'closed',
        text: '',
        message: 'Sharing ended.',
      };
      this.change(this.view);
    }
  },
}));

const root = document.createElement('div');
let copy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.append(root);
  state.failure = false;
  state.current = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ version: 1 }))),
  );
  copy = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
    writeText: copy,
  } as unknown as Clipboard);
});
afterEach(() => {
  render(null, root);
  root.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('starts browser sharing, copies its link, exchanges text and ends access', async () => {
  render(<BrowserShare />, root);
  await page.getByLabelText('Text to share').fill('initial text');
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByLabelText('Private sharing link'))
    .toBeVisible();
  await page.getByLabelText('Private sharing link').click();
  await page.getByRole('button', { name: 'Copy sharing link' }).click();
  expect(copy).toHaveBeenCalledOnce();
  await page.getByLabelText('Text to share').fill('host update');
  await page.getByRole('button', { name: 'Update shared text' }).click();
  await expect
    .element(page.getByText('host update', { exact: true }))
    .toBeVisible();
  await act(() => state.current?.text('visitor reply'));
  await page.getByRole('button', { name: 'Copy received text' }).click();
  expect(copy).toHaveBeenLastCalledWith('visitor reply');
  await page.getByRole('button', { name: 'End browser sharing' }).click();
  await expect
    .element(page.getByRole('button', { name: 'Start browser sharing' }))
    .toBeVisible();
  await expect
    .element(page.getByLabelText('Private sharing link'))
    .not.toBeInTheDocument();
});
it('shows start failures and clipboard fallback without losing the sharing controls', async () => {
  state.failure = true;
  render(<BrowserShare />, root);
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('Connection failed.');
  state.failure = false;
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  copy.mockRejectedValue(new Error('Denied.'));
  await page.getByRole('button', { name: 'Copy sharing link' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Action notice' }))
    .toHaveTextContent('Select and copy');
  await act(() => state.current?.text('reply'));
  await page.getByRole('button', { name: 'Copy received text' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Action notice' }))
    .toHaveTextContent('Select and copy the text');
  window.dispatchEvent(new PageTransitionEvent('pagehide'));
  await expect
    .element(page.getByRole('button', { name: 'Start browser sharing' }))
    .toBeVisible();
});
it('rejects invalid public configuration before creating an invitation', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('no', { status: 500 }));
  render(<BrowserShare />, root);
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('configuration unavailable');
  vi.mocked(fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ derpMap: 42 })),
  );
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('Invalid relay');
});
it('browses shared folders, downloads and verifies a file, and reports failures', async () => {
  const file = {
    name: 'result.txt',
    path: 'nested/result.txt',
    dir: false,
    size: 3,
  };
  const folder = { name: 'nested', path: 'nested', dir: true, size: 0 };
  vi.spyOn(transfers, 'listFiles').mockImplementation(
    async (_session, path = '', offset = 0) => ({
      type: 'files.list',
      path,
      entries: path === '' ? [folder] : [file],
      next: offset + 40,
      more: offset === 0,
    }),
  );
  const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
  vi.spyOn(transfers, 'chooseDownload').mockResolvedValue(sink);
  vi.spyOn(transfers, 'downloadFile').mockImplementation(
    async (_session, _file, _sink, _signal, progress) => {
      progress(3);
    },
  );
  render(<FilesPanel session={{} as ResourceSession} enabled />, root);
  await page.getByRole('button', { name: 'Open folder nested' }).click();
  await page.getByRole('button', { name: 'Download result.txt' }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Download verified');
  await page.getByRole('button', { name: 'Next page' }).click();
  await page.getByRole('button', { name: 'Previous page' }).click();
  await page.getByRole('button', { name: 'Parent folder' }).click();
  await page.getByRole('button', { name: 'Refresh files' }).click();
  vi.mocked(transfers.listFiles).mockRejectedValueOnce(
    new Error('Unavailable.'),
  );
  await page.getByRole('button', { name: 'Refresh files' }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Could not read');
});
it('cancels downloads and shows save errors', async () => {
  const file = { name: 'a.txt', path: 'a.txt', dir: false, size: 3 };
  vi.spyOn(transfers, 'listFiles').mockResolvedValue({
    type: 'files.list',
    path: '',
    entries: [file],
    next: 1,
    more: false,
  });
  vi.spyOn(transfers, 'chooseDownload').mockResolvedValue({
    write: vi.fn(),
    close: vi.fn(),
    abort: vi.fn(),
  });
  vi.spyOn(transfers, 'downloadFile').mockImplementation(
    async (_session, _file, _sink, signal, progress) => {
      progress(1);
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new Error('Download canceled.')),
          { once: true },
        ),
      );
    },
  );
  render(<FilesPanel session={{} as ResourceSession} enabled />, root);
  await page.getByRole('button', { name: 'Download a.txt' }).click();
  await page.getByRole('button', { name: 'Cancel download' }).click();
  await expect.element(page.getByRole('status')).toHaveTextContent('canceled');
  vi.mocked(transfers.chooseDownload).mockRejectedValueOnce(
    new Error('Use a streaming browser.'),
  );
  await page.getByRole('button', { name: 'Download a.txt' }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('streaming browser');
});
it('reads and deliberately sends text and handles copy/send failures', async () => {
  vi.spyOn(transfers, 'exchangeText').mockImplementation(
    async (_session, text) => text ?? 'host text',
  );
  render(<TextPanel session={{} as ResourceSession} enabled />, root);
  await expect
    .element(page.getByText('host text', { exact: true }))
    .toBeVisible();
  await page.getByRole('button', { name: 'Copy text', exact: true }).click();
  expect(copy).toHaveBeenCalledWith('host text');
  await page.getByLabelText('Shared text draft').fill('reply');
  await page
    .getByRole('button', { name: 'Update shared text', exact: true })
    .click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Shared text updated');
  copy.mockRejectedValueOnce(new Error('Denied.'));
  await page.getByRole('button', { name: 'Copy text', exact: true }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Clipboard unavailable');
  vi.mocked(transfers.exchangeText).mockRejectedValueOnce(
    new Error('Disconnected.'),
  );
  await page.getByRole('button', { name: 'Refresh text', exact: true }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Text unavailable');
  vi.mocked(transfers.exchangeText).mockRejectedValueOnce(
    new Error('Disconnected.'),
  );
  await page
    .getByRole('button', { name: 'Update shared text', exact: true })
    .click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('not confirmed');
});

it('corrects duplicate file selections before creating a session', async () => {
  render(<BrowserShare />, root);
  const input = page
    .getByLabelText('Files to share')
    .element() as HTMLInputElement;
  const selected = new DataTransfer();
  selected.items.add(new File(['a'], 'same.txt'));
  selected.items.add(new File(['b'], 'same.txt'));
  await act(() => {
    input.files = selected.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect
    .element(page.getByRole('button', { name: 'Start browser sharing' }))
    .toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove same.txt, item 1', exact: true })
    .click();
  await expect
    .element(page.getByRole('button', { name: 'Start browser sharing' }))
    .toBeEnabled();
  await page.getByRole('button', { name: 'Clear files', exact: true }).click();
  await expect
    .element(page.getByRole('button', { name: 'Clear files', exact: true }))
    .not.toBeInTheDocument();
});

it('keeps server closure visible even while a copied-link notice is present', async () => {
  render(<BrowserShare />, root);
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await page.getByRole('button', { name: 'Copy sharing link' }).click();
  await act(() => state.current?.end());
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('Sharing ended.');
  await expect
    .element(page.getByLabelText('Private sharing link'))
    .not.toBeInTheDocument();
});

it('shares through the native sheet and handles cancellation and failure without ending access', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  const original = Object.getOwnPropertyDescriptor(navigator, 'share');
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: share,
  });
  try {
    render(<BrowserShare />, root);
    await page.getByRole('button', { name: 'Start browser sharing' }).click();
    await page.getByRole('button', { name: 'Share link…' }).click();
    await expect
      .element(page.getByRole('status', { name: 'Action notice' }))
      .toHaveTextContent('Sharing sheet');
    share.mockRejectedValueOnce(new DOMException('Canceled', 'AbortError'));
    await page.getByRole('button', { name: 'Share link…' }).click();
    await expect
      .element(page.getByRole('status', { name: 'Action notice' }))
      .toHaveTextContent('session is still open');
    share.mockRejectedValueOnce(new Error('Not supported'));
    await page.getByRole('button', { name: 'Share link…' }).click();
    await expect
      .element(page.getByRole('status', { name: 'Action notice' }))
      .toHaveTextContent('Copy the private link');
    await expect
      .element(page.getByRole('button', { name: 'End browser sharing' }))
      .toBeVisible();
    expect(share).toHaveBeenCalledWith({
      title: 'TailMouse private sharing',
      url: 'https://example.invalid/.tailmouse/workspace/#synthetic',
    });
  } finally {
    if (original) Object.defineProperty(navigator, 'share', original);
    else Reflect.deleteProperty(navigator, 'share');
  }
});

it('explains a browser download limit before attempting an unsupported file', async () => {
  vi.spyOn(transfers, 'listFiles').mockResolvedValue({
    type: 'files.list',
    path: '',
    entries: [
      {
        name: 'large.bin',
        path: 'large.bin',
        dir: false,
        size: 65 * 1024 * 1024,
      },
    ],
    next: 1,
    more: false,
  });
  vi.stubGlobal('showSaveFilePicker', undefined);
  render(<FilesPanel session={{} as ResourceSession} enabled />, root);
  await expect
    .element(page.getByRole('button', { name: 'Download large.bin' }))
    .toBeDisabled();
  await expect
    .element(page.getByText(/This browser can download files up to/))
    .toHaveTextContent('64.0 MiB');
});

it('preserves a newer shared-text draft while an earlier update is in flight', async () => {
  const pending = Promise.withResolvers<string>();
  vi.spyOn(transfers, 'exchangeText')
    .mockResolvedValueOnce('initial')
    .mockReturnValueOnce(pending.promise);
  render(<TextPanel session={{} as ResourceSession} enabled />, root);
  await expect
    .element(page.getByText('initial', { exact: true }))
    .toBeVisible();
  await page.getByLabelText('Shared text draft').fill('first update');
  await page
    .getByRole('button', { name: 'Update shared text', exact: true })
    .click();
  await page.getByLabelText('Shared text draft').fill('new unsent draft');
  pending.resolve('first update');
  await expect
    .element(page.getByLabelText('Shared text draft'))
    .toHaveValue('new unsent draft');
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Shared text updated');
});

it('supports drag/drop before sharing and protects an active hosting page', async () => {
  render(<BrowserShare />, root);
  const zone = page
    .getByText('Drop files here or choose files', { exact: true })
    .element();
  const transfer = new DataTransfer();
  transfer.items.add(new File(['drop'], 'drop.txt'));
  await act(() => {
    zone.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    zone.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect
    .element(page.getByRole('button', { name: 'Remove drop.txt, item 1' }))
    .toBeVisible();
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  const warning = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(warning);
  expect(warning.defaultPrevented).toBe(true);
  await act(() => {
    zone.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await expect
    .element(page.getByRole('button', { name: 'Remove drop.txt, item 2' }))
    .not.toBeInTheDocument();
});

it('retains a usable private link if local QR generation fails', async () => {
  vi.spyOn(BrowserHost.prototype, 'qr').mockRejectedValue(
    new Error('Unavailable'),
  );
  render(<BrowserShare />, root);
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Action notice' }))
    .toHaveTextContent('Copy the private link instead');
  await expect
    .element(page.getByLabelText('Private sharing link'))
    .toBeVisible();
});

it('clears transient notices without losing persistent session guidance', async () => {
  render(<BrowserShare />, root);
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  vi.useFakeTimers();
  const button = page
    .getByRole('button', { name: 'Copy sharing link' })
    .element() as HTMLButtonElement;
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5001);
  });
  await expect
    .element(page.getByRole('status', { name: 'Action notice' }))
    .toHaveTextContent('');
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('Keep this page open');
});

it('keeps selection and explains malformed configuration', async () => {
  vi.mocked(fetch).mockResolvedValueOnce(new Response('null'));
  render(<BrowserShare />, root);
  await page.getByLabelText('Text to share').fill('keep this draft');
  await page.getByRole('button', { name: 'Start browser sharing' }).click();
  await expect
    .element(page.getByRole('status', { name: 'Session status' }))
    .toHaveTextContent('Invalid sharing configuration');
  await expect
    .element(page.getByLabelText('Text to share'))
    .toHaveValue('keep this draft');
});

it('offers deliberate download retry after an actionable transfer error', async () => {
  const file = { name: 'retry.txt', path: 'retry.txt', dir: false, size: 3 };
  vi.spyOn(transfers, 'listFiles').mockResolvedValue({
    type: 'files.list',
    path: '',
    entries: [file],
    next: 1,
    more: false,
  });
  vi.spyOn(transfers, 'chooseDownload').mockResolvedValue({
    write: vi.fn(),
    close: vi.fn(),
    abort: vi.fn(),
  });
  vi.spyOn(transfers, 'downloadFile')
    .mockRejectedValueOnce(new ResourceError('TRANSFER_LIMIT'))
    .mockImplementationOnce(
      async (_session, _file, _sink, _signal, progress) => {
        progress(3);
      },
    );
  render(<FilesPanel session={{} as ResourceSession} enabled />, root);
  await page.getByRole('button', { name: 'Download retry.txt' }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Ask the host before retrying');
  await page.getByRole('button', { name: 'Retry download' }).click();
  await expect
    .element(page.getByRole('status'))
    .toHaveTextContent('Download verified');
});
