import test from 'node:test';
import assert from 'node:assert/strict';

import { Obj } from '../public/src/types.js';
import * as research from '../server/research.js';

const {
  buildResearchFeatures,
  researchFeatureValue,
  researchTopicName,
  researchClueText,
} = research;

const ORDINARY_TYPES = [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET];
const OBJECT_COUNTS = Object.freeze({
  [Obj.ASTEROID]: 4,
  [Obj.COMET]: 2,
  [Obj.GAS_CLOUD]: 2,
  [Obj.DWARF_PLANET]: 1,
  [Obj.EMPTY]: 2,
  [Obj.PLANET_X]: 1,
});
const TOPICS = [
  [Obj.ASTEROID, Obj.COMET, 'asteroid|comet', '小行星和彗星'],
  [Obj.ASTEROID, Obj.GAS_CLOUD, 'asteroid|gasCloud', '小行星和气体云'],
  [Obj.ASTEROID, Obj.DWARF_PLANET, 'asteroid|dwarfPlanet', '小行星和矮行星'],
  [Obj.COMET, Obj.GAS_CLOUD, 'comet|gasCloud', '彗星和气体云'],
  [Obj.COMET, Obj.DWARF_PLANET, 'comet|dwarfPlanet', '彗星和矮行星'],
  [Obj.GAS_CLOUD, Obj.DWARF_PLANET, 'gasCloud|dwarfPlanet', '气体云和矮行星'],
];

function boardWith(sectorCount, placements) {
  const board = Array(sectorCount).fill(Obj.EMPTY);
  for (const [objectType, sectors] of Object.entries(placements)) {
    for (const sector of sectors) {
      assert.ok(Number.isInteger(sector) && sector >= 1 && sector <= sectorCount);
      assert.equal(board[sector - 1], Obj.EMPTY, `Overlapping fixture at sector ${sector}`);
      board[sector - 1] = objectType;
    }
  }
  return board;
}

function boardMasks(board) {
  const masks = Object.fromEntries(Object.values(Obj).map((objectType) => [objectType, 0]));
  board.forEach((objectType, sector) => { masks[objectType] |= 1 << sector; });
  return masks;
}

function boardSectors(board, objectType) {
  return board.flatMap((type, sector) => type === objectType ? [sector] : []);
}

function shortestDistance(firstSector, secondSector, sectorCount) {
  const distance = Math.abs(firstSector - secondSector);
  return Math.min(distance, sectorCount - distance);
}

function oracleValue(feature, board) {
  const subjects = boardSectors(board, feature.objectType);
  if (feature.kind === 'band') {
    if (subjects.length === 0) return 1;
    const nextSectors = [...subjects.slice(1), subjects[0] + board.length];
    const largestGap = Math.max(...subjects.map((sector, index) => nextSectors[index] - sector));
    return Number(board.length - largestGap + 1 <= feature.length);
  }
    const neighbors = boardSectors(board, feature.neighborType);
    const matches = subjects.map((subject) => neighbors.some((neighbor) => {
      if (neighbor === subject) return false;
      const distance = shortestDistance(subject, neighbor, board.length);
    if (feature.relation === 'adjacent') return distance === 1;
    if (feature.relation === 'opposite') return distance * 2 === board.length;
    return distance <= feature.range;
  }));
  if (feature.quantifier === 'none') return Number(matches.every((matched) => !matched));
  if (feature.quantifier === 'some') return Number(matches.some(Boolean));
  return Number(matches.every(Boolean));
}

function bandFeature(objectType, length) {
  return { kind: 'band', objectType, topicKey: objectType, length };
}

function relationFeature(relation, quantifier, range) {
  return {
    kind: 'relation',
    objectType: Obj.ASTEROID,
    neighborType: Obj.COMET,
    topicKey: 'asteroid|comet',
    relation,
    quantifier,
    ...(relation === 'within' ? { range } : {}),
  };
}

function assertPredicate(feature, board, expected) {
  assert.equal(oracleValue(feature, board), expected, 'The independent oracle must agree with the fixture');
  assert.equal(researchFeatureValue(feature, boardMasks(board), board.length), expected, JSON.stringify(feature));
}

