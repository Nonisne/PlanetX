import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { Obj, apparentType } from '../public/src/types.js';
import * as puzzles from '../server/puzzles.js';

const SECTOR_COUNT = 12;
const INITIAL_OBJECT_TYPES = [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET];
const COMET_SECTORS = new Set([1, 2, 4, 6, 10]);
const OBJECT_COUNTS = {
  [Obj.ASTEROID]: 4,
  [Obj.COMET]: 2,
  [Obj.GAS_CLOUD]: 2,
  [Obj.DWARF_PLANET]: 1,
  [Obj.EMPTY]: 2,
  [Obj.PLANET_X]: 1,
};
const VALID_BOARD = [
  Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID,
  Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET,
  Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY,
];

function independentlyValid(objects) {
  if (!Array.isArray(objects) || objects.length !== SECTOR_COUNT) return false;
  for (const [objectType, count] of Object.entries(OBJECT_COUNTS)) {
    if (objects.filter((object) => object === objectType).length !== count) return false;
  }
  return objects.every((objectType, sector) => {
    const neighbors = [objects[(sector + 11) % SECTOR_COUNT], objects[(sector + 1) % SECTOR_COUNT]];
    if (objectType === Obj.COMET) return COMET_SECTORS.has(sector);
    if (objectType === Obj.ASTEROID) return neighbors.includes(Obj.ASTEROID);
    if (objectType === Obj.GAS_CLOUD) return neighbors.includes(Obj.EMPTY);
    if (objectType === Obj.DWARF_PLANET) return !neighbors.includes(Obj.PLANET_X);
    return true;
  });
}

let independentCandidates;

