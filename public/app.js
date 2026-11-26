import { connect, keepAwake, clock, $, el, showScreen, remaining, fold } from './net.js';

const STORE = 'kdo-player';
let saved = load();
let current = null; // last state
let renderedKey = null; // which question the name list was built for
let pendingVote = null; // optimistic selection until server confirms

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE)) ?? {};
  } catch {
    return {};
  }
}
function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* private mode: rejoin will just create a new identity */
  }
}

const urlPin = new URLSearchParams(location.search).get('pin');
if (urlPin && /^\d{6}$/.test(urlPin)) {
  if (saved.pin !== urlPin) saved = { pin: urlPin };
  history.replaceState(null, '', location.pathname);
}

const net = connect({
  onOpen() {
    if (saved.pin) net.send({ t: 'join', pin: saved.pin, playerId: saved.playerId });
  },
  onStatus(ok) {
    $('#conn').hidden = ok;
  },
  onMessage(msg) {
    if (msg.t === 'joined') {
      saved = { pin: msg.pin, playerId: msg.playerId };
      persist();
    } else if (msg.t === 'state') {
      current = msg;
      if (pendingVote && msg.myVote === pendingVote) pendingVote = null;
      render();
    } else if (msg.t === 'error') {
      if (['bad_pin', 'game_over', 'rate_limited'].includes(msg.code)) {
        saved = {};
        persist();
        current = null;
        showScreen('join');
        $('#joinError').textContent = msg.code === 'game_over' && !$('#pin').value ? '' : msg.msg;
      } else if (msg.code === 'vote_closed') {
        pendingVote = null;
        render();
      }
    }
  },
});

keepAwake();
showScreen(saved.pin ? 'wait' : 'join');
if (saved.pin) $('#pin').value = saved.pin;

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = $('#pin').value.replace(/\D/g, '');
  if (pin.length !== 6) return ($('#joinError').textContent = 'PIN má 6 číslic.');
  $('#joinError').textContent = '';
  saved = { pin };
  net.send({ t: 'join', pin });
});
$('#pin').addEventListener('input', (e) => (e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6)));

// ---------------- rendering ----------------

function render() {
  const s = current;
  if (!s) return;
  if (s.phase === 'lobby') return renderWait(s);
  if (s.phase === 'question') return renderQuestion(s);
  if (s.phase === 'results') return renderResults(s);
  if (s.phase === 'final') return renderFinal(s);
}

function renderWait(s) {
  showScreen('wait');
  $('#waitEmoji').textContent = s.me.emoji;
  $('#waitName').textContent = s.me.name;
  $('#waitName').style.color = s.me.color;
  $('#waitPlayers').textContent = `Připojeno hráčů: ${s.players}`;
}

const initials = (name) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

function renderQuestion(s) {
  showScreen('question');
  const key = `${s.pos}|${s.startedAt}`;
  if (key !== renderedKey) {
    renderedKey = key;
    pendingVote = null;
    $('#search').value = '';
    $('#qPos').textContent = `Otázka ${s.pos + 1} / ${s.total}`;
    $('#qText').textContent = s.question;
    $('#people').replaceChildren(
      ...s.people.map((p) =>
        el('li', {}, el('button', { className: 'person', type: 'button', 'aria-pressed': 'false', 'data-person': p, onclick: () => castVote(p) },
          el('span', { className: 'initials', 'aria-hidden': 'true' }, initials(p)),
          el('span', {}, p),
        )),
      ),
    );
    window.scrollTo({ top: 0 });
    navigator.vibrate?.(60);
  }
  const chosen = pendingVote ?? s.myVote;
  for (const b of $('#people').querySelectorAll('.person')) b.setAttribute('aria-pressed', String(b.dataset.person === chosen));
  $('#voteStatus').replaceChildren(
    ...(chosen
      ? [document.createTextNode('Hlasuješ pro '), el('b', {}, chosen), document.createTextNode(' · můžeš změnit')]
      : [document.createTextNode('Ťukni na jednoho člověka')]),
  );
}

function castVote(person) {
  const s = current;
  if (s?.phase !== 'question' || remaining(s.endsAt) <= 0) return;
  pendingVote = person;
  navigator.vibrate?.(25);
  net.send({ t: 'vote', pos: s.pos, person });
  renderQuestion(s);
}

$('#search').addEventListener('input', () => {
  const q = fold($('#search').value.trim());
  let shown = 0;
  for (const li of $('#people').children) {
    const hit = !q || fold(li.textContent).includes(q);
    li.hidden = !hit;
    shown += hit;
  }
  $('#noMatch').hidden = shown > 0;
});

function bars(rows, mine) {
  const max = Math.max(1, ...rows.map((r) => r.votes));
  return rows.map((r) =>
    el('div', { className: `bar${r.rank === 1 ? ' win' : ''}${r.person === mine ? ' mine' : ''}`, style: { '--w': `${(r.votes / max) * 100}%` } },
      el('span', { className: 'fill' }),
      el('span', { className: 'rank' }, r.rank === 1 ? '👑' : `${r.rank}.`),
      el('span', { className: 'name' }, r.person),
      el('span', { className: 'votes' }, String(r.votes)),
    ),
  );
}

function renderResults(s) {
  showScreen('results');
  renderedKey = null;
  $('#rPos').textContent = `Výsledky · otázka ${s.pos + 1} / ${s.total}`;
  $('#rText').textContent = s.question;
  const rows = s.results ?? [];
  $('#rBars').replaceChildren(...(rows.length ? bars(rows, s.myVote) : [el('p', { className: 'muted center' }, 'Nikdo nehlasoval 🤷')]));
  const won = rows.some((r) => r.rank === 1 && r.person === s.myVote);
  $('#rMine').textContent = s.myVote
    ? `Tvůj tip: ${s.myVote}${won ? ' — trefa! 🎯' : ''}`
    : 'Tentokrát jsi nehlasoval/a.';
}

function renderFinal(s) {
  showScreen('final');
  const f = s.final;
  $('#fChamp').textContent = f.champions.length ? `👑 Hvězda večera: ${f.champions.join(', ')}` : 'Žádné výsledky';
  $('#fHits').textContent = `Trefil/a jsi vítěze ${f.hits}× z ${f.answered} hlasování.`;
}

// ---------------- countdown loop ----------------
function frame() {
  const s = current;
  if (s?.phase === 'question' && s.endsAt) {
    const left = remaining(s.endsAt);
    $('#qSecs').textContent = `${left} s`;
    $('#qBar').classList.toggle('low', left <= 5);
    const frac = (s.endsAt - clock.now()) / (s.duration * 1000);
    $('#qBar').firstElementChild.style.transform = `scaleX(${Math.min(1, Math.max(0, frac))})`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
