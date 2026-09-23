// Heuristic Bot strategy for online rooms.
//
// Picks a legal action for the bot from its current player view, using a simple
// score-based heuristic. Knows nothing about the puzzle solution — it only sees
// what every player sees in `viewFor(room, botId)`, which means:
//
//   * the bot's own private surveys / targets / researches
//   * the public log (every scan target sector, every research subject, every
//     revealed theory object, every conference note)
//   * the shared sky window
//   * its own remaining scan markers and researched subjects
//
// The heuristic scores each legal turn action by:
//
//   * cost / information expected (cost dominates — same info for fewer months
//     wins)
//   * overlap with the bot's existing knowledge (avoid re-surveying ranges it
//     already knows, prefer ranges that include sectors it has no info on)
//   * if a survey cannot reveal anything new (the whole arc was already surveyed
//     for the same type), it is skipped
//
// Setup, research phases (declare / submit) and final opportunities are handled
// in dedicated branches.

import { COST, arcSectors, cometSectors, surveyCost } from '../public/src/rules.js';
import { Obj, SURVEY_TYPES } from '../public/src/types.js';

const SURVEY_ARC_SIZES = [1, 2, 3, 6];

/**
 * Decide one action (setup / turn / research / final) for the bot.
 *
 * Returns a plain action object that `applyRoomAction` understands, or
 * `null` when there is nothing meaningful to do.
 *
 * @param {object} room  the live room
 * @param {string} botId the bot player id
 * @param {object} view  `viewFor(room, botId)` — the bot's redacted perspective
 */
export function decideAction(room, botId, view) {
  if (!room || !view) return null;
  if (room.phase === 'lobby') return null;
  if (room.phase === 'setup') return decideSetupAction(room, botId, view);
  if (room.phase === 'final') return decideFinalAction(room, botId, view);
  if (room.phase === 'reveal') return null;
  if (room.phase === 'done') return null;

  // peer reviews and the research phase are off-turn duties: every seated
  // player must declare / answer before normal turns resume
  if (Array.isArray(view.myPendingReviews) && view.myPendingReviews.length) {
    return decideReviewAction(view);
  }
  if (room.research) return decideResearchAction(room, botId, view);

  // during normal play the bot must be the one whose turn it is
  if (!view.isMyTurn) return null;

  // conference prompt: free action, prefer to record it when we are on the clock
  if (room.conference && view.conference && view.conference.sector != null) {
    return { kind: 'conference', sector: view.conference.sector, text: view.conference.text || '（未记录线索内容）' };
  }

  return decideTurnAction(room, botId, view);
}

// ---- setup phase -----------------------------------------------------------

function decideSetupAction(room, botId, view) {
  const card = view.mySetup;
  if (card && card.ready) return null; // already submitted

  if (room.playMode === 'builtin') {
    return { kind: 'setup' };
  }

  // record mode: pick the first `initialClueCount` initial clues
  const count = room.initialClueCount || 0;
  const clues = [];
  for (let sector = 0; sector < room.session.mode.sectors && clues.length < count; sector += 1) {
    clues.push({ sector, type: Obj.ASTEROID });
  }
  const action = { kind: 'setup', clues: count ? clues : undefined, noClues: count === 0 };
  // the host fills the table-wide topic / conference names
  if (view.amHost) {
    action.topics = {
      A: 'Bot 课题 A', B: 'Bot 课题 B', C: 'Bot 课题 C',
      D: 'Bot 课题 D', E: 'Bot 课题 E', F: 'Bot 课题 F',
    };
  }
  return action;
}

// ---- research phase: declare + submit --------------------------------------

function decideResearchAction(room, botId, view) {
  const phase = room.research;
  if (!phase) return null;
  const declared = phase.declares[botId];
  const capacity = view.research ? view.research.maxDeclare : 0;

  // declaration step
  if (!phase.order.length) {
    if (declared === undefined) {
      const guessCount = countConfidentGuesses(view);
      const pick = Math.max(0, Math.min(capacity, guessCount > 0 ? 1 : 0));
      return { kind: 'research-declare', phaseId: phase.id, count: pick };
    }
    return null;
  }

  // publishing step: only the cursor may submit
  if (phase.cursorId !== botId) return null;
  if ((phase.left[botId] || 0) <= 0) return null;

  const ownTheories = room.session.entries.filter((entry) => entry.type === 'theory' && entry.actorId === botId);
  const publishedSectors = new Set(ownTheories.map((entry) => entry.sector));
  const lockedSectors = new Set(view.theoryLockedSectors || []);
  const candidates = (view.theoryOptions || []).filter(({ sector }) => !publishedSectors.has(sector));
  if (!candidates.length) return null;

  const seenSectors = new Set([
    ...(view.knowledge?.targets || []).map((entry) => entry.sector),
    ...(view.knowledge?.surveys || []).flatMap((entry) => arcSectors(entry.start, entry.size, room.session.mode.sectors)),
  ]);
  let best = null;
  let bestScore = -Infinity;
  for (const { sector, types } of candidates) {
    if (lockedSectors.has(sector)) continue;
    const type = types[0];
    if (!type) continue;
    const score = (seenSectors.has(sector) ? 1 : 0) - publishedSectors.size * 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = { sector, type };
    }
  }
  if (!best) return null;
  return { kind: 'research-submit', phaseId: phase.id, sector: best.sector, objectType: best.type };
}

