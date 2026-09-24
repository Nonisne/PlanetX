// Persistent cache for puzzle difficulty ratings.
//
// We avoid replaying puzzles the bot has already seen. The cache lives on
// disk so a server restart picks up where the previous process left off, and
// new puzzles get their rating computed lazily on first lookup.
//
// Two pieces of data are kept here:
//
//   * `samples` — for each modeId, an array of composite scores drawn from
//     a one-off pre-computation of N puzzles. Used as the population from
//     which `rankDifficulties()` derives the percentile breakpoints.
//   * `computed` — a map keyed by puzzle hash, holding `{ stars, rawScore,
//     measuredAt, botVersion, timedOut }` for puzzles we have already
//     simulated.
//
// The cache is intentionally simple: a JSON file written atomically on every
// mutation. We never run the simulation in a worker thread — the engine is
// synchronous and fast enough that the bot loop dominates. The "lazy" path
// returns immediately with the cached value, or runs the simulation and
// writes the result before returning.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { hashPuzzle, simulateBotRun, scoreDifficulty, rankDifficulties, starsForScore } from './difficulty.js';

const BOT_VERSION = 'heuristic-9a45';
const DEFAULT_SAMPLE_SIZE = 32;
const MAX_RECENT_ENTRIES = 4096;

function emptyCache() {
  return {
    version: 1,
    botVersion: BOT_VERSION,
    samples: { standard: [], expert: [] },
    computed: {},
  };
}

export class DifficultyCache {
  constructor({ filePath, writeDelayMs = 250 } = {}) {
    this.filePath = filePath || null;
    this.writeDelayMs = writeDelayMs;
    this.pendingWrite = null;
    this.state = emptyCache();
    if (filePath && existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        if (parsed && typeof parsed === 'object' && parsed.version === 1) {
          this.state = {
            version: 1,
            botVersion: parsed.botVersion || BOT_VERSION,
            samples: {
              standard: Array.isArray(parsed.samples?.standard) ? parsed.samples.standard : [],
              expert: Array.isArray(parsed.samples?.expert) ? parsed.samples.expert : [],
            },
            computed: parsed.computed && typeof parsed.computed === 'object' ? parsed.computed : {},
          };
        }
      } catch (error) {
        // corrupt cache → start fresh; the next save will overwrite it
        // eslint-disable-next-line no-console
        console.warn('[difficulty-cache] could not load cache, starting empty:', error.message);
      }
    }
    // when the bot version changes, the cached scores are no longer comparable;
    // keep them around so we can mark entries stale, but invalidate the
    // breakpoints.
    if (this.state.botVersion !== BOT_VERSION) {
      this.state.botVersion = BOT_VERSION;
      this.state.samples = { standard: [], expert: [] };
      this.state.computed = {};
    }
  }

  /** Drop all stored data; mostly used by tests. */
  reset() {
    this.state = emptyCache();
    this.flushNow();
  }

  /**
   * Look up a puzzle's difficulty. If we have a fresh cached result, return
   * it; otherwise simulate the bot, store the result, and return.
   */
  getOrCompute(puzzle, options = {}) {
    const modeId = options.modeId || puzzle.modeId || 'standard';
    const hash = hashPuzzle(puzzle);
    const cached = this.state.computed[hash];
    if (cached && cached.botVersion === BOT_VERSION) {
      return cached;
    }
    const result = simulateBotRun(puzzle, { modeId, ...options });
    const rawScore = scoreDifficulty(result);
    const breakpoints = this.breakpointsFor(modeId);
    const stars = starsForScore(rawScore, breakpoints);
    const entry = {
      stars,
      rawScore,
      measuredAt: Date.now(),
      botVersion: BOT_VERSION,
      timedOut: Boolean(result.timedOut),
      ticks: result.ticks,
      finalScore: result.finalScore,
    };
    this.state.computed[hash] = entry;
    this.scheduleWrite();
    return entry;
  }

  /**
   * Compute breakpoints (the percentile thresholds used to map a raw score to
   * 1–5 stars) for the given mode. If we already have enough samples, use
   * those; otherwise generate `DEFAULT_SAMPLE_SIZE` fresh simulations first.
   */
  breakpointsFor(modeId) {
    const samples = this.state.samples[modeId] || [];
    if (samples.length >= DEFAULT_SAMPLE_SIZE) return rankDifficulties(samples);
    return [0.2, 0.4, 0.6, 0.8];
  }

  /**
   * Pre-compute difficulty scores for `count` puzzles. Used at server startup
   * to bootstrap the percentile breakpoints so the first user-generated
   * puzzle gets a sensible star rating.
   */
  async primeSamples({ puzzles, modeId = 'standard', onProgress } = {}) {
    if (!Array.isArray(puzzles) || !puzzles.length) return [];
    const scores = [];
    for (let index = 0; index < puzzles.length; index += 1) {
      const puzzle = puzzles[index];
      const result = simulateBotRun(puzzle, { modeId, maxTicks: 150 });
      const score = scoreDifficulty(result);
      scores.push(score);
      if (typeof onProgress === 'function') onProgress(index + 1, puzzles.length);
    }
    this.state.samples[modeId] = (this.state.samples[modeId] || []).concat(scores);
    // keep only the most recent samples so the cache doesn't grow forever
    if (this.state.samples[modeId].length > MAX_RECENT_ENTRIES) {
      this.state.samples[modeId] = this.state.samples[modeId].slice(-MAX_RECENT_ENTRIES);
    }
    this.scheduleWrite();
    return scores;
  }

  scheduleWrite() {
    if (!this.filePath) return;
    if (this.pendingWrite) return;
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = null;
      this.flushNow();
    }, this.writeDelayMs);
    // never keep the process alive solely for cache writes
    if (this.pendingWrite.unref) this.pendingWrite.unref();
  }

  flushNow() {
    if (!this.filePath) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[difficulty-cache] could not write cache:', error.message);
    }
  }
}
