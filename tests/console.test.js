import test from 'node:test';
import assert from 'node:assert/strict';

import { COST, MAX_TARGET_USES, MODES, conferenceSectors, eventsAt, surveyCost, visibleSectorsAt } from '../public/src/rules.js';
import { Obj, CODE } from '../public/src/types.js';
import { PRIVATE_KEYS } from '../public/src/room.js';
import { scoreBoard, scoreWinners } from '../public/src/score.js';
import {
  actionRounds,
  completeTheoryPhase,
  consoleSummary,
  consoleTime,
  consoleView,
  createConsole,
  markTheoryReview,
  nudgeWindow,
  recordConference,
  recordLocate,
  recordResearch,
  recordSurvey,
  recordTarget,
  recordTheory,
  recordWait,
  revealObjects,
  theoriesAwaitingReview,
  theoryLockedSectors,
  timeOf,
  undoLast,
  windowOf,
  windowStartOf,
} from '../public/src/console.js';

const mode = MODES.standard;

function finishEmptyPhases(state) {
  for (const phase of [...state.theoryPhases]) {
    assert.equal(consoleView(state).theoryPhase.id, phase.id);
    assert.equal(completeTheoryPhase(state).ok, true);
  }
}

test('a fresh console knows nothing about the puzzle', () => {
  const state = createConsole();
  assert.equal(state.kind, 'console');
  assert.equal(state.status, 'open');
  assert.equal(state.entries.length, 0);
  assert.equal(consoleTime(state), 0);
  const view = consoleView(state);
  assert.equal(view.time, 0);
  assert.equal(view.timeLabel, '第 1 圈／第 1 格');
  assert.equal(view.recordCount, 0);
  assert.equal(view.targetUses, MAX_TARGET_USES);
  assert.equal(view.researched.size, 0);
  assert.deepEqual(view.visible, visibleSectorsAt(0, mode));
  assert.equal(view.worlds, undefined, 'the console must not carry a candidate world set');
});

test('recording a survey costs the same time as making one', () => {
  const state = createConsole();
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 6, count: 2 }).ok, true);
  assert.equal(consoleTime(state), surveyCost(6));
  assert.equal(consoleTime(state), 3);
  const view = consoleView(state);
  assert.equal(view.knowledge.surveys.length, 1);
  assert.deepEqual(
    { type: view.knowledge.surveys[0].surveyType, count: view.knowledge.surveys[0].count, at: view.knowledge.surveys[0].time },
    { type: Obj.ASTEROID, count: 2, at: 0 },
  );
  assert.equal(view.timeLabel, '第 1 圈／第 4 格');
});

test('each board completes a lap without changing wait costs or stored entry clocks', () => {
  for (const boardMode of [MODES.standard, MODES.expert]) {
    const state = createConsole({ modeId: boardMode.id });
    const first = recordWait(state, boardMode.sectors - 1);
    assert.equal(first.ok, true);
    assert.equal(first.entry.time, 0);
    assert.equal(first.entry.cost, boardMode.sectors - 1);
    assert.equal(consoleView(state).timeLabel, `第 1 圈／第 ${boardMode.sectors} 格`);
    assert.equal(consoleSummary(state).laps, (boardMode.sectors - 1) / boardMode.sectors);
    finishEmptyPhases(state);
    const next = recordWait(state);
    assert.equal(next.ok, true);
    assert.equal(next.entry.time, boardMode.sectors - 1);
    assert.equal(next.entry.cost, 1);
    assert.equal(consoleTime(state), boardMode.sectors);
    assert.equal(windowStartOf(state), 0);
    assert.equal(consoleView(state).timeLabel, '第 2 圈／第 1 格');
    assert.equal(consoleSummary(state).laps, 1);
    assert.equal(actionRounds(state)[1].cells.me[0].time, `第 1 圈／第 ${boardMode.sectors} 格`);
  }
});

