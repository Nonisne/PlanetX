import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoom, addPlayer, applyRoomAction, viewFor, stateFor, roomSummary, currentPlayer } from '../public/src/room.js';
import { Obj, THEORY_TYPES } from '../public/src/types.js';
import { renderActionPanel } from '../public/ui/panels.js';

function puzzleFixture() {
  return {
    objects: [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
    conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
    startingClues: Array.from({ length: 4 }, (_, playerIndex) => [
      { sector: playerIndex, objectType: Obj.DWARF_PLANET },
      { sector: 10, objectType: Obj.COMET },
      { sector: 11, objectType: Obj.GAS_CLOUD },
      { sector: 9, objectType: Obj.ASTEROID },
    ]),
  };
}

function builtin(playerCount = 1, initialClueCount = 4) {
  const puzzle = puzzleFixture();
  const room = createRoom({ playMode: 'builtin', puzzle, hostName: '甲', initialClueCount });
  while (room.players.length < playerCount) addPlayer(room, `玩家 ${room.players.length + 1}`);
  return { room, puzzle, host: room.players[0], guest: room.players[1] };
}

function accept(room, player, action) {
  const result = applyRoomAction(room, player.id, action);
  assert.equal(result.ok, true, result.error);
  return result;
}

test('builtin initial clues are private, uniformly dealt on start, and cannot be rerolled', () => {
  const counts = [0, 4, 8, 12];
  for (const count of counts) {
    const { room, host } = builtin(4, count);
    const pool = room.puzzle.objects.flatMap((actual, sector) => THEORY_TYPES
      .filter((objectType) => objectType !== actual && (objectType !== Obj.COMET || [1, 2, 4, 6, 10].includes(sector)))
      .map((objectType) => ({ sector, objectType }))).slice(0, 12);
    room.puzzle.startingClues = room.players.map(() => structuredClone(pool));
    accept(room, host, { kind: 'start-game' });
    for (const player of room.players) {
      const setup = viewFor(room, player.id).mySetup;
      assert.equal(setup.clues.length, count);
      assert.equal(setup.cluesClaimed, true);
      assert.equal(setup.initialClueCount, count);
      for (const invalidCount of [-1, 1, 3, 5, 13, 4.5, null, '4']) {
        assert.equal(applyRoomAction(room, player.id, { kind: 'claim-initial-clues', count: invalidCount }).ok, false);
      }
    }
    for (const [index, player] of room.players.entries()) {
      accept(room, player, { kind: 'claim-initial-clues', count });
      const before = structuredClone(viewFor(room, player.id).mySetup);
      assert.equal(before.cluesClaimed, true);
      assert.equal(before.initialClueCount, count);
      assert.equal(before.clues.length, count);
      accept(room, player, { kind: 'claim-initial-clues', count });
      assert.deepEqual(viewFor(room, player.id).mySetup, before);
      assert.equal(applyRoomAction(room, player.id, { kind: 'claim-initial-clues', count: count === 4 ? 8 : 4 }).ok, false);
      assert.equal(viewFor(room, player.id).startingClues, undefined);
      assert.equal(viewFor(room, player.id).puzzle, undefined);
      const nextPlayer = room.players[index + 1];
      if (nextPlayer) assert.equal(viewFor(room, nextPlayer.id).mySetup.clues.length, count);
      accept(room, player, { kind: 'setup' });
    }
    assert.equal(room.phase, 'play');
    assert.equal(applyRoomAction(room, host.id, { kind: 'claim-initial-clues', count: 12 }).ok, false);
  }
});

test('claiming builtin clues cannot mutate record setup or silently truncate an unavailable pool', () => {
  const record = createRoom();
  assert.equal(applyRoomAction(record, record.players[0].id, { kind: 'claim-initial-clues', count: 4 }).ok, false);
  const { room, host } = builtin(1, 12);
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, false);
  assert.equal(room.phase, 'lobby');
  assert.equal(viewFor(room, host.id).mySetup, null);
});

