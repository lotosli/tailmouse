import { describe, expect, it } from 'vitest';

import {
  initialView,
  retryAllowed,
  retryableFailure,
  safeMessage,
  statusRole,
  titleFor,
  viewForStage,
} from './app.tsx';
import { InvitationError, type MouseCard } from './invitation.ts';
import { ProtocolError } from './protocol/frame.ts';
import { SessionError } from './session.ts';
import { TerminalDisplayError } from './leash.ts';
import { TailcatTransportError } from './transport/tailcat/adapter.ts';

const escapeInvitation: MouseCard = {
  address: 'tcSyntheticEscapeCredential',
  expiresAt: 0,
  mode: 'escape',
  port: 44321,
  protocolMax: 1,
  protocolMin: 1,
  sessionID: new Uint8Array(16).fill(7),
  version: 1,
};
const leashInvitation: MouseCard = {
  ...escapeInvitation,
  address: 'tcSyntheticLeashCredential',
  mode: 'leash',
};

describe('Session connection presentation', () => {
  it('maps every transport stage to user-visible state', () => {
    expect(viewForStage('loading')).toEqual({
      detail: 'Loading Tailcat WebAssembly',
      stage: 'loading',
    });
    expect(viewForStage('connecting')).toEqual({
      detail: 'Connecting to relay / Meow handshake',
      stage: 'connecting',
    });
    expect(viewForStage('establishing')).toEqual({
      detail: 'Establishing encrypted session',
      stage: 'establishing',
    });
    expect(viewForStage('loading', 50)).toEqual({
      detail: 'Loading Tailcat WebAssembly',
      stage: 'loading',
      progress: 50,
    });
    expect(viewForStage('connecting', 100)).toEqual(viewForStage('connecting'));
  });

  it('renders mode hints only for validated invitations', () => {
    const invalid = new InvitationError();
    expect(initialView(escapeInvitation)).toEqual(viewForStage('loading'));
    expect(initialView(invalid)).toEqual({
      detail: invalid.message,
      stage: 'error',
    });
    expect(titleFor(escapeInvitation)).toBe('TailMouse Escape');
    expect(titleFor(leashInvitation)).toBe('TailMouse Leash');
    expect(titleFor(invalid)).toBe('TailMouse');
  });

  it('offers retry only for connection failures and exposes status semantics', () => {
    const errorView = {
      detail: 'failed',
      retryable: true,
      stage: 'error',
    } as const;
    expect(retryAllowed(errorView, escapeInvitation)).toBe(true);
    expect(retryAllowed(viewForStage('loading'), escapeInvitation)).toBe(false);
    expect(retryAllowed(errorView, new InvitationError())).toBe(false);
    expect(retryAllowed(errorView, undefined)).toBe(false);
    expect(
      retryAllowed({ detail: 'expired', stage: 'error' }, escapeInvitation),
    ).toBe(false);
    expect(retryableFailure(new ProtocolError('SESSION_BUSY'))).toBe(true);
    expect(retryableFailure(new ProtocolError('PROTOCOL_MISMATCH'))).toBe(
      false,
    );
    expect(retryableFailure(new SessionError('DISCONNECTED'))).toBe(true);
    expect(retryableFailure(new SessionError('HANDSHAKE_TIMEOUT'))).toBe(true);
    expect(retryableFailure(new SessionError('HANDSHAKE_TIMEOUT'), true)).toBe(
      false,
    );
    expect(retryableFailure(new TerminalDisplayError())).toBe(true);
    expect(retryableFailure(new TerminalDisplayError(), true)).toBe(false);
    expect(retryableFailure(new TailcatTransportError('CANCELED'))).toBe(false);
    expect(retryableFailure(new Error('unknown'))).toBe(false);
    for (const failure of [
      new SessionError('DISCONNECTED'),
      new TailcatTransportError('CLOSE_FAILED'),
      new ProtocolError('SESSION_BUSY'),
    ]) {
      expect(retryableFailure(failure, true)).toBe(false);
    }
    expect(statusRole('error')).toBe('alert');
    expect(statusRole('connecting')).toBe('status');
  });

  it('shows only bounded application-owned failures', () => {
    expect(safeMessage(new TerminalDisplayError())).toBe(
      'The terminal display failed. Reconnect to try again.',
    );
    expect(safeMessage(new TailcatTransportError('DIAL_TIMEOUT'))).toBe(
      'Tailcat connection timed out.',
    );
    expect(safeMessage(new SessionError('DISCONNECTED'))).toBe(
      'The encrypted session disconnected. Retry to reconnect.',
    );
    expect(safeMessage(new ProtocolError('SESSION_BUSY'))).toBe(
      'Another browser is controlling this session.',
    );
    expect(safeMessage(new Error('tcSyntheticDoNotDisplay'))).toBe(
      'The encrypted connection failed.',
    );
  });
});