test('summaries present saved clocks in time units without rewriting old records or the shared window', () => {
  for (const boardMode of [MODES.standard, MODES.expert]) {
    const state = createConsole({ modeId: boardMode.id });
    state.entries = [
      { id: 1, type: 'wait', time: 0, cost: boardMode.sectors - 1 },
      { id: 2, type: 'target', time: boardMode.sectors - 1, cost: 4, sector: 0, apparent: Obj.EMPTY },
      { id: 3, type: 'conference', time: boardMode.sectors + 3, cost: 0, sector: conferenceSectors(boardMode)[0], scheduledMonth: boardMode.id === 'expert' ? 4 : 9, text: '已保存的线索' },
    ];
    state.seq = 4;
    state.windowTime = 5;
    state.windowOffset = boardMode.sectors - 1;
    const before = structuredClone(state);
    const summary = consoleSummary(state);
    const view = consoleView(state);
    assert.equal(summary.units, boardMode.sectors + 3);
    assert.equal(summary.laps, summary.units / boardMode.sectors);
    assert.equal(summary.durationLabel, `${summary.units} 个时间单位`);
    assert.deepEqual(summary.parts, { lap: 2, step: 4 });
    assert.equal(summary.timeLabel, '第 2 圈／第 4 格');
    assert.equal(summary.timeShort, summary.timeLabel);
    assert.equal(summary.months, summary.units);
    assert.equal(summary.years, summary.laps);
    assert.equal(summary.yearsLabel, summary.durationLabel);
    assert.equal(view.time, boardMode.sectors + 3);
    assert.equal(view.visibleStart, 4);
    assert.deepEqual(view.visible, visibleSectorsAt(4, boardMode));
    assert.deepEqual(state, before);
  }
});

test('wait duration validation retains its numeric behavior', () => {
  for (const units of [0, -1, 1.5, '2', NaN, Infinity]) {
    const state = createConsole();
    assert.equal(recordWait(state, units).entry.cost, COST.wait);
    assert.equal(consoleTime(state), COST.wait);
  }
  assert.equal(recordWait(createConsole(), 4).entry.cost, 4);
});

test('surveys and scans are limited to the visible sky', () => {
  const state = createConsole();
  assert.equal(windowOf(state).sectors.includes(7), false, 'sector 8 is outside the first window');

  // the engine refuses anything outside the window, and says which sectors are visible
  const survey = recordSurvey(state, { type: Obj.ASTEROID, start: 7, size: 2, count: 1 });
  assert.equal(survey.ok, false);
  assert.match(survey.error, /勘测只能在可见天窗内进行/);
  assert.match(survey.error, /1、2、3、4、5、6/);
  assert.equal(consoleTime(state), 0, 'a refused record costs nothing');

  const scan = recordTarget(state, { sector: 7, apparent: Obj.EMPTY });
  assert.equal(scan.ok, false);
  assert.match(scan.error, /扫描只能在可见天窗内进行/);

  // a range that only partly overlaps is refused too, and names the hidden sectors
  const straddling = recordSurvey(state, { type: Obj.ASTEROID, start: 5, size: 3, count: 1 });
  assert.equal(straddling.ok, false, 'the whole range has to be visible');
  assert.match(straddling.error, /7、8 号/);

  // records inside the window go through
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 6, count: 1 }).ok, true);
  assert.equal(consoleTime(state), 3);
  assert.equal(windowOf(state).sectors.includes(3), true, 'the shifted window still sees sector 4');
  finishEmptyPhases(state);
  assert.equal(recordTarget(state, { sector: 3, apparent: Obj.EMPTY }).ok, true);
  finishEmptyPhases(state);

  // wait until sector 8 is back in view, and then it is allowed
  let guard = 0;
  while (!windowOf(state).sectors.includes(7) && guard++ < 20) {
    assert.equal(recordWait(state, 1).ok, true);
    finishEmptyPhases(state);
  }
  assert.equal(windowOf(state).sectors.includes(7), true);
  assert.equal(recordTarget(state, { sector: 7, apparent: Obj.EMPTY }).ok, true);
});

test('the modelled sky window can be nudged to match the real board', () => {
  const state = createConsole();
  assert.deepEqual(windowOf(state).sectors, visibleSectorsAt(0, mode));
  nudgeWindow(state, 1);
  assert.equal(windowStartOf(state), 1);
  assert.deepEqual(windowOf(state).sectors, [1, 2, 3, 4, 5, 6]);
  nudgeWindow(state, -1);
  assert.equal(windowStartOf(state), 0);
  nudgeWindow(state, -1);
  assert.equal(windowStartOf(state), mode.sectors - 1, 'nudging wraps around');
  assert.equal(consoleView(state).windowOffset, mode.sectors - 1);
});

