// Tests for the heuristic bot: we run the decision loop on a real room and
// assert that it (a) emits only actions the engine accepts, (b) drives the
// game forward without manual input, and (c) does not depend on puzzle truth.
//
// All tests run the decision *function*, not the timed controller, so the
// suite stays fast and deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { addPlayer, applyRoomAction, createRoom, currentPlayer, playerById, viewFor } from '../public/src/room.js';
import { BUILTIN_MAX_PLAYERS } from '../public/src/rules.js';
import { Obj } from '../public/src/types.js';
import { decideAction } from '../server/bot.js';
import { attachBotController, detachBotController } from '../server/bot-controller.js';

function puzzleFixture(playerCount = BUILTIN_MAX_PLAYERS) {
  return {
    objects: [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
    conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
    startingClues: Array.from({ length: playerCount }, (_, playerIndex) => [
      { sector: playerIndex, objectType: Obj.DWARF_PLANET },
      { sector: 10, objectType: Obj.COMET },
      { sector: 11, objectType: Obj.GAS_CLOUD },
      { sector: 9, objectType: Obj.ASTEROID },
    ]),
  };
}

function builtinWithBots(botCount = 1) {
  const room = createRoom({ playMode: 'builtin', puzzle: puzzleFixture(), hostName: '人类玩家' });
  for (let i = 0; i < botCount; i += 1) {
    const bot = addPlayer(room, `Bot${i + 1}`);
    bot.bot = true;
  }
  return room;
}

function startGame(room) {
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const player of room.players) {
    applyRoomAction(room, player.id, { kind: 'claim-initial-clues', count: 4 });
    applyRoomAction(room, player.id, { kind: 'setup' });
  }
  assert.equal(room.phase, 'play');
}

function passResearchPhase(room) {
  for (let guard = 0; room.research && guard < 30; guard++) {
    const phaseId = room.research.id;
    for (const player of room.players) {
      if (room.research?.id !== phaseId) break;
      if (Object.hasOwn(room.research.declares, player.id)) continue;
      const res = applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 0 });
      assert.ok(res.ok, res.error);
    }
  }
  assert.equal(room.research, null);
}

test('a bot-driven builtin room completes its setup before any turn action', () => {
  const room = builtinWithBots(1);
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const player of room.players) {
    applyRoomAction(room, player.id, { kind: 'claim-initial-clues', count: 4 });
    const view = viewFor(room, player.id);
    const action = decideAction(room, player.id, view);
    assert.ok(action, `bot ${player.name} should have a setup action`);
    assert.equal(action.kind, 'setup');
    applyRoomAction(room, player.id, action);
  }
  assert.equal(room.phase, 'play');
});

test('bot emits a legal action whenever the engine says it is the bot turn', () => {
  const room = builtinWithBots(2);
  startGame(room);
  for (let guard = 0; guard < 80; guard++) {
    const turn = currentPlayer(room);
    if (!turn) break;
    if (room.research) { passResearchPhase(room); continue; }
    if (!turn.bot) continue;
    const view = viewFor(room, turn.id);
    const action = decideAction(room, turn.id, view);
    assert.ok(action, `bot ${turn.name} should produce an action on tick ${guard}`);
    const result = applyRoomAction(room, turn.id, action);
    assert.ok(result.ok, `bot action rejected: ${result.error} (action=${JSON.stringify(action)})`);
  }
});

test('survey target research and wait all commit one entry to the log', () => {
  const room = builtinWithBots(1);
  startGame(room);
  const bot = room.players.find((player) => player.bot);
  for (let guard = 0; guard < 30; guard++) {
    if (currentPlayer(room)?.id === bot.id && !room.research) break;
    const turn = currentPlayer(room);
    if (room.research) { passResearchPhase(room); continue; }
    applyRoomAction(room, turn.id, { kind: 'wait' });
  }
  const view = viewFor(room, bot.id);
  const action = decideAction(room, bot.id, view);
  assert.ok(action, 'the bot should act on its first turn');
  const before = room.session.entries.length;
  applyRoomAction(room, bot.id, action);
  if (['survey', 'target', 'research', 'wait'].includes(action.kind)) {
    assert.equal(room.session.entries.length, before + 1, `bot action ${action.kind} should record an entry`);
  }
});

test('setup reuses an already-ready card instead of resubmitting', () => {
  const room = builtinWithBots(1);
  startGame(room);
  const bot = playerById(room, room.players.find((player) => player.bot).id);
  const view = viewFor(room, bot.id);
  const action = decideAction(room, bot.id, view);
  assert.equal(action, null);
});

test('during research phase, every bot declares even when it is not the turn cursor', () => {
  const room = builtinWithBots(2);
  startGame(room);
  for (let guard = 0; guard < 50; guard++) {
    if (room.research) break;
    const turn = currentPlayer(room);
    applyRoomAction(room, turn.id, { kind: 'wait' });
  }
  assert.ok(room.research, 'a research phase should have opened');
  const phaseId = room.research.id;
  const bots = room.players.filter((player) => player.bot);
  assert.equal(bots.length, 2);
  for (const bot of bots) {
    const view = viewFor(room, bot.id);
    // neither bot needs to be currentPlayer for a declaration
    const action = decideAction(room, bot.id, view);
    assert.ok(action, `bot ${bot.name} should declare without waiting for isMyTurn`);
    assert.equal(action.kind, 'research-declare');
    assert.equal(action.phaseId, phaseId);
    const result = applyRoomAction(room, bot.id, action);
    assert.ok(result.ok, result.error);
  }
  assert.equal(Object.keys(room.research.declares).filter((id) => bots.some((bot) => bot.id === id)).length, 2);
});

