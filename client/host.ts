import type { GameListing, HostActionMsg, HostGame } from '../shared/types.ts';
import { connect, keepAwake, clock, $, el, showScreen, remaining, themeButtons, czPlural, votesWord } from './net.ts';

const KEY_STORE = 'kdo-host-key';
const SOUND_STORE = 'kdo-host-sound';
let hostKey = read(KEY_STORE);
let authed = false;
let s: HostGame | null = null; // last host state (msg.game)
let publicUrl = '';
let resultsKey: string | null = null;
let lastBeep: string | null = null;
let gongTimer: ReturnType<typeof setTimeout> | undefined;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string | null): void {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

const controlsBar = $('#controls');
const loginError = $('#loginError');
const optAuto = $<HTMLInputElement>('#optAuto');
const optSound = $<HTMLInputElement>('#optSound');

const net = connect({
  onOpen() {
    if (hostKey) net.send({ t: 'host', key: hostKey });
    else showScreen('login');
  },
  onStatus(ok) {
    $('#conn').hidden = ok;
  },
  onMessage(msg) {
    if (msg.t === 'hostOk') {
      authed = true;
      write(KEY_STORE, hostKey);
      net.send({ t: 'history' });
    } else if (msg.t === 'state' && msg.role === 'host') {
      publicUrl = msg.publicUrl || location.origin;
      const prev = s;
      s = msg.game;
      render(prev);
    } else if (msg.t === 'history') {
      renderHistory(msg.games);
    } else if (msg.t === 'error' && msg.code === 'unauthorized') {
      authed = false;
      hostKey = null;
      write(KEY_STORE, null);
      showScreen('login');
      controlsBar.hidden = true;
      loginError.textContent = msg.msg;
    }
  },
});
keepAwake();

type PlainAction = Exclude<HostActionMsg, { action: 'addTime' | 'settings' }>['action'];
const action = (name: PlainAction): void => net.send({ t: 'action', action: name });
const addTime = (): void => net.send({ t: 'action', action: 'addTime', seconds: 10 });

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  hostKey = $<HTMLInputElement>('#key').value;
  loginError.textContent = '';
  net.send({ t: 'host', key: hostKey });
});

$('#newGame').addEventListener('click', () => action('newGame'));
$('#menuNew').addEventListener('click', () => {
  if (confirm('Začít novou hru s novým PINem? Rozehraná hra se uloží do historie.')) action('newGame');
});
$('#menuFinish').addEventListener('click', () => {
  if (confirm('Ukončit hru a ukázat finální výsledky?')) action('finish');
});
optAuto.addEventListener('change', () => net.send({ t: 'action', action: 'settings', autoEndWhenAllVoted: optAuto.checked }));
optSound.checked = read(SOUND_STORE) !== 'off';
optSound.addEventListener('change', () => write(SOUND_STORE, optSound.checked ? 'on' : 'off'));
$('#fullscreen').addEventListener('click', toggleFullscreen);

themeButtons([$('#themeToggle'), $('#themeToggleHome')], (t) => (t === 'light' ? 'Tmavé zobrazení' : 'Světlé zobrazení'));

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.();
}

// ---------------- controls per phase ----------------

interface Control {
  label: string;
  primary?: boolean;
  fn: () => void;
}
let primary: (() => void) | null = null; // function for Space / →

function controls(buttons: Control[]): void {
  primary = buttons.find((b) => b.primary)?.fn ?? null;
  $('#ctlPhase').replaceChildren(
    ...buttons.map((b) =>
      el('button', { className: `btn small${b.primary ? '' : ' ghost'}`, onclick: b.fn }, b.label, b.primary ? el('span', { className: 'kbd' }, 'mezerník') : null),
    ),
  );
}

document.addEventListener('keydown', (e) => {
  if ((e.target instanceof Element && e.target.closest('input, textarea')) || e.repeat) return;
  if ((e.key === ' ' || e.key === 'ArrowRight') && primary) {
    e.preventDefault();
    primary();
  } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === '+' && s?.phase === 'question') addTime();
});

// ---------------- render ----------------

function render(prev: HostGame | null): void {
  if (!authed) return;
  controlsBar.hidden = !s;
  if (!s) {
    showScreen('home');
    net.send({ t: 'history' });
    return;
  }
  optAuto.checked = s.settings.autoEndWhenAllVoted;
  switch (s.phase) {
    case 'lobby':
      return renderLobby(s);
    case 'question':
      return renderQuestion(s);
    case 'results':
      return renderResults(s);
    case 'final':
      return renderFinal(s, prev);
  }
}

