import {
  API_PATH,
  CODE,
  ORIGIN,
  REQUEST_MS,
  RequestFailure,
  base64url,
  exact,
  failure,
  randomCode,
  readJSON,
  requireEmptyBody,
  reply,
  tokenHash,
  validInvitation,
} from './api.ts';
import { isStaticLocator, serveStatic } from './static.ts';
export { ShortInvitation } from './short-invitation.ts';

let inFlight = 0;

async function api(
  request: Request,
  env: Env,
  signal: AbortSignal,
): Promise<Response> {
  const url = new URL(request.url);
  const create = url.pathname === API_PATH && request.method === 'POST';
  const code = url.pathname.slice(API_PATH.length + 1);
  if (
    url.search ||
    (!create && (!url.pathname.startsWith(API_PATH + '/') || !CODE.test(code)))
  )
    return failure();
  if (url.origin !== ORIGIN) return failure(400);
  if (!create && !['GET', 'PUT', 'DELETE'].includes(request.method))
    return failure(405);
  if (request.headers.has('origin') && request.headers.get('origin') !== ORIGIN)
    return failure(400);
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip || ip.length > 64) return failure(503);
  const ipLimit = create ? env.CREATE_IP : env.READ_IP;
  const edgeLimit = create ? env.CREATE_EDGE : env.READ_EDGE;
  if (
    !(await ipLimit.limit({ key: ip })).success ||
    !(await edgeLimit.limit({ key: 'edge' })).success
  )
    return failure(429);
  signal.throwIfAborted();
  if (create) {
    const body = await readJSON(request);
    if (
      !exact(body, ['invitation', 'access']) ||
      body.access !== 'code' ||
      !validInvitation(body.invitation)
    )
      return failure(400);
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const managementToken = base64url(tokenBytes);
    tokenBytes.fill(0);
    const verifier = await tokenHash(managementToken);
    for (let attempt = 0; attempt < 8; attempt++) {
      signal.throwIfAborted();
      const allocated = randomCode();
      if (isStaticLocator(allocated)) continue;
      const object = env.SHORT_INVITATIONS.getByName(allocated);
      const result = await object.fetch(
        new Request(`${ORIGIN}${API_PATH}/${allocated}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invitation: body.invitation, verifier }),
          signal,
        }),
      );
      if (result.status === 409) continue;
      if (result.status !== 201) return failure(503);
      const stored = await result.json<{ expiresAt: number }>();
      return reply(
        { code: allocated, managementToken, expiresAt: stored.expiresAt },
        201,
      );
    }
    return failure(503);
  }
  await requireEmptyBody(request);
  const headers = new Headers();
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  return env.SHORT_INVITATIONS.getByName(code).fetch(
    new Request(`${ORIGIN}${API_PATH}/${code}`, {
      method: request.method,
      headers,
      signal,
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      try {
        return await serveStatic(request, env);
      } catch {
        return failure(503);
      }
    }
    if (inFlight >= 64) return failure(429);
    inFlight++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<Response>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failure(503));
      }, REQUEST_MS);
    });
    // A timed-out operation keeps its slot until its actual work releases resources.
    const operation = api(request, env, controller.signal)
      .catch((error: unknown) =>
        failure(error instanceof RequestFailure ? error.status : 503),
      )
      .finally(() => {
        inFlight--;
        if (timer !== null) clearTimeout(timer);
      });
    return Promise.race([operation, deadline]);
  },
};
