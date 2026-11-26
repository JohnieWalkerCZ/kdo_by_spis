import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import * as G from './game.js';
import { createStore } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);
const HOST_KEY = process.env.KDO_HOST_KEY ?? '';
const DATA_FILE = process.env.KDO_DATA_FILE ?? path.join(ROOT, 'data.json');
const STATE_DIR = process.env.KDO_STATE_DIR ?? path.join(ROOT, 'data');
const PUBLIC_URL = (process.env.KDO_PUBLIC_URL ?? '').replace(/\/$/, '');
const TRUST_PROXY = process.env.KDO_TRUST_PROXY === 'true';

if (!HOST_KEY) {
  console.error('Chybí KDO_HOST_KEY (heslo pro projektor). Nastav ho v env / Portaineru.');
  process.exit(1);
}

const store = createStore(STATE_DIR);
// Admin-panel edits live next to the game state (Docker volume); the bundled data.json is only the first-run default.
let data = loadData();
function loadData() {
  const saved = store.loadData();
  if (saved) {
    try {
      return G.validateData(saved);
    } catch (e) {
      console.error(`Uložená data jsou neplatná, používám ${DATA_FILE}:\n${e.message}`);
    }
  }
  return G.validateData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
}
const state = store.load();
console.log(`Načteno ${data.people.length} lidí, ${data.questions.length} otázek. Rozehraná hra: ${state.game ? state.game.pin + ' (' + state.game.phase + ')' : 'žádná'}`);

const keyDigest = createHash('sha256').update(HOST_KEY).digest();
const isHostKey = (k) => typeof k === 'string' && timingSafeEqual(createHash('sha256').update(k).digest(), keyDigest);

// ---------- views (what each client is allowed to see) ----------

function currentResults(game, top) {
  return game.results[game.pos]?.slice(0, top) ?? null;
}

function hostView() {
  const g = state.game;
  return {
    t: 'state',
    role: 'host',
    serverNow: Date.now(),
    publicUrl: PUBLIC_URL,
    game: g && {
      pin: g.pin,
      phase: g.phase,
      pos: g.pos,
      total: g.questions.length,
      question: g.pos >= 0 ? g.questions[g.pos] : null,
      nextQuestion: g.questions[g.pos + 1] ?? null,
      endsAt: g.endsAt,
      startedAt: g.startedAt,
      duration: g.endsAt ? (g.endsAt - g.startedAt) / 1000 : null,
      players: Object.values(g.players).map(({ name, emoji, color }) => ({ name, emoji, color })),
      online: onlinePlayers(g).size,
      voted: G.votedCount(g),
      results: currentResults(g, g.settings.resultsTop),
      summary: g.phase === 'final' ? G.summary(g) : null,
      settings: g.settings,
    },
  };
}

function playerView(playerId) {
  const g = state.game;
  const me = g.players[playerId];
  return {
    t: 'state',
    role: 'player',
    serverNow: Date.now(),
    me: { name: me.name, emoji: me.emoji, color: me.color },
    phase: g.phase,
    pos: g.pos,
    total: g.questions.length,
    question: g.pos >= 0 ? g.questions[g.pos].text : null,
    endsAt: g.endsAt,
    startedAt: g.startedAt,
    duration: g.endsAt ? (g.endsAt - g.startedAt) / 1000 : null,
    people: g.people,
    players: Object.keys(g.players).length,
    voted: G.votedCount(g),
    myVote: g.pos >= 0 ? (g.votes[g.pos]?.[playerId] ?? null) : null,
    results: currentResults(g, 3),
    final:
      g.phase === 'final'
        ? { ...G.playerHits(g, playerId), champions: G.summary(g).champions }
        : null,
  };
}

// ---------- connections ----------

const clients = new Map(); // ws -> { role, playerId, pin, ip }

