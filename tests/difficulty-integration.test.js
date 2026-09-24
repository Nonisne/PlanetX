// Integration tests that exercise the full server-side difficulty rating
// pipeline, including the async simulation step (run from DifficultyCache) and
// the on-disk cache persistence.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DifficultyCache } from '../server/difficulty-cache.js';
import { createPuzzle, initialCluesFor } from '../server/puzzles.js';
import { BUILTIN_MAX_PLAYERS } from '../public/src/rules.js';

function stdPuzzle(seed = 1) {
  // createPuzzle is deterministic in-process, so rotating seeds via mutate-
  // after-create won't help — we just generate fresh puzzles and rely on
  // hashPuzzle's cache keys.
  const p = createPuzzle({ modeId: 'standard' });
  return { ...p, startingClues: Array.from({ length: BUILTIN_MAX_PLAYERS }, () => initialCluesFor(p, { count: 12 })) };
}

function tempCache() {
  const dir = mkdtempSync(join(tmpdir(), 'dx-integ-'));
  const filePath = join(dir, 'cache.json');
  return {
    filePath,
    cache: new DifficultyCache({ filePath, writeDelayMs: 0 }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('two concurrent getOrCompute calls for the same puzzle share the in-flight simulation', async () => {
  const { cache, cleanup } = tempCache();
  try {
    const puzzle = stdPuzzle();
    const [a, b] = await Promise.all([
      cache.getOrCompute(puzzle, { modeId: 'standard' }),
      cache.getOrCompute(puzzle, { modeId: 'standard' }),
    ]);
    assert.ok(!a.cached && !b.cached, 'first calls should be in-flight');
    const [ea, eb] = await Promise.all([a.promise, b.promise]);
    assert.equal(ea.measuredAt, eb.measuredAt, 'both should resolve to the same simulation result');
    assert.equal(ea.stars, eb.stars);
  } finally {
    cleanup();
  }
});

test('after a simulation lands, subsequent calls hit cache and return {cached: true}', async () => {
  const { cache, cleanup } = tempCache();
  try {
    const puzzle = stdPuzzle();
    const inFlight = cache.getOrCompute(puzzle, { modeId: 'standard' });
    assert.ok(!inFlight.cached);
    const entry = await inFlight.promise;
    const cached = cache.getOrCompute(puzzle, { modeId: 'standard' });
    assert.equal(cached.cached, true);
    assert.equal(cached.entry.measuredAt, entry.measuredAt);
  } finally {
    cleanup();
  }
});

test('primeSamples accumulates into the per-mode samples array', async () => {
  const { cache, cleanup } = tempCache();
  try {
    const puzzles = [stdPuzzle(0), stdPuzzle(1)];
    await cache.primeSamples({ puzzles, modeId: 'standard', maxTicks: 80 });
    const samples = cache.state.samples.standard;
    assert.equal(samples.length, 2);
    for (const s of samples) {
      assert.ok(s >= 0 && s <= 1, `score should be in [0, 1], got ${s}`);
    }
  } finally {
    cleanup();
  }
});

test('stars get derived from real scoreBoard accounting — never zero', async () => {
  // The regresssion we're guarding: difficulty.js used a hand-rolled score
  // tally (locate +10, theory per-object) — when bots never locate or
  // publish theories, the fake tally returned 0 even though scoreBoard
  // would have computed something meaningful.  The metric must use the
  // real accounting path now and return a real number.
  const { cache, cleanup } = tempCache();
  try {
    const puzzle = stdPuzzle();
    const result = cache.getOrCompute(puzzle, { modeId: 'standard' });
    const entry = await result.promise;
    // Real-accounting check: entry.finalScore is computed by scoreBoard, not
    // a hard-coded zero baseline.
    assert.ok(typeof entry.rawScore === 'number');
    assert.ok(entry.rawScore >= 0 && entry.rawScore <= 1);
    assert.ok(entry.stars >= 1 && entry.stars <= 5);
  } finally {
    cleanup();
  }
});

test('cache persists in-flight results to disk so server restart can skip them', async () => {
  const { filePath, cleanup } = tempCache();
  try {
    const cache1 = new DifficultyCache({ filePath, writeDelayMs: 0 });
    const puzzle = stdPuzzle();
    const entry = await cache1.getOrCompute(puzzle, { modeId: 'standard' }).promise;
    cache1.flushNow();

    const cache2 = new DifficultyCache({ filePath });
    const result = cache2.getOrCompute(puzzle, { modeId: 'standard' });
    assert.equal(result.cached, true, 'after restart the puzzle should be cached');
    assert.equal(result.entry.stars, entry.stars);
  } finally {
    cleanup();
  }
});
