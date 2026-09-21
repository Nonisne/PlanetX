// The circular star map: sectors, the rotating visible sky window, the time-track
// event markers and the player's own marks.
import { s } from './dom.js';
import { CODE, CODE_TO_TYPE, LABEL } from '../src/types.js';
import { durationLabel, isCometSector, mod, timeShort, visibleSectorsAt, visibleStartAt } from '../src/rules.js';
import { iconAt } from './icons.js';
import { TYPE_COLOR } from './theme.js';
import { tutorialExpected, tutorialFocusProps } from './tutorial.js';

export { TYPE_COLOR, SHORT_BY_CODE } from './theme.js';

const CX = 280;
const CY = 280;
const R_OUTER = 244;
const R_INNER = 112;
const R_EARTH_ORBIT = 94;
const EARTH_RADIUS = 14;
const R_NUMBER = 237;
const R_MARK = 216;
const R_DOTS = 166;
const R_EVENT = 269;
/** Player pawns sit outside the event glyphs, on the very edge of the ring. */
const R_PAWN = 291;
const PAWN_SIZE = 8.5;
const PAD_DEG = 1.1;

const MARK_SIZE = 28;
const DOT_SIZE = 21;
const COL_PITCH = 24;
const ROW_PITCH = 24;
const EVENT_SIZE = 17;

export const EVENT_COLOR = Object.freeze({ conference: '#f5b942', theory: '#a78bfa' });

export function pendingUiEvents(game) {
  if (game.status !== 'open' || (game.phase && game.phase !== 'play') || game.awaitingReview?.length) return { theory: null, conference: null };
  const theory = game.research || (!game.phase && game.theoryPhaseOpen ? game.theoryPhase || null : null);
  let conference = game.conference || null;
  if (!game.phase && !conference) {
    const progress = game.windowTime ?? game.time ?? 0;
    const recorded = new Set((game.knowledge?.conferences || []).map((entry) => entry.sector));
    const sector = (game.conferenceSectors || []).find((marker) => progress >= marker && !recorded.has(marker) && (!theory || theory.time > marker));
    if (sector !== undefined) conference = { sector };
  }
  return { theory, conference };
}

/** Small glyphs for the two kinds of time-track events (conference / theory phase). */
export function eventGlyph(kind, cx, cy, size, { active = false } = {}) {
  const g = s('g', { class: `event-marker event-${kind}${active ? ' active' : ''}` });
  const color = EVENT_COLOR[kind];
  const half = size / 2;
  if (active) g.append(s('circle', { cx, cy, r: half + 4, class: 'event-halo', stroke: color }));
  if (kind === 'conference') {
    // speech bubble with a tail
    g.append(
      s('rect', { x: cx - half, y: cy - half + 1, width: size, height: size - 5, rx: 3.5, fill: color }),
      s('path', { d: `M${cx - 2} ${cy + half - 4} L${cx - 5.5} ${cy + half + 2} L${cx + 2.5} ${cy + half - 4} Z`, fill: color }),
    );
  } else {
    // document with two lines
    g.append(
      s('rect', { x: cx - half + 1, y: cy - half, width: size - 2, height: size, rx: 3, fill: color }),
      s('path', {
        d: `M${cx - half + 4} ${cy - 3} H${cx + half - 4} M${cx - half + 4} ${cy + 1} H${cx + half - 4} M${cx - half + 4} ${cy + 5} H${cx + 1}`,
        stroke: 'rgba(9,14,28,0.75)',
        'stroke-width': 1.6,
        'stroke-linecap': 'round',
        fill: 'none',
      }),
    );
  }
  return g;
}

// Fixed slot for every object type: two columns of three, same order as the note
// sheet rows, so an icon never moves when the candidate set changes.
const SLOT_ORDER = [CODE.planetX, CODE.asteroid, CODE.comet, CODE.gasCloud, CODE.dwarfPlanet, CODE.empty];
const SLOT_COL = [0, 0, 0, 1, 1, 1];
const SLOT_ROW = [0, 1, 2, 0, 1, 2];