function allIndependentBoards() {
  if (independentCandidates) return independentCandidates;
  const remaining = { ...OBJECT_COUNTS };
  const objects = [];
  const candidates = [];
  function visit(sector) {
    if (sector === SECTOR_COUNT) {
      if (independentlyValid(objects)) candidates.push(objects.slice());
      return;
    }
    for (const objectType of Object.keys(remaining)) {
      if (!remaining[objectType]) continue;
      if (objectType === Obj.COMET && !COMET_SECTORS.has(sector)) continue;
      const previous = objects[sector - 1];
      const beforePrevious = objects[sector - 2];
      if (previous === Obj.PLANET_X && objectType === Obj.DWARF_PLANET) continue;
      if (previous === Obj.DWARF_PLANET && objectType === Obj.PLANET_X) continue;
      if (sector >= 2 && previous === Obj.ASTEROID && beforePrevious !== Obj.ASTEROID && objectType !== Obj.ASTEROID) continue;
      if (sector >= 2 && previous === Obj.GAS_CLOUD && beforePrevious !== Obj.EMPTY && objectType !== Obj.EMPTY) continue;
      remaining[objectType] -= 1;
      objects.push(objectType);
      visit(sector + 1);
      objects.pop();
      remaining[objectType] += 1;
    }
  }
  visit(0);
  independentCandidates = candidates;
  return candidates;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const TOPIC_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const CLUE_TYPES = {
  小行星: Obj.ASTEROID,
  彗星: Obj.COMET,
  气体云: Obj.GAS_CLOUD,
  矮行星: Obj.DWARF_PLANET,
  X行星: Obj.PLANET_X,
};

function ringDistance(first, second) {
  const difference = Math.abs(first - second);
  return Math.min(difference, SECTOR_COUNT - difference);
}

function readClueType(label) {
  assert.ok(Object.hasOwn(CLUE_TYPES, label), `unambiguous true-object label: ${label}`);
  return CLUE_TYPES[label];
}

function completeObservationExclusions(puzzle) {
  return puzzle.objects.flatMap((object, sector) => INITIAL_OBJECT_TYPES
    .filter((objectType) => objectType !== object)
    .map((objectType) => ({ sector, objectType })));
}

function interpretedRelation(subjectLabel, neighborLabel, relation, quantifier, range) {
  const objectType = readClueType(subjectLabel);
  const neighborType = readClueType(neighborLabel);
  assert.ok([...INITIAL_OBJECT_TYPES, Obj.PLANET_X].includes(objectType));
  assert.ok([...INITIAL_OBJECT_TYPES, Obj.PLANET_X].includes(neighborType));
  assert.notEqual(objectType, neighborType);
  if (relation === 'within') assert.ok(range >= 2 && range < SECTOR_COUNT / 2);
  return {
    kind: relation,
    objectTypes: [objectType, neighborType],
    test: (objects) => {
      const subjects = objects.flatMap((object, sector) => object === objectType ? [sector] : []);
      const neighbors = objects.flatMap((object, sector) => object === neighborType ? [sector] : []);
      const related = subjects.map((subject) => neighbors.some((neighbor) => {
        const distance = ringDistance(subject, neighbor);
        if (relation === 'adjacent') return distance === 1;
        if (relation === 'opposite') return distance === SECTOR_COUNT / 2;
        return distance > 0 && distance <= range;
      }));
      if (quantifier === 'none') return related.every((result) => !result);
      if (quantifier === 'some') return related.some(Boolean);
      return related.every(Boolean);
    },
  };
}

function parseClueText(clue) {
  return clue.split('。').map((sentence) => sentence.trim()).filter(Boolean).map((sentence) => {
    let fields = sentence.match(/^X行星(不与任何|与至少一个)(.+)(相邻|正对)$/u);
    if (fields) {
      return interpretedRelation('X行星', fields[2], fields[3] === '相邻' ? 'adjacent' : 'opposite', fields[1] === '不与任何' ? 'none' : 'some');
    }
    fields = sentence.match(/^X行星(不在任何|位于至少一个)(.+)的 (\d+) 个扇区以内$/u);
    if (fields) {
      return interpretedRelation('X行星', fields[2], 'within', fields[1] === '不在任何' ? 'none' : 'some', Number(fields[3]));
    }
    fields = sentence.match(/^所有(.+)都位于一段不超过 (\d+) 个连续扇区内$/u);
    if (fields) {
      const objectType = readClueType(fields[1]);
      const length = Number(fields[2]);
      assert.ok(INITIAL_OBJECT_TYPES.includes(objectType));
      assert.ok(OBJECT_COUNTS[objectType] > 1);
      assert.ok(length >= OBJECT_COUNTS[objectType] && length < SECTOR_COUNT);
      return {
        kind: 'band',
        objectTypes: [objectType],
        test: (objects) => {
          const positions = objects.flatMap((object, sector) => object === objectType ? [sector] : []);
          return Array.from({ length: SECTOR_COUNT }, (unused, start) => start)
            .some((start) => positions.every((sector) => (sector - start + SECTOR_COUNT) % SECTOR_COUNT < length));
        },
      };
    }
    for (const [quantifier, pattern] of [
      ['none', /^没有任何(.+)与(.+)(相邻|正对)$/u],
      ['some', /^至少有一个(.+)与(?:某个)?(.+)(相邻|正对)$/u],
      ['all', /^每个(.+)都与(?:至少一个)?(.+)(相邻|正对)$/u],
    ]) {
      fields = sentence.match(pattern);
      if (fields) return interpretedRelation(fields[1], fields[2], fields[3] === '相邻' ? 'adjacent' : 'opposite', quantifier);
    }
    for (const [quantifier, pattern] of [
      ['none', /^没有任何(.+)位于(.+)的 (\d+) 个扇区以内$/u],
      ['some', /^至少有一个(.+)位于(?:某个)?(.+)的 (\d+) 个扇区以内$/u],
      ['all', /^每个(.+)都位于(?:至少一个)?(.+)的 (\d+) 个扇区以内$/u],
    ]) {
      fields = sentence.match(pattern);
      if (fields) return interpretedRelation(fields[1], fields[2], 'within', quantifier, Number(fields[3]));
    }
    assert.fail(`unsupported or ambiguous displayed clue: ${sentence}`);
  });
}

function parseConferenceText(clue) {
  assert.match(clue, /^[^。！？\n]+。$/u);
  assert.doesNotMatch(clue, /空域|从第|位于第|恰有|最短环形距离|每个X行星|任何X行星|某个X行星|至少(?:有)?一个X行星/u);
  const statements = parseClueText(clue);
  assert.equal(statements.length, 1);
  const [statement] = statements;
  assert.ok(['adjacent', 'opposite', 'within'].includes(statement.kind));
  assert.equal(statement.objectTypes.length, 2);
  assert.ok(statement.objectTypes.includes(Obj.PLANET_X));
  assert.equal(statement.objectTypes.filter((objectType) => INITIAL_OBJECT_TYPES.includes(objectType)).length, 1);
  return statement;
}

let independentConferences;

function independentConferenceSpace() {
  if (independentConferences) return independentConferences;
  const candidates = allIndependentBoards();
  const observationGroups = new Map();
  for (const [index, objects] of candidates.entries()) {
    const key = objects.map(apparentType).join(',');
    if (!observationGroups.has(key)) observationGroups.set(key, []);
    observationGroups.get(key).push(index);
  }
  const statements = [];
  for (const [label, objectType] of Object.entries(CLUE_TYPES)) {
    if (!INITIAL_OBJECT_TYPES.includes(objectType)) continue;
    for (const [subject, neighbor] of [['X行星', label], [label, 'X行星']]) {
      for (const [relation, range] of [['adjacent'], ['opposite'], ['within', 2], ['within', 3], ['within', 4], ['within', 5]]) {
        for (const quantifier of ['none', 'some', 'all']) {
          const statement = interpretedRelation(subject, neighbor, relation, quantifier, range);
          const values = Uint8Array.from(candidates, (objects) => Number(statement.test(objects)));
          statements.push({ ...statement, values });
        }
      }
    }
  }
  const informative = statements.filter((statement) => statement.values.includes(0) && statement.values.includes(1));
  const eligible = [];
  const excluded = [];
  for (const [index, objects] of candidates.entries()) {
    const peers = observationGroups.get(objects.map(apparentType).join(','));
    const distinguishable = informative.some((statement) => statement.values[index] === 1
      && peers.every((peer) => peer === index || statement.values[peer] === 0));
    (distinguishable ? eligible : excluded).push(objects);
  }
  independentConferences = { candidates, observationGroups, informative, eligible, excluded };
  return independentConferences;
}

test('standard board validation accepts the declared inventory and circular neighbors', () => {
  assert.equal(puzzles.validateBoard(VALID_BOARD), true);
  assert.equal(puzzles.validateBoard([
    Obj.ASTEROID, Obj.COMET, Obj.COMET, Obj.GAS_CLOUD,
    Obj.EMPTY, Obj.DWARF_PLANET, Obj.EMPTY, Obj.GAS_CLOUD,
    Obj.PLANET_X, Obj.ASTEROID, Obj.ASTEROID, Obj.ASTEROID,
  ]), true);
  assert.equal(puzzles.validateBoard([
    Obj.EMPTY, Obj.COMET, Obj.COMET, Obj.ASTEROID,
    Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET,
    Obj.ASTEROID, Obj.ASTEROID, Obj.PLANET_X, Obj.GAS_CLOUD,
  ]), true);
});

test('standard board validation rejects each forbidden placement, including wraparound', () => {
  const forbiddenComet = VALID_BOARD.slice();
  [forbiddenComet[0], forbiddenComet[1]] = [forbiddenComet[1], forbiddenComet[0]];
  assert.equal(puzzles.validateBoard(forbiddenComet), false);
  assert.equal(puzzles.validateBoard([
    Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID,
    Obj.DWARF_PLANET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID,
    Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY,
  ]), false);
  assert.equal(puzzles.validateBoard([
    Obj.EMPTY, Obj.COMET, Obj.COMET, Obj.ASTEROID,
    Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET,
    Obj.ASTEROID, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.PLANET_X,
  ]), false, 'Planet X does not satisfy a gas cloud’s true-empty neighbor rule');
  assert.equal(puzzles.validateBoard([
    Obj.PLANET_X, Obj.COMET, Obj.COMET, Obj.ASTEROID,
    Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID,
    Obj.ASTEROID, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET,
  ]), false, 'sectors 12 and 1 are adjacent');
});

test('standard board validation rejects malformed boards and incorrect inventory', () => {
  for (const objects of [null, undefined, {}, [], VALID_BOARD.slice(1), [...VALID_BOARD, Obj.EMPTY]]) {
    assert.equal(puzzles.validateBoard(objects), false);
  }
  for (const replacement of [Obj.EMPTY, 'unknown', 6, undefined]) {
    const objects = VALID_BOARD.slice();
    objects[0] = replacement;
    assert.equal(puzzles.validateBoard(objects), false);
  }
});

test('board validation agrees with an independent exhaustive backtracking oracle', (context) => {
  const started = performance.now();
  const candidates = allIndependentBoards();
  assert.equal(candidates.length, 4446);
  assert.equal(new Set(candidates.map((objects) => objects.join(','))).size, candidates.length);
  for (const objects of candidates) assert.equal(puzzles.validateBoard(objects), true);
  context.diagnostic(`${candidates.length} independent valid boards; enumeration ${Math.round(performance.now() - started)}ms`);
});

test('research topics name one or two ordinary objects and contain exactly one fact', () => {
  const topicPattern = /^(小行星|彗星|气体云|矮行星)(?:和(小行星|彗星|气体云|矮行星))?$/u;
  for (let seed = 0; seed < 24; seed += 1) {
    const puzzle = puzzles.createPuzzle({ random: seededRandom(seed + 700) });
    const topics = Object.values(puzzle.topics);
    assert.equal(new Set(topics.map((topic) => topic.name)).size, 6);
    for (const topic of topics) {
      assert.match(topic.name, topicPattern, 'topic names must not leak the relation or a bound');
      assert.equal(topic.clue.split('。').filter((sentence) => sentence.trim()).length, 1);
      assert.doesNotMatch(topic.clue, /从第|恰有|之间的最短环形距离为/u);
    }
  }
});

test('relative research preserves legal mirror candidates until observations distinguish them', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(648) });
  const comets = puzzle.objects.flatMap((object, sector) => object === Obj.COMET ? [sector] : []);
  const reflected = puzzle.objects.map((unused, sector) => puzzle.objects[(comets[0] + comets[1] - sector + 24) % 12]);
  assert.ok(independentlyValid(reflected));
  assert.notDeepEqual(reflected, puzzle.objects);
  assert.equal(puzzles.matchingClues(reflected, puzzle), true, 'relative facts cannot encode an arbitrary board orientation');
  assert.ok(puzzles.countSolutions(puzzle) >= 2);
  const observations = completeObservationExclusions(puzzle);
  assert.equal(puzzles.countSolutions(puzzle, { initialClues: observations }), 1);
});

