import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { Overlay } from './Overlay.tsx';
import { windowLabel, log } from './services/platform';

// One-time move of saved settings/login from the app's old name.
try {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith('afterglow.')) {
      const nk = 'songseam.' + k.slice('afterglow.'.length);
      if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(k) ?? '');
      localStorage.removeItem(k);
    }
  }
} catch {
  /* storage blocked: nothing to move */
}

windowLabel().then((label) => {
  log('info', 'ui started in window', label);
  createRoot(document.getElementById('root')!).render(<StrictMode>{label === 'overlay' ? <Overlay /> : <App />}</StrictMode>);
});
