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
  const [platform, setPlatform] = useState<'unix' | 'windows'>(() =>
    /Windows/u.test(navigator.userAgent) ? 'windows' : 'unix',
  );
  const selected = workflow[step]!;
  return (
    <main class="resource-shell landing">
      <header class="landing-nav">
        <a class="workspace-brand" href="/" aria-label="TailMouse home">
          TailMouse <span class="alpha-badge">1.0</span>
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
          Let them test your work. <span>Skip the setup.</span>
        </h1>
        <p class="hero-description">
          Share files, text, a local app or a terminal through one private
          browser link.
        </p>
        <div class="landing-actions">
          <a class="button-link" href="/#share">
            Send files or text in browser
          </a>
          <a class="button-link secondary" href="#get-started">
            Share an app or terminal
          </a>
        </div>
        <p class="hero-footnote">
          Files and text: neither device installs anything. Apps and terminals:
          only the sharing machine needs TailMouse. No account.
        </p>
      </section>
      <section id="guide" class="landing-section" aria-labelledby="guide-title">
        <p class="eyebrow">Your first successful share</p>
        <h2 id="guide-title">One file. Two browsers. Three steps.</h2>
        <ol class="getting-started">
          <li>
            <h3>Choose a file or enter text.</h3>
            <p>
              <a href="/#share">Open browser sharing</a> on the sending device.
              Selection errors appear before you start.
            </p>
          </li>
          <li>
            <h3>Connect the other device.</h3>
            <p>
              Start sharing, then privately copy the link, scan its QR code or
              use your device’s sharing sheet.
            </p>
          </li>
          <li>
            <h3>Confirm the result, then end sharing.</h3>
            <p>
              Keep both pages open. The receiving device verifies the download.
              End sharing when finished; files already downloaded stay on that
              device.
            </p>
          </li>
        </ol>
        <a class="button-link" href="/#share">
          Share from your browser ↗
        </a>
      </section>
      <section
        id="get-started"
        class="landing-section"
        aria-labelledby="get-title"
      >
        <p class="eyebrow">For local apps and terminals</p>
        <h2 id="get-title">Install once on the sharing machine.</h2>
        <p>
          TailMouse v1.0.0 includes hosted defaults. No configuration file or
          account is needed. Guests always join in a browser.
        </p>
        <div
          class="workflow-steps"
          role="group"
          aria-label="Installation platform"
        >
          <button
            class="secondary"
            aria-pressed={platform === 'unix'}
            onClick={() => setPlatform('unix')}
          >
            macOS / Linux
          </button>
          <button
            class="secondary"
            aria-pressed={platform === 'windows'}
            onClick={() => setPlatform('windows')}
          >
            Windows
          </button>
        </div>
        {platform === 'unix' ? (
          <CopyCommand
            command="curl -fsSL https://tailmouse.com/install.sh | sh"
            label="Copy macOS/Linux install"
          />
        ) : (
          <CopyCommand
            command="irm https://tailmouse.com/install.ps1 | iex"
            label="Copy Windows install"
          />
        )}
        <p>
          Run <code>tailmouse</code> for guided startup. On macOS/Linux, open a
          new terminal if the installer added TailMouse to PATH. Already
          installed? Run <code>tailmouse update</code>; package-manager
          installations use their manager.
        </p>
        <CopyCommand command="tailmouse web 8080" label="Copy Web example" />
        <p>
          Start your app locally first. Port 8080 means{' '}
          <code>127.0.0.1:8080</code> on the sharing machine. A server bound to{' '}
          <code>0.0.0.0:8080</code> usually accepts it; a LAN-only address
          requires an explicit target and remote opt-in.
        </p>
        <p>
          <a
            href="https://github.com/lotosli/tailmouse/releases/tag/v1.0.0"
            target="_blank"
            rel="noopener noreferrer"
          >
            Download v1.0.0 ↗
          </a>{' '}
          · <a href="/install.sh">Read the shell installer</a> ·{' '}
          <a href="/install.ps1">Read the PowerShell installer</a>
        </p>
        <details>
          <summary>Terminal, folders and receiving files</summary>
          <div class="landing-cards">
            <article>
              <h3>Watch a terminal</h3>
              <CopyCommand
                command="tailmouse cli --read-only -- sh"
                label="Copy readonly command"
              />
            </article>
            <article>
              <h3>Allow terminal input</h3>
              <CopyCommand
                command="tailmouse cli -- sh"
                label="Copy terminal command"
              />
            </article>
            <article>
              <h3>Offer a read-only folder</h3>
              <CopyCommand
                command="tailmouse files ./dist"
                label="Copy folder command"
              />
            </article>
            <article>
              <h3>Receive into a local folder (Linux/macOS)</h3>
              <CopyCommand
                command={
                  'mkdir -p ./tailmouse-uploads\ntailmouse receive ./tailmouse-uploads'
                }
                label="Copy first-share command"
              />
            </article>
          </div>
          <p>
            Unix examples use sh; on Windows choose powershell.exe. Terminal
            access uses your user permissions and is not a sandbox. Windows
            Receive is unsupported; macOS Receive needs APFS.
          </p>
        </details>
        <details>
          <summary>Manual installation, uninstall and recovery</summary>
          <p>
            Manual archives support macOS/Linux/Windows on x64 and ARM64.
            Packages are unsigned. Extract an archive and use ./tailmouse or
            .\\tailmouse.exe, or add it to PATH. For package-manager commands,
            removal, PATH repair and failed-update recovery, see the{' '}
            <a
              href="https://github.com/lotosli/tailmouse#install-or-upgrade"
              target="_blank"
              rel="noopener noreferrer"
            >
              installation guide
            </a>
            .
          </p>
        </details>
      </section>
      <section
        id="workflow"
        class="landing-section"
        aria-labelledby="workflow-title"
      >
        <p class="eyebrow">When a task needs more than one tool</p>
        <h2 id="workflow-title">Preview, reproduce, fix together.</h2>
        <p>
          Dev combines resources in one workspace. This walkthrough illustrates
          the flow; it does not start a live session.
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
          </div>
          <div>
            <h3>{selected.heading}</h3>
            <p>{selected.text}</p>
          </div>
        </article>
        <details>
          <summary>Start a combined workspace (Linux/macOS)</summary>
          <CopyCommand
            command={
              'mkdir -p ./tailmouse-uploads\ntailmouse dev --web 5173 --receive ./tailmouse-uploads -- sh'
            }
            label="Copy Dev example"
          />
          <p>
            Requires a running server and Unix shell. Ctrl+] opens local
            management; q in that menu ends sharing.
          </p>
        </details>
      </section>
      <section
        id="compatibility"
        class="landing-section"
        aria-labelledby="compatibility-title"
      >
        <h2 id="compatibility-title">Choose the right sharing mode.</h2>
        <div class="compatibility-grid">
          <article>
            <h3>Files and temporary text</h3>
            <p>
              Current browsers with WebAssembly and Workers. Up to 256 MiB per
              file; browsers without streaming save support have a 64 MiB
              download limit. Keep the hosting page open.
            </p>
          </article>
          <article>
            <h3>Local apps and terminals</h3>
            <p>
              Native archives: Linux, macOS and Windows, x64/ARM64. Windows
              Receive is unsupported; macOS Receive requires APFS. Packages are
              unsigned. Native execution evidence varies by platform.
            </p>
          </article>
        </div>
        <details>
          <summary>Preview, session and validation details</summary>
          <p>
            The browser preview shares the whole configured origin. It is not an
            endpoint for webhooks, curl or OAuth callbacks. The current
            tailmouse.com interface and previews share an origin; open only
            applications you trust.
          </p>
          <p>
            Sessions default to one hour and one visitor. --open occupies a
            visitor slot; use --max-clients 2 when needed. Ending a session
            stops its managed terminal; an existing web server and confirmed
            files remain.
          </p>
          <p>
            Linux automated acceptance and public browser transfers are
            verified. Cross-built archives are not evidence of execution on
            every native OS or physical phone. See{' '}
            <a
              href="https://github.com/lotosli/tailmouse/blob/main/docs/releases/v1.0.0.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              release notes and limits
            </a>
            .
          </p>
        </details>
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
          <a
            href="https://github.com/lotosli/tailmouse#build-from-source"
            target="_blank"
            rel="noopener noreferrer"
          >
            Build from source ↗
          </a>
          <a href="#get-started">Get TailMouse</a>
        </nav>
      </footer>
    </main>
  );
}
