// Shared by player + host: WebSocket with auto-reconnect, server clock offset, wake lock.

export function connect({ onOpen, onMessage, onStatus }) {
  let ws;
  let delay = 500;
  let queue = [];

  function open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      onStatus?.(true);
      onOpen?.();
      queue.forEach((m) => ws.send(m));
      queue = [];
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.serverNow) clock.sync(msg.serverNow);
      onMessage(msg);
    };
    ws.onclose = () => {
      onStatus?.(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }
  open();

  // Reconnect immediately when a phone wakes up / tab returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState > 1) {
      delay = 0;
      ws.close();
    }
  });

  return {
    send(msg) {
      const raw = JSON.stringify(msg);
      if (ws.readyState === 1) ws.send(raw);
      else queue.push(raw);
    },
  };
}

// ponytail: offset ignores network latency (~tens of ms); fine for a seconds countdown.
export const clock = {
  offset: 0,
  sync(serverNow) {
    this.offset = serverNow - Date.now();
  },
  now() {
    return Date.now() + this.offset;
  },
};

export function keepAwake() {
  let lock = null;
  async function req() {
    try {
      if (document.visibilityState === 'visible' && !lock) {
        lock = await navigator.wakeLock?.request('screen');
        lock?.addEventListener('release', () => (lock = null));
      }
    } catch {
      /* not supported / denied: harmless */
    }
  }
  document.addEventListener('visibilitychange', req);
  document.addEventListener('click', req, { once: true });
  req();
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** Show exactly one <section data-screen>. */
export function showScreen(name) {
  for (const s of document.querySelectorAll('[data-screen]')) s.hidden = s.dataset.screen !== name;
}

export function el(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') for (const [p, val] of Object.entries(v)) e.style.setProperty(p, val);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...children.flat().filter((c) => c != null));
  return e;
}

/** Remaining seconds (ceil) until endsAt using server clock. */
export const remaining = (endsAt) => Math.max(0, Math.ceil((endsAt - clock.now()) / 1000));

/** Remove diacritics + lowercase, for search. */
export const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