function onlinePlayers(g) {
  const ids = new Set();
  for (const c of clients.values()) if (c.role === 'player' && c.pin === g.pin) ids.add(c.playerId);
  return ids;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function sendView(ws, c) {
  if (c.role === 'host') return send(ws, hostView());
  if (c.role !== 'player') return;
  if (!state.game || state.game.pin !== c.pin || !state.game.players[c.playerId]) {
    c.role = null;
    return send(ws, { t: 'error', code: 'game_over', msg: 'Hra skončila. Zadej nový PIN.' });
  }
  send(ws, playerView(c.playerId));
}

let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = null;
  for (const [ws, c] of clients) sendView(ws, c);
}
// ponytail: coalesces bursts of votes into one broadcast per 100 ms; full state is small (<5 kB) so no diffing.
function scheduleBroadcast() {
  broadcastTimer ??= setTimeout(broadcast, 100);
}

/** Persist + archive + broadcast after any mutation. */
function changed({ important = false } = {}) {
  const g = state.game;
  if (g?.phase === 'final' && !g.archived) {
    g.archived = store.archive(g, G.summary(g));
    important = true;
  }
  store.save(state, important);
  important ? broadcast() : scheduleBroadcast();
}

// Bad-PIN rate limit: 10 failures per minute per IP.
const failures = new Map();
function rateLimited(ip) {
  const f = failures.get(ip);
  return f && f.resetAt > Date.now() && f.count >= 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + 60_000 });
  else f.count++;
}

const hostActions = {
  newGame() {
    const prev = state.game;
    if (prev && !prev.archived && Object.keys(prev.results).length) {
      G.finish(prev);
      prev.archived = store.archive(prev, G.summary(prev));
    }
    state.game = G.createGame(data, Date.now(), prev?.pin);
  },
  closeGame() {
    const prev = state.game;
    if (prev && !prev.archived && Object.keys(prev.results).length) {
      G.finish(prev);
      prev.archived = store.archive(prev, G.summary(prev));
    }
    state.game = null;
  },
  next: (g) => G.startNext(g, Date.now()),
  endNow: (g) => G.endNow(g),
  addTime: (g, msg) => G.addTime(g, Math.min(Math.max(Number(msg.seconds) || 10, 1), 120), Date.now()),
  skip: (g) => G.skip(g, Date.now()),
  repeat: (g) => G.repeat(g, Date.now()),
  finish: (g) => G.finish(g),
  settings(g, msg) {
    if (typeof msg.autoEndWhenAllVoted === 'boolean') g.settings.autoEndWhenAllVoted = msg.autoEndWhenAllVoted;
  },
};