function assertBoardFeatures(features, board) {
  assert.ok(features.length > 0);
  const masks = boardMasks(board);
  for (const feature of features) {
    assert.equal(
      researchFeatureValue(feature, masks, board.length),
      oracleValue(feature, board),
      `${JSON.stringify(feature)} on ${board.join(',')}`,
    );
  }
}

function shuffledBoard(board, seed) {
  const shuffled = [...board];
  let state = seed;
  for (let last = shuffled.length - 1; last > 0; last -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const destination = state % (last + 1);
    [shuffled[last], shuffled[destination]] = [shuffled[destination], shuffled[last]];
  }
  return shuffled;
}

function inventoryFor(sectorCount) {
  return sectorCount === 12
    ? OBJECT_COUNTS
    : { ...OBJECT_COUNTS, [Obj.DWARF_PLANET]: 4, [Obj.EMPTY]: 5 };
}

function inventoryBoard(objectCounts) {
  return Object.entries(objectCounts).flatMap(([objectType, count]) => Array(count).fill(objectType));
}

test('research generates bands, same-type separation, and distinct-type relations', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  assert.equal(features.length, 259);
  assert.equal(features.filter((feature) => feature.kind === 'band').length, 28);
  assert.equal(features.filter((feature) => feature.kind === 'relation' && feature.objectType !== feature.neighborType).length, 216);
  const separations = features.filter((feature) => feature.objectType === feature.neighborType);
  assert.equal(separations.length, 15);
  assert.equal(separations.every((feature) => feature.objectType !== Obj.DWARF_PLANET), true);
  const expertSeparations = buildResearchFeatures(18, { ...OBJECT_COUNTS, [Obj.DWARF_PLANET]: 4, [Obj.EMPTY]: 5 })
    .filter((feature) => feature.objectType === feature.neighborType);
  assert.equal(expertSeparations.length, 24);
  assert.equal(expertSeparations.some((feature) => feature.objectType === Obj.DWARF_PLANET), false);
  assert.equal(new Set(expertSeparations.map((feature) => feature.objectType)).size, 3);
  for (const feature of features) {
    assert.ok(['band', 'relation'].includes(feature.kind));
    assert.ok(ORDINARY_TYPES.includes(feature.objectType));
    assert.equal(Object.hasOwn(feature, 'start'), false);
    assert.equal(Object.hasOwn(feature, 'count'), false);
    if (feature.kind === 'relation' && feature.objectType !== feature.neighborType) {
      assert.ok(ORDINARY_TYPES.includes(feature.neighborType));
    }
  }
  for (const feature of separations) {
    assert.equal(feature.relation, 'within');
    assert.equal(feature.quantifier, 'none');
    assert.equal(feature.topicKey, feature.objectType);
    assert.ok(feature.range >= 1 && feature.range < 6);
    assert.equal(researchTopicName(feature), { asteroid: '小行星', comet: '彗星', gasCloud: '气体云' }[feature.objectType]);
    assert.equal(researchClueText(feature), `没有任何${researchTopicName(feature)}位于其他${researchTopicName(feature)}的 ${feature.range} 个扇区以内。`);
  }
  const separated = boardWith(12, { [Obj.COMET]: [1, 6] });
  assertPredicate({ ...separations.find((feature) => feature.objectType === Obj.COMET && feature.range === 4) }, separated, 1);
  assertPredicate({ ...separations.find((feature) => feature.objectType === Obj.COMET && feature.range === 5) }, separated, 0);
});

test('conferences enumerate all 144 allowed X-to-ordinary relations in both directions', () => {
  assert.equal(typeof research.buildConferenceFeatures, 'function');
  const features = research.buildConferenceFeatures(12);
  assert.equal(features.length, 144);
  assert.equal(new Set(features.map((feature) => JSON.stringify(feature))).size, 144);
  const expectedDescriptors = ['adjacent', 'opposite', 'within:2', 'within:3', 'within:4', 'within:5']
    .flatMap((relation) => ['none', 'some', 'all'].map((quantifier) => `${relation}/${quantifier}`));
  for (const ordinaryType of ORDINARY_TYPES) {
    for (const [objectType, neighborType] of [[Obj.PLANET_X, ordinaryType], [ordinaryType, Obj.PLANET_X]]) {
      const matching = features.filter((feature) => feature.objectType === objectType && feature.neighborType === neighborType);
      assert.equal(matching.length, 18);
      assert.deepEqual(new Set(matching.map((feature) => (
        `${feature.relation}${feature.relation === 'within' ? `:${feature.range}` : ''}/${feature.quantifier}`
      ))), new Set(expectedDescriptors));
    }
  }
  for (const feature of features) {
    assert.equal(feature.kind, 'relation');
    assert.ok([feature.objectType, feature.neighborType].includes(Obj.PLANET_X));
    assert.equal([feature.objectType, feature.neighborType].filter((objectType) => ORDINARY_TYPES.includes(objectType)).length, 1);
    for (const field of ['start', 'length', 'count', 'mask', 'first', 'second']) assert.equal(Object.hasOwn(feature, field), false);
  }
});

