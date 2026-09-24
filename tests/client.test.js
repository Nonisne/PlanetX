// End-to-end: the *real* browser client transport (public/src/online.js) talking to the
// *real* server over HTTP. Only two browser globals are shimmed — fetch gets a base URL
// (the client uses relative paths) and localStorage/sessionStorage are Maps — so the
// code under test is exactly the code the page runs.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server.mjs';
import { Obj } from '../public/src/types.js';
import { inMemoryFetch } from './server-dispatch.js';

const store = new Map();
const tabStore = new Map();
const realLocalStorage = globalThis.localStorage;
const realSessionStorage = globalThis.sessionStorage;

const server = createServer();
const useMemory = process.env.PLANETX_TEST_TRANSPORT === 'memory';
if (!useMemory) await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = useMemory ? 'http://in-memory.test' : `http://127.0.0.1:${server.address().port}`;
const transportFetch = useMemory ? inMemoryFetch(server) : globalThis.fetch;

// Installed in a hook (not at import time) so other test files keep the real fetch.
// Storage stubs are only installed when nobody else has provided them, so every test
// file in this single process shares one consistent pair of stores.
let nativeFetch = null;
test.before(() => {
  globalThis.localStorage =
    globalThis.localStorage ||
    {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  globalThis.sessionStorage =
    globalThis.sessionStorage ||
    {
      getItem: (k) => (tabStore.has(k) ? tabStore.get(k) : null),
      setItem: (k, v) => tabStore.set(k, String(v)),
      removeItem: (k) => tabStore.delete(k),
    };
  nativeFetch = globalThis.fetch;
  // relative URLs -> absolute, exactly like a browser on that origin
  globalThis.fetch = (url, options) => transportFetch(String(url).startsWith('/') ? base + url : url, options);
});

test.after(() => {
  if (nativeFetch) globalThis.fetch = nativeFetch;
  server.close();
});

const online = await import('../public/src/online.js');

test('builtin transport creates solo puzzle mode and restores earned private clues without the answer', async () => {
  const created = await online.createRoom({ name: '单人玩家', modeId: 'standard', playMode: 'builtin', initialClueCount: 12 });
  assert.equal(created.view.playMode, 'builtin');
  assert.equal(created.view.canStart, true);
  const started = await online.sendAction(created, { kind: 'start-game' });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.view.mySetup.clues.length, 12);
  assert.equal(started.view.mySetup.cluesClaimed, true);
  const claimed = await online.sendAction(created, { kind: 'claim-initial-clues', count: 12 });
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.view.mySetup.clues.length, 12);
  assert.equal(claimed.view.mySetup.initialClueCount, 12);
  const ready = await online.sendAction(created, { kind: 'setup' });
  assert.equal(ready.view.phase, 'play');
  const research = await online.sendAction(created, { kind: 'research', topic: 'A' });
  assert.equal(research.ok, true, research.error);
  assert.ok(research.view.topics.A.clue);
  assert.equal(research.view.topics.B.clue, '');
  const restored = await online.fetchView(created);
  assert.deepEqual(restored.mySetup.clues, claimed.view.mySetup.clues);
  assert.equal(restored.topics.A.clue, research.view.topics.A.clue);
  assert.equal(restored.revealedObjects, null);
  assert.equal(restored.puzzle, undefined);
  assert.equal(restored.objects, undefined);
});

test('builtin transport creates expert puzzles instead of falling back to a record room', async () => {
  const room = await online.createRoom({ name: '专家玩家', modeId: 'expert', playMode: 'builtin' });
  assert.equal(room.view.playMode, 'builtin');
  assert.equal(room.view.mode.sectors, 18);
});

/** Create a room with two players sitting in the lobby, plus their identities. */
async function tableInLobby(initialClueCount = 0) {
  const host = await online.createRoom({ name: '阿甲', initialClueCount });
  const guest = await online.joinRoom(host.roomId, '阿乙');
  return { host, guest };
}

/**
 * Start the game and fill both setup cards.
 * `submitSetup` is what the page does: initial clue (optional) +, for the host, the
 * table-wide A–F names and conference notes.
 */
