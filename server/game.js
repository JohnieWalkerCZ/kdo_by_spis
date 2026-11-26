// Game state + transitions. Pure-ish: every function takes `now` explicitly so tests control time.
import { randomInt, randomUUID } from 'node:crypto';
import { ANIMALS, COLORS } from './animals.js';

export const VOTE_GRACE_MS = 300;

export const LIMITS = { people: 100, name: 60, questions: 200, question: 200 };

/** Validate people/questions/settings (data.json or the admin panel); throws with a readable Czech message. */
export function validateData(data) {
  const errors = [];
  const people = Array.isArray(data?.people) ? data.people.map((p) => (typeof p === 'string' ? p.trim() : p)) : null;
  if (!people || people.length < 2) errors.push('potřebuju aspoň 2 hráče');
  else if (people.length > LIMITS.people) errors.push(`maximálně ${LIMITS.people} hráčů`);
  const seen = new Set();
  for (const p of people ?? []) {
    if (typeof p !== 'string' || !p) errors.push(`neplatné jméno: ${JSON.stringify(p)}`);
    else if (p.length > LIMITS.name) errors.push(`jméno je moc dlouhé: ${p.slice(0, 20)}…`);
    else if (seen.has(p)) errors.push(`jméno je tam dvakrát: ${p}`);
    else seen.add(p);
  }
  if (!Array.isArray(data?.questions) || data.questions.length < 1) errors.push('potřebuju aspoň 1 otázku');
  else if (data.questions.length > LIMITS.questions) errors.push(`maximálně ${LIMITS.questions} otázek`);
  for (const [i, q] of (data?.questions ?? []).entries()) {
    if (typeof q?.text !== 'string' || !q.text.trim()) errors.push(`otázka ${i + 1} nemá text`);
    else if (q.text.length > LIMITS.question) errors.push(`otázka ${i + 1} je moc dlouhá`);
    if (q?.time != null && !(Number.isInteger(q.time) && q.time >= 5 && q.time <= 600)) {
      errors.push(`otázka ${i + 1}: čas musí být celé číslo 5–600 s`);
    }
  }
  const st = data?.settings ?? {};
  const settings = {
    defaultTime: st.defaultTime ?? 20,
    shuffleQuestions: st.shuffleQuestions ?? false,
    resultsTop: st.resultsTop ?? 5,
    autoEndWhenAllVoted: st.autoEndWhenAllVoted ?? false,
  };
  if (!(Number.isInteger(settings.defaultTime) && settings.defaultTime >= 5 && settings.defaultTime <= 600)) errors.push('výchozí čas musí být 5–600 s');
  if (!(Number.isInteger(settings.resultsTop) && settings.resultsTop >= 1 && settings.resultsTop <= 10)) errors.push('počet míst ve výsledcích musí být 1–10');
  for (const k of ['shuffleQuestions', 'autoEndWhenAllVoted']) if (typeof settings[k] !== 'boolean') errors.push(`${k} musí být ano/ne`);
  if (errors.length) throw new Error('Chyba v datech:\n - ' + errors.join('\n - '));
  return {
    people,
    questions: data.questions.map((q) => (q.time != null ? { text: q.text.trim(), time: q.time } : { text: q.text.trim() })),
    settings,
  };
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newPin(avoid) {
  let pin;
  do pin = String(randomInt(100000, 1000000));
  while (pin === avoid);
  return pin;
}

export function createGame(data, now, prevPin) {
  const order = data.questions.map((_, i) => i);
  if (data.settings.shuffleQuestions) shuffle(order);
  return {
    id: randomUUID(),
    pin: newPin(prevPin),
    createdAt: now,
    phase: 'lobby', // lobby | question | results | final
    // questions are snapshotted so editing data.json mid-game can't corrupt a running game
    people: [...data.people],
    questions: order.map((i) => ({
      text: data.questions[i].text,
      time: data.questions[i].time ?? data.settings.defaultTime,
    })),
    settings: { ...data.settings },
    pos: -1, // index into questions
    startedAt: null,
    endsAt: null,
    players: {}, // playerId -> { name, emoji, color, joinedAt }
    votes: {}, // pos -> { playerId: person }
    results: {}, // pos -> tally (frozen when question closes)
    skipped: [],
  };
}

/** Join or re-join. Returns the player record (with id). */
export function addPlayer(game, playerId, now) {
  if (playerId && game.players[playerId]) return { id: playerId, ...game.players[playerId] };
  const used = new Set(Object.values(game.players).map((p) => p.animal));
  const free = ANIMALS.filter(([a]) => !used.has(a));
  const pool = free.length ? free : ANIMALS;
  const [animal, emoji] = pool[randomInt(pool.length)];
  const count = Object.values(game.players).filter((p) => p.animal === animal).length;
  const id = randomUUID();
  game.players[id] = {
    animal,
    name: `Anonymní ${animal}${count ? ' ' + (count + 1) : ''}`,
    emoji,
    color: COLORS[randomInt(COLORS.length)],
    joinedAt: now,
  };
  return { id, ...game.players[id] };
}

export function startNext(game, now) {
  if (game.phase === 'final') return 'bad_phase';
  if (game.phase === 'question') closeQuestion(game);
  if (game.pos + 1 >= game.questions.length) return finish(game);
  game.pos += 1;
  openQuestion(game, now);
}

function openQuestion(game, now) {
  game.phase = 'question';
  game.votes[game.pos] = {};
  delete game.results[game.pos];
  game.startedAt = now;
  game.endsAt = now + game.questions[game.pos].time * 1000;
}

export function vote(game, playerId, pos, person, now) {
  if (!game.players[playerId]) return 'unknown_player';
  if (game.phase !== 'question' || pos !== game.pos || now > game.endsAt + VOTE_GRACE_MS) return 'vote_closed';
  if (!game.people.includes(person)) return 'bad_person';
  game.votes[pos][playerId] = person;
}

export function votedCount(game) {
  return game.pos >= 0 ? Object.keys(game.votes[game.pos] ?? {}).length : 0;
}

/** Sorted tally with competition ranking (1,1,3). Only people with >0 votes. */
export function tally(votes) {
  const counts = new Map();
  for (const person of Object.values(votes)) counts.set(person, (counts.get(person) ?? 0) + 1);
  const rows = [...counts].map(([person, n]) => ({ person, votes: n }));
  rows.sort((a, b) => b.votes - a.votes || a.person.localeCompare(b.person, 'cs'));
  let rank = 0;
  rows.forEach((r, i) => (r.rank = i > 0 && rows[i - 1].votes === r.votes ? rank : (rank = i + 1)));
  return rows;
}

export function closeQuestion(game) {
  if (game.phase !== 'question') return;
  game.results[game.pos] = tally(game.votes[game.pos]);
  game.phase = 'results';
  game.endsAt = null;
}

/** Advance time-driven transitions. Returns true if state changed. */
export function tick(game, now) {
  if (game?.phase !== 'question') return false;
  const allVoted =
    game.settings.autoEndWhenAllVoted &&
    Object.keys(game.players).length > 0 &&
    votedCount(game) >= Object.keys(game.players).length;
  if (now >= game.endsAt || allVoted) {
    closeQuestion(game);
    return true;
  }
  return false;
}

export function addTime(game, seconds, now) {
  if (game.phase !== 'question') return 'bad_phase';
  game.endsAt = Math.max(game.endsAt, now) + seconds * 1000;
}

export function endNow(game) {
  if (game.phase !== 'question') return 'bad_phase';
  closeQuestion(game);
}

/** Re-run the current question from scratch (clears its votes). */
export function repeat(game, now) {
  if (game.pos < 0 || game.phase === 'final') return 'bad_phase';
  openQuestion(game, now);
}

/** Skip current question without results; moves to the next one. */
export function skip(game, now) {
  if (game.phase !== 'question') return 'bad_phase';
  game.skipped.push(game.pos);
  delete game.votes[game.pos];
  game.phase = 'results'; // transient; startNext moves on
  return startNext(game, now);
}

export function finish(game) {
  if (game.phase === 'question') closeQuestion(game);
  game.phase = 'final';
  game.endsAt = null;
}

export function winners(rows) {
  return rows.filter((r) => r.rank === 1).map((r) => r.person);
}

/** Per-question winners + who won most questions. Aggregates only, never who voted for whom. */
export function summary(game) {
  const questions = [];
  const wins = new Map();
  for (let i = 0; i < game.questions.length; i++) {
    if (!game.results[i]) continue;
    const w = winners(game.results[i]);
    w.forEach((p) => wins.set(p, (wins.get(p) ?? 0) + 1));
    questions.push({ text: game.questions[i].text, results: game.results[i], winners: w });
  }
  const top = Math.max(0, ...wins.values());
  const champions = top ? [...wins].filter(([, n]) => n === top).map(([p]) => p) : [];
  return { questions, champions, championWins: top };
}

/** How many times the player picked a winner. */
export function playerHits(game, playerId) {
  let hits = 0;
  let answered = 0;
  for (const [pos, rows] of Object.entries(game.results)) {
    const mine = game.votes[pos]?.[playerId];
    if (!mine) continue;
    answered++;
    if (winners(rows).includes(mine)) hits++;
  }
  return { hits, answered };
}