test('X conferences state exactly one relative fact about X and one ordinary type', () => {
  for (let seed = 0; seed < 32; seed += 1) {
    const puzzle = puzzles.createPuzzle({ random: seededRandom(seed + 1200) });
    const statement = parseConferenceText(puzzle.conferences[10]);
    assert.equal(statement.test(puzzle.objects), true);
  }
});

test('the independent relation oracle finds 114 informative predicates and 4428 eligible boards', () => {
  const { candidates, informative, eligible, excluded } = independentConferenceSpace();
  assert.equal(candidates.length, 4446);
  assert.equal(informative.length, 114);
  assert.equal(eligible.length, 4428);
  assert.equal(excluded.length, 18);
  assert.equal(new Set([...eligible, ...excluded].map((objects) => objects.join(','))).size, 4446);
});

test('ambiguous boards stay legal solver possibilities rather than becoming hidden player knowledge', () => {
  const ambiguous = [
    Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.DWARF_PLANET,
    Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.PLANET_X,
    Obj.GAS_CLOUD, Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY,
  ];
  const swapped = ambiguous.slice();
  [swapped[7], swapped[11]] = [swapped[11], swapped[7]];
  const { candidates, observationGroups, informative, eligible, excluded } = independentConferenceSpace();
  const excludedKeys = new Set(excluded.map((objects) => objects.join(',')));
  for (const objects of [ambiguous, swapped]) {
    assert.ok(independentlyValid(objects));
    assert.equal(puzzles.validateBoard(objects), true);
    assert.equal(excludedKeys.has(objects.join(',')), true);
    assert.equal(eligible.some((candidate) => candidate.join(',') === objects.join(',')), false);
  }
  assert.deepEqual(ambiguous.map(apparentType), swapped.map(apparentType));
  for (const statement of informative) assert.equal(statement.test(ambiguous), statement.test(swapped));
  const puzzle = puzzles.createPuzzle({ random: seededRandom(18) });
  for (const objects of excluded) {
    const peers = observationGroups.get(objects.map(apparentType).join(',')).map((index) => candidates[index]);
    const options = { topicIds: [], includeConference: false, initialClues: completeObservationExclusions({ objects }) };
    assert.equal(puzzles.validateBoard(objects), true);
    assert.equal(puzzles.countSolutions(puzzle, options), peers.length);
    for (const peer of peers) assert.equal(puzzles.matchingClues(peer, puzzle, options), true);
  }
});