const HOST_TOPICS = { A: '阿甲的课题', B: '课题B', C: '课题C', D: '课题D', E: '课题E', F: '课题F' };

async function tablePlaying({ hostClue = null, conferences = null } = {}) {
  const ctx = await tableInLobby(hostClue ? 4 : 0);
  const clues = hostClue ? [hostClue, { sector: 0, type: Obj.GAS_CLOUD }, { sector: 3, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }] : [];
  const started = await online.sendAction(ctx.host, { kind: 'start-game' });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.view.phase, 'setup');

  const hostSetup = await online.sendAction(ctx.host, {
    kind: 'setup',
    clues,
    noClues: !hostClue,
    topics: HOST_TOPICS,
    conferenceNames: { 10: '彗星邻居' },
    conferences: conferences || {},
  });
  assert.equal(hostSetup.ok, true, hostSetup.error);
  assert.equal(hostSetup.view.phase, 'setup', 'one card is not enough');

  const guestSetup = await online.sendAction(ctx.guest, { kind: 'setup', noClues: !hostClue, clues: clues.map((clue) => ({ ...clue, type: Obj.GAS_CLOUD })), topics: { A: '阿乙的课题' } });
  assert.equal(guestSetup.ok, true, guestSetup.error);
  assert.equal(guestSetup.view.phase, 'play');
  assert.equal(guestSetup.view.turnPlayerId, ctx.host.playerId, 'the host opens the first round');
  return ctx;
}

/**
 * Play `action` as `who`: pass on any open research phase (everybody publishes nothing)
 * and let the host skip the current player until it is `who`'s turn.
 */
async function play(ctx, who, action) {
  for (let guard = 0; guard < 60; guard++) {
    const view = await online.fetchView(who);
    assert.equal(view.phase, 'play', 'turn arrangement must not skip final opportunities');
    assert.equal(view.awaitingReview.length, 0, 'pending reviews must be resolved explicitly');
    if (view.research) {
      for (const player of [ctx.host, ctx.guest]) {
        const ownView = await online.fetchView(player);
        if (!ownView.research || ownView.research.id !== view.research.id) break;
        assert.ok(ownView.research.myCount === null || ownView.research.myCount === 0, 'finish declared publications explicitly');
        if (ownView.research.myCount === null) {
          const passed = await online.sendAction(player, { kind: 'research-declare', phaseId: view.research.id, count: 0 });
          assert.equal(passed.ok, true, passed.error);
        }
      }
      continue;
    }
    if (view.turnPlayerId === who.playerId) return online.sendAction(who, action);
    const skipped = await online.sendAction(ctx.host, { kind: 'skip-turn' });
    assert.equal(skipped.ok, true, skipped.error);
  }
  assert.fail('the requested client did not receive a turn');
}

const finalObjects = [Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY];

function frozenState(view) {
  return {
    players: view.players.map((player) => ({ id: player.id, time: player.time, sector: player.sector })),
    windowTime: view.windowTime,
    visible: view.visible,
    arrowSector: view.arrowSector,
  };
}

test('the client can list modes, create a room and reconnect to it', async () => {
  const modes = await online.listModes();
  assert.ok(modes.some((m) => m.id === 'standard' && m.sectors === 12));
  assert.ok(modes.some((m) => m.id === 'expert' && m.sectors === 18));

  const room = await online.createRoom({ name: '阿甲' });
  assert.match(room.roomId, /^[A-Z0-9]{6}$/);
  assert.equal(room.view.time, 0);
  assert.equal(room.view.mode.sectors, 12);
  assert.equal(room.view.phase, 'lobby', 'a fresh room is in the lobby');
  assert.equal(room.view.amHost, true);
  assert.equal(room.view.canStart, false, 'one player is not a table');
  assert.equal(room.view.me, room.playerId);
  assert.equal(room.view.players[0].name, '阿甲');
  assert.equal(room.view.players[0].host, true);

  // identity survives a reload through sessionStorage
  online.saveRoom({ roomId: room.roomId, playerId: room.playerId, token: room.token });
  const saved = online.loadRoom();
  assert.equal(saved.roomId, room.roomId);
  const again = await online.fetchView(saved);
  assert.equal(again.roomId, room.roomId);
  assert.equal(again.me, room.playerId);
  assert.ok(Array.isArray(again.researched), 'the wire format carries arrays, not Sets');
  online.clearRoom();
  assert.equal(online.loadRoom(), null);

  // a stale token is reported, not silently accepted
  await assert.rejects(() => online.fetchView({ roomId: room.roomId, token: 'bogus' }), /身份|失效/);
  await assert.rejects(() => online.joinRoom('ZZZZZZ', '无名'), /房间/);
});

