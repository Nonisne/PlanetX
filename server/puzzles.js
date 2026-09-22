import { Obj, INITIAL_CLUE_TYPES, apparentType } from '../public/src/types.js';
import { buildResearchFeatures, buildConferenceFeatures, researchFeatureValue, researchTopicName, conferenceTopicName, researchClueText } from './research.js';
import { EXPERT_COMET_SECTORS, validateExpertBoard, createExpertDefinition, countExpertSolutions } from './expert-puzzles.js';

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
  if (Array.isArray(objects) && objects.length === 18) return validateExpertBoard(objects);
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

function engine() {
  if (cachedEngine) return cachedEngine;
  const candidates = enumerateBoards();
  const research = buildResearchFeatures(SECTOR_COUNT, OBJECT_COUNTS);
  const conference = buildConferenceFeatures(SECTOR_COUNT);
  for (const feature of [...research, ...conference]) {
    feature.values = Uint8Array.from(candidates, (candidate) => researchFeatureValue(feature, candidate.masks, SECTOR_COUNT));
  }
  const informativeResearch = research.filter((feature) => feature.values.includes(0) && feature.values.includes(1));
  const informativeConferences = conference.filter((feature) => feature.values.includes(0) && feature.values.includes(1));
  const observationGroups = new Map();
  for (const [index, candidate] of candidates.entries()) {
    const key = candidate.objects.map(apparentType).join(',');
    if (!observationGroups.has(key)) observationGroups.set(key, []);
    observationGroups.get(key).push(index);
  }
  const eligible = [];
  for (const [answerIndex, candidate] of candidates.entries()) {
    const observationPeers = observationGroups.get(candidate.objects.map(apparentType).join(','));
    const conferenceOptions = informativeConferences.filter((feature) => feature.values[answerIndex] === 1
      && observationPeers.every((index) => index === answerIndex || feature.values[index] === 0));
    if (conferenceOptions.length) eligible.push({ answerIndex, conferenceOptions });
  }
  cachedEngine = { candidates, research: informativeResearch, eligible, indices: candidates.map((candidate, index) => index) };
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

function createStandardPuzzle(random) {
  const catalogue = engine();
  const { answerIndex, conferenceOptions } = catalogue.eligible[randomIndex(catalogue.eligible.length, random)];
  const conference = { feature: conferenceOptions[randomIndex(conferenceOptions.length, random)], value: 1 };
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
  return assemblePuzzle('standard', catalogue.candidates[answerIndex].objects, research, { 10: conference });
}

function assemblePuzzle(modeId, objects, research, conferences) {
  const puzzle = {
    modeId,
    objects: objects.slice(),
    topics: Object.fromEntries(TOPIC_IDS.map((topicId, index) => [topicId, {
      name: researchTopicName(research[index][0].feature),
      clue: researchClueText(research[index][0].feature),
    }])),
    conferences: Object.fromEntries(Object.entries(conferences).map(([sector, constraint]) => [sector, researchClueText(constraint.feature)])),
    conferenceNames: Object.fromEntries(Object.entries(conferences).map(([sector, constraint]) => [sector, conferenceTopicName(constraint.feature)])),
  };
  puzzleConstraints.set(puzzle, { modeId, sectorCount: objects.length, research, conferences: Object.values(conferences) });
  return puzzle;
}

export function createPuzzle({ modeId = 'standard', random = Math.random, maxAttempts } = {}) {
  if (modeId !== 'standard' && modeId !== 'expert') throw new RangeError('modeId must be standard or expert.');
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  if (modeId === 'standard') return createStandardPuzzle(random);
  const { objects, research, conferences } = createExpertDefinition((length) => randomIndex(length, random), { maxAttempts });
  return assemblePuzzle(modeId, objects, research, conferences);
}

const DEAL_GUARD = Object.freeze({
  standard: Object.freeze({ maxPrimeCometExclusions: 1, minCandidates: 64 }),
  expert: Object.freeze({ maxPrimeCometExclusions: 2, minCandidates: 10000 }),
});
const DEAL_GUARD_ATTEMPTS = 48;

function sampleExclusions(exclusions, count, random, rotation = 0) {
  const offset = ((rotation % exclusions.length) + exclusions.length) % exclusions.length;
  const pool = offset === 0 ? exclusions.slice() : exclusions.slice(offset).concat(exclusions.slice(0, offset));
  for (let index = 0; index < count; index += 1) {
    const selected = index + randomIndex(pool.length - index, random);
    [pool[index], pool[selected]] = [pool[selected], pool[index]];
  }
  return pool.slice(0, count);
}

function primeCometExclusionCount(clues) {
  return clues.reduce((total, clue) => total + (clue.objectType === Obj.COMET ? 1 : 0), 0);
}

function handPassesDealGuard(puzzle, hand, guard, { scoreCandidates }) {
  if (primeCometExclusionCount(hand) > guard.maxPrimeCometExclusions) return { ok: false, candidates: -1 };
  if (!scoreCandidates) return { ok: true, candidates: Infinity };
  const candidates = countSolutions(puzzle, { topicIds: [], includeConference: false, initialClues: hand });
  return { ok: candidates >= guard.minCandidates, candidates };
}

export function initialCluesFor(puzzle, { count = 4, random = Math.random } = {}) {
  if (!validateBoard(puzzle?.objects)) throw new TypeError('Initial clues require a valid standard board or expert board.');
  const modeId = puzzle.objects.length === 18 ? 'expert' : 'standard';
  const cometSectors = modeId === 'expert' ? new Set(EXPERT_COMET_SECTORS) : COMET_SECTORS;
  const exclusions = puzzle.objects.flatMap((object, sector) => INITIAL_CLUE_TYPES
    .filter((objectType) => objectType !== apparentType(object) && (objectType !== Obj.COMET || cometSectors.has(sector)))
    .map((objectType) => ({ sector, objectType })));
  if (!Number.isInteger(count) || count < 0 || count > exclusions.length) {
    throw new RangeError(`count must be an integer from 0 to ${exclusions.length}.`);
  }
  if (typeof random !== 'function') throw new TypeError('random must be a function.');
  if (count === 0) return [];
  // Full-pool deals skip the guard so enumeration helpers stay exact.
  if (count === exclusions.length) return sampleExclusions(exclusions, count, random);
  const guard = DEAL_GUARD[modeId];
  const scoreCandidates = puzzleConstraints.has(puzzle);
  let bestHand = null;
  let bestScore = -Infinity;
  for (let attempt = 0; attempt < DEAL_GUARD_ATTEMPTS; attempt += 1) {
    const hand = sampleExclusions(exclusions, count, random, attempt);
    const { ok, candidates } = handPassesDealGuard(puzzle, hand, guard, { scoreCandidates });
    if (ok) return hand;
    if (candidates > bestScore) {
      bestScore = candidates;
      bestHand = hand;
    } else if (!bestHand) {
      bestHand = hand;
    }
  }
  return bestHand;
}

function selectedConstraints(puzzle, { topicIds = TOPIC_IDS, includeConference = true } = {}) {
  const constraints = puzzleConstraints.get(puzzle);
  if (!constraints) throw new TypeError('Solver helpers require a puzzle returned by createPuzzle.');
  if (!Array.isArray(topicIds) || [...topicIds].some((topicId) => !TOPIC_IDS.includes(topicId))) {
    throw new RangeError('topicIds must contain only A–F.');
  }
  if (typeof includeConference !== 'boolean') throw new TypeError('includeConference must be a boolean.');
  const selected = [...new Set(topicIds)].flatMap((topicId) => constraints.research[TOPIC_IDS.indexOf(topicId)]);
  if (includeConference) selected.push(...constraints.conferences);
  return selected;
}

function checkedInitialClues({ initialClues = [] } = {}, sectorCount = SECTOR_COUNT) {
  if (!Array.isArray(initialClues)) throw new TypeError('initialClues must be an array of exclusions.');
  for (const clue of initialClues) {
    if (!Number.isInteger(clue?.sector) || clue.sector < 0 || clue.sector >= sectorCount || !INITIAL_CLUE_TYPES.includes(clue.objectType)) {
      throw new RangeError(`initialClues require zero-based sectors 0–${sectorCount - 1} and ordinary objectType keys.`);
    }
  }
  return initialClues;
}

function matchesExclusions(objects, initialClues) {
  return initialClues.every(({ sector, objectType }) => apparentType(objects[sector]) !== objectType);
}

export function matchingClues(objects, puzzle, options = {}) {
  const constraints = selectedConstraints(puzzle, options);
  const { sectorCount } = puzzleConstraints.get(puzzle);
  const initialClues = checkedInitialClues(options, sectorCount);
  if (!validateBoard(objects) || objects.length !== sectorCount) return false;
  if (!matchesExclusions(objects, initialClues)) return false;
  const masks = Object.fromEntries(Object.keys(OBJECT_COUNTS).map((objectType) => [objectType, 0]));
  objects.forEach((objectType, sector) => { masks[objectType] |= 1 << sector; });
  return constraints.every((constraint) => researchFeatureValue(constraint.feature, masks, sectorCount) === constraint.value);
}

export function countSolutions(puzzle, options = {}) {
  const { limit = Infinity } = options;
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new RangeError('limit must be a positive integer or Infinity.');
  const constraints = selectedConstraints(puzzle, options);
  const { modeId, sectorCount } = puzzleConstraints.get(puzzle);
  const initialClues = checkedInitialClues(options, sectorCount);
  if (modeId === 'expert') return countExpertSolutions(constraints, initialClues, options);
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
