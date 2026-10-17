import { ResourceProtocolError } from './wire.ts';

// This file is served by the trusted UI deployment, never by a sharing host or
// the preview. Exact allowlisting prevents a hostile host choosing a same-site
// content origin. Native startup enforces the public suffix list unless the
// operator explicitly selects the documented single-origin test deployment.
export async function validateContentOrigin(
  origin: unknown,
  session: string,
  singleOrigin = false,
): Promise<void> {
  try {
    const response = await fetch('/tailmouse-config.json', {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 4096) throw new Error();
    const config = JSON.parse(text) as {
      version?: unknown;
      testSingleOrigin?: unknown;
      frontendBase?: unknown;
      contentBase?: unknown;
    };
    if (
      config.version !== 1 ||
      typeof config.frontendBase !== 'string' ||
      typeof config.contentBase !== 'string'
    )
      throw new Error();
    const front = new URL(config.frontendBase),
      content = new URL(config.contentBase);
    for (const base of [front, content])
      if (
        base.protocol !== 'https:' ||
        base.username ||
        base.password ||
        base.search ||
        base.hash ||
        base.pathname !== '/'
      )
        throw new Error();
    if (singleOrigin) {
      if (
        config.testSingleOrigin !== true ||
        front.origin !== content.origin ||
        front.origin !== location.origin ||
        origin !== front.origin
      )
        throw new Error();
      return;
    }
    if (
      front.hostname === content.hostname ||
      content.hostname.endsWith(`.${front.hostname}`) ||
      front.hostname.endsWith(`.${content.hostname}`)
    )
      throw new Error();
    front.hostname = `s-${session}.${front.hostname}`;
    content.hostname = `a-${session}-web.${content.hostname}`;
    if (front.origin !== location.origin || content.origin !== origin)
      throw new Error();
  } catch {
    throw new ResourceProtocolError(
      'Preview deployment configuration is missing or incompatible.',
    );
  }
}

export async function validateTestEntry(): Promise<void> {
  await validateContentOrigin(location.origin, '', true);
}
