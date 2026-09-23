import { Obj } from '../public/src/types.js';
import { buildResearchFeatures, buildConferenceFeatures, researchFeatureValue, researchClueText } from './research.js';

const SECTOR_COUNT = 18;
// A band that covers more than a third of the expert circle barely rules anything out.
// Dwarf planets are already fixed to an exact six-sector band by the base rules.
const USEFUL_BAND_LENGTH = 6;
const FULL_MASK = (1 << SECTOR_COUNT) - 1;
const MAX_ATTEMPTS = 256;
const DEFAULT_MAX_NODES = 20000000;
export const EXPERT_COMET_SECTORS = Object.freeze([1, 2, 4, 6, 10, 12, 16]);
export const EXPERT_OBJECT_COUNTS = Object.freeze({
  [Obj.ASTEROID]: 4,
  [Obj.COMET]: 2,
  [Obj.GAS_CLOUD]: 2,
  [Obj.DWARF_PLANET]: 4,
  [Obj.EMPTY]: 5,
  [Obj.PLANET_X]: 1,
});
let cachedPlacements;
let cachedFeatures;

export function validateExpertBoard(objects) {
  if (!Array.isArray(objects) || objects.length !== SECTOR_COUNT) return false;
  for (const [objectType, count] of Object.entries(EXPERT_OBJECT_COUNTS)) {
    if (objects.filter((object) => object === objectType).length !== count) return false;
  }
  const dwarfs = objects.flatMap((object, sector) => object === Obj.DWARF_PLANET ? [sector] : []);
  if (!dwarfs.some((start) => objects[(start + 5) % SECTOR_COUNT] === Obj.DWARF_PLANET
    && dwarfs.every((sector) => (sector - start + SECTOR_COUNT) % SECTOR_COUNT < 6))) return false;
  return objects.every((objectType, sector) => {
    const before = objects[(sector + SECTOR_COUNT - 1) % SECTOR_COUNT];
    const after = objects[(sector + 1) % SECTOR_COUNT];
    if (objectType === Obj.COMET) return EXPERT_COMET_SECTORS.includes(sector);
    if (objectType === Obj.ASTEROID) return before === Obj.ASTEROID || after === Obj.ASTEROID;
    if (objectType === Obj.GAS_CLOUD) return before === Obj.EMPTY || after === Obj.EMPTY;
    if (objectType === Obj.PLANET_X) return before !== Obj.DWARF_PLANET && after !== Obj.DWARF_PLANET;
    return true;
  });
}

function adjacentMask(mask) {
  return ((mask << 1) | (mask >>> 17) | (mask >>> 1) | (mask << 17)) & FULL_MASK;
}

function combinationMasks(sectors, count) {
  const masks = [];
  function visit(start, remaining, mask) {
    if (remaining === 0) {
      masks.push(mask);
      return;
    }
    for (let index = start; index <= sectors.length - remaining; index += 1) {
      visit(index + 1, remaining - 1, mask | (1 << sectors[index]));
    }
  }
  visit(0, count, 0);
  return masks;
}

function placements() {
  if (cachedPlacements) return cachedPlacements;
  const sectors = Array.from({ length: SECTOR_COUNT }, (unused, sector) => sector);
  const dwarfs = sectors.flatMap((start) => combinationMasks(
    Array.from({ length: 4 }, (unused, offset) => (start + offset + 1) % SECTOR_COUNT), 2,
  ).map((interior) => interior | (1 << start) | (1 << ((start + 5) % SECTOR_COUNT))));
  cachedPlacements = {
    [Obj.DWARF_PLANET]: dwarfs,
    [Obj.COMET]: combinationMasks(EXPERT_COMET_SECTORS, 2),
    [Obj.ASTEROID]: combinationMasks(sectors, 4).filter((mask) => !(mask & ~adjacentMask(mask))),
    [Obj.GAS_CLOUD]: combinationMasks(sectors, 2),
  };
  return cachedPlacements;
}

function singleBits(mask) {
  const bits = [];
  for (let remaining = mask; remaining; remaining &= remaining - 1) bits.push(remaining & -remaining);
  return bits;
}

function legalPlanetPlacements(masks) {
  const observedEmpty = FULL_MASK ^ (masks[Obj.DWARF_PLANET] | masks[Obj.COMET] | masks[Obj.ASTEROID] | masks[Obj.GAS_CLOUD]);
  const available = observedEmpty & ~adjacentMask(masks[Obj.DWARF_PLANET]);
  let planets = 0;
  for (const planet of singleBits(available)) {
    if (!(masks[Obj.GAS_CLOUD] & ~adjacentMask(observedEmpty ^ planet))) planets |= planet;
  }
  return planets;
}

