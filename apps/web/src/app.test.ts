import { describe, expect, it } from 'vitest';

import {
  initialView,
  retryAllowed,
  safeMessage,
  statusRole,
  titleFor,
  viewForStage,
} from './app.tsx';
import { InvitationError, type SpikeInvitation } from './invitation.ts';
import { EchoError } from './spike.ts';
import { TailcatTransportError } from './transport/tailcat/adapter.ts';

const escapeInvitation: SpikeInvitation = {
  address: 'tcSyntheticEscapeCredential',
  mode: 'escape',
};
const leashInvitation: SpikeInvitation = {
  address: 'tcSyntheticLeashCredential',
  mode: 'leash',
};

describe('M0 connection presentation', () => {
  it('maps every transport stage to user-visible state', () => {
    expect(viewForStage('loading')).toEqual({
      detail: 'Loading Tailcat WebAssembly',
      stage: 'loading',
    });
    expect(viewForStage('connecting')).toEqual({
      detail: 'Connecting to relay',
      stage: 'connecting',
    });
    expect(viewForStage('establishing')).toEqual({
      detail: 'Establishing encrypted session',
      stage: 'establishing',
    });
    expect(viewForStage('complete')).toEqual({
      detail: 'Meowed',
      stage: 'complete',
    });
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
    const errorView = { detail: 'failed', stage: 'error' } as const;
    expect(retryAllowed(errorView, escapeInvitation)).toBe(true);
    expect(retryAllowed(viewForStage('loading'), escapeInvitation)).toBe(false);
    expect(retryAllowed(errorView, new InvitationError())).toBe(false);
    expect(statusRole('error')).toBe('alert');
    expect(statusRole('connecting')).toBe('status');
  });

  it('shows only bounded application-owned failures', () => {
    expect(safeMessage(new TailcatTransportError('DIAL_TIMEOUT'))).toBe(
      'Tailcat connection timed out.',
    );
    expect(safeMessage(new EchoError())).toBe(
      'The encrypted echo exchange failed.',
    );
    expect(safeMessage(new Error('tcSyntheticDoNotDisplay'))).toBe(
      'The encrypted connection failed.',
    );
  });
});
