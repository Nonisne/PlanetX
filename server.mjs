// Minimal zero-dependency static file server + online room API for the game.
//
//   node server.mjs   ->  http://127.0.0.1:5173/
//
// The room API is plain HTTP: POST for actions, Server-Sent Events for pushes, so no
// websocket library is needed. Room state lives in memory (a table top, not a
// database) and every response is a per-player redacted view.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addPlayer, applyRoomAction, createRoom, hydrateRoom, playerByToken, roomSummary, serializeRoom, viewFor } from './public/src/room.js';
import { BUILTIN_MAX_PLAYERS, INITIAL_CLUE_COUNTS, MODES } from './public/src/rules.js';
import { createPuzzle, initialCluesFor } from './server/puzzles.js';
import { applyTutorialAction, createTutorialRoom } from './server/tutorial.js';
import { attachBotController, detachBotController } from './server/bot-controller.js';
import { DifficultyCache } from './server/difficulty-cache.js';
import { hashPuzzle } from './server/difficulty.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

// ---- rooms -----------------------------------------------------------------

export const rooms = new Map();

/**
 * The on-disk cache that maps each puzzle to its 1–5 star difficulty. The
 * cache is shared across every room in this process and survives restarts
 * via `data/difficulty.json`. We resolve `data/` relative to the project
 * root so `node server.mjs` from anywhere finds the same file.
 */
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
export const difficultyCache = new DifficultyCache({
  filePath: path.join(projectRoot, 'data', 'difficulty.json'),
});

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function roomView(room, playerId) {
  const view = { ...viewFor(room, playerId), revision: room.revision || 0 };
  if (room.difficulty) view.difficulty = room.difficulty;
  return view;
}

/** Push the current per-player view to everyone watching this room. */
function broadcast(room, extra = null) {
  for (const listener of room.listeners) {
    const view = roomView(room, listener.playerId);
    writeEvent(listener.res, 'view', { view, notice: extra });
  }
}

/**
 * Run the bot simulation against `puzzle` off the response cycle, then
 * notify every listener in `room` via SSE when the stars land. Errors are
 * logged but never propagate — a failed simulation should not crash the
 * server or block the lobby.
 */
function rateDifficultyAsync(room, puzzle, { modeId }) {
  setImmediate(() => {
    try {
      const result = difficultyCache.getOrCompute(puzzle, { modeId });
      room.difficulty = result;
      broadcast(room, { kind: 'difficulty-ready', modeId, ...result });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[difficulty] simulation failed:', error.message);
      broadcast(room, { kind: 'difficulty-error', modeId, error: error.message });
    }
  });
}

/** Stand-alone rating that just updates the cache; no room to broadcast to. */
function ratePuzzleAsync(puzzle, { modeId }) {
  setImmediate(() => {
    try {
      difficultyCache.getOrCompute(puzzle, { modeId });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[difficulty] simulation failed:', error.message);
    }
  });
}

function writeEvent(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* the listener is gone; it will be cleaned up by its close handler */
  }
}

function cleanupRooms() {
  const cutoff = Date.now() - 1000 * 60 * 60 * 12;
  for (const [id, room] of rooms) {
    const live = room.listeners.size > 0;
    if (!live && room.createdAt < cutoff) {
      detachBotController(room);
      rooms.delete(id);
    }
  }
}

