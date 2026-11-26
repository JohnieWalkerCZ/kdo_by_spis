import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../server/game.js';
import { createStore } from '../server/store.js';

const data = G.validateData({
  people: ['Adam', 'Bára', 'Cyril'],
  questions: [{ text: 'Q1' }, { text: 'Q2', time: 30 }],
});

function setup() {
  const g = G.createGame(data, 0);
  const a = G.addPlayer(g, null, 0).id;
  const b = G.addPlayer(g, null, 0).id;
  const c = G.addPlayer(g, null, 0).id;
  return { g, a, b, c };
}

test('validateData rejects duplicates and empty lists', () => {
  assert.throws(() => G.validateData({ people: ['A', 'A'], questions: [{ text: 'x' }] }), /duplicitní/);
  assert.throws(() => G.validateData({ people: ['A', 'B'], questions: [] }), /questions/);
});

test('pin is 6 digits and differs from previous', () => {
  const g = G.createGame(data, 0, '123456');
  assert.match(g.pin, /^\d{6}$/);
  assert.notEqual(g.pin, '123456');
});

test('rejoin with known id keeps identity; animals are unique', () => {
  const { g, a } = setup();
  assert.equal(G.addPlayer(g, a, 1).id, a);
  assert.equal(Object.keys(g.players).length, 3);
  const names = Object.values(g.players).map((p) => p.name);
  assert.equal(new Set(names).size, 3);
  assert.match(names[0], /^Anonymní /);
});

test('vote, change vote, late vote, wrong question', () => {
  const { g, a, b } = setup();
  assert.equal(G.vote(g, a, 0, 'Adam', 0), 'vote_closed'); // lobby
  G.startNext(g, 1000);
  assert.equal(g.endsAt, 21000);
  assert.equal(G.vote(g, a, 0, 'Adam', 2000), undefined);
  assert.equal(G.vote(g, a, 0, 'Bára', 3000), undefined); // change
  assert.equal(G.votedCount(g), 1);
  assert.equal(G.vote(g, b, 1, 'Bára', 3000), 'vote_closed'); // wrong pos
  assert.equal(G.vote(g, b, 0, 'Nobody', 3000), 'bad_person');
  assert.equal(G.vote(g, b, 0, 'Bára', 21000 + G.VOTE_GRACE_MS + 1), 'vote_closed');
  assert.equal(G.vote(g, 'ghost', 0, 'Bára', 3000), 'unknown_player');
});

test('tick closes question at endsAt and tallies with ties', () => {
  const { g, a, b, c } = setup();
  G.startNext(g, 0);
  G.vote(g, a, 0, 'Adam', 1);
  G.vote(g, b, 0, 'Bára', 1);
  G.vote(g, c, 0, 'Cyril', 1);
  assert.equal(G.tick(g, 19999), false);
  assert.equal(G.tick(g, 20000), true);
  assert.equal(g.phase, 'results');
  assert.deepEqual(g.results[0].map((r) => r.rank), [1, 1, 1]);
  assert.deepEqual(G.tally({ x: 'B', y: 'B', z: 'A', w: 'C' }).map((r) => [r.person, r.rank]), [['B', 1], ['A', 2], ['C', 2]]);
});

test('auto-end when everyone voted (opt-in)', () => {
  const { g, a, b, c } = setup();
  g.settings.autoEndWhenAllVoted = true;
  G.startNext(g, 0);
  for (const p of [a, b]) G.vote(g, p, 0, 'Adam', 1);
  assert.equal(G.tick(g, 2), false);
  G.vote(g, c, 0, 'Adam', 3);
  assert.equal(G.tick(g, 4), true);
});

test('addTime, repeat, skip, finish, summary, hits', () => {
  const { g, a, b } = setup();
  G.startNext(g, 0);
  G.addTime(g, 10, 5000);
  assert.equal(g.endsAt, 30000);
  G.vote(g, a, 0, 'Adam', 1);
  G.repeat(g, 100);
  assert.equal(G.votedCount(g), 0);
  G.vote(g, a, 0, 'Adam', 200);
  G.vote(g, b, 0, 'Bára', 200);
  G.vote(g, b, 0, 'Adam', 300);
  G.endNow(g);
  G.startNext(g, 400); // Q2
  G.skip(g, 500); // last question skipped -> final
  assert.equal(g.phase, 'final');
  const s = G.summary(g);
  assert.equal(s.questions.length, 1);
  assert.deepEqual(s.champions, ['Adam']);
  assert.deepEqual(G.playerHits(g, a), { hits: 1, answered: 1 });
  assert.ok(!JSON.stringify(s).includes(a), 'summary must not leak player ids');
});

test('state survives restart; expired question resolves on load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdo-'));
  const store = createStore(dir);
  const { g, a } = setup();
  G.startNext(g, 0);
  G.vote(g, a, 0, 'Cyril', 1);
  store.save({ game: g }, true);

  const loaded = createStore(dir).load().game;
  assert.equal(loaded.votes[0][a], 'Cyril');
  assert.equal(G.tick(loaded, 10_000), false); // still running
  assert.equal(G.tick(loaded, 60_000), true); // expired during "downtime"
  assert.equal(loaded.results[0][0].person, 'Cyril');

  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  assert.equal(createStore(dir).load().game, null);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('state.json.broken-')));
});