test('generation exposes the standard server contract without serializing private constraints', async (context) => {
  assert.equal(typeof puzzles.createPuzzle, 'function');
  assert.equal(typeof puzzles.matchingClues, 'function');
  assert.equal(typeof puzzles.countSolutions, 'function');
  const coldPuzzles = await import('../server/puzzles.js?cold-generation-test');
  const started = performance.now();
  const puzzle = coldPuzzles.createPuzzle({ random: seededRandom(42) });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `cold enumeration and first puzzle took ${Math.round(elapsed)}ms`);
  assert.deepEqual(Object.keys(puzzle).sort(), ['conferenceNames', 'conferences', 'modeId', 'objects', 'topics']);
  assert.equal(puzzle.modeId, 'standard');
  assert.deepEqual(Object.keys(puzzle.conferenceNames), ['10']);
  assert.match(puzzle.conferenceNames[10], /^X行星和(小行星|彗星|气体云|矮行星)$/u);
  assert.deepEqual(Object.keys(puzzle.topics), TOPIC_IDS);
  assert.deepEqual(Object.keys(puzzle.conferences), ['10']);
  assert.equal(typeof puzzle.conferences[10], 'string');
  assert.match(puzzle.conferences[10], /X行星/u);
  assert.ok(independentlyValid(puzzle.objects));
  assert.equal(puzzle.objects.filter((object) => object === Obj.EMPTY).length, 2);
  assert.equal(puzzle.objects.filter((object) => apparentType(object) === Obj.EMPTY).length, 3);
  for (const topic of Object.values(puzzle.topics)) {
    assert.deepEqual(Object.keys(topic).sort(), ['clue', 'name']);
    assert.equal(typeof topic.name, 'string');
    assert.ok(topic.name.trim().length > 0);
    assert.equal(typeof topic.clue, 'string');
    assert.ok(topic.clue.trim().length > 0);
    assert.doesNotMatch(topic.clue, /X行星/u, 'research and the X conference have distinct subjects');
  }
  assert.deepEqual(JSON.parse(JSON.stringify(puzzle)), puzzle);
  assert.ok(independentlyValid(puzzles.createPuzzle().objects));
  context.diagnostic(`cold enumeration, feature cache, and first puzzle ${Math.round(elapsed)}ms`);
});

test('unknown modes are explicitly rejected instead of falling back', () => {
  for (const modeId of ['unknown', '', null, 12]) {
    assert.throws(() => puzzles.createPuzzle({ modeId }), /standard|标准/u);
  }
});

test('generation rejects invalid random sources and out-of-range draws', () => {
  for (const random of [null, false, 0, 'random']) {
    assert.throws(() => puzzles.createPuzzle({ random }), /random/u);
  }
  for (const draw of [-0.1, 1, NaN, Infinity, undefined, '0.5']) {
    assert.throws(() => puzzles.createPuzzle({ random: () => draw }), /random/u);
  }
  assert.throws(() => puzzles.createPuzzle({ random: (() => {
    let calls = 0;
    return () => calls++ === 0 ? 0.5 : NaN;
  })() }), /random/u);
});

