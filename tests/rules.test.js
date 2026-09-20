import test from 'node:test';
import assert from 'node:assert/strict';

import { Obj, CODE, LABEL, apparentType, SURVEY_TYPES, THEORY_TYPES, NOTE_ROWS } from '../public/src/types.js';
import {
  BASE_RULE_TEXT,
  COST,
  EVENT_SECTORS,
  LEADER_BONUS,
  LOCATE_POINTS,
  MAX_TARGET_USES,
  MODES,
  MODE_LIST,
  THEORY_TRACK,
  TIME_UNITS_PER_SHIFT,
  arcSectors,
  arrowSector,
  baseRuleText,
  conferenceSectors,
  durationLabel,
  eventSummary,
  eventsAt,
  isVisible,
  locatePointsFor,
  mod,
  modeById,
  surveyCost,
  theoryPointsFor,
  theorySectors,
  timeLabel,
  timeParts,
  timeShort,
  visibleSectorsAt,
  visibleStartAt,
  yearsLabel,
} from '../public/src/rules.js';

const { standard, expert } = MODES;

test('the visible sky window slides one sector per time unit', () => {
  assert.equal(TIME_UNITS_PER_SHIFT, 1);
  assert.deepEqual(visibleSectorsAt(0, standard), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(visibleSectorsAt(1, standard), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(visibleSectorsAt(6, standard), [6, 7, 8, 9, 10, 11]);
  assert.deepEqual(visibleSectorsAt(12, standard), visibleSectorsAt(0, standard));
  assert.equal(visibleStartAt(60, standard), mod(60, 12));
  assert.equal(isVisible(5, standard, 5), true);
  assert.equal(isVisible(5, standard, 10), true);
  assert.equal(isVisible(5, standard, 11), false);
  assert.equal(isVisible(5, standard, 4), false);
});

test('the time-track step follows the arrow for either board size', () => {
  for (const mode of [standard, expert]) {
    for (let units = 0; units < mode.sectors * 3; units++) {
      const start = visibleStartAt(units, mode);
      assert.equal(start, mod(units, mode.sectors));
      assert.equal(start + 1, timeParts(units, mode).step);
      assert.equal(arrowSector(mode, units), timeParts(units, mode).step);
    }
    assert.deepEqual(visibleSectorsAt(mode.sectors, mode), visibleSectorsAt(0, mode));
    assert.equal(arrowSector(mode, mode.sectors - 1), mode.sectors);
    assert.equal(arrowSector(mode, mode.sectors), 1);
  }
});

test('time parts wrap after 12 standard or 18 expert time units', () => {
  assert.deepEqual(timeParts(0, standard), { lap: 1, step: 1 });
  assert.deepEqual(timeParts(11, standard), { lap: 1, step: 12 });
  assert.deepEqual(timeParts(12, standard), { lap: 2, step: 1 });
  assert.deepEqual(timeParts(12, expert), { lap: 1, step: 13 });
  assert.deepEqual(timeParts(17, expert), { lap: 1, step: 18 });
  assert.deepEqual(timeParts(18, expert), { lap: 2, step: 1 });
  assert.deepEqual(timeParts(35, expert), { lap: 2, step: 18 });
  assert.deepEqual(timeParts(36, expert), { lap: 3, step: 1 });
});

test('time helpers default to the standard board and clamp negative display clocks', () => {
  assert.deepEqual(timeParts(12), { lap: 2, step: 1 });
  assert.equal(timeLabel(12), '第 2 圈／第 1 格');
  assert.equal(timeShort(12), '第 2 圈／第 1 格');
  for (const mode of [standard, expert]) {
    assert.deepEqual(timeParts(-1, mode), { lap: 1, step: 1 });
    assert.equal(timeLabel(-1, mode), '第 1 圈／第 1 格');
  }
});

test('full and short clock labels consistently show board laps and steps', () => {
  const cases = [
    [0, standard, '第 1 圈／第 1 格'],
    [12, standard, '第 2 圈／第 1 格'],
    [14, standard, '第 2 圈／第 3 格'],
    [17, expert, '第 1 圈／第 18 格'],
    [18, expert, '第 2 圈／第 1 格'],
    [36, expert, '第 3 圈／第 1 格'],
  ];
  for (const [units, mode, expected] of cases) {
    assert.equal(timeLabel(units, mode), expected);
    assert.equal(timeShort(units, mode), expected);
  }
});

test('durations and the legacy display alias retain the exact number of time units', () => {
  for (const units of [0, 1, 3, 12, 18, 40, 48]) {
    assert.equal(durationLabel(units), `${units} 个时间单位`);
    assert.equal(yearsLabel(units), durationLabel(units));
  }
});

test('events sit on the time track and scale with the board size', () => {
  // standard (12 sectors): conference on 10, theory phases on 3, 6, 9, 12
  assert.deepEqual(conferenceSectors(standard), [10]);
  assert.deepEqual(theorySectors(standard), [3, 6, 9, 12]);
  // expert (18 sectors): conferences on 7 and 16, theory phases every third sector
  assert.deepEqual(conferenceSectors(expert), [7, 16]);
  assert.deepEqual(theorySectors(expert), [3, 6, 9, 12, 15, 18]);
  for (const mode of [standard, expert]) {
    for (const s of conferenceSectors(mode)) assert.ok(s >= 1 && s <= mode.sectors);
    for (const s of theorySectors(mode)) assert.ok(s >= 1 && s <= mode.sectors);
  }
  assert.deepEqual(eventsAt(standard, 9), { sector: 10, conference: true, conferenceIndex: 0, theory: false, theoryIndex: -1 });
  assert.deepEqual(eventsAt(standard, 11), { sector: 12, conference: false, conferenceIndex: -1, theory: true, theoryIndex: 3 });
  assert.equal(eventsAt(standard, 2).theory, true, 'sector 3 is a theory phase');
  assert.equal(eventsAt(standard, 0).conference, false);
  assert.equal(eventsAt(expert, 6).conference, true, 'sector 7 is the expert conference');
  assert.equal(eventsAt(expert, 15).conference, true, 'and sector 16 is the second one');
  assert.equal(EVENT_SECTORS.standard.conferences.length, 1);
  assert.equal(eventSummary(standard), 'X行星会议在第 10 扇区，学术研究在第 3、6、9、12 扇区。');
  assert.match(eventSummary(expert), /X行星会议在第 7、16 扇区/);
});

test('costs are measured in time units', () => {
  assert.equal(surveyCost(1), 4);
  assert.equal(surveyCost(3), 4);
  assert.equal(surveyCost(4), 3);
  assert.equal(surveyCost(6), 3);
  assert.equal(surveyCost(7), 2);
  assert.equal(surveyCost(9), 2);
  assert.equal(COST.target, 4);
  assert.equal(COST.research, 1);
  assert.equal(COST.locate, 5);
  assert.equal(COST.wait, 1);
  assert.equal(COST.theory, 0);
  assert.equal(COST.conference, 0);
  assert.equal(MAX_TARGET_USES, 2);
  assert.deepEqual(THEORY_TRACK, [4, 3, 2, 1]);
});

test('geometry helpers', () => {
  assert.deepEqual(arcSectors(10, 4, 12), [10, 11, 0, 1]);
  assert.equal(mod(-1, 12), 11);
  assert.equal(mod(13, 12), 1);
});

test('object types are the six the board uses', () => {
  assert.equal(NOTE_ROWS.length, 6);
  assert.equal(NOTE_ROWS[0], Obj.PLANET_X, 'Planet X comes first, like the sheet');
  assert.deepEqual(SURVEY_TYPES, [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET, Obj.EMPTY]);
  assert.equal(SURVEY_TYPES.includes(Obj.PLANET_X), false, 'you cannot survey or scan for Planet X');
  assert.equal(apparentType(Obj.PLANET_X), Obj.EMPTY, 'Planet X reads as empty');
  assert.equal(CODE[Obj.PLANET_X], 6);
  assert.equal(LABEL[Obj.EMPTY], '空域');
});

test('the base rules text matches the mode', () => {
  assert.equal(baseRuleText(standard).length, BASE_RULE_TEXT.length);
  assert.ok(baseRuleText(standard).some((line) => line.includes('彗星共 2 颗')));
  assert.ok(baseRuleText(expert).some((line) => line.includes('6 个扇区')), 'expert mentions the dwarf planet band');
});

test('a mode id is never handed out unresolved', () => {
  assert.equal(modeById('standard').sectors, 12);
  assert.equal(modeById('expert').sectors, 18);
  assert.equal(modeById('nonsense').id, 'standard', 'an unknown id falls back to the standard board');
  assert.equal(modeById(undefined).id, 'standard');
  assert.deepEqual(MODE_LIST.map((m) => m.id), ['standard', 'expert'], 'the pickers offer both boards');
});

test('the scoring tables and the locate formula', () => {
  assert.deepEqual(
    THEORY_TYPES,
    ['asteroid', 'comet', 'gasCloud', 'dwarfPlanet'],
    'empty is not a claimable theory: that sector may be Planet X',
  );
  assert.equal(theoryPointsFor(MODES.standard, 'asteroid'), 2);
  assert.equal(theoryPointsFor(MODES.standard, 'comet'), 3);
  assert.equal(theoryPointsFor(MODES.standard, 'gasCloud'), 4);
  assert.equal(theoryPointsFor(MODES.standard, 'dwarfPlanet'), 4);
  assert.equal(theoryPointsFor(MODES.expert, 'dwarfPlanet'), 2, 'four dwarf planets on the expert board pay less');
  assert.equal(theoryPointsFor(MODES.standard, 'empty'), 0, 'an empty claim is worth nothing');
  assert.equal(LEADER_BONUS, 1);

  assert.equal(LOCATE_POINTS.first, 10);
  assert.equal(locatePointsFor(0), 0, 'a pawn in the same sector has no final opportunity');
  assert.equal(locatePointsFor(1), 2);
  assert.equal(locatePointsFor(2), 4);
  assert.equal(locatePointsFor(5), 10);
  assert.equal(locatePointsFor(9), 10, 'valid frozen distances never exceed five');
  assert.equal(locatePointsFor(-3), 0);
});
