import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { Obj, LABEL, apparentType } from '../public/src/types.js';
import { createPuzzle, validateBoard, initialCluesFor, matchingClues, countSolutions } from '../server/puzzles.js';
import { expertLegalBoardCount } from '../server/expert-puzzles.js';

const SECTOR_COUNT = 18;
const ORDINARY_TYPES = [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET];
const PRIME_SECTORS = [2, 3, 5, 7, 11, 13, 17];
const INVENTORY = {
  [Obj.ASTEROID]: 4,
  [Obj.COMET]: 2,
  [Obj.GAS_CLOUD]: 2,
  [Obj.DWARF_PLANET]: 4,
  [Obj.EMPTY]: 5,
  [Obj.PLANET_X]: 1,
};
const SIX_PEER_BOARD = [
  Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID, Obj.DWARF_PLANET, Obj.DWARF_PLANET,
  Obj.COMET, Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY, Obj.COMET, Obj.EMPTY,
  Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.ASTEROID, Obj.ASTEROID,
];
const UNRESOLVABLE_BOARD = [
  Obj.ASTEROID, Obj.COMET, Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.PLANET_X,
  Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.EMPTY,
  Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID,
];

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sectorsOf(objects, objectType) {
  return objects.flatMap((object, sector) => object === objectType ? [sector] : []);
}

function minimumBandLength(objects, objectType) {
  const positions = sectorsOf(objects, objectType);
  const gaps = positions.map((sector, index) => (
    index + 1 < positions.length ? positions[index + 1] - sector : positions[0] + objects.length - sector
  ));
  return objects.length - Math.max(...gaps) + 1;
}

function independentlyValid(objects, checkBand = true) {
  if (!Array.isArray(objects) || objects.length !== SECTOR_COUNT) return false;
  if (!Object.entries(INVENTORY).every(([objectType, count]) => sectorsOf(objects, objectType).length === count)) return false;
  if (checkBand && minimumBandLength(objects, Obj.DWARF_PLANET) !== 6) return false;
  return objects.every((objectType, sector) => {
    const neighbors = [objects[(sector + 17) % SECTOR_COUNT], objects[(sector + 1) % SECTOR_COUNT]];
    if (objectType === Obj.COMET) return PRIME_SECTORS.includes(sector + 1);
    if (objectType === Obj.ASTEROID) return neighbors.includes(Obj.ASTEROID);
    if (objectType === Obj.GAS_CLOUD) return neighbors.includes(Obj.EMPTY);
    if (objectType === Obj.PLANET_X) return !neighbors.includes(Obj.DWARF_PLANET);
    return true;
  });
}

function completePeers(objects) {
  const observed = objects.map(apparentType);
  return sectorsOf(observed, Obj.EMPTY).map((planetSector) => observed.map((objectType, sector) => (
    sector === planetSector ? Obj.PLANET_X : objectType
  ))).filter((candidate) => independentlyValid(candidate));
}

function observationsFor(objects) {
  return objects.flatMap((object, sector) => ORDINARY_TYPES.filter((objectType) => objectType !== object)
    .map((objectType) => ({ sector, objectType })));
}

function predicateValue(feature, objects) {
  if (feature.kind === 'band') return minimumBandLength(objects, feature.objectType) <= feature.length;
  const neighbors = sectorsOf(objects, feature.neighborType);
  const related = sectorsOf(objects, feature.objectType).map((subject) => neighbors.some((neighbor) => {
    const difference = Math.abs(subject - neighbor);
    const distance = Math.min(difference, objects.length - difference);
    if (feature.relation === 'adjacent') return distance === 1;
    if (feature.relation === 'opposite') return distance * 2 === objects.length;
    return distance > 0 && distance <= feature.range;
  }));
  if (feature.quantifier === 'none') return related.every((value) => !value);
  if (feature.quantifier === 'some') return related.some(Boolean);
  return related.every(Boolean);
}