test('equal random streams reproduce puzzles and constant streams stay observation-solvable', () => {
  assert.deepEqual(
    puzzles.createPuzzle({ random: seededRandom(123456789) }),
    puzzles.createPuzzle({ modeId: 'standard', random: seededRandom(123456789) }),
  );
  for (const draw of [0, 0.5, 1 - Number.EPSILON]) {
    const puzzle = puzzles.createPuzzle({ random: () => draw });
    assert.ok(independentlyValid(puzzle.objects));
    assert.equal(puzzles.countSolutions(puzzle, { initialClues: completeObservationExclusions(puzzle) }), 1);
  }
});

test('the candidate counter covers the complete independent valid-board space', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(7) });
  assert.equal(puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false }), allIndependentBoards().length);
  assert.equal(puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false, limit: 2 }), 2);
  assert.equal(puzzles.countSolutions(puzzle, { limit: 2 }), Math.min(2, puzzles.countSolutions(puzzle)));
});

test('displayed facts independently match candidates and become unique with complete observations', (context) => {
  const candidates = allIndependentBoards();
  const clueKinds = new Set();
  let maximumClauses = 0;
  for (let seed = 0; seed < 32; seed += 1) {
    const puzzle = puzzles.createPuzzle({ random: seededRandom(seed * 104729 + 17) });
    const statements = [...Object.values(puzzle.topics).map((topic) => topic.clue), puzzle.conferences[10]];
    const parsed = statements.flatMap(parseClueText);
    maximumClauses = Math.max(maximumClauses, parsed.length);
    assert.equal(new Set(statements.flatMap((clue) => clue.split('。').map((sentence) => sentence.trim()).filter(Boolean))).size, parsed.length);
    for (const statement of parsed) {
      clueKinds.add(statement.kind);
      assert.equal(statement.test(puzzle.objects), true, `truth at seed ${seed}`);
    }
    for (const [topicId, topic] of Object.entries(puzzle.topics)) {
      const topicStatements = parseClueText(topic.clue);
      const remaining = candidates.filter((objects) => topicStatements.every((statement) => statement.test(objects))).length;
      assert.ok(remaining > 1 && remaining < candidates.length, `topic ${topicId} is informative without listing the solution`);
      assert.equal(puzzles.countSolutions(puzzle, { topicIds: [topicId], includeConference: false }), remaining);
      assert.equal(topicStatements.length, 1, 'one research action reveals exactly one fact');
      const expectedName = INITIAL_OBJECT_TYPES.filter((objectType) => topicStatements[0].objectTypes.includes(objectType))
        .map((objectType) => Object.keys(CLUE_TYPES).find((label) => CLUE_TYPES[label] === objectType)).join('和');
      assert.equal(topic.name, expectedName, 'the subject matches the clue without leaking its predicate');
    }
    const conferenceStatement = parseConferenceText(puzzle.conferences[10]);
    const conferenceCount = candidates.filter((objects) => conferenceStatement.test(objects)).length;
    assert.ok(conferenceCount > 1 && conferenceCount < candidates.length);
    assert.equal(puzzles.countSolutions(puzzle, { topicIds: [] }), conferenceCount);
    const solutions = candidates.filter((objects) => parsed.every((statement) => statement.test(objects)));
    assert.ok(solutions.some((objects) => objects.every((object, sector) => object === puzzle.objects[sector])));
    assert.equal(puzzles.countSolutions(puzzle), solutions.length);
    const observedSolutions = solutions.filter((objects) => objects.every((object, sector) => apparentType(object) === apparentType(puzzle.objects[sector])));
    assert.deepEqual(observedSolutions, [puzzle.objects], `complete observations make the full board unique at seed ${seed}`);
    const initialClues = completeObservationExclusions(puzzle);
    assert.equal(puzzles.countSolutions(puzzle, { initialClues }), observedSolutions.length);
    assert.equal(puzzles.countSolutions(puzzle, { initialClues, topicIds: [] }), 1, 'the conference distinguishes X from true empty even without research');
    const helperSolutions = candidates.filter((objects) => puzzles.matchingClues(objects, puzzle));
    assert.deepEqual(helperSolutions, solutions, 'the helper agrees with separately interpreted public clue text');
  }
  for (const kind of ['band', 'adjacent', 'opposite', 'within']) assert.ok(clueKinds.has(kind), `generated clues include ${kind}`);
  assert.equal(maximumClauses, 7);
  context.diagnostic(`32 independently solved puzzles; clue kinds ${[...clueKinds].join(', ')}; maximum ${maximumClauses} statements`);
});

test('candidate filtering uses deduction constraints, not the stored answer', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(987) });
  const answer = puzzle.objects;
  const expectedCount = puzzles.countSolutions(puzzle);
  const initialClues = completeObservationExclusions(puzzle);
  puzzle.objects = Array(SECTOR_COUNT).fill(Obj.EMPTY);
  assert.equal(puzzles.countSolutions(puzzle), expectedCount);
  assert.equal(puzzles.countSolutions(puzzle, { initialClues }), 1);
  assert.equal(puzzles.matchingClues(answer, puzzle), true);
  assert.equal(puzzles.matchingClues(puzzle.objects, puzzle), false);
  assert.equal(puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false }), allIndependentBoards().length);
});

