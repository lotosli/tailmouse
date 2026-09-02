import { render } from 'preact';

import { App } from './app.tsx';
import './style.css';

const root = document.querySelector('#app');
if (!(root instanceof HTMLElement)) {
  throw new Error('TailMouse application root is missing.');
}
render(<App />, root);
