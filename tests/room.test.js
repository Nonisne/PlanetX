import test from 'node:test';
import assert from 'node:assert/strict';

import { Obj } from '../public/src/types.js';
import { MAX_TARGET_USES, MODES } from '../public/src/rules.js';
import {
  addPlayer,
  applyRoomAction,
  CLUE_TYPES,
  createRoom,
  crossedConferenceSector,
  crossedTheorySector,
  crossedTheorySectors,
  currentPlayer,
  MAX_SETUP_CLUES,
  playerById,
  playerByToken,
  readyCount,
  researchOrder,
  stateFor,
  turnOrder,
  viewFor,
  windowTimeOf,
} from '../public/src/room.js';

/** A room with two players sitting in the lobby. */
function lobby(modeId = 'standard', initialClueCount = 0) {
  const room = createRoom({ modeId, hostName: '阿甲', initialClueCount });
  const host = room.players[0];
  const guest = addPlayer(room, '阿乙');
  return { room, host, guest };
}

/** The same, but with the game started and both setup cards filled in. */
function playing(modeId = 'standard') {
  const ctx = lobby(modeId);
  assert.equal(applyRoomAction(ctx.room, ctx.host.id, { kind: 'start-game' }).ok, true);
  for (const p of [ctx.host, ctx.guest]) {
    assert.equal(
      applyRoomAction(ctx.room, p.id, { kind: 'setup', noClues: true, topics: { A: `${p.name}的课题` } }).ok,
      true,
    );
  }
  return ctx;
}

/**
 * Test helper: the pawns decide who acts, so "act as X" means "let time pass until X
 * is the one who has spent the least". Any research phase the waits trigger is closed
 * by everybody passing.
 */
function act(room, playerId, action) {
  passTo(room, playerId);
  const res = applyRoomAction(room, playerId, action);
  resolveResearch(room);
  return res;
}

/** Advance the table until `playerId` is the least-time pawn (each step is a wait). */
function passTo(room, playerId) {
  for (let guard = 0; guard < 60; guard++) {
    resolveResearch(room);
    assert.equal(viewFor(room, playerId).awaitingReview.length, 0, 'pending reviews must be resolved explicitly');
    const who = currentPlayer(room);
    assert.ok(who, 'arranging a turn requires the play phase');
    if (who.id === playerId) return;
    const result = applyRoomAction(room, who.id, { kind: 'wait' });
    assert.equal(result.ok, true, result.error);
  }
  assert.fail('the requested player did not receive a turn');
}

/** Everybody passes on the open research phase, which closes it. */
function resolveResearch(room) {
  for (let guard = 0; guard < 8 && room.research; guard++) {
    const phase = room.research;
    assert.equal(Object.values(phase.declares).every((count) => count === 0), true, 'finish declared publications explicitly');
    for (const player of room.players) {
      if (room.research !== phase) break;
      if (Object.hasOwn(phase.declares, player.id)) continue;
      const result = applyRoomAction(room, player.id, { kind: 'research-declare', phaseId: phase.id, count: 0 });
      assert.equal(result.ok, true, result.error);
    }
  }
  assert.equal(room.research, null, 'all zero-submission phases closed');
}

/** Play turn actions as one player, arranging the turns around them. */
function play(room, playerId, action) {
  return act(room, playerId, action);
}

/** Act exactly in turn order (no arranging) and close any phase the move triggered. */
function step(room, playerId, action) {
  const res = applyRoomAction(room, playerId, action);
  resolveResearch(room);
  return res;
}

function accepted(room, playerId, action) {
  const result = applyRoomAction(room, playerId, action);
  assert.equal(result.ok, true, result.error);
  return result;
}

// ---- lobby -----------------------------------------------------------------

test('a room starts in the lobby with a host and a joinable code', () => {
  const room = createRoom({ hostName: '阿甲' });
  assert.match(room.id, /^[A-Z0-9]{6}$/);
  assert.equal(room.phase, 'lobby');
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].host, true);
  assert.equal(room.hostId, room.players[0].id);
  assert.ok(playerByToken(room, room.players[0].token));

  const guest = addPlayer(room, '阿乙');
  assert.equal(guest.host, false);
  assert.notEqual(guest.color, room.players[0].color, 'players get distinct colours');
  assert.equal(playerById(room, guest.id).name, '阿乙');
});

test('in the lobby nothing can be recorded and only the host may start', () => {
  const { room, host, guest } = lobby();
  const early = applyRoomAction(room, host.id, { kind: 'wait' });
  assert.equal(early.ok, false);
  assert.match(early.error, /还没开始/);

  assert.equal(applyRoomAction(room, guest.id, { kind: 'start-game' }).ok, false, 'only the host starts');
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  assert.equal(room.phase, 'setup');
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, false, 'and only once');
});

test('a lone host cannot start: the table needs two players', () => {
  const room = createRoom({ hostName: '独行' });
  const res = applyRoomAction(room, room.players[0].id, { kind: 'start-game' });
  assert.equal(res.ok, false);
  assert.match(res.error, /至少需要 2 名玩家/);
  const view = viewFor(room, room.players[0].id);
  assert.equal(view.canStart, false);
  assert.equal(view.playerCount, 1);
});

// ---- setup: initial clues + A–F subject names ------------------------------

test('setup collects initial clues and the six subject names', () => {
  const { room, host, guest } = lobby('standard', 4);
  const clues = [{ sector: 1, type: Obj.COMET }, { sector: 7, type: Obj.GAS_CLOUD }, { sector: 2, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }];
  applyRoomAction(room, host.id, { kind: 'start-game' });
  assert.equal(room.phase, 'setup');
  assert.equal(readyCount(room), 0);

  const res = applyRoomAction(room, host.id, {
    kind: 'setup',
    clues,
    topics: { A: '小行星带', B: '彗星轨道' },
  });
  assert.equal(res.ok, true);
  assert.equal(room.phase, 'setup', 'one player is not enough to begin');
  assert.equal(readyCount(room), 1);

  const view = viewFor(room, host.id);
  assert.equal(view.phase, 'setup');
  assert.equal(view.readyCount, 1);
  assert.equal(view.mySetup.ready, true);
  assert.deepEqual(view.mySetup.clues, clues);
  assert.equal(view.mySetup.topics.A.name, '小行星带');
  assert.equal(view.mySetup.topics.C.name, '', 'unnamed subjects stay blank');
  // the other player does not see my starting information
  const guestView = viewFor(room, guest.id);
  assert.equal(guestView.mySetup.ready, false);
  assert.equal(guestView.mySetup.clues.length, 0);
  assert.equal(guestView.players.find((p) => p.id === host.id).ready, true, 'but the ready flag is public');

  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', clues }).ok, true);
  assert.equal(room.phase, 'play', 'everyone ready -> first round');
  assert.equal(currentPlayer(room).id, host.id, 'everybody starts at month 0, so the host (first in) opens');
  assert.equal(viewFor(room, host.id).turnPlayerName, '阿甲');
  assert.deepEqual(viewFor(room, host.id).players.map((p) => p.time), [0, 0], 'every pawn starts at the beginning');
});

test('setup validates the initial clues', () => {
  const { room, host } = lobby('standard', 12);
  applyRoomAction(room, host.id, { kind: 'start-game' });
  const bad = [
    [{ sector: 99, type: Obj.COMET }, /扇区/],
    [{ sector: 1, type: Obj.PLANET_X }, /天体/],
    [{ sector: 1, type: Obj.EMPTY }, /天体/],
    [{ sector: 1, type: Obj.COMET }, /最多填 12 条/, MAX_SETUP_CLUES + 1],
  ];
  for (const [clue, pattern, count] of bad) {
    const clues = count ? Array.from({ length: count }, (unused, index) => ({ sector: index % 12, type: index < 12 ? Obj.ASTEROID : Obj.GAS_CLOUD })) : [clue];
    const res = applyRoomAction(room, host.id, { kind: 'setup', clues, topics: {} });
    assert.equal(res.ok, false, JSON.stringify(clue));
    assert.match(res.error, pattern);
  }
  const twelve = Array.from({ length: MAX_SETUP_CLUES }, (_, sector) => ({ sector, type: Obj.ASTEROID }));
  const full = applyRoomAction(room, host.id, { kind: 'setup', clues: twelve, topics: {} });
  assert.equal(full.ok, true, full.error);
  assert.equal(room.setup[host.id].clues.length, MAX_SETUP_CLUES, 'all twelve are kept');
  const ok = applyRoomAction(room, host.id, {
    kind: 'setup',
    clues: [{ sector: 1, type: Obj.COMET }, { sector: 1, type: Obj.COMET }],
    topics: {},
  });
  assert.equal(ok.ok, false);
  assert.match(ok.error, /12 条不同/);
  assert.equal(room.setup[host.id].clues.length, 12);
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup', noClues: true, topics: {} }).ok, false);
  assert.equal(room.setup[host.id].clues.length, 12);
  assert.equal(CLUE_TYPES.includes(Obj.EMPTY), false);
});

