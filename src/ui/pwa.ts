/**
 * Offline operation: registers the service worker (production builds only), reports when the app is
 * ready for offline use or a new version waits, and offers installation as an app.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach(l => l());
export function onPwaChange(l: Listener) { listeners.add(l); return () => { listeners.delete(l); }; }

interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }

export const pwa = {
  /** Everything is cached: the app works without a network. */
  offlineReady: false,
  /** A new version is installed and waits for a reload. */
  updateWaiting: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  canInstall: false,
};

let waiting: ServiceWorker | null = null;
let installEvent: InstallPrompt | null = null;

export function registerOffline(onMessage: (text: string) => void) {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => { pwa.online = true; emit(); });
  window.addEventListener('offline', () => { pwa.online = false; emit(); });
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e as InstallPrompt; pwa.canInstall = true; emit(); });
  window.addEventListener('appinstalled', () => { installEvent = null; pwa.canInstall = false; emit(); });
  // the desktop program has all files on disk: no service worker needed
  if ('formelwerkDesktop' in window) return;
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const track = (w: ServiceWorker | null) => {
      if (!w) return;
      const check = () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller && hadController) { waiting = w; pwa.updateWaiting = true; emit(); }
        if (w.state === 'activated') { pwa.offlineReady = true; emit(); if (!hadController) onMessage('FormelWerk ist jetzt auch ohne Internet nutzbar'); }
      };
      w.addEventListener('statechange', check);
      check();
    };
    if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; pwa.updateWaiting = true; emit(); }
    if (reg.active) { pwa.offlineReady = true; emit(); }
    track(reg.installing);
    reg.addEventListener('updatefound', () => track(reg.installing));
    // look for a new version when the window gets the focus again (at most every 30 minutes)
    let last = Date.now();
    window.addEventListener('focus', () => { if (Date.now() - last > 30 * 60e3 && navigator.onLine) { last = Date.now(); reg.update().catch(() => undefined); } });
  }).catch(() => undefined);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloading && pwa.updateWaiting) { reloading = true; location.reload(); } });
}

/** Activate the waiting version; the page reloads when it has taken over. */
export function applyUpdate() { waiting?.postMessage('skipWaiting'); }

export async function installApp(): Promise<boolean> {
  if (!installEvent) return false;
  await installEvent.prompt();
  const r = await installEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
  installEvent = null; pwa.canInstall = false; emit();
  return r.outcome === 'accepted';
}
