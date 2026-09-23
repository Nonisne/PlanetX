// Heuristic Bot for builtin puzzles.
//
// The Bot only ever sees what `viewFor(room, botId)` returns: its own private
// surveys / targets / researches, the public log, the shared sky window, and
// the table-wide conferences. It NEVER touches `room.puzzle`, `objects`,
// unearned topic clues, or other players' private surveys. Every state change
// goes through `applyRoomAction`, so all existing rules (turn order, research
// phase, peer review, scoring) remain authoritative.
//
// The strategy maintains a per-sector candidate set from the bot's own initial
// clues, surveys, scans, revealed theories, and research or conference
// sentences it has already received. It never reads the puzzle or an unearned
// clue. A theory paper is submitted only when that set supports the claim;
// otherwise the bot declares zero papers.
//
// The Bot is **only** active in `playMode === 'builtin'`. In any other mode
// (`record`, `tutorial`) `decideAction` returns `null` so the controller never
// acts.

import { crossedEvents } from '../public/src/phases.js';
import {
  COST,
  arcSectors,
  cometSectors,
  isCometSector,
  mod,
  surveyCost,
} from '../public/src/rules.js';
import { Obj, SURVEY_TYPES } from '../public/src/types.js';

const ALL_OBJECTS = Object.freeze([Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.DWARF_PLANET, Obj.EMPTY, Obj.PLANET_X]);
const SURVEY_ARC_SIZES_STANDARD = Object.freeze([1, 2, 3, 6]);
const SURVEY_ARC_SIZES_EXPERT = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const TOPIC_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

// ---- entry point ----------------------------------------------------------

/**
 * Decide one action for the bot. Returns a plain action object that
 * `applyRoomAction` understands, or `null` when there is nothing meaningful.
 */
export function decideAction(room, botId, view) {
  if (!room || !view) return null;
  if (room.playMode !== 'builtin') return null;
  if (room.tutorialState) return null;

  if (room.phase === 'lobby') return null;
  if (room.phase === 'setup') return decideSetupAction(room, botId, view);
  if (room.phase === 'final') return decideFinalAction(room, botId, view);
  if (room.phase === 'reveal') return null;
  if (room.phase === 'done') return null;

  // Declarations and peer reviews are table-wide: a bot that is not the
  // current pawn must still answer, or a multi-bot room stalls.
  if (Array.isArray(view.myPendingReviews) && view.myPendingReviews.length) {
    return decideReviewAction(room, botId, view);
  }
  if (room.research) return decideResearchPhaseAction(room, botId, view);

  if (!view.isMyTurn) return null;

  if (room.conference && view.conference && view.conference.sector != null) {
    return { kind: 'conference', sector: view.conference.sector, text: view.conference.text || '（未记录线索内容）' };
  }

  return decideTurnAction(room, botId, view);
}

// ---- setup -----------------------------------------------------------------

function decideSetupAction(room, botId, view) {
  const card = view.mySetup;
  if (card && card.ready) return null;
  return { kind: 'setup' };
}

// ---- research phase: declare + submit --------------------------------------

function decideResearchPhaseAction(room, botId, view) {
  const phase = room.research;
  if (!phase) return null;
  const declared = phase.declares[botId];
  const capacity = view.research ? view.research.maxDeclare : 0;

  if (!phase.order.length) {
    if (declared === undefined) {
      const picks = pickTheoryPicks(room, botId, view);
      const count = Math.max(0, Math.min(capacity, picks.length));
      return { kind: 'research-declare', phaseId: phase.id, count };
    }
    return null;
  }

  if (phase.cursorId !== botId) return null;
  if ((phase.left[botId] || 0) <= 0) return null;

  const picks = pickTheoryPicks(room, botId, view);
  const usedThisPhase = new Set(
    room.research.picks.filter((pick) => pick.playerId === botId).map((pick) => pick.sector),
  );
  const remaining = picks.filter(({ sector }) => !usedThisPhase.has(sector));
  if (!remaining.length) return null;
  return { kind: 'research-submit', phaseId: phase.id, sector: remaining[0].sector, objectType: remaining[0].type };
}

const THEORY_GUESS_SCORE = 55;
const THEORY_TYPE_VALUE = { dwarfPlanet: 4, comet: 3, gasCloud: 4, asteroid: 2 };

/**
 * Rank the (sector, type) papers the bot is willing to publish.
 *
 * A legal option is not enough. The sector must be pinned to that one object
 * (score 100) or sit inside the bot's own dense survey (score 80 or 55).
 * Anything else is omitted, so the declaration count is 0 when the bot is
 * still guessing in the dark. Token stock is reserved here so two planned
 * papers cannot spend the same last token.
 */
