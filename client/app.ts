import type { PlayerView } from '../shared/types.ts';
import { connect, keepAwake, clock, $, el, showScreen, remaining, fold, themeButtons, votesWord } from './net.ts';

const STORE = 'kdo-player';

interface Saved {
  pin?: string;
  playerId?: string;
}

let saved = load();
let current: PlayerView | null = null; // last state
let renderedKey: string | null = null; // which question the name list was built for
let pendingVote: string | null = null; // optimistic selection until server confirms

function load(): Saved {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return {};
    const { pin, playerId } = raw as Record<string, unknown>;
    return { pin: typeof pin === 'string' ? pin : undefined, playerId: typeof playerId === 'string' ? playerId : undefined };
  } catch {
    return {};
  }
}
function persist(): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(saved));
  } catch {
    /* private mode: rejoin will just create a new identity */
  }
}

const pinInput = $<HTMLInputElement>('#pin');
const joinError = $('#joinError');
const searchInput = $<HTMLInputElement>('#search');
const peopleList = $('#people');

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
    } else if (msg.t === 'state' && msg.role === 'player') {
      current = msg;
      if (pendingVote && msg.myVote === pendingVote) pendingVote = null;
      render(msg);
    } else if (msg.t === 'error') {
      if (msg.code === 'bad_pin' || msg.code === 'game_over' || msg.code === 'rate_limited') {
        saved = {};
        persist();
        current = null;
        showScreen('join');
        joinError.textContent = msg.code === 'game_over' && !pinInput.value ? '' : msg.msg;
      } else if (msg.code === 'vote_closed') {
        pendingVote = null;
        if (current) render(current);
      }
    }
  },
});

keepAwake();
themeButtons([$('#themeBtn')]);
showScreen(saved.pin ? 'wait' : 'join');
if (saved.pin) pinInput.value = saved.pin;

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const pin = pinInput.value.replace(/\D/g, '');
  if (pin.length !== 6) {
    joinError.textContent = 'PIN má 6 číslic.';
    return;
  }
  joinError.textContent = '';
  saved = { pin };
  net.send({ t: 'join', pin });
});
pinInput.addEventListener('input', () => {
  pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 6);
});

// ---------------- rendering ----------------

function render(s: PlayerView): void {
  switch (s.phase) {
    case 'lobby':
      return renderWait(s);
    case 'question':
      return renderQuestion(s);
    case 'results':
      return renderResults(s);
    case 'final':
      return renderFinal(s);
  }
}

function renderWait(s: PlayerView): void {
  showScreen('wait');
  $('#waitName').textContent = s.me.name;
  $('#waitPlayers').textContent = `Ve hře je ${s.players} lidí`;
}

function renderQuestion(s: PlayerView): void {
  showScreen('question');
  const key = `${s.pos}|${s.startedAt}`;
  if (key !== renderedKey) {
    renderedKey = key;
    pendingVote = null;
    searchInput.value = '';
    $('#noMatch').hidden = true;
    $('#qPos').textContent = `Otázka ${s.pos + 1} z ${s.total}`;
    $('#qText').textContent = s.question;
    peopleList.replaceChildren(
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
  for (const b of peopleList.querySelectorAll<HTMLElement>('.person')) b.setAttribute('aria-pressed', String(b.dataset.person === chosen));
  $('#voteStatus').replaceChildren(
    ...(chosen
      ? [document.createTextNode('Tvůj hlas: '), el('b', {}, chosen), document.createTextNode(' · do konce jde změnit')]
      : [document.createTextNode('Ťukni na jedno jméno')]),
  );
}

function castVote(person: string): void {
  const s = current;
  if (s?.phase !== 'question' || s.endsAt === null || remaining(s.endsAt) <= 0) return;
  pendingVote = person;
  navigator.vibrate?.(25);
  net.send({ t: 'vote', pos: s.pos, person });
  renderQuestion(s);
}

searchInput.addEventListener('input', () => {
  const q = fold(searchInput.value.trim());
  let shown = 0;
  for (const li of peopleList.children as HTMLCollectionOf<HTMLElement>) {
    const hit = !q || fold(li.textContent ?? '').includes(q);
    li.hidden = !hit;
    if (hit) shown++;
  }
  $('#noMatch').hidden = shown > 0;
});

function renderResults(s: PlayerView): void {
  showScreen('results');
  renderedKey = null;
  $('#rPos').textContent = `Výsledky · otázka ${s.pos + 1} z ${s.total}`;
  $('#rText').textContent = s.question;
  const rows = s.results ?? [];
  const winners = rows.filter((r) => r.rank === 1);
  const first = winners[0];
  const total = Math.max(1, s.voted, rows.reduce((n, r) => n + r.votes, 0));
  const pct = (v: number) => Math.round((v / total) * 100);
  const key = `${s.pos}|${s.startedAt}`;
  const rWin = $('#rWin');
  if (rWin.dataset.key !== key) {
    // rebuild only when the question changes, so the wipe plays once
    rWin.dataset.key = key;
    rWin.className = `pwin${winners.length > 1 ? ' tie' : ''}`;
    rWin.replaceChildren(
      ...(first
        ? [
            el('h3', { className: 'head ruled' }, winners.map((r) => r.person).join(' & ')),
            el('div', { className: 'share', style: { '--pct': `${pct(first.votes)}%` } },
              el('span', { className: 'bar' }, el('i')),
              el('span', { className: 'v' }, `${first.votes} ${votesWord(first.votes)} · ${pct(first.votes)} %`),
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

function renderFinal(s: PlayerView): void {
  showScreen('final');
  const f = s.final;
  if (!f) return;
  $('#fChamp').textContent = f.champions.length ? f.champions.join(' & ') : '—';
  $('#fHits').textContent = `Vítěze jsi trefil/a ${f.hits}× z ${f.answered}.`;
}

// ---------------- countdown loop ----------------
const qSecs = $('#qSecs');
const qBarFill = $('#qBar > :first-child');
function frame(): void {
  const s = current;
  if (s?.phase === 'question' && s.endsAt !== null) {
    qSecs.textContent = String(remaining(s.endsAt));
    const frac = Math.min(1, Math.max(0, (s.endsAt - clock.now()) / ((s.duration ?? 1) * 1000)));
    qBarFill.style.width = `${frac * 100}%`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
