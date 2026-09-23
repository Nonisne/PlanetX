// Heuristic Bot for builtin puzzles.
//
// The Bot only ever sees what `viewFor(room, botId)` returns: its own private
// surveys / targets / researches, the public log, the shared sky window, and
// the table-wide conferences. It NEVER touches `room.puzzle`, `objects`,
// unearned topic clues, or other players' private surveys. Every state change
// goes through `applyRoomAction`, so all existing rules (turn order, research
// phase, peer review, scoring) remain authoritative.
//
// The strategy maintains a per-sector candidate set (what could still be there
// in the bot's eyes), then picks the cheapest legal action that narrows it the
// most. The strategy is deliberately conservative — it never claims certainty
// it cannot derive from public information.
//
// The Bot is **only** active in `playMode === 'builtin'`. In any other mode
// (`record`, `tutorial`) `decideAction` returns `null` so the controller never
// acts.

import { crossedEvents } from '../public/src/phases.js';
import {
  COST,
  arcSectors,
  cometSectors,
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

/**
 * Rank the (sector, type) candidates for a bot's theory paper.
 *
 * Each candidate must (a) not be locked, (b) the type still has tokens,
 * (c) the bot has not already published this sector in this phase. The score
 * rewards sectors whose candidate set has narrowed to a single ordinary
 * object — those are near-certainties and the bot should claim them first.
 */
function pickTheoryPicks(room, botId, view) {
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
  const candidatesInSectors = new Map();
  for (const { sector, type } of candidates) candidatesInSectors.set(sector, (candidatesInSectors.get(sector) || []).concat(type));

  // bonus for rare tokens so the bot spends its budget where points are
  const typeValue = { dwarfPlanet: 4, comet: 3, gasCloud: 4, asteroid: 2 };
  for (const candidate of candidates) {
    const cs = candidatesInSectors.get(candidate.sector);
    const narrowed = cs.length === 1;
    candidate.score = (narrowed ? 100 : 0) + (typeValue[candidate.type] || 0);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
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

/**
 * Build a per-sector candidate set the Bot can query for downstream scoring.
 *
 * Sources, in order:
 *  1. bot's initial clues (`view.mySetup.clues`) — private to the bot
 *  2. bot's own surveys — private; count constraints narrow candidate sets
 *  3. bot's own targets — private; apparent fixes or rules out objects
 *  4. publicly revealed theories (correct locks the sector; wrong excludes)
 *  5. global object counts (soft, non-binding prune)
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
    for (const sector of arcSectors(survey.start, survey.size, sectors)) surveyedByBot.add(sector);
    if (survey.type && Number.isInteger(survey.count)) {
      applySurvey(possible, arcSectors(survey.start, survey.size, sectors), survey.type, survey.count, view.mode);
    }
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

  applyGlobalCounts(possible, view.mode);

  const frozen = possible.map((set) => Array.from(set));
  return {
    possible(sector) {
      return frozen[sector] || [];
    },
    surveyedByBot,
  };
}

/**
 * Narrow the candidate set based on the bot's own survey result. count === 0
 * rules the type out everywhere in the range; count === range.length fixes
 * every sector to that type; intermediate counts are uninformative without
 * combinatorics, so we leave them.
 */
function applySurvey(possible, range, type, count) {
  if (count === 0) {
    for (const sector of range) possible[sector]?.delete(type);
    return;
  }
  if (count === range.length) {
    for (const sector of range) {
      const set = possible[sector];
      if (!set) continue;
      set.clear();
      set.add(type);
    }
  }
}

/**
 * No-op placeholder: the candidate sets the bot derives from private clues,
 * scans, and public theories are already enough for the heuristic. A full
 * constraint solver is out of scope here.
 */
function applyGlobalCounts(possible, mode) {
  void possible;
  void mode;
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