function readClue(clue) {
  assert.match(clue, /^[^。！？\n]+。$/u);
  assert.doesNotMatch(clue, /空域|从第|位于第|恰有|最短环形距离|每个X行星|任何X行星|某个X行星|至少(?:有)?一个X行星/u);
  const labels = Object.fromEntries(Object.entries(LABEL).map(([objectType, label]) => [label, objectType]));
  const sentence = clue.slice(0, -1);
  const separation = sentence.match(/^没有任何(.+)位于其他(.+)的 (\d+) 个扇区以内$/u);
  if (separation) {
    assert.equal(separation[1], separation[2]);
    const objectType = labels[separation[1]];
    assert.ok(ORDINARY_TYPES.includes(objectType));
    const range = Number(separation[3]);
    assert.ok(range >= 1 && range < SECTOR_COUNT / 2);
    return { kind: 'relation', objectType, neighborType: objectType, relation: 'within', quantifier: 'none', range };
  }
  const band = sentence.match(/^所有(.+)都位于一段不超过 (\d+) 个连续扇区内$/u);
  if (band) {
    const objectType = labels[band[1]];
    assert.ok(ORDINARY_TYPES.includes(objectType));
    const length = Number(band[2]);
    assert.ok(length >= INVENTORY[objectType] && length < SECTOR_COUNT);
    return { kind: 'band', objectType, length };
  }
  for (const [quantifier, pattern, relationKind] of [
    ['none', /^X行星不与任何(.+)(相邻|正对)$/u, 'planet'],
    ['some', /^X行星与至少一个(.+)(相邻|正对)$/u, 'planet'],
    ['none', /^X行星不在任何(.+)的 (\d+) 个扇区以内$/u, 'planetWithin'],
    ['some', /^X行星位于至少一个(.+)的 (\d+) 个扇区以内$/u, 'planetWithin'],
    ['none', /^没有任何(.+)与(.+)(相邻|正对)$/u, 'ordinary'],
    ['some', /^至少有一个(.+)与(?:某个)?(.+)(相邻|正对)$/u, 'ordinary'],
    ['all', /^每个(.+)都与(?:至少一个)?(.+)(相邻|正对)$/u, 'ordinary'],
    ['none', /^没有任何(.+)位于(.+)的 (\d+) 个扇区以内$/u, 'ordinaryWithin'],
    ['some', /^至少有一个(.+)位于(?:某个)?(.+)的 (\d+) 个扇区以内$/u, 'ordinaryWithin'],
    ['all', /^每个(.+)都位于(?:至少一个)?(.+)的 (\d+) 个扇区以内$/u, 'ordinaryWithin'],
  ]) {
    const fields = sentence.match(pattern);
    if (!fields) continue;
    const planetSubject = relationKind.startsWith('planet');
    const objectType = planetSubject ? Obj.PLANET_X : labels[fields[1]];
    const neighborType = labels[fields[planetSubject ? 1 : 2]];
    const relationText = fields[planetSubject ? 2 : 3];
    const relation = relationKind.endsWith('Within') ? 'within' : relationText === '相邻' ? 'adjacent' : 'opposite';
    assert.ok([...ORDINARY_TYPES, Obj.PLANET_X].includes(objectType));
    assert.ok([...ORDINARY_TYPES, Obj.PLANET_X].includes(neighborType));
    assert.notEqual(objectType, neighborType);
    const feature = { kind: 'relation', objectType, neighborType, relation, quantifier };
    if (relation === 'within') {
      feature.range = Number(relationText);
      assert.ok(feature.range >= 2 && feature.range <= 8);
    }
    return feature;
  }
  assert.fail(`Unsupported clue: ${clue}`);
}

function allConferencePredicates() {
  return ORDINARY_TYPES.flatMap((ordinaryType) => [[Obj.PLANET_X, ordinaryType], [ordinaryType, Obj.PLANET_X]]
    .flatMap(([objectType, neighborType]) => [
      { relation: 'adjacent' }, { relation: 'opposite' },
      ...Array.from({ length: 7 }, (unused, index) => ({ relation: 'within', range: index + 2 })),
    ].flatMap((relation) => ['none', 'some', 'all'].map((quantifier) => ({
      kind: 'relation', objectType, neighborType, quantifier, ...relation,
    })))));
}

