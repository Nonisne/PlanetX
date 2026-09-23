// End-to-end test of the room HTTP API: real server, real requests (no sockets are
// faked), including a Server-Sent Events stream read straight from the response body.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer, rooms } from '../server.mjs';
import { Obj } from '../public/src/types.js';
import { applyRoomAction, currentPlayer } from '../public/src/room.js';
import { inMemoryFetch } from './server-dispatch.js';

const server = createServer();
const useMemory = process.env.PLANETX_TEST_TRANSPORT === 'memory';
if (!useMemory) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = useMemory ? 'http://in-memory.test' : `http://127.0.0.1:${server.address().port}`;
const fetch = useMemory ? inMemoryFetch(server) : globalThis.fetch;

async function createBuiltinTable(playerCount = 1) {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '内置甲', modeId: 'standard', playMode: 'builtin' } });
  assert.equal(created.status, 200, created.body.error);
  const players = [created.body];
  while (players.length < playerCount) {
    const joined = await api(`/api/rooms/${created.body.roomId}/join`, { method: 'POST', body: { name: `内置玩家 ${players.length + 1}` } });
    assert.equal(joined.status, 200);
    players.push(joined.body);
  }
  await acceptedAction(players[0], { kind: 'start-game' });
  for (const player of players) {
    await acceptedAction(player, { kind: 'claim-initial-clues', count: 4 });
    await acceptedAction(player, { kind: 'setup' });
  }
  return { host: players[0], guest: players[1], players, room: rooms.get(created.body.roomId) };
}

test('builtin HTTP creation validates mode and keeps generator files outside the static root', async () => {
  const expert = await api('/api/rooms', { method: 'POST', body: { playMode: 'builtin', modeId: 'expert' } });
  assert.equal(expert.status, 200);
  assert.equal(expert.body.view.mode.sectors, 18);
  const unknown = await api('/api/rooms', { method: 'POST', body: { playMode: 'unknown' } });
  assert.equal(unknown.status, 400);
  for (const privatePath of ['/server/puzzles.js', '/server.mjs']) {
    assert.equal((await fetch(`${base}${privatePath}`)).status, 404);
  }
  const { host } = await createBuiltinTable();
  const lateJoin = await api(`/api/rooms/${host.roomId}/join`, { method: 'POST', body: { name: '迟到玩家' } });
  assert.equal(lateJoin.status, 409);
});

test('builtin HTTP caps rooms at four players and distributes the host-selected initial clue count', async () => {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '房主', playMode: 'builtin', initialClueCount: 12 } });
  assert.equal(created.status, 200);
  const players = [created.body];
  const room = rooms.get(created.body.roomId);
  assert.equal(room.puzzle.startingClues.length, 4);
  assert.ok(room.puzzle.startingClues.every((hand) => hand.length === 12));
  while (players.length < 4) {
    const joined = await api(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: `玩家 ${players.length + 1}` } });
    assert.equal(joined.status, 200);
    players.push(joined.body);
  }
  const revision = room.revision;
  const extra = await api(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: '第五位' } });
  assert.equal(extra.status, 409);
  assert.match(extra.body.error, /最多支持 4 名玩家/);
  assert.equal(room.players.length, 4);
  assert.equal(room.revision, revision);
  const spectator = await api(`/api/rooms/${room.id}/join`, { method: 'POST', body: { name: '旁观', spectator: true } });
  assert.equal(spectator.status, 200);
  assert.equal(spectator.body.view.amSpectator, true);
  assert.equal(spectator.body.view.playerCount, 4);
  assert.equal(room.players.length, 5);
  await acceptedAction(players[0], { kind: 'start-game' });
  for (const player of players) {
    assert.equal(room.setup[player.playerId].clues.length, 12);
    const count = 12;
    const claimed = await acceptedAction(player, { kind: 'claim-initial-clues', count });
    assert.equal(claimed.view.mySetup.clues.length, count);
    assert.equal(claimed.view.mySetup.initialClueCount, count);
    assert.equal(claimed.view.mySetup.cluesClaimed, true);
    for (const clue of claimed.view.mySetup.clues) {
      assert.notEqual(room.puzzle.objects[clue.sector], clue.type);
      if (clue.type === Obj.COMET) assert.ok([1, 2, 4, 6, 10].includes(clue.sector));
    }
    const retry = await acceptedAction(player, { kind: 'claim-initial-clues', count });
    assert.deepEqual(retry.view.mySetup.clues, claimed.view.mySetup.clues);
    const reroll = await roomAction(player, { kind: 'claim-initial-clues', count: count === 12 ? 0 : 12 });
    assert.equal(reroll.status, 400);
    assert.deepEqual(reroll.body.view.mySetup.clues, claimed.view.mySetup.clues);
    await acceptedAction(player, { kind: 'setup' });
  }
  assert.equal(room.phase, 'play');
});

test('HTTP and SSE views share monotonic revisions for joins and non-log actions', async (context) => {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '甲', playMode: 'builtin' } });
  const host = created.body;
  assert.equal(host.view.revision, 0);
  const stream = await openViewStream(context, host);
  assert.equal((await stream.nextEvent()).data.view.revision, 0);
  const joined = await api(`/api/rooms/${host.roomId}/join`, { method: 'POST', body: { name: '乙' } });
  const guest = joined.body;
  assert.equal(guest.view.revision, 1);
  assert.equal((await stream.nextEvent()).data.view.revision, 1);
  const started = await acceptedAction(host, { kind: 'start-game' });
  assert.equal(started.view.revision, 2);
  assert.equal((await stream.nextEvent()).data.view.revision, 2);
  const hostClaim = await acceptedAction(host, { kind: 'claim-initial-clues', count: 4 });
  assert.equal(hostClaim.view.revision, 3);
  assert.equal((await stream.nextEvent()).data.view.revision, 3);
  const guestClaim = await acceptedAction(guest, { kind: 'claim-initial-clues', count: 4 });
  assert.equal(guestClaim.view.revision, 4);
  assert.equal((await stream.nextEvent()).data.view.revision, 4);
  const hostReady = await acceptedAction(host, { kind: 'setup' });
  assert.equal(hostReady.view.revision, 5);
  assert.equal((await stream.nextEvent()).data.view.revision, 5);
  const guestReady = await acceptedAction(guest, { kind: 'setup' });
  assert.equal(guestReady.view.revision, 6);
  assert.equal(guestReady.view.recordCount, 0);
  assert.equal((await stream.nextEvent()).data.view.revision, 6);
  const rejected = await roomAction(guest, { kind: 'wait' });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.view.revision, 6);
  const moved = await acceptedAction(host, { kind: 'wait' });
  assert.equal(moved.view.revision, 7);
  assert.equal((await stream.nextEvent()).data.view.revision, 7);
  const refreshed = await api(`/api/rooms/${host.roomId}/view`, { token: host.token });
  assert.equal(refreshed.body.view.revision, 7);
});

