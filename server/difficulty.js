// Difficulty rating for builtin puzzles.
//
// We rate a puzzle by running the heuristic bot from `bot.js` against a real
// room built around the puzzle, then collapsing the run into a composite
// metric. The metric is designed so that "harder" puzzles have a higher
// score: the bot has to spend more time before locating X, and finishes with
// less of the available score.
//
// The rating pipeline has three steps:
//
//   1. `simulateBotRun(puzzle, options)` — drive the bot through one full game
//      in headless mode. Returns raw observations (rounds to locate, final
//      score, knowledge curve).
//   2. `scoreDifficulty(result)` — collapse the observations into a single
//      [0, 1] composite number.
//   3. `rankDifficulties(scores)` — turn a sample of scores into per-mode
//      percentile breakpoints so any new puzzle's score can be mapped to a
//      1–5 star bucket.
//
// The cache layer (above this file) stores both the percentile breakpoints
// and the per-puzzle results so we don't replay puzzles the bot has already
// seen. The cache is keyed by the puzzle's objects array hash, so changing
// the heuristic bot invalidates only when the cached `botVersion` no longer
// matches.

import { applyRoomAction, createRoom, viewFor } from '../public/src/room.js';
import { decideAction } from './bot.js';

const DEFAULT_MAX_TICKS = 200;
const DEFAULT_SEED = 0xc0ffee;

/**
 * Deterministic pseudo-random number generator for bot simulation. We feed a
 * stable seed so the same puzzle always produces the same difficulty score
 * (otherwise the cache key would have to encode the entire RNG trajectory).
 *
 * Uses a simple xorshift32 — fast, no allocations, and the results are good
 * enough for shuffling decision noise.
 */
function makeRng(seed = DEFAULT_SEED) {
  let state = (seed >>> 0) || 1;
  return function rng() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) / 0x1_0000_0000);
  };
}

/**
 * Walk the room forward with `decideAction` + `applyRoomAction` until the
 * room reaches a terminal phase (reveal, done) or the bot refuses to act
 * `MAX_TICKS` times in a row.
 *
 * The bot is the sole player; this simulates a single-player perfect-play
 * run with no human input.
 */
