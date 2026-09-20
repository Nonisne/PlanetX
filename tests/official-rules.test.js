import test from 'node:test';
import assert from 'node:assert/strict';
import { COST, MODES, baseRuleText, surveyCost } from '../public/src/rules.js';
import * as engine from '../public/src/console.js';
import { createConsole, recordResearch, recordConference, recordSurvey, recordTheory, markTheoryReview, timeOf } from '../public/src/console.js';
import { addPlayer, applyRoomAction, createRoom, currentPlayer, viewFor } from '../public/src/room.js';
import { scoreBoard, scoreWinners } from '../public/src/score.js';

function accepted(room, player, action) {
  const bound = ['research-declare', 'research-submit'].includes(action.kind) ? { phaseId: room.research?.id, ...action } : action;
  const result = applyRoomAction(room, player.id, bound);
  assert.equal(result.ok, true, result.error);
  return result;
}

function playing(modeId = 'standard') {
  const room = createRoom({ modeId, hostName: '甲' });
  const host = room.players[0];
  const guest = addPlayer(room, '乙');
  accepted(room, host, { kind: 'start-game' });
  accepted(room, host, { kind: 'setup', noClues: true });
  accepted(room, guest, { kind: 'setup', noClues: true });
  return { room, host, guest };
}

test('official action costs advance by 4/3/2, 4, 1 and 5 sectors', () => {
  assert.deepEqual([surveyCost(1), surveyCost(4), surveyCost(7)], [4, 3, 2]);
  assert.deepEqual([COST.target, COST.research, COST.locate], [4, 1, 5]);
});

test('expert comet rules include 13 and 17 and surveys require comet endpoints', () => {
  const text = baseRuleText(MODES.expert).find((rule) => rule.includes('彗星'));
  assert.match(text, /13/);
  assert.match(text, /17/);
  assert.equal(recordSurvey(createConsole(), { type: 'comet', start: 0, size: 2, count: 0 }).ok, false);
  assert.equal(recordSurvey(createConsole(), { type: 'comet', start: 1, size: 3, count: 0 }).ok, false);
  assert.equal(recordSurvey(createConsole(), { type: 'comet', start: 1, size: 2, count: 0 }).ok, true);
});

test('research checks the same player last action despite another player acting', () => {
  const { room, host, guest } = playing();
  accepted(room, host, { kind: 'research', topic: 'A', text: '甲线索' });
  accepted(room, guest, { kind: 'research', topic: 'A', text: '乙线索' });
  assert.equal(applyRoomAction(room, host.id, { kind: 'research', topic: 'B', text: '第二次' }).ok, false);
  assert.equal(viewFor(room, host.id).lastWasResearch, true);
});

test('a free conference record does not reset the research restriction', () => {
  const state = createConsole();
  assert.equal(recordResearch(state, { topic: 'A', text: '线索' }).ok, true);
  assert.equal(recordConference(state, { sector: 10, text: '会议' }).ok, true);
  assert.equal(recordResearch(state, { topic: 'B', text: '线索' }).ok, false);
});

test('a failed locate stays in play, pays five, and does not disclose its answer', () => {
  const { room, host, guest } = playing();
  accepted(room, host, { kind: 'locate', sector: 0, left: 'asteroid', right: 'comet', correct: false });
  assert.equal(room.phase, 'play');
  assert.equal(room.session.status, 'open');
  assert.equal(timeOf(room.session, host.id), 5);
  const ownView = viewFor(room, host.id);
  const otherView = viewFor(room, guest.id);
  assert.equal(ownView.locate.sector, 0);
  const sharedGuess = otherView.entries.find((entry) => entry.type === 'located');
  for (const property of ['sector', 'left', 'right']) {
    assert.equal(Object.hasOwn(sharedGuess, property), false);
    assert.equal(Object.hasOwn(otherView.locate || {}, property), false);
    assert.equal(Object.hasOwn(otherView.summary.locate || {}, property), false);
  }
  assert.equal(sharedGuess.correct, false);
  accepted(room, guest, { kind: 'wait' });
});

