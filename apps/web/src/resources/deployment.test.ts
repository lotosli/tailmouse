import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateContentOrigin, validateTestEntry } from './deployment.ts';

const session = 'a'.repeat(32);
function configure(config: unknown, origin: string) {
  vi.stubGlobal('location', { origin });
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify(config))),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe('preview origin allowlist', () => {
  it('accepts only the exact session origins and fetches configuration without credentials or cache', async () => {
    configure(
      {
        version: 1,
        frontendBase: 'https://front.test',
        contentBase: 'https://preview.test',
      },
      `https://s-${session}.front.test`,
    );
    await validateContentOrigin(
      `https://a-${session}-web.preview.test`,
      session,
    );
    expect(fetch).toHaveBeenCalledWith(
      '/tailmouse-config.json',
      expect.objectContaining({ credentials: 'omit', cache: 'no-store' }),
    );
    await expect(
      validateContentOrigin('https://attacker.test', session),
    ).rejects.toThrow('incompatible');
  });
  it('requires an explicit matching same-origin test configuration', async () => {
    configure(
      {
        version: 1,
        frontendBase: 'https://front.test',
        contentBase: 'https://front.test',
        testSingleOrigin: true,
      },
      'https://front.test',
    );
    await validateTestEntry();
    await expect(
      validateContentOrigin('https://front.test', session),
    ).rejects.toThrow();
    configure(
      {
        version: 1,
        frontendBase: 'https://front.test',
        contentBase: 'https://front.test',
      },
      'https://front.test',
    );
    await expect(validateTestEntry()).rejects.toThrow();
  });
  it.each([
    { version: 2 },
    { version: 1, frontendBase: 1, contentBase: 'https://preview.test' },
    {
      version: 1,
      frontendBase: 'http://front.test',
      contentBase: 'https://preview.test',
    },
    {
      version: 1,
      frontendBase: 'https://user:pass@front.test',
      contentBase: 'https://preview.test',
    },
    {
      version: 1,
      frontendBase: 'https://front.test/path',
      contentBase: 'https://preview.test',
    },
    {
      version: 1,
      frontendBase: 'https://front.test?x=1',
      contentBase: 'https://preview.test',
    },
    {
      version: 1,
      frontendBase: 'https://front.test#x',
      contentBase: 'https://preview.test',
    },
    {
      version: 1,
      frontendBase: 'https://front.test',
      contentBase: 'https://child.front.test',
    },
  ])('rejects unsafe deployment configuration', async (config) => {
    configure(config, `https://s-${session}.front.test`);
    await expect(
      validateContentOrigin('https://preview.test', session),
    ).rejects.toThrow('configuration');
  });
  it('bounds configuration responses and fails on fetch errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x'.repeat(4097))),
    );
    await expect(validateTestEntry()).rejects.toThrow();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 503 })),
    );
    await expect(validateContentOrigin('', '')).rejects.toThrow();
  });
});
