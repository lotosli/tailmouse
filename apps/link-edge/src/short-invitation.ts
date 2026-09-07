import { DurableObject } from 'cloudflare:workers';
import {
  API_PATH,
  CODE,
  LEASE_MS,
  RequestFailure,
  equalHash,
  exact,
  failure,
  readJSON,
  requireEmptyBody,
  reply,
  tokenHash,
  validInvitation,
  validToken,
} from './api.ts';

interface Mapping {
  invitation: string;
  verifier: string;
  expiresAt: number;
}

export class ShortInvitation extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const code = url.pathname.slice(API_PATH.length + 1);
      if (
        url.search ||
        !url.pathname.startsWith(API_PATH + '/') ||
        !CODE.test(code)
      )
        return failure();
      const method = request.method;
      if (!['POST', 'GET', 'PUT', 'DELETE'].includes(method))
        return failure(405);
      let creation: Mapping | undefined;
      let verifier = '';
      if (method === 'POST') {
        const body = await readJSON(request);
        if (
          !exact(body, ['invitation', 'verifier']) ||
          !validInvitation(body.invitation) ||
          !validToken(body.verifier)
        )
          return failure(400);
        creation = {
          invitation: body.invitation,
          verifier: body.verifier,
          expiresAt: Date.now() + LEASE_MS,
        };
      } else {
        await requireEmptyBody(request);
        if (method !== 'GET') {
          const token = request.headers
            .get('authorization')
            ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
          if (!validToken(token)) return failure();
          verifier = await tokenHash(token);
        }
      }
      return await this.ctx.blockConcurrencyWhile(async () => {
        const storage = this.ctx.storage;
        let mapping = await storage.get<Mapping>('mapping');
        const now = Date.now();
        if (mapping && now >= mapping.expiresAt) {
          await storage.deleteAll();
          mapping = undefined;
        }
        if (creation) {
          if (mapping) return failure(409);
          if (!validInvitation(creation.invitation, now)) return failure(400);
          const record = { ...creation, expiresAt: now + LEASE_MS };
          await storage.transaction(async (txn) => {
            await txn.put('mapping', record);
            await txn.setAlarm(record.expiresAt);
          });
          return reply({ expiresAt: record.expiresAt }, 201);
        }
        if (!mapping) return failure();
        if (method === 'GET')
          return reply({
            invitation: mapping.invitation,
            expiresAt: mapping.expiresAt,
          });
        if (!equalHash(mapping.verifier, verifier)) return failure();
        if (method === 'DELETE') {
          await storage.deleteAll();
          return reply(null, 204);
        }
        const renewed = { ...mapping, expiresAt: now + LEASE_MS };
        await storage.transaction(async (txn) => {
          await txn.put('mapping', renewed);
          await txn.setAlarm(renewed.expiresAt);
        });
        return reply({ expiresAt: renewed.expiresAt });
      });
    } catch (error) {
      return failure(error instanceof RequestFailure ? error.status : 503);
    }
  }

  override async alarm(): Promise<void> {
    const complete = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        const mapping = await this.ctx.storage.get<Mapping>('mapping');
        if (mapping && Date.now() < mapping.expiresAt) {
          await this.ctx.storage.setAlarm(mapping.expiresAt);
        } else {
          await this.ctx.storage.deleteAll();
        }
        return true;
      } catch {
        // A rejected concurrency callback resets the object. Persist the
        // backstop before leaving it, while this storage context is usable.
        try {
          await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
        } catch {
          // If storage is unavailable, only the platform alarm retry remains.
        }
        return false;
      }
    });
    if (!complete) throw new Error('cleanup_unavailable');
  }
}
