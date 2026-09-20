import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { MODES, COST, surveyCost, baseRuleText, theoryPointsFor } from '../public/src/rules.js';
import {
  createConsole,
  recordSurvey,
  recordTarget,
  recordTheory,
  advanceTheoryTrack,
  closeTheoryPhase,
  completeTheoryPhase,
  consoleTime,
  consoleView,
  theoryQuota,
  timeOf,
  windowOf,
} from '../public/src/console.js';
import { createRoom, addPlayer, applyRoomAction, currentPlayer, viewFor } from '../public/src/room.js';
import { scoreBoard, scoreWinners } from '../public/src/score.js';

const results = [];

function requiredAction(room, playerId, action) {
  const bound = ['research-declare', 'research-submit'].includes(action.kind) ? { phaseId: room.research?.id, ...action } : action;
  const result = applyRoomAction(room, playerId, bound);
  assert.equal(result.ok, true, `Fixture action ${action.kind}: ${result.error}`);
  return result;
}

function playing(modeId = 'standard') {
  const room = createRoom({ modeId, hostName: '审计甲' });
  const host = room.players[0];
  const guest = addPlayer(room, '审计乙');
  requiredAction(room, host.id, { kind: 'start-game' });
  requiredAction(room, host.id, { kind: 'setup', noClues: true });
  requiredAction(room, guest.id, { kind: 'setup', noClues: true });
  assert.equal(room.phase, 'play');
  return { room, host, guest };
}

function nextTheoryPhase(room, sector) {
  for (let step = 0; step < 64 && !room.research; step += 1) {
    requiredAction(room, currentPlayer(room).id, { kind: 'wait' });
  }
  assert.equal(room.research?.sector, sector, 'Fixture must reach the requested theory phase');
}

function declarePapers(room, counts) {
  for (const player of room.players) {
    requiredAction(room, player.id, { kind: 'research-declare', count: counts[player.id] || 0 });
  }
}

function paperFixture(room, player, sector, objectType, slot) {
  const context = { ...room.session, actorId: player.id };
  const result = recordTheory(context, { sector, type: objectType }, { enforceSchedule: false });
  assert.equal(result.ok, true, result.error);
  room.session.seq = context.seq;
  result.entry.slot = slot;
  return result.entry;
}

function verify(id, title, pages, exercise) {
  let comparison;
  try {
    comparison = exercise();
  } catch (error) {
    results.push({ id, title, pages, status: 'harness-error', error: error.message });
    return;
  }
  try {
    assert.deepEqual(comparison.actual, comparison.expected);
    results.push({ id, title, pages, status: 'pass', ...comparison });
  } catch {
    results.push({ id, title, pages, status: 'mismatch', ...comparison });
  }
}

verify('P01', '棋盘和可见天区规模', '4, 5', () => ({
  expected: [[12, 6], [18, 9]],
  actual: Object.values(MODES).map((mode) => [mode.sectors, mode.visible]),
}));

verify('P02', '扫描受天窗和两枚标记限制', '9', () => {
  const state = createConsole();
  const hidden = recordTarget(state, { sector: 8, apparent: 'empty' });
  const first = recordTarget(state, { sector: windowOf(state).start, apparent: 'empty' });
  for (const phase of [...state.theoryPhases]) assert.equal(completeTheoryPhase(state).ok, true, phase.id);
  const second = recordTarget(state, { sector: windowOf(state).start, apparent: 'empty' });
  for (const phase of [...state.theoryPhases]) assert.equal(completeTheoryPhase(state).ok, true, phase.id);
  const third = recordTarget(state, { sector: windowOf(state).start, apparent: 'empty' });
  return { expected: [false, true, true, false], actual: [hidden.ok, first.ok, second.ok, third.ok] };
});

verify('P03', '他人看不到勘测数量', '9', () => {
  const { room, host, guest } = playing();
  requiredAction(room, host.id, { kind: 'survey', type: 'asteroid', start: 0, size: 1, count: 1 });
  const entry = viewFor(room, guest.id).entries[0];
  return { expected: { publicRange: 1, privateCountPresent: false }, actual: { publicRange: entry.size, privateCountPresent: Object.hasOwn(entry, 'count') } };
});

verify('P04', '正确论文的天体分值', '17', () => {
  const objects = ['asteroid', 'comet', 'gasCloud', 'dwarfPlanet'];
  return {
    expected: [[2, 3, 4, 4], [2, 3, 4, 2]],
    actual: Object.values(MODES).map((mode) => objects.map((objectType) => theoryPointsFor(mode, objectType))),
  };
});