export function pickTheoryPicks(room, botId, view) {
  const candidates = [];
  const lockedSectors = new Set(view.theoryLockedSectors || []);
  const remaining = view.theoryTokensRemaining || {};
  for (const { sector, types } of view.theoryOptions || []) {
    if (lockedSectors.has(sector)) continue;
    for (const type of types) {
      if ((remaining[type] || 0) <= 0) continue;
      candidates.push({ sector, type });
    }
  }
  if (!candidates.length) return candidates;

  const knowledge = computeKnowledge(room, botId, view);
  const surveys = (view.knowledge?.surveys || []).filter((survey) => survey.actorId === botId);
  const unresolved = new Set();
  for (const theory of view.knowledge?.theories || []) {
    if (theory.actorId === botId && !theory.revealed) unresolved.add(theory.sector);
  }
  const sectorCount = view.mode?.sectors || 0;
  const ranked = [];
  for (const candidate of candidates) {
    if (unresolved.has(candidate.sector)) continue;
    const support = theorySupport(candidate.sector, candidate.type, knowledge, surveys, sectorCount);
    if (support < THEORY_GUESS_SCORE) continue;
    candidate.score = support;
    candidate.tie = (THEORY_TYPE_VALUE[candidate.type] || 0) + (stableHash(botId, candidate.sector, candidate.type) % 97) / 1000;
    ranked.push(candidate);
  }
  ranked.sort((a, b) => b.score - a.score || b.tie - a.tie);

  const tokens = { ...remaining };
  const chosen = [];
  for (const candidate of ranked) {
    if ((tokens[candidate.type] || 0) <= 0) continue;
    if (chosen.some((pick) => pick.sector === candidate.sector)) continue;
    tokens[candidate.type] -= 1;
    chosen.push(candidate);
  }
  return chosen;
}

/**
 * How strongly the bot's own information supports publishing `type` in `sector`.
 * 100 means the candidate set has collapsed to that object. 80 means a small
 * survey almost forces it. 55 means the survey is dense enough to guess, but
 * not dense enough to treat as certain. 0 means there is no positive evidence.
 */
function theorySupport(sector, type, knowledge, surveys, sectorCount) {
  const possible = knowledge.possible(sector);
  if (!possible.includes(type)) return -1;
  if (possible.length === 1) return 100;
  let best = 0;
  for (const survey of surveys) {
    const apparent = surveyApparent(survey);
    if (apparent !== type || !Number.isInteger(survey.count) || survey.count <= 0) continue;
    if (!Number.isInteger(survey.start) || !Number.isInteger(survey.size) || survey.size <= 0) continue;
    const range = arcSectors(survey.start, survey.size, sectorCount);
    if (!range.includes(sector)) continue;
    const density = survey.count / range.length;
    if (range.length > 6 || density < 0.5) continue;
    const open = range.filter((item) => knowledge.possible(item).includes(type));
    if (open.length <= survey.count + 1) best = Math.max(best, 80);
    else if (density >= 2 / 3) best = Math.max(best, THEORY_GUESS_SCORE);
  }
  return best;
}

// ---- review ----------------------------------------------------------------

function decideReviewAction(room, botId, view) {
  const id = view.myPendingReviews[0];
  if (id == null) return null;
  const entry = (view.knowledge?.theories || []).find((theory) => theory.id === id);
  if (!entry) return { kind: 'review', id, review: 'correct' };

  // if a peer has already locked this sector with a correct claim, defer
  const locked = view.theoryLockedSectors || [];
  if (locked.includes(entry.sector)) {
    const lockedEntry = (view.knowledge.theories || []).find(
      (theory) => theory.sector === entry.sector && theory.review === 'correct' && theory.revealed,
    );
    if (lockedEntry) return { kind: 'review', id, review: entry.objectType === lockedEntry.objectType ? 'correct' : 'wrong' };
  }

  // otherwise check the bot's own candidate set: if this (sector, object) is
  // the only remaining possibility, mark correct; if it is provably excluded,
  // mark wrong.
  const knowledge = computeKnowledge(room, botId, view);
  const possible = knowledge.possible(entry.sector);
  if (possible.length === 1 && possible[0] === entry.objectType) return { kind: 'review', id, review: 'correct' };
  if (possible.length === 1 && possible[0] !== entry.objectType) return { kind: 'review', id, review: 'wrong' };
  // cannot be sure: bias toward correct (a missed-correct claim would lock the
  // sector for everyone; a missed-wrong costs only 1 month to the author)
  return { kind: 'review', id, review: 'correct' };
}

// ---- final opportunity ------------------------------------------------------