test('the lobby gates the start on two players and the host’s command', async () => {
  const { host, guest } = await tableInLobby();

  const guestTry = await online.sendAction(guest, { kind: 'start-game' });
  assert.equal(guestTry.ok, false);
  assert.match(guestTry.error, /房主/);

  const early = await online.sendAction(host, { kind: 'wait' });
  assert.equal(early.ok, false, 'nothing can be recorded before the start');
  assert.match(early.error, /还没开始/);

  const hostView = await online.fetchView(host);
  assert.equal(hostView.playerCount, 2);
  assert.equal(hostView.canStart, true, 'two players is enough for the host to start');
  const guestView = await online.fetchView(guest);
  assert.equal(guestView.amHost, false);
  assert.equal(guestView.canStart, false, 'and only the host can start');
});

test('the setup phase collects a private initial clue, shared subjects and the conference notes', async () => {
  const clues = [{ sector: 1, type: Obj.COMET }, { sector: 0, type: Obj.GAS_CLOUD }, { sector: 3, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }];
  const draft = await tableInLobby(4);
  await online.sendAction(draft.host, { kind: 'start-game' });
  const missingTopic = await online.sendAction(draft.host, {
    kind: 'setup',
    clues,
    topics: { A: '阿甲的课题' },
    conferenceNames: { 10: '彗星邻居' },
  });
  assert.equal(missingTopic.ok, false);
  assert.match(missingTopic.error, /请填写研究课题 B 的名称/);
  const missingTitle = await online.sendAction(draft.host, {
    kind: 'setup',
    clues,
    topics: HOST_TOPICS,
    conferenceNames: {},
  });
  assert.equal(missingTitle.ok, false);
  assert.match(missingTitle.error, /10 号扇区的 X行星会议名称/);

  const ctx = await tablePlaying({ hostClue: { sector: 1, type: Obj.COMET }, conferences: { 10: 'X行星紧邻一颗彗星' } });
  const { host, guest } = ctx;

  const hostView = await online.fetchView(host);
  assert.equal(hostView.phase, 'play');
  assert.equal(hostView.mySetup.ready, true);
  assert.equal(hostView.mySetup.clues.length, 4);
  assert.deepEqual(hostView.mySetup.clues[0], { sector: 1, type: Obj.COMET });
  assert.equal(hostView.mySetup.topics.A.name, '阿甲的课题');
  assert.equal(hostView.topics.A.name, '阿甲的课题', 'and it seeds the subject list used while playing');
  assert.equal(hostView.conferenceNames[10], '彗星邻居', 'the host’s conference title is the table’s');
  assert.deepEqual(hostView.conferenceRuleSectors, [10], 'a standard board has one conference');

  const guestView = await online.fetchView(guest);
  assert.equal(guestView.mySetup.ready, true);
  assert.equal(guestView.mySetup.clues.length, 4, 'the guest has the same count with a private hand');
  assert.equal(guestView.players.find((p) => p.id === host.playerId).ready, true, 'readiness is public');
  assert.equal(guestView.topics.A.name, '阿甲的课题', 'subject names are shared by the whole table');
  assert.equal(guestView.conferenceNames[10], '彗星邻居', 'the conference title is shared with the guest');
  assert.equal(guestView.conferenceRules[10], 'X行星紧邻一颗彗星', 'and so is the conference rule');
  assert.equal(guestView.amHost, false);

  // only the host types the table-wide information
  const guestEdit = await online.sendAction(guest, { kind: 'set-topic-names', names: { A: '偷改' } });
  assert.equal(guestEdit.ok, false);
  assert.match(guestEdit.error, /房主/);
  const hostEdit = await online.sendAction(host, { kind: 'set-topic-names', names: { A: '小行星带' } });
  assert.equal(hostEdit.ok, true);
  assert.equal(hostEdit.view.topics.A.name, '小行星带');
  const guestAgain = await online.fetchView(guest);
  assert.equal(guestAgain.topics.A.name, '小行星带', 'the change reaches everybody');

  // an expert board with two conferences refuses a note for a standard-only sector
  const expert = await online.createRoom({ name: '专家甲', modeId: 'expert' });
  const expertGuest = await online.joinRoom(expert.roomId, '专家乙');
  await online.sendAction(expert, { kind: 'start-game' });
  assert.deepEqual((await online.fetchView(expert)).conferenceRuleSectors, [7, 16]);
  const bad = await online.sendAction(expert, { kind: 'set-conference-rules', rules: { 10: 'nope' } });
  assert.equal(bad.ok, true);
  assert.deepEqual(bad.view.conferenceRules, {}, 'sector 10 is not an expert conference');
  const good = await online.sendAction(expert, { kind: 'set-conference-rules', rules: { 7: '甲', 16: '乙' } });
  assert.deepEqual(good.view.conferenceRules, { 7: '甲', 16: '乙' });
  assert.equal((await online.fetchView(expertGuest)).conferenceRules[16], '乙', 'and the guest reads them');
});

