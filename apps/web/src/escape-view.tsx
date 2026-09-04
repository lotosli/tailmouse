import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { EscapeClient, EscapeState } from './escape.ts';
import { EscapeInput, type InputView } from './escape-input.ts';
import {
  drawEscape,
  updateEscapeScent,
  type EscapeScentSample,
} from './escape-canvas.ts';
import type { GameResult } from './protocol/game.ts';
import type { ConnectionMetrics } from './session.ts';

const tiltMessages: Record<InputView['tilt'], string> = {
  off: 'Drag to move. Keyboard: arrows or WASD; Space to dash.',
  permission: 'Waiting for tilt permission.',
  calibrating: 'Hold still for one second to calibrate.',
  active: 'Tilt to move. Touch is available at any time.',
  unavailable: 'Tilt is unavailable. Touch controls are active.',
  denied: 'Tilt permission was denied. Touch controls are active.',
};

export function EscapeResult({ result }: { readonly result: GameResult }) {
  return (
    <section class="result-card" aria-labelledby="result-heading">
      <p class="eyebrow">Round complete</p>
      <h2 id="result-heading">
        {
          {
            escaped: 'THE MOUSE ESCAPED',
            caught: 'THE CAT WON',
            timeout: 'TIME RAN OUT',
            connection_lost: 'CONNECTION LOST',
          }[result.outcome]
        }
      </h2>
      <dl class="game-stats">
        <div>
          <dt>Time</dt>
          <dd>{(result.elapsed_ms / 1000).toFixed(1)} s</dd>
        </div>
        <div>
          <dt>RTT p50</dt>
          <dd>{result.rtt_p50_ms} ms</dd>
        </div>
        <div>
          <dt>RTT p95</dt>
          <dd>{result.rtt_p95_ms} ms</dd>
        </div>
        {result.jitter_ms !== null ? (
          <div>
            <dt>Jitter</dt>
            <dd>{result.jitter_ms} ms</dd>
          </div>
        ) : null}
        <div>
          <dt>Relay</dt>
          <dd>{result.relay}</dd>
        </div>
      </dl>
      <p>{result.message}</p>
    </section>
  );
}

