import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
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
import { LeashView } from './leash-view.tsx';
import { TerminalDisplayError, type LeashState } from './leash.ts';
import type { ProcessState } from './protocol/terminal.ts';
import { registerStaticCache } from './static-cache.ts';
import {
  discardShortInvitationTimings,
  resolveShortInvitation,
} from './short-invitation.ts';

export interface ViewState {
  readonly stage:
    SessionStage | 'resolving' | 'connected' | 'closing' | 'closed' | 'error';
  readonly detail: string;
  readonly retryable?: boolean;
  readonly progress?: number;
}

export interface StartupTimings {
  readonly uiReadyMS: number | null;
  readonly codeEntryMS: number;
  readonly wasmTransferMS: number | null;
  readonly wasmInitializationMS: number | null;
  readonly relayMeowMS: number | null;
  readonly authenticationAdmissionMS: number | null;
  readonly terminalReadyMS: number | null;
  readonly totalMS: number | null;
}

// This recorder is page-local and deliberately has no persistence or analytics
// sink. Its phase boundaries are the same callbacks that drive the visible UI.
export class StartupTimingRecorder {
  readonly #startedAt: number;
  #uiReadyMS: number | undefined;
  #codeEntryMS = 0;
  #wasmTransferMS: number | undefined;
  #wasmInitializationMS: number | undefined;
  #relayMeowMS: number | undefined;
  #authenticationAdmissionMS: number | undefined;
  #terminalReadyMS: number | undefined;
  #totalMS: number | undefined;
  #loadStartedAt: number | undefined;
  #transferCompletedAt: number | undefined;
  #relayStartedAt: number | undefined;
  #authenticationStartedAt: number | undefined;
  #codeEntryStartedAt: number | undefined;
  #connectedAt: number | undefined;

  constructor(startedAt: number) {
    this.#startedAt = startedAt;
  }

  uiReady(at: number): void {
    this.#uiReadyMS ??= this.#elapsed(this.#startedAt, at);
  }