function independentSearch(initialClues) {
  const remaining = { ...INVENTORY };
  const objects = [];
  const results = [];
  let visits = 0;
  function visit(sector) {
    visits += 1;
    assert.ok(visits <= 2000000, 'independent restricted oracle stays bounded');
    if (sector === SECTOR_COUNT) {
      if (independentlyValid(objects)) results.push(objects.slice());
      return;
    }
    for (const objectType of Object.keys(remaining)) {
      if (!remaining[objectType]) continue;
      if (initialClues.some((clue) => clue.sector === sector && clue.objectType === objectType)) continue;
      if (objectType === Obj.COMET && !PRIME_SECTORS.includes(sector + 1)) continue;
      const previous = objects[sector - 1];
      const beforePrevious = objects[sector - 2];
      if (previous === Obj.DWARF_PLANET && objectType === Obj.PLANET_X) continue;
      if (previous === Obj.PLANET_X && objectType === Obj.DWARF_PLANET) continue;
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
  return results;
}

function positionCombinations(sectors, count) {
  const groups = [];
  function visit(start, selected) {
    if (selected.length === count) {
      groups.push(selected.slice());
      return;
    }
    for (let index = start; index <= sectors.length - count + selected.length; index += 1) {
      selected.push(sectors[index]);
      visit(index + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return groups;
}

function independentExpertUniverseCount() {
  const sectors = Array.from({ length: SECTOR_COUNT }, (unused, sector) => sector);
  const fourPositions = positionCombinations(sectors, 4);
  const dwarfGroups = fourPositions.filter((positions) => {
    const board = sectors.map((sector) => positions.includes(sector) ? Obj.DWARF_PLANET : Obj.EMPTY);
    return minimumBandLength(board, Obj.DWARF_PLANET) === 6;
  });
  const asteroidGroups = fourPositions.filter((positions) => positions.every((sector) => (
    positions.includes((sector + 1) % SECTOR_COUNT) || positions.includes((sector + 17) % SECTOR_COUNT)
  )));
  const cometGroups = positionCombinations(PRIME_SECTORS.map((sector) => sector - 1), 2);
  const board = Array(SECTOR_COUNT).fill(Obj.EMPTY);
  let count = 0;
  for (const dwarfs of dwarfGroups) {
    for (const sector of dwarfs) board[sector] = Obj.DWARF_PLANET;
    for (const comets of cometGroups) {
      if (comets.some((sector) => board[sector] !== Obj.EMPTY)) continue;
      for (const sector of comets) board[sector] = Obj.COMET;
      for (const asteroids of asteroidGroups) {
        if (asteroids.some((sector) => board[sector] !== Obj.EMPTY)) continue;
        for (const sector of asteroids) board[sector] = Obj.ASTEROID;
        const available = sectorsOf(board, Obj.EMPTY);
        for (const gases of positionCombinations(available, 2)) {
          for (const sector of gases) board[sector] = Obj.GAS_CLOUD;
          for (const planet of available) {
            if (board[planet] !== Obj.EMPTY) continue;
            if ([board[(planet + 1) % SECTOR_COUNT], board[(planet + 17) % SECTOR_COUNT]].includes(Obj.DWARF_PLANET)) continue;
            board[planet] = Obj.PLANET_X;
            if (gases.every((sector) => [board[(sector + 1) % SECTOR_COUNT], board[(sector + 17) % SECTOR_COUNT]].includes(Obj.EMPTY))) count += 1;
            board[planet] = Obj.EMPTY;
          }
          for (const sector of gases) board[sector] = Obj.EMPTY;
        }
        for (const sector of asteroids) board[sector] = Obj.EMPTY;
      }
      for (const sector of comets) board[sector] = Obj.EMPTY;
    }
    for (const sector of dwarfs) board[sector] = Obj.EMPTY;
  }
  return count;
}

test('expert validation infers eighteen sectors and requires an exact six-sector dwarf band with endpoints', () => {
  assert.ok(independentlyValid(SIX_PEER_BOARD));
  assert.equal(validateBoard(SIX_PEER_BOARD), true);
  const wrapped = SIX_PEER_BOARD.map((unused, sector) => SIX_PEER_BOARD[(sector + 4) % SECTOR_COUNT]);
  assert.ok(independentlyValid(wrapped));
  assert.equal(validateBoard(wrapped), true);
  const narrow = [
    Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.COMET, Obj.EMPTY,
    Obj.COMET, Obj.PLANET_X, Obj.ASTEROID, Obj.ASTEROID, Obj.EMPTY, Obj.GAS_CLOUD,
    Obj.EMPTY, Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID, Obj.ASTEROID,
  ];
  const missingEndpoint = [
    Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.DWARF_PLANET, Obj.EMPTY,
    Obj.COMET, Obj.ASTEROID, Obj.ASTEROID, Obj.PLANET_X, Obj.COMET, Obj.EMPTY,
    Obj.GAS_CLOUD, Obj.EMPTY, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID, Obj.ASTEROID,
  ];
  const wide = SIX_PEER_BOARD.slice();
  [wide[5], wide[7]] = [wide[7], wide[5]];
  for (const [objects, length] of [[narrow, 4], [missingEndpoint, 5], [wide, 8]]) {
    assert.ok(independentlyValid(objects, false));
    assert.equal(minimumBandLength(objects, Obj.DWARF_PLANET), length);
    assert.equal(validateBoard(objects), false);
  }
  for (const objects of [null, [], SIX_PEER_BOARD.slice(1), [...SIX_PEER_BOARD, Obj.EMPTY], Array(18).fill(Obj.EMPTY)]) {
    assert.equal(validateBoard(objects), false);
  }
});

test('expert sampler counts every legal board once', () => {
  assert.equal(expertLegalBoardCount(), 1138272);
});

test('cold expert generation exposes only the public subjects and hidden clue strings within a bounded budget', (context) => {
  const started = performance.now();
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(42) });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `cold expert generation took ${elapsed.toFixed(2)}ms`);
  assert.deepEqual(Object.keys(puzzle).sort(), ['conferenceNames', 'conferences', 'modeId', 'objects', 'topics']);
  assert.equal(puzzle.modeId, 'expert');
  assert.deepEqual(Object.keys(puzzle.topics), ['A', 'B', 'C', 'D', 'E', 'F']);
  assert.deepEqual(Object.keys(puzzle.conferences), ['7', '16']);
  assert.deepEqual(Object.keys(puzzle.conferenceNames), ['7', '16']);
  for (const title of Object.values(puzzle.conferenceNames)) assert.match(title, /^X行星和(小行星|彗星|气体云|矮行星)$/u);
  assert.deepEqual(JSON.parse(JSON.stringify(puzzle)), puzzle);
  context.diagnostic(`cold expert generation ${elapsed.toFixed(2)}ms`);
});

test('expert generation certifies every complete-observation peer with two independently interpreted predicates', (context) => {
  const sampleCount = 4096;
  const boards = new Set();
  const cometSectors = new Set();
  const peerCounts = new Set();
  const researchKinds = new Set();
  let needsBoth = 0;
  let maximumGeneration = 0;
  const started = performance.now();
  for (let seed = 0; seed < sampleCount; seed += 1) {
    const generationStarted = performance.now();
    const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(seed * 104729 + 17) });
    maximumGeneration = Math.max(maximumGeneration, performance.now() - generationStarted);
    assert.ok(independentlyValid(puzzle.objects), `independent inventory and base rules at seed ${seed}`);
    assert.equal(validateBoard(puzzle.objects), true);
    boards.add(puzzle.objects.join(','));
    for (const sector of sectorsOf(puzzle.objects, Obj.COMET)) cometSectors.add(sector + 1);
    const peers = completePeers(puzzle.objects);
    peerCounts.add(peers.length);
    assert.ok(peers.length >= 1 && peers.length <= 6);
    const conferences = Object.values(puzzle.conferences).map(readClue);
    assert.equal(new Set(Object.values(puzzle.conferences)).size, 2);
    for (const [index, feature] of conferences.entries()) {
      assert.equal(feature.kind, 'relation');
      assert.ok([feature.objectType, feature.neighborType].includes(Obj.PLANET_X));
      assert.equal(predicateValue(feature, puzzle.objects), true);
      const ordinary = feature.objectType === Obj.PLANET_X ? feature.neighborType : feature.objectType;
      assert.equal(Object.values(puzzle.conferenceNames)[index], `X行星和${LABEL[ordinary]}`);
    }
    assert.deepEqual(peers.filter((candidate) => conferences.every((feature) => predicateValue(feature, candidate))), [puzzle.objects]);
    if (conferences.every((feature) => peers.filter((candidate) => predicateValue(feature, candidate)).length > 1)) needsBoth += 1;
    assert.equal(new Set(Object.values(puzzle.topics).map((topic) => topic.name)).size, 6);
    for (const topic of Object.values(puzzle.topics)) {
      const feature = readClue(topic.clue);
      researchKinds.add(feature.kind === 'band' ? 'band' : feature.relation);
      assert.ok(ORDINARY_TYPES.includes(feature.objectType));
      if (feature.kind === 'band') {
        const span = minimumBandLength(puzzle.objects, feature.objectType);
        assert.notEqual(feature.objectType, Obj.DWARF_PLANET, 'the expert base rules already fix the dwarf band');
        assert.ok(span <= 8, `${topic.clue} describes a spread wider than eight sectors`);
        assert.ok(feature.length >= 6 && feature.length <= 8, topic.clue);
        assert.equal(feature.length, Math.max(span, 6), topic.clue);
      }
      if (feature.kind === 'relation') assert.ok(ORDINARY_TYPES.includes(feature.neighborType));
      assert.equal(predicateValue(feature, puzzle.objects), true);
      assert.equal(topic.name, ORDINARY_TYPES.filter((objectType) => [feature.objectType, feature.neighborType].includes(objectType))
        .map((objectType) => LABEL[objectType]).join('和'));
    }
    const initialClues = observationsFor(puzzle.objects);
    assert.equal(countSolutions(puzzle, { topicIds: [], initialClues }), 1);
    assert.equal(countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues }), peers.length);
    for (const candidate of peers) {
      assert.equal(matchingClues(candidate, puzzle, { topicIds: [] }), conferences.every((feature) => predicateValue(feature, candidate)));
      assert.equal(matchingClues(candidate, puzzle, { topicIds: [], includeConference: false }), true);
    }
    if (seed < 32) {
      for (let first = 0; first < SECTOR_COUNT; first += 1) {
        for (let second = first + 1; second < SECTOR_COUNT; second += 1) {
          const swapped = puzzle.objects.slice();
          [swapped[first], swapped[second]] = [swapped[second], swapped[first]];
          assert.equal(validateBoard(swapped), independentlyValid(swapped));
        }
      }
    }
  }
  const elapsed = performance.now() - started;
  assert.ok(boards.size >= 3900, `${boards.size} distinct expert boards`);
  assert.deepEqual([...cometSectors].sort((first, second) => first - second), PRIME_SECTORS);
  assert.ok(peerCounts.has(6), 'certification covers all six possible X/empty placements');
  assert.ok(needsBoth > 0, 'two conferences can be necessary rather than repeating a single complete answer');
  for (const kind of ['band', 'adjacent', 'opposite', 'within']) assert.ok(researchKinds.has(kind));
  assert.ok(elapsed < 10000, `${sampleCount} expert generations and independent checks took ${elapsed.toFixed(2)}ms`);
  context.diagnostic(`${sampleCount} experts: ${boards.size} boards, ${elapsed.toFixed(2)}ms including oracles; max generation ${maximumGeneration.toFixed(2)}ms; peer sizes ${[...peerCounts].sort().join(',')}; ${needsBoth} need both conferences`);
});