function renderLobby(g: HostGame): void {
  showScreen('lobby');
  const url = `${publicUrl}/?pin=${g.pin}`;
  const qr = $<HTMLImageElement>('#qr');
  const qrSrc = `/qr.svg?text=${encodeURIComponent(url)}`;
  if (qr.getAttribute('src') !== qrSrc) qr.src = qrSrc;
  $('#joinUrl').textContent = publicUrl.replace(/^https?:\/\//, '');
  $('#lobbyPin').textContent = g.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
  $('#lobbyCount').textContent = String(g.players.length);
  // append only new nameplates so existing ones don't re-animate
  const box = $('#bubbles');
  if (box.dataset.pin !== g.pin) {
    box.replaceChildren();
    box.dataset.pin = g.pin;
  }
  for (const p of g.players.slice(box.children.length)) {
    box.append(el('span', {}, p.name));
  }
  $('#lobbyHint').hidden = g.players.length > 0;
  controls([{ label: 'Spustit hru', primary: true, fn: () => action('next') }]);
}

function renderQuestion(g: HostGame): void {
  showScreen('question');
  $('#qPos').textContent = `Otázka ${g.pos + 1} z ${g.total}`;
  $('#qPin').textContent = g.pin;
  $('#qText').textContent = g.question?.text ?? '';
  $('#voted').textContent = String(g.voted);
  $('#votedOf').textContent = String(g.players.length);
  resultsKey = null;
  controls([
    { label: '+10 s', fn: () => addTime() },
    { label: 'Ukončit hlasování', primary: true, fn: () => action('endNow') },
    { label: 'Přeskočit otázku', fn: () => confirm('Přeskočit otázku bez výsledků?') && action('skip') },
  ]);
}

function renderResults(g: HostGame): void {
  showScreen('results');
  const last = g.pos + 1 >= g.total;
  controls([
    { label: 'Zopakovat otázku', fn: () => confirm('Spustit tuto otázku znovu? Hlasy se smažou.') && action('repeat') },
    { label: last ? 'Finále' : 'Další otázka', primary: true, fn: () => action('next') },
  ]);
  const key = `${g.pos}|${g.startedAt}`;
  if (key === resultsKey) return; // don't replay the reveal on unrelated updates
  resultsKey = key;

  $('#rPos').textContent = `Výsledky · otázka ${g.pos + 1} z ${g.total}`;
  $('#rPin').textContent = g.pin;
  $('#rText').textContent = g.question?.text ?? '';
  const rows = g.results ?? [];
  const winners = rows.filter((r) => r.rank === 1);
  const w = winners[0];
  if (!w) {
    $('#rWin').replaceChildren(el('p', { className: 'empty' }, 'Nikdo nehlasoval.'));
    $('#rBars').replaceChildren();
    return;
  }
  const total = Math.max(1, g.voted, rows.reduce((n, r) => n + r.votes, 0));
  const pct = (v: number) => Math.round((v / total) * 100);
  const runners = rows.filter((r) => r.rank !== 1).slice(0, 4);
  const max = w.votes;
  const step = 0.45;
  // runners-up land first (lowest rank first), a beat of "A nejspíš…", then the winner wipes in
  const t = runners.length * step + 1.1;
  $('#rBars').replaceChildren(
    ...runners.map((r, i) =>
      el('li', { style: { '--delay': `${(runners.length - 1 - i) * step}s`, '--pct': `${(r.votes / max) * 100}%` } },
        el('span', { className: 'n' }, `${r.rank}.`),
        el('span', { className: 'nm' }, r.person),
        el('span', { className: 'mini' }, el('i')),
        el('span', { className: 'v' }, `${r.votes} ${votesWord(r.votes)} · ${pct(r.votes)} %`),
      ),
    ),
  );
  const rWin = $('#rWin');
  rWin.className = `spot${winners.length > 1 ? ' tie' : ''}`;
  rWin.style.setProperty('--t', `${t}s`);
  rWin.replaceChildren(
    el('p', { className: 'tease', 'aria-hidden': 'true' }, 'A nejspíš…'),
    el('div', { className: 'who' },
      el('h2', { className: 'head ruled' }, winners.map((r) => r.person).join(' & ')),
      el('div', { className: 'share', style: { '--pct': `${pct(w.votes)}%` } },
        el('span', { className: 'bar' }, el('i')),
        el('span', { className: 'v' }, `${winners.length > 1 ? 'remíza · ' : ''}${w.votes} ${votesWord(w.votes)} · ${pct(w.votes)} %`),
      ),
    ),
  );
  clearTimeout(gongTimer);
  gongTimer = setTimeout(gong, t * 1000);
}

function renderFinal(g: HostGame, prev: HostGame | null): void {
  showScreen('final');
  controls([
    { label: 'Stáhnout výsledky', fn: () => downloadCurrent(g.pin) },
    { label: 'Zavřít hru', primary: true, fn: () => confirm('Zavřít hru? Výsledky zůstanou v archivu.') && action('closeGame') },
  ]);
  const list = $('#fList');
  if (prev?.phase === 'final' && list.children.length) return;
  const sum = g.summary;
  if (!sum) return;
  $('#fChamp').textContent = sum.champions.join(' & ') || '—';
  $('#fChampSub').textContent = sum.championWins
    ? `Vyhrál/a ${sum.championWins} ${czPlural(sum.championWins, 'otázku', 'otázky', 'otázek')} z ${sum.questions.length}.`
    : '';
  // who else kept winning: tally wins per person, champions excluded
  const wins = new Map<string, number>();
  for (const q of sum.questions) for (const p of q.winners) wins.set(p, (wins.get(p) ?? 0) + 1);
  const next = [...wins].filter(([p]) => !sum.champions.includes(p)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'cs')).slice(0, 3);
  $('#fPodium').replaceChildren(
    ...next.map(([p, n], i) =>
      el('li', { style: { '--delay': `${0.6 + i * 0.15}s` } },
        el('span', { className: 'n' }, `${i + 2}.`),
        el('span', { className: 'nm' }, p),
        el('span', { className: 'v' }, `${n} ${czPlural(n, 'otázka', 'otázky', 'otázek')}`),
      ),
    ),
  );
  list.replaceChildren(
    ...sum.questions.map((q, i) =>
      el('li', { style: { '--delay': `${0.3 + i * 0.07}s` } },
        el('span', { className: 'q' }, q.text),
        el('span', { className: 'w' }, q.winners.length ? q.winners.join(', ') : '—'),
      ),
    ),
  );
}

