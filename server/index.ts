import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import QRCode from 'qrcode';
import type { ClientMsg, ErrorCode, Game, GameData, GameError, HostActionMsg, HostGame, HostView, Player, PlayerView, ServerMsg, State } from '../shared/types.ts';
import * as G from './game.ts';
import { parseClientMsg } from './protocol.ts';
import { createStore } from './store.ts';

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
let data: GameData = loadData();
function loadData(): GameData {
  const saved = store.loadData();
  if (saved) {
    try {
      return G.validateData(saved);
    } catch (e) {
      console.error(`Uložená data jsou neplatná, používám ${DATA_FILE}:\n${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return G.validateData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
}
const state: State = store.load();
console.log(`Načteno ${data.people.length} lidí, ${data.questions.length} otázek. Rozehraná hra: ${state.game ? state.game.pin + ' (' + state.game.phase + ')' : 'žádná'}`);

const keyDigest = createHash('sha256').update(HOST_KEY).digest();
const isHostKey = (k: unknown): boolean => typeof k === 'string' && timingSafeEqual(createHash('sha256').update(k).digest(), keyDigest);

// ---------- views (what each client is allowed to see) ----------

function currentResults(game: Game, top: number) {
  return game.results[game.pos]?.slice(0, top) ?? null;
}

/** Question length in seconds (only while a question is running). */
function durationOf(g: Game): number | null {
  return g.endsAt !== null && g.startedAt !== null ? (g.endsAt - g.startedAt) / 1000 : null;
}

function hostGame(g: Game): HostGame {
  return {
    pin: g.pin,
    phase: g.phase,
    pos: g.pos,
    total: g.questions.length,
    question: g.questions[g.pos] ?? null,
    nextQuestion: g.questions[g.pos + 1] ?? null,
    endsAt: g.endsAt,
    startedAt: g.startedAt,
    duration: durationOf(g),
    players: Object.values(g.players).map(({ name, emoji, color }) => ({ name, emoji, color })),
    online: onlinePlayers(g).size,
    voted: G.votedCount(g),
    results: currentResults(g, g.settings.resultsTop),
    summary: g.phase === 'final' ? G.summary(g) : null,
    settings: g.settings,
  };
}

function hostView(): HostView {
  const g = state.game;
  return { t: 'state', role: 'host', serverNow: Date.now(), publicUrl: PUBLIC_URL, game: g && hostGame(g) };
}

function playerView(g: Game, playerId: string, me: Player): PlayerView {
  return {
    t: 'state',
    role: 'player',
    serverNow: Date.now(),
    me: { name: me.name, emoji: me.emoji, color: me.color },
    phase: g.phase,
    pos: g.pos,
    total: g.questions.length,
    question: g.questions[g.pos]?.text ?? null,
    endsAt: g.endsAt,
    startedAt: g.startedAt,
    duration: durationOf(g),
    people: g.people,
    players: Object.keys(g.players).length,
    voted: G.votedCount(g),
    myVote: g.votes[g.pos]?.[playerId] ?? null,
    results: currentResults(g, 3),
    final: g.phase === 'final' ? { ...G.playerHits(g, playerId), champions: G.summary(g).champions } : null,
  };
}

// ---------- connections ----------

type Session = { role: 'anon' } | { role: 'host' } | { role: 'player'; playerId: string; pin: string };
interface Conn {
  session: Session;
  ip: string;
}
const clients = new Map<WebSocket, Conn>();

function onlinePlayers(g: Game): Set<string> {
  const ids = new Set<string>();
  for (const { session } of clients.values()) if (session.role === 'player' && session.pin === g.pin) ids.add(session.playerId);
  return ids;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
const sendError = (ws: WebSocket, code: ErrorCode, msg: string): void => send(ws, { t: 'error', code, msg });

function sendView(ws: WebSocket, c: Conn): void {
  const { session } = c;
  if (session.role === 'host') return send(ws, hostView());
  if (session.role !== 'player') return;
  const g = state.game;
  const me = g?.pin === session.pin ? g.players[session.playerId] : undefined;
  if (!g || !me) {
    c.session = { role: 'anon' };
    return sendError(ws, 'game_over', 'Hra skončila. Zadej nový PIN.');
  }
  send(ws, playerView(g, session.playerId, me));
}

let broadcastTimer: NodeJS.Timeout | null = null;
function broadcast(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = null;
  for (const [ws, c] of clients) sendView(ws, c);
}
// ponytail: coalesces bursts of votes into one broadcast per 100 ms; full state is small (<5 kB) so no diffing.
function scheduleBroadcast(): void {
  broadcastTimer ??= setTimeout(broadcast, 100);
}

/** Persist + archive + broadcast after any mutation. */
function changed({ important = false } = {}): void {
  const g = state.game;
  if (g?.phase === 'final' && !g.archived) {
    g.archived = store.archive(g, G.summary(g));
    important = true;
  }
  store.save(state, important);
  if (important) broadcast();
  else scheduleBroadcast();
}

// Bad-PIN rate limit: 10 failures per minute per IP.
const failures = new Map<string, { count: number; resetAt: number }>();
function rateLimited(ip: string): boolean {
  const f = failures.get(ip);
  return !!f && f.resetAt > Date.now() && f.count >= 10;
}
function recordFailure(ip: string): void {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.resetAt < now) failures.set(ip, { count: 1, resetAt: now + 60_000 });
  else f.count++;
}

/** Played games (at least one closed question) go to the archive before the game is replaced. */
function archivePlayed(prev: Game | null): void {
  if (prev && !prev.archived && Object.keys(prev.results).length) {
    G.finish(prev);
    prev.archived = store.archive(prev, G.summary(prev));
  }
}

/** Actions that need a running game. Returns an error code when the transition is not allowed now. */
function gameAction(g: Game, msg: Exclude<HostActionMsg, { action: 'newGame' | 'closeGame' }>): GameError | undefined {
  switch (msg.action) {
    case 'next':
      return G.startNext(g, Date.now());
    case 'endNow':
      return G.endNow(g);
    case 'addTime':
      return G.addTime(g, Math.min(Math.max(msg.seconds || 10, 1), 120), Date.now());
    case 'skip':
      return G.skip(g, Date.now());
    case 'repeat':
      return G.repeat(g, Date.now());
    case 'finish':
      G.finish(g);
      return undefined;
    case 'settings':
      if (msg.autoEndWhenAllVoted !== undefined) g.settings.autoEndWhenAllVoted = msg.autoEndWhenAllVoted;
      return undefined;
  }
}

function handle(ws: WebSocket, c: Conn, msg: ClientMsg): void {
  switch (msg.t) {
    case 'join': {
      if (rateLimited(c.ip)) return sendError(ws, 'rate_limited', 'Moc pokusů. Zkus to za minutu.');
      const g = state.game;
      if (!g || g.phase === 'final' || msg.pin !== g.pin) {
        recordFailure(c.ip);
        return sendError(ws, 'bad_pin', 'Špatný PIN.');
      }
      const p = G.addPlayer(g, msg.playerId ?? null, Date.now());
      c.session = { role: 'player', playerId: p.id, pin: g.pin };
      send(ws, { t: 'joined', playerId: p.id, pin: g.pin });
      return changed();
    }
    case 'vote': {
      const { session } = c;
      const g = state.game;
      if (session.role !== 'player' || !g || g.pin !== session.pin) return;
      const err = G.vote(g, session.playerId, msg.pos, msg.person, Date.now());
      if (err) return sendError(ws, err, err === 'vote_closed' ? 'Hlasování už skončilo.' : 'Neplatný hlas.');
      return changed({ important: G.tick(g, Date.now()) }); // auto-end when all voted
    }
    case 'host':
      if (!isHostKey(msg.key)) return sendError(ws, 'unauthorized', 'Špatné heslo.');
      c.session = { role: 'host' };
      send(ws, { t: 'hostOk' });
      return sendView(ws, c);
    case 'history':
      if (c.session.role === 'host') send(ws, { t: 'history', games: store.listGames() });
      return;
    case 'action': {
      if (c.session.role !== 'host') return sendError(ws, 'unauthorized', 'Nejsi přihlášen jako host.');
      if (msg.action === 'newGame') {
        archivePlayed(state.game);
        state.game = G.createGame(data, Date.now(), state.game?.pin);
      } else if (msg.action === 'closeGame') {
        archivePlayed(state.game);
        state.game = null;
      } else {
        if (!state.game) return;
        const err = gameAction(state.game, msg);
        if (err) sendError(ws, err, 'Teď to nejde.');
      }
      return changed({ important: true });
    }
  }
}

// ---------- HTTP ----------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};
const ROUTES: Record<string, string> = { '/': 'index.html', '/host': 'host.html', '/admin': 'admin.html' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'",
};

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
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

function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = String(fwd ?? '').split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const JSON_TYPE = 'application/json';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const reply = (code: number, body: string | Buffer, type = 'text/plain; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };
  const replyJson = (code: number, value: unknown) => reply(code, JSON.stringify(value), JSON_TYPE);

  if (url.pathname === '/health') return reply(200, 'ok');

  if (url.pathname === '/qr.svg') {
    const text = url.searchParams.get('text') ?? '';
    if (!text || text.length > 300) return reply(400, 'bad text');
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return reply(200, svg, MIME['.svg'], { 'Cache-Control': 'max-age=3600' });
  }

  if (url.pathname.startsWith('/api/')) {
    if (!isHostKey(req.headers['x-host-key'])) return reply(401, 'unauthorized');
    if (url.pathname === '/api/games') return replyJson(200, store.listGames());
    const m = url.pathname.match(/^\/api\/games\/([\w-]+\.json)$/);
    if (m?.[1]) {
      const body = store.readGame(m[1]);
      return body ? reply(200, body, JSON_TYPE) : reply(404, 'not found');
    }
    if (url.pathname === '/api/data') {
      if (req.method === 'GET') return replyJson(200, data);
      if (req.method === 'PUT') {
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req, 256 * 1024));
        } catch (e) {
          return replyJson(400, { error: e instanceof Error && e.message === 'too_large' ? 'Data jsou moc velká.' : 'Neplatný JSON.' });
        }
        let next: GameData;
        try {
          next = G.validateData(body);
        } catch (e) {
          return replyJson(400, { error: e instanceof Error ? e.message : String(e) });
        }
        store.saveData(next);
        data = next; // new games pick it up; a running game keeps its own snapshot
        console.log(`Admin uložil ${data.people.length} lidí, ${data.questions.length} otázek.`);
        return replyJson(200, data);
      }
      return reply(405, 'method not allowed');
    }
    if (url.pathname === '/api/current' && state.game) {
      return reply(200, JSON.stringify({ pin: state.game.pin, ...G.summary(state.game) }, null, 1), JSON_TYPE);
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
const alive = new WeakSet<WebSocket>();

wss.on('connection', (ws, req) => {
  const c: Conn = { session: { role: 'anon' }, ip: clientIp(req) };
  clients.set(ws, c);
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  ws.on('message', (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const msg = parseClientMsg(json);
    if (msg) handle(ws, c, msg);
  });
  ws.on('close', () => {
    clients.delete(ws);
    if (c.session.role === 'player') scheduleBroadcast(); // online count for host
  });
  send(ws, { t: 'hello', serverNow: Date.now() });
});

// Keepalive through reverse proxies + drop dead sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 20_000);

// Server-driven countdown. Also resolves questions that expired while the server was down.
setInterval(() => {
  if (G.tick(state.game, Date.now())) changed({ important: true });
}, 200);

function shutdown(): void {
  store.flush();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => console.log(`Kdo by nejspíš… běží na http://localhost:${PORT} (projektor: /host)`));
