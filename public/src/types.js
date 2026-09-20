// Object types on the board. Codes are 1..6 so boards fit in a Uint8Array.
export const Obj = Object.freeze({
  COMET: 'comet',
  ASTEROID: 'asteroid',
  GAS_CLOUD: 'gasCloud',
  DWARF_PLANET: 'dwarfPlanet',
  EMPTY: 'empty', // "truly empty" sector
  PLANET_X: 'planetX',
});

export const CODE = Object.freeze({
  comet: 1,
  asteroid: 2,
  gasCloud: 3,
  dwarfPlanet: 4,
  empty: 5,
  planetX: 6,
});

export const CODE_TO_TYPE = Object.freeze([
  null,
  Obj.COMET,
  Obj.ASTEROID,
  Obj.GAS_CLOUD,
  Obj.DWARF_PLANET,
  Obj.EMPTY,
  Obj.PLANET_X,
]);

export const LABEL = Object.freeze({
  [Obj.PLANET_X]: 'X行星',
  [Obj.ASTEROID]: '小行星',
  [Obj.COMET]: '彗星',
  [Obj.GAS_CLOUD]: '气体云',
  [Obj.DWARF_PLANET]: '矮行星',
  [Obj.EMPTY]: '空域',
});

export const SHORT = Object.freeze({
  [Obj.PLANET_X]: 'X',
  [Obj.ASTEROID]: '小',
  [Obj.COMET]: '彗',
  [Obj.GAS_CLOUD]: '气',
  [Obj.DWARF_PLANET]: '矮',
  [Obj.EMPTY]: '空',
});

// What a survey/target reports for a sector.
export function apparentType(type) {
  return type === Obj.PLANET_X ? Obj.EMPTY : type;
}

/**
 * The Chinese name of an object, whether you hand it a type key ('comet') or a numeric
 * code (1). Log entries keep keys but the locate record keeps codes, and an old save
 * may hold either.
 */
export function labelOf(value) {
  if (value === undefined || value === null) return '';
  return LABEL[value] || LABEL[CODE_TO_TYPE[value]] || String(value);
}

export function apparentCode(code) {
  return code === CODE.planetX ? CODE.empty : code;
}

// You can survey for these; Planet X is NOT an option (it looks empty).
export const SURVEY_TYPES = Object.freeze([
  Obj.ASTEROID,
  Obj.COMET,
  Obj.GAS_CLOUD,
  Obj.DWARF_PLANET,
  Obj.EMPTY,
]);

export const INITIAL_CLUE_TYPES = Object.freeze([
  Obj.ASTEROID,
  Obj.COMET,
  Obj.GAS_CLOUD,
  Obj.DWARF_PLANET,
]);

/**
 * What a published theory may claim. "Truly empty" is not on the list: an empty-looking
 * sector may be Planet X itself, so the game never lets you publish that claim.
 */
export const THEORY_TYPES = Object.freeze([Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET]);

// Rows of the note sheet, most interesting first.
export const NOTE_ROWS = Object.freeze([
  Obj.PLANET_X,
  Obj.ASTEROID,
  Obj.COMET,
  Obj.GAS_CLOUD,
  Obj.DWARF_PLANET,
  Obj.EMPTY,
]);
