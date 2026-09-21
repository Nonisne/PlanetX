import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, rooms } from '../server.mjs';
import { validateBoard } from '../server/puzzles.js';
import { inMemoryFetch } from './server-dispatch.js';

const server = createServer();
const useHttp = process.env.PLANETX_TEST_TRANSPORT === 'http';
if (useHttp) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = useHttp ? `http://127.0.0.1:${server.address().port}` : 'http://in-memory.test';
const fetch = useHttp ? globalThis.fetch : inMemoryFetch(server);
test.after(() => server.close());

async function request(path, body, token) {
  const response = await fetch(`${base}/api${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-room-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

async function create(options = {}) {
  const response = await request('/rooms', { name: '新手', ...options });
  assert.equal(response.status, 200, response.body.error);
  return response.body;
}

const actionFor = (player, action) => request(`/rooms/${player.roomId}/action`, { action }, player.token);

test('capabilities expose both builtin boards, tutorial and strict room clue counts', async () => {
  const modes = await request('/modes');
  assert.deepEqual(modes.body.builtinBoards, ['standard', 'expert']);
  assert.ok(modes.body.playModes.includes('tutorial'));
  assert.deepEqual(modes.body.initialClueCounts, [0, 4, 8, 12]);
  for (const initialClueCount of [null, '4', 1, 13, false]) {
    const before = rooms.size;
    const response = await request('/rooms', { playMode: 'builtin', initialClueCount });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /0、4、8、12/);
    assert.equal(rooms.size, before);
  }
});

test('HTTP enforces a single host-controlled clue count and automatic private distribution', async () => {
  const host = await create({ playMode: 'builtin', initialClueCount: 8 });
  const joined = await request(`/rooms/${host.roomId}/join`, { name: '来宾' });
  const guest = joined.body;
  assert.equal(host.view.initialClueCount, 8);
  assert.equal(guest.view.initialClueCount, 8);
  const denied = await actionFor(guest, { kind: 'set-initial-clue-count', count: 0 });
  assert.equal(denied.status, 400);
  const changed = await actionFor(host, { kind: 'set-initial-clue-count', count: 12 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.view.initialClueCount, 12);
  const started = await actionFor(host, { kind: 'start-game' });
  assert.equal(started.status, 200);
  assert.equal(started.body.view.mySetup.clues.length, 12);
  const restored = await request(`/rooms/${host.roomId}/view`, null, guest.token);
  assert.equal(restored.body.view.mySetup.clues.length, 12);
  assert.equal(restored.body.view.mySetup.cluesClaimed, true);
  assert.equal(restored.body.view.setup, undefined);
  assert.equal(restored.body.view.puzzle, undefined);
  assert.deepEqual(restored.body.view.conferenceRules, {});
  assert.equal((await actionFor(host, { kind: 'set-initial-clue-count', count: 4 })).status, 400);
  assert.equal((await actionFor(guest, { kind: 'claim-initial-clues', count: 4 })).status, 400);
});

test('HTTP creates expert builtin puzzles with two public conference titles but no unearned text', async () => {
  const host = await create({ playMode: 'builtin', modeId: 'expert', initialClueCount: 0 });
  const room = rooms.get(host.roomId);
  assert.equal(validateBoard(room.puzzle.objects), true);
  assert.equal(host.view.mode.sectors, 18);
  assert.equal(host.view.mode.visible, 9);
  assert.deepEqual(host.view.conferenceSectors, [7, 16]);
  assert.deepEqual(Object.keys(host.view.conferenceNames), ['7', '16']);
  for (const text of Object.values(room.puzzle.conferences)) assert.equal(JSON.stringify(host.view).includes(text), false);
  const started = await actionFor(host, { kind: 'start-game' });
  assert.equal(started.body.view.mySetup.clues.length, 0);
  const ready = await actionFor(host, { kind: 'setup' });
  assert.equal(ready.body.view.phase, 'play');
});

test('tutorial creation is fixed, unjoinable, server-only and denies Bot credentials on every route', async () => {
  const host = await create({ playMode: 'tutorial', modeId: 'expert', initialClueCount: 12 });
  const room = rooms.get(host.roomId);
  assert.equal(host.view.mode.sectors, 12);
  assert.equal(host.view.initialClueCount, 4);
  assert.equal(host.view.phase, 'play');
  assert.ok(host.view.tutorial);
  assert.equal((await request(`/rooms/${host.roomId}/join`, { name: '闯入' })).status, 409);
  const bot = room.players[1];
  for (const route of ['view', 'summary', 'stream']) {
    const response = await request(`/rooms/${host.roomId}/${route}`, null, bot.token);
    assert.equal(response.status, 403);
  }
  assert.equal((await actionFor({ ...host, token: bot.token }, { kind: 'tutorial-next', stepId: host.view.tutorial.stepId })).status, 403);
  assert.equal(JSON.stringify(host).includes(bot.token), false);
  assert.equal(JSON.stringify(host).includes(room.puzzle.topics.B.clue), false);
  assert.equal((await fetch(`${base}/server/tutorial.js`)).status, 404);
});

async function openStream(context, player) {
  const controller = new AbortController();
  context.after(() => controller.abort());
  const response = await fetch(`${base}/api/rooms/${player.roomId}/stream?token=${encodeURIComponent(player.token)}`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    let timer;
    const read = async () => {
      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (data) return JSON.parse(data);
          continue;
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    };
    try {
      return await Promise.race([read(), new Promise((resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('missing tutorial SSE update')); }, 4000);
      })]);
    } finally { clearTimeout(timer); }
  };
}

test('HTTP and SSE persist every tutorial step, reject duplicates, and finish a complete private lesson', async (context) => {
  const host = await create({ playMode: 'tutorial' });
  const room = rooms.get(host.roomId);
  const nextEvent = await openStream(context, host);
  let view = (await nextEvent()).view;
  assert.equal(view.revision, 0);
  let steps = 0;
  while (!view.tutorial.completed && steps < 70) {
    const guide = view.tutorial;
    const action = guide.interaction === 'action' ? { ...guide.expected, stepId: guide.stepId }
      : { kind: guide.interaction === 'inspect' ? 'tutorial-inspect' : guide.interaction === 'mark' ? 'tutorial-mark' : 'tutorial-next', ...guide.expected, stepId: guide.stepId };
    const response = await actionFor(host, action);
    assert.equal(response.status, 200, `${guide.stepId}: ${response.body.error}`);
    const pushed = await nextEvent();
    assert.deepEqual(pushed.view, response.body.view);
    assert.equal(pushed.view.revision, view.revision + 1);
    if (guide.actor === 'bot') assert.equal(response.body.entry, null);
    assert.equal(JSON.stringify(pushed).includes(room.players[1].token), false);
    const duplicate = await actionFor(host, action);
    assert.equal(duplicate.status, 400);
    assert.deepEqual(duplicate.body.view, pushed.view);
    const refreshed = await request(`/rooms/${host.roomId}/view`, null, host.token);
    assert.deepEqual(refreshed.body.view, pushed.view);
    view = refreshed.body.view;
    steps += 1;
  }
  assert.equal(view.phase, 'done');
  assert.equal(view.tutorial.completed, true);
  assert.deepEqual(view.scores.rows.map((row) => row.total), [15, 5]);
  assert.equal(view.revealedObjects.length, 12);
});