test('unresolvable expert boards remain legal solver candidates, including peers never generated', () => {
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(19) });
  const peers = completePeers(UNRESOLVABLE_BOARD);
  assert.equal(peers.length, 2);
  for (const feature of allConferencePredicates()) assert.equal(predicateValue(feature, peers[0]), predicateValue(feature, peers[1]));
  assert.equal(completePeers(SIX_PEER_BOARD).length, 6);
  for (const objects of [UNRESOLVABLE_BOARD, SIX_PEER_BOARD]) {
    const options = { topicIds: [], includeConference: false, initialClues: observationsFor(objects) };
    assert.equal(validateBoard(objects), true);
    const alternatives = completePeers(objects);
    assert.equal(countSolutions(puzzle, options), alternatives.length);
    assert.equal(countSolutions(puzzle, { ...options, limit: 2 }), 2);
    for (const candidate of alternatives) assert.equal(matchingClues(candidate, puzzle, options), true);
  }
});

test('expert solution counting matches independent restricted array enumeration rather than a sample', () => {
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(1729) });
  for (const objects of [SIX_PEER_BOARD, UNRESOLVABLE_BOARD, puzzle.objects]) {
    const initialClues = observationsFor(objects).filter((clue) => ![1, 2, 6, 8].includes(clue.sector));
    const candidates = independentSearch(initialClues);
    assert.ok(candidates.length > 1);
    for (const selection of [{ topicIds: [], includeConference: false }, { topicIds: [] }, { topicIds: ['A', 'B'], includeConference: false }, {}]) {
      const statements = [
        ...(selection.topicIds ?? ['A', 'B', 'C', 'D', 'E', 'F']).map((topicId) => readClue(puzzle.topics[topicId].clue)),
        ...(selection.includeConference === false ? [] : Object.values(puzzle.conferences).map(readClue)),
      ];
      const solutions = candidates.filter((candidate) => statements.every((feature) => predicateValue(feature, candidate)));
      const options = { ...selection, initialClues };
      assert.equal(countSolutions(puzzle, options), solutions.length);
      assert.equal(countSolutions(puzzle, { ...options, limit: 2 }), Math.min(2, solutions.length));
      assert.deepEqual(candidates.filter((candidate) => matchingClues(candidate, puzzle, options)), solutions);
    }
  }
  assert.equal(countSolutions(puzzle, { topicIds: [], includeConference: false, limit: 2 }), 2);
});