export function EscapeView({
  game,
  canInput,
  canDash,
  metrics,
}: {
  readonly game: EscapeClient;
  readonly canInput: boolean;
  readonly canDash: boolean;
  readonly metrics?: ConnectionMetrics | undefined;
}) {
  const [state, setState] = useState<EscapeState>(() => game.inspect());
  const [inputView, setInputView] = useState<InputView>();
  const [canvasFailed, setCanvasFailed] = useState(false);
  const [muted, setMuted] = useState(true);
  const [soundError, setSoundError] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const input = useRef<EscapeInput>();
  const audio = useRef<AudioContext>();
  const oscillator = useRef<OscillatorNode>();
  const mutedRef = useRef(true);
  const mounted = useRef(true);
  const network = useRef(metrics);
  const init = state.init;
  const snapshot = state.snapshot;
  const finished = state.result !== undefined || state.stopped;
  const active = canInput && !finished;

  useEffect(() => {
    network.current = metrics;
  }, [metrics]);

  // Bind input before the exposed controls can receive their first interaction.
  useLayoutEffect(() => {
    if (!active || area.current === null) return;
    const controls = new EscapeInput(area.current, (x, y) => {
      game.move(x, y);
    });
    input.current = controls;
    return () => {
      controls.dispose();
      input.current = undefined;
    };
  }, [game, active, init, snapshot === undefined]);

  useEffect(() => {
    mounted.current = true;
    const scent: EscapeScentSample[] = [];
    let request = 0;
    let lastDraw = -Infinity;
    let lastHUD = -Infinity;
    let lastEvent = 0;
    let previousInput: InputView | undefined;
    const draw = (now: number): void => {
      const next = game.inspect();
      if (next.init !== init) scent.length = 0;
      if (
        now - lastHUD >= 100 ||
        next.init !== init ||
        next.result !== state.result
      ) {
        setState(next);
        lastHUD = now;
      }
      const currentInput = input.current?.inspect();
      if (currentInput !== previousInput) {
        setInputView(currentInput);
        previousInput = currentInput;
      }
      if (next.event !== undefined && next.event.sequence !== lastEvent) {
        lastEvent = next.event.sequence;
        const context = audio.current;
        if (!mutedRef.current && context?.state === 'running') {
          oscillator.current?.stop();
          const tone = context.createOscillator();
          const gain = context.createGain();
          tone.frequency.value =
            next.event.event === 'dash_rejected' ? 180 : 660;
          gain.gain.setValueAtTime(0.035, context.currentTime);
          gain.gain.exponentialRampToValueAtTime(
            0.001,
            context.currentTime + 0.07,
          );
          tone.connect(gain);
          gain.connect(context.destination);
          tone.onended = () => {
            tone.disconnect();
            gain.disconnect();
            if (oscillator.current === tone) oscillator.current = undefined;
          };
          tone.start();
          tone.stop(context.currentTime + 0.08);
          oscillator.current = tone;
        }
      }
      const element = canvas.current;
      if (
        element !== null &&
        next.init !== undefined &&
        next.snapshot !== undefined &&
        now - lastDraw >= 1000 / 60 - 0.5
      ) {
        const context = element.getContext('2d', { alpha: false });
        if (context === null) setCanvasFailed(true);
        else {
          const width = Math.max(
            48,
            Math.round(
              element.clientWidth * Math.min(3, window.devicePixelRatio),
            ),
          );
          const height = Math.round((width * 18) / 48);
          if (element.width !== width || element.height !== height) {
            element.width = width;
            element.height = height;
          }
          context.setTransform(width / 48, 0, 0, height / 18, 0, 0);
          const predicted = game.predict(now);
          drawEscape(
            context,
            next.init,
            next.snapshot,
            predicted?.mouse,
            predicted?.dust,
            updateEscapeScent(
              scent,
              predicted?.mouse ?? next.snapshot.mouse,
              now,
              network.current?.rttMs ?? 0,
              network.current?.jitterMs ?? 0,
              next.snapshot.phase === 1 &&
                !next.stopped &&
                next.result === undefined,
            ),
          );
        }
        // Preserve the 60 Hz phase on 90/120 Hz displays instead of rounding
        // each interval up to the next display frame and drifting to 45 FPS.
        lastDraw = Number.isFinite(lastDraw)
          ? lastDraw +
            Math.max(1, Math.floor((now - lastDraw + 0.5) / (1000 / 60))) *
              (1000 / 60)
          : now;
      }
      request = requestAnimationFrame(draw);
    };
    request = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(request);
      scent.length = 0;
    };
  }, [game, init, state.result]);

  useEffect(
    () => () => {
      mounted.current = false;
      oscillator.current?.stop();
      if (audio.current !== undefined) {
        void audio.current.close().catch(() => {
          // Sound is optional; its context has already been detached from the view.
          if (mounted.current) setSoundError(true);
        });
      }
    },
    [],
  );

  const dash = (): void => {
    game.dash();
    setState(game.inspect());
  };
  const toggleSound = async (): Promise<void> => {
    if (!mutedRef.current) {
      mutedRef.current = true;
      setMuted(true);
      oscillator.current?.stop();
      return;
    }
    try {
      audio.current ??= new AudioContext();
      await audio.current.resume();
      if (!mounted.current) return;
      mutedRef.current = false;
      setMuted(false);
      setSoundError(false);
    } catch {
      if (mounted.current) setSoundError(true);
    }
  };

  if (init === undefined || snapshot === undefined)
    return (
      <section class="game-card">
        <p>Waiting for the host's game state.</p>
      </section>
    );
  const countdown =
    state.event?.event === 'countdown' ? state.event.value : null;
  const cheese =
    (snapshot.collectedMask & 1) + ((snapshot.collectedMask >> 1) & 1);
  const phase =
    snapshot.phase === 0
      ? `Get ready${countdown === null ? '' : `: ${countdown}`}`
      : snapshot.phase === 2
        ? 'Connection lost — game paused. Reconnect within 30 seconds.'
        : 'Collect both cheeses, then reach the exit.';
  return (
    <section class="game-card" aria-label="Escape game">
      <div class="game-heading">
        <p class="eyebrow">The cat is always one RTT behind the mouse.</p>
        {init.presentation.show_net ? (
          <span class="game-rtt">
            RTT{' '}
            {metrics !== undefined && metrics.samples > 0
              ? `${metrics.rttMs.toFixed(0)} ms`
              : 'measuring'}
          </span>
        ) : null}
        <span class="game-time" aria-label="Time remaining">
          {(snapshot.remainingMS / 1000).toFixed(1)} s
        </span>
      </div>
      <p class="game-phase" aria-live="polite">
        {finished ? 'Round complete.' : phase}
      </p>
      <div class="game-body">
        <div class="game-playfield">
          {init.presentation.phone_render && !canvasFailed ? (
            <canvas
              ref={canvas}
              class="game-map"
              role="img"
              aria-label={`${init.map.name} map: mouse, cat, two cheeses and ${snapshot.exitOpen ? 'open' : 'locked'} exit`}
            />
          ) : (
            <p>
              {canvasFailed
                ? 'Canvas is unavailable.'
                : 'Phone rendering is disabled by the host.'}{' '}
              Text state and authorized controls remain available.
            </p>
          )}
          <p class="map-legend">
            Mouse · Cat · Cheese {cheese}/2 · Exit{' '}
            {snapshot.exitOpen ? 'open' : 'locked'}
          </p>
          <details>
            <summary>Text map and positions</summary>
            <p>
              Mouse {snapshot.mouse.x.toFixed(1)}, {snapshot.mouse.y.toFixed(1)}
              . Cat {snapshot.cat.x.toFixed(1)}, {snapshot.cat.y.toFixed(1)}.
            </p>
            <p>
              Cheeses{' '}
              {init.cheeses
                .map((point) => `${point.x}, ${point.y}`)
                .join(' and ')}
              . Exit {init.exit.x}, {init.exit.y}.
            </p>
            <pre class="text-map" aria-label="Map walls and floor">
              {init.map.rows.join('\n')}
            </pre>
          </details>
        </div>
        <div class="game-controls">
          {active ? (
            <>
              <div
                ref={area}
                class="joystick"
                role="group"
                tabIndex={0}
                aria-label="Movement controls"
                aria-describedby="control-help"
                onKeyDown={(event) => {
                  if (event.key === ' ' && !event.repeat) {
                    event.preventDefault();
                    if (
                      canDash &&
                      snapshot.phase === 1 &&
                      snapshot.dashCooldownMS === 0
                    )
                      dash();
                  }
                }}
              >
                <span>Drag to move</span>
                {inputView?.pointer !== undefined ? (
                  <span
                    class="joystick-center"
                    aria-hidden="true"
                    style={{
                      left: inputView.pointer.x,
                      top: inputView.pointer.y,
                    }}
                  >
                    <span
                      class="joystick-knob"
                      style={{
                        transform: `translate(${inputView.direction.x * 18}vmin, ${inputView.direction.y * 18}vmin)`,
                      }}
                    />
                  </span>
                ) : null}
              </div>
              <p id="control-help">{tiltMessages[inputView?.tilt ?? 'off']}</p>
              {init.presentation.control === 'tilt' &&
              (inputView?.tilt ?? 'off') === 'off' ? (
                <p>
                  The host prefers tilt. Enable it with the button below; touch
                  works without permission.
                </p>
              ) : null}
              <div class="game-actions">
                {canDash ? (
                  <button
                    type="button"
                    disabled={
                      snapshot.phase !== 1 || snapshot.dashCooldownMS > 0
                    }
                    onClick={dash}
                  >
                    Dash
                    {snapshot.dashCooldownMS > 0
                      ? ` · ${(snapshot.dashCooldownMS / 1000).toFixed(1)} s`
                      : ''}
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-pressed={inputView?.mode !== 'tilt'}
                  onClick={() => input.current?.touch()}
                >
                  Touch
                </button>
                <button
                  type="button"
                  aria-pressed={inputView?.mode === 'tilt'}
                  disabled={
                    inputView?.tilt === 'permission' ||
                    inputView?.tilt === 'calibrating'
                  }
                  onClick={() => {
                    void input.current?.enableTilt();
                  }}
                >
                  Enable tilt
                </button>
              </div>
              {state.backpressure ? (
                <p role="alert">
                  Input queue is full. Release movement and try again.
                </p>
              ) : null}
            </>
          ) : !finished ? (
            <p>Read only — the host has not granted game input.</p>
          ) : null}
          <button
            type="button"
            class="sound-toggle"
            aria-pressed={muted}
            onClick={() => {
              void toggleSound();
            }}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
          {soundError ? (
            <p>Sound is unavailable. The game remains muted.</p>
          ) : null}
        </div>
      </div>
      {state.result !== undefined ? (
        <EscapeResult result={state.result} />
      ) : null}
    </section>
  );
}