export function simulateBotRun(puzzle, {
  modeId = 'standard',
  initialClueCount = 4,
  maxTicks = DEFAULT_MAX_TICKS,
  seed = DEFAULT_SEED,
} = {}) {
  if (!puzzle || !Array.isArray(puzzle.objects)) {
    throw new TypeError('simulateBotRun requires a puzzle with an objects array.');
  }
  const room = createRoom({
    playMode: 'builtin',
    modeId,
    puzzle,
    hostName: '难度评估 Bot',
    initialClueCount,
  });
  // Solo mode: the host IS the bot. There is no human to drive the host, so
  // we promote the host to bot status and drive it ourselves in the loop
  // below. The setup check `seated.length < 2 && playMode !== 'builtin'`
  // accepts a single-player builtin run.
  const bot = room.players.find((player) => player.id === room.hostId);
  bot.bot = true;
  // Pin a deterministic RNG so the bot's tie-breaking choices are stable.
  room.rng = makeRng(seed);

  // Start the game: the host kicks off (claim-initial-clues + setup were
  // already done by start-game's `cards` block), and we transition straight
  // into the play phase.
  const hostStart = applyRoomAction(room, room.hostId, { kind: 'start-game' });
  if (!hostStart.ok) {
    throw new Error(`simulateBotRun: start-game refused (${hostStart.error})`);
  }
  // start-game fills the host's setup card; the bot still has to confirm
  // readiness before the room enters play.
  const setup = applyRoomAction(room, room.hostId, { kind: 'setup' });
  if (!setup.ok) {
    throw new Error(`simulateBotRun: setup refused (${setup.error})`);
  }
  if (room.phase !== 'play') {
    throw new Error(`simulateBotRun: room did not enter play phase (phase=${room.phase})`);
  }

  let lastActionTick = 0;
  let ticks = 0;
  let stalled = 0;
  let locatedTick = null;
  let finalTick = 0;
  let actionsApplied = 0;
  // Knowledge curve: every `KNOWLEDGE_SAMPLE_INTERVAL` ticks, snapshot the
  // average candidate-set size across the bot's view. Smaller numbers mean
  // the bot has narrowed the puzzle further. The first half of the curve is
  // the most informative (it tells us how much the bot learned in the early
  // game); we capture that as the `earlyCoverage` metric.
  const KNOWLEDGE_SAMPLE_INTERVAL = 5;
  const knowledgeCurve = [];
  const maxTheoreticalScore = theoreticalMaxScore(room);

  while (ticks < maxTicks) {
    ticks += 1;
    if (room.phase === 'reveal' || room.phase === 'done') {
      finalTick = ticks;
      break;
    }
    if (KNOWLEDGE_SAMPLE_INTERVAL && ticks % KNOWLEDGE_SAMPLE_INTERVAL === 0) {
      knowledgeCurve.push(sampleAverageKnowledge(room, bot.id));
    }
    const view = viewFor(room, bot.id);
    const action = decideAction(room, bot.id, view);
    if (!action) {
      // Phase changed mid-loop (e.g. research phase opened); loop again to
      // pick up the new action shape on the next iteration.
      stalled += 1;
      if (stalled > 25) break;
      continue;
    }
    stalled = 0;
    const result = applyRoomAction(room, bot.id, action);
    if (!result.ok) {
      // The bot proposed a transient-illegal action (rare). Skip and retry.
      continue;
    }
    actionsApplied += 1;
    if (action.kind === 'locate') {
      const entry = room.session.entries[room.session.entries.length - 1];
      if (entry?.type === 'located' && entry.correct) locatedTick = ticks;
    }
    lastActionTick = ticks;
  }

  const finalScore = currentScore(room, bot.id);
  const completedCleanly = room.phase === 'reveal' || room.phase === 'done';

  return {
    puzzleId: hashPuzzle(puzzle),
    modeId,
    seed,
    ticks,
    actionsApplied,
    completedCleanly,
    locatedTick,
    finalTick: finalTick || lastActionTick,
    finalScore,
    maxTheoreticalScore,
    knowledgeCurve,
    // quick reject for puzzles that the bot cannot solve at all within the
    // tick budget — give them a placeholder so callers can decide what to do
    maxTicks,
    timedOut: ticks >= maxTicks && !completedCleanly,
  };
}

/**
 * Build a stable identifier for a puzzle from its `objects` array. We do not
 * hash the topics or conferences because the puzzles generated by the same
 * seed share those (research/conf are derived from the underlying board).
 */
export function hashPuzzle(puzzle) {
  if (!puzzle || !Array.isArray(puzzle.objects)) return 'invalid';
  return puzzle.objects.join('|');
}

function sampleAverageKnowledge(room, botId) {
  const view = viewFor(room, botId);
  if (!view || !view.mode) return 0;
  let total = 0;
  let counted = 0;
  // Use the bot's *visible* sectors as the denominator so the curve is
  // comparable across early and late game (visible rotates).
  const visible = Array.isArray(view.visible) ? view.visible : [];
  if (!visible.length) return 0;
  for (const sector of visible) {
    // The view does not expose `possible` directly; we infer knowledge from
    // the bot's own surveys / targets / theories for now. A future iteration
    // could pipe through the same constraint engine `computeKnowledge` uses.
    let sectorKnowledge = 6; // worst case: every object still possible
    const targets = view.knowledge?.targets || [];
    for (const target of targets) {
      if (target.sector === sector && target.apparent && target.apparent !== 'empty') {
        sectorKnowledge = 1;
      }
    }
    total += sectorKnowledge;
    counted += 1;
  }
  return counted ? total / counted : 0;
}

