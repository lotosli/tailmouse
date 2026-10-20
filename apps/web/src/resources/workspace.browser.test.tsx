import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { ResourceLanding } from './landing.tsx';
import { ResourceApp } from './workspace.tsx';
import {
  ResourceSession,
  type SessionView,
  type UploadReceipt,
} from './session.ts';
import { ResourceError, type ResourceWire } from './wire.ts';
import type { Recovery } from './invitation.ts';

vi.mock('./session.ts', { spy: true });
const root = document.createElement('div');
const recovery: Recovery = {
  invitation: {
    v: 1,
    frontend_major: 1,
    session: 'a'.repeat(32),
    token: 'A'.repeat(43),
    address: 'synthetic',
  },
  key: '',
  member: '',
  grant: '',
  expires: 0,
};
const receipt: UploadReceipt = {
  type: 'upload.completed',
  upload: 'a'.repeat(32),
  name: 'host-renamed.txt',
  path: 'uploads/host-renamed.txt',
  size: 5,
  sha256: 'b'.repeat(64),
};
let listener: ((view: SessionView) => void) | undefined;
let view: SessionView;
let connects = 0;
let clipboard: ReturnType<typeof vi.fn<(text: string) => Promise<void>>>;
beforeEach(() => {
  connects = 0;
  document.body.append(root);
  clipboard = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({
    writeText: clipboard,
  } as unknown as Clipboard);
  view = {
    status: 'active',
    message: 'Connected',
    controller: false,
    expiring: false,
    manifest: {
      title: 'Synthetic workspace',
      resources: [
        {
          id: 'receive',
          state: 'READY',
          maxFile: 256 * 1024 * 1024,
          maxTotal: 1024 * 1024 * 1024,
          maxFiles: 100,
        },
      ],
      contentOrigin: '',
      transport: 'test',
    },
  };
  vi.spyOn(ResourceSession.prototype, 'view', 'get').mockImplementation(
    () => view,
  );
  vi.spyOn(ResourceSession.prototype, 'subscribe').mockImplementation((fn) => {
    listener = fn;
    fn(view);
    return () => {
      listener = undefined;
    };
  });
  vi.spyOn(ResourceSession.prototype, 'connect').mockImplementation(
    async () => {
      connects++;
    },
  );
  vi.spyOn(ResourceSession.prototype, 'suspend').mockImplementation(
    () => undefined,
  );
});
afterEach(async () => {
  await act(() => render(null, root));
  root.remove();
  root.replaceChildren();
  vi.restoreAllMocks();
});
async function mountWorkspace() {
  await act(() => render(<ResourceApp recovery={recovery} />, root));
}
async function changeView(next: Partial<SessionView>) {
  view = { ...view, ...next };
  await act(() => listener?.(view));
}
async function chooseFile() {
  const input = root.querySelector<HTMLInputElement>('input[type=file]')!;
  const files = new DataTransfer();
  files.items.add(new File(['hello'], 'original.txt', { type: 'text/plain' }));
  await act(() => {
    input.files = files.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('onboarding and support', () => {
  it('offers a complete first-task path with prerequisites and honest download availability', async () => {
    await act(() => render(<ResourceLanding />, root));
    await expect
      .element(page.getByRole('heading', { name: /Let them test/ }))
      .toBeVisible();
    expect(
      page
        .getByRole('link', { name: 'Get TailMouse', exact: true })
        .elements()[0],
    ).toHaveAttribute('href', '#get-started');
    await expect
      .element(
        page.getByRole('link', {
          name: 'Download v1.0.0 ↗',
          exact: true,
        }),
      )
      .toHaveAttribute(
        'href',
        'https://github.com/lotosli/tailmouse/releases/tag/v1.0.0',
      );
    await page.getByRole('button', { name: 'Windows', exact: true }).click();
    await page
      .getByRole('button', { name: 'Copy Windows install', exact: true })
      .click();
    expect(clipboard).toHaveBeenCalledWith(
      'irm https://tailmouse.com/install.ps1 | iex',
    );
    await page
      .getByRole('button', { name: 'macOS / Linux', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Copy macOS/Linux install', exact: true })
      .click();
    expect(clipboard).toHaveBeenCalledWith(
      'curl -fsSL https://tailmouse.com/install.sh | sh',
    );
    expect(root.textContent).toContain('127.0.0.1:8080');
    expect(root.textContent).toContain('not a sandbox');
    await page
      .getByText('Terminal, folders and receiving files', { exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Copy first-share command' })
      .click();
    expect(clipboard).toHaveBeenCalledWith(
      'mkdir -p ./tailmouse-uploads\ntailmouse receive ./tailmouse-uploads',
    );
    await expect
      .element(page.getByText('Copied. Review the command before running it.'))
      .toBeVisible();
    await page.getByRole('button', { name: /5 End sharing/ }).click();
    await expect
      .element(
        page.getByRole('heading', {
          name: 'Close access when the task is done.',
        }),
      )
      .toBeVisible();
    await page.getByRole('button', { name: /3 Use the terminal/ }).click();
    await expect
      .element(page.getByText('Review the prepared input before sending.'))
      .toBeVisible();
    clipboard.mockRejectedValueOnce(new Error('private failure detail'));
    await page.getByRole('button', { name: 'Copy Web example' }).click();
    await expect
      .element(
        page.getByText('Copy unavailable. Select and copy the command above.'),
      )
      .toBeVisible();
    expect(root.textContent).not.toContain('private failure detail');
  });
  it('gives a missing-invitation exit and exports only user-inspected diagnostics', async () => {
    await act(() => render(<ResourceApp recovery={null} />, root));
    await expect
      .element(page.getByRole('link', { name: 'TailMouse home' }))
      .toBeVisible();
    await page.getByText('Help & feedback', { exact: true }).click();
    expect(clipboard).not.toHaveBeenCalled();
    await page.getByRole('button', { name: 'Prepare a safe report' }).click();
    await expect
      .element(page.getByLabelText('Feedback report'))
      .toHaveTextContent('Stage: invitation');
    await page.getByRole('button', { name: 'Copy report' }).click();
    expect(clipboard.mock.calls[0]?.[0]).not.toContain('synthetic');
    expect(clipboard.mock.calls[0]?.[0]).not.toContain(location.href);
    expect(root.textContent).toContain('Nothing is sent automatically');
  });
});

describe('workspace outcomes', () => {
  it('prepares a confirmed path for an authorized terminal without executing it', async () => {
    view.controller = true;
    view.manifest!.resources.unshift({
      id: 'cli',
      state: 'READY',
      readOnly: false,
    });
    let first = true;
    const inputs: Uint8Array[] = [];
    const wire = {
      read: async () => {
        if (!first) return new Promise(() => undefined);
        first = false;
        return {
          kind: 1,
          data: new TextEncoder().encode(
            JSON.stringify({
              type: 'terminal',
              running: true,
              controller: true,
              cols: 80,
              rows: 24,
            }),
          ),
        };
      },
      json: async () => undefined,
      write: async (_kind: number, data: Uint8Array) => {
        inputs.push(data);
      },
    } as unknown as ResourceWire;
    vi.spyOn(ResourceSession.prototype, 'open').mockResolvedValue(wire);
    vi.spyOn(ResourceSession.prototype, 'release').mockResolvedValue(undefined);
    vi.spyOn(ResourceSession.prototype, 'upload').mockResolvedValue(receipt);
    await mountWorkspace();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await chooseFile();
    await page
      .getByRole('button', { name: 'Insert into terminal field' })
      .click();
    await expect
      .element(page.getByLabelText('Prepare terminal input'))
      .toHaveValue('uploads/host-renamed.txt');
    expect(inputs).toEqual([]);
    await page.getByRole('button', { name: 'Send text without Enter' }).click();
    expect(inputs.map((b) => new TextDecoder().decode(b))).toEqual([
      'uploads/host-renamed.txt',
    ]);
    await changeView({ controller: false });
    await expect
      .element(page.getByRole('button', { name: 'Ctrl+C', exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole('button', { name: 'Send text without Enter' }))
      .toBeDisabled();
  });
  it('does not confuse 100 percent transfer with a confirmed receipt', async () => {
    let finish!: (receipt: UploadReceipt) => void;
    vi.spyOn(ResourceSession.prototype, 'upload').mockImplementation(
      (_file, _abort, progress) => {
        progress('verifying', 5);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    );
    await mountWorkspace();
    await chooseFile();
    await expect
      .element(page.getByText('Verifying with host · 5 B / 5 B'))
      .toBeVisible();
    expect(root.querySelector('.receipt')).toBeNull();
    await act(() => finish(receipt));
    await expect
      .element(page.getByText('Received by host · 5 B / 5 B'))
      .toBeVisible();
    await expect
      .element(page.getByText('Saved as', { exact: false }))
      .toHaveTextContent('host-renamed.txt');
    await page.getByRole('button', { name: 'Copy path', exact: true }).click();
    expect(clipboard).toHaveBeenCalledWith('uploads/host-renamed.txt');
    expect(
      page
        .getByRole('button', { name: 'Insert into terminal field' })
        .elements(),
    ).toHaveLength(0);
  });
  it('explains host quota failure without pretending to know remaining global traffic', async () => {
    vi.spyOn(ResourceSession.prototype, 'upload').mockRejectedValue(
      new ResourceError('UPLOAD_LIMIT'),
    );
    await mountWorkspace();
    await chooseFile();
    await expect
      .element(page.getByText(/Ask the host to check the limits/))
      .toBeVisible();
    expect(root.textContent).toContain(
      'Failed or canceled transfers use traffic allowance',
    );
    expect(root.textContent).toContain(
      'does not have a live total for other visitors',
    );
    expect(root.querySelector('.receipt')).toBeNull();
  });
  it('provides approval, expiry and reconnect actions and preserves resource consequences after close', async () => {
    await mountWorkspace();
    await changeView({ status: 'waiting' });
    await expect
      .element(page.getByText(/host needs to approve your visit/))
      .toBeVisible();
    await changeView({ status: 'active', expiring: true });
    await expect
      .element(page.getByText(/This session expires in less than five minutes/))
      .toHaveTextContent(
        'Files already confirmed as received stay on the host',
      );
    await changeView({ status: 'disconnected' });
    await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    expect(connects).toBe(2);
    await changeView({ status: 'closed', manifest: null });
    await expect
      .element(page.getByRole('link', { name: 'Version and setup help' }))
      .toBeVisible();
    await expect
      .element(page.getByRole('button', { name: 'Leave workspace' }))
      .toBeDisabled();
    expect(root.textContent).toContain(
      'Files already confirmed as received stay on the host',
    );
    expect(root.textContent).toContain('does not end the host');
    expect(root.textContent).not.toContain(
      'This session expires in less than five minutes',
    );
  });
  it('cancels a queued transfer and does not call cancellation a host receipt', async () => {
    vi.spyOn(ResourceSession.prototype, 'upload').mockImplementation(
      (_file, abort) =>
        new Promise((_resolve, reject) =>
          abort.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    );
    await mountWorkspace();
    await chooseFile();
    await page.getByRole('button', { name: 'Cancel upload' }).click();
    await expect.element(page.getByText('Canceled · 0 B / 5 B')).toBeVisible();
    expect(root.querySelector('.receipt')).toBeNull();
  });
});