test('two clients share the log and the board, but each one has their own clock', async () => {
  const ctx = await tablePlaying({ hostClue: { sector: 9, type: Obj.DWARF_PLANET } });
  const { host, guest } = ctx;

  // turns: the host opens (both pawns at month 0, host joined first)
  const tooEarly = await online.sendAction(guest, { kind: 'wait' });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /轮到/);

  // the host surveys, the guest scans: alternating turns, two separate pawns
  // surveys and scans may only cover sectors the shared window currently shows
  const survey = await play(ctx, host, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 6, count: 2 });
  assert.equal(survey.ok, true, survey.error);
  assert.equal(survey.view.time, 3, 'three months on the host’s own pawn');
  assert.equal(survey.view.knowledge.surveys[0].count, 2, 'the host keeps their own result');
  assert.equal(survey.view.turnPlayerId, guest.playerId, 'and the least-time player is next');

  const guestWin = (await online.fetchView(guest)).visible;
  const guestSector = guestWin[2];
  assert.equal((await play(ctx, guest, { kind: 'target', sector: guestSector, apparent: Obj.COMET })).ok, true);
  const hostWin = (await online.fetchView(host)).visible;
  const hostSector = hostWin[1];
  assert.equal((await play(ctx, host, { kind: 'target', sector: hostSector, apparent: Obj.EMPTY })).ok, true);
  assert.equal((await play(ctx, guest, { kind: 'research', topic: 'B', name: '乙的课题', text: '乙的线索' })).ok, true);
  assert.equal((await play(ctx, host, { kind: 'research', topic: 'A', name: '小行星带', text: '编号之和为 30' })).ok, true);

  // conferences are free: anybody may record them at any time
  const conf = await online.sendAction(host, { kind: 'conference', sector: 10, text: 'X行星紧邻一颗彗星' });
  assert.equal(conf.ok, true, conf.error);

  const hostView = await online.fetchView(host);
  const guestView = await online.fetchView(guest);

  // shared
  assert.equal(hostView.recordCount, guestView.recordCount, 'one action log');
  assert.equal(guestView.knowledge.surveys.length, 1, 'the guest sees that a survey happened');
  assert.equal(guestView.knowledge.surveys[0].surveyType, Obj.ASTEROID, 'and what was asked');
  assert.equal(guestView.knowledge.conferences[0].text, 'X行星紧邻一颗彗星', 'conference clues are public');
  assert.deepEqual(
    hostView.players.map((p) => p.time),
    guestView.players.map((p) => p.time),
    'both clients see the same two pawns',
  );
  assert.equal(hostView.players.find((p) => p.isMe).id, host.playerId);

  // private
  const spentBy = (view, id) => view.log.filter((e) => e.actorId === id).reduce((n, e) => n + (e.cost || 0), 0);
  assert.equal(hostView.time, spentBy(hostView, host.playerId), 'my clock is the sum of my own entries');
  assert.equal(guestView.time, spentBy(guestView, guest.playerId), 'and each client reads their own');
  assert.equal(hostView.time > guestView.time, true, 'the host has spent more time, so the guest acts first');
  assert.equal(hostView.knowledge.surveys[0].count, 2);
  assert.equal(guestView.knowledge.surveys[0].count, undefined, 'survey counts stay private');
  assert.equal(hostView.knowledge.targets.find((t) => t.sector === hostSector).apparent, Obj.EMPTY);
  assert.equal(guestView.knowledge.targets.find((t) => t.sector === hostSector).apparent, undefined, 'scan results stay private');
  assert.equal(guestView.knowledge.targets.find((t) => t.sector === guestSector).apparent, Obj.COMET, 'each player keeps their own');
  assert.equal(guestView.knowledge.clues.find((c) => c.topic === 'A').text, undefined, 'research text stays private');
  assert.equal(guestView.knowledge.clues.find((c) => c.topic === 'A').topic, 'A', 'the subject itself is public');
  assert.equal(hostView.topics.A.name, '阿甲的课题', 'the A–F names are the table’s, set by the host');
  assert.equal(guestView.topics.A.name, '阿甲的课题', 'so both players see the same subject list');
  assert.equal(hostView.knowledge.clues.find((c) => c.topic === 'B').text, undefined, 'and the guest’s clue text stays theirs');
  assert.equal(guestView.knowledge.clues.find((c) => c.topic === 'B').text, '乙的线索');

  // publishing belongs to a research phase: walk a pawn over a research sector
  const opened = await walkToResearch(ctx);
  assert.equal(opened.sector !== 0, true, 'a research sector was crossed');
  assert.match(opened.id, /^theory:\d+$/);
  const before = online.fetchView(host);
  assert.equal((await before).research !== null, true, 'so the table is in its research phase');

  const hostDeclared = await online.sendAction(host, { kind: 'research-declare', phaseId: opened.id, count: 1 });
  assert.equal(hostDeclared.ok, true, hostDeclared.error);
  const declared = await online.sendAction(guest, { kind: 'research-declare', phaseId: opened.id, count: 1 });
  assert.equal(declared.ok, true, declared.error);
  assert.equal(declared.view.research.allDeclared, true);
  assert.equal(declared.view.research.order.length, 2, 'both players publish');
  assert.equal(declared.view.research.quota, 1, 'a standard board allows one paper each');

  // publish in the phase's order; the objects are private to their authors
  const firstPublisher = publisher(declared.view, host, guest);
  const secondPublisher = firstPublisher === host ? guest : host;
  const first = await online.sendAction(firstPublisher, { kind: 'research-submit', phaseId: opened.id, sector: 4, objectType: Obj.COMET });
  assert.equal(first.ok, true, first.error);
  const second = await online.sendAction(secondPublisher, { kind: 'research-submit', phaseId: opened.id, sector: 1, objectType: Obj.GAS_CLOUD });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.view.knowledge.theories.map((t) => t.slot).sort(), [3, 3], 'one phase -> one track space');
  assert.equal(second.view.research, null, 'and the phase is over');
  const authored = second.view.knowledge.theories.find((t) => t.sector === 4);
  assert.equal(authored.objectType, undefined, 'only the sector is public');
  const myOwn = (await online.fetchView(firstPublisher)).knowledge.theories.find((t) => t.sector === 4);
  assert.equal(myOwn.objectType, Obj.COMET, 'the author receives their own object');

  assert.equal((await online.sendAction(firstPublisher, { kind: 'undo' })).ok, false, 'not the last entry');
  const settledUndo = await online.sendAction(secondPublisher, { kind: 'undo' });
  assert.equal(settledUndo.ok, false, 'a paper already advanced by a completed phase cannot be undone');
  assert.match(settledUndo.error, /阶段结算/);
  assert.equal(settledUndo.view.knowledge.theories.length, 2);
});

