import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, applyRoomAction, createRoom, currentPlayer, viewFor, windowTimeOf } from '../public/src/room.js';
import { completeTheoryPhase, consoleView, createConsole, recordSurvey, recordTheory, recordWait } from '../public/src/console.js';
import { createPuzzle } from '../server/puzzles.js';
import { arcSectors } from '../public/src/rules.js';
import { apparentType, Obj } from '../public/src/types.js';

function accepted(room, seat, action) {
  const result = applyRoomAction(room, room.players[seat].id, action);
  assert.equal(result.ok, true, `${room.playMode} ${action.kind}: ${result.error}`);
  return result;
}

function createPair(modeId) {
  const generated = createPuzzle({ modeId, random: () => 0.25 });
  const puzzle = { ...generated, startingClues: [[], []] };
  const builtin = createRoom({ modeId, playMode: 'builtin', puzzle, initialClueCount: 0, hostName: '甲' });
  const record = createRoom({ modeId, initialClueCount: 0, hostName: '甲' });
  for (const room of [builtin, record]) {
    addPlayer(room, '乙');
    accepted(room, 0, { kind: 'start-game' });
    for (const seat of [0, 1]) accepted(room, seat, { kind: 'setup', noClues: true, topics: Object.fromEntries(Object.entries(puzzle.topics).map(([topic, value]) => [topic, value.name])), conferenceNames: puzzle.conferenceNames });
  }
  return { builtin, record, puzzle };
}

function settleRecord(room, puzzle) {
  for (let guard = 0; guard < 30; guard += 1) {
    const view = viewFor(room, room.hostId);
    if (view.awaitingReview.length) {
      const original = room.session.entries.filter((entry) => view.awaitingReview.includes(entry.id)).sort((first, second) => first.sector - second.sector || first.id - second.id)[0];
      accepted(room, 0, { kind: 'review', id: original.id, review: puzzle.objects[original.sector] === original.objectType ? 'correct' : 'wrong' });
    } else if (room.conference && !room.research) {
      accepted(room, 0, { kind: 'conference', sector: room.conference.sector, text: puzzle.conferences[room.conference.sector] });
    } else if (room.phase === 'reveal') {
      accepted(room, 0, { kind: 'reveal-objects', objects: puzzle.objects });
    } else return;
  }
  assert.fail('record adjudication failed to settle');
}

function comparable(room) {
  const view = viewFor(room, room.hostId);
  const seatOf = (playerId) => room.players.findIndex((player) => player.id === playerId);
  return {
    phase: view.phase,
    times: view.players.map((player) => player.time),
    order: view.turnOrder.map(seatOf),
    window: [view.windowTime, view.visibleStart, view.visible],
    phaseSector: view.research?.sector || null,
    cursor: seatOf(view.research?.cursorId),
    log: view.log.map((entry) => Object.fromEntries(['type', 'sector', 'surveyType', 'start', 'size', 'count', 'apparent', 'topic', 'text', 'objectType', 'review', 'slot', 'cost', 'correct', 'publicationPhase'].map((key) => [key, entry[key]]))),
    scores: view.scores.rows.map((row) => [row.theoryPoints, row.leaderBonus, row.locatePoints, row.total]),
  };
}

function applyPair(pair, seat, action) {
  const { builtin, record, puzzle } = pair;
  const recorded = { ...action };
  if (action.kind === 'survey') recorded.count = arcSectors(action.start, action.size, puzzle.objects.length).filter((sector) => apparentType(puzzle.objects[sector]) === action.type).length;
  if (action.kind === 'target') recorded.apparent = apparentType(puzzle.objects[action.sector]);
  if (action.kind === 'research') Object.assign(recorded, { name: puzzle.topics[action.topic].name, text: puzzle.topics[action.topic].clue });
  if (action.kind === 'locate') recorded.correct = true;
  accepted(builtin, seat, action);
  accepted(record, seat, recorded);
  settleRecord(record, puzzle);
  assert.deepEqual(comparable(record), comparable(builtin));
}

