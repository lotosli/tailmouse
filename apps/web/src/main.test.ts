import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  render: vi.fn(),
  consume: vi.fn(),
  home: () => null,
  share: () => null,
  workspace: () => null,
  legacy: () => null,
}));
vi.mock('preact', () => ({ render: state.render }));
vi.mock('./app.tsx', () => ({ App: state.legacy }));
vi.mock('./resources/landing.tsx', () => ({ ResourceLanding: state.home }));
vi.mock('./resources/browser-share.tsx', () => ({ BrowserShare: state.share }));
vi.mock('./resources/workspace.tsx', () => ({ ResourceApp: state.workspace }));
vi.mock('./resources/invitation.ts', () => ({
  consumeRecovery: state.consume,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
async function route(
  pathname = '/',
  hash = '',
  hostname = 'localhost',
  search = '',
) {
  class Element {}
  const root = new Element();
  const location = {
    pathname,
    hash,
    hostname,
    search,
    origin: `https://${hostname}`,
    replace: vi.fn(),
  };
  const history = { replaceState: vi.fn() };
  let change!: () => void;
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('document', { querySelector: () => root });
  vi.stubGlobal('location', location);
  vi.stubGlobal('history', history);
  vi.stubGlobal('sessionStorage', {});
  vi.stubGlobal('window', {
    addEventListener: (_name: string, callback: () => void) => {
      change = callback;
    },
  });
  vi.resetModules();
  await import('./main.tsx');
  return {
    location,
    history,
    change: () => change(),
    last: () =>
      state.render.mock.lastCall?.[0] as {
        type: unknown;
        props: Record<string, unknown>;
      } | null,
  };
}
it('starts in the task landing and changes to browser sharing without losing anchor navigation', async () => {
  const page = await route();
  expect(page.last()?.type).toBe(state.home);
  const before = state.render.mock.calls.length;
  page.location.hash = '#guide';
  page.change();
  expect(state.render).toHaveBeenCalledTimes(before);
  page.location.hash = '#share';
  page.change();
  expect(page.last()?.type).toBe(state.share);
  page.location.hash = '#get-started';
  page.change();
  expect(page.last()?.type).toBe(state.home);
});
it('routes a private resource invitation through its one-shot consumer', async () => {
  const page = await route('/', '#tm=synthetic');
  expect(page.last()?.type).toBe(state.workspace);
  expect(state.consume).toHaveBeenCalledOnce();
  page.location.hash = '#tm=another-synthetic';
  page.change();
  expect(state.consume).toHaveBeenCalledTimes(2);
});
it('shows a safe workspace error if recovery storage is unavailable', async () => {
  state.consume.mockImplementationOnce(() => {
    throw new Error('private details');
  });
  const page = await route('/.tailmouse/workspace/');
  expect(page.history.replaceState).toHaveBeenCalledWith(
    null,
    '',
    '/.tailmouse/workspace/',
  );
  expect(page.last()?.props).toEqual({
    recovery: null,
    initialError: 'The invitation or browser recovery storage is unavailable.',
  });
  expect(JSON.stringify(state.render.mock.calls)).not.toContain(
    'private details',
  );
});
it('recognizes a resource host and keeps the legacy terminal fallback separate', async () => {
  const page = await route('/', '', 's-' + 'a'.repeat(32) + '.example.test');
  expect(page.last()?.type).toBe(state.workspace);
  page.location.hostname = 'localhost';
  page.location.pathname = '/legacy';
  page.change();
  expect(page.last()?.type).toBe(state.legacy);
  page.location.pathname = '/';
  page.location.hash = '#share';
  page.change();
  expect(page.last()?.type).toBe(state.share);
});

it.each([
  '',
  '#share',
  '#guide',
  '#get-started',
  '#workflow',
  '#permissions',
  '#compatibility',
])(
  'uses the canonical product site for ordinary legacy-origin navigation %s',
  async (hash) => {
    const page = await route(
      '/',
      hash,
      'link.tailmouse.com',
      '?synthetic-query',
    );
    expect(page.location.replace).toHaveBeenCalledWith(
      'https://tailmouse.com/' + hash,
    );
    expect(state.render).not.toHaveBeenCalled();
    expect(state.consume).not.toHaveBeenCalled();
  },
);
it.each([
  ['/', '#/v1/synthetic', 'link.tailmouse.com'],
  ['/AbCd12', '', 'link.tailmouse.com'],
  ['/', '#tm=synthetic', 'link.tailmouse.com'],
  ['/', '#share', 'link.tailmouse.com.example.test'],
  ['/', '#guide', 'self-hosted.example.test'],
])(
  'never redirects credential, short locator or self-hosted navigation',
  async (path, hash, host) => {
    const page = await route(path, hash, host);
    expect(page.location.replace).not.toHaveBeenCalled();
    expect(state.render).toHaveBeenCalled();
  },
);