test('expert counting covers the full independent array-enumerated universe without a generated-board catalogue', (context) => {
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(7) });
  const started = performance.now();
  const expected = independentExpertUniverseCount();
  context.diagnostic(`${expected} independent legal expert boards enumerated in ${(performance.now() - started).toFixed(2)}ms`);
  assert.equal(countSolutions(puzzle, { topicIds: [], includeConference: false }), expected);
  assert.equal(countSolutions(puzzle, { topicIds: [], includeConference: false, limit: 100 }), Math.min(100, expected));
});

test('expert initial exclusions support zero, twelve and all 49 true nontrivial exclusions', () => {
  for (let seed = 0; seed < 32; seed += 1) {
    const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(seed + 1234) });
    const snapshot = JSON.stringify(puzzle);
    assert.deepEqual(initialCluesFor(puzzle, { count: 0, random: () => assert.fail('zero clues need no random draw') }), []);
    assert.equal(initialCluesFor(puzzle).length, 4);
    const allClues = initialCluesFor(puzzle, { count: 49, random: seededRandom(9001) });
    assert.equal(new Set(allClues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, 49);
    for (const clue of allClues) {
      assert.ok(ORDINARY_TYPES.includes(clue.objectType));
      assert.notEqual(clue.objectType, apparentType(puzzle.objects[clue.sector]));
      assert.ok(clue.objectType !== Obj.COMET || PRIME_SECTORS.includes(clue.sector + 1));
    }
    for (const count of [0, 4, 8, 12]) {
      const clues = initialCluesFor(puzzle, { count, random: seededRandom(9001 + count) });
      assert.equal(clues.length, count);
      assert.equal(new Set(clues.map(({ sector, objectType }) => `${sector}:${objectType}`)).size, count);
      assert.equal(matchingClues(puzzle.objects, puzzle, { initialClues: clues }), true);
      const cometExclusions = clues.filter(({ objectType }) => objectType === Obj.COMET).length;
      assert.ok(cometExclusions <= 2, `expert hand seed=${seed} count=${count} had ${cometExclusions} comet exclusions`);
      if (count > 0) {
        const candidates = countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues: clues });
        assert.ok(candidates >= 10000, `expert hand seed=${seed} count=${count} left only ${candidates} candidates`);
      }
    }
    assert.equal(countSolutions(puzzle, { initialClues: allClues }), 1);
    assert.equal(JSON.stringify(puzzle), snapshot);
    assert.throws(() => initialCluesFor(puzzle, { count: 50 }), /count/u);
  }
});