/** Whose publishing turn it is inside the open research phase. */
function publisher(view, host, guest) {
  return view.research && view.research.cursorId === guest.playerId ? guest : host;
}

/** Move pawns until somebody crosses a research sector, which opens the table's phase. */
async function walkToResearch(ctx) {
  const { host, guest } = ctx;
  for (let guard = 0; guard < 20; guard++) {
    const view = await online.fetchView(host);
    if (view.research) return view.research;
    assert.equal(view.phase, 'play');
    assert.equal(view.awaitingReview.length, 0, 'review papers before requesting another phase');
    const who = view.turnPlayerId === guest.playerId ? guest : host;
    const res = await online.sendAction(who, { kind: 'wait' });
    if (!res.ok) {
      const now = await online.fetchView(host);
      if (now.research) return now.research;
      throw new Error(res.error);
    }
  }
  throw new Error('no research phase was triggered');
}

test('the client can undo an own unsettled turn but not another player’s action', async () => {
  const { host, guest } = await tablePlaying();
  assert.equal((await online.sendAction(host, { kind: 'wait' })).ok, true);
  assert.equal((await online.sendAction(guest, { kind: 'wait' })).ok, true);
  const refused = await online.sendAction(host, { kind: 'undo' });
  assert.equal(refused.status, 400);
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.view.players.map((player) => player.time), [1, 1]);
  const guestUndo = await online.sendAction(guest, { kind: 'undo' });
  assert.equal(guestUndo.ok, true, guestUndo.error);
  assert.deepEqual(guestUndo.view.players.map((player) => player.time), [1, 0]);
  const hostUndo = await online.sendAction(host, { kind: 'undo' });
  assert.equal(hostUndo.ok, true, hostUndo.error);
  assert.deepEqual(hostUndo.view.players.map((player) => player.time), [0, 0]);
  assert.equal(hostUndo.view.turnPlayerId, host.playerId);
});