function slotOffset(slot) {
  return {
    dx: (SLOT_COL[slot] ? 1 : -1) * (COL_PITCH / 2),
    dy: (SLOT_ROW[slot] - 1) * ROW_PITCH,
  };
}

function polar(r, deg) {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function earthGlyph(horizontal, vertical, label) {
  return s(
    'g',
    { class: 'earth-marker', transform: `translate(${horizontal} ${vertical})`, role: 'img', 'aria-label': label },
    s('title', {}, label),
    s('circle', { r: EARTH_RADIUS, class: 'earth-atmosphere' }),
    s('circle', { r: 12, class: 'earth-ocean' }),
    s('path', { d: 'M -6 -9 L -1 -10 L 2 -7 L 1 -3 L -3 -1 L -2 3 L -5 5 L -8 1 L -9 -4 Z M 5 0 L 9 2 L 8 7 L 3 10 L 1 6 L 3 3 Z', class: 'earth-land' }),
    s('path', { d: 'M -7 -4 Q -1 -8 5 -5 M -1 8 Q 4 6 8 5', class: 'earth-clouds' }),
  );
}

function wedgePath(r0, r1, a0, a1) {
  const [x0, y0] = polar(r1, a0);
  const [x1, y1] = polar(r1, a1);
  const [x2, y2] = polar(r0, a1);
  const [x3, y3] = polar(r0, a0);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r1} ${r1} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${r0} ${r0} 0 ${large} 0 ${x3} ${y3} Z`;
}

export function sectorAngles(index, n) {
  const step = 360 / n;
  const a0 = -90 - step / 2 + index * step + PAD_DEG;
  const a1 = -90 - step / 2 + (index + 1) * step - PAD_DEG;
  return [a0, a1];
}

// Player marks for one sector: { yes: Set<code>, no: Set<code> }
function marksFor(notes, sector) {
  const yes = new Set();
  const no = new Set();
  if (!notes) return { yes, no };
  for (const [key, value] of Object.entries(notes)) {
    const [sec, code] = key.split(':').map(Number);
    if (sec !== sector) continue;
    if (value === 'yes') yes.add(code);
    if (value === 'no') no.add(code);
  }
  return { yes, no };
}

/**
 * @param {object} params
 * @param {object} params.game
 * @param {object} params.ui   { mapMode, selectedSector, rangeStart, rangeSize, assist }
 * @param {object} params.notes player marks keyed `${sector}:${code}` -> 'yes'|'no'
 * @param {(sector:number)=>void} params.onSector
 * @param {(sector:number, code:number)=>void} params.onMark
 */
export function renderBoard({ game, ui, notes, onSector, onMark }) {
  const mode = game.mode;
  const n = mode.sectors;
  const dotSize = n === 18 ? 18 : DOT_SIZE;
  // The console never knows the answer, so every slot is a neutral check box the
  // player annotates by hand.
  const visibleList = Array.isArray(game.visible) ? game.visible : visibleSectorsAt(game.time, mode);
  const visibleStart = Number.isInteger(game.visibleStart) ? mod(game.visibleStart, n) : Number.isInteger(visibleList[0]) ? visibleList[0] : visibleStartAt(game.time, mode);
  const isVisibleSector = (sector) => visibleList.includes(sector);
  const targeted = new Map(game.knowledge.targets.map((t) => [t.sector, t.apparent]));
  const expected = tutorialExpected(game);
  const tutorialSectors = new Set();
  if (Number.isInteger(expected?.sector)) tutorialSectors.add(expected.sector);
  if (Number.isInteger(expected?.start) && Number.isInteger(expected?.size)) {
    for (let offset = 0; offset < Math.min(expected.size, mode.sectors); offset += 1) tutorialSectors.add(mod(expected.start + offset, mode.sectors));
  }
  const expectedCode = CODE[expected?.type || expected?.objectType || expected?.surveyType] || expected?.code;

  const possibilities = new Map();
  for (let i = 0; i < n; i++) possibilities.set(i, new Set(SLOT_ORDER));

  const rangeSectors = new Set();
  if (ui.mapMode === 'survey' && ui.rangeStart !== null && ui.rangeStart !== undefined) {
    const size = Math.min(ui.rangeSize, mode.visible);
    for (let k = 0; k < size; k++) rangeSectors.add(mod(ui.rangeStart + k, n));
  }
  // sectors picked on the map for the action in progress (survey start/end, scan target)
  const picked = Array.isArray(ui.pick) ? ui.pick : [];
  for (const sector of picked) rangeSectors.add(sector);

  const root = s('svg', { viewBox: `0 0 ${CX * 2} ${CY * 2}`, class: 'starmap', role: game.tutorial ? 'group' : 'img', 'aria-label': '星图与公共时间轨', ...tutorialFocusProps(game, game.tutorial?.focus === 'timeline' ? 'timeline' : 'map') });

  // rotating visible sky window
  const [wa0] = sectorAngles(visibleStart, n);
  const [, wa1] = sectorAngles(mod(visibleStart + mode.visible - 1, n), n);
  root.append(s('path', { d: wedgePath(R_OUTER + 5, R_OUTER + 16, wa0, wa1), class: 'window-band' }));

  // time-track events: the sectors where a conference / theory phase happens
  const confSectors = Array.isArray(game.conferenceSectors) ? game.conferenceSectors : [];
  const theo = Array.isArray(game.theorySectors) ? game.theorySectors : [];
  const pendingEvents = pendingUiEvents(game);
  for (const [kind, list] of [
    ['conference', confSectors],
    ['theory', theo],
  ]) {
    for (const sector of list) {
      const [a] = sectorAngles(sector - 1, n);
      const [, aEnd] = sectorAngles(sector - 1, n);
      const [ex, ey] = polar(R_EVENT, (a + aEnd) / 2);
      const glyph = eventGlyph(kind, ex, ey, EVENT_SIZE, { active: pendingEvents[kind]?.sector === sector });
      glyph.append(s('title', {}, `天窗起点离开 ${sector} 号事件标记（${sector}→${mod(sector, n) + 1} 号）时触发${kind === 'conference' ? '会议' : '学术研究'}`));
      root.append(glyph);
    }
  }

  for (let i = 0; i < n; i++) {
    const [a0, a1] = sectorAngles(i, n);
    const g = s('g', { class: `sector${isVisibleSector(i) ? ' visible' : ''}`, 'data-sector': i });

    const revealedCode = CODE[targeted.get(i)] || targeted.get(i);
    const revealed = revealedCode === CODE.comet && !isCometSector(mode, i) ? null : revealedCode;
    const canPick = !['survey', 'scan'].includes(ui.action) || (isVisibleSector(i) && (ui.action !== 'survey' || ui.surveyType !== 'comet' || isCometSector(mode, i)));
    const fill = revealed ? TYPE_COLOR[revealed] : null;
    const tutorialTarget = tutorialSectors.has(i);
    const sectorLabel = `${i + 1} 号扇区${isVisibleSector(i) ? '（可见）' : '（当前不可见）'}${tutorialTarget ? ' · 教学目标' : ''}`;
    const path = s('path', {
      d: wedgePath(R_INNER, R_OUTER, a0, a1),
      class: ['wedge', isVisibleSector(i) ? 'visible' : 'hidden', ui.selectedSector === i ? 'selected' : '', rangeSectors.has(i) ? 'in-range' : '', canPick ? '' : 'unavailable', tutorialTarget ? 'tutorial-target' : '']
        .filter(Boolean)
        .join(' '),
      fill: fill || undefined,
      'fill-opacity': fill ? 0.34 : undefined,
      'aria-disabled': canPick ? null : 'true',
      'data-tutorial-target': tutorialTarget ? 'sector' : null,
      'aria-describedby': tutorialTarget ? 'tutorial-instruction' : null,
      'aria-label': tutorialTarget ? sectorLabel : null,
      role: tutorialTarget ? 'button' : null,
      tabindex: tutorialTarget && canPick ? 0 : null,
      onkeydown: tutorialTarget && canPick ? event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSector?.(i);
        }
      } : null,
      onclick: canPick ? () => onSector(i) : null,
    });
    path.append(s('title', {}, sectorLabel));
    g.append(path);

    const mid = (a0 + a1) / 2;
    const [tx, ty] = polar(R_NUMBER, mid);
    g.append(s('text', { x: tx, y: ty, class: 'sector-number', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, String(i + 1)));

    const marks = marksFor(notes, i);

    const [mx, my] = polar(R_DOTS, mid);
    const turn = ((mid - 90) * Math.PI) / 180;
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    SLOT_ORDER.forEach((code, slot) => {
      if (code === CODE.comet && !isCometSector(mode, i)) return;
      const markState = marks.yes.has(code) ? 'yes' : marks.no.has(code) ? 'no' : 'none';
      const visual = markState === 'yes' ? 'yes' : markState === 'no' ? 'no' : 'possible';
      const { dx, dy } = slotOffset(slot);
      // rotate the fixed slot offset into the sector's own frame
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      const stateText = markState === 'yes' ? '你已确定存在' : markState === 'no' ? '你已标记不存在' : '可能存在';
      const tutorialMark = game.tutorial?.interaction === 'mark' && expected?.sector === i && expectedCode === code;
      const markIcon = iconAt(code, dotSize, mx + rx, my + ry, {
        halo: markState === 'yes',
        struck: markState === 'no',
        className: `poss-icon state-${visual} mark-${markState}${tutorialMark ? ' tutorial-target' : ''}`,
        title: `${i + 1} 号扇区 · ${LABEL[CODE_TO_TYPE[code]]}（${stateText}，点击标注）`,
        onclick: onMark ? () => onMark(i, code) : null,
      });
      if (tutorialMark) {
        markIcon.setAttribute('data-tutorial-target', 'object');
        markIcon.setAttribute('aria-describedby', 'tutorial-instruction');
        markIcon.setAttribute('aria-label', `${i + 1} 号扇区 · ${LABEL[CODE_TO_TYPE[code]]} · 教学标注目标`);
        markIcon.setAttribute('role', 'button');
        markIcon.setAttribute('tabindex', '0');
        markIcon.addEventListener('keydown', event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onMark?.(i, code);
          }
        });
      }
      g.append(markIcon);
    });

    if (revealed) {
      const [rx, ry] = polar(R_MARK, mid);
      g.append(iconAt(revealed, MARK_SIZE, rx, ry, { className: 'revealed-icon' }));
    }

    root.append(g);
  }

  const players = Array.isArray(game.players) ? game.players : [];
  if (players.length) {
    const bySector = new Map();
    for (const p of players) {
      const sector = Number.isInteger(p.sector) ? p.sector - 1 : 0;
      if (!bySector.has(sector)) bySector.set(sector, []);
      bySector.get(sector).push(p);
    }
    for (const [sector, group] of bySector) {
      const [a0, a1] = sectorAngles(sector, n);
      const list = group
        .slice()
        .sort((a, b) => (a.arrival || 0) - (b.arrival || 0) || (a.joinIndex || 0) - (b.joinIndex || 0));
      const count = list.length;
      const span = a1 - a0;
      const pad = Math.min(5, span / (count + 1) / 2);
      const size = Math.max(4.2, Math.min(PAWN_SIZE, (span * Math.PI / 180) * R_PAWN / (count * 2.4)));
      const slots = [];
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0.5 : (i + 0.5) / count;
        const deg = a0 + pad + (span - 2 * pad) * t;
        const [sx, sy] = polar(R_PAWN, deg);
        slots.push({ deg, x: sx, y: sy });
      }
      list.forEach((p, index) => {
        const [px, py] = polar(R_PAWN, slots[index].deg);
        const g = s('g', {
          class: `pawn${p.isMe ? ' me' : ''}${p.isTurn ? ' turn' : ''}`,
          'data-player': p.id,
        });
        g.append(s('circle', { cx: px, cy: py, r: size, fill: p.color, class: 'pawn-dot' }));
        if (size >= 6.5) {
          g.append(
            s(
              'text',
              { x: px, y: py + 0.5, class: 'pawn-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' },
              p.name.slice(0, 1),
            ),
          );
        }
        g.append(
          s(
            'title',
            {},
            `${p.name}：第 ${p.sector} 号扇区（已用 ${durationLabel(p.time)}）${p.isTurn ? ' · 现在轮到 TA（天窗跟着 TA 走）' : ''}${p.pendingReviews ? ' · 有待评审的理论' : ''}`,
          ),
        );
        root.append(g);
      });
    }
  }

  const hub = s('g', { class: 'hub' });
  hub.append(s('circle', { cx: CX, cy: CY, r: R_INNER - 10, class: 'hub-disc' }));
  hub.append(s('circle', { cx: CX, cy: CY, r: R_EARTH_ORBIT, class: 'earth-orbit', 'aria-hidden': 'true' }));
  hub.append(s('circle', { cx: CX, cy: CY, r: 36, class: 'sun' }));
  hub.append(s('text', { x: CX, y: CY - 46, class: 'hub-time', 'text-anchor': 'middle', textLength: 98, lengthAdjust: 'spacingAndGlyphs' }, timeShort(game.time, mode)));
  hub.append(
    s(
      'text',
      { x: CX, y: CY + 60, class: 'hub-hint', 'text-anchor': 'middle' },
      ui.action === 'survey'
        ? picked.length === 0
          ? '勘测：点起点'
          : picked.length === 1
            ? '勘测：再点终点'
            : '勘测：范围已选好'
        : ui.action === 'scan'
          ? '扫描：点扇区'
          : ui.mapMode === 'survey'
            ? '点空白勘测'
            : '地球朝向可见天区',
    ),
  );
  const earthAngle = -90 + (visibleStart + (mode.visible - 1) / 2) * 360 / n;
  const [earthHorizontal, earthVertical] = polar(R_EARTH_ORBIT, earthAngle);
  const visibleEnd = mod(visibleStart + mode.visible - 1, n);
  hub.append(earthGlyph(earthHorizontal, earthVertical, `地球（示意）：朝向可见天区 ${visibleStart + 1}–${visibleEnd + 1} 号，随公共天窗移动而公转`));
  root.append(hub);

  return root;
}

/** Geometry constants, exported so tests can check that nothing overlaps. */
export const GEOMETRY = Object.freeze({
  CX,
  CY,
  R_OUTER,
  R_INNER,
  R_EARTH_ORBIT,
  EARTH_RADIUS,
  R_NUMBER,
  R_MARK,
  R_DOTS,
  R_EVENT,
  R_PAWN,
  PAWN_SIZE,
  EVENT_SIZE,
  MARK_SIZE,
  DOT_SIZE,
  COL_PITCH,
  ROW_PITCH,
});

/** Anchor point (percent of the view box) of a sector's icon cluster, for HTML popovers. */
export function sectorAnchor(sector, n) {
  const [a0, a1] = sectorAngles(sector, n);
  const [x, y] = polar(R_DOTS, (a0 + a1) / 2);
  return { left: (x / (CX * 2)) * 100, top: (y / (CY * 2)) * 100 };
}
