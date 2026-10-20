import { render } from 'preact';

import { App } from './app.tsx';
import { ResourceApp } from './resources/workspace.tsx';
import { BrowserShare } from './resources/browser-share.tsx';
import { ResourceLanding } from './resources/landing.tsx';
import { consumeRecovery } from './resources/invitation.ts';
import './style.css';

const root = document.querySelector('#app');
if (!(root instanceof HTMLElement)) {
  throw new Error('TailMouse application root is missing.');
}
const container = root;
let landing = false;
function mountRoute(): void {
  if (location.pathname === '/' && location.hash === '#share') {
    if (landing) render(null, container);
    render(<BrowserShare />, container);
    landing = false;
  } else if (
    location.pathname === '/.tailmouse/workspace/' ||
    location.hash.startsWith('#tm=') ||
    /^s-[a-f0-9]{32}\./u.test(location.hostname)
  ) {
    landing = false;
    render(null, container);
    try {
      render(
        <ResourceApp
          recovery={consumeRecovery(location, history, sessionStorage)}
        />,
        container,
      );
    } catch {
      history.replaceState(null, '', location.pathname + location.search);
      render(
        <ResourceApp
          recovery={null}
          initialError="The invitation or browser recovery storage is unavailable."
        />,
        container,
      );
    }
  } else if (
    location.pathname === '/' &&
    [
      '',
      '#get-started',
      '#workflow',
      '#guide',
      '#permissions',
      '#compatibility',
      '#escape',
    ].includes(location.hash)
  ) {
    if (landing) return;
    render(null, container);
    render(<ResourceLanding />, container);
    landing = true;
  } else {
    landing = false;
    render(null, container);
    render(<App />, container);
  }
}
mountRoute();
// Opening a second invitation in this tab can be a fragment-only navigation.
// Remount the session so its one-shot parser still consumes and erases it.
window.addEventListener('hashchange', mountRoute);
