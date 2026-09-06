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
  authenticating: 'Verifying access code',
  admitting: 'Waiting for session admission',
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
  const [accessMode, setAccessMode] = useState<'unknown' | 'code' | 'link'>(
    'unknown',
  );
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const accessCode = useRef<string>();
  const accessCodeInput = useRef<HTMLInputElement>(null);
  const exitRequested = useRef(false);
  const [cacheStatus, setCacheStatus] = useState(
    'Static cache registration pending.',
  );
  const cacheRegistration = useRef<Promise<string>>();
  const loadingRuntime = view.stage === 'loading';

  useEffect(() => {
    if (cooldownUntil === 0) return;
    const update = (): void => {
      const current = Date.now();
      setClock(current);
      if (current >= cooldownUntil) setCooldownUntil(0);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [cooldownUntil]);

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
    void connectSession(
      invitation,
      controller.signal,
      (stage, progress) => {
        if (!active) return;
        if (stage === 'authenticating') setAccessMode('code');
        setView(viewForStage(stage, progress));
      },
      accessCode.current,
    )
      .then(async (connected) => {
        if (active) {
          accessCode.current = undefined;
          if (accessCodeInput.current !== null)
            accessCodeInput.current.value = '';
          setCooldownUntil(0);
          setAccessMode(connected.welcome.accessMode ?? 'unknown');
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
        if (
          error instanceof ProtocolError &&
          (error.code === 'AUTH_REQUIRED' ||
            error.code === 'AUTH_FAILED' ||
            error.code === 'AUTH_THROTTLED')
        ) {
          accessCode.current = undefined;
          if (accessCodeInput.current !== null)
            accessCodeInput.current.value = '';
          setAccessMode('code');
          if (
            error.code === 'AUTH_THROTTLED' &&
            error.retryAfterMS !== undefined
          ) {
            const current = Date.now();
            setClock(current);
            setCooldownUntil(current + error.retryAfterMS);
          }
          setSession(undefined);
          setView({
            detail:
              error.code === 'AUTH_REQUIRED'
                ? 'Enter the host access code to continue.'
                : safeMessage(error),
            stage: 'error',
          });
          return;
        }
        const retryable = retryableFailure(error, exitRequested.current);
        accessCode.current = undefined;
        if (accessCodeInput.current !== null)
          accessCodeInput.current.value = '';
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
            {welcome.mode === 'leash' ? (
              <>
                <dt>Protection</dt>
                <dd>
                  {welcome.accessMode === 'code'
                    ? 'Password protected'
                    : 'No password — link grants access'}
                </dd>
              </>
            ) : null}
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
        {accessMode === 'code' &&
        session === undefined &&
        invitation !== undefined &&
        !(invitation instanceof InvitationError) ? (
          <form
            class="access-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (cooldownUntil > clock || accessCodeInput.current === null)
                return;
              accessCode.current = accessCodeInput.current.value;
              accessCodeInput.current.value = '';
              setView(viewForStage('loading'));
              setAttempt((current) => current + 1);
            }}
          >
            <p>Password protected</p>
            <label for="access-code">Access code</label>
            <input
              id="access-code"
              ref={accessCodeInput}
              type="password"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck={false}
              disabled={cooldownUntil > clock}
              required
            />
            <button type="submit" disabled={cooldownUntil > clock}>
              Connect
            </button>
            {cooldownUntil > clock ? (
              <p role="status">
                Retry in {Math.ceil((cooldownUntil - clock) / 1000)} seconds.
              </p>
            ) : null}
          </form>
        ) : null}
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
        {accessMode === 'link'
          ? 'No password — link grants access. Treat this invitation link like a password until expiry or revocation.'
          : accessMode === 'code'
            ? 'Password protected. The invitation link and host access code are separate credentials.'
            : 'Treat this invitation link like a password. The host may also require a separate access code.'}{' '}
        TailMouse keeps session credentials only in memory.
      </p>
      <details>
        <summary>About TailMouse</summary>
        <p>{cacheStatus}</p>
        <p>Build {BUILD.version}</p>
        <p>TMOUSE Escape protocol {BUILD.protocols.escape}</p>
        <p>TMOUSE Leash protocol {BUILD.protocols.leash}</p>
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
