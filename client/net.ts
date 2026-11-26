// Shared by player, host and admin: WebSocket with auto-reconnect, server clock offset, wake lock, theme.
import type { ClientMsg, ServerMsg } from '../shared/types.ts';

type Theme = 'light' | 'dark';

// Light/dark is each device's own choice, remembered only in that browser. Default dark (darkened hall).
const THEME_KEY = 'kdo-theme';
function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#ffffff' : '#141112');
}
const currentTheme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}
applyTheme(storedTheme());

/** Wire buttons that flip this device between light and dark. `label(theme)` renders the button text. */
export function themeButtons(buttons: HTMLElement[], label?: (theme: Theme) => string): void {
  const paint = () => {
    const t = currentTheme();
    for (const b of buttons) {
      b.setAttribute('aria-pressed', String(t === 'light'));
      if (label) b.textContent = label(t);
    }
  };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const next: Theme = currentTheme() === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* private mode: applies for this visit only */
      }
      paint();
    });
  }
  paint();
}

export interface ConnectOptions {
  onOpen?: () => void;
  onMessage: (msg: ServerMsg) => void;
  onStatus?: (online: boolean) => void;
}
export interface Connection {
  send(msg: ClientMsg): void;
}

export function connect({ onOpen, onMessage, onStatus }: ConnectOptions): Connection {
  let ws: WebSocket;
  let delay = 500;
  let queue: string[] = [];

  function open(): void {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    socket.onopen = () => {
      delay = 500;
      onStatus?.(true);
      onOpen?.();
      queue.forEach((m) => socket.send(m));
      queue = [];
    };
    socket.onmessage = (e) => {
      // same-origin server we ship ourselves: trusted shape, see shared/types.ts
      const msg = JSON.parse(String(e.data)) as ServerMsg;
      if ('serverNow' in msg) clock.sync(msg.serverNow);
      onMessage(msg);
    };
    socket.onclose = () => {
      onStatus?.(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }
  open();

  // Reconnect immediately when a phone wakes up / tab returns.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && ws.readyState > WebSocket.OPEN) {
      delay = 0;
      ws.close();
    }
  });

  return {
    send(msg) {
      const raw = JSON.stringify(msg);
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
      else queue.push(raw);
    },
  };
}

// ponytail: offset ignores network latency (~tens of ms); fine for a seconds countdown.
export const clock = {
  offset: 0,
  sync(serverNow: number): void {
    this.offset = serverNow - Date.now();
  },
  now(): number {
    return Date.now() + this.offset;
  },
};

export function keepAwake(): void {
  let lock: WakeLockSentinel | null = null;
  async function req(): Promise<void> {
    try {
      if (document.visibilityState === 'visible' && !lock) {
        lock = (await navigator.wakeLock?.request('screen')) ?? null;
        lock?.addEventListener('release', () => (lock = null));
      }
    } catch {
      /* not supported / denied: harmless */
    }
  }
  document.addEventListener('visibilitychange', req);
  document.addEventListener('click', req, { once: true });
  void req();
}

/** querySelector that throws instead of returning null: a missing element is a bug in the page, fail loudly. */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`Chybí element: ${sel}`);
  return found;
}

/** Show exactly one <section data-screen>. */
export function showScreen(name: string): void {
  for (const s of document.querySelectorAll<HTMLElement>('[data-screen]')) s.hidden = s.dataset.screen !== name;
}

export type Child = Node | string | null | undefined;
export type Props = { style?: Record<string, string> } & Record<string, unknown>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') for (const [p, val] of Object.entries(props.style ?? {})) e.style.setProperty(p, val);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) Object.assign(e, { [k]: v });
    else e.setAttribute(k, String(v));
  }
  e.append(...children.filter((c): c is Node | string => c != null));
  return e;
}

/** Remaining seconds (ceil) until endsAt using server clock. */
export const remaining = (endsAt: number): number => Math.max(0, Math.ceil((endsAt - clock.now()) / 1000));

/** Remove diacritics + lowercase, for search. */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Czech plural: 1 / 2–4 / 0, 5+. */
export const czPlural = (n: number, one: string, few: string, many: string): string => (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
export const votesWord = (n: number): string => czPlural(n, 'hlas', 'hlasy', 'hlasů');