test('conference feature construction is deterministic and does not contaminate ordinary research', () => {
  assert.equal(typeof research.buildConferenceFeatures, 'function');
  const ordinary = buildResearchFeatures(12, OBJECT_COUNTS);
  const features = research.buildConferenceFeatures(12);
  const expected = structuredClone(features);
  for (const feature of features) feature.values = new Uint8Array([0, 1]);
  assert.deepEqual(research.buildConferenceFeatures(12), expected);
  assert.deepEqual(buildResearchFeatures(12, OBJECT_COUNTS), ordinary);
});

test('conference titles expose only X and the ordinary subject in both modes and directions', () => {
  assert.equal(typeof research.conferenceTopicName, 'function');
  for (const sectorCount of [12, 18]) {
    for (const feature of research.buildConferenceFeatures(sectorCount)) {
      const title = research.conferenceTopicName(feature);
      assert.equal(title, `X行星和${researchTopicName(feature)}`);
      assert.match(title, /^X行星和(小行星|彗星|气体云|矮行星)$/u);
      assert.doesNotMatch(title, /相邻|正对|以内|至少|没有|每个|\d/u);
    }
  }
});

test('all 216 expert conference predicates match an independent eighteen-sector array oracle', () => {
  const features = research.buildConferenceFeatures(18);
  assert.equal(features.length, 216);
  assert.equal(new Set(features.map((feature) => JSON.stringify(feature))).size, 216);
  const inventory = inventoryBoard(inventoryFor(18));
  for (let seed = 1; seed <= 128; seed += 1) {
    assertBoardFeatures(features, shuffledBoard(inventory, seed * 104729));
  }
});

test('all conference predicates agree with the independent array oracle on varied inventories', () => {
  assert.equal(typeof research.buildConferenceFeatures, 'function');
  const features = research.buildConferenceFeatures(12);
  const board = inventoryBoard(OBJECT_COUNTS);
  for (let seed = 1; seed <= 48; seed += 1) {
    assertBoardFeatures(features, shuffledBoard(board, seed));
  }
});

test('all remains directional when the conference subject or neighbor is the singleton X', () => {
  for (const [relation, ordinarySectors] of [['adjacent', [12, 5]], ['opposite', [7, 8]], ['within', [12, 6]]]) {
    const board = boardWith(12, { [Obj.PLANET_X]: [1], [Obj.ASTEROID]: ordinarySectors });
    const forward = { ...relationFeature(relation, 'all', 2), objectType: Obj.PLANET_X, neighborType: Obj.ASTEROID };
    const reverse = { ...forward, objectType: Obj.ASTEROID, neighborType: Obj.PLANET_X };
    assertPredicate(forward, board, 1);
    assertPredicate(reverse, board, 0);
    for (const feature of [forward, reverse]) {
      assertPredicate({ ...feature, quantifier: 'some' }, board, 1);
      assertPredicate({ ...feature, quantifier: 'none' }, board, 0);
    }
  }
});

test('band limits run inclusively from inventory size to board size minus one', () => {
  for (const sectorCount of [12, 18]) {
    const objectCounts = sectorCount === 12
      ? OBJECT_COUNTS
      : { ...OBJECT_COUNTS, [Obj.DWARF_PLANET]: 4, [Obj.EMPTY]: 5 };
    const features = buildResearchFeatures(sectorCount, objectCounts);
    for (const objectType of ORDINARY_TYPES) {
      const count = objectCounts[objectType];
      const expectedLengths = count > 1
        ? Array.from({ length: sectorCount - count }, (unused, index) => count + index)
        : [];
      const bands = features.filter((feature) => feature.kind === 'band' && feature.objectType === objectType);
      assert.deepEqual(bands.map((feature) => feature.length), expectedLengths);
      for (const feature of bands) assert.equal(feature.topicKey, objectType);
    }
  }
});

