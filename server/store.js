// Durable state: /data/state.json (atomic write) + /data/games/*.json archive.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir) {
  const stateFile = path.join(dir, 'state.json');
  const dataFile = path.join(dir, 'data.json');
  const gamesDir = path.join(dir, 'games');
  fs.mkdirSync(gamesDir, { recursive: true });

  function writeAtomic(file, value) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  let timer = null;
  let pending = null;

  return {
    /** People/questions saved from the admin panel; null when never saved. */
    loadData() {
      try {
        return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') console.error(`data.json ve stavu nejde načíst (${e.message}), používám výchozí`);
        return null;
      }
    },
    saveData(value) {
      writeAtomic(dataFile, value);
    },
    load() {
      try {
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') {
          // keep the broken file for inspection instead of silently overwriting it
          const bad = `${stateFile}.broken-${Date.now()}`;
          fs.renameSync(stateFile, bad);
          console.error(`state.json nešel načíst (${e.message}), přesunut do ${bad}`);
        }
        return { game: null };
      }
    },
    /** Debounced save; `now=true` flushes immediately (phase changes). */
    save(state, now = false) {
      pending = state;
      if (now) return this.flush();
      timer ??= setTimeout(() => this.flush(), 250);
    },
    flush() {
      clearTimeout(timer);
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
      writeAtomic(path.join(gamesDir, name), {
        pin: game.pin,
        createdAt: game.createdAt,
        finishedAt: Date.now(),
        players: Object.keys(game.players).length,
        ...summary,
      });
      return name;
    },
    listGames() {
      return fs
        .readdirSync(gamesDir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => {
          try {
            const g = JSON.parse(fs.readFileSync(path.join(gamesDir, name), 'utf8'));
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
}