function handle(ws, c, msg) {
  switch (msg.t) {
    case 'join': {
      if (rateLimited(c.ip)) return send(ws, { t: 'error', code: 'rate_limited', msg: 'Moc pokusů. Zkus to za minutu.' });
      const g = state.game;
      if (!g || g.phase === 'final' || String(msg.pin) !== g.pin) {
        recordFailure(c.ip);
        return send(ws, { t: 'error', code: 'bad_pin', msg: 'Špatný PIN.' });
      }
      const p = G.addPlayer(g, typeof msg.playerId === 'string' ? msg.playerId : null, Date.now());
      Object.assign(c, { role: 'player', playerId: p.id, pin: g.pin });
      send(ws, { t: 'joined', playerId: p.id, pin: g.pin });
      return changed();
    }
    case 'vote': {
      if (c.role !== 'player' || state.game?.pin !== c.pin) return;
      const err = G.vote(state.game, c.playerId, msg.pos, msg.person, Date.now());
      if (err) return send(ws, { t: 'error', code: err, msg: err === 'vote_closed' ? 'Hlasování už skončilo.' : 'Neplatný hlas.' });
      if (G.tick(state.game, Date.now())) return changed({ important: true }); // auto-end when all voted
      return changed();
    }
    case 'host': {
      if (!isHostKey(msg.key)) return send(ws, { t: 'error', code: 'unauthorized', msg: 'Špatné heslo.' });
      c.role = 'host';
      send(ws, { t: 'hostOk' });
      return sendView(ws, c);
    }
    case 'history':
      if (c.role === 'host') send(ws, { t: 'history', games: store.listGames() });
      return;
    case 'action': {
      if (c.role !== 'host') return send(ws, { t: 'error', code: 'unauthorized', msg: 'Nejsi přihlášen jako host.' });
      const fn = hostActions[msg.action];
      if (!fn) return;
      const needsGame = !['newGame', 'closeGame'].includes(msg.action);
      if (needsGame && !state.game) return;
      const err = fn(state.game, msg);
      if (err) send(ws, { t: 'error', code: err, msg: 'Teď to nejde.' });
      return changed({ important: true });
    }
  }
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
const ROUTES = { '/': 'index.html', '/host': 'host.html', '/admin': 'admin.html' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too_large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const reply = (code, body, type = 'text/plain; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };

  if (url.pathname === '/health') return reply(200, 'ok');

  if (url.pathname === '/qr.svg') {
    const text = url.searchParams.get('text') ?? '';
    if (!text || text.length > 300) return reply(400, 'bad text');
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply(200, svg, MIME['.svg'], { 'Cache-Control': 'max-age=3600' });
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isHostKey(req.headers['x-host-key'])) return reply(401, 'unauthorized');
    if (url.pathname === '/api/games') return reply(200, JSON.stringify(store.listGames()), 'application/json');
    const m = url.pathname.match(/^\/api\/games\/([\w-]+\.json)$/);
    if (m) {
      const body = store.readGame(m[1]);
      return body ? reply(200, body, 'application/json') : reply(404, 'not found');
    }
    if (url.pathname === '/api/data') {
      if (req.method === 'GET') return reply(200, JSON.stringify(data), 'application/json');
      if (req.method === 'PUT') {
        let body;
        try {
          body = JSON.parse(await readBody(req, 256 * 1024));
        } catch (e) {
          return reply(400, JSON.stringify({ error: e.message === 'too_large' ? 'Data jsou moc velká.' : 'Neplatný JSON.' }), 'application/json');
        }
        let next;
        try {
          next = G.validateData(body);
        } catch (e) {
          return reply(400, JSON.stringify({ error: e.message }), 'application/json');
        }
        store.saveData(next);
        data = next; // new games pick it up; a running game keeps its own snapshot
        console.log(`Admin uložil ${data.people.length} lidí, ${data.questions.length} otázek.`);
        return reply(200, JSON.stringify(data), 'application/json');
      }
      return reply(405, 'method not allowed');
    }
    if (url.pathname === '/api/current' && state.game) {
      return reply(200, JSON.stringify({ pin: state.game.pin, ...G.summary(state.game) }, null, 1), 'application/json');
    }
    return reply(404, 'not found');
  }

  const rel = ROUTES[url.pathname] ?? url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return reply(403, 'forbidden');
  fs.readFile(file, (err, body) => {
    if (err) return reply(404, 'Nenalezeno');
    reply(200, body, MIME[path.extname(file)] ?? 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
});

// ---------- WebSocket ----------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });

wss.on('connection', (ws, req) => {
  const c = { role: null, playerId: null, pin: null, ip: clientIp(req) };
  clients.set(ws, c);
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') handle(ws, c, msg);
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (c.role === 'player') scheduleBroadcast(); // online count for host
  });
  send(ws, { t: 'hello', serverNow: Date.now() });
});

// Keepalive through reverse proxies + drop dead sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000);

// Server-driven countdown. Also resolves questions that expired while the server was down.
setInterval(() => {
  if (G.tick(state.game, Date.now())) changed({ important: true });
}, 200);

function shutdown() {
  store.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Kdo by nejspíš… běží na http://localhost:${PORT} (projektor: /host)`));