test('singleton inventories never produce bands, including for X and empty', () => {
  const objectCounts = Object.fromEntries(ORDINARY_TYPES.map((objectType) => [objectType, 1]));
  objectCounts[Obj.PLANET_X] = 2;
  objectCounts[Obj.EMPTY] = 6;
  const features = buildResearchFeatures(12, objectCounts);
  assert.equal(features.length, 216);
  assert.equal(features.some((feature) => feature.kind === 'band'), false);
  for (const feature of features) {
    assert.ok(ORDINARY_TYPES.includes(feature.objectType));
    assert.ok(ORDINARY_TYPES.includes(feature.neighborType));
  }
});

test('each ordered pair has every relation and quantifier under one canonical topic', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  const expectedRelations = ['adjacent', 'opposite', 'within:2', 'within:3', 'within:4', 'within:5'];
  const expectedDescriptors = expectedRelations.flatMap((relation) => (
    ['none', 'some', 'all'].map((quantifier) => `${relation}/${quantifier}`)
  ));
  for (const [firstType, secondType, topicKey] of TOPICS) {
    for (const [objectType, neighborType] of [[firstType, secondType], [secondType, firstType]]) {
      const relations = features.filter((feature) => (
        feature.kind === 'relation' && feature.objectType === objectType && feature.neighborType === neighborType
      ));
      assert.equal(relations.length, 18);
      assert.deepEqual(new Set(relations.map((feature) => feature.topicKey)), new Set([topicKey]));
      const descriptors = relations.map((feature) => (
        `${feature.relation}${feature.relation === 'within' ? `:${feature.range}` : ''}/${feature.quantifier}`
      ));
      assert.deepEqual(new Set(descriptors), new Set(expectedDescriptors));
    }
  }
});

test('within limits are exactly two through half a circle minus one for each board size', () => {
  const objectCounts = Object.fromEntries(ORDINARY_TYPES.map((objectType) => [objectType, 1]));
  for (const sectorCount of [4, 6, 12, 18]) {
    const features = buildResearchFeatures(sectorCount, objectCounts);
    assert.equal(features.length, 36 * (sectorCount / 2));
    const within = features.filter((feature) => feature.relation === 'within');
    const expectedRanges = Array.from({ length: sectorCount / 2 - 2 }, (unused, index) => index + 2);
    assert.deepEqual(new Set(within.map((feature) => feature.range)), new Set(expectedRanges));
    for (const range of expectedRanges) {
      assert.equal(within.filter((feature) => feature.range === range).length, 36);
    }
  }
});

test('feature sets are deterministic, unique and independently extensible with engine caches', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  assert.equal(features.length, 259);
  const baseline = structuredClone(features);
  assert.equal(new Set(features.map((feature) => JSON.stringify(feature))).size, features.length);
  for (const feature of features) {
    feature.values = new Uint8Array([0, 1]);
    feature.score = 7;
    assert.deepEqual(feature.values, new Uint8Array([0, 1]));
    assert.equal(feature.score, 7);
  }
  const reorderedCounts = Object.freeze(Object.fromEntries(Object.entries(OBJECT_COUNTS).reverse()));
  assert.deepEqual(buildResearchFeatures(12, reorderedCounts), baseline);
  assert.deepEqual(OBJECT_COUNTS, reorderedCounts);
});

test('bands accept every unknown start, including a four-sector arc across 12/1', () => {
  for (let start = 0; start < 12; start += 1) {
    const sectors = Array.from({ length: 4 }, (unused, offset) => (start + offset) % 12 + 1);
    const board = boardWith(12, { [Obj.ASTEROID]: sectors });
    assertPredicate(bandFeature(Obj.ASTEROID, 3), board, 0);
    assertPredicate(bandFeature(Obj.ASTEROID, 4), board, 1);
    assertPredicate(bandFeature(Obj.ASTEROID, 5), board, 1);
  }
});

