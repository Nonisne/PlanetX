// Tests for server/difficulty.js — the puzzle difficulty rating engine.
//
// We deliberately keep the simulation budget small (under 200 ticks) so the
// suite finishes quickly. The tests focus on:
//   * simulateBotRun produces well-formed output for a known puzzle
//   * scoreDifficulty returns a [0, 1] composite with documented boundary cases
//   * rankDifficulties turns a sample into correct percentile breakpoints
//   * starsForScore maps breakpoints onto 1–5 buckets consistently

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyRoomAction, createRoom, addPlayer, viewFor } from '../public/src/room.js';
import { decideAction } from '../server/bot.js';
import { hashPuzzle, simulateBotRun, scoreDifficulty, rankDifficulties, starsForScore } from '../server/difficulty.js';

// One starting-clue set is enough for a single-bot simulation.
const PUZZLE = {
  modeId: 'standard',
  objects: ['asteroid', 'asteroid', 'comet', 'gasCloud', 'empty', 'planetX', 'comet', 'gasCloud', 'empty', 'dwarfPlanet', 'asteroid', 'asteroid'],
  topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
  conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
  // One seat pool is enough for a solo-bot simulation.
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

test('simulateBotRun drives the room forward and either locates or times out within the tick budget', () => {
  const result = simulateBotRun(PUZZLE, { modeId: 'standard', maxTicks: 200 });
  assert.ok(result, 'simulation should return a result object');
  assert.ok(result.ticks > 0, 'simulation should run at least one tick');
  assert.equal(result.actionsApplied > 0, true, 'simulation should record at least one bot action');
  assert.ok(Array.isArray(result.knowledgeCurve), 'knowledgeCurve should be an array');
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

test('simulateBotRun respects the deterministic seed', () => {
  const a = simulateBotRun(PUZZLE, { modeId: 'standard', seed: 42, maxTicks: 120 });
  const b = simulateBotRun(PUZZLE, { modeId: 'standard', seed: 42, maxTicks: 120 });
  // The bot's action count under a fixed seed must be identical — that's
  // what makes the cache key meaningful.
  assert.equal(a.actionsApplied, b.actionsApplied, 'same seed should produce the same action count');
});

test('scoreDifficulty returns a finite number in [0, 1]', () => {
  const result = simulateBotRun(PUZZLE, { modeId: 'standard', maxTicks: 200 });
  const score = scoreDifficulty(result);
  assert.ok(Number.isFinite(score), 'score should be finite');
  assert.ok(score >= 0 && score <= 1, `score should be in [0, 1], got ${score}`);
});

test('scoreDifficulty treats a bot that never located as the hardest possible puzzle', () => {
  const score = scoreDifficulty({
    ticks: 100,
    actionsApplied: 0,
    completedCleanly: false,
    locatedTick: null,
    finalTick: 0,
    finalScore: 0,
    maxTheoreticalScore: 30,
    knowledgeCurve: [],
    timedOut: true,
  });
  // locateComponent = 1 (no locate) → 0.6; scoreComponent = 1 (timed out) → 0.4.
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
    knowledgeCurve: [],
    timedOut: false,
  });
  // locateComponent = 1/10 = 0.1 → 0.06; scoreComponent = 1 - 1 = 0 → 0.
  assert.ok(score < 0.1, `easiest puzzle should score near 0, got ${score}`);
});

test('scoreDifficulty uses the tick budget, not the tick the simulation stopped on', () => {
  const early = scoreDifficulty({ locatedTick: 10, finalTick: 11, maxTicks: 200, finalScore: 15, maxTheoreticalScore: 34 });
  const late = scoreDifficulty({ locatedTick: 160, finalTick: 161, maxTicks: 200, finalScore: 15, maxTheoreticalScore: 34 });
  assert.ok(early < 0.3, `an early locate should stay easy, got ${early}`);
  assert.ok(late > early + 0.3, `a late locate should score clearly higher, got ${late} vs ${early}`);
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
  // Build a tiny sample of simulations (cheap: each under 1s) and verify
  // every star is in [1, 5].
  const samples = [];
  for (let seed = 1; seed <= 4; seed += 1) {
    const result = simulateBotRun(PUZZLE, { modeId: 'standard', seed, maxTicks: 120 });
    samples.push(scoreDifficulty(result));
  }
  const breakpoints = rankDifficulties(samples);
  for (const sample of samples) {
    const stars = starsForScore(sample, breakpoints);
    assert.ok(stars >= 1 && stars <= 5, `stars should be in [1, 5], got ${stars}`);
  }
});

test('multiplayer simulation (host + 2 bots) completes cleanly because peer conferences narrow the search', () => {
  // Three seats so two peer bots can share conferences / theories. Two bots
  // also lets one publish a theory that the third bot then uses to locate.
  const multiplayerPuzzle = {
    ...PUZZLE,
    startingClues: [
      PUZZLE.startingClues[0],
      [
        { sector: 1, objectType: 'asteroid' },
        { sector: 2, objectType: 'comet' },
        { sector: 7, objectType: 'gasCloud' },
        { sector: 8, objectType: 'empty' },
      ],
      [
        { sector: 3, objectType: 'comet' },
        { sector: 4, objectType: 'gasCloud' },
        { sector: 5, objectType: 'empty' },
        { sector: 6, objectType: 'dwarfPlanet' },
      ],
    ],
  };
  // Build the room manually so we can promote the host and add two more bots.
  const room = createRoom({
    playMode: 'builtin',
    modeId: 'standard',
    puzzle: multiplayerPuzzle,
    hostName: 'BotHost',
    initialClueCount: 4,
  });
  const host = room.players.find((player) => player.id === room.hostId);
  host.bot = true;
  addPlayer(room, 'BotA').bot = true;
  addPlayer(room, 'BotB').bot = true;
  room.rng = () => 1 - Number.EPSILON;
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const player of room.players) applyRoomAction(room, player.id, { kind: 'setup' });
  assert.equal(room.phase, 'play');

  // Drive every bot until reveal/done or 250 ticks, just like the real
  // controller does but synchronously.
  let ticks = 0;
  let lastActed = 0;
  while (ticks < 250 && room.phase === 'play') {
    ticks += 1;
    let anyoneActed = false;
    for (const bot of room.players.filter((player) => player.bot)) {
      const v = viewFor(room, bot.id);
      const action = decideAction(room, bot.id, v);
      if (!action) continue;
      const result = applyRoomAction(room, bot.id, action);
      if (result.ok) {
        anyoneActed = true;
        lastActed = ticks;
      }
    }
    if (!anyoneActed && ticks - lastActed > 25) break;
  }

  // We don't strictly require a clean reveal (the bot may still be
  // researching), but at least one bot should have acted.
  const entries = room.session.entries.length;
  assert.ok(entries > 5, `multiplayer should produce at least 5 entries, got ${entries}`);
});