function completeObservationPeers(masks) {
  const observedEmpty = masks[Obj.EMPTY] | masks[Obj.PLANET_X];
  return singleBits(legalPlanetPlacements(masks)).map((planet) => ({
    ...masks, [Obj.PLANET_X]: planet, [Obj.EMPTY]: observedEmpty ^ planet,
  }));
}

function sampleCandidate(selectIndex, attempt) {
  const groups = placements();
  const dwarfs = groups[Obj.DWARF_PLANET];
  const masks = { [Obj.DWARF_PLANET]: dwarfs[(selectIndex(dwarfs.length) + attempt) % dwarfs.length] };
  let occupied = masks[Obj.DWARF_PLANET];
  for (const objectType of [Obj.COMET, Obj.ASTEROID]) {
    const choices = groups[objectType].filter((mask) => !(mask & occupied));
    if (!choices.length) return null;
    masks[objectType] = choices[selectIndex(choices.length)];
    occupied |= masks[objectType];
  }
  const gasChoices = [];
  for (const gas of groups[Obj.GAS_CLOUD]) {
    if (gas & occupied) continue;
    masks[Obj.GAS_CLOUD] = gas;
    const planets = legalPlanetPlacements(masks);
    if (planets) gasChoices.push({ gas, planets });
  }
  if (!gasChoices.length) return null;
  const selected = gasChoices[selectIndex(gasChoices.length)];
  const planets = singleBits(selected.planets);
  masks[Obj.GAS_CLOUD] = selected.gas;
  masks[Obj.PLANET_X] = planets[selectIndex(planets.length)];
  masks[Obj.EMPTY] = FULL_MASK ^ (occupied | selected.gas | masks[Obj.PLANET_X]);
  return masks;
}

function featuresWithCounterexamples() {
  if (cachedFeatures) return cachedFeatures;
  const research = buildResearchFeatures(SECTOR_COUNT, EXPERT_OBJECT_COUNTS);
  const conference = buildConferenceFeatures(SECTOR_COUNT);
  const refuted = new Set();
  let pending = [...research, ...conference];
  let state = 20260920;
  const selectIndex = (length) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 0x100000000 * length);
  };
  for (let attempt = 0; attempt < 128; attempt += 1) {
    const masks = sampleCandidate(selectIndex, attempt);
    if (!masks) continue;
    pending = pending.filter((feature) => {
      if (researchFeatureValue(feature, masks, SECTOR_COUNT) === 1) return true;
      refuted.add(feature);
      return false;
    });
  }
  cachedFeatures = {
    research: research.filter((feature) => refuted.has(feature)),
    conference: conference.filter((feature) => refuted.has(feature)),
  };
  return cachedFeatures;
}

function certifiedConferences(masks, features, selectIndex) {
  const peers = completeObservationPeers(masks);
  const answer = 1 << peers.findIndex((peer) => peer[Obj.PLANET_X] === masks[Obj.PLANET_X]);
  const seenText = new Set();
  const options = [];
  for (const feature of features) {
    let matchingPeers = 0;
    for (const [index, peer] of peers.entries()) {
      if (researchFeatureValue(feature, peer, SECTOR_COUNT) === 1) matchingPeers |= 1 << index;
    }
    if (!(matchingPeers & answer)) continue;
    const text = researchClueText(feature);
    if (seenText.has(text)) continue;
    seenText.add(text);
    options.push({ feature, matchingPeers });
  }
  let bestScore = -1;
  let pairs = [];
  for (let first = 0; first < options.length; first += 1) {
    for (let second = first + 1; second < options.length; second += 1) {
      const left = options[first];
      const right = options[second];
      if ((left.matchingPeers & right.matchingPeers) !== answer) continue;
      const score = Number(left.matchingPeers !== answer) + Number(right.matchingPeers !== answer);
      if (score > bestScore) {
        bestScore = score;
        pairs = [[left.feature, right.feature]];
      } else if (score === bestScore) pairs.push([left.feature, right.feature]);
    }
  }
  if (!pairs.length) return null;
  return pairs[selectIndex(pairs.length)].map((feature) => ({ feature, value: 1 }));
}

