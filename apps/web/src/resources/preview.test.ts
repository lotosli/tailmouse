import { describe, expect, it, vi } from 'vitest';
import { allowedPreviewPath, bridgeHTTP, bridgeSocket } from './preview.ts';
import type { ResourceSession } from './session.ts';
import type { ResourceWire } from './wire.ts';

describe('preview request boundary', () => {
  it.each([
    '//external.test',
    '/\\external.test',
    '/.tailmouse/workspace/',
    '/x\n',
    'https://external.test/',
    '/' + 'a'.repeat(8192),
    null,
  ])('rejects a path outside the app namespace', (path) => {
    expect(allowedPreviewPath(path)).toBe(false);
  });
  it('allows bounded app-relative paths and queries', () => {
    expect(allowedPreviewPath('/app?q=ok')).toBe(true);
  });
  it('rejects malformed methods, headers and socket targets before opening transport', async () => {
    const open = vi.fn();
    const session = { open } as unknown as ResourceSession;
    const channel = new MessageChannel();
    const signal = new AbortController().signal;
    try {
      for (const request of [
        { method: 'CONNECT', path: '/', headers: [] },
        { method: 'GET', path: '/', headers: [1] },
        { method: 'GET', path: '/', headers: [], credentials: 'secret' },
      ])
        await expect(
          bridgeHTTP(session, channel.port1, request, signal),
        ).rejects.toThrow('Invalid preview request');
      await expect(
        bridgeSocket(
          session,
          channel.port1,
          { path: '//elsewhere', protocols: [] },
          signal,
        ),
      ).rejects.toThrow('Invalid socket target');
      expect(open).not.toHaveBeenCalled();
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
  it('streams a fixed web response with acknowledgments and releases it at completion', async () => {
    const channel = new MessageChannel();
    const messages: Record<string, unknown>[] = [];
    let nextFrame = 0;
    const wire = {
      json: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      object: async () => ({
        type: 'response',
        status: 200,
        headers: [['content-type', 'text/plain']],
      }),
      read: async () =>
        nextFrame++ === 0
          ? { kind: 2, data: new Uint8Array([111, 107]) }
          : { kind: 3, data: new Uint8Array() },
    } as unknown as ResourceWire;
    const open = vi.fn().mockResolvedValue(wire);
    const release = vi.fn().mockResolvedValue(undefined);
    channel.port2.onmessage = (
      event: MessageEvent<Record<string, unknown>>,
    ) => {
      messages.push(event.data);
      if (event.data.type === 'response.data')
        channel.port2.postMessage({ type: 'response.ack' });
    };
    try {
      const response = bridgeHTTP(
        { open, release } as unknown as ResourceSession,
        channel.port1,
        { method: 'GET', path: '/example', headers: [] },
        new AbortController().signal,
      );
      channel.port2.postMessage({ type: 'body.end' });
      await response;
      await vi.waitFor(() =>
        expect(messages.at(-1)?.type).toBe('response.end'),
      );
      expect(open).toHaveBeenCalledWith('http', 'web');
      expect(messages[0]).toMatchObject({ type: 'response', status: 200 });
      expect(messages[1]?.data).toEqual(new Uint8Array([111, 107]));
      expect(release).toHaveBeenCalledWith(wire);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
  it('validates websocket open and close while preserving the fixed resource', async () => {
    const channel = new MessageChannel();
    const object = vi
      .fn()
      .mockResolvedValueOnce({ type: 'websocket.open', protocol: 'test' })
      .mockResolvedValueOnce({ type: 'websocket.close', code: 1000 });
    const wire = {
      object,
      json: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResourceWire;
    const open = vi.fn().mockResolvedValue(wire);
    const release = vi.fn();
    const messages: unknown[] = [];
    channel.port2.onmessage = (event: MessageEvent) => {
      messages.push(event.data);
    };
    try {
      await bridgeSocket(
        { open, release } as unknown as ResourceSession,
        channel.port1,
        { path: '/socket', protocols: ['test'] },
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(messages).toHaveLength(2));
      expect(messages).toEqual([
        { type: 'websocket.open', protocol: 'test' },
        { type: 'websocket.close', code: 1000 },
      ]);
      expect(open).toHaveBeenCalledWith('websocket', 'web');
      expect(release).toHaveBeenCalledWith(wire);
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
  });
});