test('band length includes both endpoints and intervening unoccupied sectors', () => {
  const crossing = boardWith(12, { [Obj.COMET]: [12, 2] });
  assertPredicate(bandFeature(Obj.COMET, 2), crossing, 0);
  assertPredicate(bandFeature(Obj.COMET, 3), crossing, 1);
  for (const sectorCount of [12, 18]) {
    const opposite = boardWith(sectorCount, { [Obj.COMET]: [1, sectorCount / 2 + 1] });
    assertPredicate(bandFeature(Obj.COMET, sectorCount / 2), opposite, 0);
    assertPredicate(bandFeature(Obj.COMET, sectorCount / 2 + 1), opposite, 1);
  }
});

test('bands handle spread-out objects and the maximum board-size-minus-one limit', () => {
  const spread = boardWith(12, { [Obj.ASTEROID]: [1, 4, 7, 10] });
  assertPredicate(bandFeature(Obj.ASTEROID, 9), spread, 0);
  assertPredicate(bandFeature(Obj.ASTEROID, 10), spread, 1);
  assertPredicate(bandFeature(Obj.ASTEROID, 11), spread, 1);
  const nearlyFull = boardWith(12, { [Obj.ASTEROID]: Array.from({ length: 11 }, (unused, index) => index + 1) });
  assertPredicate(bandFeature(Obj.ASTEROID, 10), nearlyFull, 0);
  assertPredicate(bandFeature(Obj.ASTEROID, 11), nearlyFull, 1);
  assertPredicate(bandFeature(Obj.ASTEROID, 11), Array(12).fill(Obj.ASTEROID), 0);
});

test('adjacent wraps across 12/1 but excludes a two-step neighbor', () => {
  const adjacent = boardWith(12, { [Obj.ASTEROID]: [12], [Obj.COMET]: [1] });
  const separated = boardWith(12, { [Obj.ASTEROID]: [12], [Obj.COMET]: [2] });
  for (const quantifier of ['none', 'some', 'all']) {
    assertPredicate(relationFeature('adjacent', quantifier), adjacent, quantifier === 'none' ? 0 : 1);
    assertPredicate(relationFeature('adjacent', quantifier), separated, quantifier === 'none' ? 1 : 0);
  }
});

test('opposite means exactly half a circle on both 12- and 18-sector boards', () => {
  for (const sectorCount of [12, 18]) {
    for (const offset of [-1, 0, 1]) {
      const board = boardWith(sectorCount, {
        [Obj.ASTEROID]: [sectorCount],
        [Obj.COMET]: [sectorCount / 2 + offset],
      });
      const matched = offset === 0;
      for (const quantifier of ['none', 'some', 'all']) {
        assertPredicate(relationFeature('opposite', quantifier), board, Number(quantifier === 'none' ? !matched : matched));
      }
    }
  }
});

test('within uses inclusive shortest distance in either direction and never includes the half-circle distance', () => {
  for (const sectorCount of [12, 18]) {
    for (let range = 2; range < sectorCount / 2; range += 1) {
      for (let distance = 1; distance <= sectorCount / 2; distance += 1) {
        for (const subject of [1, sectorCount]) {
          for (const direction of [-1, 1]) {
            const neighbor = (subject - 1 + direction * distance + sectorCount) % sectorCount + 1;
            const board = boardWith(sectorCount, { [Obj.ASTEROID]: [subject], [Obj.COMET]: [neighbor] });
            for (const quantifier of ['none', 'some', 'all']) {
              const matched = distance <= range;
              assertPredicate(relationFeature('within', quantifier, range), board, Number(quantifier === 'none' ? !matched : matched));
            }
          }
        }
      }
    }
  }
});

test('some includes all subjects, and multiple subjects may share the same neighbor', () => {
  const cases = [
    ['adjacent', [12, 2], [1]],
    ['opposite', [1, 2], [7, 8]],
    ['within', [12, 3], [1]],
  ];
  for (const [relation, subjects, neighbors] of cases) {
    const board = boardWith(12, { [Obj.ASTEROID]: subjects, [Obj.COMET]: neighbors });
    assertPredicate(relationFeature(relation, 'none', 2), board, 0);
    assertPredicate(relationFeature(relation, 'some', 2), board, 1);
    assertPredicate(relationFeature(relation, 'all', 2), board, 1);
  }
});

