// Game state + transitions. Pure-ish: every function takes `now` explicitly so tests control time.
import { randomInt, randomUUID } from 'node:crypto';
import type { DataQuestion, Game, GameData, GameError, Player, Summary, TallyRow, Votes } from '../shared/types.ts';
import { ANIMALS, COLORS } from './animals.ts';
import { isRecord } from './util.ts';

export const VOTE_GRACE_MS = 300;

export const LIMITS = { people: 100, name: 60, questions: 200, question: 200 };

const intIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Validate people/questions/settings (data.json or the admin panel); throws with a readable Czech message. */
export function validateData(input: unknown): GameData {
  const errors: string[] = [];
  const raw = isRecord(input) ? input : {};

  const rawPeople = Array.isArray(raw.people) ? raw.people.map((p: unknown) => (typeof p === 'string' ? p.trim() : p)) : null;
  if (!rawPeople || rawPeople.length < 2) errors.push('potřebuju aspoň 2 hráče');
  else if (rawPeople.length > LIMITS.people) errors.push(`maximálně ${LIMITS.people} hráčů`);
  const people: string[] = [];
  const seen = new Set<string>();
  for (const p of rawPeople ?? []) {
    if (typeof p !== 'string' || !p) errors.push(`neplatné jméno: ${JSON.stringify(p)}`);
    else if (p.length > LIMITS.name) errors.push(`jméno je moc dlouhé: ${p.slice(0, 20)}…`);
    else if (seen.has(p)) errors.push(`jméno je tam dvakrát: ${p}`);
    else {
      seen.add(p);
      people.push(p);
    }
  }

  const rawQuestions = Array.isArray(raw.questions) ? (raw.questions as unknown[]) : null;
  if (!rawQuestions || rawQuestions.length < 1) errors.push('potřebuju aspoň 1 otázku');
  else if (rawQuestions.length > LIMITS.questions) errors.push(`maximálně ${LIMITS.questions} otázek`);
  const questions: DataQuestion[] = [];
  for (const [i, item] of (rawQuestions ?? []).entries()) {
    const q = isRecord(item) ? item : {};
    const rawText = typeof q.text === 'string' ? q.text : '';
    const text = rawText.trim();
    if (!text) errors.push(`otázka ${i + 1} nemá text`);
    else if (rawText.length > LIMITS.question) errors.push(`otázka ${i + 1} je moc dlouhá`);
    const time = intIn(q.time, 5, 600);
    if (q.time != null && time === null) errors.push(`otázka ${i + 1}: čas musí být celé číslo 5–600 s`);
    questions.push(time === null ? { text } : { text, time });
  }

  const st = isRecord(raw.settings) ? raw.settings : {};
  const defaultTime = intIn(st.defaultTime ?? 20, 5, 600);
  const resultsTop = intIn(st.resultsTop ?? 5, 1, 10);
  const shuffleQuestions = bool(st.shuffleQuestions ?? false);
  const autoEndWhenAllVoted = bool(st.autoEndWhenAllVoted ?? false);
  if (defaultTime === null) errors.push('výchozí čas musí být 5–600 s');
  if (resultsTop === null) errors.push('počet míst ve výsledcích musí být 1–10');
  if (shuffleQuestions === null) errors.push('shuffleQuestions musí být ano/ne');
  if (autoEndWhenAllVoted === null) errors.push('autoEndWhenAllVoted musí být ano/ne');

  if (errors.length || defaultTime === null || resultsTop === null || shuffleQuestions === null || autoEndWhenAllVoted === null) {
    throw new Error('Chyba v datech:\n - ' + errors.join('\n - '));
  }
  return { people, questions, settings: { defaultTime, shuffleQuestions, resultsTop, autoEndWhenAllVoted } };
}