// ---------------- countdown + sound ----------------

const ringNum = $('#ringNum');
const ringFill = $('#ringFill');
function frame(): void {
  if (s?.phase === 'question' && s.endsAt !== null) {
    const left = remaining(s.endsAt);
    ringNum.textContent = String(left);
    const frac = Math.min(1, Math.max(0, (s.endsAt - clock.now()) / ((s.duration ?? 1) * 1000)));
    ringFill.style.width = `${frac * 100}%`;
    const beepKey = `${s.startedAt}|${left}`;
    if (left > 0 && left <= 5 && lastBeep !== beepKey) {
      lastBeep = beepKey;
      beep(660, 0.12);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let audio: AudioContext | undefined;
function tone(freq: number, dur: number, type: OscillatorType = 'sine', when = 0): void {
  if (!optSound.checked) return;
  audio ??= new AudioContext();
  const t = audio.currentTime + when;
  const o = audio.createOscillator();
  const g = audio.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(audio.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}
const beep = (f: number, d: number): void => tone(f, d, 'square');
function gong(): void {
  tone(523, 0.5, 'triangle');
  tone(659, 0.5, 'triangle', 0.12);
  tone(784, 0.9, 'triangle', 0.24);
}

// ---------------- history / downloads ----------------

function renderHistory(games: GameListing[]): void {
  if (!games.length) return;
  $('#history').replaceChildren(
    ...games.map((g) =>
      el('div', { className: 'item' },
        el('span', {},
          el('b', {}, g.broken ? g.name : new Date(g.createdAt).toLocaleString('cs-CZ')),
          g.broken ? null : el('span', { className: 'muted' }, ` · ${g.players} hráčů · ${g.questions} otázek · 👑 ${g.champions.join(', ') || '—'}`),
        ),
        el('button', { className: 'btn small ghost', onclick: () => void download(`/api/games/${g.name}`, g.name) }, 'Stáhnout'),
      ),
    ),
  );
}

const downloadCurrent = (pin: string): Promise<void> => download('/api/current', `vysledky-${pin}.json`);

async function download(url: string, name: string): Promise<void> {
  const res = await fetch(url, { headers: { 'x-host-key': hostKey ?? '' } });
  if (!res.ok) return alert('Stažení selhalo.');
  const a = el('a', { href: URL.createObjectURL(await res.blob()), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