test('some can match one subject while all is false', () => {
  const cases = [
    ['adjacent', [12, 5], [1]],
    ['opposite', [1, 2], [7]],
    ['within', [12, 6], [1]],
  ];
  for (const [relation, subjects, neighbors] of cases) {
    const board = boardWith(12, { [Obj.ASTEROID]: subjects, [Obj.COMET]: neighbors });
    assertPredicate(relationFeature(relation, 'none', 2), board, 0);
    assertPredicate(relationFeature(relation, 'some', 2), board, 1);
    assertPredicate(relationFeature(relation, 'all', 2), board, 0);
  }
});

test('none holds only when every possible subject-neighbor pair fails the relation', () => {
  const cases = [
    ['adjacent', [1, 5], [3, 9]],
    ['opposite', [1, 2], [4, 5]],
    ['within', [1, 2], [6, 7]],
  ];
  for (const [relation, subjects, neighbors] of cases) {
    const board = boardWith(12, { [Obj.ASTEROID]: subjects, [Obj.COMET]: neighbors });
    assertPredicate(relationFeature(relation, 'none', 2), board, 1);
    assertPredicate(relationFeature(relation, 'some', 2), board, 0);
    assertPredicate(relationFeature(relation, 'all', 2), board, 0);
  }
});

test('all quantifies only the subject population, not every neighbor', () => {
  const cases = [
    ['adjacent', [12, 2], [1, 6]],
    ['opposite', [1], [7, 8]],
    ['within', [12, 3], [1, 7]],
  ];
  for (const [relation, subjects, neighbors] of cases) {
    const board = boardWith(12, { [Obj.ASTEROID]: subjects, [Obj.COMET]: neighbors });
    const feature = relationFeature(relation, 'all', 2);
    const reverse = { ...feature, objectType: Obj.COMET, neighborType: Obj.ASTEROID };
    assertPredicate(feature, board, 1);
    assertPredicate(reverse, board, 0);
    assertPredicate({ ...feature, quantifier: 'some' }, board, 1);
    assertPredicate({ ...reverse, quantifier: 'some' }, board, 1);
  }
});

test('empty populations keep existential and universal meanings and return numeric values', () => {
  const noSubjects = boardWith(12, { [Obj.COMET]: [1] });
  const noNeighbors = boardWith(12, { [Obj.ASTEROID]: [1] });
  const empty = Array(12).fill(Obj.EMPTY);
  for (const relation of ['adjacent', 'opposite', 'within']) {
    for (const quantifier of ['none', 'some', 'all']) {
      const feature = relationFeature(relation, quantifier, 2);
      for (const board of [noSubjects, empty]) {
        assertPredicate(feature, board, quantifier === 'some' ? 0 : 1);
      }
      assertPredicate(feature, noNeighbors, quantifier === 'none' ? 1 : 0);
      assert.equal(researchFeatureValue(feature, {}, 12), oracleValue(feature, empty));
    }
  }
  assertPredicate(bandFeature(Obj.ASTEROID, 4), empty, 1);
});

test('research cannot distinguish swapping X and truly empty sectors', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  const board = boardWith(12, {
    [Obj.ASTEROID]: [11, 12, 1, 2],
    [Obj.COMET]: [3, 9],
    [Obj.GAS_CLOUD]: [5, 8],
    [Obj.DWARF_PLANET]: [6],
    [Obj.PLANET_X]: [10],
  });
  const swapped = [...board];
  [swapped[9], swapped[3]] = [swapped[3], swapped[9]];
  assertBoardFeatures(features, board);
  assertBoardFeatures(features, swapped);
  for (const feature of features) {
    assert.equal(oracleValue(feature, board), oracleValue(feature, swapped));
  }
});

test('predicate evaluation leaves frozen inputs and engine-added caches unchanged', () => {
  const board = Object.freeze(boardWith(12, { [Obj.ASTEROID]: [12, 1], [Obj.COMET]: [2] }));
  const masks = Object.freeze(boardMasks(board));
  const expectedMasks = { ...masks };
  const features = [bandFeature(Obj.ASTEROID, 2), relationFeature('adjacent', 'some'), relationFeature('adjacent', 'all')];
  for (const original of features) {
    const feature = Object.freeze({ ...original, values: new Uint8Array([0, 1]), score: 7 });
    assert.equal(researchFeatureValue(feature, masks, 12), oracleValue(feature, board));
    assert.deepEqual(feature.values, new Uint8Array([0, 1]));
    assert.equal(feature.score, 7);
  }
  assert.deepEqual(masks, expectedMasks);
});

