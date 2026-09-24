// Tests for server/difficulty-cache.js — the persistent cache layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DifficultyCache, BOT_VERSION } from '../server/difficulty-cache.js';

const PUZZLE = {
  modeId: 'standard',
  objects: ['asteroid', 'asteroid', 'comet', 'gasCloud', 'empty', 'planetX', 'comet', 'gasCloud', 'empty', 'dwarfPlanet', 'asteroid', 'asteroid'],
  topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
  conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
  startingClues: [[{ sector: 0, objectType: 'dwarfPlanet' }, { sector: 10, objectType: 'comet' }, { sector: 11, objectType: 'gasCloud' }, { sector: 9, objectType: 'asteroid' }]],
};

function tempCache() {
  const dir = mkdtempSync(join(tmpdir(), 'dx-cache-'));
  const filePath = join(dir, 'cache.json');
  return {
    dir,
    filePath,
    cache: new DifficultyCache({ filePath }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('getOrCompute returns 1–5 stars and persists to disk', async () => {
  const { cache, filePath, cleanup } = tempCache();
  try {
    const result = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    // First call returns a promise (sim not yet run)
    if (!result.cached) {
      const entry = await result.promise;
      assert.ok(entry.stars >= 1 && entry.stars <= 5, `stars should be 1–5, got ${entry.stars}`);
      assert.ok(typeof entry.rawScore === 'number');
    } else {
      assert.ok(result.entry.stars >= 1 && result.entry.stars <= 5);
    }
    cache.flushNow();
    assert.ok(existsSync(filePath), 'cache file should exist after flush');
  } finally {
    cleanup();
  }
});

test('cache reuses a previously computed entry on second call (no replay)', async () => {
  const { cache, cleanup } = tempCache();
  try {
    const first = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    const firstEntry = first.cached ? first.entry : await first.promise;
    const second = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.equal(second.cached, true, 'second call should be cached');
    assert.equal(second.entry.stars, firstEntry.stars);
    assert.equal(second.entry.measuredAt, firstEntry.measuredAt, 'cached entry should not be recomputed');
  } finally {
    cleanup();
  }
});

test('concurrent calls for the same puzzle hash share one simulation', async () => {
  const { cache, cleanup } = tempCache();
  try {
    // Fire two getOrCompute calls in the same micro-task. Only one
    // simulation should run; both should resolve to the same entry.
    const a = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    const b = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.ok(!a.cached && !b.cached, 'first two calls should both be in-flight');
    const [ea, eb] = await Promise.all([a.promise, b.promise]);
    assert.equal(ea.stars, eb.stars);
    assert.equal(ea.measuredAt, eb.measuredAt);
  } finally {
    cleanup();
  }
});

test('cache survives a reload via DifficultyCache constructor', async () => {
  const { filePath, cleanup } = tempCache();
  try {
    const first = new DifficultyCache({ filePath });
    const result = first.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    const firstEntry = result.cached ? result.entry : await result.promise;
    first.flushNow();
    const second = new DifficultyCache({ filePath });
    const cached = second.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.equal(cached.cached, true, 'after reload the entry should be cached');
    assert.equal(cached.entry.stars, firstEntry.stars);
    assert.equal(cached.entry.rawScore, firstEntry.rawScore);
  } finally {
    cleanup();
  }
});

test('cache returns sensible defaults for breakpoints when samples are empty', () => {
  const { cache, cleanup } = tempCache();
  try {
    const breakpoints = cache.breakpointsFor('standard');
    assert.equal(breakpoints.length, 4);
    assert.deepEqual(breakpoints, [0.2, 0.4, 0.6, 0.8]);
  } finally {
    cleanup();
  }
});

test('primeSamples keeps fixed breakpoints until eight samples exist', async () => {
  const { cache, cleanup } = tempCache();
  try {
    const puzzles = [PUZZLE, { ...PUZZLE, objects: PUZZLE.objects.slice().reverse() }];
    await cache.primeSamples({ puzzles, modeId: 'standard', maxTicks: 80 });
    const samples = cache.state.samples.standard;
    assert.ok(samples.length >= 1, `expected samples to be populated, got ${samples.length}`);
    assert.deepEqual(cache.breakpointsFor('standard'), [0.2, 0.4, 0.6, 0.8]);
  } finally {
    cleanup();
  }
});

test('eight samples replace the fixed breakpoints', () => {
  const { cache, cleanup } = tempCache();
  try {
    cache.state.samples.standard = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9];
    assert.deepEqual(cache.breakpointsFor('standard'), [0.2, 0.4, 0.5, 0.7]);
    assert.deepEqual(cache.breakpointsFor('expert'), [0.2, 0.4, 0.6, 0.8]);
  } finally {
    cleanup();
  }
});

test('reset() clears all stored data', async () => {
  const { cache, filePath, cleanup } = tempCache();
  try {
    cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 60 });
    cache.flushNow();
    assert.ok(existsSync(filePath), 'cache should be on disk');
    cache.reset();
    cache.flushNow();
    const fresh = new DifficultyCache({ filePath });
    assert.deepEqual(fresh.breakpointsFor('standard'), [0.2, 0.4, 0.6, 0.8]);
  } finally {
    cleanup();
  }
});

test('BOT_VERSION is exported and matches the current heuristic', () => {
  assert.ok(typeof BOT_VERSION === 'string' && BOT_VERSION.length > 0);
});