test('the recorded result has to be a plausible number', () => {
  const state = createConsole();
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 3, count: 4 }).ok, false);
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 3, count: -1 }).ok, false);
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 3, count: 2.5 }).ok, false);
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 3, count: 2 }).ok, true);
  assert.equal(recordSurvey(state, { type: Obj.PLANET_X, start: 0, size: 3, count: 1 }).ok, false, 'you cannot survey for Planet X');
});

test('targets are limited and only accept the five apparent results', () => {
  const state = createConsole();
  assert.equal(recordTarget(state, { sector: 0, apparent: CODE.planetX }).ok, false, 'Planet X is reported as empty');
  assert.equal(recordTarget(state, { sector: windowOf(state).sectors[0], apparent: Obj.EMPTY }).ok, true);
  finishEmptyPhases(state);
  assert.equal(recordTarget(state, { sector: windowOf(state).sectors[5], apparent: Obj.ASTEROID }).ok, true);
  finishEmptyPhases(state);
  assert.equal(consoleView(state).targetUses, 0);
  const third = recordTarget(state, { sector: windowOf(state).sectors[0], apparent: Obj.COMET });
  assert.equal(third.ok, false);
  assert.match(third.error, /用完/);
});
test('research obeys the topic and back-to-back rules and keeps the player-typed name', () => {
  const state = createConsole();
  assert.equal(recordResearch(state, { topic: 'A', name: '小行星带', text: '小行星编号之和为 30' }).ok, true);
  assert.equal(consoleTime(state), COST.research);
  const backToBack = recordResearch(state, { topic: 'B', name: 'x', text: 'x' });
  assert.equal(backToBack.ok, false);
  assert.match(backToBack.error, /连续/);
  recordWait(state);
  finishEmptyPhases(state);
  assert.equal(recordResearch(state, { topic: 'A', name: 'again', text: 'again' }).ok, false);
  assert.equal(recordResearch(state, { topic: 'B', name: '气体云位置', text: '两个气体云相隔 4 格' }).ok, true);
  const view = consoleView(state);
  assert.equal(view.knowledge.clues.length, 2);
  assert.equal(view.knowledge.clues[1].text, '两个气体云相隔 4 格');
  assert.equal(view.knowledge.clues[1].name, '气体云位置');
  assert.equal(view.topics.A.name, '小行星带');
  assert.equal(view.topics.B.clue, '两个气体云相隔 4 格');
  assert.equal(view.lastWasResearch, true);
  assert.equal(recordResearch(state, { topic: 'Z', text: 'x' }).ok, false, 'only A–F exist');
});

test('conferences are tied to the sectors the rulebook puts them on', () => {
  const state = createConsole();
  const sectors = conferenceSectors(mode);
  assert.deepEqual(sectors, [10], 'standard mode has a single Planet X conference, on sector 10');
  assert.equal(recordConference(state, { sector: 5, text: 'x' }).ok, false, 'only the marked sector counts');
  assert.equal(recordConference(state, { sector: 12, text: 'x' }).ok, false, 'sector 12 is a theory phase, not a conference');
  const first = recordConference(state, { sector: 10, text: 'X行星紧邻一颗彗星' });
  assert.equal(first.ok, true);
  assert.equal(first.entry.cost, 0, 'conferences are free');
  assert.equal(recordConference(state, { sector: 10, text: 'dup' }).ok, false);
  assert.equal(consoleView(state).knowledge.conferences.length, 1);
});

test('an expert console runs on 18 sectors with its own event sectors', () => {
  const state = createConsole({ modeId: 'expert' });
  assert.equal(state.mode.sectors, 18);
  assert.equal(consoleView(state).conferenceSectors.join(','), '7,16');
  assert.equal(recordConference(state, { sector: 10, text: 'x' }).ok, false, 'sector 10 is not an expert conference');
  assert.equal(recordConference(state, { sector: 7, text: 'X行星在两颗矮行星之间' }).ok, true);
  const survey = recordSurvey(state, { type: Obj.ASTEROID, start: 6, size: 3, count: 1 });
  assert.equal(survey.ok, true, 'a range inside the expert window works');
  finishEmptyPhases(state);
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 18, size: 3, count: 1 }).ok, false, 'and sector 19 does not exist');
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 16, size: 3, count: 1 }).ok, false, 'sector 18 exists but is outside the window');
});