test('builtin HTTP responses and SSE keep truth, initial cards and unearned research private', async (context) => {
  const { host, guest, room } = await createBuiltinTable(2);
  const stream = await openViewStream(context, guest);
  await stream.nextEvent();
  const response = await acceptedAction(host, { kind: 'research', topic: 'A', text: '冒充结果' });
  assert.equal(response.view.topics.A.clue, room.puzzle.topics.A.clue);
  assert.deepEqual(Object.keys(response.entry).sort(), ['actorId', 'id', 'type']);
  const pushed = await stream.nextEvent();
  assert.equal(pushed.data.view.topics.A.clue, '');
  const guestResearch = pushed.data.view.log.find((entry) => entry.type === 'research');
  assert.equal(guestResearch.text, undefined);
  assert.equal(guestResearch.name, undefined);
  const summary = await api(`/api/rooms/${host.roomId}/summary`, { token: host.token });
  for (const payload of [response, pushed.data, summary.body]) {
    const encoded = JSON.stringify(payload);
    assert.equal(encoded.includes('"puzzle"'), false);
    assert.equal(encoded.includes('startingClues'), false);
    assert.equal(encoded.includes(JSON.stringify(room.puzzle.objects)), false);
    assert.equal(encoded.includes(room.puzzle.topics.B.clue), false);
    assert.equal(encoded.includes(room.puzzle.conferences[10]), false);
  }
  const forbidden = await roomAction(guest, { kind: 'reveal-objects', objects: room.puzzle.objects });
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.body.view.revealedObjects, null);
});

test('builtin HTTP and SSE delay a crossed conference until the preceding research phase is finished', async (context) => {
  const { host, room } = await createBuiltinTable();
  for (const start of [0, 4]) {
    const moved = await acceptedAction(host, { kind: 'survey', type: Obj.ASTEROID, start, size: 1 });
    await acceptedAction(host, { kind: 'research-declare', phaseId: moved.view.research.id, count: 0 });
  }
  const stream = await openViewStream(context, host);
  await stream.nextEvent();
  const jumped = await acceptedAction(host, { kind: 'target', sector: 8 });
  const queued = await stream.nextEvent();
  for (const payload of [jumped, queued.data]) {
    assert.equal(payload.view.research.sector, 9);
    assert.equal(payload.view.knowledge.conferences.length, 0);
    assert.equal(JSON.stringify(payload).includes(room.puzzle.conferences[10]), false);
  }
  const finished = await acceptedAction(host, { kind: 'research-declare', phaseId: jumped.view.research.id, count: 0 });
  const published = await stream.nextEvent();
  for (const payload of [finished, published.data]) {
    assert.equal(payload.view.research.sector, 12);
    assert.equal(payload.view.knowledge.conferences[0].text, room.puzzle.conferences[10]);
  }
});

test('builtin HTTP solo locate ignores forged verdict and automatically reveals a valid generated board', async () => {
  const { host, room } = await createBuiltinTable();
  const objects = room.puzzle.objects;
  const sector = objects.indexOf(Obj.PLANET_X);
  const response = await acceptedAction(host, { kind: 'locate', sector, left: objects[(sector + 11) % 12], right: objects[(sector + 1) % 12], correct: false });
  assert.equal(response.view.phase, 'done');
  assert.equal(response.view.status, 'finished');
  assert.deepEqual(response.view.revealedObjects, objects);
  assert.equal(response.view.scores.rows[0].locatePoints, 10);
  const restored = await api(`/api/rooms/${host.roomId}/view`, { token: host.token });
  assert.equal(restored.body.view.phase, 'done');
  assert.deepEqual(restored.body.view.revealedObjects, objects);
});

test('builtin HTTP multiplayer resolves final theories without manual reveal or penalty time', async () => {
  const { host, guest, room } = await createBuiltinTable(2);
  await acceptedAction(host, { kind: 'wait' });
  await acceptedAction(guest, { kind: 'wait' });
  await acceptedAction(host, { kind: 'wait' });
  const objects = room.puzzle.objects;
  const sector = objects.indexOf(Obj.PLANET_X);
  const located = await acceptedAction(guest, { kind: 'locate', sector, left: objects[(sector + 11) % 12], right: objects[(sector + 1) % 12] });
  assert.equal(located.view.phase, 'final');
  assert.equal(located.view.revealedObjects, null);
  const hostView = await api(`/api/rooms/${host.roomId}/view`, { token: host.token });
  assert.equal(hostView.body.view.locate.sector, undefined);
  const clocks = hostView.body.view.players.map((player) => player.time);
  const asteroidSector = objects.indexOf(Obj.ASTEROID);
  const completed = await acceptedAction(host, { kind: 'final-theories', theories: [{ sector: asteroidSector, objectType: Obj.ASTEROID }] });
  assert.equal(completed.view.phase, 'done');
  assert.deepEqual(completed.view.revealedObjects, objects);
  assert.equal(completed.view.knowledge.theories[0].review, 'correct');
  assert.deepEqual(completed.view.players.map((player) => player.time), clocks);
  assert.equal(completed.view.log.some((entry) => entry.type === 'penalty'), false);
});

test.after(() => server.close());

async function api(path, { method = 'GET', body, token } = {}) {
  if (path === '/api/rooms' && body && !body.playMode) body = { initialClueCount: 0, ...body };
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-room-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function roomAction(player, action) {
  return api(`/api/rooms/${player.roomId}/action`, { method: 'POST', token: player.token, body: { action } });
}

async function acceptedAction(player, action) {
  const response = await roomAction(player, action);
  assert.equal(response.status, 200, response.body.error);
  assert.equal(response.body.ok, true, response.body.error);
  return response.body;
}

async function playingTable(modeId = 'standard') {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '阿甲', modeId } });
  assert.equal(created.status, 200);
  const host = created.body;
  const joined = await api(`/api/rooms/${host.roomId}/join`, { method: 'POST', body: { name: '阿乙' } });
  assert.equal(joined.status, 200);
  const guest = joined.body;
  await acceptedAction(host, { kind: 'start-game' });
  await acceptedAction(host, { kind: 'setup', noClues: true });
  const ready = await acceptedAction(guest, { kind: 'setup', noClues: true });
  assert.equal(ready.view.phase, 'play');
  return { host, guest };
}

async function fetchViews(players) {
  return Promise.all(players.map(async (player) => {
    const response = await api(`/api/rooms/${player.roomId}/view`, { token: player.token });
    assert.equal(response.status, 200);
    return response.body.view;
  }));
}

function revealedBoard(modeId = 'standard') {
  const objects = [Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY];
  if (modeId === 'expert') objects.push(Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.EMPTY, Obj.EMPTY);
  return objects;
}

