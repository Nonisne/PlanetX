import { Obj, LABEL, INITIAL_CLUE_TYPES, SURVEY_TYPES, apparentType } from '../public/src/types.js';
import { buildResearchFeatures, researchFeatureValue, researchTopicName, researchClueText } from './research.js';

const SECTOR_COUNT = 12;
const COMET_SECTORS = new Set([1, 2, 4, 6, 10]);
const OBJECT_COUNTS = Object.freeze({
  [Obj.ASTEROID]: 4,
  [Obj.COMET]: 2,
  [Obj.GAS_CLOUD]: 2,
  [Obj.DWARF_PLANET]: 1,
  [Obj.EMPTY]: 2,
  [Obj.PLANET_X]: 1,
});
const TOPIC_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);
const FULL_MASK = (1 << SECTOR_COUNT) - 1;
const POPCOUNTS = new Uint8Array(FULL_MASK + 1);
for (let mask = 1; mask <= FULL_MASK; mask += 1) {
  POPCOUNTS[mask] = POPCOUNTS[mask >> 1] + (mask & 1);
}
const puzzleConstraints = new WeakMap();
let cachedEngine;

export function validateBoard(objects) {
  if (!Array.isArray(objects) || objects.length !== SECTOR_COUNT) return false;
  for (const [objectType, count] of Object.entries(OBJECT_COUNTS)) {
    if (objects.filter((object) => object === objectType).length !== count) return false;
  }
  return objects.every((objectType, sector) => {
    const before = objects[(sector + SECTOR_COUNT - 1) % SECTOR_COUNT];
    const after = objects[(sector + 1) % SECTOR_COUNT];
    if (objectType === Obj.COMET) return COMET_SECTORS.has(sector);
    if (objectType === Obj.ASTEROID) return before === Obj.ASTEROID || after === Obj.ASTEROID;
    if (objectType === Obj.GAS_CLOUD) return before === Obj.EMPTY || after === Obj.EMPTY;
    if (objectType === Obj.DWARF_PLANET) return before !== Obj.PLANET_X && after !== Obj.PLANET_X;
    return true;
  });
}

function adjacentMask(mask) {
  return ((mask << 1) | (mask >> 11) | (mask >> 1) | (mask << 11)) & FULL_MASK;
}

function enumerateBoards() {
  const pairs = [];
  const asteroidGroups = [];
  for (let mask = 0; mask <= FULL_MASK; mask += 1) {
    if (POPCOUNTS[mask] === 2) pairs.push(mask);
    if (POPCOUNTS[mask] === 4 && !(mask & ~adjacentMask(mask))) asteroidGroups.push(mask);
  }
  const cometMask = [...COMET_SECTORS].reduce((mask, sector) => mask | (1 << sector), 0);
  const candidates = [];
  for (const comets of pairs) {
    if (comets & ~cometMask) continue;
    for (const asteroids of asteroidGroups) {
      if (asteroids & comets) continue;
      const available = FULL_MASK ^ (asteroids | comets);
      for (const empty of pairs) {
        if (empty & ~available) continue;
        const gasSectors = (available ^ empty) & adjacentMask(empty);
        for (const gasClouds of pairs) {
          if (gasClouds & ~gasSectors) continue;
          const singletons = available ^ empty ^ gasClouds;
          if (singletons & adjacentMask(singletons)) continue;
          const first = singletons & -singletons;
          for (const planetX of [first, singletons ^ first]) {
            const masks = {
              [Obj.ASTEROID]: asteroids,
              [Obj.COMET]: comets,
              [Obj.GAS_CLOUD]: gasClouds,
              [Obj.DWARF_PLANET]: singletons ^ planetX,
              [Obj.EMPTY]: empty,
              [Obj.PLANET_X]: planetX,
            };
            const objects = Array(SECTOR_COUNT);
            for (const [objectType, mask] of Object.entries(masks)) {
              for (let sector = 0; sector < SECTOR_COUNT; sector += 1) {
                if (mask & (1 << sector)) objects[sector] = objectType;
              }
            }
            candidates.push({ objects, masks });
          }
        }
      }
    }
  }
  return candidates;
}

function arcMask(start, length) {
  let mask = 0;
  for (let offset = 0; offset < length; offset += 1) mask |= 1 << ((start + offset) % SECTOR_COUNT);
  return mask;
}

function featureValue(feature, masks) {
  if (feature.kind === 'band' || feature.kind === 'relation') {
    return researchFeatureValue(feature, masks, SECTOR_COUNT);
  }
  if (feature.kind === 'arc' || feature.kind === 'x-candidates') {
    return POPCOUNTS[masks[feature.objectType] & feature.mask];
  }
  if (feature.kind === 'x-neighbors') {
    return POPCOUNTS[adjacentMask(masks[Obj.PLANET_X]) & masks[feature.objectType]];
  }
  if (feature.kind !== 'x-distance') throw new Error('Unknown puzzle feature kind.');
  let reachable = masks[Obj.PLANET_X];
  for (let distance = 1; distance <= SECTOR_COUNT / 2; distance += 1) {
    reachable |= adjacentMask(reachable);
    if (reachable & masks[feature.objectType]) return distance;
  }
  throw new Error('Invalid distance constraint.');
}

