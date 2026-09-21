import { Obj, LABEL } from '../public/src/types.js';

const RESEARCH_TYPES = [Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET];

function relationFeatures(sectorCount, objectType, neighborType, topicKey) {
  const relations = [{ relation: 'adjacent' }, { relation: 'opposite' }];
  for (let range = 2; range < sectorCount / 2; range += 1) {
    relations.push({ relation: 'within', range });
  }
  return relations.flatMap((relation) => ['none', 'some', 'all'].map((quantifier) => ({
    kind: 'relation',
    objectType,
    neighborType,
    topicKey,
    ...relation,
    quantifier,
  })));
}

export function buildResearchFeatures(sectorCount, objectCounts) {
  const features = [];
  for (const objectType of RESEARCH_TYPES) {
    const count = objectCounts[objectType];
    if (count > 1) {
      for (let length = count; length < sectorCount; length += 1) {
        features.push({ kind: 'band', objectType, topicKey: objectType, length });
      }
    }
    for (const neighborType of RESEARCH_TYPES) {
      if (neighborType === objectType) continue;
      const topicKey = RESEARCH_TYPES.filter((type) => type === objectType || type === neighborType).join('|');
      features.push(...relationFeatures(sectorCount, objectType, neighborType, topicKey));
    }
  }
  return features;
}

export function buildConferenceFeatures(sectorCount) {
  return RESEARCH_TYPES.flatMap((objectType) => {
    const topicKey = `${objectType}|${Obj.PLANET_X}`;
    return [
      ...relationFeatures(sectorCount, Obj.PLANET_X, objectType, topicKey),
      ...relationFeatures(sectorCount, objectType, Obj.PLANET_X, topicKey),
    ];
  });
}

function rotateMask(mask, distance, sectorCount) {
  const fullMask = (1 << sectorCount) - 1;
  return ((mask << distance) | (mask >>> (sectorCount - distance))) & fullMask;
}

export function researchFeatureValue(feature, masks, sectorCount) {
  const objectMask = masks[feature.objectType] ?? 0;
  if (feature.kind === 'band') {
    let bandMask = (1 << feature.length) - 1;
    for (let start = 0; start < sectorCount; start += 1) {
      if ((objectMask & ~bandMask) === 0) return 1;
      bandMask = rotateMask(bandMask, 1, sectorCount);
    }
    return 0;
  }

  const neighborMask = masks[feature.neighborType] ?? 0;
  let relatedMask;
  switch (feature.relation) {
    case 'adjacent':
      relatedMask = rotateMask(neighborMask, 1, sectorCount)
        | rotateMask(neighborMask, sectorCount - 1, sectorCount);
      break;
    case 'opposite':
      relatedMask = rotateMask(neighborMask, sectorCount / 2, sectorCount);
      break;
    case 'within':
      relatedMask = neighborMask;
      for (let distance = 1; distance <= feature.range; distance += 1) {
        relatedMask |= rotateMask(neighborMask, distance, sectorCount)
          | rotateMask(neighborMask, sectorCount - distance, sectorCount);
      }
      break;
    default:
      throw new Error('Unknown research relation.');
  }

  const matchingMask = objectMask & relatedMask;
  switch (feature.quantifier) {
    case 'none': return Number(matchingMask === 0);
    case 'some': return Number(matchingMask !== 0);
    case 'all': return Number((objectMask & ~relatedMask) === 0);
    default: throw new Error('Unknown research quantifier.');
  }
}

export function researchTopicName(feature) {
  return RESEARCH_TYPES.filter((objectType) => (
    objectType === feature.objectType || (feature.kind === 'relation' && objectType === feature.neighborType)
  )).map((objectType) => LABEL[objectType]).join('和');
}

export function conferenceTopicName(feature) {
  return `${LABEL[Obj.PLANET_X]}和${researchTopicName(feature)}`;
}

export function researchClueText(feature) {
  const object = LABEL[feature.objectType];
  if (feature.kind === 'band') {
    return `所有${object}都位于一段不超过 ${feature.length} 个连续扇区内。`;
  }
  const neighbor = LABEL[feature.neighborType];
  const relation = feature.relation === 'adjacent' ? '相邻' : '正对';
  if (feature.objectType === Obj.PLANET_X) {
    if (feature.relation === 'within') {
      return feature.quantifier === 'none'
        ? `X行星不在任何${neighbor}的 ${feature.range} 个扇区以内。`
        : `X行星位于至少一个${neighbor}的 ${feature.range} 个扇区以内。`;
    }
    return feature.quantifier === 'none'
      ? `X行星不与任何${neighbor}${relation}。`
      : `X行星与至少一个${neighbor}${relation}。`;
  }
  const someNeighbor = feature.neighborType === Obj.PLANET_X ? neighbor : `某个${neighbor}`;
  const allNeighbor = feature.neighborType === Obj.PLANET_X ? neighbor : `至少一个${neighbor}`;
  if (feature.relation === 'within') {
    if (feature.quantifier === 'none') return `没有任何${object}位于${neighbor}的 ${feature.range} 个扇区以内。`;
    if (feature.quantifier === 'some') return `至少有一个${object}位于${someNeighbor}的 ${feature.range} 个扇区以内。`;
    return `每个${object}都位于${allNeighbor}的 ${feature.range} 个扇区以内。`;
  }
  if (feature.quantifier === 'none') return `没有任何${object}与${neighbor}${relation}。`;
  if (feature.quantifier === 'some') return `至少有一个${object}与${someNeighbor}${relation}。`;
  return `每个${object}都与${allNeighbor}${relation}。`;
}
