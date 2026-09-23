import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, applyRoomAction, createRoom, viewFor } from '../public/src/room.js';
import { INITIAL_CLUE_COUNTS, isCometSector, MODES } from '../public/src/rules.js';
import { INITIAL_CLUE_TYPES, Obj } from '../public/src/types.js';

function fixturePuzzle() {
  const objects = [Obj.ASTEROID, Obj.COMET, Obj.DWARF_PLANET, Obj.EMPTY, Obj.GAS_CLOUD, Obj.PLANET_X, Obj.GAS_CLOUD, Obj.EMPTY, Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.ASTEROID];
  const pool = objects.flatMap((actual, sector) => INITIAL_CLUE_TYPES
    .filter((objectType) => actual !== objectType && (objectType !== Obj.COMET || isCometSector(MODES.standard, sector)))
    .map((objectType) => ({ sector, objectType })));
  return {
    modeId: 'standard', objects,
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: topic, clue: `私有课题${topic}` }])),
    conferences: { 10: '未召开前的秘密关系' },
    conferenceNames: { 10: 'X行星与气体云' },
    startingClues: Array.from({ length: 4 }, (_, seat) => pool.slice(seat, seat + 12)),
  };
}

function accepted(room, playerId, action) {
  const result = applyRoomAction(room, playerId, action);
  assert.equal(result.ok, true, result.error);
  return result;
}

test('room-wide initial clue count defaults to four and rejects non-enumerated values', () => {
  assert.equal(createRoom().initialClueCount, 4);
  for (const count of INITIAL_CLUE_COUNTS) assert.equal(createRoom({ initialClueCount: count }).initialClueCount, count);
  for (const count of [-1, 1, 3, 5, 13, 4.5, null, '4', false]) {
    assert.throws(() => createRoom({ initialClueCount: count }), /0、4、8、12/);
  }
});

for (const playMode of ['record', 'builtin']) {
  test(`${playMode} clue count is host-only, public, and locked after start`, () => {
    const room = createRoom({ playMode, puzzle: fixturePuzzle() });
    const guest = addPlayer(room, '来宾');
    const before = structuredClone(room);
    assert.equal(applyRoomAction(room, guest.id, { kind: 'set-initial-clue-count', count: 8 }).ok, false);
    assert.deepEqual(room, before);
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-initial-clue-count', count: '8' }).ok, false);
    accepted(room, room.hostId, { kind: 'set-initial-clue-count', count: 8 });
    assert.equal(viewFor(room, guest.id).initialClueCount, 8);
    accepted(room, room.hostId, { kind: 'start-game' });
    const started = structuredClone(room);
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-initial-clue-count', count: 4 }).ok, false);
    assert.deepEqual(room, started);
  });
}

for (const count of INITIAL_CLUE_COUNTS) {
  test(`built-in start automatically deals exactly ${count} private clues to every seat`, () => {
    const puzzle = fixturePuzzle();
    const room = createRoom({ playMode: 'builtin', puzzle, initialClueCount: count });
    while (room.players.length < 4) addPlayer(room, `玩家${room.players.length + 1}`);
    accepted(room, room.hostId, { kind: 'start-game' });
    for (const [seat, player] of room.players.entries()) {
      const view = viewFor(room, player.id);
      const card = structuredClone(view.mySetup);
      assert.equal(card.initialClueCount, count);
      assert.equal(card.cluesClaimed, true);
      assert.equal(card.ready, false);
      assert.equal(card.noClues, count === 0);
      assert.deepEqual(card.clues, puzzle.startingClues[seat].slice(0, count).map((clue) => ({ sector: clue.sector, type: clue.objectType })));
      assert.equal(view.puzzle, undefined);
      assert.equal(view.setup, undefined);
      assert.equal(view.startingClues, undefined);
      accepted(room, player.id, { kind: 'claim-initial-clues', count });
      assert.deepEqual(viewFor(room, player.id).mySetup, card);
      assert.equal(applyRoomAction(room, player.id, { kind: 'claim-initial-clues', count: count === 4 ? 8 : 4 }).ok, false);
      accepted(room, player.id, { kind: 'setup' });
    }
    assert.equal(room.phase, 'play');
  });
}

test('unavailable initial clue pools reject start without changing any card or phase', () => {
  const puzzle = fixturePuzzle();
  puzzle.startingClues[1] = [];
  const room = createRoom({ playMode: 'builtin', puzzle, initialClueCount: 8 });
  addPlayer(room, '来宾');
  const before = structuredClone(room);
  const result = applyRoomAction(room, room.hostId, { kind: 'start-game' });
  assert.equal(result.ok, false);
  assert.match(result.error, /线索不足/);
  assert.deepEqual(room, before);
});