test('setup only accepts ordinary-object exclusions on both board sizes', () => {
  const objectTypes = [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET];
  assert.deepEqual(CLUE_TYPES, objectTypes);
  for (const modeId of ['standard', 'expert']) {
    const { room, host } = lobby(modeId, 4);
    assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
    const snapshot = structuredClone(room.setup[host.id]);
    for (const type of [Obj.EMPTY, Obj.PLANET_X]) {
      const result = applyRoomAction(room, host.id, { kind: 'setup', clues: [{ sector: 0, type }] });
      assert.equal(result.ok, false);
      assert.match(result.error, /初始线索的天体/u);
      assert.deepEqual(room.setup[host.id], snapshot, 'an invalid clue does not change the setup card');
    }
    const clues = objectTypes.map((type, sector) => ({ sector, type }));
    assert.equal(applyRoomAction(room, host.id, { kind: 'setup', clues }).ok, true);
    assert.deepEqual(room.setup[host.id].clues, clues);
  }
});

test('somebody joining during setup still gets a setup card', () => {
  const { room, host, guest } = lobby();
  applyRoomAction(room, host.id, { kind: 'start-game' });
  const late = addPlayer(room, '阿丙');
  assert.ok(room.setup[late.id], 'a card exists for the late joiner');
  assert.equal(room.setup[late.id].ready, false);

  assert.equal(applyRoomAction(room, host.id, { kind: 'setup', noClues: true }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', noClues: true }).ok, true);
  assert.equal(room.phase, 'setup', 'still waiting for the late joiner');
  assert.equal(applyRoomAction(room, late.id, { kind: 'setup', noClues: true }).ok, true);
  assert.equal(room.phase, 'play', 'now everyone is ready');
});

test('recording is refused until the setup cards are in', () => {
  const { room, host } = lobby();
  applyRoomAction(room, host.id, { kind: 'start-game' });
  const res = applyRoomAction(room, host.id, { kind: 'wait' });
  assert.equal(res.ok, false);
  assert.match(res.error, /初始线索/);
});

// ---- turn order ------------------------------------------------------------

test('only the player whose turn it is may act, and acting passes the turn on', () => {
  const { room, host, guest } = playing();
  assert.equal(currentPlayer(room).id, host.id, 'the host starts');

  const tooEarly = applyRoomAction(room, guest.id, { kind: 'wait' });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /轮到 阿甲/);

  assert.equal(applyRoomAction(room, host.id, { kind: 'wait' }).ok, true);
  assert.equal(currentPlayer(room).id, guest.id, 'the turn moved on');
  assert.equal(applyRoomAction(room, host.id, { kind: 'wait' }).ok, false, 'and it is no longer the host’s');

  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, true);
  assert.equal(currentPlayer(room).id, host.id, 'two players alternate');
});

test('free actions (conference, review, nudge) move nobody’s pawn', () => {
  const { room, host, guest } = playing();
  assert.equal(applyRoomAction(room, guest.id, { kind: 'nudge', delta: 1 }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'conference', sector: 10, text: 'x' }).ok, true);
  assert.equal(currentPlayer(room).id, host.id, 'the same pawn is still the one to act');
  assert.deepEqual(viewFor(room, host.id).players.map((p) => p.time), [0, 0], 'nobody spent time');

  // publishing is not free any more: it belongs to a triggered research phase
  const early = applyRoomAction(room, host.id, { kind: 'theory', sector: 0, type: Obj.COMET });
  assert.equal(early.ok, false);
  assert.match(early.error, /学术研究/);
  assert.equal(viewFor(room, guest.id).entries.length, 1, 'only the conference is a log entry (a nudge is not)');
});

test('the host can skip a turn, which costs the current player a month', () => {
  const { room, host, guest } = playing();
  assert.equal(applyRoomAction(room, guest.id, { kind: 'skip-turn' }).ok, false, 'only the host');
  assert.equal(applyRoomAction(room, host.id, { kind: 'skip-turn' }).ok, true);
  const pawns = viewFor(room, host.id).players.reduce((acc, p) => ({ ...acc, [p.name]: p.time }), {});
  assert.equal(pawns['阿甲'], 1, 'the skipped player paid a month');
  assert.equal(pawns['阿乙'], 0);
  resolveResearch(room);
  assert.equal(currentPlayer(room).id, guest.id, 'and the table moves on');
});

test('undoing winds the pawn back and hands the turn over again', () => {
  const { room, host, guest } = playing();
  assert.equal(applyRoomAction(room, host.id, { kind: 'wait' }).ok, true);
  assert.equal(currentPlayer(room).id, guest.id);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, true);

  assert.equal(applyRoomAction(room, host.id, { kind: 'undo' }).ok, false, 'the last step is not the host’s');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'undo' }).ok, true);
  assert.equal(viewFor(room, host.id).players.find((p) => p.name === '阿乙').time, 0, 'the guest’s pawn went back');
  assert.equal(applyRoomAction(room, host.id, { kind: 'undo' }).ok, true, 'and now the host may undo too');
  assert.equal(currentPlayer(room).id, host.id);
});

// ---- shared board vs private observations ----------------------------------

test('everybody has a private clock, but the log and the board are shared', () => {
  const { room, host, guest } = playing();

  // a straight alternation: the host opens, then the guest, then the host again
  assert.equal(step(room, host.id, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 6, count: 3 }).ok, true);
  assert.equal(step(room, guest.id, { kind: 'target', sector: 2, apparent: Obj.EMPTY }).ok, true);
  assert.equal(step(room, host.id, { kind: 'research', topic: 'A', name: '小行星带', text: '编号之和 30' }).ok, true);

  const hostView = viewFor(room, host.id);
  const guestView = viewFor(room, guest.id);

  // one log, two pawns, one shared sky window that follows the pawn furthest behind
  assert.equal(hostView.time, 4, 'three months of survey plus one of research');
  assert.equal(guestView.time, 4, 'the guest paid four months for their scan');
  assert.equal(hostView.arrowSector, 5, 'the tied pawns stand at month four');
  assert.equal(guestView.arrowSector, 5, 'and everybody reads the same window');
  assert.deepEqual(hostView.visible, guestView.visible, 'one dial, not two');
  assert.equal(hostView.windowPlayerName, '阿乙');
  assert.equal(guestView.windowPlayerId, guest.id);
  assert.equal(guestView.recordCount, 3, 'the guest sees that three actions happened');
  assert.equal(guestView.knowledge.surveys.length, 1, 'and what was surveyed');
  assert.equal(guestView.knowledge.surveys[0].surveyType, Obj.ASTEROID);
  assert.equal(guestView.knowledge.surveys[0].start, 0);
  assert.equal(guestView.knowledge.surveys[0].size, 6);

  // private
  assert.equal(hostView.knowledge.surveys[0].count, 3);
  assert.equal(guestView.knowledge.surveys[0].count, undefined, 'survey counts are private');
  assert.equal(guestView.knowledge.targets[0].apparent, Obj.EMPTY, 'the guest keeps their own scan');
  assert.equal(hostView.knowledge.targets[0].apparent, undefined, 'scan results are private');
  assert.equal(hostView.knowledge.targets[0].sector, 2, 'but the scanned sector is public');
  assert.equal(hostView.knowledge.clues[0].text, '编号之和 30');
  assert.equal(guestView.knowledge.clues[0].text, undefined, 'research clue text is private');
  assert.equal(guestView.knowledge.clues[0].topic, 'A', 'the subject is public knowledge');
  assert.equal(hostView.topics.A.name, '阿甲的课题', 'the A–F names come from the host’s setup');
  assert.equal(guestView.topics.A.name, '阿甲的课题', 'and are the same for the whole table');
  assert.equal(hostView.topics.A.clue, '编号之和 30', 'the clue text under a subject stays private');
  assert.equal(guestView.topics.A.clue, '', 'nobody else sees what I learned');
  assert.equal(guestView.topics.B.name, '', 'unnamed subjects stay blank');
});

