import { connect, keepAwake, clock, $, el, showScreen, remaining, fold, themeButtons } from './net.js';

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
themeButtons([$('#themeBtn')]);
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
  $('#waitName').textContent = s.me.name;
  $('#waitPlayers').textContent = `Ve hře je ${s.players} lidí`;
}

function renderQuestion(s) {
  showScreen('question');
  const key = `${s.pos}|${s.startedAt}`;
  if (key !== renderedKey) {
    renderedKey = key;
    pendingVote = null;
    $('#search').value = '';
    $('#noMatch').hidden = true;
    $('#qPos').textContent = `Otázka ${s.pos + 1} z ${s.total}`;
    $('#qText').textContent = s.question;
    $('#people').replaceChildren(
      ...s.people.map((p) =>
        el('li', {}, el('button', { className: 'person', type: 'button', 'aria-pressed': 'false', 'data-person': p, onclick: () => castVote(p) },
          el('span', {}, p),
          el('span', { className: 'tag', 'aria-hidden': 'true' }, 'tvůj hlas'),
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
      ? [document.createTextNode('Tvůj hlas: '), el('b', {}, chosen), document.createTextNode(' · do konce jde změnit')]
      : [document.createTextNode('Ťukni na jedno jméno')]),
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

const votesWord = (n) => (n === 1 ? 'hlas' : n >= 2 && n <= 4 ? 'hlasy' : 'hlasů');

function renderResults(s) {
  showScreen('results');
  renderedKey = null;
  $('#rPos').textContent = `Výsledky · otázka ${s.pos + 1} z ${s.total}`;
  $('#rText').textContent = s.question;
  const rows = s.results ?? [];
  const winners = rows.filter((r) => r.rank === 1);
  const total = Math.max(1, s.voted, rows.reduce((n, r) => n + r.votes, 0));
  const pct = (v) => Math.round((v / total) * 100);
  const key = `${s.pos}|${s.startedAt}`;
  if ($('#rWin').dataset.key !== key) {
    // rebuild only when the question changes, so the wipe plays once
    $('#rWin').dataset.key = key;
    $('#rWin').className = `pwin${winners.length > 1 ? ' tie' : ''}`;
    $('#rWin').replaceChildren(
      ...(winners.length
        ? [
            el('h3', { className: 'head ruled' }, winners.map((r) => r.person).join(' & ')),
            el('div', { className: 'share', style: { '--pct': `${pct(winners[0].votes)}%` } },
              el('span', { className: 'bar' }, el('i')),
              el('span', { className: 'v' }, `${winners[0].votes} ${votesWord(winners[0].votes)} · ${pct(winners[0].votes)} %`),
            ),
          ]
        : [el('p', { className: 'muted' }, 'Nikdo nehlasoval.')]),
    );
  }
  $('#rBars').replaceChildren(
    ...rows.filter((r) => r.rank !== 1).map((r) =>
      el('li', { className: r.person === s.myVote ? 'mine' : '' },
        el('span', { className: 'n' }, `${r.rank}.`),
        el('span', { className: 'nm' }, r.person),
        el('span', { className: 'v' }, `${r.votes} ${votesWord(r.votes)}`),
      ),
    ),
  );
  const won = winners.some((r) => r.person === s.myVote);
  $('#rMine').classList.toggle('hit', won);
  $('#rMine').textContent = s.myVote
    ? won ? `Trefa! Tipoval/a jsi ${s.myVote}.` : `Tvůj tip: ${s.myVote}`
    : 'Tentokrát jsi nehlasoval/a.';
}

function renderFinal(s) {
  showScreen('final');
  const f = s.final;
  $('#fChamp').textContent = f.champions.length ? f.champions.join(' & ') : '—';
  $('#fHits').textContent = `Vítěze jsi trefil/a ${f.hits}× z ${f.answered}.`;
}

// ---------------- countdown loop ----------------
function frame() {
  const s = current;
  if (s?.phase === 'question' && s.endsAt) {
    $('#qSecs').textContent = String(remaining(s.endsAt));
    const frac = Math.min(1, Math.max(0, (s.endsAt - clock.now()) / (s.duration * 1000)));
    $('#qBar').firstElementChild.style.width = `${frac * 100}%`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