function decideFinalAction(room, botId, view) {
  const endgame = view.endgame;
  if (!endgame || !endgame.isMyTurn) return null;
  const knowledge = computeKnowledge(room, botId, view);

  // Locate only when X and both neighbours are each a single object.
  // Anything less certain is a pass: guessing papers in the final window is
  // not part of this heuristic.
  const locate = findCertainLocate(knowledge, view);
  if (locate) return { kind: 'locate', sector: locate.sector, left: locate.left, right: locate.right };
  return { kind: 'final-pass' };
}

/**
 * Look for a sector whose candidate set has collapsed to Planet X, where the
 * left and right neighbours are each unique too.
 */
function findCertainLocate(knowledge, view) {
  const sectors = view.mode.sectors;
  for (let sector = 0; sector < sectors; sector += 1) {
    const possible = knowledge.possible(sector);
    if (possible.length !== 1 || possible[0] !== Obj.PLANET_X) continue;
    const left = mod(sector - 1, sectors);
    const right = mod(sector + 1, sectors);
    const leftPossible = knowledge.possible(left);
    const rightPossible = knowledge.possible(right);
    if (leftPossible.length === 1 && rightPossible.length === 1 && left !== right) {
      return { sector, left: leftPossible[0], right: rightPossible[0] };
    }
  }
  return null;
}

// ---- the normal turn --------------------------------------------------------

/**
 * Pick the best normal-turn action: survey / target / research / locate.
 *
 * Survey scoring: range.size / (cost + 1), bonus for full-window arcs.
 * Target scoring: prefer sectors the bot has *itself* narrowed to 2-3 objects
 * (still uncertain but informative) over sectors it has never touched.
 * Research scoring: alphabet-order with a per-bot hash so the room's bots do
 * not all pick the same first topic.
 * There is no official "wait" action. If every real action would leave an
 * unprepared event, the bot still takes the best real action.
 */
function decideTurnAction(room, botId, view) {
  const mode = view.mode;
  const knowledge = computeKnowledge(room, botId, view);
  const locate = findCertainLocate(knowledge, view);
  if (locate) return { kind: 'locate', sector: locate.sector, left: locate.left, right: locate.right };

  const candidates = [];
  const seatIndex = Math.max(0, room.players.findIndex((player) => player.id === botId));
  const preferStart = preferredSurveyStart(botId, seatIndex, mode.sectors);

  // ---- surveys ----
  for (const type of SURVEY_TYPES) {
    for (const size of surveyArcSizes(mode)) {
      if (size > mode.visible) continue;
      for (let start = 0; start < mode.sectors; start += 1) {
        const range = arcSectors(start, size, mode.sectors);
        if (type === Obj.COMET) {
          const legal = cometSectors(mode);
          if (!legal.includes(range[0] + 1) || !legal.includes(range[range.length - 1] + 1)) continue;
        }
        if (!range.every((sector) => Array.isArray(view.visible) && view.visible.includes(sector))) continue;
        const cost = surveyCost(size);
        if (!Number.isFinite(cost)) continue;
        // require at least one sector that is still uncertain
        let unknown = 0;
        for (const sector of range) if (knowledge.possible(sector).length > 1) unknown += 1;
        if (unknown === 0) continue;
        const forward = (start - preferStart + mode.sectors) % mode.sectors;
        const backward = (preferStart - start + mode.sectors) % mode.sectors;
        const distance = Math.min(forward, backward);
        // Tie-break only: one unknown sector is worth ~0.2, so this cannot
        // override a genuinely narrower or cheaper arc.
        const bias = (mode.sectors - distance) * 0.001;
        candidates.push({ score: unknown / (cost + 1) + (size >= mode.visible ? 0.2 : 0) + bias, action: { kind: 'survey', type, start, size, count: 0 } });
      }
    }
  }

  // ---- targets ----
  if ((view.targetUses || 0) > 0) {
    for (const sector of view.visible || []) {
      if (alreadyTargeted(room, botId, sector)) continue;
      const possible = knowledge.possible(sector);
      // only scan if the candidate set has 2 or 3 possibilities — if it is a
      // single object the bot already knows; if it has 4+ the scan is unlikely
      // to break a tie
      if (possible.length < 2 || possible.length > 3) continue;
      const covered = knowledge.surveyedByBot.has(sector);
      const score = (covered ? 2 : 0.5) + (possible.length === 2 ? 1 : 0);
      candidates.push({ score: score / (COST.target + 1) + 0.6, action: { kind: 'target', sector, apparent: Obj.EMPTY } });
    }
  }

  // ---- research ----
  if (!view.lastWasResearch) {
    const researched = new Set(view.researched || []);
    // give each bot a stable preferred starting topic. The hash uses both the
    // bot id and the bot's seat index so consecutive bot ids (Bot1, Bot2, ...)
    // still spread across the 6 topics.
    const seatIndex = room.players.findIndex((p) => p.id === botId);
    const preferredIndex = (stableHash(botId, seatIndex) * 37 + 0xc2b2ae35) >>> 0 % TOPIC_IDS.length;
    for (let index = 0; index < TOPIC_IDS.length; index += 1) {
      const topic = TOPIC_IDS[index];
      if (researched.has(topic)) continue;
      const forward = (index - preferredIndex + TOPIC_IDS.length) % TOPIC_IDS.length;
      const backward = (preferredIndex - index + TOPIC_IDS.length) % TOPIC_IDS.length;
      const distance = Math.min(forward, backward);
      // prefer the bot's chosen starting topic; alphabet position provides a
      // mild bias toward later letters (more useful for locating X).
      const score = (TOPIC_IDS.length - 1 - distance) + (researchPriority(topic, knowledge, view) * 0.3);
      candidates.push({ score, action: { kind: 'research', topic, name: `课题 ${topic}`, text: 'Bot 自动研究' } });
    }
  }

  if (!candidates.length) return fallbackSurvey(view);

  candidates.sort((a, b) => b.score - a.score);
  const safe = candidates.filter((candidate) => !crossesUnpreparedEvent(room, botId, view, actionCost(candidate.action)));
  // Prefer a real action that stays short of an unprepared marker. Waiting is
  // not an official action, so if every survey, scan and research would leave
  // the marker, take the best of those instead.
  if (safe.length) return safe[0].action;
  return candidates[0].action;
}

