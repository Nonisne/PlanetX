// Tests for server/difficulty-cache.js — the persistent cache layer.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DifficultyCache } from '../server/difficulty-cache.js';

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

test('cache returns a 1–5 star rating and persists to disk', () => {
  const { cache, filePath, cleanup } = tempCache();
  try {
    const result = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.ok(result.stars >= 1 && result.stars <= 5, `stars should be 1–5, got ${result.stars}`);
    assert.ok(typeof result.rawScore === 'number');
    cache.flushNow();
    assert.ok(existsSync(filePath), 'cache file should exist after flush');
  } finally {
    cleanup();
  }
});

test('cache reuses a previously computed entry on second call (no replay)', () => {
  const { cache, cleanup } = tempCache();
  try {
    const first = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    const firstTicks = first.ticks;
    const second = cache.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.equal(second.ticks, firstTicks, 'cached entry should preserve the original ticks');
    assert.equal(second.stars, first.stars, 'cached entry should preserve the original stars');
    assert.equal(second.measuredAt, first.measuredAt, 'cached entry should not be recomputed');
  } finally {
    cleanup();
  }
});

test('cache survives a reload via DifficultyCache constructor', () => {
  const { filePath, cleanup } = tempCache();
  try {
    const first = new DifficultyCache({ filePath });
    const result = first.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    first.flushNow();
    const second = new DifficultyCache({ filePath });
    const cached = second.getOrCompute(PUZZLE, { modeId: 'standard', maxTicks: 80 });
    assert.equal(cached.stars, result.stars);
    assert.equal(cached.rawScore, result.rawScore);
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

test('reset() clears all stored data', () => {
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