for (const modeId of ['standard', 'expert']) {
  test(`${modeId} record room matches builtin departure, arrival, paper, conference and endgame rules`, () => {
    const pair = createPair(modeId);
    const { builtin, record, puzzle } = pair;
    const correctSector = puzzle.objects.indexOf(Obj.ASTEROID);
    const wrongSector = puzzle.objects.indexOf(Obj.DWARF_PLANET);
    let phases = 0;
    for (let guard = 0; guard < 150 && windowTimeOf(builtin) < puzzle.objects.length + 1; guard += 1) {
      if (builtin.research) {
        phases += 1;
        const phaseId = builtin.research.id;
        const count = phases <= 2 ? 1 : 0;
        applyPair(pair, 0, { kind: 'research-declare', phaseId, count });
        applyPair(pair, 1, { kind: 'research-declare', phaseId, count: phases === 1 ? 1 : 0 });
        while (builtin.research?.cursorId) {
          const seat = builtin.players.findIndex((player) => player.id === builtin.research.cursorId);
          const sector = seat === 0 ? correctSector : wrongSector;
          if (phases === 2 && seat === 0) {
            for (const room of [builtin, record]) {
              const before = structuredClone(room);
              assert.equal(applyRoomAction(room, room.players[seat].id, { kind: 'research-submit', phaseId, sector, objectType: Obj.ASTEROID }).ok, false);
              assert.deepEqual(room, before);
            }
          }
          applyPair(pair, seat, { kind: 'research-submit', phaseId, sector, objectType: phases === 2 ? Obj.GAS_CLOUD : Obj.ASTEROID });
        }
      } else {
        const seat = builtin.players.indexOf(currentPlayer(builtin));
        applyPair(pair, seat, { kind: 'wait' });
      }
    }
    assert.ok(phases >= (modeId === 'standard' ? 4 : 6));
    assert.equal(viewFor(record, record.hostId).knowledge.conferences.length, modeId === 'standard' ? 1 : 2);
    assert.ok(record.session.entries.some((entry) => entry.type === 'penalty'));
    assert.ok(viewFor(record, record.hostId).theoryLockedSectors.includes(correctSector));
    const locator = builtin.players.indexOf(currentPlayer(builtin));
    const sector = puzzle.objects.indexOf(Obj.PLANET_X);
    applyPair(pair, locator, { kind: 'locate', sector, left: puzzle.objects[(sector + puzzle.objects.length - 1) % puzzle.objects.length], right: puzzle.objects[(sector + 1) % puzzle.objects.length] });
    while (builtin.phase === 'final') applyPair(pair, builtin.players.findIndex((player) => player.id === builtin.endgame.cursorId), { kind: 'final-pass' });
    assert.equal(record.phase, 'done');
    assert.deepEqual(viewFor(record, record.hostId).revealedObjects, puzzle.objects);
  });

  test(`${modeId} offline record phases trigger on departure and forbid nonprime comet claims and endpoints`, () => {
    const session = createConsole({ modeId });
    const before = structuredClone(session);
    assert.equal(recordSurvey(session, { type: Obj.COMET, start: 0, size: 2, count: 0 }).ok, false);
    assert.deepEqual(session, before);
    assert.equal(recordWait(session, 2).ok, true);
    assert.equal(consoleView(session).theoryPhase, null);
    assert.equal(recordTheory(session, { sector: 1, type: Obj.COMET }).ok, false);
    assert.equal(recordWait(session, 1).ok, true);
    assert.equal(session.theoryPhases[0].sector, 3);
    const opened = structuredClone(session);
    assert.equal(recordTheory(session, { sector: 0, type: Obj.COMET }).ok, false);
    assert.deepEqual(session, opened);
    assert.equal(consoleView(session).theoryOptions.find((option) => option.sector === 0).types.includes(Obj.COMET), false);
    assert.equal(recordTheory(session, { sector: 1, type: Obj.COMET }).ok, true);
    assert.equal(completeTheoryPhase(session).ok, true);
    assert.equal(recordWait(session, 3).ok, true);
    assert.equal(recordTheory(session, { sector: 1, type: Obj.COMET }).ok, false);
    assert.equal(recordTheory(session, { sector: 1, type: Obj.ASTEROID }).ok, true);
  });
}