function nextPhase(room, sector) {
  for (let count = 0; count < 60 && !room.research; count += 1) {
    accepted(room, currentPlayer(room), { kind: 'wait' });
  }
  assert.equal(room.research?.sector, sector);
}

function declare(room, hostCount = 0, guestCount = 0) {
  accepted(room, room.players[0], { kind: 'research-declare', count: hostCount });
  accepted(room, room.players[1], { kind: 'research-declare', count: guestCount });
}

function paper(room, player, sector, objectType, slot = 1) {
  const context = { ...room.session, actorId: player.id };
  const result = recordTheory(context, { sector, type: objectType }, { enforceSchedule: false });
  assert.equal(result.ok, true, result.error);
  room.session.seq = context.seq;
  result.entry.slot = slot;
  return result.entry;
}

test('every theory phase advances old papers even when everyone submits zero', () => {
  const { room, host } = playing();
  nextPhase(room, 3);
  declare(room, 1);
  const first = accepted(room, host, { kind: 'research-submit', sector: 5, objectType: 'asteroid' }).entry;
  assert.equal(first.slot, 3);
  nextPhase(room, 6);
  declare(room);
  assert.equal(first.slot, 2);
});

test('one player cannot repeat a claim or publish two objects in one sector in the same phase', () => {
  const { room, host } = playing('expert');
  nextPhase(room, 3);
  declare(room, 2);
  accepted(room, host, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 5, objectType: 'asteroid' }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 5, objectType: 'comet' }).ok, false);
  accepted(room, host, { kind: 'research-submit', sector: 6, objectType: 'comet' });
  nextPhase(room, 6);
  declare(room, 1);
  assert.equal(applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 5, objectType: 'asteroid' }).ok, false);
  accepted(room, host, { kind: 'research-submit', sector: 5, objectType: 'comet' });
});

test('a rejected theory is public and duplicate reviews do not duplicate penalties', () => {
  const { room, host, guest } = playing();
  const claim = paper(room, host, 5, 'comet');
  accepted(room, host, { kind: 'review', id: claim.id, review: 'wrong' });
  assert.equal(viewFor(room, guest.id).entries.find((entry) => entry.id === claim.id).objectType, 'comet');
  applyRoomAction(room, host.id, { kind: 'review', id: claim.id, review: 'wrong' });
  assert.equal(timeOf(room.session, host.id), 1);
  assert.equal(applyRoomAction(room, host.id, { kind: 'review', id: claim.id, review: 'correct' }).ok, false);
});

test('a correct review applies every inferred penalty in player order exactly once', () => {
  const { room, host, guest } = playing();
  const correct = paper(room, host, 5, 'asteroid');
  const incorrect = paper(room, guest, 5, 'comet', 3);
  accepted(room, host, { kind: 'review', id: correct.id, review: 'correct' });
  assert.equal(incorrect.review, 'wrong');
  assert.equal(incorrect.revealed, true);
  assert.equal(timeOf(room.session, guest.id), 1);
  applyRoomAction(room, guest.id, { kind: 'review', id: incorrect.id, review: 'wrong' });
  assert.equal(timeOf(room.session, guest.id), 1);
});

