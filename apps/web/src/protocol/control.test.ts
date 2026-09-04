import { describe, expect, it } from 'vitest';

import {
  closeFrame,
  decodeClose,
  decodeError,
  decodeWelcome,
  encodeFrame,
  errorFrame,
  FrameDecoder,
  helloFrame,
  Message,
  ProtocolError,
  type CloseReason,
  type Frame,
  type MessageType,
} from './frame.ts';

const payload = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));
const jsonFrame = (type: MessageType, value: unknown): Frame => ({
  type,
  payload: payload(value),
});

describe('TMOUSE/1 typed control boundary', () => {
  it('builds a bounded HELLO without collecting browser identity details', async () => {
    const identifier = Uint8Array.from({ length: 16 }, (_, index) => index);
    const frame = helloFrame(identifier, 'escape');
    const wire = encodeFrame('browser', 'await-client-hello', frame);
    let read = false;
    const decoder = new FrameDecoder({
      close: async () => {},
      write: async () => {},
      read: async () => {
        if (read) return null;
        read = true;
        return wire;
      },
    });
    const decoded = await decoder.read(
      'host',
      'await-client-hello',
      new AbortController().signal,
    );
    expect(decoded?.selectedProtocol).toBe(1);
    expect(
      JSON.parse(new TextDecoder().decode(decoded?.payload)),
    ).toMatchObject({
      session_id: '000102030405060708090a0b0c0d0e0f',
      mode: 'escape',
      client: { name: 'tailmouse-web', platform: 'web', user_agent: '' },
    });
    expect(identifier[15]).toBe(15);
    expect(() => helloFrame(new Uint8Array(16), 'escape')).toThrowError(
      new ProtocolError('BAD_MOUSE_CARD'),
    );
    expect(() => helloFrame(new Uint8Array(17), 'leash')).toThrowError(
      new ProtocolError('BAD_MOUSE_CARD'),
    );
  });

  it('returns immutable host authority and rejects a card-mode mismatch', () => {
    const welcome = {
      protocol: 1,
      mode: 'leash',
      session_state: 'active',
      expires_at: 0,
      relay: {
        mode: 'custom-host',
        host: 'relay.example.com',
        browser_path: 'derp',
      },
      capabilities: ['terminal_output'],
    };
    const frame = jsonFrame(Message.SERVER_WELCOME, welcome);
    const result = decodeWelcome(frame, 'leash');
    expect(result).toEqual({
      mode: 'leash',
      expiresAt: 0,
      relay: {
        mode: 'custom-host',
        host: 'relay.example.com',
        browserPath: 'derp',
      },
      capabilities: ['terminal_output'],
    });
    welcome.capabilities.push('terminal_input');
    expect(result.capabilities).toEqual(['terminal_output']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.relay)).toBe(true);
    expect(Object.isFrozen(result.capabilities)).toBe(true);
    expect(() => decodeWelcome(frame, 'escape')).toThrowError(
      new ProtocolError('MODE_MISMATCH'),
    );
    for (const invalid of [
      { ...welcome, capabilities: ['terminal_output', 'terminal_output'] },
      { ...welcome, capabilities: ['unknown'] },
      { ...welcome, capabilities: [] },
      { ...welcome, expires_at: -1 },
      { ...welcome, protocol: 2 },
      {
        ...welcome,
        relay: { ...welcome.relay, host: 'https://secret.example/' },
      },
    ]) {
      expect(() =>
        decodeWelcome(jsonFrame(Message.SERVER_WELCOME, invalid), 'leash'),
      ).toThrowError(new ProtocolError('BAD_FRAME'));
    }
    expect(() =>
      decodeWelcome(
        { type: Message.PING, payload: new Uint8Array(16) },
        'leash',
      ),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
    expect(() =>
      decodeWelcome(
        { type: Message.SERVER_WELCOME, payload: new Uint8Array(4097) },
        'leash',
      ),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
  });

  it('uses the local stable error vocabulary instead of peer text or retry claims', () => {
    for (const code of [
      'BAD_MOUSE_CARD',
      'EXPIRED',
      'MODE_MISMATCH',
      'PROTOCOL_MISMATCH',
      'SESSION_BUSY',
      'UNAUTHORIZED_CAPABILITY',
      'FRAME_TOO_LARGE',
      'BAD_FRAME',
      'PROCESS_NOT_RUNNING',
      'RESTART_DISABLED',
      'TERMINATE_DISABLED',
      'READONLY',
      'BACKPRESSURE',
      'INTERNAL',
    ] as const) {
      const error = decodeError(
        jsonFrame(Message.ERROR, {
          code,
          message: 'tcSyntheticPeerSecret',
          retryable: true,
        }),
      );
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('tcSyntheticPeerSecret');
      expect(error.retryable).toBe(
        ['SESSION_BUSY', 'PROCESS_NOT_RUNNING', 'BACKPRESSURE'].includes(code),
      );
      const outbound = errorFrame(code);
      const wire = encodeFrame('browser', 'active-leash', outbound);
      expect(wire[4]).toBe(Message.ERROR);
      expect(decodeError(outbound)).toEqual(error);
      expect(new TextDecoder().decode(outbound.payload)).not.toContain(
        'tcSyntheticPeerSecret',
      );
    }
    for (const code of ['CANCELED', 'tcSyntheticUnknownCode']) {
      expect(() => errorFrame(code as never)).toThrowError(
        new ProtocolError('BAD_FRAME'),
      );
    }
    for (const value of [
      {},
      { code: 'CANCELED', message: 'safe', retryable: false },
      { code: 'INTERNAL', message: 'safe', retryable: null },
      { code: 'INTERNAL', message: 'x'.repeat(257), retryable: false },
      { code: 'INTERNAL', message: '', retryable: false },
      { code: 'INTERNAL', message: 'safe', retryable: false, extra: true },
    ]) {
      expect(() => decodeError(jsonFrame(Message.ERROR, value))).toThrowError(
        new ProtocolError('BAD_FRAME'),
      );
    }
    expect(() =>
      decodeError({ type: Message.PING, payload: new Uint8Array(16) }),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
    expect(() =>
      decodeError({ type: Message.ERROR, payload: new Uint8Array(1025) }),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
  });

  it('accepts only bounded CLOSE reasons and never returns the peer message', () => {
    for (const reason of [
      'normal',
      'mode_complete',
      'local_revoke',
      'expired',
      'protocol_error',
      'transport_error',
    ] as const) {
      const frame = closeFrame(reason);
      expect(decodeClose(frame)).toBe(reason);
      expect(() => encodeFrame('host', 'closing', frame)).not.toThrow();
      expect(
        decodeClose(
          jsonFrame(Message.CLOSE, {
            reason,
            message: 'tcSyntheticPeerSecret',
          }),
        ),
      ).toBe(reason);
    }
    for (const invalid of [
      {},
      { reason: 'unknown', message: 'safe' },
      { reason: 'normal', message: '' },
      { reason: 'normal', message: 'x'.repeat(257) },
      { reason: 'normal', message: 'safe', extra: true },
    ]) {
      expect(() => decodeClose(jsonFrame(Message.CLOSE, invalid))).toThrowError(
        new ProtocolError('BAD_FRAME'),
      );
    }
    expect(() => closeFrame('unknown' as CloseReason)).toThrowError(
      new ProtocolError('BAD_FRAME'),
    );
    expect(() =>
      decodeClose({ type: Message.PING, payload: new Uint8Array(16) }),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
    expect(() =>
      decodeClose({ type: Message.CLOSE, payload: new Uint8Array(513) }),
    ).toThrowError(new ProtocolError('BAD_FRAME'));
  });
});