test('uniform board sampling uses equal-sized bins without rejection or rotation bias', () => {
  const total = independentConferenceSpace().eligible.length;
  const boards = new Set();
  for (const index of [0, 1, 17, 100, Math.floor(total / 2), total - 2, total - 1]) {
    function selectAt(fraction) {
      let calls = 0;
      const puzzle = puzzles.createPuzzle({ random: () => calls++ === 0 ? fraction : 0 });
      assert.equal(calls, 13, 'one board draw, one conference draw, six topic draws and five shuffle draws');
      return puzzle;
    }
    const lower = selectAt((index + 0.01) / total);
    const upper = selectAt((index + 0.99) / total);
    assert.deepEqual(lower.objects, upper.objects);
    assert.ok(independentlyValid(lower.objects));
    boards.add(lower.objects.join(','));
  }
  assert.equal(boards.size, 7);
});

test('generation produces varied complete puzzles within a bounded warm runtime', (context) => {
  const candidates = allIndependentBoards();
  const random = seededRandom(20260920);
  const generated = new Set();
  const research = new Set();
  const xHistogram = Array(SECTOR_COUNT).fill(0);
  const started = performance.now();
  for (let sample = 0; sample < 256; sample += 1) {
    const puzzle = puzzles.createPuzzle({ random });
    assert.ok(independentlyValid(puzzle.objects));
    assert.equal(puzzles.countSolutions(puzzle, { initialClues: completeObservationExclusions(puzzle) }), 1);
    generated.add(puzzle.objects.join(','));
    research.add(JSON.stringify(puzzle.topics));
    xHistogram[puzzle.objects.indexOf(Obj.PLANET_X)] += 1;
  }
  const elapsed = performance.now() - started;
  const possibleXSectors = new Set(candidates.map((objects) => objects.indexOf(Obj.PLANET_X)));
  assert.ok(generated.size >= 230, `${generated.size} different boards in 256 draws`);
  assert.ok(research.size >= 250);
  for (const sector of possibleXSectors) assert.ok(xHistogram[sector] > 0, `X can occur in sector ${sector + 1}`);
  assert.ok(elapsed < 10000, `256 cached generations took ${Math.round(elapsed)}ms`);
  context.diagnostic(`256 puzzles: ${generated.size} boards, ${research.size} research sets, ${Math.round(elapsed)}ms; X histogram ${xHistogram.join(',')}`);
});

test('four seats receive twelve fresh ordinary-object exclusions while the helper defaults to four', () => {
  assert.equal(typeof puzzles.initialCluesFor, 'function');
  const puzzle = puzzles.createPuzzle({ random: seededRandom(11) });
  const snapshot = JSON.stringify(puzzle);
  const random = seededRandom(8675309);
  const startingClues = Array.from({ length: 4 }, () => puzzles.initialCluesFor(puzzle, { count: 12, random }));
  assert.equal(JSON.stringify(puzzle), snapshot, 'issuing clues does not mutate or publish them on the puzzle');
  assert.equal(new Set(startingClues.map((clues) => JSON.stringify(clues))).size, 4);
  for (const clues of startingClues) {
    assert.equal(clues.length, 12);
    assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, clues.length);
    for (const clue of clues) {
      assert.deepEqual(Object.keys(clue).sort(), ['objectType', 'sector']);
      assert.ok(Number.isInteger(clue.sector) && clue.sector >= 0 && clue.sector < SECTOR_COUNT);
      assert.ok(INITIAL_OBJECT_TYPES.includes(clue.objectType), `initial clues cannot exclude ${clue.objectType}`);
      assert.notEqual(clue.objectType, apparentType(puzzle.objects[clue.sector]));
      assert.ok(clue.objectType !== Obj.COMET || COMET_SECTORS.has(clue.sector));
    }
    assert.ok(puzzles.countSolutions(puzzle, { initialClues: clues }) >= 1);
    assert.equal(puzzles.matchingClues(puzzle.objects, puzzle, { initialClues: clues }), true);
  }
  assert.equal(puzzles.initialCluesFor(puzzle).length, 4);
  const expectedCount = puzzles.countSolutions(puzzle);
  puzzle.startingClues = startingClues;
  assert.equal(puzzles.countSolutions(puzzle), expectedCount, 'main may attach its per-player starting clue arrays');
  assert.equal(puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false }), allIndependentBoards().length);
  const otherPlayer = JSON.stringify(startingClues[1]);
  startingClues[0][0].sector = -1;
  assert.equal(JSON.stringify(startingClues[1]), otherPlayer);
});