function selectResearch(masks, features, selectIndex) {
  const topics = new Map();
  const tightBands = new Map();
  for (const feature of features) {
    if (researchFeatureValue(feature, masks, SECTOR_COUNT) !== 1) continue;
    if (feature.kind === 'band') {
      if (feature.objectType === Obj.DWARF_PLANET || feature.length > USEFUL_BAND_LENGTH) continue;
      const current = tightBands.get(feature.topicKey);
      if (!current || feature.length < current.length) tightBands.set(feature.topicKey, feature);
      continue;
    }
    if (!topics.has(feature.topicKey)) topics.set(feature.topicKey, []);
    topics.get(feature.topicKey).push(feature);
  }
  for (const [key, feature] of tightBands) topics.set(key, [feature]);
  if (topics.size < 6) return null;
  const bandTopics = [...topics.keys()].filter((key) => topics.get(key)[0].kind === 'band');
  const relationTopics = [...topics.keys()].filter((key) => topics.get(key)[0].kind === 'relation');
  const bandCount = Math.min(2, bandTopics.length);
  const research = [];
  for (let index = 0; index < 6; index += 1) {
    const available = index < bandCount ? bandTopics : relationTopics;
    if (!available.length) return null;
    const [key] = available.splice(selectIndex(available.length), 1);
    const choices = topics.get(key);
    research.push([{ feature: choices[selectIndex(choices.length)], value: 1 }]);
  }
  for (let index = research.length - 1; index > 0; index -= 1) {
    const selected = selectIndex(index + 1);
    [research[index], research[selected]] = [research[selected], research[index]];
  }
  return research;
}

export function createExpertDefinition(selectIndex, { maxAttempts = MAX_ATTEMPTS } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS}.`);
  }
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const masks = sampleCandidate(selectIndex, attempt);
    if (!masks) continue;
    const features = featuresWithCounterexamples();
    const conferences = certifiedConferences(masks, features.conference, selectIndex);
    if (!conferences) continue;
    const research = selectResearch(masks, features.research, selectIndex);
    if (!research) continue;
    const objects = Array.from({ length: SECTOR_COUNT }, (unused, sector) => (
      Object.keys(EXPERT_OBJECT_COUNTS).find((objectType) => masks[objectType] & (1 << sector))
    ));
    return { objects, research, conferences: { 7: conferences[0], 16: conferences[1] } };
  }
  throw new Error(`Unable to generate a certified expert puzzle within ${maxAttempts} attempts.`);
}

export function countExpertSolutions(constraints, initialClues, { limit = Infinity, maxNodes = DEFAULT_MAX_NODES } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new RangeError('maxNodes must be a positive safe integer.');
  const objectTypes = [Obj.DWARF_PLANET, Obj.COMET, Obj.ASTEROID, Obj.GAS_CLOUD, Obj.PLANET_X];
  const excluded = Object.fromEntries(objectTypes.map((objectType) => [objectType, 0]));
  for (const { sector, objectType } of initialClues) excluded[objectType] |= 1 << sector;
  const groups = placements();
  const choices = objectTypes.slice(0, -1).map((objectType) => groups[objectType].filter((mask) => !(mask & excluded[objectType])));
  const stagedConstraints = objectTypes.map(() => []);
  for (const constraint of constraints) {
    const { feature } = constraint;
    const stage = Math.max(objectTypes.indexOf(feature.objectType), feature.kind === 'band' ? -1 : objectTypes.indexOf(feature.neighborType));
    stagedConstraints[stage].push(constraint);
  }
  const masks = {};
  let count = 0;
  let visited = 0;
  function visit(stage, occupied) {
    const objectType = objectTypes[stage];
    const available = stage === objectTypes.length - 1
      ? singleBits((FULL_MASK ^ occupied) & ~adjacentMask(masks[Obj.DWARF_PLANET]))
      : choices[stage];
    for (const mask of available) {
      visited += 1;
      if (visited > maxNodes) throw new RangeError('Expert solution search exceeded maxNodes; add observations or raise the debug budget. No exact count was returned.');
      if (mask & occupied) continue;
      masks[objectType] = mask;
      if (!stagedConstraints[stage].every((constraint) => researchFeatureValue(constraint.feature, masks, SECTOR_COUNT) === constraint.value)) continue;
      if (objectType === Obj.PLANET_X) {
        masks[Obj.EMPTY] = FULL_MASK ^ (occupied | mask);
        if (masks[Obj.GAS_CLOUD] & ~adjacentMask(masks[Obj.EMPTY])) continue;
        count += 1;
      } else {
        visit(stage + 1, occupied | mask);
      }
      if (count >= limit) return;
    }
  }
  visit(0, 0);
  return count;
}