test('per-player limits: scan markers and research subjects', () => {
  const { room, host, guest } = playing();
  for (let scan = 0; scan < MAX_TARGET_USES; scan++) {
    passTo(room, host.id);
    const sector = viewFor(room, host.id).visible[0];
    const res = applyRoomAction(room, host.id, { kind: 'target', sector, apparent: Obj.EMPTY });
    assert.equal(res.ok, true, res.error);
    resolveResearch(room);
  }
  assert.equal(viewFor(room, host.id).targetUses, 0);
  assert.equal(viewFor(room, guest.id).targetUses, MAX_TARGET_USES, 'the guest still has both markers');
  const blocked = act(room, host.id, { kind: 'target', sector: viewFor(room, host.id).visible[0], apparent: Obj.COMET });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /用完/);

  assert.equal(act(room, host.id, { kind: 'research', topic: 'C', name: 'c', text: 'c' }).ok, true);
  assert.equal(act(room, guest.id, { kind: 'research', topic: 'C', name: 'c2', text: 'c2' }).ok, true, 'the guest may research the same subject');
  assert.equal(act(room, host.id, { kind: 'research', topic: 'C', name: 'again', text: 'again' }).ok, false);
});

test('official action costs charge only the acting pawn', () => {
  const actions = [
    ...[[1, 4], [3, 4], [4, 3], [6, 3], [7, 2], [9, 2]].map(([size, cost]) => ({ action: { kind: 'survey', type: Obj.ASTEROID, start: 0, size, count: 0 }, cost })),
    { action: { kind: 'target', sector: 0, apparent: Obj.EMPTY }, cost: 4 },
    { action: { kind: 'research', topic: 'A', text: '线索' }, cost: 1 },
    { action: { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: false }, cost: 5 },
  ];
  for (const { action, cost } of actions) {
    const { room, host, guest } = playing('expert');
    const result = accepted(room, host.id, action);
    assert.equal(result.entry.cost, cost, JSON.stringify(action));
    assert.deepEqual(viewFor(room, guest.id).players.map((player) => player.time), [cost, 0]);
    assert.equal(viewFor(room, guest.id).windowTime, 0);
    assert.equal(room.phase, 'play');
  }
});

test('research restrictions survive another player and free records until an own turn intervenes', () => {
  const { room, host, guest } = playing();
  accepted(room, host.id, { kind: 'research', topic: 'A', text: '甲的线索' });
  accepted(room, guest.id, { kind: 'research', topic: 'A', text: '乙的线索' });
  accepted(room, host.id, { kind: 'conference', sector: 10, text: '公共会议' });
  accepted(room, guest.id, { kind: 'nudge', delta: 0 });
  const before = structuredClone(room.session);
  const refused = applyRoomAction(room, host.id, { kind: 'research', topic: 'B', text: '不能连续' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /连续/);
  assert.equal(viewFor(room, host.id).lastWasResearch, true);
  assert.deepEqual(room.session, before);
  accepted(room, host.id, { kind: 'wait' });
  accepted(room, guest.id, { kind: 'wait' });
  assert.equal(room.research, null);
  accepted(room, host.id, { kind: 'wait' });
  accepted(room, guest.id, { kind: 'wait' });
  assert.equal(room.research.sector, 3);
  resolveResearch(room);
  assert.equal(viewFor(room, host.id).lastWasResearch, false);
  accepted(room, host.id, { kind: 'research', topic: 'B', text: '现在可以研究' });
  assert.deepEqual(viewFor(room, host.id).researched, ['A', 'B']);
});

// ---- the research phase ----------------------------------------------------

/** Walk a player's pawn onto a theory sector, which opens the table's research phase. */
function walkToTheorySector(room, playerId) {
  for (let guard = 0; guard < 24; guard++) {
    if (room.research) return room.research;
    assert.equal(viewFor(room, playerId).awaitingReview.length, 0, 'review papers before walking to another phase');
    const who = currentPlayer(room);
    assert.ok(who, 'a theory crossing requires normal play');
    const result = applyRoomAction(room, who.id, { kind: 'wait' });
    assert.equal(result.ok, true, result.error);
  }
  assert.fail('no research phase was triggered');
}

/** Publish one paper as whoever the phase says is next. */
function publishNext(room, sector, objectType) {
  const id = room.research && room.research.cursorId;
  assert.ok(id, 'somebody is at the cursor');
  const res = applyRoomAction(room, id, { kind: 'research-submit', phaseId: room.research.id, sector, objectType });
  assert.equal(res.ok, true, res.error);
  return res;
}

test('the shared window opens a research phase when it passes a research sector', () => {
  const { room, host, guest } = playing();
  assert.equal(room.research, null, 'nothing is open at the start');
  assert.equal(windowTimeOf(room), 0);

  // the window follows the pawn furthest behind, so one player running ahead moves nothing
  applyRoomAction(room, host.id, { kind: 'wait' }); // host 1, guest 0
  assert.equal(windowTimeOf(room), 0, 'the window stays with the laggard');
  assert.equal(room.research, null);
  const view = viewFor(room, host.id);
  assert.equal(view.windowPlayerName, '阿乙');
  assert.equal(view.arrowSector, 1);

  applyRoomAction(room, guest.id, { kind: 'wait' }); // both 1 -> window 0 -> 1 (sector 2)
  assert.equal(windowTimeOf(room), 1);
  assert.equal(room.research, null, 'sector 2 is not a research sector');

  applyRoomAction(room, host.id, { kind: 'wait' }); // host 2, guest 1 -> the window waits
  assert.equal(windowTimeOf(room), 1, 'the window only moves when the laggard moves');
  assert.equal(room.research, null);

  applyRoomAction(room, guest.id, { kind: 'wait' });
  assert.equal(room.research, null, 'entering sector 3 does not trigger the phase');
  applyRoomAction(room, host.id, { kind: 'wait' });
  assert.equal(room.research, null);
  applyRoomAction(room, guest.id, { kind: 'wait' });
  assert.ok(room.research, 'the window passed sector 3');
  assert.equal(room.research.id, 'theory:3');
  assert.equal(viewFor(room, host.id).research.id, room.research.id);
  assert.equal(viewFor(room, host.id).research.sector, 3);
  assert.equal(viewFor(room, host.id).research.quota, 1, 'a standard board allows one paper per phase');
  assert.equal(viewFor(room, host.id).research.allDeclared, false);
  assert.equal(viewFor(room, host.id).research.myCount, null);

  // turn actions wait for the phase to finish
  const blocked = applyRoomAction(room, currentPlayer(room).id, { kind: 'wait' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /学术研究阶段/);

  // everybody declares at once, then nobody may change their mind
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 }).ok, true);
  const twice = applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
  assert.equal(twice.ok, false);
  assert.match(twice.error, /选过篇数/);
  const silly = applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 5 });
  assert.equal(silly.ok, false);
  assert.match(silly.error, /篇数只能是 0 到 1/);
  assert.equal(viewFor(room, host.id).research.declaredCount, 1);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 }).ok, true);
  const open = viewFor(room, host.id).research;
  assert.deepEqual(open.orderNames, ['阿甲'], 'only the host wants to publish');
  assert.equal(open.isMyPick, true, 'and it is their turn to do it');
});

test('publishing runs from the player furthest behind, and the claimed object stays private', () => {
  const { room, host, guest } = playing();
  // push both pawns around so the order is unambiguous: the host spends more
  act(room, host.id, { kind: 'wait' }); // host: 1
  act(room, guest.id, { kind: 'wait' }); // guest: 1
  // a survey may only cover visible sectors, so start from the shared window's first sector
  act(room, host.id, { kind: 'survey', type: Obj.ASTEROID, start: viewFor(room, host.id).visible[0], size: 6, count: 1 });
  const phase = walkToTheorySector(room, guest.id);
  assert.ok(phase, 'a research phase is open');
  const times = viewFor(room, host.id).players.map((p) => `${p.name}:${p.time}`);
  assert.deepEqual(times, ['阿甲:4', '阿乙:3'], 'the guest left the marker while waiting');

  applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: phase.id, count: 1 });
  applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: phase.id, count: 1 });
  const view = viewFor(room, host.id);
  assert.deepEqual(view.research.orderNames, ['阿乙', '阿甲'], 'the player furthest behind publishes first');
  assert.equal(view.research.cursorId, guest.id);
  assert.equal(view.research.isMyPick, false, 'and the host waits for their turn');

  const outOfOrder = applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: phase.id, sector: 1, objectType: Obj.COMET });
  assert.equal(outOfOrder.ok, false);
  assert.match(outOfOrder.error, /轮到 ?阿乙/);

  const mine = applyRoomAction(room, guest.id, { kind: 'research-submit', phaseId: phase.id, sector: 5, objectType: Obj.GAS_CLOUD });
  assert.equal(mine.ok, true);
  assert.equal(mine.entry.slot, 4);
  const hostNow = viewFor(room, host.id);
  assert.equal(hostNow.knowledge.theories[0].sector, 5, 'the sector is public');
  assert.equal(hostNow.knowledge.theories[0].objectType, undefined, 'the object is not');
  assert.equal(viewFor(room, guest.id).knowledge.theories[0].objectType, Obj.GAS_CLOUD, 'but the author keeps it');
  assert.equal(hostNow.research.isMyPick, true, 'and the cursor moved on');

  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: phase.id, sector: 8, objectType: Obj.DWARF_PLANET }).ok, true);
  assert.equal(room.research, null, 'the phase closes when everybody has published');
  assert.deepEqual(
    viewFor(room, host.id).knowledge.theories.map((t) => t.slot),
    [3, 3],
    'the phase is over, so both papers of that round stepped forward together',
  );
});