test('reopening builtin readiness preserves the claimed count and never permits a new hand', () => {
  const { room, host } = builtin(2);
  accept(room, host, { kind: 'start-game' });
  accept(room, host, { kind: 'claim-initial-clues', count: 4 });
  const clues = structuredClone(viewFor(room, host.id).mySetup.clues);
  accept(room, host, { kind: 'setup' });
  accept(room, host, { kind: 'setup-reopen' });
  assert.equal(viewFor(room, host.id).mySetup.ready, false);
  assert.equal(viewFor(room, host.id).mySetup.cluesClaimed, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'claim-initial-clues', count: 0 }).ok, false);
  accept(room, host, { kind: 'claim-initial-clues', count: 4 });
  assert.deepEqual(viewFor(room, host.id).mySetup.clues, clues);
});

function start(room) {
  accept(room, room.players[0], { kind: 'start-game' });
  for (const player of room.players.filter((seat) => !seat.spectator)) {
    if (room.playMode === 'builtin') accept(room, player, { kind: 'claim-initial-clues', count: 4 });
    accept(room, player, { kind: 'setup' });
  }
}

function passResearch(room) {
  for (let guard = 0; room.research && guard < 20; guard++) {
    const phaseId = room.research.id;
    for (const player of room.players.filter((seat) => !seat.spectator)) {
      if (room.research?.id === phaseId && !Object.hasOwn(room.research.declares, player.id)) {
        accept(room, player, { kind: 'research-declare', phaseId, count: 0 });
      }
    }
  }
  assert.equal(room.research, null);
}

function nextResearch(room) {
  for (let guard = 0; !room.research && guard < 100; guard++) {
    accept(room, currentPlayer(room), { kind: 'wait' });
  }
  assert.ok(room.research);
  return room.research.id;
}

function exhaustedBuiltin(playerCount = 1) {
  const fixture = builtin(playerCount);
  const { room, host, puzzle } = fixture;
  start(room);
  // One correct paper per ordinary sector spends the whole standard inventory (9 tokens)
  // and locks every sector that can ever be confirmed by review.
  const claims = puzzle.objects
    .map((objectType, sector) => ({ sector, objectType }))
    .filter((claim) => THEORY_TYPES.includes(claim.objectType));
  assert.equal(claims.length, 9);
  for (const claim of claims) {
    const phaseId = nextResearch(room);
    for (const player of room.players) {
      accept(room, player, { kind: 'research-declare', phaseId, count: player.id === host.id ? 1 : 0 });
    }
    accept(room, host, { kind: 'research-submit', phaseId, ...claim });
  }
  for (let advance = 0; advance < 2; advance++) {
    nextResearch(room);
    passResearch(room);
  }
  nextResearch(room);
  assert.equal(room.session.entries.filter((entry) => entry.type === 'theory').length, 9);
  assert.equal(viewFor(room, host.id).theoryLockedSectors.length, 9);
  assert.equal(viewFor(room, host.id).theoryTokensRemaining.asteroid, 0);
  assert.equal(viewFor(room, host.id).theoryTokensRemaining.dwarfPlanet, 0);
  return fixture;
}

function declarationControls(game) {
  const originalDocument = globalThis.document;
  const buttons = [];
  const actions = [];
  globalThis.document = {
    createElement(tagName) {
      const element = {
        nodeType: 1,
        children: [],
        attributes: {},
        listeners: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, handler) { this.listeners[name] = handler; },
        append(...children) { this.children.push(...children); },
      };
      if (tagName === 'button') buttons.push(element);
      return element;
    },
    createElementNS(_ns, tagName) { return this.createElement(tagName); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; },
  };
  try {
    renderActionPanel({ state: { game, ui: {} }, api: { consoleAction: (action) => actions.push(action) } });
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
  return { buttons, actions };
}