test('expert generation validates randomness and terminates for constant streams and bounded attempts', () => {
  for (const random of [null, false, 0, 'random']) assert.throws(() => createPuzzle({ modeId: 'expert', random }), /random/u);
  for (const draw of [-0.1, 1, NaN, Infinity, undefined, '0.5']) {
    assert.throws(() => createPuzzle({ modeId: 'expert', random: () => draw }), /random/u);
  }
  let draws = 0;
  assert.throws(() => createPuzzle({ modeId: 'expert', random: () => ++draws === 3 ? NaN : 0.5 }), /random/u);
  for (const draw of [0, 0.5, 1 - Number.EPSILON]) {
    let calls = 0;
    const puzzle = createPuzzle({ modeId: 'expert', random: () => { calls += 1; return draw; } });
    assert.ok(independentlyValid(puzzle.objects));
    assert.ok(calls < 10000, `${calls} RNG calls terminate constant ${draw}`);
  }
  for (const maxAttempts of [0, -1, 1.5, NaN, Infinity, '1', 257]) {
    assert.throws(() => createPuzzle({ modeId: 'expert', maxAttempts }), /maxAttempts/u);
  }
  let exhausted = false;
  for (let seed = 0; seed < 2048 && !exhausted; seed += 1) {
    try {
      createPuzzle({ modeId: 'expert', maxAttempts: 1, random: seededRandom(seed) });
    } catch (error) {
      assert.match(error.message, /attempt/u);
      exhausted = true;
    }
  }
  assert.equal(exhausted, true, 'a one-attempt budget can fail explicitly without falling back to an uncertified board');
  assert.deepEqual(createPuzzle({ modeId: 'expert', random: seededRandom(123456789) }), createPuzzle({ modeId: 'expert', random: seededRandom(123456789) }));
});