function pick<T>(arr: readonly T[]): T {
  const v = arr[randomInt(arr.length)];
  if (v === undefined) throw new Error('pick from empty list');
  return v;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export function newPin(avoid?: string): string {
  let pin: string;
  do pin = String(randomInt(100000, 1000000));
  while (pin === avoid);
  return pin;
}

export function createGame(data: GameData, now: number, prevPin?: string): Game {
  const qs = [...data.questions];
  if (data.settings.shuffleQuestions) shuffle(qs);
  return {
    id: randomUUID(),
    pin: newPin(prevPin),
    createdAt: now,
    phase: 'lobby',
    // questions are snapshotted so editing data.json mid-game can't corrupt a running game
    people: [...data.people],
    questions: qs.map((q) => ({ text: q.text, time: q.time ?? data.settings.defaultTime })),
    settings: { ...data.settings },
    pos: -1,
    startedAt: null,
    endsAt: null,
    players: {},
    votes: {},
    results: {},
    skipped: [],
  };
}

/** Join or re-join. Returns the player record (with id). */
export function addPlayer(game: Game, playerId: string | null, now: number): Player & { id: string } {
  const existing = playerId ? game.players[playerId] : undefined;
  if (playerId && existing) return { id: playerId, ...existing };
  const used = new Set(Object.values(game.players).map((p) => p.animal));
  const free = ANIMALS.filter(([a]) => !used.has(a));
  const [animal, emoji] = pick(free.length ? free : ANIMALS);
  const count = Object.values(game.players).filter((p) => p.animal === animal).length;
  const id = randomUUID();
  const player: Player = {
    animal,
    name: `Anonymní ${animal}${count ? ' ' + (count + 1) : ''}`,
    emoji,
    color: pick(COLORS),
    joinedAt: now,
  };
  game.players[id] = player;
  return { id, ...player };
}

export function startNext(game: Game, now: number): GameError | undefined {
  if (game.phase === 'final') return 'bad_phase';
  if (game.phase === 'question') closeQuestion(game);
  if (game.pos + 1 >= game.questions.length) {
    finish(game);
    return undefined;
  }
  game.pos += 1;
  openQuestion(game, now);
  return undefined;
}

function openQuestion(game: Game, now: number): void {
  const q = game.questions[game.pos];
  if (!q) throw new Error(`no question at pos ${game.pos}`);
  game.phase = 'question';
  game.votes[game.pos] = {};
  delete game.results[game.pos];
  game.startedAt = now;
  game.endsAt = now + q.time * 1000;
}

export function vote(game: Game, playerId: string, pos: number, person: string, now: number): GameError | undefined {
  if (!game.players[playerId]) return 'unknown_player';
  const votes = game.votes[pos];
  if (game.phase !== 'question' || pos !== game.pos || !votes || game.endsAt === null || now > game.endsAt + VOTE_GRACE_MS) {
    return 'vote_closed';
  }
  if (!game.people.includes(person)) return 'bad_person';
  votes[playerId] = person;
  return undefined;
}

export function votedCount(game: Game): number {
  return game.pos >= 0 ? Object.keys(game.votes[game.pos] ?? {}).length : 0;
}

/** Sorted tally with competition ranking (1,1,3). Only people with >0 votes. */
export function tally(votes: Votes): TallyRow[] {
  const counts = new Map<string, number>();
  for (const person of Object.values(votes)) counts.set(person, (counts.get(person) ?? 0) + 1);
  const rows: TallyRow[] = [...counts].map(([person, n]) => ({ person, votes: n, rank: 0 }));
  rows.sort((a, b) => b.votes - a.votes || a.person.localeCompare(b.person, 'cs'));
  let rank = 0;
  let prevVotes = -1;
  rows.forEach((r, i) => {
    if (r.votes !== prevVotes) rank = i + 1;
    prevVotes = r.votes;
    r.rank = rank;
  });
  return rows;
}

export function closeQuestion(game: Game): void {
  if (game.phase !== 'question') return;
  game.results[game.pos] = tally(game.votes[game.pos] ?? {});
  game.phase = 'results';
  game.endsAt = null;
}

/** Advance time-driven transitions. Returns true if state changed. */
export function tick(game: Game | null, now: number): boolean {
  if (game?.phase !== 'question') return false;
  const playerCount = Object.keys(game.players).length;
  const allVoted = game.settings.autoEndWhenAllVoted && playerCount > 0 && votedCount(game) >= playerCount;
  if (game.endsAt === null || now >= game.endsAt || allVoted) {
    closeQuestion(game);
    return true;
  }
  return false;
}

export function addTime(game: Game, seconds: number, now: number): GameError | undefined {
  if (game.phase !== 'question') return 'bad_phase';
  game.endsAt = Math.max(game.endsAt ?? now, now) + seconds * 1000;
  return undefined;
}

export function endNow(game: Game): GameError | undefined {
  if (game.phase !== 'question') return 'bad_phase';
  closeQuestion(game);
  return undefined;
}

/** Re-run the current question from scratch (clears its votes). */
export function repeat(game: Game, now: number): GameError | undefined {
  if (game.pos < 0 || game.phase === 'final') return 'bad_phase';
  openQuestion(game, now);
  return undefined;
}

/** Skip current question without results; moves to the next one. */
export function skip(game: Game, now: number): GameError | undefined {
  if (game.phase !== 'question') return 'bad_phase';
  game.skipped.push(game.pos);
  delete game.votes[game.pos];
  game.phase = 'results'; // transient; startNext moves on
  return startNext(game, now);
}

export function finish(game: Game): void {
  if (game.phase === 'question') closeQuestion(game);
  game.phase = 'final';
  game.endsAt = null;
}

export function winners(rows: TallyRow[]): string[] {
  return rows.filter((r) => r.rank === 1).map((r) => r.person);
}

/** Per-question winners + who won most questions. Aggregates only, never who voted for whom. */
export function summary(game: Game): Summary {
  const questions: Summary['questions'] = [];
  const wins = new Map<string, number>();
  game.questions.forEach((q, i) => {
    const results = game.results[i];
    if (!results) return;
    const w = winners(results);
    w.forEach((p) => wins.set(p, (wins.get(p) ?? 0) + 1));
    questions.push({ text: q.text, results, winners: w });
  });
  const top = Math.max(0, ...wins.values());
  const champions = top ? [...wins].filter(([, n]) => n === top).map(([p]) => p) : [];
  return { questions, champions, championWins: top };
}

/** How many times the player picked a winner. */
export function playerHits(game: Game, playerId: string): { hits: number; answered: number } {
  let hits = 0;
  let answered = 0;
  for (const [pos, rows] of Object.entries(game.results)) {
    const mine = game.votes[Number(pos)]?.[playerId];
    if (!mine) continue;
    answered++;
    if (winners(rows).includes(mine)) hits++;
  }
  return { hits, answered };
}
