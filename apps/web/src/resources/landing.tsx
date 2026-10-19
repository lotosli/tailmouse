import { useState } from 'preact/hooks';
import { CopyCommand, Feedback } from './help.tsx';
import './workspace.css';
import './landing.css';

const workflow = [
  {
    title: 'Preview the change',
    heading: 'Open the app. Skip the setup.',
    text: 'Your colleague opens one link and checks your running development app in a browser.',
    visual: '01 / PREVIEW',
    detail: 'A live view of the app running on your machine.',
  },
  {
    title: 'Send a reproduction',
    heading: 'Bring the failing case into the session.',
    text: 'Your colleague sends a small test file. A confirmed receipt shows the name and path saved on your machine.',
    visual: '02 / SEND FILE',
    detail: 'Sending → Verifying → Received by host',
  },
  {
    title: 'Use the terminal',
    heading: 'Choose the next command together.',
    text: 'With input permission, your colleague inserts the received path into the terminal input field, reviews it, then explicitly sends it. Nothing runs automatically.',
    visual: '03 / TERMINAL',
    detail: 'Review the prepared input before sending.',
  },
  {
    title: 'Verify the result',
    heading: 'Check the fix in the same workspace.',
    text: 'Return to the preview and repeat the failing step. Terminal, preview and file receipt stay together.',
    visual: '04 / VERIFY',
    detail: 'One workspace for the whole feedback loop.',
  },
  {
    title: 'End sharing',
    heading: 'Close access when the task is done.',
    text: 'The host ends the session. Its managed terminal stops; the existing web server and confirmed files remain on the host.',
    visual: '05 / FINISH',
    detail: 'Visitor access ends. Confirmed files stay.',
  },
];

