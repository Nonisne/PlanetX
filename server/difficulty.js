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
//   1. `simulateBotRun(puzzle, options)` (async generator) — drives the bot
//      through one full game step by step, yielding to the event loop between
//      steps so the server stays responsive. Callers run the generator to
//      completion and receive the final result object.
//   2. `scoreDifficulty(result)` — collapse the observations into a single
//      [0, 1] composite number.
//   3. `rankDifficulties(scores)` — turn a sample of scores into per-mode
//      percentile breakpoints so any new puzzle's score can be mapped to a
//      1–5 star bucket.
//
// The cache layer (difficulty-cache.js) stores both the percentile breakpoints
// and the per-puzzle results so we don't replay puzzles the bot has already
// seen. The cache is keyed by the puzzle's objects array hash, so changing
// the heuristic bot invalidates only when the cached `botVersion` no longer
// matches.

import { applyRoomAction, createRoom, viewFor } from '../public/src/room.js';
import { decideAction } from './bot.js';
import { scoreBoard } from '../public/src/score.js';

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
 * Async-generator wrapper.  Each step yields to the event loop via
 * `await new Promise(setImmediate)` so the server stays responsive while the
 * simulation runs in the background.  The terminal yield carries `_done: true`
 * plus the full result object.
 */
export async function* simulateBotRun(puzzle, options = {}) {
  const { modeId = 'standard', initialClueCount = 4, maxTicks = DEFAULT_MAX_TICKS, seed = DEFAULT_SEED } = options;
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
  const bot = room.players.find((player) => player.id === room.hostId);
  bot.bot = true;
  room.rng = makeRng(seed);

  const hostStart = applyRoomAction(room, room.hostId, { kind: 'start-game' });
  if (!hostStart.ok) {
    throw new Error(`simulateBotRun: start-game refused (${hostStart.error})`);
  }
  const setup = applyRoomAction(room, room.hostId, { kind: 'setup' });
  if (!setup.ok) {
    throw new Error(`simulateBotRun: setup refused (${setup.error})`);
  }
  if (room.phase !== 'play') {
    throw new Error(`simulateBotRun: room did not enter play phase (phase=${room.phase})`);
  }

  const maxTheoreticalScore = theoreticalMaxScore(room);
  let lastActionTick = 0;
  let ticks = 0;
  let stalled = 0;
  let locatedTick = null;
  let finalTick = 0;
  let actionsApplied = 0;
  const knowledgeCurve = [];

  while (ticks < maxTicks) {
    ticks += 1;
    if (room.phase === 'reveal' || room.phase === 'done') {
      finalTick = ticks;
      break;
    }
    const view = viewFor(room, bot.id);
    const action = decideAction(room, bot.id, view);
    if (!action) {
      stalled += 1;
      if (stalled > 25) break;
      await new Promise((resolve) => setImmediate(resolve));
      yield { _progress: true, ticks, actionsApplied, locatedTick };
      continue;
    }
    stalled = 0;
    const result = applyRoomAction(room, bot.id, action);
    if (!result.ok) continue;
    actionsApplied += 1;
    if (action.kind === 'locate') {
      const entry = room.session.entries[room.session.entries.length - 1];
      if (entry?.type === 'located' && entry.correct) locatedTick = ticks;
    }
    lastActionTick = ticks;
    await new Promise((resolve) => setImmediate(resolve));
    yield { _progress: true, ticks, actionsApplied, locatedTick };
  }

  const finalScore = botScore(room, bot.id);
  const completedCleanly = room.phase === 'reveal' || room.phase === 'done';
  yield {
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
    maxTicks,
    timedOut: ticks >= maxTicks && !completedCleanly,
    _done: true,
  };
}

/**
 * Sync helper for tests: runs the simulator body without yielding to the
 * event loop.  Used by the test suite to keep wall-clock time short.
 *
 * Internally this is the same logic as `simulateBotRun` minus the per-step
 * `await setImmediate`.  Production code should use `simulateBotRun` instead.
 */
export function simulateBotRunSync(puzzle, options = {}) {
  const { modeId = 'standard', initialClueCount = 4, maxTicks = DEFAULT_MAX_TICKS, seed = DEFAULT_SEED } = options;
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
  const bot = room.players.find((player) => player.id === room.hostId);
  bot.bot = true;
  room.rng = makeRng(seed);

  const hostStart = applyRoomAction(room, room.hostId, { kind: 'start-game' });
  if (!hostStart.ok) {
    throw new Error(`simulateBotRun: start-game refused (${hostStart.error})`);
  }
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
  const maxTheoreticalScore = theoreticalMaxScore(room);

  while (ticks < maxTicks) {
    ticks += 1;
    if (room.phase === 'reveal' || room.phase === 'done') {
      finalTick = ticks;
      break;
    }
    const view = viewFor(room, bot.id);
    const action = decideAction(room, bot.id, view);
    if (!action) {
      stalled += 1;
      if (stalled > 25) break;
      continue;
    }
    stalled = 0;
    const result = applyRoomAction(room, bot.id, action);
    if (!result.ok) continue;
    actionsApplied += 1;
    if (action.kind === 'locate') {
      const entry = room.session.entries[room.session.entries.length - 1];
      if (entry?.type === 'located' && entry.correct) locatedTick = ticks;
    }
    lastActionTick = ticks;
  }

  const finalScore = botScore(room, bot.id);
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
    knowledgeCurve: [],
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

/**
 * The score for the bot player at the end of a simulation, using the same
 * scoring rules the real game uses (theory points, leader bonuses, locate
 * bonus).  Passes the full `room.session` state through scoreBoard so the
 * bot's entry timestamps are respected.
 */
function botScore(room, botId) {
  const player = room.players.find((p) => p.id === botId);
  if (!player || !room.session) return 0;
  const board = scoreBoard(room.session, [player]);
  const row = board.rows.find((r) => r.id === botId);
  return row ? row.total : 0;
}

/**
 * Theoretical maximum score for this room's mode: the best-case score
 * achievable by any player with perfect knowledge of the board.
 */
function theoreticalMaxScore(room) {
  const mode = room.mode || room.session?.mode;
  if (!mode) return 30;
  // Count ordinary objects (theories) per mode.
  const theorySectors = mode.sectors - 1 - 1; // minus PlanetX minus empties
  const theoryPoints = theorySectors * 4; // worst case: all are gasCloud (highest)
  return 10 + theoryPoints; // locate-first bonus + all theory points
}

/**
 * Reduce a bot simulation result into the [0, 1] composite difficulty score.
 * Larger values = harder puzzle.
 *
 * locateComponent:
 *   - located in tick N: N / MAX_TICKS
 *   - never located: 1
 *
 * scoreComponent:
 *   - finalScore ≤ maxScore: 1 - finalScore / maxScore  (lower score = harder)
 *   - negative scores count normally (more negative = harder)
 *   - timed out without locating: handled by the never-located path above
 *
 * composite = 0.6 * locateComponent + 0.4 * scoreComponent
 */
export function scoreDifficulty(result) {
  if (!result || typeof result !== 'object') return 0;
  const budget = result.maxTicks || 200;
  const maxScore = result.maxTheoreticalScore || 30;

  let locateComponent;
  if (result.locatedTick) {
    // Stop as soon as X is found: divide by the full tick budget so
    // early solves score low and late solves score high.
    locateComponent = clamp01(result.locatedTick / budget);
  } else {
    locateComponent = 1; // never located — worst case
  }

  // finalScore can be negative (wrong theories); use it directly.
  const scoreComponent = clamp01(1 - result.finalScore / maxScore);

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