test('simultaneous correct papers earn all authors the leader bonus', () => {
  const { room, host, guest } = playing();
  nextPhase(room, 3);
  declare(room, 1, 1);
  const first = accepted(room, host, { kind: 'research-submit', sector: 5, objectType: 'asteroid' }).entry;
  accepted(room, guest, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  nextPhase(room, 6);
  declare(room);
  nextPhase(room, 9);
  declare(room);
  assert.equal(applyRoomAction(room, currentPlayer(room).id, { kind: 'wait' }).ok, false);
  accepted(room, host, { kind: 'review', id: first.id, review: 'correct' });
  assert.deepEqual(scoreBoard(room.session, room.players).rows.map((row) => row.leaderBonus), [1, 1]);
});

test('tie breaks use locate points, then leader bonuses, then share the victory', () => {
  const rows = [{ id: 'first', total: 10, locatePoints: 0, leaderBonus: 1 }, { id: 'second', total: 10, locatePoints: 10, leaderBonus: 0 }];
  assert.deepEqual(scoreWinners({ rows }).map((row) => row.id), ['second']);
  rows[0].locatePoints = 10;
  assert.deepEqual(scoreWinners({ rows }).map((row) => row.id), ['first']);
  rows[1].leaderBonus = 1;
  assert.equal(scoreWinners({ rows }).length, 2);
});

test('local crossing keeps the skipped phase open and empty completion advances papers', () => {
  const state = createConsole();
  assert.equal(recordSurvey(state, { type: 'asteroid', start: 0, size: 1, count: 0 }).ok, true);
  assert.equal(engine.consoleView(state).theoryPhaseOpen, true);
  assert.equal(engine.recordWait(state).ok, false);
  assert.equal(recordTheory(state, { sector: 5, type: 'asteroid' }).ok, true);
  assert.equal(typeof engine.completeTheoryPhase, 'function');
  assert.equal(engine.completeTheoryPhase(state).ok, true);
  assert.equal(state.entries.find((entry) => entry.type === 'theory').slot, 3);
  assert.equal(engine.recordWait(state).ok, true);
  assert.equal(engine.completeTheoryPhase(state).ok, true);
  assert.equal(state.entries.find((entry) => entry.type === 'theory').slot, 2);
});

const answer = { sector: 0, left: 'asteroid', right: 'comet', correct: true };
const revealed = ['planetX', 'comet', 'comet', 'asteroid', 'asteroid', 'gasCloud', 'empty', 'dwarfPlanet', 'asteroid', 'asteroid', 'gasCloud', 'empty'];

test('correct location freezes the sky and gives the trailing player one zero-cost final opportunity', () => {
  const { room, host, guest } = playing();
  accepted(room, host, { kind: 'locate', ...answer });
  assert.equal(room.phase, 'final');
  const before = viewFor(room, guest.id);
  assert.equal(before.windowTime, 0);
  assert.equal(before.endgame.isMyTurn, true);
  assert.equal(before.endgame.behind, 5);
  assert.equal(before.endgame.quota, 2);
  assert.equal(before.scores.finished, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'final-pass' }).ok, false);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, false);
  accepted(room, guest, { kind: 'locate', ...answer });
  assert.equal(room.phase, 'reveal');
  assert.equal(timeOf(room.session, guest.id), 0);
  assert.equal(viewFor(room, guest.id).windowTime, 0);
  assert.deepEqual(viewFor(room, host.id).scores.rows.map((row) => row.locatePoints), [10, 10]);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'locate', ...answer }).ok, false);
  for (const player of [host, guest]) {
    const entries = viewFor(room, player.id).entries.filter((entry) => entry.type === 'located' && entry.actorId !== player.id);
    assert.equal(entries.length, 1);
    for (const key of ['sector', 'left', 'right']) assert.equal(Object.hasOwn(entries[0], key), false);
  }
});

test('final theory batches validate atomically and outstanding papers score only after host reveal', () => {
  const { room, host, guest } = playing();
  const oldPaper = paper(room, host, 3, 'asteroid', 3);
  accepted(room, host, { kind: 'locate', ...answer });
  const count = room.session.entries.length;
  assert.equal(applyRoomAction(room, guest.id, { kind: 'final-theories', theories: [{ sector: 1, objectType: 'comet' }, { sector: 1, objectType: 'asteroid' }] }).ok, false);
  assert.equal(room.session.entries.length, count);
  accepted(room, guest, { kind: 'final-theories', theories: [{ sector: 1, objectType: 'comet' }, { sector: 3, objectType: 'comet' }] });
  assert.equal(room.phase, 'reveal');
  assert.equal(timeOf(room.session, guest.id), 0);
  assert.equal(oldPaper.review, 'pending');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'reveal-objects', objects: revealed }).ok, false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'reveal-objects', objects: ['planetX'] }).ok, false);
  assert.equal(oldPaper.review, 'pending');
  accepted(room, host, { kind: 'reveal-objects', objects: revealed });
  assert.equal(room.phase, 'done');
  assert.equal(room.session.status, 'finished');
  assert.equal(oldPaper.review, 'correct');
  assert.equal(timeOf(room.session, guest.id), 0);
  const game = viewFor(room, guest.id);
  assert.deepEqual(game.revealedObjects, revealed);
  assert.equal(game.scores.finished, true);
  assert.deepEqual(game.scores.rows.map((row) => row.theoryPoints), [2, 3]);
});

