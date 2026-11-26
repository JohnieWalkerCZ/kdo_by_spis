import { connect, keepAwake, clock, $, el, showScreen, remaining } from './net.js';

const KEY_STORE = 'kdo-host-key';
const SOUND_STORE = 'kdo-host-sound';
let hostKey = read(KEY_STORE);
let authed = false;
let s = null; // last host state (msg.game)
let publicUrl = '';
let resultsKey = null;
let lastBeep = null;

function read(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k, v) {
  try {
    v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

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
      $('#controls').hidden = true;
      $('#loginError').textContent = msg.msg;
    }
  },
});
keepAwake();

const action = (name, extra = {}) => net.send({ t: 'action', action: name, ...extra });

$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  hostKey = $('#key').value;
  $('#loginError').textContent = '';
  net.send({ t: 'host', key: hostKey });
});

$('#newGame').addEventListener('click', () => action('newGame'));
$('#menuNew').addEventListener('click', () => {
  if (confirm('Začít novou hru s novým PINem? Rozehraná hra se uloží do historie.')) action('newGame');
});
$('#menuFinish').addEventListener('click', () => {
  if (confirm('Ukončit hru a ukázat finální výsledky?')) action('finish');
});
$('#optAuto').addEventListener('change', (e) => action('settings', { autoEndWhenAllVoted: e.target.checked }));
$('#optSound').checked = read(SOUND_STORE) !== 'off';
$('#optSound').addEventListener('change', (e) => write(SOUND_STORE, e.target.checked ? 'on' : 'off'));
$('#fullscreen').addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// ---------------- controls per phase ----------------

let primary = null; // function for Space / →

function controls(buttons) {
  primary = buttons.find((b) => b.primary)?.fn ?? null;
  $('#ctlPhase').replaceChildren(
    ...buttons.map((b) =>
      el('button', { className: `btn small${b.primary ? '' : ' ghost'}`, onclick: b.fn }, b.label, b.primary ? el('span', { className: 'kbd' }, 'mezerník') : null),
    ),
  );
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.repeat) return;
  if ((e.key === ' ' || e.key === 'ArrowRight') && primary) {
    e.preventDefault();
    primary();
  } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  else if (e.key === '+' && s?.phase === 'question') action('addTime', { seconds: 10 });
});

// ---------------- render ----------------

function render(prev) {
  if (!authed) return;
  $('#controls').hidden = !s;
  if (!s) {
    showScreen('home');
    net.send({ t: 'history' });
    return;
  }
  $('#optAuto').checked = !!s.settings.autoEndWhenAllVoted;
  if (s.phase === 'lobby') renderLobby();
  else if (s.phase === 'question') renderQuestion();
  else if (s.phase === 'results') renderResults(prev);
  else if (s.phase === 'final') renderFinal(prev);
}