test('builtin exhausted legal claims reject a positive declaration without trapping the game', () => {
  const { room, host } = exhaustedBuiltin();
  const phaseId = room.research.id;
  const before = structuredClone(room);
  const refused = applyRoomAction(room, host.id, { kind: 'research-declare', phaseId, count: 1 });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /可提交|合法/);
  assert.deepEqual(room, before);
  assert.equal(viewFor(room, host.id).research.maxDeclare, 0);
  accept(room, host, { kind: 'research-declare', phaseId, count: 0 });
  passResearch(room);
  accept(room, host, { kind: 'locate', sector: 5, left: Obj.EMPTY, right: Obj.COMET });
  assert.equal(room.phase, 'done');
});

test('builtin declaration capacity uses each author history rather than hidden puzzle truth', () => {
  const { room, host, guest, puzzle } = exhaustedBuiltin(2);
  const hostView = viewFor(room, host.id);
  const guestView = viewFor(room, guest.id);
  assert.equal(hostView.research.maxDeclare, 0);
  assert.equal(guestView.research.maxDeclare, 1);
  assert.equal(JSON.stringify(guestView).includes(JSON.stringify(puzzle.objects)), false);
  for (const topic of Object.values(puzzle.topics)) assert.equal(JSON.stringify(guestView).includes(topic.clue), false);
  const phaseId = room.research.id;
  accept(room, host, { kind: 'research-declare', phaseId, count: 0 });
  accept(room, guest, { kind: 'research-declare', phaseId, count: 1 });
  accept(room, guest, { kind: 'research-submit', phaseId, sector: 5, objectType: Obj.GAS_CLOUD });
});

test('declaration buttons enforce personal capacity and preserve old expert views', () => {
  for (const { modeId, maxDeclare, allowed } of [
    { modeId: 'standard', maxDeclare: 0, allowed: 0 },
    { modeId: 'expert', maxDeclare: 1, allowed: 1 },
    { modeId: 'expert', maxDeclare: undefined, allowed: 2 },
  ]) {
    const room = modeId === 'standard' ? builtin().room : createRoom({ modeId, initialClueCount: 0 });
    if (modeId === 'expert') addPlayer(room, '乙');
    start(room);
    nextResearch(room);
    const game = viewFor(room, room.hostId);
    game.research.maxDeclare = maxDeclare;
    const { buttons, actions } = declarationControls(game);
    assert.equal(buttons.length, game.research.quota + 1);
    for (const [count, button] of buttons.entries()) {
      assert.equal(Object.hasOwn(button.attributes, 'disabled'), count > allowed);
      button.listeners.click();
    }
    assert.deepEqual(actions.map((action) => action.count), Array.from({ length: allowed + 1 }, (unused, count) => count));
    assert.ok(actions.every((action) => action.kind === 'research-declare' && action.phaseId === game.research.id));
  }
});

test('legacy rooms stay record mode, builtin accepts solo and rejects mismatched puzzles', () => {
  const legacy = createRoom();
  assert.equal(viewFor(legacy, legacy.hostId).playMode, 'record');
  assert.equal(viewFor(legacy, legacy.hostId).canStart, false);
  const { room, host } = builtin();
  assert.equal(viewFor(room, host.id).canStart, true);
  assert.equal(viewFor(room, host.id).playMode, 'builtin');
  assert.throws(() => createRoom({ playMode: 'builtin', modeId: 'expert', puzzle: puzzleFixture() }), /谜题/);
  assert.throws(() => createRoom({ playMode: 'builtin' }), /谜题/);
});

test('builtin setup issues private initial clues and ignores forged setup data', () => {
  const { room, host, guest } = builtin(2);
  accept(room, host, { kind: 'start-game' });
  accept(room, host, { kind: 'claim-initial-clues', count: 4 });
  accept(room, guest, { kind: 'claim-initial-clues', count: 4 });
  const before = structuredClone(viewFor(room, host.id).mySetup.clues);
  assert.equal(before.length, 4);
  assert.notDeepEqual(before, viewFor(room, guest.id).mySetup.clues);
  accept(room, host, { kind: 'setup', noClues: true, clues: [{ sector: 5, type: Obj.EMPTY }], topics: { A: '篡改名称' }, conferences: { 10: '篡改会议' } });
  assert.deepEqual(viewFor(room, host.id).mySetup.clues, before);
  assert.equal(viewFor(room, host.id).topicNames.A, '研究 A');
  assert.deepEqual(viewFor(room, host.id).conferenceRules, {});
  accept(room, guest, { kind: 'setup' });
  assert.equal(room.phase, 'play');
});

