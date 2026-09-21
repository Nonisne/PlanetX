import test from 'node:test';
import assert from 'node:assert/strict';
import * as online from '../public/src/online.js';

const originals = { fetch: globalThis.fetch, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage };
const storage = new Map();
let requests;
let capabilities;
let reply;
test.beforeEach(() => {
  storage.clear();
  globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key) };
  globalThis.localStorage = { getItem: () => null, removeItem() {} };
  requests = [];
  capabilities = { playModes: ['record', 'builtin', 'tutorial'], builtinBoards: ['standard', 'expert'], initialClueCounts: [0, 4, 8, 12] };
  reply = null;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, body });
    const data = url.endsWith('/modes') ? capabilities : reply || {
      roomId: 'ROOM', playerId: 'HOST', token: 'TOKEN',
      view: { modeId: body.modeId, playMode: body.playMode === 'tutorial' ? 'builtin' : body.playMode, initialClueCount: body.initialClueCount, tutorial: body.playMode === 'tutorial' ? { stepId: 'welcome' } : null },
    };
    return { status: 200, json: async () => data };
  };
});
test.after(() => Object.assign(globalThis, originals));

test('client forwards the room-wide count including zero and supports expert built-in creation', async () => {
  const result = await online.createRoom({ name: '专家', playMode: 'builtin', modeId: 'expert', initialClueCount: 0 });
  assert.equal(result.view.modeId, 'expert');
  assert.equal(result.view.initialClueCount, 0);
  assert.deepEqual(requests.at(-1).body, { name: '专家', playMode: 'builtin', modeId: 'expert', initialClueCount: 0 });
  await online.createRoom({ name: '记录员' });
  assert.equal(requests.at(-1).body.initialClueCount, 4);
});

test('tutorial transport fixes standard four-clue setup and refuses an ordinary fallback', async () => {
  await online.createRoom({ name: '新人', playMode: 'tutorial', modeId: 'expert', initialClueCount: 12 });
  assert.deepEqual(requests.at(-1).body, { name: '新人', playMode: 'tutorial', modeId: 'standard', initialClueCount: 4 });
  reply = { token: 'TOKEN', view: { playMode: 'builtin', modeId: 'standard' } };
  await assert.rejects(() => online.createRoom({ name: '新人', playMode: 'tutorial' }), /教学/);
});

test('unsupported builtin board and tutorial are rejected before a room is created', async () => {
  capabilities.builtinBoards = ['standard'];
  await assert.rejects(() => online.createRoom({ name: '专家', playMode: 'builtin', modeId: 'expert' }), /18|专家|棋盘/);
  assert.equal(requests.some((request) => request.url.endsWith('/rooms')), false);
  capabilities.playModes = ['record', 'builtin'];
  await assert.rejects(() => online.createRoom({ name: '新人', playMode: 'tutorial' }), /教学/);
  assert.equal(requests.some((request) => request.url.endsWith('/rooms')), false);
});

test('client detects an older server that does not support shared clue counts', async () => {
  delete capabilities.initialClueCounts;
  await assert.rejects(() => online.createRoom({ name: '新人', playMode: 'builtin', initialClueCount: 8 }), /线索|重启/);
  assert.equal(requests.some((request) => request.url.endsWith('/rooms')), false);
});

test('tutorial return identity is separate from active room and survives repeated tutorial starts', () => {
  assert.equal(typeof online.saveTutorialReturn, 'function');
  const ordinary = { roomId: 'NORMAL', playerId: 'PLAYER', token: 'normal-token' };
  online.saveRoom(ordinary);
  online.saveTutorialReturn(ordinary);
  online.saveRoom({ roomId: 'TUTORIAL', playerId: 'LEARNER', token: 'tutorial-token' });
  online.saveTutorialReturn({ roomId: 'TUTORIAL', token: 'tutorial-token' });
  assert.deepEqual(online.loadTutorialReturn(), { room: ordinary });
  assert.equal(online.loadRoom().roomId, 'TUTORIAL');
  online.clearRoom();
  assert.deepEqual(online.loadTutorialReturn(), { room: ordinary });
  online.clearTutorialReturn();
  assert.equal(online.loadTutorialReturn(), null);
});

test('tutorial return identity distinguishes offline return from a missing backup', () => {
  assert.equal(typeof online.saveTutorialReturn, 'function');
  assert.equal(online.loadTutorialReturn(), null);
  online.saveTutorialReturn(null);
  assert.deepEqual(online.loadTutorialReturn(), { room: null });
  online.clearTutorialReturn();
  assert.equal(online.loadTutorialReturn(), null);
});