/**
 * A rough "do I have a guess worth committing?" check.
 *
 * The bot cannot truly verify a sector without the puzzle solution, but it can
 * count how many sectors in the visible window have been scanned or surveyed
 * by anyone. If at least one of those sectors has been *both* surveyed and
 * scanned, the bot is willing to commit one paper.
 */
function countConfidentGuesses(view) {
  if (!view.knowledge) return 0;
  const scannedSectors = new Set(view.knowledge.targets.map((entry) => entry.sector));
  const surveyedSectors = new Set();
  for (const survey of view.knowledge.surveys) {
    for (const sector of arcSectors(survey.start, survey.size, view.mode.sectors)) surveyedSectors.add(sector);
  }
  let overlap = 0;
  for (const sector of scannedSectors) if (surveyedSectors.has(sector)) overlap += 1;
  return overlap > 0 ? 1 : 0;
}

// ---- review ----------------------------------------------------------------

function decideReviewAction(view) {
  // the bot cannot know whether the app said correct / wrong, so it always
  // reports "correct" — that matches the heuristic of preferring bold claims
  const id = view.myPendingReviews[0];
  if (id == null) return null;
  return { kind: 'review', id, review: 'correct' };
}

// ---- final opportunities ---------------------------------------------------

function decideFinalAction(room, botId, view) {
  const endgame = view.endgame;
  if (!endgame || !endgame.isMyTurn) return null;
  // without puzzle knowledge the bot cannot locate safely — pass
  return { kind: 'final-pass' };
}

// ---- the normal turn --------------------------------------------------------

function decideTurnAction(room, botId, view) {
  const mode = room.session.mode;
  const candidates = [];

  // --- surveys ------------------------------------------------------------
  for (const type of SURVEY_TYPES) {
    for (const size of SURVEY_ARC_SIZES) {
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
        const info = surveyInfo(room, botId, view, range, type);
        if (info <= 0) continue;
        candidates.push({ score: info / (cost + 1) + (size >= 6 ? 0.2 : 0), action: { kind: 'survey', type, start, size, count: 0 } });
      }
    }
  }

  // --- targets ------------------------------------------------------------
  if (view.targetUses > 0) {
    for (const sector of view.visible || []) {
      if (alreadyTargeted(room, botId, sector)) continue;
      const priority = scanPriority(view, sector);
      if (priority <= 0) continue;
      candidates.push({ score: priority / (COST.target + 1) + 0.5, action: { kind: 'target', sector, apparent: Obj.EMPTY } });
    }
  }

  // --- research -----------------------------------------------------------
  if (!view.lastWasResearch) {
    const researched = new Set(view.researched || []);
    for (const topic of ['A', 'B', 'C', 'D', 'E', 'F']) {
      if (researched.has(topic)) continue;
      candidates.push({ score: 1.4, action: { kind: 'research', topic, name: `课题 ${topic}`, text: 'Bot 自动研究' } });
      break;
    }
  }

  if (!candidates.length) {
    return { kind: 'wait' };
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].action;
}

/** Sectors in the range we have not already surveyed for this type. */
function surveyInfo(room, botId, view, range, type) {
  const ownSurveys = view.knowledge && view.knowledge.surveys ? view.knowledge.surveys : [];
  let alreadyCovered = 0;
  for (const survey of ownSurveys) {
    if (survey.surveyType !== type) continue;
    const covered = new Set(arcSectors(survey.start, survey.size, room.session.mode.sectors));
    for (const sector of range) if (covered.has(sector)) alreadyCovered += 1;
  }
  return Math.max(0, range.length - alreadyCovered);
}

/** True if the bot already scanned this sector. */
function alreadyTargeted(room, botId, sector) {
  for (const entry of room.session.entries) {
    if (entry.type === 'target' && entry.actorId === botId && entry.sector === sector) return true;
  }
  return false;
}

/**
 * Heuristic priority for scanning `sector`. Without puzzle knowledge we just
 * prefer sectors in the visible window that no one has touched yet.
 */
function scanPriority(view, sector) {
  const targeted = new Set((view.knowledge?.targets || []).map((entry) => entry.sector));
  const surveyedSectors = new Set();
  for (const survey of view.knowledge?.surveys || []) {
    for (const s of arcSectors(survey.start, survey.size, view.mode.sectors)) surveyedSectors.add(s);
  }
  if (targeted.has(sector)) return 0;
  if (surveyedSectors.has(sector)) return 0.5;
  return 1;
}
