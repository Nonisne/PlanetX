// Expert-board dwarf-planet band helper. Pure note arithmetic — never solves the board.
import { CODE } from './types.js';
import { mod } from './rules.js';

export const EXPERT_DWARF_BAND_SIZE = 6;
export const EXPERT_DWARF_COUNT = 4;

export const DWARF_BELT_HINT_TEXT = Object.freeze([
  '专家盘的 4 颗矮行星全部落在恰好 6 个连续扇区组成的带内，且带的两端都必须是矮行星。',
  '带可以跨越 18 与 1；带外不能再有矮行星。根据你的手写标注，下面列出仍可能成立的带。',
  '辅助提示不会替你填答案，也不会排除官方 app 尚未给出的可能性。',
]);

/** @returns {'yes'|'no'|'maybe'} */
export function dwarfNoteState(notes, sector) {
  const value = notes?.[`${sector}:${CODE.dwarfPlanet}`];
  return value === 'yes' || value === 'no' ? value : 'maybe';
}

export function bandSectors(start, sectorCount = 18, size = EXPERT_DWARF_BAND_SIZE) {
  const out = [];
  for (let offset = 0; offset < size; offset++) out.push(mod(start + offset, sectorCount));
  return out;
}

/**
 * Why a candidate band is impossible given the player's dwarf marks, or null if still possible.
 */
export function dwarfBandConflict(notes, start, sectorCount = 18) {
  const sectors = bandSectors(start, sectorCount);
  const inside = new Set(sectors);
  const endpoints = [sectors[0], sectors[sectors.length - 1]];
  let yesInside = 0;
  let noInside = 0;

  for (let sector = 0; sector < sectorCount; sector++) {
    const mark = dwarfNoteState(notes, sector);
    if (inside.has(sector)) {
      if (mark === 'yes') yesInside += 1;
      if (mark === 'no') noInside += 1;
    } else if (mark === 'yes') {
      return `${sector + 1} 号已确定有矮行星，不能落在带外`;
    }
  }

  for (const endpoint of endpoints) {
    if (dwarfNoteState(notes, endpoint) === 'no') {
      return `${endpoint + 1} 号是带的端点，不能标记为没有矮行星`;
    }
  }

  if (yesInside > EXPERT_DWARF_COUNT) return `带内已确定 ${yesInside} 颗矮行星，超过 4 颗`;
  if (sectors.length - noInside < EXPERT_DWARF_COUNT) {
    return `带内排除后最多还能放下 ${sectors.length - noInside} 颗矮行星，不足 4 颗`;
  }
  return null;
}

/** Remaining expert bands that still fit the player's dwarf yes/no marks. */
export function possibleDwarfBands(notes, sectorCount = 18) {
  const bands = [];
  for (let start = 0; start < sectorCount; start++) {
    const conflict = dwarfBandConflict(notes, start, sectorCount);
    if (conflict) continue;
    const sectors = bandSectors(start, sectorCount);
    bands.push({
      start,
      sectors,
      endpoints: [sectors[0], sectors[sectors.length - 1]],
      label: `${sectors[0] + 1}–${sectors[sectors.length - 1] + 1}`,
    });
  }
  return bands;
}

/** Sectors that still appear in at least one remaining band. */
export function dwarfBandCoverage(notes, sectorCount = 18) {
  const coverage = new Map();
  for (const band of possibleDwarfBands(notes, sectorCount)) {
    for (const sector of band.sectors) {
      coverage.set(sector, (coverage.get(sector) || 0) + 1);
    }
  }
  return coverage;
}