function frozenState(view) {
  return {
    pawns: view.players.map((player) => ({ id: player.id, time: player.time, sector: player.sector })),
    windowTime: view.windowTime,
    windowOffset: view.windowOffset,
    visibleStart: view.visibleStart,
    visible: view.visible,
    arrowSector: view.arrowSector,
    events: view.events,
  };
}

function assertLocatePrivacy(view, guesses, revealed = false) {
  const cells = view.rounds.flatMap((round) => Object.values(round.cells).flat());
  for (const guess of guesses) {
    const visible = revealed || view.me === guess.actorId;
    for (const entries of [view.entries, view.log]) {
      const entry = entries.find((record) => record.id === guess.id);
      assert.ok(entry);
      assert.equal(entry.type, 'located');
      assert.equal(entry.correct, guess.correct);
      assert.equal(entry.cost, guess.cost);
      for (const field of ['sector', 'left', 'right']) {
        assert.equal(Object.hasOwn(entry, field), visible, `${field} visibility for ${guess.actorId}`);
        if (visible) assert.equal(entry[field], guess[field]);
      }
    }
    const cell = cells.find((record) => record.id === guess.id);
    assert.ok(cell);
    assert.equal(cell.op, visible ? `定位 X行星 ${guess.sector + 1} 号` : '定位 X行星（扇区保密）');
    assert.equal(cell.result, guess.correct ? 'app 判定：正确' : 'app 判定：错误');
  }
  const normalLocate = guesses.findLast((guess) => guess.cost === 5);
  if (normalLocate) {
    const visible = revealed || view.me === normalLocate.actorId;
    for (const locate of [view.locate, view.summary.locate]) {
      assert.ok(locate);
      assert.equal(locate.correct, normalLocate.correct);
      for (const field of ['sector', 'left', 'right']) {
        assert.equal(Object.hasOwn(locate, field), visible, `summary ${field} visibility`);
        if (visible) assert.equal(locate[field], normalLocate[field]);
      }
    }
  }
}