/** A legal survey when nothing looks informative. Never a wait. */
function fallbackSurvey(view) {
  const visible = Array.isArray(view.visible) ? view.visible : [];
  if (!visible.length) return null;
  const start = visible[0];
  return { kind: 'survey', type: Obj.ASTEROID, start, size: 1, count: 0 };
}

/** Stable preferred survey origin so bots in the same room do not copy one arc. */
export function preferredSurveyStart(botId, seatIndex, sectorCount) {
  const count = Math.max(1, sectorCount | 0);
  return stableHash(botId, seatIndex, 'survey') % count;
}

function actionCost(action) {
  if (!action) return 0;
  if (action.kind === 'survey') return surveyCost(action.size);
  if (action.kind === 'target') return COST.target;
  if (action.kind === 'research') return COST.research;
  if (action.kind === 'locate') return COST.locate;
  return 0;
}

function surveyArcSizes(mode) {
  return mode.id === 'expert' ? SURVEY_ARC_SIZES_EXPERT : SURVEY_ARC_SIZES_STANDARD;
}

function alreadyTargeted(room, botId, sector) {
  for (const entry of room.session.entries) {
    if (entry.type === 'target' && entry.actorId === botId && entry.sector === sector) return true;
  }
  return false;
}

// ---- per-sector knowledge ---------------------------------------------------

const BOARD_COUNTS = Object.freeze({
  standard: Object.freeze({ asteroid: 4, comet: 2, gasCloud: 2, dwarfPlanet: 1, empty: 2, planetX: 1 }),
  expert: Object.freeze({ asteroid: 4, comet: 2, gasCloud: 2, dwarfPlanet: 4, empty: 5, planetX: 1 }),
});

const CLUE_LABELS = Object.freeze([
  ['矮行星', Obj.DWARF_PLANET],
  ['气体云', Obj.GAS_CLOUD],
  ['小行星', Obj.ASTEROID],
  ['X行星', Obj.PLANET_X],
  ['彗星', Obj.COMET],
]);
const CLUE_NAME = CLUE_LABELS.map(([label]) => label).join('|');

/**
 * Turn one earned research or conference sentence back into a feature.
 * Only the fixed sentences this game generates are recognized. Free text,
 * and any clue the bot has not been given, stays unused.
 */