for (const modeId of ['standard', 'expert']) {
  test(`${modeId} record setup enforces host count and rejects rule-only comet exclusions atomically`, () => {
    const room = createRoom({ modeId, initialClueCount: 4 });
    addPlayer(room, '来宾');
    accepted(room, room.hostId, { kind: 'start-game' });
    const validClues = [
      { sector: 0, type: Obj.GAS_CLOUD }, { sector: 1, type: Obj.ASTEROID },
      { sector: 2, type: Obj.COMET }, { sector: 3, type: Obj.DWARF_PLANET },
    ];
    for (const clues of [validClues.slice(0, 3), [...validClues.slice(0, 3), validClues[0]], [{ sector: 0, type: Obj.COMET }, ...validClues.slice(1)]]) {
      const before = structuredClone(room);
      const result = applyRoomAction(room, room.hostId, { kind: 'setup', clues, topics: { A: '不应保存' }, conferences: { 10: '不应保存' }, conferenceNames: { 10: '不应保存' } });
      assert.equal(result.ok, false);
      assert.deepEqual(room, before);
    }
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'setup', noClues: true }).ok, false);
    accepted(room, room.hostId, { kind: 'setup', clues: validClues });
    assert.deepEqual(viewFor(room, room.hostId).mySetup.clues, validClues);
    assert.equal(viewFor(room, room.hostId).mySetup.initialClueCount, 4);
    accepted(room, room.hostId, { kind: 'setup-reopen' });
    const changed = validClues.map((clue) => ({ ...clue }));
    changed[0].type = Obj.DWARF_PLANET;
    accepted(room, room.hostId, { kind: 'setup', clues: changed });
    assert.deepEqual(viewFor(room, room.hostId).mySetup.clues, changed);
  });
}

test('public conference titles do not expose unearned built-in clues', () => {
  const puzzle = fixturePuzzle();
  const room = createRoom({ playMode: 'builtin', puzzle });
  const guest = addPlayer(room, '来宾');
  for (const player of room.players) {
    const view = viewFor(room, player.id);
    assert.deepEqual(view.conferenceNames, puzzle.conferenceNames);
    assert.deepEqual(view.conferenceSectors, [10]);
    assert.doesNotMatch(JSON.stringify(view), /未召开前的秘密关系|私有课题/);
  }
  assert.equal(applyRoomAction(room, guest.id, { kind: 'set-conference-names', names: { 10: '偷改' } }).ok, false);
});

test('record conference headings are independently editable and invalid metadata leaves setup untouched', () => {
  const room = createRoom({ modeId: 'expert', initialClueCount: 0 });
  const guest = addPlayer(room, '来宾');
  accepted(room, room.hostId, { kind: 'start-game' });
  const before = structuredClone(room);
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'setup', noClues: true, topics: { A: '不应保存' }, conferenceNames: [] }).ok, false);
  assert.deepEqual(room, before);
  const blank = applyRoomAction(room, room.hostId, { kind: 'setup', noClues: true, topics: { A: '小行星' }, conferenceNames: { 7: ' X行星与气体云 ', 16: '', 10: '忽略' } });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /课题|会议名称/);
  assert.deepEqual(room, before);
  const topics = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((id) => [id, id === 'A' ? '小行星' : `课题${id}`]));
  accepted(room, room.hostId, { kind: 'setup', noClues: true, topics, conferenceNames: { 7: ' X行星与气体云 ', 16: '矮行星之间', 10: '忽略' } });
  const view = viewFor(room, guest.id);
  assert.deepEqual(view.conferenceNames, { 7: 'X行星与气体云', 16: '矮行星之间' });
  assert.deepEqual(view.conferenceRules, {});
  assert.equal(applyRoomAction(room, guest.id, { kind: 'set-conference-names', names: {} }).ok, false);
  accepted(room, room.hostId, { kind: 'set-conference-names', names: { 16: 'X行星与矮行星' } });
  assert.equal(viewFor(room, guest.id).conferenceNames[16], 'X行星与矮行星');
  assert.deepEqual(room.conferenceRules, {});
});

test('duplicate raw entries do not count toward the twelve-clue setup limit', () => {
  const room = createRoom({ initialClueCount: 12 });
  addPlayer(room, '来宾');
  accepted(room, room.hostId, { kind: 'start-game' });
  const clues = Array.from({ length: 12 }, (unused, sector) => ({ sector, type: Obj.ASTEROID }));
  accepted(room, room.hostId, { kind: 'setup', clues: [...clues, clues[0], clues[1]] });
  assert.deepEqual(room.setup[room.hostId].clues, clues);
  const before = structuredClone(room);
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'setup', clues: [...clues, { sector: 0, type: Obj.GAS_CLOUD }] }).ok, false);
  assert.deepEqual(room, before);
});
