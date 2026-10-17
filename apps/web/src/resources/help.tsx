import { useState } from 'preact/hooks';
import { BUILD } from '../build.ts';
import type { SharedResource } from './session.ts';

export function CopyCommand({
  command,
  label = 'Copy command',
}: {
  command: string;
  label?: string;
}) {
  const [status, setStatus] = useState('');
  return (
    <div class="command-block">
      <pre>
        <code>{command}</code>
      </pre>
      <button
        class="secondary"
        onClick={() => {
          void Promise.resolve()
            .then(() => navigator.clipboard.writeText(command))
            .then(
              () => setStatus('Copied. Review the command before running it.'),
              () =>
                setStatus(
                  'Copy unavailable. Select and copy the command above.',
                ),
            );
        }}
      >
        {label}
      </button>
      <span role="status">{status}</span>
    </div>
  );
}

export function endConsequences(
  resources: readonly Pick<SharedResource, 'id'>[],
): string {
  return [
    'When the host ends sharing or the session expires, visitor access ends.',
    resources.some((r) => r.id === 'cli')
      ? 'The terminal process started by this session ends.'
      : '',
    resources.some((r) => r.id === 'web')
      ? 'The existing web server keeps running on the host.'
      : '',
    resources.some((r) => r.id === 'receive')
      ? 'Files already confirmed as received stay on the host.'
      : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function browserFamily(agent: string): string {
  if (/Edg\//u.test(agent)) return 'Edge';
  if (/Firefox\//u.test(agent)) return 'Firefox';
  if (/Chrome\//u.test(agent)) return 'Chrome / Chromium';
  if (/Version\/.*Safari\//u.test(agent)) return 'Safari';
  return 'Other';
}

export function feedbackReport(phase: string, agent: string): string {
  const safePhase = [
    'onboarding',
    'connecting',
    'waiting',
    'active',
    'reconnecting',
    'disconnected',
    'closed',
    'invitation',
  ].includes(phase)
    ? phase
    : 'unknown';
  return [
    'TailMouse feedback',
    `Web build: ${BUILD.version}`,
    `Tailcat: ${BUILD.tailcatRevision}`,
    `Resource protocol: ${BUILD.protocols.resource}`,
    `Browser: ${browserFamily(agent)}`,
    `Stage: ${safePhase}`,
  ].join('\n');
}

export function Feedback({ phase }: { phase: string }) {
  const [report, setReport] = useState('');
  const [status, setStatus] = useState('');
  return (
    <details class="feedback-panel">
      <summary>Help & feedback</summary>
      <p>
        <a href="/#guide" target="_blank" rel="noopener noreferrer">
          Open the getting started guide
        </a>{' '}
        or{' '}
        <a
          href="https://github.com/lotosli/tailmouse/issues/new"
          target="_blank"
          rel="noopener noreferrer"
        >
          report a problem on GitHub
        </a>
        .
      </p>
      <p>
        Describe the step that failed and the time it took. Keep invitation
        links, terminal output, file names and private addresses out of your
        report.
      </p>
      <button
        class="secondary"
        onClick={() => {
          setReport(feedbackReport(phase, navigator.userAgent));
          setStatus('');
        }}
      >
        Prepare a safe report
      </button>
      {report !== '' && (
        <>
          <pre aria-label="Feedback report">{report}</pre>
          <p>
            Review this report before copying. Nothing is sent automatically.
          </p>
          <button
            class="secondary"
            onClick={() => {
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(report))
                .then(
                  () =>
                    setStatus(
                      'Report copied. Paste it into your feedback when ready.',
                    ),
                  () =>
                    setStatus(
                      'Copy unavailable. Select and copy the report above.',
                    ),
                );
            }}
          >
            Copy report
          </button>
        </>
      )}
      <p role="status">{status}</p>
    </details>
  );
}