async function openViewStream(context, player) {
  const controller = new AbortController();
  context.after(() => controller.abort());
  const response = await fetch(`${base}/api/rooms/${player.roomId}/stream?token=${encodeURIComponent(player.token)}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    close: () => controller.abort(),
    async nextEvent() {
      let timer;
      const readEvent = async () => {
        while (true) {
          const boundary = buffer.indexOf('\n\n');
          if (boundary >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = frame.match(/^event: (.*)$/m)?.[1];
            const data = frame.match(/^data: (.*)$/m)?.[1];
            if (event && data) return { event, data: JSON.parse(data) };
            continue;
          }
          const { value, done } = await reader.read();
          assert.equal(done, false, 'the SSE connection closed before a view arrived');
          buffer += decoder.decode(value, { stream: true });
        }
      };
      try {
        return await Promise.race([
          readEvent(),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('timed out waiting for a room SSE event'));
              controller.abort();
            }, 4000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

test('static files are still served', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /X行星之谜/);
});

test('a room can be created, joined and played over HTTP', async () => {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '阿甲', initialClueCount: 4 } });
  const initialClues = [{ sector: 1, type: Obj.COMET }, { sector: 0, type: Obj.GAS_CLOUD }, { sector: 3, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }];
  assert.equal(created.status, 200);
  const { roomId, token } = created.body;
  assert.match(roomId, /^[A-Z0-9]{6}$/);
  assert.ok(token);
  assert.equal(created.body.view.me, created.body.playerId);
  assert.equal(created.body.view.players.length, 1);
  assert.equal(created.body.view.phase, 'lobby');
  assert.equal(created.body.view.canStart, false, 'a lone host cannot start');

  const joined = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { name: '阿乙' } });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.view.players.length, 2);
  const guest = joined.body;

  const spectatorJoin = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { name: '观众', spectator: true } });
  assert.equal(spectatorJoin.status, 200);
  assert.equal(spectatorJoin.body.view.amSpectator, true);
  assert.equal(spectatorJoin.body.view.playerCount, 2);
  assert.equal(spectatorJoin.body.view.spectatorCount, 1);

  // the game only opens once the host starts it and everybody fills their card
  const early = await api(`/api/rooms/${roomId}/action`, { method: 'POST', token, body: { action: { kind: 'wait' } } });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /还没开始/);

  const started = await api(`/api/rooms/${roomId}/action`, { method: 'POST', token, body: { action: { kind: 'start-game' } } });
  assert.equal(started.body.ok, true);
  assert.equal(started.body.view.phase, 'setup');
  assert.equal(started.body.view.canStart, false);
  assert.equal(started.body.view.playerCount, 2);

  const hostCard = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token,
    body: { action: { kind: 'setup', clues: initialClues, topics: { A: '小行星带', B: '课题B', C: '课题C', D: '课题D', E: '课题E', F: '课题F' }, conferenceNames: { 10: '彗星邻居' } } },
  });
  assert.equal(hostCard.body.ok, true);
  assert.equal(hostCard.body.view.phase, 'setup', 'still waiting for the seated guest, not the spectator');

  const spectatorAct = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: spectatorJoin.body.token,
    body: { action: { kind: 'setup', noClues: true } },
  });
  assert.equal(spectatorAct.status, 400);
  assert.match(spectatorAct.body.error, /观战/);

  const guestCard = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: guest.token,
    body: { action: { kind: 'setup', clues: initialClues } },
  });
  assert.equal(guestCard.body.ok, true);
  assert.equal(guestCard.body.view.phase, 'play');

  const surveyed = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token,
    body: { action: { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 3, count: 2 } },
  });
  assert.equal(surveyed.body.ok, true);
  const spectatorView = await api(`/api/rooms/${roomId}/view?token=${encodeURIComponent(spectatorJoin.body.token)}`);
  const guestView = await api(`/api/rooms/${roomId}/view?token=${encodeURIComponent(guest.token)}`);
  const surveyForSpectator = spectatorView.body.view.entries.find((entry) => entry.type === 'survey');
  const surveyForGuest = guestView.body.view.entries.find((entry) => entry.type === 'survey');
  assert.equal(surveyForSpectator.count, 2);
  assert.equal(surveyForGuest.count, undefined);
});

test('HTTP room create join play continues with subject names after spectator coverage', async () => {
  // Keep the remainder of the original end-to-end flow focused on seated play.
  const created = await api('/api/rooms', { method: 'POST', body: { name: '阿甲', initialClueCount: 4 } });
  const initialClues = [{ sector: 1, type: Obj.COMET }, { sector: 0, type: Obj.GAS_CLOUD }, { sector: 3, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }];
  assert.equal(created.status, 200);
  const { roomId, token } = created.body;
  const joined = await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { name: '阿乙' } });
  assert.equal(joined.status, 200);
  const guest = joined.body;
  await api(`/api/rooms/${roomId}/action`, { method: 'POST', token, body: { action: { kind: 'start-game' } } });
  const hostCard = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token,
    body: { action: { kind: 'setup', clues: initialClues, topics: { A: '小行星带', B: '课题B', C: '课题C', D: '课题D', E: '课题E', F: '课题F' }, conferenceNames: { 10: '彗星邻居' } } },
  });
  assert.equal(hostCard.body.ok, true);
  assert.deepEqual(hostCard.body.view.mySetup.clues, initialClues, 'my own initial clues come back');
  const guestCard = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: guest.token,
    body: { action: { kind: 'setup', clues: initialClues.map((clue) => ({ ...clue, type: Obj.GAS_CLOUD })), topics: {} } },
  });
  assert.equal(guestCard.body.ok, true);
  assert.equal(guestCard.body.view.phase, 'play', 'everybody ready -> first round');
  assert.equal(guestCard.body.view.turnPlayerId, created.body.playerId, 'the host opens');
  const guestSetupView = await api(`/api/rooms/${roomId}/view`, { token: guest.token });
  assert.equal(guestSetupView.body.view.mySetup.clues.length, 4, 'the guest uses the same host-selected count');
  assert.equal(guestSetupView.body.view.players[0].ready, true, 'readiness is public');

  // turns: the guest cannot act first
  const outOfTurn = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: guest.token,
    body: { action: { kind: 'wait' } },
  });
  assert.equal(outOfTurn.status, 400);
  assert.match(outOfTurn.body.error, /轮到/);

  // a body token works exactly like a header token
  const viaBody = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    body: { token, action: { kind: 'wait' } },
  });
  assert.equal(viaBody.status, 200, 'a body token is accepted like a header token');
  assert.equal(viaBody.body.view.time, 1);
  assert.equal(viaBody.body.entry.actorId, created.body.playerId, 'the entry is stamped with who did it');
  assert.equal(viaBody.body.view.turnPlayerId, guest.playerId, 'and the turn passed to the guest');

  // the guest surveys: the number stays with the guest, and only their pawn moves
  const survey = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: guest.token,
    body: { action: { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 6, count: 3 } },
  });
  assert.equal(survey.status, 200);
  assert.equal(survey.body.ok, true);
  assert.equal(survey.body.view.time, 3, 'three months on the guest’s own pawn');

  const hostView = await api(`/api/rooms/${roomId}/view`, { token });
  assert.equal(hostView.body.view.time, 1, 'the host only paid for their own wait');
  assert.deepEqual(
    hostView.body.view.players.map((p) => p.time),
    [1, 3],
    'each player has their own pawn on the time track',
  );
  assert.equal(hostView.body.view.knowledge.surveys.length, 1, 'and that a survey happened');
  assert.equal(hostView.body.view.knowledge.surveys[0].count, undefined, 'but not the guest’s result');
  assert.equal(survey.body.view.knowledge.surveys[0].count, 3, 'the guest keeps their own result');

  // a bad token is refused
  const nope = await api(`/api/rooms/${roomId}/view`, { token: 'stolen' });
  assert.equal(nope.status, 403);

  // unknown rooms are reported as such
  const missing = await api('/api/rooms/ZZZ999/view', { token });
  assert.equal(missing.status, 404);

  // the shared window follows the pawn furthest behind, so it only moves when that one does
  const step = async (who, action) =>
    (await api(`/api/rooms/${roomId}/action`, { method: 'POST', token: who, body: { action } })).body;
  const before = (await api(`/api/rooms/${roomId}/view`, { token })).body.view;
  assert.equal(before.research, null, 'the guest running ahead did not move the window');
  assert.equal(before.arrowSector, 2, 'the window still sits at the host’s month 1');
  assert.equal(before.windowPlayerId, created.body.playerId);

  const hostWait = await step(token, { kind: 'wait' }); // host 1 -> 2, which lifts the window
  assert.equal(hostWait.ok, true);
  assert.equal(hostWait.view.research, null, 'entering sector 3 does not open a phase');
  const departed = await step(token, { kind: 'wait' });
  assert.equal(departed.view.research.sector, 3, 'leaving sector 3 opens the phase');
  assert.equal(departed.view.research.quota, 1, 'a standard board allows one paper per player');
  const phaseId = departed.view.research.id;
  assert.equal(phaseId, 'theory:3');

  assert.equal((await step(token, { kind: 'research-declare', phaseId, count: 1 })).ok, true);
  assert.equal((await step(guest.token, { kind: 'research-declare', phaseId, count: 1 })).ok, true);
  const ordered = (await api(`/api/rooms/${roomId}/view`, { token })).body.view.research;
  assert.deepEqual(ordered.orderNames, ['阿乙', '阿甲'], 'at equal time the earlier-arriving guest is behind and publishes first');

  const first = await step(guest.token, { kind: 'research-submit', phaseId, sector: 1, objectType: Obj.COMET });
  assert.equal(first.ok, true);
  const second = await step(token, { kind: 'research-submit', phaseId, sector: 3, objectType: Obj.GAS_CLOUD });
  assert.equal(second.ok, true);
  assert.equal(second.view.research, null, 'the phase closes after everybody published');
  assert.deepEqual(second.view.knowledge.theories.map((t) => t.slot).sort(), [3, 3], 'one phase -> one track space');
  assert.equal(second.view.knowledge.theories[0].objectType, undefined, 'and the objects stay private');
  assert.equal(second.view.arrowSector, 4, 'the shared window has left sector 3');
  assert.equal(second.view.windowPlayerId, guest.playerId, 'and follows the earlier arrival behind the host');
});

test('HTTP rejects missing and replayed declarations when a zero-submission phase opens the next queued event', async () => {
  const { host, guest } = await playingTable();
  const players = [host, guest];
  for (const player of players) await acceptedAction(player, { kind: 'wait' });
  for (const player of players) await acceptedAction(player, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: false });
  const firstViews = await fetchViews(players);
  const firstPhaseId = firstViews[0].research.id;
  assert.equal(firstPhaseId, 'theory:3');
  assert.equal(firstViews[1].research.id, firstPhaseId);
  assert.equal(firstViews[0].research.sector, 3);
  assert.equal(firstViews[0].windowTime, 6);
  const frozen = frozenState(firstViews[0]);
  for (const player of players) {
    const missing = await roomAction(player, { kind: 'research-declare', count: 0 });
    assert.equal(missing.status, 400, 'a declaration without its displayed phase id is rejected');
    assert.equal(missing.body.ok, false);
    assert.deepEqual(missing.body.view, firstViews[players.indexOf(player)]);
    assert.deepEqual(await fetchViews(players), firstViews);
  }
  const oldDeclaration = { kind: 'research-declare', phaseId: firstPhaseId, count: 0 };
  await acceptedAction(host, oldDeclaration);
  await acceptedAction(guest, oldDeclaration);
  const nextViews = await fetchViews(players);
  const nextPhaseId = nextViews[0].research.id;
  assert.equal(nextPhaseId, 'theory:6');
  assert.notEqual(nextPhaseId, firstPhaseId, 'queued empty phases have distinct ids without another log entry');
  assert.equal(nextViews[1].research.id, nextPhaseId);
  assert.equal(nextViews[0].research.sector, 6);
  assert.equal(nextViews[0].research.declaredCount, 0);
  assert.equal(nextViews[0].recordCount, firstViews[0].recordCount);
  assert.deepEqual(frozenState(nextViews[0]), frozen);
  for (const player of players) {
    for (const action of [oldDeclaration, { kind: 'research-declare', count: 0 }]) {
      const replay = await roomAction(player, action);
      assert.equal(replay.status, 400);
      assert.equal(replay.body.ok, false);
      assert.deepEqual(replay.body.view, nextViews[players.indexOf(player)], 'a replay must not declare for the new phase');
      assert.deepEqual(await fetchViews(players), nextViews);
    }
  }
  const currentDeclaration = { kind: 'research-declare', phaseId: nextPhaseId, count: 0 };
  await acceptedAction(host, currentDeclaration);
  const closed = await acceptedAction(guest, currentDeclaration);
  assert.equal(closed.view.research, null);
  assert.equal(closed.view.knowledge.theories.length, 0);
  assert.deepEqual(frozenState(closed.view), frozen);
  for (const action of [oldDeclaration, currentDeclaration]) {
    const replay = await roomAction(guest, action);
    assert.equal(replay.status, 400);
    assert.deepEqual(replay.body.view, closed.view, 'a closed phase cannot be reopened by a declaration');
  }
  const resumed = await acceptedAction(host, { kind: 'wait' });
  assert.equal(resumed.view.phase, 'play');
  assert.deepEqual(resumed.view.players.map((player) => player.time), [7, 6]);
});

test('HTTP rejects stale and missing submission ids without spending the current publication quota', async () => {
  const { host, guest } = await playingTable();
  const players = [host, guest];
  for (const player of players) await acceptedAction(player, { kind: 'wait' });
  for (const player of players) await acceptedAction(player, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: false });
  const firstViews = await fetchViews(players);
  const firstPhaseId = firstViews[0].research.id;
  assert.equal(firstPhaseId, 'theory:3');
  await acceptedAction(host, { kind: 'research-declare', phaseId: firstPhaseId, count: 1 });
  const firstDeclared = await acceptedAction(guest, { kind: 'research-declare', phaseId: firstPhaseId, count: 0 });
  assert.equal(firstDeclared.view.research.cursorId, host.playerId);
  const delayedSubmission = { kind: 'research-submit', phaseId: firstPhaseId, sector: 1, objectType: Obj.COMET };
  const skipped = await acceptedAction(host, { kind: 'skip-turn' });
  const currentPhaseId = skipped.view.research.id;
  assert.equal(currentPhaseId, 'theory:6');
  assert.equal(skipped.view.knowledge.theories.length, 0, 'the delayed claim has never been published, so duplicate-claim checks cannot mask a stale id');
  assert.equal(skipped.view.recordCount, firstViews[0].recordCount);
  await acceptedAction(host, { kind: 'research-declare', phaseId: currentPhaseId, count: 1 });
  await acceptedAction(guest, { kind: 'research-declare', phaseId: currentPhaseId, count: 0 });
  const before = await fetchViews(players);
  assert.equal(before[0].research.cursorId, host.playerId);
  assert.equal(before[0].research.left, 1);
  assert.equal(before[0].research.isMyPick, true);
  for (const action of [
    delayedSubmission,
    { kind: 'research-submit', sector: 1, objectType: Obj.COMET },
    { kind: 'theory', phaseId: firstPhaseId, sector: 1, type: Obj.COMET },
    { kind: 'theory', sector: 1, type: Obj.COMET },
  ]) {
    const refused = await roomAction(host, action);
    assert.equal(refused.status, 400, action.kind);
    assert.equal(refused.body.ok, false);
    assert.deepEqual(refused.body.view, before[0], 'the current publisher keeps their quota and cursor after a stale request');
    assert.deepEqual(await fetchViews(players), before);
  }
  const published = await acceptedAction(host, { ...delayedSubmission, phaseId: currentPhaseId });
  assert.equal(published.view.research, null);
  assert.equal(published.view.knowledge.theories.length, 1);
  const paper = published.view.knowledge.theories[0];
  assert.equal(paper.id, before[0].entries.at(-1).id + 1, 'rejected submissions do not consume entry ids');
  assert.equal(paper.publicationPhase, currentPhaseId);
  assert.equal(paper.sector, delayedSubmission.sector);
  assert.equal(paper.objectType, delayedSubmission.objectType);
  assert.equal(paper.slot, 3);
  assert.equal(paper.cost, 0);
  assert.deepEqual(frozenState(published.view), frozenState(before[0]));
  const guestView = (await fetchViews([guest]))[0];
  assert.equal(Object.hasOwn(guestView.knowledge.theories[0], 'objectType'), false);
});

test('the host picks the board when the room is created', async () => {
  const modes = await api('/api/modes');
  assert.deepEqual(modes.body.modes.map((m) => m.id), ['standard', 'expert']);

  const expert = await api('/api/rooms', { method: 'POST', body: { name: '专家', modeId: 'expert' } });
  assert.equal(expert.body.view.modeId, 'expert');
  assert.equal(expert.body.view.mode.sectors, 18, '18 sectors, 9 visible');
  assert.equal(expert.body.view.mode.visible, 9);
  assert.deepEqual(expert.body.view.conferenceSectors, [7, 16]);

  const fallback = await api('/api/rooms', { method: 'POST', body: { name: '随便', modeId: 'nope' } });
  assert.equal(fallback.body.view.modeId, 'standard', 'an unknown board falls back instead of failing');

  const standard = await api('/api/rooms', { method: 'POST', body: { name: '标准' } });
  assert.equal(standard.body.view.mode.sectors, 12);
  assert.deepEqual(standard.body.view.conferenceSectors, [10]);
  assert.deepEqual(standard.body.view.theorySectors, [3, 6, 9, 12]);
});

test('the SSE stream pushes the shared state to every player', async (context) => {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '观测者', initialClueCount: 0 } });
  const { roomId, token } = created.body;
  const guest = (await api(`/api/rooms/${roomId}/join`, { method: 'POST', body: { name: '同行者' } })).body;
  await api(`/api/rooms/${roomId}/action`, { method: 'POST', token, body: { action: { kind: 'start-game' } } });
  const hostReady = await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token,
    body: { action: { kind: 'setup', noClues: true, topics: { A: '课题A', B: '课题B', C: '课题C', D: '课题D', E: '课题E', F: '课题F' }, conferenceNames: { 10: '彗星邻居' } } },
  });
  assert.equal(hostReady.body.ok, true, hostReady.body.error);
  await api(`/api/rooms/${roomId}/action`, {
    method: 'POST',
    token: guest.token,
    body: { action: { kind: 'setup', noClues: true } },
  });

  const stream = await openViewStream(context, created.body);
  const hello = await stream.nextEvent();
  assert.equal(hello.event, 'view');
  assert.equal(hello.data.view.roomId, roomId);
  assert.equal(hello.data.view.time, 0);

  await api(`/api/rooms/${roomId}/action`, { method: 'POST', token, body: { action: { kind: 'wait' } } });
  const push = await stream.nextEvent();
  assert.equal(push.event, 'view');
  assert.equal(push.data.view.time, 1, 'the stream carried the new shared state');
  assert.equal(push.data.view.me, created.body.playerId, 'and it is redacted for this player');

  stream.close();
});

test('two SSE clients keep all locate fields private through final choices and frozen-clock reveal', async (context) => {
  const { host, guest } = await playingTable();
  const players = [host, guest];
  const streams = await Promise.all(players.map((player) => openViewStream(context, player)));
  const initial = await Promise.all(streams.map((stream) => stream.nextEvent()));
  for (const [index, event] of initial.entries()) {
    assert.equal(event.event, 'view');
    assert.equal(event.data.notice.kind, 'hello');
    assert.equal(event.data.view.me, players[index].playerId);
    assert.equal(event.data.view.time, 0);
  }
  const guesses = [];
  let views = initial.map((event) => event.data.view);
  const pushAction = async (player, action, locateCost) => {
    const response = await acceptedAction(player, action);
    if (action.kind === 'locate') {
      assert.deepEqual(Object.keys(response.entry).sort(), ['actorId', 'id', 'type'], 'the action envelope contains no guess');
      guesses.push({ ...action, id: response.entry.id, actorId: player.playerId, cost: locateCost });
    }
    const events = await Promise.all(streams.map((stream) => stream.nextEvent()));
    views = events.map((event) => event.data.view);
    for (const [index, event] of events.entries()) {
      assert.equal(event.event, 'view');
      assert.equal(event.data.notice.kind, 'action');
      assert.equal(event.data.notice.action, action.kind);
      assert.equal(event.data.view.me, players[index].playerId);
      assertLocatePrivacy(event.data.view, guesses, action.kind === 'reveal-objects');
    }
    assert.deepEqual(views, await fetchViews(players), 'both SSE snapshots match their own HTTP views');
    assert.deepEqual(response.view, views[players.indexOf(player)]);
    return response;
  };

  await pushAction(host, { kind: 'research', topic: 'A', text: '甲的线索' });
  await pushAction(guest, { kind: 'locate', sector: 8, left: Obj.GAS_CLOUD, right: Obj.DWARF_PLANET, correct: false }, 5);
  assert.equal(views[0].phase, 'play');
  assert.equal(views[1].status, 'open');
  assert.deepEqual(views[0].players.map((player) => player.time), [1, 5]);
  assert.equal(views[0].scores.firstFinderId, null, 'a failed locate does not become the first finder');
  await pushAction(host, { kind: 'wait' });
  assert.equal(views[0].research, null);
  await pushAction(host, { kind: 'wait' });
  assert.equal(views[0].research.sector, 3);
  const phaseId = views[0].research.id;
  assert.equal(phaseId, 'theory:3');
  assert.equal(views[1].research.id, phaseId, 'both SSE clients receive the same phase identity');
  for (const player of players) await pushAction(player, { kind: 'research-declare', phaseId, count: 1 });
  const firstPaper = await pushAction(host, { kind: 'research-submit', phaseId, sector: 3, objectType: Obj.ASTEROID });
  await pushAction(guest, { kind: 'research-submit', phaseId, sector: 10, objectType: Obj.COMET });
  const beforeLocate = frozenState(views[0]);
  assert.equal(beforeLocate.windowTime, 3);
  assert.deepEqual(beforeLocate.pawns.map((player) => player.time), [3, 5]);
  const answer = { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true };
  for (const invalid of [
    { ...answer, left: Obj.PLANET_X },
    { ...answer, right: 'invalid' },
    { ...answer, correct: 'false' },
    { ...answer, correct: null },
    { ...answer, correct: 1 },
    { ...answer, sector: 12 },
  ]) {
    const refused = await roomAction(host, invalid);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.ok, false);
    assert.deepEqual(refused.body.view, views[0], 'invalid guesses do not pay time or alter the phase');
  }
  await pushAction(host, answer, 5);
  assert.equal(views[0].phase, 'final');
  assert.equal(views[1].status, 'final');
  assert.deepEqual(views[0].players.map((player) => player.time), [8, 5]);
  assert.equal(views[1].endgame.firstFinderId, host.playerId);
  assert.equal(views[1].endgame.firstFinderName, '阿甲');
  assert.equal(views[1].endgame.cursorId, guest.playerId);
  assert.equal(views[1].endgame.cursorName, '阿乙');
  assert.equal(views[1].endgame.isMyTurn, true);
  assert.equal(views[1].endgame.behind, 3);
  assert.equal(views[1].endgame.quota, 1);
  assert.equal(views[1].endgame.canReveal, false);
  assert.equal(views[0].endgame.isMyTurn, false);
  const frozen = frozenState(views[0]);
  assert.deepEqual({ ...frozen, pawns: beforeLocate.pawns }, beforeLocate, 'the sky freezes before the successful locate pays five');
  for (const view of views) {
    assert.equal(view.research, null, 'the successful locate does not open a crossed theory phase');
    assert.equal(view.revealedObjects, null);
    assert.equal(view.turnPlayerId, null);
    assert.equal(view.scores.finished, false);
    assert.deepEqual(view.knowledge.theories.map((paper) => paper.slot), [3, 3]);
    assert.deepEqual(frozenState(view), frozen);
  }
  for (const [player, action] of [
    [host, { kind: 'final-pass' }],
    [guest, { kind: 'wait' }],
    [guest, { ...answer, correct: 'true' }],
    [guest, { ...answer, right: Obj.PLANET_X }],
    [host, { kind: 'reveal-objects', objects: revealedBoard() }],
  ]) {
    const refused = await roomAction(player, action);
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.view, views[players.indexOf(player)]);
  }
  await pushAction(guest, answer, 0);
  for (const view of views) {
    assert.equal(view.phase, 'reveal');
    assert.equal(view.status, 'reveal');
    assert.equal(view.revealedObjects, null);
    assert.equal(view.endgame.cursorId, null);
    assert.deepEqual(view.endgame.players, [{ id: guest.playerId, name: '阿乙', behind: 3, quota: 1, done: true, choice: 'locate' }]);
    assert.deepEqual(frozenState(view), frozen);
    assert.deepEqual(view.scores.rows.map((row) => row.locatePoints), [10, 6]);
  }
  assert.equal(views[0].endgame.canReveal, true);
  assert.equal(views[1].endgame.canReveal, false);
  const guestReveal = await roomAction(guest, { kind: 'reveal-objects', objects: revealedBoard() });
  assert.equal(guestReveal.status, 400);
  assert.deepEqual(guestReveal.body.view, views[1]);
  const summary = await api(`/api/rooms/${host.roomId}/summary`, { token: guest.token });
  assert.equal(summary.status, 200);
  assert.doesNotMatch(JSON.stringify(summary.body), /"(?:sector|left|right|locate|token)":/);
  await pushAction(host, { kind: 'reveal-objects', objects: revealedBoard() });
  for (const view of views) {
    assert.equal(view.phase, 'done');
    assert.equal(view.status, 'finished');
    assert.equal(view.scores.finished, true);
    assert.equal(view.endgame.canReveal, false);
    assert.deepEqual(view.revealedObjects, revealedBoard());
    assert.deepEqual(frozenState(view), frozen);
    assert.deepEqual(view.knowledge.theories.map((paper) => paper.review), ['correct', 'wrong']);
    assert.equal(view.entries.some((entry) => entry.type === 'penalty'), false, 'final paper review never adds penalties');
    assert.deepEqual(view.scores.rows.map((row) => row.total), [13, 6]);
  }
  for (const player of players) {
    for (const action of [
      { kind: 'wait' }, answer, { kind: 'final-pass' }, { kind: 'final-theories', theories: [] },
      { kind: 'review', id: firstPaper.entry.id, review: 'wrong' }, { kind: 'skip-turn' },
      { kind: 'nudge', delta: 1 }, { kind: 'undo' }, { kind: 'reveal-objects', objects: revealedBoard() },
    ]) {
      const refused = await roomAction(player, action);
      assert.equal(refused.status, 400, action.kind);
      assert.equal(refused.body.ok, false);
      assert.match(refused.body.error, /已结束/);
      assert.deepEqual(refused.body.view, views[players.indexOf(player)]);
    }
  }
  assert.deepEqual(await fetchViews(players), views);
});

for (const modeId of ['standard', 'expert']) {
  test(`${modeId}: HTTP final theory batches and host-only object reveal validate atomically`, async () => {
    const { host, guest } = await playingTable(modeId);
    const players = [host, guest];
    await acceptedAction(host, { kind: 'research', topic: 'A', text: '甲的线索' });
    await acceptedAction(guest, { kind: 'target', sector: 2, apparent: Obj.COMET });
    const entered = await acceptedAction(host, { kind: 'wait' });
    assert.equal(entered.view.research, null);
    const opened = await acceptedAction(host, { kind: 'wait' });
    const phaseId = opened.view.research.id;
    assert.equal(phaseId, 'theory:3');
    for (const player of players) await acceptedAction(player, { kind: 'research-declare', phaseId, count: 1 });
    await acceptedAction(host, { kind: 'research-submit', phaseId, sector: 3, objectType: Obj.ASTEROID });
    await acceptedAction(guest, { kind: 'research-submit', phaseId, sector: 10, objectType: Obj.COMET });
    const located = await acceptedAction(host, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true });
    const beforeBatch = await fetchViews(players);
    const frozen = frozenState(located.view);
    assert.equal(located.view.phase, 'final');
    assert.equal(frozen.windowTime, 3);
    assert.deepEqual(frozen.pawns.map((player) => player.time), [8, 4]);
    assert.equal(beforeBatch[1].endgame.behind, 4);
    assert.equal(beforeBatch[1].endgame.quota, 2);
    const validPaper = { sector: 1, objectType: Obj.COMET };
    for (const theories of [
      null,
      [validPaper, { sector: 4, objectType: Obj.ASTEROID }, { sector: 5, objectType: Obj.GAS_CLOUD }],
      [validPaper, null],
      [validPaper, { sector: located.view.mode.sectors, objectType: Obj.COMET }],
      [validPaper, { sector: 2, objectType: Obj.EMPTY }],
      [validPaper, { sector: 0, objectType: Obj.COMET }],
      [validPaper, validPaper],
      [validPaper, { sector: 1, objectType: Obj.ASTEROID }],
      [validPaper, { sector: 10, objectType: Obj.COMET }],
    ]) {
      const refused = await roomAction(guest, { kind: 'final-theories', theories });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.ok, false);
      assert.deepEqual(refused.body.view, beforeBatch[1], 'a bad second paper cannot publish the first or consume the choice');
      assert.deepEqual(await fetchViews(players), beforeBatch);
    }
    const papers = [validPaper, { sector: 4, objectType: Obj.COMET }];
    const published = await acceptedAction(guest, { kind: 'final-theories', theories: papers });
    assert.equal(published.view.phase, 'reveal');
    assert.equal(published.view.status, 'reveal');
    assert.equal(published.view.endgame.players[0].choice, 'final-theories');
    assert.equal(published.view.endgame.players[0].done, true);
    const finalPapers = published.view.knowledge.theories.slice(-2);
    const previousId = beforeBatch[1].entries.at(-1).id;
    assert.deepEqual(finalPapers.map((paper) => paper.id), [previousId + 1, previousId + 2], 'failed batches do not consume ids');
    assert.deepEqual(finalPapers.map((paper) => ({ sector: paper.sector, objectType: paper.objectType })), papers);
    assert.deepEqual(finalPapers.map((paper) => paper.cost), [0, 0]);
    assert.ok(finalPapers[0].publicationPhase);
    assert.equal(finalPapers[0].publicationPhase, finalPapers[1].publicationPhase);
    const beforeReveal = await fetchViews(players);
    for (const view of beforeReveal) {
      assert.deepEqual(frozenState(view), frozen);
      assert.deepEqual(view.knowledge.theories.map((paper) => paper.slot), [3, 3, 4, 4]);
      assert.equal(view.knowledge.theories.every((paper) => paper.review === 'pending' && paper.revealed === false), true);
      assert.deepEqual(view.scores.rows.map((row) => row.theoryPoints), [0, 0]);
    }
    assert.equal(beforeReveal[0].knowledge.theories.slice(-2).every((paper) => !Object.hasOwn(paper, 'objectType')), true);
    const objects = revealedBoard(modeId);
    const guestReveal = await roomAction(guest, { kind: 'reveal-objects', objects });
    assert.equal(guestReveal.status, 400);
    assert.deepEqual(guestReveal.body.view, beforeReveal[1]);
    for (const invalid of [
      objects.slice(0, -1), [...objects, Obj.EMPTY], objects.with(objects.length - 1, 'invalid'),
      objects.with(0, Obj.EMPTY), objects.with(objects.length - 1, Obj.PLANET_X),
    ]) {
      const refused = await roomAction(host, { kind: 'reveal-objects', objects: invalid });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.ok, false);
      assert.deepEqual(refused.body.view, beforeReveal[0], 'invalid boards cannot partially reveal or score papers');
      assert.deepEqual(await fetchViews(players), beforeReveal);
    }
    const finished = await acceptedAction(host, { kind: 'reveal-objects', objects });
    assert.equal(finished.view.phase, 'done');
    const completed = await fetchViews(players);
    for (const view of completed) {
      assert.equal(view.status, 'finished');
      assert.equal(view.scores.finished, true);
      assert.deepEqual(view.revealedObjects, objects);
      assert.deepEqual(frozenState(view), frozen);
      assert.equal(view.recordCount, beforeReveal[0].recordCount);
      assert.equal(view.entries.some((entry) => entry.type === 'penalty'), false);
      assert.equal(view.knowledge.theories.every((paper) => paper.revealed && paper.finalReview), true);
      assert.deepEqual(view.knowledge.theories.map((paper) => paper.review), ['correct', 'wrong', 'correct', 'wrong']);
      assert.deepEqual(view.knowledge.theories.map((paper) => paper.objectType), [Obj.ASTEROID, Obj.COMET, Obj.COMET, Obj.COMET]);
      assert.deepEqual(view.scores.rows.map((row) => row.total), [13, 4]);
    }
    const repeated = await roomAction(guest, { kind: 'final-theories', theories: papers });
    assert.equal(repeated.status, 400);
    assert.deepEqual(repeated.body.view, completed[1]);
  });
}

test('GET archive exports the room and POST restore rehydrates a missing room', async () => {
  const created = await api('/api/rooms', { method: 'POST', body: { name: '存档甲', playMode: 'record', initialClueCount: 0 } });
  assert.equal(created.status, 200);
  const host = created.body;
  const guest = (await api(`/api/rooms/${host.roomId}/join`, { method: 'POST', body: { name: '存档乙' } })).body;
  await acceptedAction(host, { kind: 'start-game' });
  for (const player of [host, guest]) {
    await acceptedAction(player, { kind: 'setup', noClues: true });
  }
  await acceptedAction(host, { kind: 'wait' });

  const archive = await api(`/api/rooms/${host.roomId}/archive`, { token: host.token });
  assert.equal(archive.status, 200);
  assert.equal(archive.body.room.id, host.roomId);
  assert.equal(archive.body.room.phase, 'play');
  assert.ok(archive.body.room.players.every((player) => player.token));
  assert.equal(JSON.stringify(archive.body).includes('"listeners"'), false);

  const denied = await api(`/api/rooms/${host.roomId}/archive`);
  assert.equal(denied.status, 403);

  rooms.delete(host.roomId);
  assert.equal(rooms.has(host.roomId), false);

  const restored = await api('/api/rooms/restore', { method: 'POST', body: { room: archive.body.room } });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.restored, true);
  assert.equal(restored.body.roomId, host.roomId);
  assert.ok(rooms.has(host.roomId));

  const again = await api('/api/rooms/restore', { method: 'POST', body: { room: archive.body.room } });
  assert.equal(again.status, 200);
  assert.equal(again.body.restored, false);

  const view = await api(`/api/rooms/${host.roomId}/view`, { token: guest.token });
  assert.equal(view.status, 200);
  assert.equal(view.body.view.me, guest.playerId);
  assert.equal(view.body.view.phase, 'play');
  assert.ok(view.body.view.recordCount >= 1);
});

test('record rooms reject withBots and restored record seats lose the bot flag', async () => {
  const rejected = await api('/api/rooms', { method: 'POST', body: { name: '记录', playMode: 'record', initialClueCount: 0, withBots: 1 } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /内置谜题/);

  const created = await api('/api/rooms', { method: 'POST', body: { name: '记录', playMode: 'record', initialClueCount: 0 } });
  assert.equal(created.status, 200);
  const archive = await api(`/api/rooms/${created.body.roomId}/archive`, { token: created.body.token });
  archive.body.room.players[0].bot = true;
  rooms.delete(created.body.roomId);
  const restored = await api('/api/rooms/restore', { method: 'POST', body: { room: archive.body.room } });
  assert.equal(restored.status, 200);
  const room = rooms.get(created.body.roomId);
  assert.equal(room.playMode, 'record');
  assert.equal(room.players.every((player) => !player.bot), true);
  assert.equal(room.__botController, undefined);
});

test('builtin withBots creates bot seats and SSE receives bot actions', async (context) => {
  const previousTick = process.env.BOT_TICK_MS;
  process.env.BOT_TICK_MS = '40';
  try {
    const modes = await api('/api/modes');
    assert.equal(modes.status, 200);
    assert.equal(modes.body.withBots.max, 3);
    const created = await api('/api/rooms', {
      method: 'POST',
      body: { name: '人类', playMode: 'builtin', modeId: 'standard', initialClueCount: 4, withBots: 1 },
    });
    assert.equal(created.status, 200, created.body.error);
    const host = created.body;
    const room = rooms.get(host.roomId);
    assert.equal(room.players.filter((player) => player.bot).length, 1);
    assert.ok(room.__botController);
    assert.equal(host.view.players.filter((player) => player.bot).length, 1);

    await acceptedAction(host, { kind: 'start-game' });
    await acceptedAction(host, { kind: 'claim-initial-clues', count: 4 });
    await acceptedAction(host, { kind: 'setup' });
    for (let i = 0; i < 40 && room.phase === 'setup'; i++) {
      const bot = room.players.find((player) => player.bot);
      if (bot && !room.setup[bot.id]?.ready) applyRoomAction(room, bot.id, { kind: 'setup' });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(room.phase, 'play');

    const stream = await openViewStream(context, host);
    await stream.nextEvent();
    const beforeRevision = room.revision || 0;
    for (let guard = 0; guard < 40; guard++) {
      const turn = currentPlayer(room);
      if (turn?.bot) break;
      if (room.research) {
        const phaseId = room.research.id;
        for (const player of room.players) {
          if (!room.research || room.research.id !== phaseId) break;
          if (Object.hasOwn(room.research.declares, player.id)) continue;
          applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 0 });
        }
        continue;
      }
      if (turn?.id === host.playerId) await acceptedAction(host, { kind: 'wait' });
      else await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const pushed = await Promise.race([
      stream.nextEvent(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for bot SSE')), 4000)),
    ]);
    assert.ok(room.revision > beforeRevision, 'bot action should bump revision');
    assert.ok(pushed.data.view, 'SSE should deliver a view after bot action');
    assert.equal(pushed.data.notice?.kind, 'action');
  } finally {
    if (previousTick === undefined) delete process.env.BOT_TICK_MS;
    else process.env.BOT_TICK_MS = previousTick;
  }
});