function engine() {
  if (cachedEngine) return cachedEngine;
  const candidates = enumerateBoards();
  const research = buildResearchFeatures(SECTOR_COUNT, OBJECT_COUNTS);
  const conference = [];
  for (let length = 3; length <= 6; length += 1) {
    for (let start = 0; start < SECTOR_COUNT; start += 1) {
      conference.push({ kind: 'arc', objectType: Obj.PLANET_X, start, length, mask: arcMask(start, length) });
    }
  }
  for (const objectType of SURVEY_TYPES) {
    conference.push({ kind: 'x-neighbors', objectType }, { kind: 'x-distance', objectType });
  }
  for (let first = 0; first < SECTOR_COUNT; first += 1) {
    for (let second = first + 1; second < SECTOR_COUNT; second += 1) {
      conference.push({ kind: 'x-candidates', objectType: Obj.PLANET_X, first, second, mask: (1 << first) | (1 << second) });
    }
  }
  for (const feature of [...research, ...conference]) {
    feature.values = Uint8Array.from(candidates, (candidate) => featureValue(feature, candidate.masks));
  }
  const informativeResearch = research.filter((feature) => feature.values.includes(0) && feature.values.includes(1));
  const observationGroups = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const key = candidate.objects.map(apparentType).join(',');
    if (!observationGroups.has(key)) observationGroups.set(key, []);
    observationGroups.get(key).push(index);
  }
  cachedEngine = { candidates, research: informativeResearch, conference, observationGroups, indices: candidates.map((candidate, index) => index) };
  return cachedEngine;
}

function randomIndex(length, random) {
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  const value = random();
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError('random must return a finite number in [0, 1).');
  }
  return Math.floor(value * length);
}

function matchingIndices(indices, constraint) {
  return indices.filter((index) => constraint.feature.values[index] === constraint.value);
}

function chooseResearch(features, indices, answerIndex, desiredCount, used, random) {
  let bestScore = Infinity;
  let choices = [];
  for (const feature of features) {
    if (used.has(feature.topicKey) || feature.values[answerIndex] !== 1) continue;
    let count = 0;
    for (const index of indices) {
      if (feature.values[index] === 1) count += 1;
    }
    if (count === indices.length) continue;
    const score = Math.abs(count - desiredCount);
    if (score < bestScore) {
      bestScore = score;
      choices = [{ feature, value: 1 }];
    } else if (score === bestScore) {
      choices.push({ feature, value: 1 });
    }
  }
  if (!choices.length) return null;
  const selected = choices[randomIndex(choices.length, random)];
  used.add(selected.feature.topicKey);
  return selected;
}

function clueLabel(objectType) {
  return objectType === Obj.EMPTY ? '真正空域的扇区' : LABEL[objectType];
}

function clueText({ feature, value }) {
  const label = clueLabel(feature.objectType);
  if (feature.kind === 'arc') {
    return `从第 ${feature.start + 1} 扇区起顺时针连续 ${feature.length} 个扇区中，${label}恰有 ${value} 个。`;
  }
  if (feature.kind === 'x-neighbors') {
    return `X行星相邻的两个扇区中，${label}恰有 ${value} 个。`;
  }
  if (feature.kind === 'x-candidates') {
    return `X行星位于第 ${feature.first + 1} 或第 ${feature.second + 1} 扇区。`;
  }
  return `X行星与最近的${label}之间的最短环形距离为 ${value}（相邻为 1）。`;
}