test('an expert table hands out two papers per phase, a standard one hands out one', () => {
  const room = createRoom({ modeId: 'expert', hostName: '甲', initialClueCount: 0 });
  const host = room.players[0];
  const guest = addPlayer(room, '乙');
  applyRoomAction(room, host.id, { kind: 'start-game' });
  for (const p of [host, guest]) applyRoomAction(room, p.id, { kind: 'setup', noClues: true });
  assert.equal(room.phase, 'play');
  const phase = walkToTheorySector(room, host.id);
  assert.equal(phase.quota, 2);
  assert.equal(viewFor(room, host.id).research.maxDeclare, 2);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: phase.id, count: 2 }).ok, true);
  const again = applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: phase.id, count: 1 });
  assert.equal(again.ok, false);
  assert.match(again.error, /选过篇数/);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: phase.id, count: 0 }).ok, true);
  assert.equal(room.research.order.length, 1, 'the guest passed');
  assert.equal(viewFor(room, host.id).research.left, 2, 'an expert player may publish two papers');
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: phase.id, sector: 2, objectType: Obj.COMET }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: phase.id, sector: 4, objectType: Obj.GAS_CLOUD }).ok, true);
  assert.equal(room.research, null, 'two is the expert limit');
  assert.equal(viewFor(room, host.id).knowledge.theories.length, 2);
});

test('expert declaration capacity counts distinct available sectors, not remaining object types', () => {
  const { room, host, guest } = playing('expert');
  const finishReviews = () => {
    const pending = room.session.entries.filter((entry) => entry.type === 'theory' && entry.review === 'pending' && entry.slot <= 1)
      .sort((first, second) => first.sector - second.sector);
    for (const paper of pending) accepted(room, host.id, { kind: 'review', id: paper.id, review: 'correct' });
  };
  for (let sector = 0; sector < 17; sector += 2) {
    const phaseId = walkToTheorySector(room, host.id).id;
    const sectors = [sector, sector + 1].filter((candidate) => candidate < 17);
    accepted(room, host.id, { kind: 'research-declare', phaseId, count: sectors.length });
    accepted(room, guest.id, { kind: 'research-declare', phaseId, count: 0 });
    for (const target of sectors) publishNext(room, target, Obj.ASTEROID);
    finishReviews();
  }
  for (let advance = 0; advance < 2; advance++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
    finishReviews();
  }
  const phaseId = walkToTheorySector(room, host.id).id;
  assert.equal(viewFor(room, host.id).theoryLockedSectors.length, 17);
  const before = structuredClone(room);
  const refused = applyRoomAction(room, host.id, { kind: 'research-declare', phaseId, count: 2 });
  assert.equal(refused.ok, false);
  assert.deepEqual(room, before);
  assert.equal(viewFor(room, host.id).research.quota, 2);
  assert.equal(viewFor(room, host.id).research.maxDeclare, 1);
  accepted(room, host.id, { kind: 'research-declare', phaseId, count: 1 });
  accepted(room, guest.id, { kind: 'research-declare', phaseId, count: 1 });
  publishNext(room, 17, Obj.ASTEROID);
  assert.equal(viewFor(room, host.id).research.maxDeclare, 0);
  assert.equal(viewFor(room, guest.id).research.maxDeclare, 1);
  assert.equal(viewFor(room, guest.id).research.picks[0].objectType, undefined);
  publishNext(room, 17, Obj.GAS_CLOUD);
  walkToTheorySector(room, host.id);
  assert.equal(viewFor(room, host.id).research.maxDeclare, 1);
  assert.equal(viewFor(room, guest.id).research.maxDeclare, 1);
});

test('a peer review that says correct reveals the whole sector and locks it', () => {
  const { room, host, guest } = playing();
  // both players publish about the same sector: one right, one wrong
  act(room, host.id, { kind: 'wait' });
  act(room, guest.id, { kind: 'wait' });
  walkToTheorySector(room, host.id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  // the phase dictates who publishes first, so always follow the cursor
  const first = publishNext(room, 2, Obj.COMET);
  const second = publishNext(room, 2, Obj.DWARF_PLANET);
  const author = first.entry.actorId;
  const other = second.entry.actorId;
  assert.notEqual(author, other);

  walkToTheorySector(room, host.id);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 }).ok, true);
  const later = publishNext(room, 6, Obj.ASTEROID);
  assert.equal(first.entry.slot, 2);
  walkToTheorySector(room, host.id);
  resolveResearch(room);
  const paper = viewFor(room, host.id).knowledge.theories.find((theory) => theory.id === first.entry.id);
  assert.equal(paper.slot, 1, 'the paper reached the review slot');
  assert.equal(viewFor(room, author).myPendingReviews.length >= 1, true, 'and the author is prompted');
  assert.equal(viewFor(room, author).myPendingReviews.includes(paper.id), true);

  const clocksBefore = viewFor(room, host.id).players.map((player) => player.time);
  assert.equal(applyRoomAction(room, author, { kind: 'review', id: paper.id, review: 'correct' }).ok, true);
  const outsider = author === host.id ? guest.id : host.id;
  const outsiderView = viewFor(room, outsider);
  const revealedPaper = outsiderView.knowledge.theories.find((t) => t.id === paper.id);
  assert.equal(revealedPaper.objectType, Obj.COMET, 'the revealed sector shows the object to everybody');
  assert.equal(revealedPaper.review, 'correct');
  const settled = outsiderView.knowledge.theories.find((t) => t.id === second.entry.id);
  assert.equal(settled.objectType, Obj.DWARF_PLANET, 'and settles the other paper');
  assert.equal(settled.review, 'wrong', 'which did not match the revealed contents');
  assert.equal(settled.reviewInferred, true);
  assert.deepEqual(outsiderView.players.map((player, index) => player.time - clocksBefore[index]), room.players.map((player) => player.id === other ? 1 : 0));
  assert.deepEqual(room.session.entries.filter((entry) => entry.type === 'penalty').map((entry) => entry.theoryId), [second.entry.id]);
  const reviewedState = structuredClone(room.session);
  assert.equal(applyRoomAction(room, author, { kind: 'review', id: paper.id, review: 'correct' }).ok, true);
  assert.equal(applyRoomAction(room, other, { kind: 'review', id: second.entry.id, review: 'wrong' }).ok, true);
  assert.deepEqual(room.session, reviewedState, 'duplicate direct and inferred verdicts do not charge twice');
  assert.deepEqual(outsiderView.theoryLockedSectors, [2], 'the sector is locked for later research');
  assert.deepEqual(viewFor(room, host.id).awaitingReview, []);
  const travelling = later.entry;
  assert.equal(travelling.slot, 2, 'the later paper is still travelling');
  const tooEarly = applyRoomAction(room, travelling.actorId, { kind: 'review', id: travelling.id, review: 'correct' });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /推进到 1 才能确认/);

  // nobody may publish about a revealed sector again
  walkToTheorySector(room, currentPlayer(room).id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  const who = viewFor(room, host.id).research.cursorId;
  const locked = applyRoomAction(room, who, { kind: 'research-submit', phaseId: room.research.id, sector: 2, objectType: Obj.COMET });
  assert.equal(locked.ok, false);
  assert.match(locked.error, /已经公开/);
  assert.equal(applyRoomAction(room, host.id, { kind: 'skip-turn' }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'skip-turn' }).ok, true);
  assert.equal(room.research, null);
});