test('hidden puzzle and unearned research/conference information never enter views or summaries', () => {
  const { room, host, guest, puzzle } = builtin(2);
  start(room);
  for (const player of [host, guest]) {
    const payload = JSON.stringify({ view: viewFor(room, player.id), state: stateFor(room, player.id), summary: roomSummary(room) });
    assert.equal(payload.includes('startingClues'), false);
    assert.equal(payload.includes('"puzzle"'), false);
    assert.equal(payload.includes(JSON.stringify(puzzle.objects)), false);
    for (const topic of Object.values(puzzle.topics)) assert.equal(payload.includes(topic.clue), false);
    assert.equal(payload.includes(puzzle.conferences[10]), false);
  }
});

test('survey/target results are server-authoritative and X looks empty only to its querying player', () => {
  const { room, host, guest } = builtin(2);
  start(room);
  const scan = accept(room, host, { kind: 'target', sector: 5, apparent: Obj.PLANET_X });
  assert.equal(scan.entry.apparent, Obj.EMPTY);
  assert.equal(viewFor(room, guest.id).log.find((entry) => entry.id === scan.entry.id).apparent, undefined);
  const survey = accept(room, guest, { kind: 'survey', type: Obj.EMPTY, start: 0, size: 6, count: 99 });
  assert.equal(survey.entry.count, 2);
  assert.equal(survey.entry.cost, 3);
  assert.equal(viewFor(room, host.id).log.find((entry) => entry.id === survey.entry.id).count, undefined);
});

test('builtin research returns only the chosen private clue and keeps turn/cost rules', () => {
  const { room, host, guest, puzzle } = builtin(2);
  start(room);
  const result = accept(room, host, { kind: 'research', topic: 'A', text: '伪造线索', name: '伪造名称' });
  assert.equal(result.entry.text, puzzle.topics.A.clue);
  assert.equal(result.entry.cost, 1);
  const own = JSON.stringify(viewFor(room, host.id));
  const other = JSON.stringify(viewFor(room, guest.id));
  assert.ok(own.includes(puzzle.topics.A.clue));
  assert.equal(own.includes(puzzle.topics.B.clue), false);
  assert.equal(other.includes(puzzle.topics.A.clue), false);
  assert.equal(applyRoomAction(room, host.id, { kind: 'target', sector: 0 }).ok, false);
  accept(room, guest, { kind: 'wait' });
  assert.equal(applyRoomAction(room, host.id, { kind: 'research', topic: 'B' }).ok, false);
});

test('builtin rejects manual truth, early conference, undo, calibration and host bypass actions', () => {
  const { room, host } = builtin();
  start(room);
  for (const kind of ['review', 'conference', 'undo', 'nudge', 'reveal-objects', 'set-topic-names', 'set-conference-rules', 'skip-turn']) {
    const before = JSON.stringify(stateFor(room, host.id));
    const result = applyRoomAction(room, host.id, { kind, sector: 10, objects: puzzleFixture().objects, delta: 1 });
    assert.equal(result.ok, false, kind);
    assert.equal(JSON.stringify(stateFor(room, host.id)), before, kind);
  }
});

test('builtin retains range validation and rejects malformed queries without spending time', () => {
  const { room, host } = builtin();
  start(room);
  for (const action of [null, { kind: 'survey', type: Obj.EMPTY, start: 0, size: 1000000000 }, { kind: 'target', sector: 7 }, { kind: 'research', topic: 'Z' }, { kind: 'locate', sector: 5, left: 'invalid', right: Obj.COMET }]) {
    const result = applyRoomAction(room, host.id, action);
    assert.equal(result.ok, false);
    assert.equal(room.session.entries.length, 0);
  }
});