test('final locate scores two per frozen sector behind and never changes the final clocks', () => {
  for (const behind of [1, 2, 3, 4, 5]) {
    const { room, host, guest } = playing();
    room.session.entries.push({ id: room.session.seq++, type: 'wait', actorId: guest.id, cost: 5 - behind, time: 0 });
    accepted(room, host, { kind: 'locate', ...answer });
    assert.equal(viewFor(room, guest.id).endgame.quota, behind <= 3 ? 1 : 2);
    accepted(room, guest, { kind: 'locate', ...answer });
    assert.equal(timeOf(room.session, guest.id), 5 - behind);
    assert.equal(scoreBoard(room.session, room.players).rows[1].locatePoints, 2 * behind);
  }
});

test('no final opportunity is granted to another pawn in the same sector', () => {
  const { room, host, guest } = playing();
  room.session.entries.push({ id: room.session.seq++, type: 'wait', actorId: guest.id, cost: 5, time: 0 });
  accepted(room, host, { kind: 'locate', ...answer });
  assert.equal(room.phase, 'reveal');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'locate', ...answer }).ok, false);
});

test('local correct locate enters reveal and wrong pending papers incur no final penalties', () => {
  const state = createConsole();
  const claim = recordTheory(state, { sector: 3, type: 'comet' }, { enforceSchedule: false }).entry;
  assert.equal(engine.recordLocate(state, answer).ok, true);
  assert.equal(state.status, 'reveal');
  assert.equal(typeof engine.revealObjects, 'function');
  assert.equal(engine.revealObjects(state, revealed).ok, true);
  assert.equal(state.status, 'finished');
  assert.equal(claim.review, 'wrong');
  assert.equal(engine.consoleTime(state), 5);
});

test('final reveal rejects sparse boards without changing state', () => {
  const state = createConsole();
  assert.equal(engine.recordLocate(state, answer).ok, true);
  const before = structuredClone(state);
  const objects = Array(12);
  objects[0] = 'planetX';
  assert.equal(engine.revealObjects(state, objects).ok, false);
  assert.deepEqual(state, before);
});

test('final reveal cannot reverse confirmed peer reviews or resurrect rejected papers', () => {
  for (const verdict of ['correct', 'wrong']) {
    const state = createConsole();
    const theory = recordTheory(state, { sector: 3, type: 'comet' }, { enforceSchedule: false }).entry;
    theory.slot = 1;
    assert.equal(markTheoryReview(state, theory.id, verdict).ok, true);
    assert.equal(engine.recordLocate(state, answer).ok, true);
    const before = structuredClone(state);
    const conflict = [...revealed];
    conflict[3] = verdict === 'wrong' ? 'comet' : 'empty';
    const result = engine.revealObjects(state, conflict);
    assert.equal(result.ok, false);
    assert.match(result.error, /冲突/);
    assert.deepEqual(state, before);

    const consistent = [...revealed];
    consistent[3] = verdict === 'correct' ? 'comet' : 'empty';
    assert.equal(engine.revealObjects(state, consistent).ok, true);
    assert.equal(theory.review, verdict);
    assert.equal(theory.finalReview, undefined);
    assert.equal(engine.consoleTime(state), engine.consoleTime(before));
  }
});
