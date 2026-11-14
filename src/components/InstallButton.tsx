import { useEffect, useState } from 'react';
import { isDesktop } from '../services/platform';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * "Install app": uses the browser's install prompt where there is one
 * (Android Chrome, Edge, desktop Chrome); on iPhone/iPad, where Safari has
 * no prompt, shows how to add it to the home screen.
 */
export function InstallButton() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(() => isDesktop || standalone());
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || (!prompt && !isIOS())) return null;

  return (
    <div className="relative">
      <button
        className="btn"
        onClick={async () => {
          if (prompt) {
            await prompt.prompt();
            const { outcome } = await prompt.userChoice;
            if (outcome === 'accepted') setInstalled(true);
            setPrompt(null);
          } else setIosHelp((v) => !v);
        }}
      >
        ⤓ Install app
      </button>
      {iosHelp && (
        <div className="install-help" role="dialog" aria-label="Install on iPhone">
          <b>Add SongSeam to your Home Screen</b>
          <ol>
            <li>
              Tap <b>Share</b> <span aria-hidden>⎙</span> in Safari's toolbar
            </li>
            <li>
              Choose <b>Add to Home Screen</b>
            </li>
            <li>
              Tap <b>Add</b>, then open SongSeam from its icon
            </li>
          </ol>
          <button className="btn-ghost text-xs" onClick={() => setIosHelp(false)}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