test('only the author (or the host) may report a peer review', () => {
  const { room, host, guest } = lobby();
  const third = addPlayer(room, '阿丙');
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  for (const player of room.players) assert.equal(applyRoomAction(room, player.id, { kind: 'setup', noClues: true }).ok, true);
  act(room, host.id, { kind: 'wait' });
  walkToTheorySector(room, currentPlayer(room).id);
  for (const player of room.players) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  const paper = publishNext(room, 4, Obj.COMET);
  const author = paper.entry.actorId;
  const stranger = [host, guest, third].find((p) => p.id !== author && p.id !== room.hostId);
  assert.ok(stranger, 'there is a player who is neither the author nor the host');
  const refused = applyRoomAction(room, stranger.id, { kind: 'review', id: paper.entry.id, review: 'correct' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /作者/);
  // the host may fill it in for a disconnected author — but only once the paper is at slot 1
  const early = applyRoomAction(room, room.hostId, { kind: 'review', id: paper.entry.id, review: 'correct' });
  assert.equal(early.ok, false, 'a paper still travelling cannot be settled');
  while (room.research) assert.equal(applyRoomAction(room, host.id, { kind: 'skip-turn' }).ok, true);
  for (let phase = 0; phase < 2; phase++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
  }
  assert.equal(paper.entry.slot, 1);
  const hostReview = applyRoomAction(room, host.id, { kind: 'review', id: paper.entry.id, review: 'correct' });
  assert.equal(hostReview.ok, true, hostReview.error);
});

test('a wrong peer review costs the author a month', () => {
  const { room, host, guest } = playing();
  act(room, host.id, { kind: 'wait' });
  act(room, guest.id, { kind: 'wait' });
  walkToTheorySector(room, host.id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  const first = publishNext(room, 10, Obj.COMET);
  publishNext(room, 11, Obj.DWARF_PLANET);
  const authorId = first.entry.actorId;
  for (let phase = 0; phase < 2; phase++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
  }
  assert.equal(first.entry.slot, 1, 'two zero-submission phases brought the paper to review');
  const before = viewFor(room, host.id).players.find((p) => p.id === authorId).time;

  assert.equal(applyRoomAction(room, authorId, { kind: 'review', id: first.entry.id, review: 'wrong' }).ok, true);
  const after = viewFor(room, host.id).players.find((p) => p.id === authorId).time;
  assert.equal(after, before + 1, 'the author’s own pawn moved one month');
  const penalty = room.session.entries.find((e) => e.type === 'penalty');
  assert.ok(penalty, 'and the log says why');
  assert.equal(penalty.actorId, authorId);
  assert.equal(penalty.cost, 1);
  const outsiderId = authorId === host.id ? guest.id : host.id;
  const rejected = viewFor(room, outsiderId).knowledge.theories.find((theory) => theory.id === first.entry.id);
  assert.equal(rejected.revealed, true, 'wrong papers are public too');
  assert.equal(rejected.objectType, Obj.COMET);
  const reviewedState = structuredClone(room.session);
  assert.equal(applyRoomAction(room, authorId, { kind: 'review', id: first.entry.id, review: 'wrong' }).ok, true);
  assert.equal(applyRoomAction(room, authorId, { kind: 'review', id: first.entry.id, review: 'correct' }).ok, false);
  assert.deepEqual(room.session, reviewedState, 'retries and contradictory verdicts never add another penalty');
});

test('ordered reviews expose one sector at a time and batch wrong matching papers in player order', () => {
  const { room, host, guest } = playing('expert');
  walkToTheorySector(room, host.id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 2 });
  const hostLower = publishNext(room, 1, Obj.COMET).entry;
  const hostHigher = publishNext(room, 4, Obj.GAS_CLOUD).entry;
  const guestLower = publishNext(room, 1, Obj.COMET).entry;
  const guestHigher = publishNext(room, 4, Obj.GAS_CLOUD).entry;
  for (let phase = 0; phase < 2; phase++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
  }
  for (const player of [host, guest]) {
    const view = viewFor(room, player.id);
    assert.deepEqual(view.knowledge.theories.map((paper) => paper.slot), [1, 1, 1, 1]);
    assert.deepEqual(view.knowledge.theories.map((paper) => paper.revealed), [true, false, true, false]);
    const otherPapers = view.knowledge.theories.filter((paper) => paper.actorId !== player.id);
    assert.equal(otherPapers.find((paper) => paper.sector === 1).objectType, Obj.COMET);
    assert.equal(Object.hasOwn(otherPapers.find((paper) => paper.sector === 4), 'objectType'), false);
  }
  const before = structuredClone(room.session);
  const tooEarly = applyRoomAction(room, host.id, { kind: 'review', id: hostHigher.id, review: 'correct' });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /先完成 2 号扇区/);
  assert.deepEqual(room.session, before);
  assert.deepEqual(turnOrder(room).map((player) => player.id), [host.id, guest.id]);
  const reviewed = accepted(room, guest.id, { kind: 'review', id: guestLower.id, review: 'wrong' });
  assert.deepEqual(reviewed.penalties.map((penalty) => ({ actorId: penalty.actorId, theoryId: penalty.theoryId, cost: penalty.cost })), [
    { actorId: host.id, theoryId: hostLower.id, cost: 1 },
    { actorId: guest.id, theoryId: guestLower.id, cost: 1 },
  ]);
  assert.equal(hostLower.reviewInferred, true);
  assert.equal(hostLower.review, 'wrong');
  assert.equal(guestLower.review, 'wrong');
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [10, 10]);
  assert.deepEqual(turnOrder(room).map((player) => player.id), [host.id, guest.id], 'batch penalties preserve player order despite the guest reporting first');
  for (const player of [host, guest]) {
    const view = viewFor(room, player.id);
    assert.deepEqual(view.awaitingReview, [hostHigher.id, guestHigher.id]);
    assert.equal(view.knowledge.theories.every((paper) => paper.revealed), true);
    assert.equal(view.knowledge.theories.filter((paper) => paper.sector === 4).every((paper) => paper.objectType === Obj.GAS_CLOUD), true);
  }
  const afterBatch = structuredClone(room.session);
  accepted(room, guest.id, { kind: 'review', id: guestLower.id, review: 'wrong' });
  accepted(room, host.id, { kind: 'review', id: hostLower.id, review: 'wrong' });
  assert.deepEqual(room.session, afterBatch, 'direct and inferred retries cannot repeat either penalty');
  accepted(room, host.id, { kind: 'review', id: hostHigher.id, review: 'correct' });
  assert.equal(guestHigher.review, 'correct');
  assert.deepEqual(viewFor(room, host.id).awaitingReview, []);
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [10, 10]);
  accepted(room, host.id, { kind: 'wait' });
});

test('the same sector: the earlier arrival acts first and publishes first', () => {
  const { room, host, guest } = playing();
  applyRoomAction(room, host.id, { kind: 'wait' }); // host: month 1, sector 2
  applyRoomAction(room, guest.id, { kind: 'wait' }); // guest: month 1, same sector, later
  assert.equal(currentPlayer(room).id, host.id, 'the earlier arrival acts first');
  assert.equal(windowTimeOf(room), 1, 'the window has moved up to month 1');

  applyRoomAction(room, host.id, { kind: 'wait' }); // host 2, guest 1 -> the window waits
  assert.equal(room.research, null, 'the window has not reached a research sector yet');
  applyRoomAction(room, guest.id, { kind: 'wait' });
  assert.equal(room.research, null, 'arriving at sector 3 does not open a phase');
  applyRoomAction(room, host.id, { kind: 'wait' });
  assert.equal(room.research, null, 'the window stays while another pawn is behind');
  applyRoomAction(room, guest.id, { kind: 'wait' });
  assert.ok(room.research, 'a phase opened');
  assert.deepEqual(viewFor(room, host.id).players.map((p) => p.time), [3, 3], 'both pawns are level');
  assert.equal(viewFor(room, host.id).players[0].sector, viewFor(room, host.id).players[1].sector, 'same sector');
  assert.deepEqual(turnOrder(room).map((p) => p.name), ['阿甲', '阿乙'], 'the earlier arrival acts first');
  assert.deepEqual(researchOrder(room).map((p) => p.name), ['阿甲', '阿乙'], 'and publishes first as well');

  for (const player of room.players) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  assert.deepEqual(viewFor(room, host.id).research.orderNames, ['阿甲', '阿乙'], 'the phase follows that order');
});

test('arrival priority beats join order when moving onto an occupied sector', () => {
  const { room, host, guest } = playing();
  assert.equal(applyRoomAction(room, host.id, { kind: 'wait' }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'target', sector: 0, apparent: Obj.ASTEROID }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'survey', type: Obj.ASTEROID, start: 1, size: 6, count: 2 }).ok, true);
  const view = viewFor(room, host.id);
  assert.deepEqual(view.players.map((player) => player.time), [4, 4]);
  assert.ok(view.players[0].arrival > view.players[1].arrival);
  assert.deepEqual(view.turnOrder, [guest.id, host.id]);
  assert.equal(currentPlayer(room).id, guest.id);
  const phaseId = room.research.id;
  for (const player of room.players) assert.equal(applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 1 }).ok, true);
  assert.deepEqual(viewFor(room, host.id).research.order, [guest.id, host.id]);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId, sector: 0, objectType: Obj.ASTEROID }).ok, false);
  const first = applyRoomAction(room, guest.id, { kind: 'research-submit', phaseId, sector: 0, objectType: Obj.ASTEROID });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.entry.stationSector, 3);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId, sector: 0, objectType: Obj.ASTEROID }).ok, true);
  assert.equal(currentPlayer(room).id, guest.id);
});