test('conference schedules use time units on either board', () => {
  for (const boardMode of [MODES.standard, MODES.expert]) {
    const state = createConsole({ modeId: boardMode.id });
    for (const sector of conferenceSectors(boardMode)) {
      const result = recordConference(state, { sector, text: '公开线索' });
      assert.equal(result.ok, true);
      assert.equal(result.entry.scheduledTime, sector - 1);
      assert.equal(result.entry.time, 0);
      assert.equal(result.entry.cost, 0);
    }
    assert.equal(consoleTime(state), 0);
  }
});

test('a theory may only be published during a research phase, once per phase', () => {
  const state = createConsole();

  // the arrow starts on sector 1, which is not a research sector
  const tooEarly = recordTheory(state, { sector: 5, type: Obj.COMET });
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /学术研究只在时间轨箭头走到 3、6、9、12 号扇区/);

  recordWait(state);
  assert.equal(recordTheory(state, { sector: 5, type: Obj.COMET }).ok, false, 'step 2 is still too early');
  recordWait(state, 3);
  const view = consoleView(state);
  assert.equal(view.arrowSector, 5, 'a long action has passed sector 3');
  assert.equal(recordTheory(state, { sector: 5, type: Obj.COMET }).ok, true, 'the crossed phase remains open');
  assert.equal(recordWait(state).ok, false, 'another action cannot skip a pending phase');

  const onSector = createConsole();
  recordWait(onSector);
  recordWait(onSector);
  assert.equal(consoleView(onSector).arrowSector, 3);
  assert.equal(consoleView(onSector).theoryPhaseOpen, true);
  assert.equal(consoleView(onSector).theoryQuota, 1, 'a standard board hands out one paper per phase');

  const a = recordTheory(onSector, { sector: 5, type: Obj.COMET });
  assert.equal(a.ok, true);
  assert.equal(a.entry.slot, 4, 'a new theory enters at the top of the track');
  assert.equal(a.entry.revealed, false);
  const twice = recordTheory(onSector, { sector: 1, type: Obj.ASTEROID });
  assert.equal(twice.ok, false, 'one paper per research phase');
  assert.match(twice.error, /已经提交过 1 篇/);

  assert.equal(recordWait(onSector).ok, false);
  assert.equal(completeTheoryPhase(onSector).ok, true);
  assert.equal(consoleView(onSector).theoryPhaseOpen, false);
  assert.equal(recordTheory(onSector, { sector: 1, type: Obj.ASTEROID }).ok, false, 'the completed phase cannot reopen');
  assert.equal(recordWait(onSector).ok, true);
});

test('a round’s papers share a track space, and the phase end moves the whole track', () => {
  const state = createConsole({ modeId: 'expert' });
  const publish = (sector, type) => recordTheory(state, { sector, type });
  const slots = () => state.entries.filter((e) => e.type === 'theory').map((e) => e.slot);
  const phase = (papers) => {
    for (let step = 0; step < 24 && !consoleView(state).theoryPhaseOpen; step++) assert.equal(recordWait(state).ok, true);
    assert.equal(consoleView(state).theoryPhaseOpen, true);
    for (const [sector, type] of papers) assert.equal(publish(sector, type).ok, true);
    assert.deepEqual(
      slots().slice(-papers.length),
      papers.map(() => 4),
      'a fresh paper sits on space 4',
    );
    assert.equal(completeTheoryPhase(state).ok, true);
  };

  phase([
    [5, Obj.COMET],
    [0, Obj.ASTEROID],
  ]);
  assert.deepEqual(slots(), [3, 3], 'the round’s papers stepped forward together');

  phase([
    [8, Obj.GAS_CLOUD],
    [1, Obj.DWARF_PLANET],
  ]);
  assert.deepEqual(slots(), [2, 2, 3, 3], 'the older round leads, the new round follows');

  phase([
    [9, Obj.COMET],
    [10, Obj.ASTEROID],
  ]);
  assert.deepEqual(slots(), [1, 1, 2, 2, 3, 3], 'the first round reaches the review space together');
  assert.deepEqual(
    theoriesAwaitingReview(state).map((t) => t.sector).sort((a, b) => a - b),
    [0, 5],
    'both papers of that round wait for the app at the same time',
  );

  // a reviewed paper stops travelling
  const first = state.entries.find((e) => e.type === 'theory' && e.sector === 5);
  for (const theory of theoriesAwaitingReview(state).sort((earlier, later) => earlier.sector - later.sector)) {
    assert.equal(markTheoryReview(state, theory.id, 'correct').ok, true);
  }
  phase([[11, Obj.GAS_CLOUD]]);
  assert.equal(state.entries.find((e) => e.id === first.id).slot, 1, 'the confirmed paper stays put');
  assert.deepEqual(slots(), [1, 1, 1, 1, 2, 2, 3], 'the others keep moving, the fresh one sits at 3');

  // "truly empty" can never be claimed: an empty-looking sector may be Planet X itself
  const refused = publish(2, Obj.EMPTY);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /空域/);
  assert.equal(PRIVATE_KEYS.theory.includes('objectType'), true, 'the room hides the claimed object');
});