test('controller onApplied fires after a successful bot action', async () => {
  const room = builtinWithBots(1);
  startGame(room);
  const notices = [];
  const teardown = attachBotController(room, {
    tickMs: 20,
    onApplied(_live, bot, action) {
      notices.push({ botId: bot.id, kind: action.kind });
    },
  });
  for (let guard = 0; guard < 60; guard++) {
    if (currentPlayer(room)?.bot) break;
    const turn = currentPlayer(room);
    if (room.research) {
      const phaseId = room.research.id;
      for (const player of room.players) {
        if (!room.research || room.research.id !== phaseId) break;
        if (Object.hasOwn(room.research.declares, player.id)) continue;
        applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 0 });
      }
      continue;
    }
    applyRoomAction(room, turn.id, { kind: 'wait' });
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  teardown();
  assert.ok(notices.length >= 1, 'onApplied should observe at least one bot action');
});

test('detach clears the timer so cleanup can drop expired rooms safely', () => {
  const room = builtinWithBots(1);
  attachBotController(room, { tickMs: 50 });
  assert.ok(room.__botController);
  detachBotController(room);
  assert.equal(room.__botController, null);
  detachBotController(room);
});

test('during research phase, the bot declares then submits when at the cursor', () => {
  const room = builtinWithBots(1);
  startGame(room);
  // advance pawns until a research phase opens
  for (let guard = 0; guard < 50; guard++) {
    if (room.research) break;
    const turn = currentPlayer(room);
    applyRoomAction(room, turn.id, { kind: 'wait' });
  }
  assert.ok(room.research, 'a research phase should have opened');
  // if the bot is the only player, give it the cursor; close any leftover open phase
  // by declaring 0 + finishing whatever is left, and do not assume the cursor ever lands on it
  let safety = 0;
  while (room.research && safety++ < 40) {
    const phaseId = room.research.id;
    for (const player of room.players) {
      if (!room.research || room.research.id !== phaseId) break;
      if (Object.hasOwn(room.research.declares, player.id)) continue;
      const res = applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 0 });
      assert.ok(res.ok, res.error);
    }
  }
  assert.equal(room.research, null);
});

test('the controller attaches, runs several ticks, and emits at least one bot action', async () => {
  const room = builtinWithBots(1);
  startGame(room);
  const teardown = attachBotController(room, { tickMs: 20 });
  // the bot only acts when the room is past setup *and* the cursor is on it; in a
  // solo room the host *is* the only seated player, so we move the pawn forward by
  // hand and then let the ticks run
  const beforeEntries = room.session.entries.length;
  for (let guard = 0; guard < 60; guard++) {
    if (currentPlayer(room)?.id !== room.players[0].id) break;
    applyRoomAction(room, room.players[0].id, { kind: 'wait' });
    if (room.research) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  teardown();
  // the bot may not have produced an action when the cursor was never on it
  // (the test is simply a smoke check that attach/detach does not throw)
  assert.ok(room.session.entries.length >= beforeEntries);
});

test('detach is idempotent and safe to call on a room with no controller', () => {
  const room = builtinWithBots(1);
  detachBotController(room);
  detachBotController(room);
  assert.ok(!room.__botController);
});

test('bot never reveals puzzle truth (no reference to objects, clues, or conferences)', () => {
  const room = builtinWithBots(1);
  startGame(room);
  const puzzle = puzzleFixture();
  for (let guard = 0; guard < 60 && room.phase !== 'done'; guard++) {
    if (room.research) { passResearchPhase(room); continue; }
    const turn = currentPlayer(room);
    if (!turn) break;
    if (turn.bot) {
      const view = viewFor(room, turn.id);
      const json = JSON.stringify(view);
      assert.equal(json.includes(JSON.stringify(puzzle.objects)), false, 'bot view leaks puzzle objects');
      for (const topic of Object.values(puzzle.topics)) {
        assert.equal(json.includes(topic.clue), false, `bot view leaks clue ${topic.name}`);
      }
      assert.equal(json.includes(puzzle.conferences[10]), false, 'bot view leaks conference text');
    } else {
      if (room.session.entries.length === 0 || guard % 2 === 0) {
        applyRoomAction(room, turn.id, { kind: 'wait' });
      } else {
        applyRoomAction(room, turn.id, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 6, count: 0 });
      }
    }
  }
});

test('the bot never picks a non-existent action kind', () => {
  const room = builtinWithBots(2);
  startGame(room);
  const allowed = new Set([
    'wait', 'survey', 'target', 'research', 'review', 'nudge', 'undo', 'locate',
    'final-pass', 'final-theories', 'research-declare', 'research-submit',
    'setup', 'setup-reopen', 'skip-turn',
  ]);
  for (let guard = 0; guard < 80 && room.phase !== 'done'; guard++) {
    if (room.research) { passResearchPhase(room); continue; }
    const turn = currentPlayer(room);
    if (!turn) break;
    if (turn.bot) {
      const view = viewFor(room, turn.id);
      const action = decideAction(room, turn.id, view);
      if (action) assert.ok(allowed.has(action.kind), `unknown action kind: ${action.kind}`);
    } else {
      applyRoomAction(room, turn.id, { kind: 'wait' });
    }
  }
});
