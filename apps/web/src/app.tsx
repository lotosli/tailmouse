import { useEffect, useRef, useState } from 'preact/hooks';
import { BUILD } from './build.ts';

import {
  consumeInvitation,
  InvitationError,
  type MouseCard,
} from './invitation.ts';
import { ProtocolError, type Welcome } from './protocol/frame.ts';
import {
  BrowserSession,
  connectSession,
  SessionError,
  type ConnectionMetrics,
  type SessionStage,
} from './session.ts';
import { TailcatTransportError } from './transport/tailcat/adapter.ts';
import { EscapeView, EscapeResult } from './escape-view.tsx';
import type { GameResult } from './protocol/game.ts';
import { LeashView } from './leash-view.tsx';
import { TerminalDisplayError } from './leash.ts';
import { registerStaticCache } from './static-cache.ts';

export interface ViewState {
  readonly stage: SessionStage | 'connected' | 'closing' | 'closed' | 'error';
  readonly detail: string;
  readonly retryable?: boolean;
  readonly progress?: number;
}

const stageDetails: Record<SessionStage, string> = {
  loading: 'Loading Tailcat WebAssembly',
  connecting: 'Connecting to relay / Meow handshake',
  establishing: 'Establishing encrypted session',
};

export function viewForStage(
  stage: SessionStage,
  progress?: number,
): ViewState {
  return {
    detail: stageDetails[stage],
    stage,
    ...(stage === 'loading' && progress !== undefined ? { progress } : {}),
  };
}

export function initialView(
  invitation: MouseCard | InvitationError,
): ViewState {
  return invitation instanceof InvitationError
    ? { detail: invitation.message, stage: 'error' }
    : viewForStage('loading');
}

export function titleFor(invitation: MouseCard | InvitationError): string {
  return invitation instanceof InvitationError
    ? 'TailMouse'
    : `TailMouse ${invitation.mode === 'escape' ? 'Escape' : 'Leash'}`;
}

export function retryAllowed(
  view: ViewState,
  invitation: MouseCard | InvitationError | undefined,
): boolean {
  return (
    view.stage === 'error' &&
    view.retryable === true &&
    invitation !== undefined &&
    !(invitation instanceof InvitationError)
  );
}

export function statusRole(stage: ViewState['stage']): 'alert' | 'status' {
  return stage === 'error' ? 'alert' : 'status';
}