test('client research stays restricted across another player and free conference records', async () => {
  const ctx = await tablePlaying();
  const { host, guest } = ctx;
  assert.equal((await online.sendAction(host, { kind: 'research', topic: 'A', text: '甲的线索' })).ok, true);
  assert.equal((await online.sendAction(guest, { kind: 'research', topic: 'A', text: '乙的线索' })).ok, true);
  assert.equal((await online.sendAction(guest, { kind: 'conference', sector: 10, text: '公共线索' })).ok, true);
  const before = await online.fetchView(host);
  assert.equal(before.lastWasResearch, true);
  const refused = await online.sendAction(host, { kind: 'research', topic: 'B', text: '不应记录' });
  assert.equal(refused.status, 400);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /连续/);
  assert.deepEqual(refused.view, before);
  assert.equal((await online.sendAction(host, { kind: 'wait' })).ok, true);
  assert.equal((await online.sendAction(guest, { kind: 'wait' })).ok, true);
  const allowed = await play(ctx, host, { kind: 'research', topic: 'B', text: '自己的等待后可以研究' });
  assert.equal(allowed.ok, true, allowed.error);
  assert.equal(allowed.view.time, 3);
  assert.deepEqual(allowed.view.researched, ['A', 'B']);
});

for (const correct of [true, false]) {
  test(`two clients finish a ${correct ? 'correct' : 'wrong'} final locate privately before the host reveals`, async () => {
    const { host, guest } = await tablePlaying();
    const answer = { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true };
    const located = await online.sendAction(host, answer);
    assert.equal(located.ok, true, located.error);
    assert.equal(located.view.status, 'final');
    assert.equal(located.view.phase, 'final');
    assert.equal(located.view.time, 5);
    const guestAfter = await online.fetchView(guest);
    assert.equal(guestAfter.status, 'final');
    assert.equal(guestAfter.turnPlayerId, null);
    assert.equal(guestAfter.endgame.isMyTurn, true);
    assert.equal(guestAfter.endgame.behind, 5);
    assert.equal(guestAfter.endgame.quota, 2);
    const frozen = frozenState(guestAfter);
    for (const field of ['sector', 'left', 'right']) {
      assert.equal(located.view.locate[field], answer[field]);
      assert.equal(Object.hasOwn(guestAfter.locate, field), false);
      assert.equal(Object.hasOwn(guestAfter.summary.locate, field), false);
      assert.equal(Object.hasOwn(guestAfter.entries[0], field), false);
    }
    assert.equal((await online.sendAction(guest, { kind: 'wait' })).ok, false);
    const finalGuess = correct ? answer : { kind: 'locate', sector: 8, left: Obj.ASTEROID, right: Obj.GAS_CLOUD, correct: false };
    const last = await online.sendAction(guest, finalGuess);
    assert.equal(last.status, 200);
    assert.equal(last.ok, true, last.error);
    assert.equal(last.view.phase, 'reveal');
    assert.equal(last.view.status, 'reveal');
    assert.equal(last.view.entries.at(-1).cost, 0);
    assert.equal(last.view.entries.at(-1).correct, correct);
    assert.equal(last.view.endgame.players[0].choice, 'locate');
    assert.equal(last.view.endgame.players[0].done, true);
    assert.deepEqual(last.view.scores.rows.map((row) => row.locatePoints), [10, correct ? 10 : 0]);
    assert.deepEqual(frozenState(last.view), frozen);
    for (const player of [host, guest]) {
      const view = await online.fetchView(player);
      const otherLocate = view.entries.find((entry) => entry.type === 'located' && entry.actorId !== player.playerId);
      const ownLocate = view.entries.find((entry) => entry.type === 'located' && entry.actorId === player.playerId);
      const ownGuess = player === host ? answer : finalGuess;
      for (const field of ['sector', 'left', 'right']) {
        assert.equal(Object.hasOwn(otherLocate, field), false);
        assert.equal(ownLocate[field], ownGuess[field]);
      }
      const otherCells = view.rounds.flatMap((round) => Object.values(round.cells).flat()).filter((cell) => cell.id === otherLocate.id);
      assert.deepEqual(otherCells.map((cell) => cell.op), ['定位 X行星（扇区保密）']);
      assert.deepEqual(frozenState(view), frozen);
      assert.equal(view.scores.finished, false);
    }
    const duplicate = await online.sendAction(guest, finalGuess);
    assert.equal(duplicate.status, 400);
    assert.deepEqual(duplicate.view, last.view, 'a final locate cannot be repeated');
    const forbidden = await online.sendAction(guest, { kind: 'reveal-objects', objects: finalObjects });
    assert.equal(forbidden.ok, false);
    assert.equal(forbidden.status, 400);
    const revealed = await online.sendAction(host, { kind: 'reveal-objects', objects: finalObjects });
    assert.equal(revealed.ok, true, revealed.error);
    for (const player of [host, guest]) {
      const view = await online.fetchView(player);
      assert.equal(view.phase, 'done');
      assert.equal(view.status, 'finished');
      assert.equal(view.scores.finished, true);
      assert.deepEqual(view.revealedObjects, finalObjects);
      assert.deepEqual(frozenState(view), frozen);
      assert.equal(view.entries.every((entry) => entry.revealed), true);
      const closed = await online.sendAction(player, { kind: 'wait' });
      assert.equal(closed.status, 400);
      assert.match(closed.error, /已结束/);
      assert.deepEqual(closed.view, view);
    }
  });
}