test('conference publishes automatically only after the shared window leaves its event', () => {
  const { room, host, puzzle } = builtin();
  start(room);
  while (viewFor(room, host.id).time < 10) {
    assert.equal(JSON.stringify(viewFor(room, host.id)).includes(puzzle.conferences[10]), false);
    accept(room, host, { kind: 'wait' });
    passResearch(room);
  }
  const conferences = room.session.entries.filter((entry) => entry.type === 'conference');
  assert.equal(conferences.length, 1);
  assert.equal(conferences[0].text, puzzle.conferences[10]);
  assert.equal(conferences[0].cost, 0);
  assert.equal(room.conference, null);
});

test('builtin mixed crossings withhold conference clues until all earlier theory and review work completes', () => {
  for (const submitWrong of [false, true]) {
    const { room, host, puzzle } = builtin();
    start(room);
    accept(room, host, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 1 });
    assert.equal(room.research.sector, 3);
    const phaseId = room.research.id;
    accept(room, host, { kind: 'research-declare', phaseId, count: submitWrong ? 1 : 0 });
    if (submitWrong) accept(room, host, { kind: 'research-submit', phaseId, sector: 0, objectType: Obj.GAS_CLOUD });
    accept(room, host, { kind: 'survey', type: Obj.ASTEROID, start: 4, size: 1 });
    passResearch(room);
    accept(room, host, { kind: 'target', sector: 8 });
    assert.equal(viewFor(room, host.id).windowTime, 12);
    assert.equal(room.research.sector, 9);
    assert.equal(room.session.entries.some((entry) => entry.type === 'conference'), false);
    assert.equal(JSON.stringify(viewFor(room, host.id)).includes(puzzle.conferences[10]), false);
    accept(room, host, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
    assert.equal(room.research.sector, 12);
    const conferenceIndex = room.session.entries.findIndex((entry) => entry.type === 'conference');
    assert.ok(conferenceIndex >= 0);
    assert.equal(room.session.entries[conferenceIndex].text, puzzle.conferences[10]);
    if (submitWrong) {
      const penaltyIndex = room.session.entries.findIndex((entry) => entry.type === 'penalty');
      assert.ok(penaltyIndex >= 0 && penaltyIndex < conferenceIndex);
    }
  }
});

test('builtin advances theory track, automatically reviews and charges wrong theory once', () => {
  const { room, host } = builtin();
  start(room);
  accept(room, host, { kind: 'wait' });
  accept(room, host, { kind: 'wait' });
  assert.equal(room.research, null);
  accept(room, host, { kind: 'wait' });
  const phaseId = room.research.id;
  accept(room, host, { kind: 'research-declare', phaseId, count: 1 });
  const submitted = accept(room, host, { kind: 'research-submit', phaseId, sector: 1, objectType: Obj.COMET });
  assert.equal(submitted.entry.review, 'pending');
  for (let guard = 0; submitted.entry.review === 'pending' && guard < 20; guard++) {
    accept(room, host, { kind: 'wait' });
    passResearch(room);
  }
  assert.equal(submitted.entry.review, 'wrong');
  assert.equal(submitted.entry.revealed, true);
  assert.equal(room.session.entries.filter((entry) => entry.type === 'penalty' && entry.theoryId === submitted.entry.id).length, 1);
  assert.deepEqual(viewFor(room, host.id).awaitingReview, []);
});

test('builtin reviews multiple due sectors by sector number rather than publication order', () => {
  const { room, host, guest } = builtin(2);
  start(room);
  while (!room.research) accept(room, currentPlayer(room), { kind: 'wait' });
  const phaseId = room.research.id;
  accept(room, host, { kind: 'research-declare', phaseId, count: 1 });
  accept(room, guest, { kind: 'research-declare', phaseId, count: 1 });
  const highSector = accept(room, host, { kind: 'research-submit', phaseId, sector: 10, objectType: Obj.ASTEROID }).entry;
  const lowSector = accept(room, guest, { kind: 'research-submit', phaseId, sector: 0, objectType: Obj.ASTEROID }).entry;
  for (let guard = 0; highSector.review === 'pending' && guard < 30; guard++) {
    accept(room, currentPlayer(room), { kind: 'wait' });
    passResearch(room);
  }
  assert.equal(lowSector.review, 'correct');
  assert.equal(highSector.review, 'correct');
  assert.deepEqual(viewFor(room, host.id).awaitingReview, []);
});

