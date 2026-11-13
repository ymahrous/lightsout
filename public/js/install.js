// "Add to home screen": the install prompt on Android and desktop Chrome or Edge, the
// manual steps on iPhone and iPad, and the service worker that makes the app work offline.

const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPadOS reports itself as a Mac, so a touch screen on "MacIntel" is an iPad.
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * `onChange` is called when installing becomes possible or stops being possible.
 * `isIdle` says whether the player is somewhere a reload would not interrupt (the home screen).
 */
export function createInstall(onChange, isIdle = () => false) {
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; onChange(); });
  window.addEventListener('appinstalled', () => { deferred = null; onChange(); });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // A new version waits until it is safe to switch: never in the middle of a game.
        const tryUpdate = () => { if (reg.waiting && navigator.serviceWorker.controller && isIdle()) reg.waiting.postMessage('skip'); };
        reg.addEventListener('updatefound', () => {
          const w = reg.installing; if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') tryUpdate(); });
        });
        document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reg.update().catch(() => {}); tryUpdate(); } });
        tryUpdate();
      }).catch(() => {});
      // Reload only when a newer version replaces an older one, never when the first one takes over.
      let hadController = !!navigator.serviceWorker.controller, reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController && !reloading && isIdle()) { reloading = true; location.reload(); }
        hadController = true;
      });
    });
  }

  return {
    /** True when this browser can add the app to the home screen and it is not there already. */
    available: () => !isStandalone() && (!!deferred || isIOS()),
    /** Show the browser's own prompt, or report 'ios' so the page can show the manual steps. */
    prompt() {
      if (deferred) {
        const d = deferred; deferred = null;
        d.prompt(); d.userChoice.finally(onChange);
        return 'prompted';
      }
      return isIOS() ? 'ios' : null;
    }
  };
}
