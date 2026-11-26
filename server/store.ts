// Durable state: /data/state.json (atomic write) + /data/games/*.json archive.
import fs from 'node:fs';
import path from 'node:path';
import type { ArchivedGame, Game, GameListing, Phase, State, Summary } from '../shared/types.ts';
import { isRecord } from './util.ts';

const PHASES: readonly unknown[] = ['lobby', 'question', 'results', 'final'] satisfies Phase[];

const errCode = (e: unknown): unknown => (e instanceof Error && 'code' in e ? e.code : undefined);

/** Shape check for state.json: refuse to run on something that would crash later. */
function isGame(v: unknown): v is Game {
  return (
    isRecord(v) &&
    typeof v.pin === 'string' &&
    PHASES.includes(v.phase) &&
    typeof v.pos === 'number' &&
    Array.isArray(v.people) &&
    Array.isArray(v.questions) &&
    Array.isArray(v.skipped) &&
    isRecord(v.settings) &&
    isRecord(v.players) &&
    isRecord(v.votes) &&
    isRecord(v.results)
  );
}

export interface Store {
  loadData(): unknown;
  saveData(value: unknown): void;
  load(): State;
  save(state: State, now?: boolean): void;
  flush(): void;
  archive(game: Game, summary: Summary): string;
  listGames(): GameListing[];
  readGame(name: string): string | null;
}

export function createStore(dir: string): Store {
  const stateFile = path.join(dir, 'state.json');
  const dataFile = path.join(dir, 'data.json');
  const gamesDir = path.join(dir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });

  function writeAtomic(file: string, value: unknown): void {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  let timer: NodeJS.Timeout | null = null;
  let pending: State | null = null;

  const store: Store = {
    /** People/questions saved from the admin panel; null when never saved. Validated by the caller. */
    loadData() {
      try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } catch (e) {
        if (errCode(e) !== 'ENOENT') console.error(`data.json ve stavu nejde načíst (${String(e)}), používám výchozí`);
        return null;
      }
    },
    saveData(value) {
      writeAtomic(dataFile, value);
    },
    load() {
      let problem: string;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (isRecord(parsed) && (parsed.game === null || isGame(parsed.game))) return { game: parsed.game };
        problem = 'neočekávaný tvar';
      } catch (e) {
        if (errCode(e) === 'ENOENT') return { game: null };
        problem = String(e);
      }
      // keep the broken file for inspection instead of silently overwriting it
      const bad = `${stateFile}.broken-${Date.now()}`;
      fs.renameSync(stateFile, bad);
      console.error(`state.json nešel načíst (${problem}), přesunut do ${bad}`);
      return { game: null };
    },
    /** Debounced save; `now=true` flushes immediately (phase changes). */
    save(state, now = false) {
      pending = state;
      if (now) return store.flush();
      timer ??= setTimeout(() => store.flush(), 250);
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!pending) return;
      try {
        writeAtomic(stateFile, pending);
      } catch (e) {
        console.error('Uložení stavu selhalo:', e);
      }
      pending = null;
    },
    archive(game, summary) {
      const date = new Date(game.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const name = `${date}-${game.pin}.json`;
      const record: ArchivedGame = {
        pin: game.pin,
        createdAt: game.createdAt,
        finishedAt: Date.now(),
        players: Object.keys(game.players).length,
        ...summary,
      };
      writeAtomic(path.join(gamesDir, name), record);
      return name;
    },
    listGames() {
      return fs
        .readdirSync(gamesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((name): GameListing => {
          try {
            const g = JSON.parse(fs.readFileSync(path.join(gamesDir, name), 'utf8')) as ArchivedGame;
            return { name, createdAt: g.createdAt, players: g.players, questions: g.questions.length, champions: g.champions };
          } catch {
            return { name, broken: true };
          }
        });
    },
    readGame(name) {
      if (!/^[\w-]+\.json$/.test(name)) return null;
      try {
        return fs.readFileSync(path.join(gamesDir, name), 'utf8');
      } catch {
        return null;
      }
    },
  };
  return store;
}
