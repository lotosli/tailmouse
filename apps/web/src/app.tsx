import { useEffect, useState } from 'preact/hooks';

import {
  consumeInvitation,
  InvitationError,
  type SpikeInvitation,
} from './invitation.ts';
import { EchoError, runSpike, type SpikeStage } from './spike.ts';
import { TailcatTransportError } from './transport/tailcat/adapter.ts';

export interface ViewState {
  readonly stage:
    'loading' | 'connecting' | 'establishing' | 'complete' | 'error';
  readonly detail: string;
}

const stageDetails: Record<SpikeStage, string> = {
  loading: 'Loading Tailcat WebAssembly',
  connecting: 'Connecting to relay',
  establishing: 'Establishing encrypted session',
  complete: 'Meowed',
};

export function viewForStage(stage: SpikeStage): ViewState {
  return { detail: stageDetails[stage], stage };
}

export function initialView(
  invitation: SpikeInvitation | InvitationError,
): ViewState {
  return invitation instanceof InvitationError
    ? { detail: invitation.message, stage: 'error' }
    : viewForStage('loading');
}

export function titleFor(
  invitation: SpikeInvitation | InvitationError,
): string {
  return invitation instanceof InvitationError
    ? 'TailMouse'
    : `TailMouse ${invitation.mode === 'escape' ? 'Escape' : 'Leash'}`;
}

export function retryAllowed(
  view: ViewState,
  invitation: SpikeInvitation | InvitationError,
): boolean {
  return view.stage === 'error' && !(invitation instanceof InvitationError);
}

export function statusRole(stage: ViewState['stage']): 'alert' | 'status' {
  return stage === 'error' ? 'alert' : 'status';
}

export function App() {
  const [invitation] = useState<SpikeInvitation | InvitationError>(() => {
    try {
      return consumeInvitation();
    } catch {
      return new InvitationError();
    }
  });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<ViewState>(() => initialView(invitation));

  useEffect(() => {
    if (invitation instanceof InvitationError) return;
    const controller = new AbortController();
    let active = true;
    void runSpike(invitation.address, controller.signal, (stage) => {
      if (active) setView(viewForStage(stage));
    })
      .then((echoed) => {
        if (active) {
          setView({ detail: `Meowed: ${echoed}`, stage: 'complete' });
        }
      })
      .catch((error: unknown) => {
        if (active) setView({ detail: safeMessage(error), stage: 'error' });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, invitation]);

  const title = titleFor(invitation);

  return (
    <main class="shell">
      <p class="eyebrow">Encrypted by Tailcat</p>
      <h1>{title}</h1>
      <section class="status-card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
        <p
          class={`status status-${view.stage}`}
          role={statusRole(view.stage)}
          aria-live="polite"
        >
          {view.detail}
        </p>
        {retryAllowed(view, invitation) ? (
          <button
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Retry connection
          </button>
        ) : null}
      </section>
      <p class="security-note">
        Invitation links are passwords. TailMouse keeps this one only in memory.
      </p>
    </main>
  );
}

export function safeMessage(error: unknown): string {
  if (error instanceof TailcatTransportError || error instanceof EchoError) {
    return error.message;
  }
  return 'The encrypted connection failed.';
}
