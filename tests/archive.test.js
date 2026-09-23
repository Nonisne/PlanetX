import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVE_VERSION,
  applyConsoleArchive,
  buildArchive,
  notesForSeat,
  parseArchive,
  seatToken,
} from '../public/src/archive.js';
import { createConsole } from '../public/src/console.js';
import { createRoom, addPlayer, serializeRoom, hydrateRoom, applyRoomAction, viewFor } from '../public/src/room.js';
import { Obj } from '../public/src/types.js';

test('console archive round-trips session fields and notes', () => {
  const session = createConsole({ modeId: 'standard' });
  session.entries = [
    { id: 1, type: 'survey', cost: 4, surveyType: Obj.ASTEROID, start: 0, size: 3, count: 1 },
    { id: 2, type: 'wait', cost: 1 },
  ];
  session.seq = 3;
  session.windowOffset = 1;
  session.frozenTimes = { solo: 3 };
  const notes = { '0:A': 'no', '4:C': 'yes' };
  const archive = buildArchive({ session, notes });
  assert.equal(archive.version, ARCHIVE_VERSION);
  assert.equal(archive.kind, 'console');
  assert.equal(archive.console.entries.length, 2);
  assert.deepEqual(archive.notes, notes);

  const parsed = parseArchive(JSON.stringify(archive));
  assert.equal(parsed.ok, true);
  const next = createConsole({ modeId: 'expert' });
  const applied = applyConsoleArchive(next, parsed.archive);
  assert.equal(next.mode.id, 'standard');
  assert.equal(next.entries.length, 2);
  assert.equal(next.windowOffset, 1);
  assert.deepEqual(next.frozenTimes, { solo: 3 });
  assert.deepEqual(applied.notes, notes);
});

test('online archive keeps seat tokens and per-seat notes', () => {
  const room = createRoom({ modeId: 'standard', hostName: '房主' });
  const guest = addPlayer(room, '客人');
  const snapshot = serializeRoom(room);
  const archive = buildArchive({
    remote: { playerId: guest.id, roomId: room.id },
    notes: { '1:A': 'yes' },
    roomSnapshot: snapshot,
  });
  assert.equal(archive.kind, 'online');
  assert.equal(archive.seats.length, 2);
  assert.equal(seatToken(archive, guest.id), guest.token);
  assert.equal(seatToken(archive, room.players[0].id), room.players[0].token);
  assert.deepEqual(notesForSeat(archive, guest.id), { '1:A': 'yes' });
  assert.deepEqual(notesForSeat(archive, room.players[0].id), {});
  assert.equal(parseArchive(archive).ok, true);
  assert.match(parseArchive({ version: 99, kind: 'console', console: {} }).error, /版本/);
});

test('serializeRoom / hydrateRoom round-trip preserves play state without listeners', () => {
  const room = createRoom({ modeId: 'standard', hostName: '甲', initialClueCount: 0 });
  const guest = addPlayer(room, '乙');
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'start-game' }).ok, true);
  for (const player of [room.players[0], guest]) {
    assert.equal(applyRoomAction(room, player.id, { kind: 'setup', noClues: true }).ok, true);
  }
  room.listeners.add({ unused: true });
  const plain = serializeRoom(room);
  assert.equal(plain.listeners, undefined);
  assert.equal(plain.phase, 'play');
  assert.ok(plain.players[0].token);

  const restored = hydrateRoom(plain);
  assert.ok(restored.listeners instanceof Set);
  assert.equal(restored.listeners.size, 0);
  assert.equal(restored.id, room.id);
  assert.equal(restored.phase, 'play');
  assert.equal(viewFor(restored, guest.id).me, guest.id);
  assert.equal(viewFor(restored, guest.id).players.length, 2);
});