test('window arithmetic: which sectors the shared dial passed over', () => {
  assert.equal(crossedTheorySector(MODES.standard, 0, 1), 0, 'month 1 points at sector 2');
  assert.equal(crossedTheorySector(MODES.standard, 1, 2), 0, 'entering sector 3 is not a crossing');
  assert.equal(crossedTheorySector(MODES.standard, 0, 3), 3, 'a three month move crosses it once');
  assert.equal(crossedTheorySector(MODES.standard, 2, 3), 3, 'leaving the marker triggers it');
  assert.equal(crossedTheorySector(MODES.standard, 10, 11), 0);
  assert.equal(crossedTheorySector(MODES.standard, 11, 12), 12, 'wrapping leaves sector 12');
  assert.equal(crossedTheorySector(MODES.expert, 4, 5), 0);
  assert.equal(crossedTheorySector(MODES.expert, 16, 17), 0);
  assert.equal(crossedTheorySector(MODES.expert, 5, 6), 6);

  // conferences use the same arithmetic on their own schedule
  assert.equal(crossedConferenceSector(MODES.standard, 8, 9), 0);
  assert.equal(crossedConferenceSector(MODES.standard, 9, 10), 10);
  assert.equal(crossedConferenceSector(MODES.expert, 5, 6), 0);
  assert.equal(crossedConferenceSector(MODES.expert, 6, 7), 7);
  assert.equal(crossedConferenceSector(MODES.expert, 14, 15), 0);
  assert.equal(crossedConferenceSector(MODES.expert, 15, 16), 16);
  assert.deepEqual(crossedTheorySectors(MODES.standard, 0, 12), [3, 6, 9, 12], 'a full lap passes all four');
});

test('a wrong peer review moves the loser, and that month can move the window', () => {
  const { room, host, guest } = playing();
  walkToTheorySector(room, host.id);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 }).ok, true);
  const paper = publishNext(room, 4, Obj.COMET).entry;
  walkToTheorySector(room, host.id);
  resolveResearch(room);
  assert.equal(paper.slot, 2);
  assert.equal(applyRoomAction(room, host.id, { kind: 'wait' }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'target', sector: 7, apparent: Obj.EMPTY }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: false }).ok, true);
  assert.equal(room.research.sector, 9);
  resolveResearch(room);
  assert.equal(paper.slot, 1);
  assert.equal(windowTimeOf(room), 11, 'the host sets the window');
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [11, 12]);
  assert.equal(room.research, null);

  assert.equal(applyRoomAction(room, host.id, { kind: 'review', id: paper.id, review: 'wrong' }).ok, true);
  assert.equal(
    viewFor(room, host.id).players.find((p) => p.name === '阿甲').time,
    12,
    'the penalty month landed on the author',
  );
  assert.equal(windowTimeOf(room), 12, 'and the window moved with them');
  assert.ok(room.research, 'so it passed sector 12 and a phase opens');
  assert.equal(room.research.sector, 12);
});

test('a penalty that leaves the window where it was triggers nothing', () => {
  const { room, host, guest } = playing();
  walkToTheorySector(room, host.id);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 }).ok, true);
  const paper = publishNext(room, 6, Obj.GAS_CLOUD).entry;
  for (let phase = 0; phase < 2; phase++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
  }
  assert.equal(paper.slot, 1);
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [9, 9]);
  assert.equal(applyRoomAction(room, host.id, { kind: 'review', id: paper.id, review: 'wrong' }).ok, true);
  assert.equal(viewFor(room, host.id).players.find((player) => player.id === host.id).time, 10, 'the host moved');
  assert.equal(windowTimeOf(room), 9, 'but the window still follows the guest');
  assert.equal(room.research, null, 'so no research phase was set off');
  assert.equal(room.conference, null);
});

test('one research phase puts every paper of that round on the same track space', () => {
  const { room, host, guest } = playing();
  walkToTheorySector(room, currentPlayer(room).id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  publishNext(room, 2, Obj.COMET);
  publishNext(room, 5, Obj.DWARF_PLANET);
  const slots = () => room.session.entries.filter((e) => e.type === 'theory').map((e) => e.slot);
  assert.deepEqual(slots(), [3, 3], 'the phase closed, so both papers stepped forward together');

  // the next phase publishes one more paper: the whole track steps forward, the fresh
  // paper included, so the previous round stays one space ahead
  walkToTheorySector(room, currentPlayer(room).id);
  accepted(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  accepted(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
  publishNext(room, 7, Obj.ASTEROID);
  assert.deepEqual(slots(), [2, 2, 3], 'the second round follows the first one space behind');
  assert.deepEqual(
    viewFor(room, host.id).knowledge.theories.map((t) => t.slot),
    [2, 2, 3],
    'and the table sees it',
  );
  resolveResearch(room);
});

test('duplicate and same-phase conflicting claims do not consume a publication slot', () => {
  const { room, host, guest } = playing('expert');
  walkToTheorySector(room, host.id);
  accepted(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 2 });
  accepted(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
  const first = publishNext(room, 2, Obj.COMET).entry;
  for (const objectType of [Obj.COMET, Obj.ASTEROID]) {
    const sessionBefore = structuredClone(room.session);
    const phaseBefore = structuredClone(room.research);
    const refused = applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 2, objectType });
    assert.equal(refused.ok, false);
    assert.match(refused.error, objectType === Obj.COMET ? /重复/ : /同一学术研究阶段/);
    assert.deepEqual(room.session, sessionBefore);
    assert.deepEqual(room.research, phaseBefore);
  }
  publishNext(room, 4, Obj.GAS_CLOUD);
  walkToTheorySector(room, host.id);
  accepted(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  accepted(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
  const duplicate = applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 2, objectType: Obj.COMET });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /重复/);
  assert.equal(room.research.left[host.id], 1);
  const revised = publishNext(room, 2, Obj.DWARF_PLANET).entry;
  assert.notEqual(first.publicationPhase, revised.publicationPhase, 'a different claim is legal in a later phase');
});

test('zero-submission phases advance papers and queued phases wait for every pending review', () => {
  const { room, host, guest } = playing();
  walkToTheorySector(room, host.id);
  accepted(room, host.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  accepted(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  const first = publishNext(room, 1, Obj.COMET).entry;
  const second = publishNext(room, 4, Obj.GAS_CLOUD).entry;
  walkToTheorySector(room, host.id);
  resolveResearch(room);
  assert.deepEqual([first.slot, second.slot], [2, 2]);
  accepted(room, host.id, { kind: 'wait' });
  accepted(room, guest.id, { kind: 'wait' });
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: false });
  assert.equal(room.phase, 'play', 'failed locates continue normal play');
  assert.equal(room.research.sector, 9);
  const reviewPhaseId = room.research.id;
  assert.equal(reviewPhaseId, 'theory:9');
  assert.deepEqual(room.pendingResearch.map((event) => event.sector), [12]);
  assert.deepEqual(room.pendingResearch[0], { kind: 'theory', id: 'theory:12', time: 12, sector: 12 });
  resolveResearch(room);
  assert.equal(room.research, null, 'the next crossed phase cannot open before reviews finish');
  assert.deepEqual([first.slot, second.slot], [1, 1]);
  assert.deepEqual(viewFor(room, host.id).awaitingReview, [first.id, second.id]);
  assert.deepEqual(room.pendingResearch.map((event) => event.sector), [12]);
  const pendingState = structuredClone(room.session);
  for (const action of [
    { kind: 'wait' },
    { kind: 'survey', type: Obj.ASTEROID, start: 11, size: 1, count: 0 },
    { kind: 'target', sector: 11, apparent: Obj.EMPTY },
    { kind: 'research', topic: 'A', text: '不能跳过评审' },
    { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true },
    { kind: 'skip-turn' },
    { kind: 'research-declare', phaseId: reviewPhaseId, count: 0 },
  ]) {
    const refused = applyRoomAction(room, host.id, action);
    assert.equal(refused.ok, false, action.kind);
    assert.deepEqual(room.session, pendingState, action.kind);
    assert.equal(room.research, null);
  }
  accepted(room, first.actorId, { kind: 'review', id: first.id, review: 'correct' });
  assert.equal(room.research, null, 'one unresolved author still blocks the queued phase');
  assert.deepEqual(viewFor(room, host.id).awaitingReview, [second.id]);
  accepted(room, second.actorId, { kind: 'review', id: second.id, review: 'correct' });
  assert.equal(room.research.sector, 12);
  assert.equal(viewFor(room, host.id).research.id, 'theory:12');
  assert.deepEqual(viewFor(room, host.id).awaitingReview, []);
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [12, 12]);
  resolveResearch(room);
  assert.equal(room.pendingResearch, null);
});