function currentScore(room, botId) {
  const player = room.players.find((entry) => entry.id === botId);
  if (!player) return 0;
  // score.js exports scoreBoard, but to keep this module self-contained we
  // walk the entries and accumulate the bot's contributions directly.
  let score = 0;
  const entries = room.session?.entries || [];
  for (const entry of entries) {
    if (entry.actorId !== botId) continue;
    if (entry.type === 'survey') score += 0;
    if (entry.type === 'target') score += 0;
    if (entry.type === 'research') score += 0;
    if (entry.type === 'located' && entry.correct) score += 10;
    if (entry.type === 'theory' && entry.review === 'correct') score += (entry.objectType === 'asteroid' ? 2 : entry.objectType === 'comet' ? 3 : 4);
    if (entry.type === 'theory' && entry.review === 'wrong') score -= 5;
  }
  return score;
}

/**
 * Upper bound of the score a perfect player could earn on this puzzle, given
 * the mode. Used to normalise the final-score component of the difficulty
 * metric. Conservative: a perfect player locates immediately, gets all
 * theories right, and lands all leader bonuses.
 */
function theoreticalMaxScore(room) {
  const mode = room.mode || room.session?.mode;
  if (!mode) return 30;
  // 10 for a correct locate + 1 leader bonus per theory sector + max theory
  // points. We round generously because exact accounting depends on object
  // counts; this is a normalisation, not a ledger.
  return 10 + 6 + 18;
}

/**
 * Reduce a bot simulation result into the [0, 1] composite difficulty score.
 *
 * composite = 0.6 * (roundsToLocate / totalRounds)
 *           + 0.4 * (1 - finalScore / maxScore)
 *
 * If the bot timed out without locating, we treat the locate component as 1
 * (worst case) and fall back on the final-score component only when no
 * score was ever recorded.
 */
export function scoreDifficulty(result) {
  if (!result || typeof result !== 'object') return 0;
  const maxScore = result.maxTheoreticalScore || 30;
  let locateComponent;
  if (result.locatedTick) {
    // The simulation stops when X is found, so finalTick is only a tick or
    // two after locatedTick. Divide by the tick budget, otherwise every
    // solved puzzle looks equally late.
    const budget = result.maxTicks || result.finalTick || result.ticks;
    locateComponent = clamp01(result.locatedTick / Math.max(1, budget));
  } else {
    locateComponent = 1; // bot never located — the hardest possible puzzle
  }
  let scoreComponent;
  if (result.finalScore > 0) {
    scoreComponent = clamp01(1 - result.finalScore / maxScore);
  } else if (result.timedOut) {
    scoreComponent = 1;
  } else {
    scoreComponent = 0.5;
  }
  return 0.6 * locateComponent + 0.4 * scoreComponent;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Given a list of composite scores for puzzles of the same mode, compute the
 * percentile breakpoints used to map new scores onto 1–5 stars.
 *
 * Returns an array of 4 ascending breakpoints: [p20, p40, p60, p80]. A score
 * strictly greater than the i-th breakpoint earns at least i+1 stars.
 */
export function rankDifficulties(scores) {
  const sorted = (Array.isArray(scores) ? scores : []).slice().filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return [0.2, 0.4, 0.6, 0.8];
  return [0.2, 0.4, 0.6, 0.8].map((percentile) => sampleAtPercentile(sorted, percentile));
}

function sampleAtPercentile(sorted, percentile) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(percentile * sorted.length)));
  return sorted[index];
}

/**
 * Map a composite score to a 1–5 star bucket using the breakpoints from
 * `rankDifficulties`. Returns 1 for the easiest quintile, 5 for the hardest.
 */
export function starsForScore(score, breakpoints) {
  const thresholds = breakpoints || [0.2, 0.4, 0.6, 0.8];
  let stars = 1;
  for (const threshold of thresholds) {
    if (score >= threshold) stars += 1;
  }
  return Math.min(5, Math.max(1, stars));
}