/** Wire bot actions into the same revision / SSE path humans use. Record mode never runs bots. */
function attachRoomBots(room) {
  if (!room || room.playMode !== 'builtin' || room.tutorialState) return;
  if (!room.players?.some((player) => player.bot)) return;
  const tickMs = Number(process.env.BOT_TICK_MS);
  attachBotController(room, {
    ...(Number.isFinite(tickMs) && tickMs > 0 ? { tickMs } : {}),
    onApplied(liveRoom, bot, action) {
      liveRoom.revision = (liveRoom.revision || 0) + 1;
      broadcast(liveRoom, { kind: 'action', by: bot.name, byId: bot.id, action: action?.kind });
    },
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api','rooms',id?,...]
  if (parts[0] !== 'api') return false;

  if (req.method === 'GET' && url.pathname === '/api/modes') {
    sendJson(res, 200, {
      modes: Object.values(MODES).map((m) => ({ id: m.id, name: m.name, sectors: m.sectors, visible: m.visible })),
      playModes: ['record', 'builtin', 'tutorial'],
      builtinBoards: ['standard', 'expert'],
      initialClueCounts: INITIAL_CLUE_COUNTS,
      tutorial: { modeId: 'standard', humanPlayers: 1, botPlayers: 1, initialClueCount: 4 },
      withBots: { min: 0, max: BUILTIN_MAX_PLAYERS - 1, playMode: 'builtin' },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    const body = await readJson(req);
    // the host picks the board; anything unknown quietly means the standard one
    const modeId = MODES[body.modeId] ? body.modeId : 'standard';
    const playMode = body.playMode || 'record';
    if (!['record', 'builtin', 'tutorial'].includes(playMode)) {
      sendJson(res, 400, { error: '请选择记录模式、内置谜题模式或教学模式' });
      return true;
    }
    const initialClueCount = body.initialClueCount === undefined ? 4 : body.initialClueCount;
    if (!INITIAL_CLUE_COUNTS.includes(initialClueCount)) {
      sendJson(res, 400, { error: '初始线索数量只能选择 0、4、8、12 条' });
      return true;
    }
    let puzzle = null;
    let requestedBots = 0;
    if (playMode === 'builtin') {
      const generated = createPuzzle({ modeId });
      puzzle = { ...generated, startingClues: Array.from({ length: BUILTIN_MAX_PLAYERS }, () => initialCluesFor(generated, { count: 12 })) };
      // bots only join in builtin mode — `withBots` is ignored otherwise
      requestedBots = Number(body.withBots) || 0;
      const maxBots = BUILTIN_MAX_PLAYERS - 1; // the host still needs a seat
      if (requestedBots < 0 || requestedBots > maxBots) {
        sendJson(res, 400, { error: `内置模式最多加 ${maxBots} 个 Bot 对手（${BUILTIN_MAX_PLAYERS} 人房）` });
        return true;
      }
    } else if (body.withBots != null && body.withBots !== 0 && body.withBots !== false) {
      sendJson(res, 400, { error: 'Bot 对手只用于内置谜题，记录模式和教学不接受 withBots' });
      return true;
    }
    const room = playMode === 'tutorial' ? createTutorialRoom({ hostName: body.name })
      : createRoom({ modeId, hostName: body.name, playMode, puzzle, initialClueCount });
    // add N bots after the host joined, only in builtin mode
    for (let i = 0; i < requestedBots; i += 1) {
      const botName = i === 0 ? `Bot${i + 1}` : `Bot${i + 1}`;
      const bot = addPlayer(room, botName);
      bot.bot = true;
    }
    room.revision = 0;
    rooms.set(room.id, room);
    attachRoomBots(room);
    const me = room.players[0];
    // Fire-and-forget difficulty rating: the room is returned immediately
    // with `difficulty: null`, then we run the simulation in the background
    // and broadcast the result via SSE so the lobby UI can light up the
    // stars when they become available.
    if (playMode === 'builtin' && puzzle) {
      room.puzzle = puzzle;
      room.difficulty = null;
      const requestId = `${room.id}:${Date.now()}`;
      rateDifficultyAsync(room, puzzle, { modeId, requestId });
    }
    sendJson(res, 200, { roomId: room.id, playerId: me.id, token: me.token, view: roomView(room, me.id) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/puzzles/difficulty') {
    const modeId = MODES[url.searchParams.get('modeId')] ? url.searchParams.get('modeId') : 'standard';
    const samples = difficultyCache.state.samples[modeId] || [];
    sendJson(res, 200, {
      modeId,
      sampleCount: samples.length,
      breakpoints: difficultyCache.breakpointsFor(modeId),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/puzzles/difficulty') {
    const body = await readJson(req);
    const puzzle = body.puzzle;
    if (!puzzle || !Array.isArray(puzzle.objects)) {
      sendJson(res, 400, { error: 'puzzle.objects is required' });
      return true;
    }
    const modeId = MODES[body.modeId] ? body.modeId : (puzzle.modeId || 'standard');
    const cacheHash = hashPuzzle(puzzle);
    const cached = difficultyCache.state.computed[cacheHash];
    if (cached && cached.botVersion === difficultyCache.state.botVersion) {
      sendJson(res, 200, { status: 'ready', ...cached });
      return true;
    }
    // No cached entry yet — kick off the simulation in the background and
    // return a `computing` status. Callers can subscribe to the room's
    // SSE stream to receive the `difficulty-ready` event when it lands.
    ratePuzzleAsync(puzzle, { modeId });
    sendJson(res, 202, { status: 'computing', modeId });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/rooms/restore') {
    const body = await readJson(req);
    let room;
    try {
      room = hydrateRoom(body.room);
    } catch (error) {
      sendJson(res, 400, { error: error.message || '存档房间无效' });
      return true;
    }
    const existing = rooms.get(String(room.id || '').toUpperCase());
    if (existing) {
      sendJson(res, 200, {
        roomId: existing.id,
        restored: false,
        occupied: existing.listeners.size > 0,
        summary: roomSummary(existing),
      });
      return true;
    }
    room.id = String(room.id).toUpperCase();
    if (room.playMode !== 'builtin') {
      for (const player of room.players || []) player.bot = false;
    }
    rooms.set(room.id, room);
    attachRoomBots(room);
    sendJson(res, 200, { roomId: room.id, restored: true, occupied: false, summary: roomSummary(room) });
    return true;
  }

  if (parts[1] === 'rooms' && parts[2]) {
    const room = rooms.get(parts[2].toUpperCase());
    if (!room) {
      sendJson(res, 404, { error: '房间不存在或已过期' });
      return true;
    }

    // POST bodies are read once; the token may arrive in the body, the query string
    // or the x-room-token header (the browser client uses the body).
    const body = req.method === 'POST' ? await readJson(req) : {};

    if (req.method === 'POST' && parts[3] === 'join') {
      if (room.tutorialState) {
        sendJson(res, 409, { error: '教学房间固定为 1 名真人和 1 个 Bot，不能加入其他玩家' });
        return true;
      }
      const spectator = Boolean(body.spectator);
      const seatedCount = room.players.filter((player) => !player.spectator).length;
      if (!spectator && room.playMode === 'builtin' && (room.phase !== 'lobby' || seatedCount >= BUILTIN_MAX_PLAYERS)) {
        sendJson(res, 409, { error: room.phase !== 'lobby' ? '内置谜题已开始，不能中途加入；请等待下一局' : `内置谜题最多支持 ${BUILTIN_MAX_PLAYERS} 名玩家` });
        return true;
      }
      let player;
      try {
        player = addPlayer(room, body.name, { spectator });
      } catch (error) {
        sendJson(res, 409, { error: error.message || '无法加入房间' });
        return true;
      }
      room.revision = (room.revision || 0) + 1;
      broadcast(room, { kind: 'player-joined', name: player.name, spectator: Boolean(player.spectator) });
      sendJson(res, 200, { roomId: room.id, playerId: player.id, token: player.token, view: roomView(room, player.id) });
      return true;
    }

    const token = url.searchParams.get('token') || req.headers['x-room-token'] || body.token || '';
    const player = playerByToken(room, token);
    if (!player || (room.tutorialState && player.id !== room.tutorialState.humanId)) {
      sendJson(res, 403, { error: '身份已失效，请重新加入房间' });
      return true;
    }

    if (req.method === 'GET' && parts[3] === 'archive') {
      sendJson(res, 200, { room: serializeRoom(room) });
      return true;
    }

    if (req.method === 'GET' && parts[3] === 'view') {
      sendJson(res, 200, { view: roomView(room, player.id) });
      return true;
    }

    if (req.method === 'GET' && parts[3] === 'stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const listener = { playerId: player.id, res };
      room.listeners.add(listener);
      writeEvent(res, 'view', { view: roomView(room, player.id), notice: { kind: 'hello', name: player.name } });
      const beat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* ignored */
        }
      }, 20000);
      beat.unref?.(); // never keep the process (or a test runner) alive
      const drop = () => {
        clearInterval(beat);
        room.listeners.delete(listener);
      };
      req.on('close', drop);
      res.on('close', drop);
      return true;
    }

    if (req.method === 'POST' && parts[3] === 'action') {
      const result = room.tutorialState ? applyTutorialAction(room, player.id, body.action || {})
        : applyRoomAction(room, player.id, body.action || {});
      if (result.ok) {
        room.revision = (room.revision || 0) + 1;
        broadcast(room, { kind: 'action', by: player.name, byId: player.id, action: (body.action || {}).kind });
      }
      sendJson(res, result.ok ? 200 : 400, {
        ok: Boolean(result.ok),
        error: result.error || null,
        warning: result.warning || null,
        advanced: result.advanced || null,
        entry: result.entry ? { id: result.entry.id, type: result.entry.type, actorId: result.entry.actorId } : null,
        view: roomView(room, player.id),
      });
      return true;
    }

    if (req.method === 'GET' && parts[3] === 'summary') {
      sendJson(res, 200, roomSummary(room));
      return true;
    }
  }

  sendJson(res, 404, { error: 'not found' });
  return true;
}

// ---- static files ----------------------------------------------------------

function serveStatic(req, res, url) {
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(root, '.' + rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(full).pipe(res);
  });
}

export function createServer() {
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => {
        sendJson(res, 500, { error: String((err && err.message) || err) });
      });
      return;
    }
    serveStatic(req, res, url);
  });
  // closing the server also drops every open SSE stream and any idle keep-alive socket,
  // otherwise a test runner (or a Ctrl+C) would wait for them
  const close = server.close.bind(server);
  server.close = (cb) => {
    for (const room of rooms.values()) {
      for (const listener of room.listeners) {
        try {
          listener.res.end();
        } catch {
          /* already gone */
        }
      }
      room.listeners.clear();
    }
    server.closeAllConnections?.();
    return close(cb);
  };
  return server;
}

/** Addresses other devices on the network can use to reach this server. */
export function lanUrls(port) {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(`http://${net.address}:${port}/`);
    }
  }
  return out;
}

// Only listen when this file is the process entry point, so tests can import it.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer();
  server.listen(port, host, () => {
    const lan = lanUrls(port);
    console.log(`[planet-x] serving ${root}`);
    if (host === '0.0.0.0' || host === '::') {
      console.log('[planet-x] reachable on this machine:  http://127.0.0.1:' + port + '/');
      if (lan.length) {
        console.log('[planet-x] reachable for other devices on the same network:');
        for (const url of lan) console.log(`[planet-x]   ${url}`);
        console.log('[planet-x] share one of those links; everyone joins with the room code.');
      } else {
        console.log('[planet-x] no LAN address found — other devices cannot reach this server.');
      }
    } else {
      console.log(`[planet-x] open http://${host}:${port}/`);
      console.log('[planet-x] (only this machine can reach it; use HOST=0.0.0.0 to let others join)');
    }
  });
  setInterval(cleanupRooms, 1000 * 60 * 30).unref?.();
}

export default createServer;