export function ResourceLanding() {
  const [step, setStep] = useState(0);
  const selected = workflow[step]!;
  return (
    <main class="resource-shell landing">
      <header class="landing-nav">
        <a class="workspace-brand" href="/" aria-label="TailMouse home">
          TailMouse <span class="alpha-badge">Private alpha</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#guide">Guide</a>
          <a href="#compatibility">Compatibility</a>
          <a
            href="https://github.com/lotosli/tailmouse"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        </nav>
      </header>
      <section class="landing-hero" aria-labelledby="hero-title">
        <p class="eyebrow">Your machine. Their browser.</p>
        <h1 id="hero-title">
          Let them test
          <br />
          your work.
          <br />
          <span>Skip the setup.</span>
        </h1>
        <p class="hero-description">
          One link to preview your app, send reproduction files, and use a
          terminal when you allow it.
        </p>
        <div class="landing-actions">
          <a class="button-link" href="#get-started">
            Get TailMouse
          </a>
          <a class="button-link secondary" href="#workflow">
            See a complete workflow <span aria-hidden="true">↓</span>
          </a>
        </div>
        <p class="hero-footnote">
          The host runs TailMouse. Guests only need a browser. No account.
        </p>
      </section>

      <section
        id="workflow"
        class="landing-section"
        aria-labelledby="workflow-title"
      >
        <p class="eyebrow">One task, one shared workspace</p>
        <h2 id="workflow-title">From “can you reproduce this?” to “fixed.”</h2>
        <p>
          Dev brings two or more resources together. This walkthrough
          illustrates the flow; it does not start a live session.
        </p>
        <div
          class="workflow-steps"
          role="group"
          aria-label="Collaboration walkthrough"
        >
          {workflow.map((item, index) => (
            <button
              key={item.title}
              class="secondary"
              aria-pressed={step === index}
              onClick={() => setStep(index)}
            >
              <span>{index + 1}</span> {item.title}
            </button>
          ))}
        </div>
        <article class="workflow-detail" aria-live="polite">
          <div class="workflow-visual">
            <span class="eyebrow">{selected.visual}</span>
            <strong>{selected.detail}</strong>
            <span class="workflow-dots" aria-hidden="true">
              ● ● ●
            </span>
          </div>
          <div>
            <h3>{selected.heading}</h3>
            <p>{selected.text}</p>
          </div>
        </article>
        <p>
          Already running an app on port 5173? Create a dedicated upload folder,
          then share it with an interactive shell:
        </p>
        <CopyCommand
          command={
            'curl -fSso ./tailmouse-config.json https://tailmouse.com/tailmouse-config.json\nmkdir -p ./tailmouse-uploads\ntailmouse dev --config ./tailmouse-config.json --web 5173 --receive ./tailmouse-uploads -- sh'
          }
          label="Copy Dev example"
        />
        <p class="guide-note">
          Requires a running development server and a Unix shell. Terminal
          guests can run commands with your user permissions; the shell is not a
          sandbox.
        </p>
      </section>

      <section
        id="get-started"
        class="landing-section"
        aria-labelledby="get-title"
      >
        <p class="eyebrow">Start on the sharing machine</p>
        <h2 id="get-title">Get the matching TailMouse build.</h2>
        <div class="availability-note">
          <strong>Public CLI downloads are being prepared.</strong>
          <p>
            Build the sharing app from source or use the matching test build
            supplied by your host. Guests do not install anything.
          </p>
          <a
            href="https://github.com/lotosli/tailmouse/tree/codex/product-onboarding-2026-10#build-from-source"
            target="_blank"
            rel="noopener noreferrer"
          >
            Build from source ↗
          </a>{' '}
          <a
            href="https://github.com/lotosli/tailmouse/releases"
            target="_blank"
            rel="noopener noreferrer"
          >
            Check release availability ↗
          </a>
        </div>
        <p>
          On the sharing machine, check that your build provides the four
          commands below. A build listing only Escape and Leash cannot run these
          examples.
        </p>
        <CopyCommand
          command={
            'tailmouse version\ntailmouse cli --help\ntailmouse web --help\ntailmouse receive --help\ntailmouse dev --help'
          }
          label="Copy version checks"
        />
        <p>
          Keep the version supplied with your invitation. If the workspace
          reports an incompatible host, ask the host for a matching build and a
          new link.
        </p>
      </section>

      <section id="guide" class="landing-section" aria-labelledby="guide-title">
        <p class="eyebrow">Your first successful share</p>
        <h2 id="guide-title">Send one small file from another device.</h2>
        <p>
          Start with Receive. You need the matching CLI, a writable folder, and
          a second device with a current browser. No AI tool or running app is
          required.
        </p>
        <ol class="getting-started">
          <li>
            <h3>Create a dedicated folder and start sharing.</h3>
            <CopyCommand
              command={
                'curl -fSso ./tailmouse-config.json https://tailmouse.com/tailmouse-config.json\nmkdir -p ./tailmouse-uploads\ntailmouse receive --config ./tailmouse-config.json ./tailmouse-uploads'
              }
              label="Copy first-share command"
            />
            <p>
              The command downloads the public configuration for this private
              tailmouse.com test. Keep the host terminal open; TailMouse prints
              a sharing link and the session settings.
            </p>
          </li>
          <li>
            <h3>Open the link on the second device.</h3>
            <p>
              Send the link privately or scan its QR code. If approval is
              enabled, the host must approve the visitor. Do not post the link
              in a public issue.
            </p>
          </li>
          <li>
            <h3>Send a small, non-sensitive file.</h3>
            <p>
              Choose a file in “Send files to host”. Wait for “Received by
              host”, then check the saved name in the receipt and the file in
              your host folder. Reaching 100% alone is not success.
            </p>
          </li>
          <li>
            <h3>End sharing on the host.</h3>
            <p>
              Use the host's end-session action. Confirm that visitor access
              ends and the received file remains in your folder. “Leave
              workspace” only disconnects that visitor.
            </p>
          </li>
        </ol>
        <details class="guide-details">
          <summary>Already have a local development server?</summary>
          <CopyCommand command="tailmouse web 8080" label="Copy Web example" />
          <p>
            8080 means <code>127.0.0.1:8080</code> on the machine running
            TailMouse. A server listening on <code>0.0.0.0:8080</code> usually
            accepts this loopback connection. A server bound only to a LAN or
            public address does not: use an explicit target and the required
            remote-target opt-in.
          </p>
          <p>
            Open the service locally first. The whole configured origin is
            shared; an initial path does not restrict which paths a guest can
            reach.
          </p>
        </details>
      </section>

      <section
        id="permissions"
        class="landing-section"
        aria-labelledby="permissions-title"
      >
        <p class="eyebrow">Choose what a visitor can do</p>
        <h2 id="permissions-title">Share only the tools the task needs.</h2>
        <div class="landing-cards">
          <article>
            <h3>Only view the app</h3>
            <p>Share the browser preview without terminal access.</p>
            <CopyCommand
              command="tailmouse web 8080"
              label="Copy preview command"
            />
          </article>
          <article>
            <h3>Watch a terminal</h3>
            <p>Guests see output; terminal input stays with the host.</p>
            <CopyCommand
              command="tailmouse cli --read-only -- sh"
              label="Copy readonly command"
            />
          </article>
          <article>
            <h3>Allow terminal input</h3>
            <p>
              Share an interactive process. One controller types at a time; the
              host retains priority.
            </p>
            <CopyCommand
              command="tailmouse cli -- sh"
              label="Copy terminal command"
            />
          </article>
          <article>
            <h3>Receive files</h3>
            <p>
              Guests can send files into one chosen folder. They cannot browse
              existing files.
            </p>
            <CopyCommand
              command="tailmouse receive ./tailmouse-uploads"
              label="Copy Receive command"
            />
          </article>
        </div>
        <p class="guide-note">
          A specified terminal program is not a sandbox. Give input access only
          when you intend to let the visitor operate it with your permissions.
        </p>
        <details class="guide-details">
          <summary>Session duration, visitor slots and ending access</summary>
          <p>
            Sessions expire after one hour by default. Reconnecting does not
            extend that deadline. Use the host's explicit lifetime setting if
            the task needs a different duration.
          </p>
          <p>
            When the host ends sharing or the session expires, the managed
            terminal process ends. An existing web server keeps running.
            Confirmed files stay in the receiving folder.
          </p>
          <p>
            The default is one visitor. <code>--open</code> opens an ordinary
            visitor link and can occupy that slot. For the host's browser and
            another visitor together, use <code>--max-clients 2</code>.
          </p>
          <CopyCommand
            command="tailmouse web 8080 --max-clients 2 --open"
            label="Copy two-visitor example"
          />
        </details>
      </section>

      <section
        id="compatibility"
        class="landing-section"
        aria-labelledby="compatibility-title"
      >
        <p class="eyebrow">Know what to expect</p>
        <h2 id="compatibility-title">A browser development preview.</h2>
        <p>
          Use it for an interactive visit to your running app. Webhooks, OAuth
          callback endpoints, curl access and general public HTTP tunnels are
          outside this preview flow.
        </p>
        <div class="compatibility-grid">
          <article>
            <h3>Current test setup</h3>
            <p>
              The interface and preview use tailmouse.com during this private
              test. Open only apps you trust. This setup does not provide
              isolation from untrusted preview pages.
            </p>
          </article>
          <article>
            <h3>Compatibility evidence</h3>
            <p>
              On 17 October 2026, automated entry-page and guide checks passed
              in Chromium 151, Firefox 153 and WebKit 26.5 at desktop and phone
              widths. This is not a native mobile-device or framework
              compatibility certification.
            </p>
            <p>
              Native platform packages and named framework combinations will be
              listed when a matching release is verified. Native Windows is not
              part of this alpha's platform promise.
            </p>
          </article>
        </div>
      </section>
      <section id="escape" class="landing-section escape-section">
        <h2>The mouse is still here.</h2>
        <p>
          Escape remains available as a secondary demo. Run it on the host, then
          open its invitation in a browser.
        </p>
        <CopyCommand command="tailmouse escape" label="Copy Escape command" />
      </section>
      <footer class="landing-footer">
        <Feedback phase="onboarding" />
        <p>Powered by Tailcat · No account · Guests join in a browser.</p>
        <nav aria-label="Footer navigation">
          <a
            href="https://github.com/lotosli/tailmouse"
            target="_blank"
            rel="noopener noreferrer"
          >
            Source
          </a>
          <a href="#escape">Escape minigame</a>
          <a href="#get-started">Get TailMouse</a>
        </nav>
      </footer>
    </main>
  );
}