export function parseResearchClue(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const name = (group) => CLUE_LABELS.find(([label]) => label === group)?.[1] || null;
  let match = raw.match(new RegExp(`^所有(${CLUE_NAME})都位于一段不超过 (\\d+) 个连续扇区内。$`));
  if (match && name(match[1])) return { kind: 'band', objectType: name(match[1]), length: Number(match[2]) };

  match = raw.match(new RegExp(`^没有任何(${CLUE_NAME})位于其他\\1的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[1]), relation: 'within', range: Number(match[2]), quantifier: 'none' };
  }
  match = raw.match(new RegExp(`^X行星不在任何(${CLUE_NAME})的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1]) && name(match[1]) !== Obj.PLANET_X) {
    return { kind: 'relation', objectType: Obj.PLANET_X, neighborType: name(match[1]), relation: 'within', range: Number(match[2]), quantifier: 'none' };
  }
  match = raw.match(new RegExp(`^X行星位于至少一个(${CLUE_NAME})的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1]) && name(match[1]) !== Obj.PLANET_X) {
    return { kind: 'relation', objectType: Obj.PLANET_X, neighborType: name(match[1]), relation: 'within', range: Number(match[2]), quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^X行星不与任何(${CLUE_NAME})(相邻|正对)。$`));
  if (match && name(match[1]) && name(match[1]) !== Obj.PLANET_X) {
    return { kind: 'relation', objectType: Obj.PLANET_X, neighborType: name(match[1]), relation: match[2] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'none' };
  }
  match = raw.match(new RegExp(`^X行星与至少一个(${CLUE_NAME})(相邻|正对)。$`));
  if (match && name(match[1]) && name(match[1]) !== Obj.PLANET_X) {
    return { kind: 'relation', objectType: Obj.PLANET_X, neighborType: name(match[1]), relation: match[2] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^没有任何(${CLUE_NAME})位于(${CLUE_NAME})的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: 'within', range: Number(match[3]), quantifier: 'none' };
  }
  match = raw.match(new RegExp(`^至少有一个(${CLUE_NAME})位于某个(${CLUE_NAME})的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: 'within', range: Number(match[3]), quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^至少有一个(${CLUE_NAME})位于X行星的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: Obj.PLANET_X, relation: 'within', range: Number(match[2]), quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^每个(${CLUE_NAME})都位于至少一个(${CLUE_NAME})的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: 'within', range: Number(match[3]), quantifier: 'all' };
  }
  match = raw.match(new RegExp(`^每个(${CLUE_NAME})都位于X行星的 (\\d+) 个扇区以内。$`));
  if (match && name(match[1])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: Obj.PLANET_X, relation: 'within', range: Number(match[2]), quantifier: 'all' };
  }
  match = raw.match(new RegExp(`^没有任何(${CLUE_NAME})与(${CLUE_NAME})(相邻|正对)。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: match[3] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'none' };
  }
  match = raw.match(new RegExp(`^至少有一个(${CLUE_NAME})与某个(${CLUE_NAME})(相邻|正对)。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: match[3] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^至少有一个(${CLUE_NAME})与X行星(相邻|正对)。$`));
  if (match && name(match[1])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: Obj.PLANET_X, relation: match[2] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'some' };
  }
  match = raw.match(new RegExp(`^每个(${CLUE_NAME})都与至少一个(${CLUE_NAME})(相邻|正对)。$`));
  if (match && name(match[1]) && name(match[2])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: name(match[2]), relation: match[3] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'all' };
  }
  match = raw.match(new RegExp(`^每个(${CLUE_NAME})都与X行星(相邻|正对)。$`));
  if (match && name(match[1])) {
    return { kind: 'relation', objectType: name(match[1]), neighborType: Obj.PLANET_X, relation: match[2] === '相邻' ? 'adjacent' : 'opposite', quantifier: 'all' };
  }
  return null;
}

/**
 * Build a per-sector candidate set the Bot can query for downstream scoring.
 *
 * Sources, in order:
 *  1. bot's initial clues (`view.mySetup.clues`) — private to the bot
 *  2. bot's own surveys — private; the log stores the object on `surveyType`
 *  3. bot's own targets — private; apparent fixes or rules out objects
 *  4. publicly revealed theories (correct locks the sector; wrong excludes)
 *  5. research and conference sentences the bot has already received
 *  6. public board rules (comet sectors, object counts, adjacency, expert dwarf band)
 *
 * The returned object also exposes `surveyedByBot` so the target heuristic
 * can prefer sectors the bot has narrowed itself.
 */
export function computeKnowledge(room, botId, view) {
  const sectors = view.mode.sectors;
  const possible = Array.from({ length: sectors }, () => new Set(ALL_OBJECTS));

  const card = view.mySetup;
  if (card && Array.isArray(card.clues)) {
    for (const clue of card.clues) {
      if (typeof clue.sector !== 'number') continue;
      if (possible[clue.sector]) possible[clue.sector].delete(clue.type);
    }
  }

  const mySurveys = (view.knowledge?.surveys || []).filter((survey) => survey.actorId === botId);
  const surveyedByBot = new Set();
  for (const survey of mySurveys) {
    if (!Number.isInteger(survey.start) || !Number.isInteger(survey.size)) continue;
    for (const sector of arcSectors(survey.start, survey.size, sectors)) surveyedByBot.add(sector);
  }

  const myTargets = (view.knowledge?.targets || []).filter((target) => target.actorId === botId);
  for (const target of myTargets) {
    if (typeof target.sector !== 'number') continue;
    const apparent = target.apparent;
    if (!apparent) continue;
    const sectorSet = possible[target.sector];
    if (!sectorSet) continue;
    if (apparent === Obj.EMPTY) {
      // the four ordinary objects are out — Planet X still possible
      sectorSet.delete(Obj.ASTEROID);
      sectorSet.delete(Obj.COMET);
      sectorSet.delete(Obj.GAS_CLOUD);
      sectorSet.delete(Obj.DWARF_PLANET);
    } else {
      sectorSet.clear();
      sectorSet.add(apparent);
    }
  }

  for (const theory of view.knowledge?.theories || []) {
    if (theory.revealed && theory.review === 'correct' && typeof theory.objectType === 'string') {
      if (possible[theory.sector]) {
        possible[theory.sector].clear();
        possible[theory.sector].add(theory.objectType);
      }
    } else if (theory.revealed && theory.review === 'wrong' && typeof theory.objectType === 'string') {
      if (possible[theory.sector]) possible[theory.sector].delete(theory.objectType);
    }
  }

  tightenCandidates(possible, view, botId, mySurveys);

  const frozen = possible.map((set) => Array.from(set));
  return {
    possible(sector) {
      return frozen[sector] || [];
    },
    surveyedByBot,
  };
}