test('correct papers published in one phase share the leader bonus despite different entry ids', () => {
  const { room, host, guest } = playing();
  walkToTheorySector(room, host.id);
  for (const player of [host, guest]) accepted(room, player.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  const first = publishNext(room, 2, Obj.COMET).entry;
  const second = publishNext(room, 2, Obj.COMET).entry;
  assert.notEqual(first.id, second.id);
  assert.equal(first.publicationPhase, 'theory:3');
  assert.equal(first.publicationPhase, second.publicationPhase);
  for (let phase = 0; phase < 2; phase++) {
    walkToTheorySector(room, host.id);
    resolveResearch(room);
  }
  accepted(room, first.actorId, { kind: 'review', id: first.id, review: 'correct' });
  assert.equal(second.review, 'correct');
  assert.equal(second.reviewInferred, true);
  for (const player of [host, guest]) {
    assert.deepEqual(viewFor(room, player.id).scores.rows.map((row) => ({ theoryPoints: row.theoryPoints, leaderBonus: row.leaderBonus, total: row.total })), [
      { theoryPoints: 3, leaderBonus: 1, total: 4 },
      { theoryPoints: 3, leaderBonus: 1, total: 4 },
    ]);
  }
});

test('crossing a conference sector asks the table to look at the app', () => {
  const { room, host, guest } = playing();
  assert.equal(room.conference, null);
  // standard conferences sit on sector 10, so the prompt opens when a clock passes month 9
  for (let i = 0; i < 30 && !room.conference; i++) {
    step(room, currentPlayer(room).id, { kind: 'wait' });
  }
  assert.ok(room.conference, 'the crossing opened the prompt');
  assert.equal(room.conference.sector, 10);
  const view = viewFor(room, guest.id);
  assert.equal(view.conference.sector, 10, 'everybody sees the prompt');
  assert.ok(view.conference.byName, 'and who walked over it');
  assert.equal(view.knowledge.conferences.length, 0);

  // anybody may write the shared clue down, which answers the prompt
  const clue = applyRoomAction(room, guest.id, { kind: 'conference', sector: 10, text: 'X行星紧邻一颗彗星' });
  assert.equal(clue.ok, true, clue.error);
  assert.equal(room.conference, null, 'the prompt closes once the clue is in');
  assert.equal(viewFor(room, host.id).knowledge.conferences[0].text, 'X行星紧邻一颗彗星', 'and the table learns it');
  assert.equal(viewFor(room, host.id).conference, null);

  // the prompt does not open twice for a sector that is already written down
  resolveResearch(room);
  for (let i = 0; i < 30; i++) step(room, currentPlayer(room).id, { kind: 'wait' });
  assert.equal(room.conference, null, 'sector 10 stays quiet the second time round');
});

test('a pre-filled conference note is offered when the crossing happens', () => {
  const room = createRoom({ hostName: '阿甲', initialClueCount: 0 });
  const host = room.players[0];
  addPlayer(room, '阿乙');
  applyRoomAction(room, host.id, { kind: 'start-game' });
  applyRoomAction(room, host.id, { kind: 'setup', noClues: true, conferences: { 10: '房主先抄好的规律' } });
  applyRoomAction(room, room.players[1].id, { kind: 'setup', noClues: true });
  for (let i = 0; i < 30 && !room.conference; i++) step(room, currentPlayer(room).id, { kind: 'wait' });
  assert.ok(room.conference, 'the prompt still opens so the table can confirm the rule');
  assert.equal(viewFor(room, host.id).conference.text, '房主先抄好的规律', 'with the host’s note pre-filled');
  resolveResearch(room);
});

test('conferences are public, and only on the marked sectors', () => {
  const { room, host, guest } = playing();
  assert.equal(act(room, host.id, { kind: 'conference', sector: 4, text: 'x' }).ok, false);
  assert.equal(act(room, host.id, { kind: 'conference', sector: 12, text: 'x' }).ok, false, 'sector 12 is a theory phase');
  assert.equal(act(room, host.id, { kind: 'conference', sector: 10, text: 'X行星紧邻一颗彗星' }).ok, true);
  const view = viewFor(room, guest.id);
  assert.equal(view.knowledge.conferences[0].text, 'X行星紧邻一颗彗星', 'everyone learns the conference clue');
  assert.equal(act(room, guest.id, { kind: 'conference', sector: 10, text: 'dup' }).ok, false);
});

test('the A–F subject names are the table’s, and only the host writes them', () => {
  const room = createRoom({ hostName: '阿甲', initialClueCount: 0 });
  const host = room.players[0];
  const guest = addPlayer(room, '阿乙');
  applyRoomAction(room, host.id, { kind: 'start-game' });
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', noClues: true, topics: { A: '乙的课题' } }).ok, true);
  const hostCard = applyRoomAction(room, host.id, {
    kind: 'setup',
    noClues: true,
    topics: { A: '小行星带', B: '气体云走廊' },
    conferences: { 10: 'X行星紧邻一颗彗星', 4: '这条不应该存在' },
  });
  assert.equal(hostCard.ok, true);
  assert.equal(room.phase, 'play');
  assert.equal(room.topicNames.A, '小行星带', 'the host’s names are the table’s');
  assert.equal(room.topicNames.B, '气体云走廊');
  assert.deepEqual(room.conferenceRules, { 10: 'X行星紧邻一颗彗星' }, 'and only this board’s conference sectors count');

  const guestView = viewFor(room, guest.id);
  assert.equal(guestView.topics.A.name, '小行星带', 'everybody reads the same subject names');
  assert.equal(guestView.topicNames.B, '气体云走廊');
  assert.equal(guestView.conferenceRules[10], 'X行星紧邻一颗彗星');
  assert.deepEqual(guestView.conferenceRuleSectors, [10], 'a standard board has one conference');
  assert.equal(viewFor(room, host.id).amHost, true);
  assert.equal(guestView.amHost, false);

  // the host can correct the table-wide information later; a guest never can
  assert.equal(applyRoomAction(room, guest.id, { kind: 'set-topic-names', names: { A: '偷改' } }).ok, false);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'set-conference-rules', rules: { 10: '偷改' } }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'set-topic-names', names: { A: '彗星轨道' } }).ok, true);
  assert.equal(viewFor(room, guest.id).topics.A.name, '彗星轨道', 'the correction reaches the table');

  // the first player to research an unnamed subject names it for everybody
  const fresh = createRoom({ hostName: '丙', initialClueCount: 0 });
  const other = addPlayer(fresh, '丁');
  applyRoomAction(fresh, fresh.hostId, { kind: 'start-game' });
  for (const p of fresh.players) applyRoomAction(fresh, p.id, { kind: 'setup', noClues: true });
  assert.equal(fresh.topicNames.C, '', 'nobody named C yet');
  assert.equal(applyRoomAction(fresh, fresh.hostId, { kind: 'wait' }).ok, true, 'let the guest have the turn');
  assert.equal(applyRoomAction(fresh, other.id, { kind: 'research', topic: 'C', name: '彗星轨道', text: '两颗彗星相隔 3 格' }).ok, true);
  assert.equal(fresh.topicNames.C, '彗星轨道', 'the researcher’s name is adopted table-wide');
  assert.equal(viewFor(fresh, fresh.players[0].id).topics.C.name, '彗星轨道');
  assert.equal(viewFor(fresh, fresh.players[0].id).topics.C.clue, '', 'but the clue text stays with its author');
  assert.equal(viewFor(fresh, other.id).topics.C.clue, '两颗彗星相隔 3 格');
});

test('an expert table asks for two conference notes, a standard one for a single note', () => {
  const expert = createRoom({ modeId: 'expert', hostName: '阿甲', initialClueCount: 0 });
  addPlayer(expert, '阿乙');
  applyRoomAction(expert, expert.hostId, { kind: 'start-game' });
  const view = viewFor(expert, expert.hostId);
  assert.deepEqual(view.conferenceRuleSectors, [7, 16], 'sectors 7 and 16');
  assert.deepEqual(view.conferenceSectors, [7, 16], 'and the play-time conference block uses the same list');
  assert.equal(
    applyRoomAction(expert, expert.hostId, { kind: 'setup', noClues: true, conferences: { 7: '甲', 16: '乙', 10: '不存在', 99: '也不存在' } }).ok,
    true,
  );
  assert.deepEqual(expert.conferenceRules, { 7: '甲', 16: '乙' });
  assert.equal(viewFor(expert, expert.players[1].id).conferenceRules[16], '乙', 'shared with the guest');
});

