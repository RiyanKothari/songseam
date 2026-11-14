import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { Overlay } from './Overlay.tsx';
import { windowLabel, log } from './services/platform';

windowLabel().then((label) => {
  log('info', 'ui started in window', label);
  createRoot(document.getElementById('root')!).render(<StrictMode>{label === 'overlay' ? <Overlay /> : <App />}</StrictMode>);
});