function tightenCandidates(possible, view, botId, surveys) {
  const features = earnedFeatures(view, botId);
  const sectorCount = possible.length;
  const limit = sectorCount * ALL_OBJECTS.length;
  for (let guard = 0; guard < limit; guard += 1) {
    let changed = false;
    changed = applySurveyConstraints(possible, surveys, sectorCount) || changed;
    changed = applyBoardRules(possible, view.mode) || changed;
    for (const feature of features) {
      if (feature.kind === 'band') changed = applyBand(possible, feature, sectorCount) || changed;
      else changed = applyRelation(possible, feature, sectorCount) || changed;
    }
    if (!changed) return;
  }
}

function earnedFeatures(view, botId) {
  const texts = [];
  for (const clue of view.knowledge?.clues || []) {
    if (clue.actorId === botId && typeof clue.text === 'string') texts.push(clue.text);
  }
  for (const conference of view.knowledge?.conferences || []) {
    if (typeof conference.text === 'string') texts.push(conference.text);
  }
  for (const text of Object.values(view.conferenceRules || {})) {
    if (typeof text === 'string') texts.push(text);
  }
  return texts.map((text) => parseResearchClue(text)).filter(Boolean);
}

function surveyApparent(survey) {
  if (typeof survey.surveyType === 'string' && survey.surveyType !== 'survey') return survey.surveyType;
  if (typeof survey.type === 'string' && survey.type !== 'survey') return survey.type;
  return null;
}

function showsApparent(set, apparent) {
  if (!set) return false;
  if (apparent === Obj.EMPTY) return set.has(Obj.EMPTY) || set.has(Obj.PLANET_X);
  return set.has(apparent);
}

function mustShowApparent(set, apparent) {
  if (!set || set.size === 0) return false;
  if (apparent === Obj.EMPTY) {
    for (const type of set) if (type !== Obj.EMPTY && type !== Obj.PLANET_X) return false;
    return true;
  }
  return set.size === 1 && set.has(apparent);
}

function forceApparent(set, apparent) {
  if (!set) return false;
  if (apparent === Obj.EMPTY) {
    let changed = false;
    for (const type of [...set]) {
      if (type !== Obj.EMPTY && type !== Obj.PLANET_X) {
        set.delete(type);
        changed = true;
      }
    }
    return changed;
  }
  if (!set.has(apparent) || set.size === 1) return false;
  set.clear();
  set.add(apparent);
  return true;
}

function forbidApparent(set, apparent) {
  if (!set) return false;
  if (apparent === Obj.EMPTY) {
    const droppedEmpty = set.delete(Obj.EMPTY);
    const droppedX = set.delete(Obj.PLANET_X);
    return droppedEmpty || droppedX;
  }
  return set.delete(apparent);
}

function forceType(set, type) {
  if (!set || !set.has(type) || set.size === 1) return false;
  set.clear();
  set.add(type);
  return true;
}

function applySurveyConstraints(possible, surveys, sectorCount) {
  let changed = false;
  for (const survey of surveys) {
    const apparent = surveyApparent(survey);
    if (!apparent || !Number.isInteger(survey.count) || !Number.isInteger(survey.start) || !Number.isInteger(survey.size)) continue;
    const range = arcSectors(survey.start, survey.size, sectorCount);
    if (survey.count === 0) {
      for (const sector of range) changed = forbidApparent(possible[sector], apparent) || changed;
      continue;
    }
    const open = range.filter((sector) => showsApparent(possible[sector], apparent));
    if (open.length === survey.count) {
      for (const sector of open) changed = forceApparent(possible[sector], apparent) || changed;
    }
    const forced = range.filter((sector) => mustShowApparent(possible[sector], apparent));
    if (forced.length === survey.count && forced.length < range.length) {
      for (const sector of range) {
        if (!forced.includes(sector)) changed = forbidApparent(possible[sector], apparent) || changed;
      }
    }
  }
  return changed;
}