test('locate checks X and both neighbors, then solo auto-reveals and scores', () => {
  const { room, host, puzzle } = builtin();
  start(room);
  const wrong = accept(room, host, { kind: 'locate', sector: 5, left: Obj.ASTEROID, right: Obj.COMET, correct: true });
  assert.equal(wrong.entry.correct, false);
  assert.equal(wrong.entry.cost, 5);
  assert.equal(room.phase, 'play');
  assert.equal(viewFor(room, host.id).revealedObjects, null);
  passResearch(room);
  const correct = accept(room, host, { kind: 'locate', sector: 5, left: Obj.EMPTY, right: Obj.COMET, correct: false });
  assert.equal(correct.entry.correct, true);
  assert.equal(correct.entry.cost, 5);
  assert.equal(room.phase, 'done');
  assert.deepEqual(viewFor(room, host.id).revealedObjects, puzzle.objects);
  assert.equal(viewFor(room, host.id).scores.rows[0].locatePoints, 10);
});

test('multiplayer final opportunity keeps truth hidden, freezes clocks, and auto-reveals afterward', () => {
  const { room, host, guest, puzzle } = builtin(2);
  start(room);
  accept(room, host, { kind: 'wait' });
  accept(room, guest, { kind: 'wait' });
  accept(room, host, { kind: 'wait' });
  assert.equal(currentPlayer(room).id, guest.id);
  accept(room, guest, { kind: 'locate', sector: 5, left: Obj.EMPTY, right: Obj.COMET });
  assert.equal(room.phase, 'final');
  assert.equal(viewFor(room, host.id).revealedObjects, null);
  const frozen = viewFor(room, host.id).players.map((player) => player.time);
  const result = accept(room, host, { kind: 'locate', sector: 5, left: Obj.EMPTY, right: Obj.COMET, correct: false });
  assert.equal(result.entry.correct, true);
  assert.equal(result.entry.cost, 0);
  assert.equal(room.phase, 'done');
  assert.deepEqual(viewFor(room, host.id).players.map((player) => player.time), frozen);
  assert.deepEqual(viewFor(room, host.id).revealedObjects, puzzle.objects);
  assert.equal(viewFor(room, host.id).scores.rows.find((player) => player.id === host.id).locatePoints, 8);
});

test('builtin supports one through four players and refuses a fifth without changing the room', () => {
  for (const playerCount of [1, 2, 3, 4]) {
    const { room } = builtin(playerCount);
    if (playerCount === 4) {
      const before = structuredClone(room);
      assert.throws(() => addPlayer(room, '第五位'), /最多支持 4 名玩家/);
      assert.deepEqual(room, before);
      const spectator = addPlayer(room, '旁观', { spectator: true });
      assert.equal(spectator.spectator, true);
      assert.equal(room.players.length, 5);
    }
    start(room);
    assert.equal(room.phase, 'play');
    for (const player of room.players.filter((seat) => !seat.spectator)) assert.equal(room.setup[player.id].clues.length, 4);
    assert.throws(() => addPlayer(room, '中途加入'), /开始|加入/);
    if (playerCount === 4) {
      const late = addPlayer(room, '中途旁观', { spectator: true });
      assert.equal(late.spectator, true);
    }
  }
});

test('the builtin player cap does not change record room capacity', () => {
  const room = createRoom({ playMode: 'record', hostName: '房主' });
  for (let playerNumber = 2; playerNumber <= 5; playerNumber += 1) addPlayer(room, `玩家 ${playerNumber}`);
  assert.equal(room.players.length, 5);
});