test('a setup card can be filled in again while the table is still waiting', () => {
  const { room, host, guest } = lobby('standard', 4);
  const clues = [{ sector: 1, type: Obj.COMET }, { sector: 7, type: Obj.GAS_CLOUD }, { sector: 2, type: Obj.ASTEROID }, { sector: 5, type: Obj.DWARF_PLANET }];
  applyRoomAction(room, host.id, { kind: 'start-game' });
  applyRoomAction(room, host.id, { kind: 'setup', clues, noClues: false });
  assert.equal(readyCount(room), 1);
  assert.equal(viewFor(room, host.id).mySetup.ready, true);

  assert.equal(applyRoomAction(room, host.id, { kind: 'setup-reopen' }).ok, true);
  assert.equal(viewFor(room, host.id).mySetup.ready, false, 'the card is editable again');
  assert.equal(readyCount(room), 0);
  assert.deepEqual(viewFor(room, host.id).mySetup.clues, clues, 'what was typed is kept');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup-reopen' }).ok, true, 'anybody may reopen their own card');

  // and the card can be submitted again
  const revised = clues.map((clue) => ({ ...clue, type: Obj.GAS_CLOUD }));
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup', clues: revised }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', clues }).ok, true);
  assert.equal(room.phase, 'play');
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup-reopen' }).ok, false, 'no card to reopen once the round started');
});

test('the room plays the board the host picked', () => {
  const expert = createRoom({ modeId: 'expert', hostName: '阿甲', initialClueCount: 0 });
  addPlayer(expert, '阿乙');
  assert.equal(expert.modeId, 'expert');
  assert.equal(viewFor(expert, expert.hostId).mode.sectors, 18);
  assert.equal(viewFor(expert, expert.hostId).conferenceSectors.join(','), '7,16');
  assert.equal(expert.session.mode.visible, 9);

  const fallback = createRoom({ modeId: 'does-not-exist' });
  assert.equal(fallback.modeId, 'standard', 'an unknown board falls back instead of breaking the console');
  assert.equal(fallback.session.mode.sectors, 12);
  assert.equal(viewFor(fallback, fallback.hostId).mode.id, 'standard');

  // and the expert ring accepts sector 18 where the standard one stops at 12. A scan is
  // only allowed inside the visible sky window, so nudge the window onto the far end first.
  applyRoomAction(expert, expert.hostId, { kind: 'start-game' });
  for (const p of expert.players) applyRoomAction(expert, p.id, { kind: 'setup', noClues: true, topics: {} });
  assert.equal(viewFor(expert, expert.hostId).phase, 'play');
  applyRoomAction(expert, expert.hostId, { kind: 'nudge', delta: 9 });
  assert.equal(viewFor(expert, expert.hostId).visible.at(-1), 17, 'the window now covers sector 18');
  // the host waits so the guest is the one who is behind, i.e. whose turn it is
  assert.equal(applyRoomAction(expert, expert.hostId, { kind: 'wait' }).ok, true);
  const far = applyRoomAction(expert, expert.players[1].id, { kind: 'target', sector: 17, apparent: Obj.EMPTY });
  assert.equal(far.ok, true, 'sector 18 is on the expert board');
  // the same sector number is off the board entirely in standard mode
  const { room: std, host: stdHost } = playing();
  const offBoard = act(std, stdHost.id, { kind: 'target', sector: 17, apparent: Obj.EMPTY });
  assert.equal(offBoard.ok, false);
  assert.match(offBoard.error, /扇区编号不合法/);
});

test('the sky window can be nudged by anyone and is shared', () => {
  const { room, host, guest } = playing();
  assert.equal(viewFor(room, guest.id).visibleStart, 0);
  assert.equal(applyRoomAction(room, host.id, { kind: 'nudge', delta: 2 }).ok, true);
  assert.equal(viewFor(room, guest.id).visibleStart, 2, 'the nudge applies to the shared board');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'nudge', delta: -2 }).ok, true);
  assert.equal(viewFor(room, host.id).visibleStart, 0);
});

test('a correct locate waits for final choices and host reveal before ending the table', () => {
  const { room, host, guest } = playing();
  const guess = { sector: 0, left: Obj.EMPTY, right: Obj.COMET, correct: true };
  assert.equal(applyRoomAction(room, host.id, { kind: 'locate', ...guess }).ok, true);
  assert.equal(room.phase, 'final');
  assert.equal(room.session.status, 'final');
  const guestView = viewFor(room, guest.id);
  assert.equal(guestView.status, 'final');
  assert.deepEqual(guestView.players.map((player) => player.time), [5, 0]);
  assert.equal(guestView.endgame.firstFinderId, host.id);
  assert.equal(guestView.endgame.cursorId, guest.id);
  assert.equal(guestView.endgame.isMyTurn, true);
  assert.equal(guestView.endgame.behind, 5);
  assert.equal(guestView.endgame.quota, 2);
  assert.equal(guestView.endgame.canReveal, false);
  for (const field of ['sector', 'left', 'right']) {
    assert.equal(Object.hasOwn(guestView.locate, field), false);
    assert.equal(Object.hasOwn(guestView.summary.locate, field), false);
    assert.equal(Object.hasOwn(guestView.entries[0], field), false);
    assert.equal(viewFor(room, host.id).locate[field], guess[field]);
  }
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, false, 'ordinary turns stop during final opportunities');
  assert.equal(viewFor(room, guest.id).turnPlayerId, null);
  assert.equal(applyRoomAction(room, host.id, { kind: 'final-pass' }).ok, false);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'final-pass' }).ok, true);
  assert.equal(room.phase, 'reveal');
  assert.equal(room.session.status, 'reveal');
  assert.equal(viewFor(room, host.id).endgame.canReveal, true);
  assert.deepEqual(viewFor(room, host.id).endgame.players, [{ id: guest.id, name: guest.name, behind: 5, quota: 2, done: true, choice: 'final-pass' }]);
  const objects = [Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY];
  assert.equal(applyRoomAction(room, guest.id, { kind: 'reveal-objects', objects }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'reveal-objects', objects }).ok, true);
  assert.equal(room.phase, 'done');
  assert.equal(room.session.status, 'finished');
  assert.deepEqual(viewFor(room, guest.id).revealedObjects, objects);
  assert.equal(viewFor(room, guest.id).locate.sector, guess.sector, 'the guess is public only after reveal');
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), [5, 0]);
  assert.equal(viewFor(room, guest.id).windowTime, 0);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, false);
});

test('a player list carries each pawn and each player’s public progress', () => {
  const { room, host, guest } = playing();
  act(room, host.id, { kind: 'target', sector: 1, apparent: Obj.EMPTY });
  const view = viewFor(room, host.id);
  const h = view.players.find((p) => p.id === host.id);
  const g = view.players.find((p) => p.id === guest.id);
  assert.equal(h.scansLeft, MAX_TARGET_USES - 1);
  assert.equal(g.scansLeft, MAX_TARGET_USES);
  assert.equal(h.theories, 0);
  assert.equal(view.me, host.id);
  assert.equal(h.ready, true);
  assert.equal(h.time, 4, 'the scan cost the host four months');
  assert.equal(h.sector, 5, 'the pawn stands on the fifth sector');
  assert.equal(g.time, 0);
  assert.equal(g.sector, 1);
  assert.equal(h.isMe, true);
  assert.equal(g.isMe, false);
  assert.deepEqual(view.turnOrder.map((id) => (id === host.id ? 'host' : 'guest')), ['guest', 'host'], 'least time acts next');
});

// ---- wire format -----------------------------------------------------------

test('the view survives a JSON round trip intact (it travels over HTTP)', () => {
  const { room, host, guest } = playing();
  act(room, host.id, { kind: 'target', sector: 1, apparent: Obj.EMPTY });
  act(room, guest.id, { kind: 'research', topic: 'B', name: '彗星', text: '相隔 3 格' });

  for (const id of [host.id, guest.id]) {
    const view = viewFor(room, id);
    const wire = JSON.parse(JSON.stringify(view));
    assert.deepEqual(wire, JSON.parse(JSON.stringify(view)), 'stable');
    assert.ok(Array.isArray(wire.researched), 'Sets must be sent as arrays');
    assert.deepEqual(wire.researched, [...view.researched]);
    assert.equal(typeof wire.mySetup, 'object');
    assert.equal(typeof wire.phase, 'string');
    assert.equal(Array.isArray(wire.players), true);
    for (const fn of Object.values(wire)) {
      assert.notEqual(typeof fn, 'function', 'no functions in the payload');
    }
  }
  const guestView = JSON.parse(JSON.stringify(viewFor(room, guest.id)));
  assert.ok(guestView.knowledge.targets.some((t) => t.apparent === undefined), 'private fields are simply absent');
});

test('unknown actions, strangers and bad phases are rejected', () => {
  const { room, host } = playing();
  assert.equal(applyRoomAction(room, 'nope', { kind: 'wait' }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'sing' }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup' }).ok, false, 'setup is over');
  assert.equal(stateFor(room, 'nope').entries.length, 0);
  assert.equal(MODES.standard.sectors, 12);
});