function applyBoardRules(possible, mode) {
  const sectorCount = possible.length;
  const counts = BOARD_COUNTS[mode?.id] || BOARD_COUNTS.standard;
  let changed = false;
  for (let sector = 0; sector < sectorCount; sector += 1) {
    if (!isCometSector(mode, sector) && possible[sector].delete(Obj.COMET)) changed = true;
  }
  for (const type of ALL_OBJECTS) {
    const need = counts[type];
    if (!need) continue;
    const pinned = [];
    const open = [];
    for (let sector = 0; sector < sectorCount; sector += 1) {
      if (!possible[sector].has(type)) continue;
      open.push(sector);
      if (possible[sector].size === 1) pinned.push(sector);
    }
    if (pinned.length === need) {
      for (const sector of open) {
        if (!pinned.includes(sector) && possible[sector].delete(type)) changed = true;
      }
    } else if (open.length === need) {
      for (const sector of open) changed = forceType(possible[sector], type) || changed;
    }
  }
  changed = applyAdjacency(possible) || changed;
  if (mode?.id === 'expert') changed = applyDwarfBand(possible) || changed;
  return changed;
}

function applyAdjacency(possible) {
  const sectorCount = possible.length;
  let changed = false;
  for (let sector = 0; sector < sectorCount; sector += 1) {
    const set = possible[sector];
    const left = possible[mod(sector - 1, sectorCount)];
    const right = possible[mod(sector + 1, sectorCount)];
    if (set.has(Obj.ASTEROID) && !left.has(Obj.ASTEROID) && !right.has(Obj.ASTEROID)) {
      set.delete(Obj.ASTEROID);
      changed = true;
    }
    if (set.size === 1 && set.has(Obj.ASTEROID)) {
      const open = [mod(sector - 1, sectorCount), mod(sector + 1, sectorCount)].filter((neighbor) => possible[neighbor].has(Obj.ASTEROID));
      if (open.length === 1) changed = forceType(possible[open[0]], Obj.ASTEROID) || changed;
    }
    if (set.has(Obj.GAS_CLOUD) && !left.has(Obj.EMPTY) && !right.has(Obj.EMPTY)) {
      set.delete(Obj.GAS_CLOUD);
      changed = true;
    }
    if (set.size === 1 && set.has(Obj.GAS_CLOUD)) {
      const open = [mod(sector - 1, sectorCount), mod(sector + 1, sectorCount)].filter((neighbor) => possible[neighbor].has(Obj.EMPTY));
      if (open.length === 1) changed = forceType(possible[open[0]], Obj.EMPTY) || changed;
    }
    if (set.size === 1 && set.has(Obj.DWARF_PLANET)) {
      if (left.delete(Obj.PLANET_X)) changed = true;
      if (right.delete(Obj.PLANET_X)) changed = true;
    }
    if (set.size === 1 && set.has(Obj.PLANET_X)) {
      if (left.delete(Obj.DWARF_PLANET)) changed = true;
      if (right.delete(Obj.DWARF_PLANET)) changed = true;
    }
  }
  return changed;
}

function applyDwarfBand(possible) {
  const sectorCount = possible.length;
  const forced = [];
  for (let sector = 0; sector < sectorCount; sector += 1) {
    if (possible[sector].size === 1 && possible[sector].has(Obj.DWARF_PLANET)) forced.push(sector);
  }
  const windows = [];
  for (let start = 0; start < sectorCount; start += 1) {
    const sectors = arcSectors(start, 6, sectorCount);
    if (!possible[sectors[0]].has(Obj.DWARF_PLANET) || !possible[sectors[5]].has(Obj.DWARF_PLANET)) continue;
    if (!forced.every((sector) => sectors.includes(sector))) continue;
    windows.push(sectors);
  }
  if (!windows.length) return false;
  const cover = new Set(windows.flat());
  let changed = false;
  for (let sector = 0; sector < sectorCount; sector += 1) {
    if (!cover.has(sector) && possible[sector].delete(Obj.DWARF_PLANET)) changed = true;
  }
  return changed;
}

function applyBand(possible, feature, sectorCount) {
  const forced = [];
  for (let sector = 0; sector < sectorCount; sector += 1) {
    if (possible[sector].size === 1 && possible[sector].has(feature.objectType)) forced.push(sector);
  }
  const windows = [];
  for (let start = 0; start < sectorCount; start += 1) {
    const sectors = arcSectors(start, feature.length, sectorCount);
    if (forced.every((sector) => sectors.includes(sector))) windows.push(sectors);
  }
  if (!windows.length) return false;
  const cover = new Set(windows.flat());
  let changed = false;
  for (let sector = 0; sector < sectorCount; sector += 1) {
    if (!cover.has(sector) && possible[sector].delete(feature.objectType)) changed = true;
  }
  return changed;
}

