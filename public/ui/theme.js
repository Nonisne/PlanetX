// Shared visual constants for the star map, note sheet and panels.
import { CODE } from '../src/types.js';

export const TYPE_COLOR = Object.freeze({
  [CODE.planetX]: '#ff5f7e',
  [CODE.asteroid]: '#f5b942',
  [CODE.comet]: '#4dd0ff',
  [CODE.gasCloud]: '#a78bfa',
  [CODE.dwarfPlanet]: '#5eead4',
  [CODE.empty]: '#7c8aa5',
});

// Kept for compact text fallbacks (tooltips, log lines).
export const SHORT_BY_CODE = Object.freeze({
  [CODE.planetX]: 'X',
  [CODE.asteroid]: '小',
  [CODE.comet]: '彗',
  [CODE.gasCloud]: '气',
  [CODE.dwarfPlanet]: '矮',
  [CODE.empty]: '空',
});