test('the record is a table of rounds with an operation and its result per cell', () => {
  const state = createConsole({ actorId: 'P1' });
  state.roomManaged = true;
  const as = (actorId, fn) => {
    const prev = state.actorId;
    state.actorId = actorId;
    const res = fn();
    state.actorId = prev;
    return res;
  };
  as('P1', () => recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 6, count: 2 }));
  as('P1', () => recordTarget(state, { sector: 4, apparent: Obj.EMPTY }));
  as('P2', () => recordWait(state));

  const table = [
    { id: 'P1', name: '甲' },
    { id: 'P2', name: '乙' },
  ];
  const rounds = actionRounds(state, table);
  assert.equal(rounds.length, 1, 'three turn actions with two players make one round');
  assert.deepEqual(rounds[0].order, ['P1', 'P2']);
  assert.deepEqual(rounds[0].cells.P1.map((c) => c.op), ['勘测 1–6 号 · 小行星', '扫描 5 号']);
  assert.deepEqual(rounds[0].cells.P1.map((c) => c.result), ['2 个', '空域']);
  assert.deepEqual(rounds[0].cells.P2.map((c) => c.op), ['等待 1 个时间单位']);

  // P2's view of the same log hides P1's private results (this is what the room strips)
  const redacted = {
    ...state,
    entries: state.entries.map((e) => {
      const copy = { ...e };
      delete copy.count;
      delete copy.apparent;
      delete copy.text;
      return copy;
    }),
  };
  const other = actionRounds(redacted, table);
  assert.deepEqual(other[0].cells.P1.map((c) => c.result), ['（结果未公开）', '（结果未公开）']);

  // a second round starts once everybody has acted
  as('P1', () => recordWait(state));
  as('P2', () => recordWait(state));
  const later = actionRounds(state, table);
  assert.equal(later.length, 2, 'a new round opens for the next cycle');
  assert.equal(later[1].index, 2);
});

test('round-table waits and penalties use time units and the expert entry clock', () => {
  const state = createConsole({ modeId: 'expert' });
  state.entries = [
    { id: 1, type: 'wait', time: 0, cost: 18 },
    { id: 2, type: 'penalty', time: 18, cost: 1, sector: 2, theoryId: 3 },
  ];
  const lines = actionRounds(state).flatMap(round => round.cells.me);
  assert.deepEqual(lines.map(line => line.op), ['等待 18 个时间单位', '评审错误 · 罚 1 个时间单位']);
  assert.deepEqual(lines.map(line => line.time), ['第 1 圈／第 1 格', '第 2 圈／第 1 格']);
  assert.equal(consoleTime(state), 19);
});