verify('P05', '最靠后行动且同格先到优先', '8, 12', () => {
  const { room, host, guest } = playing();
  const initial = currentPlayer(room).id === host.id;
  requiredAction(room, host.id, { kind: 'research', topic: 'A', text: '甲线索' });
  const guestNext = currentPlayer(room).id === guest.id;
  requiredAction(room, guest.id, { kind: 'research', topic: 'A', text: '乙线索' });
  return { expected: [true, true, true], actual: [initial, guestNext, currentPlayer(room).id === host.id] };
});

verify('P06', '标准与专家阶段篇数上限', '14', () => ({
  expected: [1, 2], actual: [theoryQuota(MODES.standard), theoryQuota(MODES.expert)],
}));

verify('P07', '按官方五格定位成本构造的最后定位计分', '16, 17', () => {
  const points = [1, 2, 3, 4, 5].map((distanceBehind) => {
    const state = createConsole();
    state.status = 'finished';
    state.entries = [
      { id: 1, type: 'located', actorId: 'first', time: 10, cost: 5, correct: true },
      { id: 2, type: 'located', actorId: 'last', time: 15 - distanceBehind, cost: 0, correct: true },
    ];
    return scoreBoard(state, [{ id: 'first' }, { id: 'last' }]).rows[1].locatePoints;
  });
  return { expected: [2, 4, 6, 8, 10], actual: points };
});

verify('R01', '行动耗时与官方表不一致', '9, 10, 12', () => ({
  expected: { survey: [4, 3, 2], target: 4, research: 1, locate: 5 },
  actual: { survey: [surveyCost(1), surveyCost(4), surveyCost(7)], target: COST.target, research: COST.research, locate: COST.locate },
}));

verify('R02', '专家彗星提示遗漏13和17', '4', () => {
  const cometRule = baseRuleText(MODES.expert).find((text) => text.includes('彗星'));
  return { expected: [true, true], actual: [cometRule.includes('13'), cometRule.includes('17')] };
});

verify('R03', '彗星勘测接受不合法端点', '9', () => {
  const result = recordSurvey(createConsole(), { type: 'comet', start: 0, size: 2, count: 1 });
  return { expected: false, actual: result.ok };
});

verify('R04', '其他玩家行动绕过本人连续研究限制', '10', () => {
  const { room, host, guest } = playing();
  requiredAction(room, host.id, { kind: 'research', topic: 'A', text: '甲第一次' });
  requiredAction(room, guest.id, { kind: 'research', topic: 'A', text: '乙第一次' });
  const result = applyRoomAction(room, host.id, { kind: 'research', topic: 'B', text: '甲连续第二次' });
  return { expected: false, actual: result.ok };
});

verify('R05', '定位错误却结束联机房间', '10, 16', () => {
  const { room, host } = playing();
  requiredAction(room, host.id, { kind: 'locate', sector: 0, left: 'asteroid', right: 'comet', correct: false });
  return { expected: { phase: 'play', status: 'open' }, actual: { phase: room.phase, status: room.session.status } };
});

verify('R06', '定位的扇区与邻居泄露给其他玩家', '10, 16', () => {
  const { room, host, guest } = playing();
  requiredAction(room, host.id, { kind: 'locate', sector: 0, left: 'asteroid', right: 'comet', correct: false });
  const view = viewFor(room, guest.id);
  const log = view.entries.find((entry) => entry.type === 'located');
  const leaked = ['sector', 'left', 'right'].filter((key) => Object.hasOwn(view.locate || {}, key) || Object.hasOwn(log || {}, key));
  return { expected: [], actual: leaked };
});

verify('R07', '首次正确定位后缺少其他玩家最终机会', '16', () => {
  const { room, host, guest } = playing();
  requiredAction(room, host.id, { kind: 'locate', sector: 0, left: 'asteroid', right: 'comet', correct: true });
  const beforeTime = timeOf(room.session, guest.id);
  const result = applyRoomAction(room, guest.id, { kind: 'locate', sector: 0, left: 'asteroid', right: 'comet', correct: true });
  return {
    expected: { accepted: true, pawnUnchanged: true },
    actual: { accepted: result.ok, pawnUnchanged: timeOf(room.session, guest.id) === beforeTime },
  };
});

