import test from 'node:test';
import assert from 'node:assert/strict';

import { Obj } from '../public/src/types.js';
import {
  addPlayer,
  applyRoomAction,
  createRoom,
  currentPlayer,
  MAX_SPECTATORS,
  seatedPlayers,
  stateFor,
  turnOrder,
  viewFor,
} from '../public/src/room.js';

function puzzleFixture() {
  return {
    objects: [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有研究线索 ${topic}` }])),
    conferences: { 10: '会议专属线索：X 行星不在 1–3 号扇区。' },
    conferenceNames: { 10: 'X行星会议 · 10 号' },
    startingClues: Array.from({ length: 4 }, (_, playerIndex) => [
      { sector: playerIndex, objectType: Obj.DWARF_PLANET },
      { sector: 10, objectType: Obj.COMET },
      { sector: 11, objectType: Obj.GAS_CLOUD },
      { sector: 9, objectType: Obj.ASTEROID },
    ]),
  };
}

function accept(room, player, action) {
  const result = applyRoomAction(room, player.id, action);
  assert.equal(result.ok, true, result.error);
  return result;
}

function builtinWithSpectator() {
  const room = createRoom({ playMode: 'builtin', puzzle: puzzleFixture(), hostName: '甲', initialClueCount: 4 });
  const host = room.players[0];
  const guest = addPlayer(room, '乙');
  const spectator = addPlayer(room, '观众', { spectator: true });
  accept(room, host, { kind: 'start-game' });
  for (const player of [host, guest]) accept(room, player, { kind: 'setup' });
  return { room, host, guest, spectator };
}

function recordPlaying() {
  const room = createRoom({ hostName: '房主', initialClueCount: 0 });
  const host = room.players[0];
  const guest = addPlayer(room, '选手');
  accept(room, host, { kind: 'start-game' });
  for (const player of [host, guest]) {
    accept(room, player, { kind: 'setup', noClues: true });
  }
  return { room, host, guest };
}

test('spectators are not counted toward the four builtin seats', () => {
  const room = createRoom({ playMode: 'builtin', puzzle: puzzleFixture(), hostName: '甲' });
  while (seatedPlayers(room).length < 4) addPlayer(room, `玩家 ${seatedPlayers(room).length + 1}`);
  const spectator = addPlayer(room, '观众甲', { spectator: true });
  assert.equal(spectator.spectator, true);
  assert.equal(seatedPlayers(room).length, 4);
  assert.equal(room.players.length, 5);
  assert.equal(viewFor(room, room.hostId).playerCount, 4);
  assert.equal(viewFor(room, room.hostId).spectatorCount, 1);
  assert.throws(() => addPlayer(room, '第五位玩家'), /最多支持 4 名玩家/);
  assert.equal(addPlayer(room, '观众乙', { spectator: true }).spectator, true);
  assert.equal(viewFor(room, room.hostId).spectatorCount, 2);
});

test('spectators may join a builtin table after kickoff while seated players may not', () => {
  const { room, host, spectator } = builtinWithSpectator();
  assert.equal(room.phase, 'play');
  assert.throws(() => addPlayer(room, '迟到玩家'), /开始|加入/);
  const late = addPlayer(room, '中途观众', { spectator: true });
  assert.equal(late.spectator, true);
  assert.equal(viewFor(room, late.id).amSpectator, true);
  assert.equal(viewFor(room, late.id).mySetup, null);
  assert.equal(viewFor(room, host.id).playerCount, 2);
  assert.ok(viewFor(room, spectator.id).players.some((player) => player.id === late.id && player.spectator));
});

test('spectators never take turns and cannot submit game actions', () => {
  const { room, host, guest, spectator } = builtinWithSpectator();
  assert.deepEqual(turnOrder(room).map((player) => player.id), [host.id, guest.id]);
  assert.equal(currentPlayer(room).id, host.id);
  assert.equal(viewFor(room, spectator.id).isMyTurn, false);
  const blocked = applyRoomAction(room, spectator.id, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 3, count: 1 });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /观战/);
  assert.equal(applyRoomAction(room, spectator.id, { kind: 'setup' }).ok, false);
  assert.equal(applyRoomAction(room, spectator.id, { kind: 'start-game' }).ok, false);
});

test('spectators see private action results that seated peers cannot', () => {
  const { room, host, guest } = recordPlaying();
  const spectator = addPlayer(room, '观众', { spectator: true });
  accept(room, host, { kind: 'survey', type: Obj.ASTEROID, start: 0, size: 3, count: 2 });
  const hostState = stateFor(room, host.id);
  const guestState = stateFor(room, guest.id);
  const spectatorState = stateFor(room, spectator.id);
  const hostSurvey = hostState.entries.find((entry) => entry.type === 'survey');
  const guestSurvey = guestState.entries.find((entry) => entry.type === 'survey');
  const spectatorSurvey = spectatorState.entries.find((entry) => entry.type === 'survey');
  assert.equal(hostSurvey.count, 2);
  assert.equal(guestSurvey.count, undefined);
  assert.equal(spectatorSurvey.count, 2);
  assert.equal(viewFor(room, spectator.id).amSpectator, true);
  assert.equal(viewFor(room, spectator.id).players.find((player) => player.id === spectator.id).spectator, true);
  assert.equal(viewFor(room, guest.id).players.find((player) => player.id === host.id).spectator, false);
});

test('spectators do not block research declarations or setup readiness', () => {
  const room = createRoom({ hostName: '房主', initialClueCount: 0 });
  const host = room.players[0];
  const guest = addPlayer(room, '选手');
  addPlayer(room, '观众', { spectator: true });
  accept(room, host, { kind: 'start-game' });
  assert.equal(Object.keys(room.setup).length, 2);
  assert.equal(room.setup[host.id] != null, true);
  for (const player of [host, guest]) {
    accept(room, player, { kind: 'setup', noClues: true });
  }
  assert.equal(room.phase, 'play');
  assert.equal(viewFor(room, host.id).playerCount, 2);
  assert.equal(viewFor(room, host.id).spectatorCount, 1);
});

test('spectator seats stop at the soft cap', () => {
  const room = createRoom({ hostName: '房主' });
  for (let index = 0; index < MAX_SPECTATORS; index += 1) addPlayer(room, `观众 ${index + 1}`, { spectator: true });
  assert.throws(() => addPlayer(room, '超额观众', { spectator: true }), /观战席最多/);
  assert.equal(seatedPlayers(room).length, 1);
});