test('the client transmits final theory batches atomically without moving either pawn', async () => {
  const { host, guest } = await tablePlaying();
  const located = await online.sendAction(host, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true });
  assert.equal(located.ok, true, located.error);
  const before = await online.fetchView(guest);
  const frozen = frozenState(before);
  const invalid = await online.sendAction(guest, { kind: 'final-theories', theories: [{ sector: 1, objectType: Obj.COMET }, { sector: 1, objectType: Obj.ASTEROID }] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.ok, false);
  assert.deepEqual(invalid.view, before);
  const published = await online.sendAction(guest, { kind: 'final-theories', theories: [{ sector: 1, objectType: Obj.COMET }, { sector: 4, objectType: Obj.COMET }] });
  assert.equal(published.ok, true, published.error);
  assert.equal(published.view.phase, 'reveal');
  assert.equal(published.view.endgame.players[0].choice, 'final-theories');
  assert.deepEqual(frozenState(published.view), frozen);
  const hostView = await online.fetchView(host);
  assert.equal(hostView.knowledge.theories.every((paper) => !Object.hasOwn(paper, 'objectType')), true);
  assert.deepEqual(hostView.knowledge.theories.map((paper) => paper.review), ['pending', 'pending']);
  const revealed = await online.sendAction(host, { kind: 'reveal-objects', objects: finalObjects });
  assert.equal(revealed.ok, true, revealed.error);
  const guestView = await online.fetchView(guest);
  assert.equal(guestView.phase, 'done');
  assert.deepEqual(guestView.knowledge.theories.map((paper) => paper.review), ['correct', 'wrong']);
  assert.equal(guestView.entries.some((entry) => entry.type === 'penalty'), false);
  assert.deepEqual(guestView.scores.rows.map((row) => row.total), [10, 4]);
  assert.deepEqual(frozenState(guestView), frozen);
});