test('initial clue sampling handles the entire finite exclusion pool without retry loops', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(81) });
  for (const random of [() => 0, () => 1 - Number.EPSILON, seededRandom(999)]) {
    const clues = puzzles.initialCluesFor(puzzle, { count: 32, random });
    assert.equal(clues.length, 32);
    assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, 32);
    const expected = puzzle.objects.flatMap((object, sector) => INITIAL_OBJECT_TYPES
      .filter((objectType) => objectType !== apparentType(object) && (objectType !== Obj.COMET || COMET_SECTORS.has(sector)))
      .map((objectType) => `${sector}:${objectType}`));
    assert.deepEqual(clues.map(({ sector, objectType }) => `${sector}:${objectType}`).sort(), expected.sort());
    const xSector = puzzle.objects.indexOf(Obj.PLANET_X);
    assert.equal(clues.filter(({ sector }) => sector === xSector).length, COMET_SECTORS.has(xSector) ? 4 : 3);
    assert.ok(clues.every(({ sector, objectType }) => sector !== xSector || objectType !== Obj.EMPTY));
  }
  assert.deepEqual(puzzles.initialCluesFor(puzzle, { count: 0, random: () => assert.fail('zero clues need no random draws') }), []);
  for (const count of [0, 4, 8, 12]) {
    const clues = puzzles.initialCluesFor(puzzle, { count, random: seededRandom(123 + count) });
    assert.equal(clues.length, count);
    assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, count);
    assert.ok(clues.every(({ sector, objectType }) => apparentType(puzzle.objects[sector]) !== objectType));
  }
});

test('partial initial hands cap prime-comet exclusions and keep enough base-rule candidates', () => {
  for (let seed = 0; seed < 64; seed += 1) {
    const puzzle = puzzles.createPuzzle({ random: seededRandom(seed + 401) });
    for (const count of [4, 8, 12]) {
      const clues = puzzles.initialCluesFor(puzzle, { count, random: seededRandom(seed * 17 + count) });
      assert.equal(clues.length, count);
      const cometExclusions = clues.filter(({ objectType }) => objectType === Obj.COMET).length;
      assert.ok(cometExclusions <= 1, `standard hand seed=${seed} count=${count} had ${cometExclusions} comet exclusions`);
      const candidates = puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues: clues });
      assert.ok(candidates >= 64, `standard hand seed=${seed} count=${count} left only ${candidates} candidates`);
      assert.equal(puzzles.matchingClues(puzzle.objects, puzzle, { initialClues: clues }), true);
    }
  }
});

test('all 4446 base-legal boards have exactly 32 true nontrivial initial exclusions', () => {
  for (const objects of allIndependentBoards()) {
    let draws = 0;
    const clues = puzzles.initialCluesFor({ objects }, { count: 32, random: () => { draws += 1; return 0; } });
    assert.equal(draws, 32);
    assert.equal(clues.length, 32);
    assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, 32);
    for (const { sector, objectType } of clues) {
      assert.ok(INITIAL_OBJECT_TYPES.includes(objectType));
      assert.notEqual(objects[sector], objectType);
      assert.ok(objectType !== Obj.COMET || COMET_SECTORS.has(sector), `nontrivial exclusion at sector ${sector + 1}`);
    }
    assert.throws(() => puzzles.initialCluesFor({ objects }, { count: 33 }), /count/u);
  }
});

test('initial clue issuance rejects invalid counts, boards, and random sources', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(91) });
  for (const count of [-1, 0.5, 33, 39, 40, 48, 49, NaN, Infinity, null, false, '4']) {
    assert.throws(() => puzzles.initialCluesFor(puzzle, { count }), /count/u);
  }
  for (const invalidPuzzle of [null, undefined, {}, { objects: [] }, { objects: Array(SECTOR_COUNT).fill(Obj.EMPTY) }]) {
    assert.throws(() => puzzles.initialCluesFor(invalidPuzzle), /valid standard board/u);
  }
  for (const random of [null, false, 7, () => -1, () => 1, () => NaN, () => '0.5']) {
    assert.throws(() => puzzles.initialCluesFor(puzzle, { random }), /random/u);
  }
});

test('ordinary-object initial exclusions do not distinguish X from true empty sectors', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(982) });
  const allClues = puzzles.initialCluesFor(puzzle, { count: 32, random: () => 0 });
  const options = { topicIds: [], includeConference: false, initialClues: allClues };
  const expected = allIndependentBoards().filter((objects) => objects.every((object, sector) => apparentType(object) === apparentType(puzzle.objects[sector])));
  assert.ok(expected.length > 0);
  assert.equal(puzzles.countSolutions(puzzle, options), expected.length);
  assert.deepEqual(allIndependentBoards().filter((objects) => puzzles.matchingClues(objects, puzzle, options)), expected);
  const impossible = [{ sector: puzzle.objects.indexOf(Obj.COMET), objectType: Obj.COMET }];
  assert.equal(puzzles.countSolutions(puzzle, { initialClues: impossible }), 0);
  assert.equal(puzzles.matchingClues(puzzle.objects, puzzle, { initialClues: impossible }), false);
  const duplicate = [allClues[0], allClues[0]];
  assert.equal(
    puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues: duplicate }),
    puzzles.countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues: duplicate.slice(1) }),
  );
});

