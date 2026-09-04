/**
 * Register the service worker and auto-apply updates when the tab is idle.
 */

const UPDATE_TOAST_ID = 'pwa-update-toast';

let appBusy = false;
let reloadQueued = false;
let refreshing = false;

/**
 * Mark long-running work so PWA reload waits until idle or the tab is hidden.
 * @param {boolean} busy
 */
export function setPWABusy(busy) {
  appBusy = Boolean(busy);
  if (!appBusy) {
    flushQueuedReload();
  }
}

/**
 * Ask the active service worker for its stamped shell version.
 * @returns {Promise<string>}
 */
export async function getShellVersion() {
  if (!('serviceWorker' in navigator)) {
    return '';
  }
  const reg = await navigator.serviceWorker.ready;
  const worker = reg.active || navigator.serviceWorker.controller;
  if (!worker) {
    return '';
  }
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.type !== 'SW_VERSION') {
        return;
      }
      navigator.serviceWorker.removeEventListener('message', onMessage);
      const ver =
        typeof data.shell === 'string'
          ? data.shell
          : typeof data.version === 'string'
            ? data.version
            : '';
      resolve(ver);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'GET_VERSION' });
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve('');
    }, 1500);
  });
}

/**
 * @returns {Promise<void>}
 */
export async function registerPWA() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    wireAutoUpdate(reg);
  } catch (err) {
    console.warn('PWA registration failed', err);
  }
}

/**
 * @param {ServiceWorkerRegistration} reg
 */
function wireAutoUpdate(reg) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    queueReload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushQueuedReload();
    }
  });

  const askWaiting = () => {
    if (reg.waiting) {
      showUpdateToast('Updating...');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  askWaiting();

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) {
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        if (navigator.serviceWorker.controller) {
          showUpdateToast('Updating...');
          (reg.waiting || worker).postMessage({ type: 'SKIP_WAITING' });
        }
      }
    });
  });

  const check = () => {
    if (!navigator.onLine) {
      return;
    }
    reg.update().catch(() => {});
  };

  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check();
    }
  });
  window.addEventListener('focus', check);
  setInterval(check, 60 * 1000);
  check();
}

function queueReload() {
  reloadQueued = true;
  flushQueuedReload();
}

function flushQueuedReload() {
  if (!reloadQueued || refreshing) {
    return;
  }
  if (appBusy && document.visibilityState === 'visible') {
    showUpdateToast('Update ready...');
    return;
  }
  refreshing = true;
  showUpdateToast('Updating...');
  window.location.reload();
}

/**
 * @param {string} text
 */
function showUpdateToast(text) {
  let el = document.getElementById(UPDATE_TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = UPDATE_TOAST_ID;
    el.className = 'pwa-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-on');
}