test('expert debug counting rejects exhausted budgets instead of reporting a partial count', () => {
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(81) });
  assert.throws(() => countSolutions(puzzle, { topicIds: [], includeConference: false, maxNodes: 1 }), /maxNodes/u);
  for (const maxNodes of [0, -1, 1.5, NaN, Infinity, '100']) {
    assert.throws(() => countSolutions(puzzle, { maxNodes }), /maxNodes/u);
  }
  for (const limit of [0, -1, 0.5, NaN, '2']) assert.throws(() => countSolutions(puzzle, { limit }), /limit/u);
  for (const initialClues of [null, [null], [{ sector: 18, objectType: Obj.COMET }], [{ sector: 17, objectType: Obj.EMPTY }]]) {
    assert.throws(() => countSolutions(puzzle, { initialClues }), /initialClues/u);
    assert.throws(() => matchingClues(puzzle.objects, puzzle, { initialClues }), /initialClues/u);
  }
  const initialClues = observationsFor(SIX_PEER_BOARD);
  assert.equal(countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues, maxNodes: 100 }), 6);
});

test('expert solver state is independent of mutable puzzle fields and rejects boards of the other mode', () => {
  const puzzle = createPuzzle({ modeId: 'expert', random: seededRandom(999) });
  const expected = createPuzzle({ modeId: 'expert', random: seededRandom(999) });
  const answer = puzzle.objects;
  const initialClues = observationsFor(answer);
  puzzle.objects = Array(12).fill(Obj.EMPTY);
  puzzle.modeId = 'standard';
  puzzle.topics.A.name = 'changed';
  puzzle.topics.A.clue = 'changed';
  puzzle.conferences[7] = 'changed';
  puzzle.conferenceNames[16] = 'changed';
  assert.equal(matchingClues(answer, puzzle), true);
  assert.equal(countSolutions(puzzle, { initialClues }), 1);
  assert.equal(matchingClues(puzzle.objects, puzzle), false);
  assert.deepEqual(createPuzzle({ modeId: 'expert', random: seededRandom(999) }), expected);
  assert.throws(() => countSolutions({ ...expected }), /createPuzzle/u);
});