export function App() {
  const [invitation, setInvitation] = useState<
    MouseCard | InvitationError | undefined
  >(() => {
    try {
      return consumeInvitation();
    } catch (error: unknown) {
      return error instanceof InvitationError ? error : new InvitationError();
    }
  });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<ViewState>(() => initialView(invitation!));
  const [title] = useState(() => titleFor(invitation!));
  const [session, setSession] = useState<BrowserSession>();
  const [welcome, setWelcome] = useState<Welcome>();
  const [metrics, setMetrics] = useState<ConnectionMetrics>();
  const [result, setResult] = useState<GameResult>();
  const [showNet, setShowNet] = useState(true);
  const exitRequested = useRef(false);
  const [cacheStatus, setCacheStatus] = useState(
    'Static cache registration pending.',
  );
  const cacheRegistration = useRef<Promise<string>>();
  const loadingRuntime = view.stage === 'loading';

  useEffect(() => {
    // Finish the first runtime download before precaching the same immutable
    // bytes. A page without an invitation can install its static cache directly.
    if (loadingRuntime) return;
    let active = true;
    cacheRegistration.current ??= registerStaticCache();
    void cacheRegistration.current.then((status) => {
      if (active) setCacheStatus(status);
    });
    return () => {
      active = false;
    };
  }, [loadingRuntime]);

  useEffect(() => {
    if (session === undefined) {
      setMetrics(undefined);
      return;
    }
    setMetrics(session.inspectMetrics());
    const timer = setInterval(() => {
      setMetrics(session.inspectMetrics());
      setShowNet(session.game?.inspect().init?.presentation.show_net ?? true);
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (invitation === undefined || invitation instanceof InvitationError)
      return;
    const controller = new AbortController();
    exitRequested.current = false;
    let active = true;
    setSession(undefined);
    setWelcome(undefined);
    setResult(undefined);
    setShowNet(true);
    const forget = (): void => {
      invitation.sessionID.fill(0);
      setInvitation(undefined);
    };
    void connectSession(invitation, controller.signal, (stage, progress) => {
      if (active) setView(viewForStage(stage, progress));
    })
      .then(async (connected) => {
        if (active) {
          setSession(connected);
          setWelcome(connected.welcome);
          setView({ detail: 'Connected', stage: 'connected' });
        }
        let reason: Awaited<typeof connected.done>;
        try {
          reason = await connected.done;
        } finally {
          if (active) setResult(connected.game?.inspect().result);
        }
        if (!active) return;
        const expired = reason === 'expired';
        setSession(undefined);
        setView({
          detail: expired ? 'Session has expired.' : 'Session closed.',
          stage: expired ? 'error' : 'closed',
        });
        forget();
      })
      .catch((error: unknown) => {
        if (!active) return;
        const retryable = retryableFailure(error, exitRequested.current);
        setSession(undefined);
        setView({ detail: safeMessage(error), retryable, stage: 'error' });
        if (!retryable) forget();
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [attempt, invitation]);

  const exitControl =
    session !== undefined ? (
      <button
        type="button"
        disabled={view.stage !== 'connected'}
        onClick={() => {
          exitRequested.current = true;
          setView({ detail: 'Closing session', stage: 'closing' });
          // The connection promise reports any close failure through the effect.
          void session.close().catch(() => {});
        }}
      >
        Exit session
      </button>
    ) : null;

  return (
    <main
      class={`shell${session?.game !== undefined || result !== undefined ? ' shell-game' : ''}${session?.terminal !== undefined ? ' shell-terminal' : ''}`}
    >
      <p class="eyebrow">Encrypted by Tailcat</p>
      <h1>{title}</h1>
      {session?.game !== undefined ? (
        <div class="game-session-bar">
          <span>{view.detail}</span>
          {exitControl}
        </div>
      ) : null}
      {session?.game !== undefined && welcome !== undefined ? (
        <EscapeView
          game={session.game}
          metrics={metrics}
          canInput={welcome.capabilities.includes('game_input')}
          canDash={welcome.capabilities.includes('dash')}
        />
      ) : result !== undefined ? (
        <EscapeResult result={result} />
      ) : null}
      {session?.terminal !== undefined && welcome !== undefined ? (
        <LeashView
          terminal={session.terminal}
          welcome={welcome}
          metrics={metrics}
        />
      ) : null}
      <section class="status-card" aria-labelledby="connection-heading">
        <h2 id="connection-heading">Connection</h2>
        <p
          class={`status status-${view.stage}`}
          role={statusRole(view.stage)}
          aria-live="polite"
        >
          {view.detail}
        </p>
        {view.stage === 'loading' && view.progress !== undefined ? (
          <div class="load-progress">
            <progress
              aria-label="Tailcat WebAssembly download"
              max={100}
              value={view.progress}
            />
            <span aria-hidden="true">{view.progress}%</span>
          </div>
        ) : null}
        {welcome !== undefined ? (
          <dl>
            <dt>Mode</dt>
            <dd>{welcome.mode}</dd>
            <dt>Relay</dt>
            <dd>
              {welcome.relay.mode}: {welcome.relay.host}
            </dd>
            <dt>Browser path</dt>
            <dd>DERP relay</dd>
            <dt>Access</dt>
            <dd>
              {welcome.capabilities.includes('terminal_input') ||
              welcome.capabilities.includes('game_input')
                ? 'Control'
                : 'Read only'}
            </dd>
            {showNet ? (
              <>
                <dt>RTT / jitter</dt>
                <dd data-testid="latency">
                  {metrics !== undefined && metrics.samples > 0
                    ? `${metrics.rttMs.toFixed(1)} ms / ${metrics.jitterMs.toFixed(1)} ms`
                    : 'Measuring'}
                </dd>
                <dt>RTT p50 / p95</dt>
                <dd>
                  {metrics !== undefined && metrics.samples > 0
                    ? `${metrics.p50Ms.toFixed(1)} ms / ${metrics.p95Ms.toFixed(1)} ms`
                    : 'Measuring'}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {session?.game === undefined ? exitControl : null}
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
        Treat this invitation link like a password. Anyone with it can use the
        host&apos;s shared permissions until expiry or revocation; no separate
        password is required. TailMouse keeps the invitation only in memory.
      </p>
      <details>
        <summary>About TailMouse</summary>
        <p>{cacheStatus}</p>
        <p>Build {BUILD.version}</p>
        <p>
          TMOUSE protocol {BUILD.protocolMin}..{BUILD.protocolMax}
        </p>
        <p>Tailcat revision {BUILD.tailcatRevision}</p>
        <p>
          Unofficial Tailcat application. Browser transport uses DERP relay.
        </p>
      </details>
    </main>
  );
}

export function safeMessage(error: unknown): string {
  if (
    error instanceof TailcatTransportError ||
    error instanceof ProtocolError ||
    error instanceof TerminalDisplayError ||
    error instanceof SessionError
  ) {
    return error.message;
  }
  return 'The encrypted connection failed.';
}

export function retryableFailure(
  error: unknown,
  exitRequested = false,
): boolean {
  if (exitRequested) return false;
  if (error instanceof TerminalDisplayError) return true;
  if (error instanceof ProtocolError || error instanceof SessionError)
    return error.retryable;
  return error instanceof TailcatTransportError && error.code !== 'CANCELED';
}