  stage(stage: SessionStage, progress: number | undefined, at: number): void {
    if (this.#totalMS !== undefined) return;
    if (stage === 'loading') {
      if (progress === 0 && this.#loadStartedAt === undefined) {
        this.#loadStartedAt = at;
        this.#transferCompletedAt = undefined;
        this.#relayStartedAt = undefined;
        this.#authenticationStartedAt = undefined;
      }
      if (
        progress === 100 &&
        this.#loadStartedAt !== undefined &&
        this.#transferCompletedAt === undefined
      ) {
        this.#wasmTransferMS =
          (this.#wasmTransferMS ?? 0) + this.#elapsed(this.#loadStartedAt, at);
        this.#transferCompletedAt = at;
      }
      return;
    }
    if (stage === 'connecting') {
      if (this.#loadStartedAt !== undefined) {
        const transferredAt = this.#transferCompletedAt ?? at;
        if (this.#transferCompletedAt === undefined) {
          this.#wasmTransferMS =
            (this.#wasmTransferMS ?? 0) +
            this.#elapsed(this.#loadStartedAt, transferredAt);
        }
        this.#wasmInitializationMS =
          (this.#wasmInitializationMS ?? 0) + this.#elapsed(transferredAt, at);
        this.#loadStartedAt = undefined;
        this.#transferCompletedAt = undefined;
      }
      this.#relayStartedAt = at;
      return;
    }
    if (stage === 'establishing') {
      if (this.#relayStartedAt !== undefined) {
        this.#relayMeowMS =
          (this.#relayMeowMS ?? 0) + this.#elapsed(this.#relayStartedAt, at);
        this.#relayStartedAt = undefined;
      }
      this.#authenticationStartedAt ??= at;
      return;
    }
    this.#authenticationStartedAt ??= at;
  }

  waitForCode(at: number): void {
    this.#finishAuthentication(at);
    this.#codeEntryStartedAt ??= at;
  }

  submitCode(at: number): void {
    if (this.#codeEntryStartedAt === undefined) return;
    this.#codeEntryMS += this.#elapsed(this.#codeEntryStartedAt, at);
    this.#codeEntryStartedAt = undefined;
  }

  connected(at: number): void {
    this.#finishAuthentication(at);
    this.#connectedAt ??= at;
  }

  terminalReady(at: number): void {
    if (this.#totalMS !== undefined || this.#connectedAt === undefined) return;
    this.#terminalReadyMS = this.#elapsed(this.#connectedAt, at);
    this.#totalMS = Math.max(
      0,
      this.#elapsed(this.#startedAt, at) - this.#codeEntryMS,
    );
  }

  snapshot(): StartupTimings {
    return Object.freeze({
      uiReadyMS: this.#uiReadyMS ?? null,
      codeEntryMS: this.#codeEntryMS,
      wasmTransferMS: this.#wasmTransferMS ?? null,
      wasmInitializationMS: this.#wasmInitializationMS ?? null,
      relayMeowMS: this.#relayMeowMS ?? null,
      authenticationAdmissionMS: this.#authenticationAdmissionMS ?? null,
      terminalReadyMS: this.#terminalReadyMS ?? null,
      totalMS: this.#totalMS ?? null,
    });
  }

  #finishAuthentication(at: number): void {
    if (this.#authenticationStartedAt === undefined) return;
    this.#authenticationAdmissionMS =
      (this.#authenticationAdmissionMS ?? 0) +
      this.#elapsed(this.#authenticationStartedAt, at);
    this.#authenticationStartedAt = undefined;
  }

  #elapsed(start: number, end: number): number {
    return Math.max(0, end - start);
  }
}

export function startupTarget(
  elapsedMS: number | null,
  limitMS: number,
): 'pending' | 'met' | 'missed' {
  if (elapsedMS === null) return 'pending';
  return elapsedMS < limitMS ? 'met' : 'missed';
}

function timingValue(value: number | null): string {
  return value === null ? 'Pending' : `${Math.round(value)} ms`;
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
    : `TailMouse Leash`;
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

export function taskPresentation(
  process: ProcessState | undefined,
  connected: boolean,
): { label: string; observation: string } {
  const label =
    process?.state === 'exited'
      ? 'Retained result'
      : process === undefined
        ? 'Waiting for task state'
        : `${process.state[0]!.toUpperCase()}${process.state.slice(1)}`;
  return {
    label,
    observation: connected
      ? 'Live Host state'
      : 'Last observed before the connection ended',
  };
}

export function App() {
  const pendingShortCode = useRef<string>();
  const shortResolution = useRef<AbortController>();
  const [invitation, setInvitation] = useState<
    MouseCard | InvitationError | undefined
  >(() => {
    try {
      const input = consumeInvitation();
      if ('shortCode' in input) {
        pendingShortCode.current = input.shortCode;
        return undefined;
      }
      return input;
    } catch (error: unknown) {
      return error instanceof InvitationError ? error : new InvitationError();
    }
  });
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<ViewState>(() =>
    pendingShortCode.current !== undefined
      ? { detail: 'Opening invitation', stage: 'resolving' }
      : initialView(invitation!),
  );
  const [title, setTitle] = useState(() =>
    invitation === undefined ? 'TailMouse' : titleFor(invitation),
  );
  const [session, setSession] = useState<BrowserSession>();
  const [welcome, setWelcome] = useState<Welcome>();
  const [metrics, setMetrics] = useState<ConnectionMetrics>();
  const [task, setTask] = useState<LeashState>();
  const [accessMode, setAccessMode] = useState<'unknown' | 'code' | 'link'>(
    'unknown',
  );
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [clock, setClock] = useState(() => Date.now());
  const accessCode = useRef<string>();
  const rememberedAccessCode = useRef<string>();
  const accessCodeInput = useRef<HTMLInputElement>(null);
  const exitRequested = useRef(false);
  const startupTiming = useRef<StartupTimingRecorder>();
  startupTiming.current ??= new StartupTimingRecorder(performance.now());
  const [timings, setTimings] = useState<StartupTimings>(() =>
    startupTiming.current!.snapshot(),
  );
  const [cacheStatus, setCacheStatus] = useState(
    'Static cache registration pending.',
  );
  const cacheRegistration = useRef<Promise<string>>();
  const loadingRuntime = view.stage === 'loading';
  const publishTiming = useCallback(() => {
    setTimings(startupTiming.current!.snapshot());
  }, []);
  const observeTask = useCallback(
    (next: LeashState): void => {
      setTask(next);
      if (
        next.reset !== undefined &&
        next.process !== undefined &&
        !next.synchronizing
      ) {
        startupTiming.current!.terminalReady(performance.now());
        publishTiming();
      }
    },
    [publishTiming],
  );

  useEffect(() => {
    startupTiming.current!.uiReady(performance.now());
    publishTiming();
  }, [publishTiming]);

  useEffect(() => {
    const clearReferences = (): void => {
      accessCode.current = undefined;
      rememberedAccessCode.current = undefined;
      if (accessCodeInput.current !== null) accessCodeInput.current.value = '';
    };
    const clearPageCredentials = (): void => {
      pendingShortCode.current = undefined;
      shortResolution.current?.abort();
      clearReferences();
      setInvitation((current) => {
        if (current !== undefined && !(current instanceof InvitationError))
          current.sessionID.fill(0);
        return undefined;
      });
      setSession(undefined);
      setWelcome(undefined);
      setTask(undefined);
      setView({ detail: new InvitationError().message, stage: 'error' });
    };
    const rejectRestoredPage = (event: PageTransitionEvent): void => {
      if (event.persisted) clearPageCredentials();
    };
    window.addEventListener('pagehide', clearPageCredentials);
    window.addEventListener('pageshow', rejectRestoredPage);
    return () => {
      window.removeEventListener('pagehide', clearPageCredentials);
      window.removeEventListener('pageshow', rejectRestoredPage);
      clearReferences();
    };
  }, []);

  useEffect(() => {
    const code = pendingShortCode.current;
    pendingShortCode.current = undefined;
    if (code === undefined) return;
    const discardTimings = discardShortInvitationTimings();
    const controller = new AbortController();
    shortResolution.current = controller;
    void resolveShortInvitation(code, controller.signal)
      .then((card) => {
        if (controller.signal.aborted) {
          card.sessionID.fill(0);
          return;
        }
        setTitle(titleFor(card));
        setInvitation(card);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        const error = new InvitationError('UNAVAILABLE');
        setInvitation(error);
        setView(initialView(error));
      });
    return () => {
      controller.abort();
      discardTimings();
      shortResolution.current = undefined;
    };
  }, []);

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
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (invitation === undefined || invitation instanceof InvitationError)
      return;
    if (
      invitation.requiresAccessCode === true &&
      accessCode.current === undefined &&
      rememberedAccessCode.current === undefined
    ) {
      startupTiming.current!.waitForCode(performance.now());
      publishTiming();
      setAccessMode('code');
      setView({
        detail: 'Enter the host access code to continue.',
        stage: 'error',
      });
      return;
    }
    const controller = new AbortController();
    exitRequested.current = false;
    let active = true;
    setSession(undefined);
    setWelcome(undefined);
    const forget = (): void => {
      accessCode.current = undefined;
      rememberedAccessCode.current = undefined;
      if (accessCodeInput.current !== null) accessCodeInput.current.value = '';
      invitation.sessionID.fill(0);
      setInvitation(undefined);
    };
    void connectSession(
      invitation,
      controller.signal,
      (stage, progress) => {
        if (!active) return;
        startupTiming.current!.stage(stage, progress, performance.now());
        publishTiming();
        if (stage === 'authenticating') setAccessMode('code');
        setView(viewForStage(stage, progress));
      },
      accessCode.current ?? rememberedAccessCode.current,
    )
      .then(async (connected) => {
        if (active) {
          startupTiming.current!.connected(performance.now());
          publishTiming();
          rememberedAccessCode.current ??= accessCode.current;
          accessCode.current = undefined;
          if (accessCodeInput.current !== null)
            accessCodeInput.current.value = '';
          setCooldownUntil(0);
          setAccessMode(connected.welcome.accessMode ?? 'unknown');
          setSession(connected);
          setWelcome(connected.welcome);
          if (connected.terminal !== undefined)
            observeTask(connected.terminal.inspect());
          setView({ detail: 'Connected', stage: 'connected' });
        }
        let reason: Awaited<typeof connected.done>;
        try {
          reason = await connected.done;
        } finally {
          if (active) {
            if (connected.terminal !== undefined)
              setTask(connected.terminal.inspect());
          }
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
          startupTiming.current!.waitForCode(performance.now());
          publishTiming();
          accessCode.current = undefined;
          rememberedAccessCode.current = undefined;
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
        if (error instanceof TerminalDisplayError)
          rememberedAccessCode.current = undefined;
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
  }, [attempt, invitation, observeTask, publishTiming]);

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
  const taskView =
    task === undefined
      ? undefined
      : taskPresentation(task.process, session?.terminal !== undefined);

  return (
    <main
      class={`shell${session?.terminal !== undefined ? ' shell-terminal' : ''}`}
    >
      <p class="eyebrow">Encrypted by Tailcat</p>
      <h1>{title}</h1>
      {session?.terminal !== undefined && welcome !== undefined ? (
        <LeashView
          terminal={session.terminal}
          welcome={welcome}
          metrics={metrics}
          onState={observeTask}
        />
      ) : null}
      {task !== undefined && taskView !== undefined ? (
        <section class="task-card" aria-label="Task">
          <h2>Task</h2>
          <p class="task-state">{taskView.label}</p>
          <p>{taskView.observation}</p>
          {task.process !== undefined ? (
            <p>
              Generation {task.process.generation}
              {task.process.exit_code !== null
                ? ` · Exit ${task.process.exit_code}`
                : ''}
            </p>
          ) : null}
        </section>
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
              {welcome.capabilities.includes('terminal_input')
                ? 'Control'
                : 'Read only'}
            </dd>
            <>
              <dt>Protection</dt>
              <dd>
                {welcome.accessMode === 'code'
                  ? 'Password protected'
                  : 'No password — link grants access'}
              </dd>
            </>
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
          </dl>
        ) : null}
        {exitControl}
        {accessMode === 'code' &&
        rememberedAccessCode.current === undefined &&
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
              startupTiming.current!.submitCode(performance.now());
              publishTiming();
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
        {retryAllowed(view, invitation) &&
        !(
          accessMode === 'code' && rememberedAccessCode.current === undefined
        ) ? (
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
        This browser keeps session credentials only in memory.
      </p>
      <details>
        <summary>About TailMouse</summary>
        {invitation !== undefined &&
        !(invitation instanceof InvitationError) &&
        invitation.requiresAccessCode === true ? (
          <p>
            Cloudflare can read this short link's invitation during its
            renewable 15-minute lease. Your access code is never sent to
            Cloudflare.
          </p>
        ) : null}
        <p>{cacheStatus}</p>
        <p>Build {BUILD.version}</p>
        <p>TMOUSE Leash protocol {BUILD.protocols.leash}</p>
        <p>Tailcat revision {BUILD.tailcatRevision}</p>
        <dl aria-label="Startup timing">
          <dt>UI ready</dt>
          <dd>{timingValue(timings.uiReadyMS)}</dd>
          <dt>Code-entry wait</dt>
          <dd>{timingValue(timings.codeEntryMS)}</dd>
          <dt>Wasm transfer</dt>
          <dd>{timingValue(timings.wasmTransferMS)}</dd>
          <dt>Wasm initialization</dt>
          <dd>{timingValue(timings.wasmInitializationMS)}</dd>
          <dt>Relay / Meow handshake</dt>
          <dd>{timingValue(timings.relayMeowMS)}</dd>
          <dt>Authentication / admission</dt>
          <dd>{timingValue(timings.authenticationAdmissionMS)}</dd>
          <dt>Terminal ready</dt>
          <dd>{timingValue(timings.terminalReadyMS)}</dd>
          <dt>Startup excluding code entry</dt>
          <dd>{timingValue(timings.totalMS)}</dd>
        </dl>
        <p data-testid="startup-targets">
          Warm target (&lt;3 s): {startupTarget(timings.totalMS, 3000)}. Cold
          target (&lt;15 s): {startupTarget(timings.totalMS, 15_000)}.
        </p>
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