test('every feature agrees with the array oracle on all 729 two-type six-sector boards', () => {
  const features = buildResearchFeatures(6, {
    [Obj.ASTEROID]: 2,
    [Obj.COMET]: 2,
    [Obj.GAS_CLOUD]: 1,
    [Obj.DWARF_PLANET]: 1,
  });
  assert.equal(features.length, 120);
  const types = [Obj.EMPTY, Obj.ASTEROID, Obj.COMET];
  for (let boardCode = 0; boardCode < 3 ** 6; boardCode += 1) {
    let remaining = boardCode;
    const board = Array.from({ length: 6 }, () => {
      const objectType = types[remaining % types.length];
      remaining = Math.floor(remaining / types.length);
      return objectType;
    });
    assertBoardFeatures(features, board);
  }
});

for (const sectorCount of [12, 18]) {
  test(`every ${sectorCount}-sector feature agrees with the independent oracle on varied complete inventories`, () => {
    const objectCounts = inventoryFor(sectorCount);
    const features = buildResearchFeatures(sectorCount, objectCounts);
    assert.equal(features.length, sectorCount === 12 ? 259 : 408);
    const board = inventoryBoard(objectCounts);
    assert.equal(board.length, sectorCount);
    for (let seed = 1; seed <= 24; seed += 1) {
      assertBoardFeatures(features, shuffledBoard(board, seed));
    }
  });
}

test('every feature is invariant under all rotations and reflections on both board sizes', () => {
  for (const sectorCount of [12, 18]) {
    const objectCounts = inventoryFor(sectorCount);
    const features = buildResearchFeatures(sectorCount, objectCounts);
    const board = shuffledBoard(inventoryBoard(objectCounts), 20260920);
    const expectedValues = features.map((feature) => oracleValue(feature, board));
    assert.ok(features.length > 0);
    for (const reflected of [false, true]) {
      for (let offset = 0; offset < sectorCount; offset += 1) {
        const transformed = board.map((unused, sector) => (
          board[(offset + (reflected ? -sector : sector) + sectorCount) % sectorCount]
        ));
        const masks = boardMasks(transformed);
        features.forEach((feature, index) => {
          assert.equal(oracleValue(feature, transformed), expectedValues[index], JSON.stringify(feature));
          assert.equal(researchFeatureValue(feature, masks, sectorCount), expectedValues[index], JSON.stringify(feature));
        });
      }
    }
  }
});

test('single-object topics contain only the corresponding Chinese label', () => {
  const cases = [
    [Obj.ASTEROID, '小行星'],
    [Obj.COMET, '彗星'],
    [Obj.GAS_CLOUD, '气体云'],
    [Obj.DWARF_PLANET, '矮行星'],
  ];
  for (const [objectType, title] of cases) {
    assert.equal(researchTopicName(bandFeature(objectType, 4)), title);
  }
});

test('all relations and both directions share the canonical Chinese topic name', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  for (const [firstType, secondType, topicKey, title] of TOPICS) {
    const related = features.filter((feature) => feature.topicKey === topicKey);
    assert.equal(related.length, 36);
    assert.deepEqual(new Set(related.map((feature) => feature.objectType)), new Set([firstType, secondType]));
    for (const feature of related) assert.equal(researchTopicName(feature), title);
  }
});

test('band clues follow the exact single-sentence Chinese template', () => {
  const cases = [
    [Obj.ASTEROID, 4, '所有小行星都位于一段不超过 4 个连续扇区内。'],
    [Obj.COMET, 2, '所有彗星都位于一段不超过 2 个连续扇区内。'],
    [Obj.GAS_CLOUD, 11, '所有气体云都位于一段不超过 11 个连续扇区内。'],
    [Obj.DWARF_PLANET, 4, '所有矮行星都位于一段不超过 4 个连续扇区内。'],
  ];
  for (const [objectType, length, expected] of cases) {
    assert.equal(researchClueText(bandFeature(objectType, length)), expected);
  }
});