function applyRelation(possible, feature, sectorCount) {
  if (feature.quantifier === 'some') return false;
  const { objectType, neighborType, relation, quantifier } = feature;
  const reach = relation === 'adjacent' ? 1 : relation === 'opposite' ? sectorCount / 2 : feature.range;
  if (!Number.isInteger(reach) || reach <= 0) return false;
  let changed = false;
  if (quantifier === 'none') {
    for (let sector = 0; sector < sectorCount; sector += 1) {
      const set = possible[sector];
      if (!set || set.size !== 1) continue;
      if (set.has(objectType)) changed = excludeAround(possible, sector, neighborType, relation, reach, sectorCount) || changed;
      if (objectType !== neighborType && set.has(neighborType)) {
        changed = excludeAround(possible, sector, objectType, relation, reach, sectorCount) || changed;
      }
    }
    return changed;
  }
  if (quantifier === 'all' && relation === 'adjacent') {
    for (let sector = 0; sector < sectorCount; sector += 1) {
      const set = possible[sector];
      if (!set || set.size !== 1 || !set.has(objectType)) continue;
      const open = [mod(sector - 1, sectorCount), mod(sector + 1, sectorCount)].filter((neighbor) => possible[neighbor].has(neighborType));
      if (open.length === 1) changed = forceType(possible[open[0]], neighborType) || changed;
    }
  }
  return changed;
}

function excludeAround(possible, sector, type, relation, reach, sectorCount) {
  let changed = false;
  if (relation === 'opposite') {
    const opposite = mod(sector + sectorCount / 2, sectorCount);
    if (possible[opposite]?.delete(type)) changed = true;
    return changed;
  }
  for (let distance = 1; distance <= reach; distance += 1) {
    for (const neighbor of [mod(sector - distance, sectorCount), mod(sector + distance, sectorCount)]) {
      if (neighbor !== sector && possible[neighbor]?.delete(type)) changed = true;
    }
  }
  return changed;
}

// ---- research priority ------------------------------------------------------

/**
 * Higher alphabet letters are more often relational (X-adjacent, within-N,
 * etc.) and therefore most useful for locating Planet X. We do not parse the
 * topic clue text — that would risk leaking puzzle truth through score
 * distribution. The diversity offset below keeps two bots in the same room
 * from picking the same first topic.
 */
function researchPriority(topic, knowledge, view) {
  void knowledge;
  // Unearned clue text stays in the puzzle and is not readable here. The
  // public subject name is already on the view; an X-related title is the
  // only safe signal that this topic is more useful for locating X.
  const name = String(view.topicNames?.[topic] || '');
  const mentionsX = name.includes('X') ? 2 : 0;
  return mentionsX + (TOPIC_IDS.indexOf(topic) / TOPIC_IDS.length);
}

// ---- event guards -----------------------------------------------------------

/**
 * True when spending `cost` months would move the shared window off a
 * conference or theory marker the bot is not ready for.
 *
 * Uses the same `crossedEvents` arithmetic as the table. A theory counts as
 * prepared only when some sector has collapsed to one ordinary object (a
 * paper worth publishing). A conference counts as prepared once it is
 * recorded or the shared note is already filled in. Mere legal theory
 * options, or a missing research-phase capacity, do not count as ready.
 */
function crossesUnpreparedEvent(room, botId, view, cost) {
  if (!view.isMyTurn || !Number.isFinite(cost) || cost <= 0) return false;
  const before = view.windowTime ?? view.time ?? 0;
  return crossedEvents(view.mode, before, before + cost).some((event) => {
    if (event.kind === 'conference') return !conferencePrepared(view, event);
    if (event.kind === 'theory') return !theoryPrepared(room, botId, view);
    return false;
  });
}

function conferencePrepared(view, event) {
  const recorded = (view.knowledge?.conferences || []).some((entry) => entry.sector === event.sector);
  if (recorded) return true;
  const note = view.conferenceRules?.[event.sector];
  return typeof note === 'string' && note.trim().length > 0;
}

function theoryPrepared(room, botId, view) {
  return pickTheoryPicks(room, botId, view).some((pick) => pick.score >= 100);
}

// ---- tiny stable hash for diversity ----------------------------------------

function stableHash(...keys) {
  let h = 0x9e3779b1;
  for (const key of keys) {
    const s = String(key);
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return Math.abs(h);
}
