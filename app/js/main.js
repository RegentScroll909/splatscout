// App entry: hash router + service worker registration.

import { homeScreen } from './ui/home.js';
import { setupScreen } from './ui/setup.js';
import { captureScreen } from './ui/captureScreen.js';
import { reviewScreen } from './ui/review.js';
import { learnScreen } from './ui/learn.js';
import { settingsScreen } from './ui/settingsScreen.js';
import { h, mount } from './ui/dom.js';

const root = document.getElementById('app');
let cleanup = null;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

async function route() {
  if (typeof cleanup === 'function') {
    try {
      cleanup();
    } catch {}
  }
  cleanup = null;
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const query = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const ctx = { navigate, query };
  window.scrollTo(0, 0);
  try {
    if (!parts.length) cleanup = await homeScreen(root, ctx);
    else if (parts[0] === 'new') cleanup = await setupScreen(root, ctx);
    else if (parts[0] === 'capture') cleanup = await captureScreen(root, { ...ctx, captureId: parts[1] });
    else if (parts[0] === 'review') cleanup = await reviewScreen(root, { ...ctx, captureId: parts[1] });
    else if (parts[0] === 'learn') cleanup = learnScreen(root, ctx);
    else if (parts[0] === 'settings') cleanup = settingsScreen(root, ctx);
    else navigate('#/');
  } catch (e) {
    console.error(e);
    mount(root, h('div.page', h('h1', 'Something went wrong'), h('pre.error', String(e && e.stack || e)), h('button.btn', { onclick: () => navigate('#/') }, 'Home')));
  }
}

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