function renderLobby() {
  showScreen('lobby');
  const url = `${publicUrl}/?pin=${s.pin}`;
  const qrSrc = `/qr.svg?text=${encodeURIComponent(url)}`;
  if ($('#qr').getAttribute('src') !== qrSrc) $('#qr').src = qrSrc;
  $('#joinUrl').textContent = publicUrl.replace(/^https?:\/\//, '');
  $('#lobbyPin').textContent = s.pin.replace(/(\d{3})(\d{3})/, '$1 $2');
  $('#lobbyCount').textContent = s.players.length;
  // append only new nameplates so existing ones don't re-animate
  const box = $('#bubbles');
  if (box.dataset.pin !== s.pin) {
    box.replaceChildren();
    box.dataset.pin = s.pin;
  }
  for (const p of s.players.slice(box.children.length)) {
    box.append(el('span', {}, p.name));
  }
  $('#lobbyHint').hidden = s.players.length > 0;
  controls([{ label: 'Spustit hru', primary: true, fn: () => action('next') }]);
}


function renderQuestion() {
  showScreen('question');
  $('#qPos').textContent = `Otázka ${s.pos + 1} z ${s.total}`;
  $('#qPin').textContent = s.pin;
  $('#qText').textContent = s.question.text;
  $('#voted').textContent = s.voted;
  $('#votedOf').textContent = s.players.length;
  resultsKey = null;
  controls([
    { label: '+10 s', fn: () => action('addTime', { seconds: 10 }) },
    { label: 'Ukončit hlasování', primary: true, fn: () => action('endNow') },
    { label: 'Přeskočit otázku', fn: () => confirm('Přeskočit otázku bez výsledků?') && action('skip') },
  ]);
}

function renderResults() {
  showScreen('results');
  const last = s.pos + 1 >= s.total;
  controls([
    { label: 'Zopakovat otázku', fn: () => confirm('Spustit tuto otázku znovu? Hlasy se smažou.') && action('repeat') },
    { label: last ? 'Finále' : 'Další otázka', primary: true, fn: () => action('next') },
  ]);
  const key = `${s.pos}|${s.startedAt}`;
  if (key === resultsKey) return; // don't replay the reveal on unrelated updates
  resultsKey = key;
  gong();

  $('#rPos').textContent = `Výsledky · otázka ${s.pos + 1} z ${s.total}`;
  $('#rPin').textContent = s.pin;
  $('#rText').textContent = s.question.text;
  const rows = s.results ?? [];
  if (!rows.length) return $('#rBars').replaceChildren(el('p', { className: 'empty' }, 'Nikdo nehlasoval.'));
  const step = 0.6;
  // reveal from the lowest rank up; the winner's row lands last
  $('#rBars').replaceChildren(
    ...rows.map((r, i) =>
      el('li', { className: r.rank === 1 ? 'win' : '', style: { '--delay': `${(rows.length - 1 - i) * step + (r.rank === 1 ? 0.5 : 0)}s` } },
        el('span', { className: 'n' }, `${r.rank}.`),
        el('span', { className: 'nm' }, r.person),
        el('span', { className: 'v' }, `${r.votes} ${votesWord(r.votes)}`),
      ),
    ),
  );
}

const votesWord = (n) => (n === 1 ? 'hlas' : n >= 2 && n <= 4 ? 'hlasy' : 'hlasů');

function renderFinal(prev) {
  showScreen('final');
  controls([
    { label: 'Stáhnout výsledky', fn: downloadCurrent },
    { label: 'Zavřít hru', primary: true, fn: () => confirm('Zavřít hru? Výsledky zůstanou v archivu.') && action('closeGame') },
  ]);
  if (prev?.phase === 'final' && $('#fList').children.length) return;
  const sum = s.summary;
  $('#fChamp').textContent = sum.champions.join(' & ') || '—';
  $('#fChampSub').textContent = sum.championWins
    ? `Vyhrál/a ${sum.championWins} ${sum.championWins === 1 ? 'otázku' : sum.championWins <= 4 ? 'otázky' : 'otázek'} z ${sum.questions.length}.`
    : '';
  $('#fList').replaceChildren(
    ...sum.questions.map((q, i) =>
      el('li', { style: { '--delay': `${0.3 + i * 0.07}s` } },
        el('span', { className: 'q' }, q.text),
        el('span', { className: 'w' }, q.winners.length ? q.winners.join(', ') : '—'),
      ),
    ),
  );
}

// ---------------- countdown + sound ----------------

function frame() {
  if (s?.phase === 'question' && s.endsAt) {
    const left = remaining(s.endsAt);
    $('#ringNum').textContent = left;
    const frac = Math.min(1, Math.max(0, (s.endsAt - clock.now()) / (s.duration * 1000)));
    $('#ringFill').style.width = `${frac * 100}%`;
    const beepKey = `${s.startedAt}|${left}`;
    if (left > 0 && left <= 5 && lastBeep !== beepKey) {
      lastBeep = beepKey;
      beep(660, 0.12);
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let audio;
function tone(freq, dur, type = 'sine', when = 0) {
  if (!$('#optSound').checked) return;
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
const beep = (f, d) => tone(f, d, 'square');
function gong() {
  tone(523, 0.5, 'triangle');
  tone(659, 0.5, 'triangle', 0.12);
  tone(784, 0.9, 'triangle', 0.24);
}

// ---------------- history / downloads ----------------

function renderHistory(games) {
  if (!games.length) return;
  $('#history').replaceChildren(
    ...games.map((g) =>
      el('div', { className: 'item' },
        el('span', {},
          el('b', {}, g.broken ? g.name : new Date(g.createdAt).toLocaleString('cs-CZ')),
          g.broken ? null : el('span', { className: 'muted' }, ` · ${g.players} hráčů · ${g.questions} otázek · 👑 ${g.champions.join(', ') || '—'}`),
        ),
        el('button', { className: 'btn small ghost', onclick: () => download(`/api/games/${g.name}`, g.name) }, 'Stáhnout'),
      ),
    ),
  );
}

const downloadCurrent = () => download('/api/current', `vysledky-${s.pin}.json`);

async function download(url, name) {
  const res = await fetch(url, { headers: { 'x-host-key': hostKey } });
  if (!res.ok) return alert('Stažení selhalo.');
  const a = el('a', { href: URL.createObjectURL(await res.blob()), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