test('the score table counts confirmed theories, leader bonuses and a correct locate', () => {
  const state = createConsole({ modeId: 'standard' });
  state.roomManaged = true;
  const as = (actorId, fn) => {
    const prev = state.actorId;
    state.actorId = actorId;
    const res = fn();
    state.actorId = prev;
    return res;
  };
  const publish = (actorId, sector, type) =>
    as(actorId, () => recordTheory(state, { sector, type }, { enforceSchedule: false }));
  const players = [
    { id: 'P1', name: '甲' },
    { id: 'P2', name: '乙' },
  ];

  const comet = publish('P1', 2, Obj.COMET); // 3 points
  const asteroid = publish('P2', 7, Obj.ASTEROID); // 2 points
  recordWait(state);
  const gas = publish('P2', 2, Obj.DWARF_PLANET); // same sector as P1's comet, published later
  comet.entry.slot = 1;
  gas.entry.slot = 1;
  asteroid.entry.slot = 1;
  markTheoryReview(state, comet.entry.id, 'correct'); // sector 2 = comet → P2's empty is settled wrong
  markTheoryReview(state, asteroid.entry.id, 'correct'); // sector 7 = asteroid

  recordWait(state);
  assert.equal(as('P1', () => recordLocate(state, { sector: 2, left: Obj.COMET, right: Obj.EMPTY, correct: true })).ok, true);
  state.status = 'final';
  assert.equal(as('P2', () => recordLocate(state, { sector: 2, left: Obj.COMET, right: Obj.EMPTY, correct: false }, { final: true, distanceBehind: 3 })).ok, true);

  const board = scoreBoard(state, players);
  const p1 = board.rows.find((r) => r.id === 'P1');
  const p2 = board.rows.find((r) => r.id === 'P2');
  assert.equal(p1.theoryPoints, 3, 'a comet theory is worth 3');
  assert.equal(p1.leaderBonus, 1, 'P1 was first with a correct theory about sector 2');
  assert.equal(p1.locatePoints, 10, 'and was the first to locate Planet X');
  assert.equal(p1.total, 14);
  assert.equal(p2.theoryPoints, 2, 'P2 only had the asteroid confirmed');
  assert.equal(p2.leaderBonus, 1, 'P2 was first about sector 7');
  assert.equal(p2.located, false, 'a wrong locate does not count');
  assert.equal(p2.locatePoints, 0);
  assert.equal(p2.total, 3);
  assert.deepEqual(board.leaders, [2, 7]);
  assert.equal(board.firstFinderId, 'P1');
  assert.equal(scoreWinners(board).map((r) => r.id).join(','), 'P1');
});

test('a correct review reveals the sector and settles every paper about it', () => {
  const state = createConsole();
  state.roomManaged = true;
  const as = (actorId, fn) => {
    const prev = state.actorId;
    state.actorId = actorId;
    const res = fn();
    state.actorId = prev;
    return res;
  };
  const publish = (sector, type, actorId) => as(actorId, () => recordTheory(state, { sector, type }, { enforceSchedule: false }));

  const right = publish(2, Obj.COMET, 'P1');
  const wrong = publish(2, Obj.DWARF_PLANET, 'P2');
  const elsewhere = publish(7, Obj.DWARF_PLANET, 'P2');
  assert.equal(as('P2', () => consoleView(state)).theoryLockedSectors.length, 0);

  // a paper still travelling may not be settled: the app is only asked at slot 1
  const tooEarly = markTheoryReview(state, right.entry.id, 'correct');
  assert.equal(tooEarly.ok, false);
  assert.match(tooEarly.error, /推进到 1 才能确认/);
  right.entry.slot = 1;

  markTheoryReview(state, right.entry.id, 'correct');
  assert.equal(right.entry.revealed, true);
  assert.equal(wrong.entry.revealed, true, 'the rest of that sector is revealed too');
  assert.equal(wrong.entry.review, 'wrong', 'and settled by comparing the objects');
  assert.equal(wrong.entry.reviewInferred, true);
  assert.equal(elsewhere.entry.revealed, false, 'other sectors stay as they were');
  assert.deepEqual([...theoryLockedSectors(state)], [2], 'so the sector is locked');

  const again = recordTheory(state, { sector: 2, type: Obj.COMET }, { enforceSchedule: false });
  assert.equal(again.ok, false);
  assert.match(again.error, /已经公开/);

  const before = timeOf(state, 'P2');
  elsewhere.entry.slot = 1;
  const res = markTheoryReview(state, elsewhere.entry.id, 'wrong');
  assert.equal(res.ok, true);
  assert.equal(timeOf(state, 'P2'), before + 1, 'the penalty lands on the author’s own clock');
  assert.equal(res.penalty.type, 'penalty');
  assert.equal(res.penalty.actorId, 'P2');
  assert.equal(elsewhere.entry.revealed, true);
});