verify('R08', '全员零篇时旧论文不推进', '14', () => {
  const { room, host } = playing();
  nextTheoryPhase(room, 3);
  declarePapers(room, { [host.id]: 1 });
  const first = requiredAction(room, host.id, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  assert.equal(first.entry.slot, 3);
  nextTheoryPhase(room, 6);
  declarePapers(room, {});
  return { expected: 2, actual: first.entry.slot };
});

verify('R09', '错误论文评审后仍隐藏天体', '15', () => {
  const { room, host, guest } = playing();
  const paper = paperFixture(room, host, 5, 'comet', 1);
  requiredAction(room, host.id, { kind: 'review', id: paper.id, review: 'wrong' });
  const visiblePaper = viewFor(room, guest.id).entries.find((entry) => entry.id === paper.id);
  return { expected: 'comet', actual: visiblePaper.objectType ?? null };
});

verify('R10', '正确论文揭出其他错误论文却不罚时', '15', () => {
  const { room, host, guest } = playing();
  const correctPaper = paperFixture(room, host, 5, 'asteroid', 1);
  const wrongPaper = paperFixture(room, guest, 5, 'comet', 3);
  requiredAction(room, host.id, { kind: 'review', id: correctPaper.id, review: 'correct' });
  return { expected: { review: 'wrong', penalty: 1 }, actual: { review: wrongPaper.review, penalty: timeOf(room.session, guest.id) } };
});

verify('R11', '同一玩家可重复提交同区同天体论文', '14', () => {
  const state = createConsole({ actorId: 'author' });
  const first = recordTheory(state, { sector: 0, type: 'asteroid' }, { enforceSchedule: false });
  assert.equal(first.ok, true);
  const second = recordTheory(state, { sector: 0, type: 'asteroid' }, { enforceSchedule: false });
  return { expected: false, actual: second.ok };
});

verify('R12', '专家阶段可同时提交同区两种天体', '14', () => {
  const { room, host } = playing('expert');
  nextTheoryPhase(room, 3);
  declarePapers(room, { [host.id]: 2 });
  requiredAction(room, host.id, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  const second = applyRoomAction(room, host.id, { kind: 'research-submit', phaseId: room.research.id, sector: 5, objectType: 'comet' });
  return { expected: false, actual: second.ok };
});

verify('R13', '同阶段并列最早论文只奖励一人', '14, 17', () => {
  const { room, host, guest } = playing();
  nextTheoryPhase(room, 3);
  declarePapers(room, { [host.id]: 1, [guest.id]: 1 });
  const first = requiredAction(room, host.id, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  requiredAction(room, guest.id, { kind: 'research-submit', sector: 5, objectType: 'asteroid' });
  advanceTheoryTrack(room.session);
  advanceTheoryTrack(room.session);
  requiredAction(room, host.id, { kind: 'review', id: first.entry.id, review: 'correct' });
  return { expected: [1, 1], actual: scoreBoard(room.session, room.players).rows.map((row) => row.leaderBonus) };
});

verify('R14', '平分时缺少定位分和首发分裁决', '17', () => {
  const locateTie = { rows: [{ id: 'first', total: 10, locatePoints: 0, leaderBonus: 1 }, { id: 'second', total: 10, locatePoints: 10, leaderBonus: 0 }] };
  const leaderTie = { rows: [{ id: 'first', total: 10, locatePoints: 0, leaderBonus: 1 }, { id: 'second', total: 10, locatePoints: 0, leaderBonus: 2 }] };
  return { expected: [['second'], ['second']], actual: [scoreWinners(locateTie).map((row) => row.id), scoreWinners(leaderTie).map((row) => row.id)] };
});

verify('R15', '单机越过论文事件后无法提交', '13, 14', () => {
  const state = createConsole();
  const beforeTime = consoleTime(state);
  const survey = recordSurvey(state, { type: 'asteroid', start: 0, size: 1, count: 0 });
  assert.equal(survey.ok, true);
  closeTheoryPhase(state, beforeTime, consoleTime(state));
  assert.ok(consoleView(state).arrowSector > 3, 'Fixture must pass the first theory sector without stopping there');
  const paper = recordTheory(state, { sector: 5, type: 'asteroid' });
  return { expected: true, actual: paper.ok };
});

verify('R16', '重复提交同一次错误评审会重复罚时', '15; robustness', () => {
  const { room, host } = playing();
  const paper = paperFixture(room, host, 5, 'comet', 1);
  requiredAction(room, host.id, { kind: 'review', id: paper.id, review: 'wrong' });
  applyRoomAction(room, host.id, { kind: 'review', id: paper.id, review: 'wrong' });
  return { expected: 1, actual: timeOf(room.session, host.id) };
});

for (const result of results) {
  console.log(`[${result.status.toUpperCase()}] ${result.id} ${result.title}`);
  if (result.status === 'mismatch') console.log(`  expected=${JSON.stringify(result.expected)} actual=${JSON.stringify(result.actual)}`);
  if (result.status === 'harness-error') console.log(`  ${result.error}`);
}

const summary = {
  checks: results.length,
  passed: results.filter((result) => result.status === 'pass').length,
  mismatches: results.filter((result) => result.status === 'mismatch').length,
  harnessErrors: results.filter((result) => result.status === 'harness-error').length,
};
console.log(JSON.stringify(summary));
const outputIndex = process.argv.indexOf('--json');
if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
  writeFileSync(process.argv[outputIndex + 1], JSON.stringify({ summary, results }, null, 2) + '\n');
}
process.exitCode = summary.mismatches || summary.harnessErrors ? 1 : 0;
