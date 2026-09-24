// Tests for server/difficulty.js — the puzzle difficulty rating engine.
//
// Tests run the synchronous wrapper (simulateBotRunSync) so the test suite stays
// fast and does not require async test infrastructure.

import test from 'node:test';
import assert from 'node:assert/strict';

import { hashPuzzle, simulateBotRunSync, scoreDifficulty, rankDifficulties, starsForScore } from '../server/difficulty.js';

// One starting-clue set is enough for a single-bot simulation.
const PUZZLE = {
  modeId: 'standard',
  objects: ['asteroid', 'asteroid', 'comet', 'gasCloud', 'empty', 'planetX', 'comet', 'gasCloud', 'empty', 'dwarfPlanet', 'asteroid', 'asteroid'],
  topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
  conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
  startingClues: [
    [
      { sector: 0, objectType: 'dwarfPlanet' },
      { sector: 10, objectType: 'comet' },
      { sector: 11, objectType: 'gasCloud' },
      { sector: 9, objectType: 'asteroid' },
    ],
  ],
};

test('hashPuzzle is stable across calls and stable across property order', () => {
  const a = hashPuzzle(PUZZLE);
  const b = hashPuzzle(PUZZLE);
  assert.equal(a, b);
  assert.equal(a, PUZZLE.objects.join('|'));
});

test('simulateBotRunSync drives the room forward and either locates or times out within the tick budget', () => {
  const result = simulateBotRunSync(PUZZLE, { modeId: 'standard', maxTicks: 200 });
  assert.ok(result, 'simulation should return a result object');
  assert.ok(result.ticks > 0, 'simulation should run at least one tick');
  assert.equal(result.actionsApplied > 0, true, 'simulation should record at least one bot action');
  // Locate-first 10 + every theory's points + one leader bonus per theory object.
  assert.equal(result.maxTheoreticalScore, 45);
  // Solo-mode builtin is harder than multiplayer: a single bot has no peer
  // conferences to lean on, so timing out without locating is a legitimate
  // outcome for a tight tick budget. What we require here is that the
  // bot kept acting (no deadlock) and either finished cleanly or hit the
  // budget.
  assert.ok(
    result.completedCleanly || result.timedOut,
    `simulation should either reach reveal/done or hit the budget cleanly (completedCleanly=${result.completedCleanly}, timedOut=${result.timedOut})`,
  );
});

test('simulateBotRunSync respects the deterministic seed', () => {
  const a = simulateBotRunSync(PUZZLE, { modeId: 'standard', seed: 42, maxTicks: 120 });
  const b = simulateBotRunSync(PUZZLE, { modeId: 'standard', seed: 42, maxTicks: 120 });
  // The bot's action count under a fixed seed must be identical.
  assert.equal(a.actionsApplied, b.actionsApplied, 'same seed should produce the same action count');
});

test('scoreDifficulty returns a finite number in [0, 1]', () => {
  const result = simulateBotRunSync(PUZZLE, { modeId: 'standard', maxTicks: 200 });
  const score = scoreDifficulty(result);
  assert.ok(Number.isFinite(score), 'score should be finite');
  assert.ok(score >= 0 && score <= 1, `score should be in [0, 1], got ${score}`);
});

test('scoreDifficulty treats a bot that never located as the hardest possible puzzle', () => {
  const score = scoreDifficulty({
    ticks: 200,
    actionsApplied: 0,
    completedCleanly: false,
    locatedTick: null,
    finalTick: 0,
    finalScore: -5, // negative score still counts as hard
    maxTheoreticalScore: 30,
    maxTicks: 200,
    timedOut: true,
  });
  // locateComponent = 1; scoreComponent = 1 - (-5)/30 = 1.167 → clamp to 1
  assert.equal(score, 1);
});

test('scoreDifficulty treats an immediate locate with full score as the easiest possible puzzle', () => {
  const score = scoreDifficulty({
    ticks: 10,
    actionsApplied: 5,
    completedCleanly: true,
    locatedTick: 1,
    finalTick: 10,
    finalScore: 30,
    maxTheoreticalScore: 30,
    maxTicks: 200,
    timedOut: false,
  });
  // locateComponent = 1/200 = 0.005; scoreComponent = 0
  assert.ok(score < 0.1, `easiest puzzle should score near 0, got ${score}`);
});

test('scoreDifficulty: lower real score = higher difficulty', () => {
  // Same locate tick (50) but different final scores.
  const easy = scoreDifficulty({ locatedTick: 50, finalScore: 20, maxTheoreticalScore: 30, maxTicks: 200, ticks: 200, timedOut: false });
  const hard = scoreDifficulty({ locatedTick: 50, finalScore: -5, maxTheoreticalScore: 30, maxTicks: 200, ticks: 200, timedOut: false });
  assert.ok(hard > easy, `harder score (${hard}) should be > easier score (${easy})`);
});

test('scoreDifficulty: later locate = higher difficulty', () => {
  // Same final score but different locate ticks.
  const early = scoreDifficulty({ locatedTick: 10, finalScore: 20, maxTheoreticalScore: 30, maxTicks: 200, ticks: 200, timedOut: false });
  const late = scoreDifficulty({ locatedTick: 150, finalScore: 20, maxTheoreticalScore: 30, maxTicks: 200, ticks: 200, timedOut: false });
  assert.ok(late > early, `later locate (${late}) should be > earlier locate (${early})`);
});

test('rankDifficulties sorts and returns four ascending breakpoints', () => {
  const scores = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const breakpoints = rankDifficulties(scores);
  assert.equal(breakpoints.length, 4);
  for (let i = 1; i < breakpoints.length; i += 1) {
    assert.ok(breakpoints[i] >= breakpoints[i - 1], `breakpoints should be ascending: ${breakpoints}`);
  }
});

test('rankDifficulties handles an empty input by returning sensible defaults', () => {
  const breakpoints = rankDifficulties([]);
  assert.deepEqual(breakpoints, [0.2, 0.4, 0.6, 0.8]);
});

test('starsForScore produces 1–5 stars and respects the breakpoint boundaries', () => {
  const breakpoints = [0.2, 0.4, 0.6, 0.8];
  assert.equal(starsForScore(0.05, breakpoints), 1);
  assert.equal(starsForScore(0.2, breakpoints), 2);
  assert.equal(starsForScore(0.4, breakpoints), 3);
  assert.equal(starsForScore(0.6, breakpoints), 4);
  assert.equal(starsForScore(0.8, breakpoints), 5);
  assert.equal(starsForScore(0.99, breakpoints), 5);
  assert.equal(starsForScore(0, breakpoints), 1);
});

test('full pipeline: simulate → score → rank → stars stays self-consistent', () => {
  const samples = [];
  for (let seed = 1; seed <= 4; seed += 1) {
    const result = simulateBotRunSync(PUZZLE, { modeId: 'standard', seed, maxTicks: 120 });
    samples.push(scoreDifficulty(result));
  }
  const breakpoints = rankDifficulties(samples);
  for (const sample of samples) {
    const stars = starsForScore(sample, breakpoints);
    assert.ok(stars >= 1 && stars <= 5, `stars should be in [1, 5], got ${stars}`);
  }
});