const RELATION_TEXT_CASES = [
  ['adjacent', 'none', '没有任何气体云与彗星相邻。'],
  ['adjacent', 'some', '至少有一个气体云与某个彗星相邻。'],
  ['adjacent', 'all', '每个气体云都与至少一个彗星相邻。'],
  ['opposite', 'none', '没有任何气体云与彗星正对。'],
  ['opposite', 'some', '至少有一个气体云与某个彗星正对。'],
  ['opposite', 'all', '每个气体云都与至少一个彗星正对。'],
  ['within', 'none', '没有任何气体云位于彗星的 5 个扇区以内。'],
  ['within', 'some', '至少有一个气体云位于某个彗星的 5 个扇区以内。'],
  ['within', 'all', '每个气体云都位于至少一个彗星的 5 个扇区以内。'],
];

const CONFERENCE_TEXT_CASES = [
  ['adjacent', 'none', 'X行星不与任何气体云相邻。', '没有任何气体云与X行星相邻。'],
  ['adjacent', 'some', 'X行星与至少一个气体云相邻。', '至少有一个气体云与X行星相邻。'],
  ['adjacent', 'all', 'X行星与至少一个气体云相邻。', '每个气体云都与X行星相邻。'],
  ['opposite', 'none', 'X行星不与任何气体云正对。', '没有任何气体云与X行星正对。'],
  ['opposite', 'some', 'X行星与至少一个气体云正对。', '至少有一个气体云与X行星正对。'],
  ['opposite', 'all', 'X行星与至少一个气体云正对。', '每个气体云都与X行星正对。'],
  ['within', 'none', 'X行星不在任何气体云的 5 个扇区以内。', '没有任何气体云位于X行星的 5 个扇区以内。'],
  ['within', 'some', 'X行星位于至少一个气体云的 5 个扇区以内。', '至少有一个气体云位于X行星的 5 个扇区以内。'],
  ['within', 'all', 'X行星位于至少一个气体云的 5 个扇区以内。', '每个气体云都位于X行星的 5 个扇区以内。'],
];

for (const [relation, quantifier, expectedForward, expectedReverse] of CONFERENCE_TEXT_CASES) {
  test(`${relation}/${quantifier} conference wording treats X as a singleton in either direction`, () => {
    const forward = { ...relationFeature(relation, quantifier, 5), objectType: Obj.PLANET_X, neighborType: Obj.GAS_CLOUD };
    const reverse = { ...forward, objectType: Obj.GAS_CLOUD, neighborType: Obj.PLANET_X };
    assert.equal(researchClueText(forward), expectedForward);
    assert.equal(researchClueText(reverse), expectedReverse);
    for (const feature of [forward, reverse]) {
      const text = researchClueText(feature);
      assert.match(text, /^[^。！？\n]+。$/u);
      assert.doesNotMatch(text, /空域|第|恰有|每个X行星|任何X行星|某个X行星|至少(?:有)?一个X行星/u);
    }
  });
}

for (const [relation, quantifier, expected] of RELATION_TEXT_CASES) {
  test(`${relation}/${quantifier} clue preserves its subject and follows the literal Chinese template`, () => {
    const feature = {
      ...relationFeature(relation, quantifier, 5),
      objectType: Obj.GAS_CLOUD,
      neighborType: Obj.COMET,
      topicKey: 'comet|gasCloud',
    };
    assert.equal(researchClueText(feature), expected);
    assert.equal(researchTopicName(feature), '彗星和气体云');
  });
}

test('every generated clue is a single sentence without extra facts or excluded objects', () => {
  for (const sectorCount of [12, 18]) {
    const features = buildResearchFeatures(sectorCount, inventoryFor(sectorCount));
    assert.ok(features.length > 0);
    for (const feature of features) {
      const text = researchClueText(feature);
      assert.equal(typeof text, 'string');
      assert.match(text, /^[^。！？\n]+。$/u);
      assert.doesNotMatch(text, /且|；|X|空域|第|起点/u);
    }
  }
});

test('topic and clue rendering are pure and accept engine-added cache properties', () => {
  const features = buildResearchFeatures(12, OBJECT_COUNTS);
  assert.ok(features.length > 0);
  for (const original of features) {
    const title = researchTopicName(original);
    const text = researchClueText(original);
    assert.equal(typeof title, 'string');
    assert.equal(typeof text, 'string');
    const feature = Object.freeze({ ...original, values: new Uint8Array([1, 0]), score: 9 });
    const snapshot = structuredClone(feature);
    assert.equal(researchTopicName(feature), title);
    assert.equal(researchClueText(feature), text);
    assert.deepEqual(feature, snapshot);
  }
});