test('only the host can skip the current final opportunity and the skip costs no time', async () => {
  const { host, guest } = await tablePlaying();
  const located = await online.sendAction(host, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true });
  assert.equal(located.ok, true, located.error);
  const frozen = frozenState(located.view);
  const refused = await online.sendAction(guest, { kind: 'skip-turn' });
  assert.equal(refused.status, 400);
  assert.equal(refused.view.phase, 'final');
  assert.equal(refused.view.endgame.isMyTurn, true);
  const skipped = await online.sendAction(host, { kind: 'skip-turn' });
  assert.equal(skipped.ok, true, skipped.error);
  assert.equal(skipped.view.phase, 'reveal');
  assert.equal(skipped.view.endgame.players[0].choice, 'final-pass');
  assert.equal(skipped.view.endgame.players[0].done, true);
  assert.equal(skipped.view.recordCount, located.view.recordCount);
  assert.deepEqual(frozenState(skipped.view), frozen);
  assert.equal((await online.sendAction(guest, { kind: 'final-pass' })).ok, false);
  const revealed = await online.sendAction(host, { kind: 'reveal-objects', objects: finalObjects });
  assert.equal(revealed.ok, true, revealed.error);
  assert.equal(revealed.view.phase, 'done');
  assert.deepEqual(frozenState(revealed.view), frozen);
});

test('the room identity is per tab, so two tabs are two different players', () => {
  const realSession = globalThis.sessionStorage;
  const tabA = new Map();
  const tabB = new Map();
  const stub = (map) => ({
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  });

  globalThis.sessionStorage = stub(tabA);
  online.saveRoom({ roomId: 'ROOM01', playerId: 'P1', token: 'tok-A' });
  assert.deepEqual(online.loadRoom(), { roomId: 'ROOM01', playerId: 'P1', token: 'tok-A' });
  assert.equal(store.has('planetx.room.v1'), false, 'no stale identity is left in localStorage');

  globalThis.sessionStorage = stub(tabB);
  assert.equal(online.loadRoom(), null, 'tab B must not inherit tab A’s identity');
  online.saveRoom({ roomId: 'ROOM01', playerId: 'P2', token: 'tok-B' });
  assert.equal(online.loadRoom().token, 'tok-B');

  globalThis.sessionStorage = stub(tabA);
  assert.equal(online.loadRoom().token, 'tok-A', 'tab A still plays as P1');
  online.clearRoom();
  assert.equal(online.loadRoom(), null);

  globalThis.sessionStorage = realSession;
});

test('the stream helper reports when EventSource is unavailable', () => {
  const realEventSource = globalThis.EventSource;
  delete globalThis.EventSource;
  let status = null;
  const handle = online.openStream({ roomId: 'ABC123', token: 't' }, { onStatus: (s) => (status = s), onView: () => {} });
  assert.equal(status, 'unsupported');
  handle.close();
  if (realEventSource) globalThis.EventSource = realEventSource;
});