test('solver rejects malformed selections instead of silently ignoring them', () => {
  const puzzle = puzzles.createPuzzle({ random: seededRandom(456) });
  for (const topicIds of [null, 'A', ['G'], [1]]) {
    assert.throws(() => puzzles.countSolutions(puzzle, { topicIds }), /topicIds/u);
  }
  for (const includeConference of [null, 0, 'false']) {
    assert.throws(() => puzzles.countSolutions(puzzle, { includeConference }), /includeConference/u);
  }
  for (const limit of [0, -1, 0.1, NaN, '2']) {
    assert.throws(() => puzzles.countSolutions(puzzle, { limit }), /limit/u);
  }
  for (const initialClues of [null, {}, [null], [{ sector: -1, objectType: Obj.COMET }],
    [{ sector: 12, objectType: Obj.COMET }], [{ sector: 1.5, objectType: Obj.COMET }],
    [{ sector: 1, objectType: 'unknown' }], [{ sector: 1, objectType: Obj.PLANET_X }],
    [{ sector: 1, objectType: Obj.EMPTY }]]) {
    assert.throws(() => puzzles.countSolutions(puzzle, { initialClues }), /initialClues/u);
    assert.throws(() => puzzles.matchingClues(puzzle.objects, puzzle, { initialClues }), /initialClues/u);
  }
  assert.throws(() => puzzles.countSolutions({ ...puzzle }), /createPuzzle/u);
  assert.equal(
    puzzles.countSolutions(puzzle, { topicIds: ['A', 'A'], includeConference: false }),
    puzzles.countSolutions(puzzle, { topicIds: ['A'], includeConference: false }),
  );
});

test('puzzles and their clue strings do not share mutable state through the server cache', () => {
  const original = puzzles.createPuzzle({ random: seededRandom(789) });
  const expected = puzzles.createPuzzle({ random: seededRandom(789) });
  original.objects[0] = 'changed';
  original.topics.A.name = 'changed';
  original.topics.A.clue = 'changed';
  original.conferences[10] = 'changed';
  assert.deepEqual(puzzles.createPuzzle({ random: seededRandom(789) }), expected);
});

test('all 4428 eligible boards have a conference distinguishing every original observation peer (PUZZLE_EXHAUSTIVE=1)', {
  skip: process.env.PUZZLE_EXHAUSTIVE !== '1',
}, (context) => {
  const { candidates, eligible, observationGroups } = independentConferenceSpace();
  const unsampled = new Set(eligible.map((objects) => objects.join(',')));
  let maximumStatements = 0;
  let maximumGeneration = 0;
  const started = performance.now();
  for (let index = 0; index < eligible.length; index += 1) {
    const random = seededRandom(index * 65537 + 20260920);
    let firstDraw = true;
    const generationStarted = performance.now();
    const puzzle = puzzles.createPuzzle({ random: () => {
      if (!firstDraw) return random();
      firstDraw = false;
      return (index + 0.5) / eligible.length;
    } });
    maximumGeneration = Math.max(maximumGeneration, performance.now() - generationStarted);
    assert.equal(unsampled.delete(puzzle.objects.join(',')), true, `uniform bin ${index} selects a different eligible board`);
    assert.equal(puzzles.countSolutions(puzzle, { topicIds: [], initialClues: completeObservationExclusions(puzzle) }), 1, `conference-only observable uniqueness for bin ${index}`);
    const researchStatements = Object.values(puzzle.topics).map((topic) => parseClueText(topic.clue));
    for (const statements of researchStatements) {
      assert.equal(statements.length, 1);
      assert.ok(statements[0].objectTypes.every((objectType) => INITIAL_OBJECT_TYPES.includes(objectType)));
    }
    assert.equal(new Set(Object.values(puzzle.topics).map((topic) => topic.name)).size, 6);
    const conferenceStatement = parseConferenceText(puzzle.conferences[10]);
    const allStatements = [...researchStatements.flat(), conferenceStatement];
    maximumStatements = Math.max(maximumStatements, allStatements.length);
    assert.equal(allStatements.every((statement) => statement.test(puzzle.objects)), true);
    const observedCandidates = observationGroups.get(puzzle.objects.map(apparentType).join(',')).map((peer) => candidates[peer]);
    assert.deepEqual(observedCandidates.filter((objects) => conferenceStatement.test(objects)), [puzzle.objects]);
    assert.deepEqual(observedCandidates.filter((objects) => allStatements.every((statement) => statement.test(objects))), [puzzle.objects]);
    for (let player = 0; player < 4; player += 1) {
      const clues = puzzles.initialCluesFor(puzzle, { count: 12, random });
      assert.equal(clues.length, 12);
      assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, 12);
      assert.ok(clues.every(({ objectType }) => INITIAL_OBJECT_TYPES.includes(objectType)));
      assert.ok(clues.every(({ sector, objectType }) => apparentType(puzzle.objects[sector]) !== objectType));
      assert.ok(clues.every(({ sector, objectType }) => objectType !== Obj.COMET || COMET_SECTORS.has(sector)));
    }
  }
  assert.equal(unsampled.size, 0, 'production samples every eligible board without duplicates and never samples the 18 excluded boards');
  assert.equal(maximumStatements, 7);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 60000, `exhaustive sweep took ${Math.round(elapsed)}ms`);
  context.diagnostic(`${eligible.length} eligible boards certified against ${candidates.length} original boards in ${Math.round(elapsed)}ms; max generation ${maximumGeneration.toFixed(2)}ms; max ${maximumStatements} statements; ${eligible.length * 4} private hands`);
});