test('time is per player: only your own entries move your clock', () => {
  const state = createConsole();
  state.roomManaged = true;
  const as = (actorId, fn) => {
    const prev = state.actorId;
    state.actorId = actorId;
    const res = fn();
    state.actorId = prev;
    return res;
  };
  as('P1', () => recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 6, count: 2 }));
  as('P2', () => recordWait(state));
  assert.equal(timeOf(state, 'P1'), 3);
  assert.equal(timeOf(state, 'P2'), 1);
  assert.equal(as('P1', () => consoleTime(state)), 3, 'the view speaks for one player at a time');
  assert.equal(as('P2', () => consoleTime(state)), 1);
  assert.equal(consoleTime(state), 4, 'with no actor (the offline console) everything is yours');
});

test('undo rewinds time and derived state', () => {
  const state = createConsole();
  assert.equal(recordSurvey(state, { type: Obj.ASTEROID, start: 0, size: 6, count: 2 }).ok, true);
  assert.equal(consoleTime(state), 3);
  assert.equal(consoleView(state).theoryPhaseOpen, true);
  assert.equal(undoLast(state).ok, true);
  assert.equal(consoleTime(state), 0);
  assert.equal(consoleView(state).theoryPhaseOpen, false);
  assert.equal(recordResearch(state, { topic: 'A', text: 'clue' }).ok, true);
  assert.equal(recordWait(state).ok, true);
  assert.equal(consoleTime(state), 2);
  assert.equal(consoleView(state).researched.has('A'), true);

  undoLast(state);
  assert.equal(consoleTime(state), 1);
  undoLast(state);
  assert.equal(consoleTime(state), 0);
  assert.equal(consoleView(state).researched.has('A'), false, 'the research is unwound too');
  assert.equal(consoleView(state).knowledge.surveys.length, 0);
  const empty = undoLast(state);
  assert.equal(empty.ok, false);
});

test('recording a correct locate requires reveal before the final summary', () => {
  const state = createConsole();
  recordSurvey(state, { type: Obj.EMPTY, start: 0, size: 6, count: 3 });
  finishEmptyPhases(state);
  recordWait(state);
  const res = recordLocate(state, { sector: 4, left: Obj.COMET, right: Obj.EMPTY });
  assert.equal(res.ok, true);
  assert.equal(state.status, 'reveal');
  const summary = consoleSummary(state);
  assert.equal(summary.units, consoleTime(state));
  assert.equal(summary.laps, 9 / mode.sectors);
  assert.equal(summary.durationLabel, '9 个时间单位');
  assert.equal(summary.locate.sector, 4);
  assert.equal(summary.surveys, 1);
  assert.equal(summary.timeLabel, '第 1 圈／第 10 格', 'three units to survey, one to wait and five to locate');

  assert.equal(recordSurvey(state, { type: Obj.COMET, start: 0, size: 2, count: 1 }).ok, false);
  assert.equal(undoLast(state).ok, false);
  const objects = Array.from({ length: 12 }, (unused, sector) => sector === 4 ? Obj.PLANET_X : Obj.EMPTY);
  assert.equal(revealObjects(state, objects).ok, true);
  assert.equal(state.status, 'finished');
  assert.equal(consoleSummary(state).locate.sector, 4);
});

test('the console view is shaped so the shared panels can render it', () => {
  const state = createConsole();
  recordSurvey(state, { type: Obj.GAS_CLOUD, start: 1, size: 3, count: 1 });
  const view = consoleView(state);
  for (const key of ['mode', 'time', 'log', 'knowledge', 'researched', 'targetUses', 'status']) {
    assert.ok(key in view, `view.${key} must exist`);
  }
  assert.equal(view.knowledge.surveys[0].time, 0, 'log entries carry the numeric clock they happened at');
  assert.equal(view.log[0].type, 'survey');
  assert.ok(view.nextConference >= 0);
});
