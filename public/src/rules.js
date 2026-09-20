export const TIME_UNITS_PER_SHIFT = 1;

export const MODES = Object.freeze({
  standard: Object.freeze({ id: 'standard', name: '标准模式', sectors: 12, visible: 6 }),
  expert: Object.freeze({ id: 'expert', name: '专家模式', sectors: 18, visible: 9 }),
});

/** The modes in the order the pickers offer them. */
export const MODE_LIST = Object.freeze([MODES.standard, MODES.expert]);

/** Never hand out an undefined mode: an unknown id falls back to the standard board. */
export function modeById(id) {
  return MODES[id] || MODES.standard;
}

/**
 * Standard (12 sectors): the Planet X conference sits on sector 10, and the four
 * research/theory phases on sectors 3, 6, 9 and 12.
 * Expert (18 sectors): conferences on 7 and 16, theory phases on 3, 6, 9, 12, 15, 18.
 */
export const EVENT_SECTORS = Object.freeze({
  standard: Object.freeze({ conferences: Object.freeze([10]), theory: Object.freeze([3, 6, 9, 12]) }),
  expert: Object.freeze({ conferences: Object.freeze([7, 16]), theory: Object.freeze([3, 6, 9, 12, 15, 18]) }),
});

export function conferenceSectors(mode) {
  return EVENT_SECTORS[mode.id].conferences;
}

export function theorySectors(mode) {
  return EVENT_SECTORS[mode.id].theory;
}

/** One line the UI can print: where this board puts the conference and the theory phases. */
export function eventSummary(mode) {
  return `X行星会议在第 ${conferenceSectors(mode).join('、')} 扇区，学术研究在第 ${theorySectors(mode).join('、')} 扇区。`;
}

/** Number of peer-review slots a published theory travels before it is reviewed. */
export const THEORY_TRACK = Object.freeze([4, 3, 2, 1]);

/**
 * End-of-game scoring.
 *
 * A paper is placed on space 4 and the whole track steps forward once a research phase
 * is over (`advanceTheoryTrack` in console.js), so papers published in one round share a
 * space. A confirmed theory is worth its object's points, and the first player to have a
 * *correct* theory about a sector takes the leader bonus for that sector.
 */
export const THEORY_POINTS = Object.freeze({
  asteroid: 2,
  comet: 3,
  gasCloud: 4,
  dwarfPlanet: 4,
});

/** Expert boards hold four dwarf planets, so a dwarf-planet theory pays less. */
export const THEORY_POINTS_EXPERT = Object.freeze({ ...THEORY_POINTS, dwarfPlanet: 2 });

/** +1 for every sector where you were the first to publish a correct theory. */
export const LEADER_BONUS = 1;

export const LOCATE_POINTS = Object.freeze({ first: 10, perSectorBehind: 2 });

export function theoryPointsFor(mode, objectType) {
  const table = mode && mode.id === 'expert' ? THEORY_POINTS_EXPERT : THEORY_POINTS;
  return table[objectType] || 0;
}

/** Points a correct locate is worth, given how far behind the first finder it happened. */
export function locatePointsFor(sectorsBehind) {
  return LOCATE_POINTS.perSectorBehind * Math.max(0, Math.min(5, sectorsBehind));
}

export const COST = Object.freeze({
  target: 4, // 扫描
  research: 1, // 研究
  locate: 5, // 定位
  wait: 1,
  theory: 0, // 提交学术研究不花时间
  conference: 0, // 会议不花时间
});

export function surveyCost(size) {
  if (size <= 3) return 4;
  if (size <= 6) return 3;
  if (size <= 9) return 2;
  return Infinity;
}

export function cometSectors(mode) {
  return mode.id === 'expert' ? [2, 3, 5, 7, 11, 13, 17] : [2, 3, 5, 7, 11];
}

export const MAX_TARGET_USES = 2;

export function mod(i, n) {
  return ((i % n) + n) % n;
}

export function arcSectors(start, length, n) {
  const out = [];
  for (let k = 0; k < length; k++) out.push(mod(start + k, n));
  return out;
}

export function visibleStartAt(time, mode) {
  return mod(Math.floor(time / TIME_UNITS_PER_SHIFT), mode.sectors);
}

export function visibleSectorsAt(time, mode) {
  const start = visibleStartAt(time, mode);
  const out = [];
  for (let k = 0; k < mode.visible; k++) out.push(mod(start + k, mode.sectors));
  return out;
}

export function isVisible(time, mode, sector) {
  return visibleSectorsAt(time, mode).includes(sector);
}

/** The 1-based sector the sky window currently starts at — the time track arrow. */
export function arrowSector(mode, time) {
  return visibleStartAt(time, mode) + 1;
}

export function eventsAt(mode, time) {
  const sector = arrowSector(mode, time);
  const conferences = conferenceSectors(mode);
  const theory = theorySectors(mode);
  return {
    sector,
    conference: conferences.includes(sector),
    conferenceIndex: conferences.indexOf(sector),
    theory: theory.includes(sector),
    theoryIndex: theory.indexOf(sector),
  };
}

export function timeParts(units, mode = MODES.standard) {
  const safe = Math.max(0, units);
  return { lap: Math.floor(safe / mode.sectors) + 1, step: (safe % mode.sectors) + 1 };
}

export function timeLabel(units, mode = MODES.standard) {
  const { lap, step } = timeParts(units, mode);
  return `第 ${lap} 圈／第 ${step} 格`;
}

export function timeShort(units, mode = MODES.standard) {
  return timeLabel(units, mode);
}

export function durationLabel(units) {
  return `${units} 个时间单位`;
}

export const yearsLabel = durationLabel;

/** Base rules of the standard board, shown in the reference panel. */
export const BASE_RULE_TEXT = Object.freeze([
  '彗星共 2 颗，只出现在质数编号的扇区（2、3、5、7、11）。',
  '小行星共 4 颗，每颗都至少与另一颗小行星相邻。',
  '气体云共 2 个，每个都至少与一个真正空域的扇区相邻。',
  '真正空域的扇区共 2 个。',
  '矮行星从不与 X行星相邻。',
  'X行星只有 1 颗，且它在勘测与扫描中都会被显示为“空域”。',
]);

export const BASE_RULE_TEXT_EXPERT = Object.freeze([
  '彗星共 2 颗，只出现在质数编号的扇区（2、3、5、7、11、13、17）。',
  ...BASE_RULE_TEXT.slice(1, 3),
  '真正空域的扇区共 5 个。',
  BASE_RULE_TEXT[4],
  BASE_RULE_TEXT[5],
  '矮行星共 4 颗，全部位于恰好 6 个扇区组成的带状区域内，且带的两端都是矮行星。',
]);

export function baseRuleText(mode) {
  return mode.id === 'standard' ? BASE_RULE_TEXT : BASE_RULE_TEXT_EXPERT;
}