export function createPuzzle({ modeId = 'standard', random = Math.random } = {}) {
  if (modeId !== 'standard') throw new RangeError('Only standard mode is supported by the built-in puzzle engine.');
  const catalogue = engine();
  const answerIndex = randomIndex(catalogue.candidates.length, random);
  const observedKey = catalogue.candidates[answerIndex].objects.map(apparentType).join(',');
  const observationPeers = catalogue.observationGroups.get(observedKey);
  const conferenceOptions = [];
  for (const feature of catalogue.conference) {
    const value = feature.values[answerIndex];
    if ((feature.kind === 'arc' || feature.kind === 'x-candidates') && value !== 1) continue;
    const constraint = { feature, value };
    if (matchingIndices(observationPeers, constraint).length !== 1) continue;
    const count = matchingIndices(catalogue.indices, constraint).length;
    if (count > 1 && count < catalogue.indices.length) conferenceOptions.push(constraint);
  }
  if (!conferenceOptions.length) throw new Error('No conference can distinguish the observable boards.');
  const conference = conferenceOptions[randomIndex(conferenceOptions.length, random)];
  let remaining = matchingIndices(catalogue.indices, conference);
  const used = new Set();
  const availableBands = catalogue.research.filter((feature) => feature.kind === 'band' && feature.values[answerIndex] === 1);
  const bandCount = Math.min(2, new Set(availableBands.map((feature) => feature.topicKey)).size);
  const research = TOPIC_IDS.map((topicId, index) => {
    const kind = index < bandCount ? 'band' : 'relation';
    const features = catalogue.research.filter((feature) => feature.kind === kind);
    const slots = TOPIC_IDS.length - index;
    const indices = remaining.length > 1 ? remaining : catalogue.indices;
    const desiredCount = remaining.length > 1
      ? Math.max(1, Math.round(remaining.length ** ((slots - 1) / slots)))
      : Math.round(catalogue.indices.length / 3);
    let constraint = chooseResearch(features, indices, answerIndex, desiredCount, used, random);
    if (!constraint && indices !== catalogue.indices) {
      constraint = chooseResearch(features, catalogue.indices, answerIndex, Math.round(catalogue.indices.length / 3), used, random);
    }
    if (!constraint) throw new Error('Unable to select six distinct research topics.');
    remaining = matchingIndices(remaining, constraint);
    return [constraint];
  });
  for (let index = research.length - 1; index > 0; index -= 1) {
    const selected = randomIndex(index + 1, random);
    [research[index], research[selected]] = [research[selected], research[index]];
  }
  if (!remaining.includes(answerIndex)) throw new Error('Puzzle clue consistency verification failed.');
  const puzzle = {
    objects: catalogue.candidates[answerIndex].objects.slice(),
    topics: Object.fromEntries(TOPIC_IDS.map((topicId, index) => [topicId, {
      name: researchTopicName(research[index][0].feature),
      clue: researchClueText(research[index][0].feature),
    }])),
    conferences: { 10: clueText(conference) },
  };
  puzzleConstraints.set(puzzle, { research, conference });
  return puzzle;
}

export function initialCluesFor(puzzle, { count = 4, random = Math.random } = {}) {
  if (!validateBoard(puzzle?.objects)) throw new TypeError('Initial clues require a valid standard board.');
  const exclusions = puzzle.objects.flatMap((object, sector) => INITIAL_CLUE_TYPES
    .filter((objectType) => objectType !== apparentType(object))
    .map((objectType) => ({ sector, objectType })));
  if (!Number.isInteger(count) || count < 0 || count > exclusions.length) {
    throw new RangeError(`count must be an integer from 0 to ${exclusions.length}.`);
  }
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  for (let index = 0; index < count; index += 1) {
    const selected = index + randomIndex(exclusions.length - index, random);
    [exclusions[index], exclusions[selected]] = [exclusions[selected], exclusions[index]];
  }
  return exclusions.slice(0, count);
}

function selectedConstraints(puzzle, { topicIds = TOPIC_IDS, includeConference = true } = {}) {
  const constraints = puzzleConstraints.get(puzzle);
  if (!constraints) throw new TypeError('Solver helpers require a puzzle returned by createPuzzle.');
  if (!Array.isArray(topicIds) || [...topicIds].some((topicId) => !TOPIC_IDS.includes(topicId))) {
    throw new RangeError('topicIds must contain only A–F.');
  }
  if (typeof includeConference !== 'boolean') throw new TypeError('includeConference must be a boolean.');
  const selected = [...new Set(topicIds)].flatMap((topicId) => constraints.research[TOPIC_IDS.indexOf(topicId)]);
  if (includeConference) selected.push(constraints.conference);
  return selected;
}

function checkedInitialClues({ initialClues = [] } = {}) {
  if (!Array.isArray(initialClues)) throw new TypeError('initialClues must be an array of exclusions.');
  for (const clue of initialClues) {
    if (!Number.isInteger(clue?.sector) || clue.sector < 0 || clue.sector >= SECTOR_COUNT || !INITIAL_CLUE_TYPES.includes(clue.objectType)) {
      throw new RangeError('initialClues require zero-based sectors 0–11 and ordinary objectType keys.');
    }
  }
  return initialClues;
}

function matchesExclusions(objects, initialClues) {
  return initialClues.every(({ sector, objectType }) => apparentType(objects[sector]) !== objectType);
}

export function matchingClues(objects, puzzle, options = {}) {
  const constraints = selectedConstraints(puzzle, options);
  const initialClues = checkedInitialClues(options);
  if (!validateBoard(objects)) return false;
  if (!matchesExclusions(objects, initialClues)) return false;
  const masks = Object.fromEntries(Object.keys(OBJECT_COUNTS).map((objectType) => [objectType, 0]));
  objects.forEach((objectType, sector) => { masks[objectType] |= 1 << sector; });
  return constraints.every((constraint) => featureValue(constraint.feature, masks) === constraint.value);
}

export function countSolutions(puzzle, options = {}) {
  const { limit = Infinity } = options;
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new RangeError('limit must be a positive integer or Infinity.');
  const constraints = selectedConstraints(puzzle, options);
  const initialClues = checkedInitialClues(options);
  const catalogue = engine();
  let count = 0;
  for (const index of catalogue.indices) {
    if (!constraints.every((constraint) => constraint.feature.values[index] === constraint.value)) continue;
    if (!matchesExclusions(catalogue.candidates[index].objects, initialClues)) continue;
    count += 1;
    if (count >= limit) break;
  }
  return count;
}
