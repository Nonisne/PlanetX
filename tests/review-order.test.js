import test from 'node:test';
import assert from 'node:assert/strict';
import { timeOf } from '../public/src/console.js';
import { Obj } from '../public/src/types.js';
import { addPlayer, applyRoomAction, createRoom, currentPlayer, turnOrder, viewFor, windowTimeOf } from '../public/src/room.js';

const PHASE_ACTIONS = new Set(['research-declare', 'research-submit']);

function send(room, player, action) {
  const payload = PHASE_ACTIONS.has(action.kind) ? { phaseId: room.research?.id, ...action } : action;
  return applyRoomAction(room, player.id, payload);
}

function accepted(room, player, action) {
  const result = send(room, player, action);
  assert.equal(result.ok, true, `${action.kind}: ${result.error}`);
  return result;
}

function rejectedWithoutMutation(room, player, action) {
  const before = structuredClone(room);
  const result = send(room, player, action);
  assert.equal(result.ok, false, `Expected rejection without mutation: ${JSON.stringify(action)}`);
  assert.deepEqual(room, before, 'A rejected request must not change clocks, papers, declarations or the phase queue');
  return result;
}

function playing() {
  const room = createRoom({ hostName: '甲', initialClueCount: 0 });
  const host = room.players[0];
  const guest = addPlayer(room, '乙');
  accepted(room, host, { kind: 'start-game' });
  for (const player of room.players) accepted(room, player, { kind: 'setup', noClues: true });
  return { room, host, guest };
}

function nextPhase(room, sector) {
  for (let step = 0; !room.research && step < 60; step += 1) {
    accepted(room, currentPlayer(room), { kind: 'wait' });
  }
  assert.equal(room.research?.sector, sector, `Expected theory phase at sector ${sector}`);
}

function publishPhase(room, claims = {}) {
  for (const player of room.players) {
    accepted(room, player, { kind: 'research-declare', count: claims[player.id] ? 1 : 0 });
  }
  const order = room.research?.order.slice() || [];
  return order.map((playerId) => {
    const player = room.players.find((candidate) => candidate.id === playerId);
    return accepted(room, player, { kind: 'research-submit', ...claims[playerId] }).entry;
  });
}

function readyPapers(room, claims) {
  nextPhase(room, 3);
  const papers = publishPhase(room, claims);
  for (const sector of [6, 9]) {
    nextPhase(room, sector);
    publishPhase(room);
  }
  assert.ok(papers.every((paper) => paper.slot === 1 && paper.review === 'pending'));
  return papers;
}

function queuedPhases() {
  const fixture = playing();
  for (const player of fixture.room.players) accepted(fixture.room, player, { kind: 'wait' });
  for (const player of fixture.room.players) {
    accepted(fixture.room, player, {
      kind: 'locate', sector: 0, left: Obj.ASTEROID, right: Obj.COMET, correct: false,
    });
  }
  assert.equal(fixture.room.research?.sector, 3);
  assert.equal(fixture.room.pendingResearch?.length, 1);
  return fixture;
}

function clocks(room) {
  return room.players.map((player) => timeOf(room.session, player.id));
}

function orderIds(room) {
  return turnOrder(room).map((player) => player.id);
}

function eventIdentity(event) {
  return { id: event.id, time: event.time, sector: event.sector };
}

test('penalty-triggered theory events stay behind previously queued events in FIFO order', () => {
  const { room, host, guest } = playing();
  nextPhase(room, 3);
  const correct = publishPhase(room, { [host.id]: { sector: 4, objectType: Obj.COMET } })[0];
  nextPhase(room, 6);
  publishPhase(room, {
    [host.id]: { sector: 4, objectType: Obj.GAS_CLOUD },
    [guest.id]: { sector: 4, objectType: Obj.GAS_CLOUD },
  });
  for (let step = 0; windowTimeOf(room) < 8 && step < 20; step += 1) {
    accepted(room, currentPlayer(room), { kind: 'wait' });
  }
  assert.equal(windowTimeOf(room), 8);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    accepted(room, currentPlayer(room), {
      kind: 'locate', sector: 0, left: Obj.ASTEROID, right: Obj.COMET, correct: false,
    });
  }
  assert.deepEqual(clocks(room), [13, 13]);
  assert.equal(room.research?.sector, 9);
  assert.equal(room.pendingResearch?.length, 1);
  publishPhase(room, {
    [host.id]: { sector: 4, objectType: Obj.ASTEROID },
    [guest.id]: { sector: 4, objectType: Obj.ASTEROID },
  });
  const review = accepted(room, host, { kind: 'review', id: correct.id, review: 'correct' });
  assert.equal(review.penalties.length, 4);
  assert.deepEqual(clocks(room), [15, 15]);
  assert.equal(room.research?.sector, 12, 'The queued sector 12 phase must precede the new sector 3 phase');
  assert.deepEqual(eventIdentity(room.research), { id: 'theory:12', time: 12, sector: 12 });
  assert.deepEqual(room.pendingResearch.map(eventIdentity), [{ id: 'theory:15', time: 15, sector: 3 }]);
  publishPhase(room);
  assert.deepEqual(eventIdentity(room.research), { id: 'theory:15', time: 15, sector: 3 });
  publishPhase(room);
  assert.equal(room.research, null);
  assert.equal(room.pendingResearch?.length || 0, 0);
});

test('one wrong review batches matching inner theories and repeated reviews do not penalize again', () => {
  const { room, host, guest } = playing();
  const papers = readyPapers(room, {
    [host.id]: { sector: 4, objectType: Obj.COMET },
    [guest.id]: { sector: 4, objectType: Obj.COMET },
  });
  const previousOrder = orderIds(room);
  const previousClocks = clocks(room);
  const guestPaper = papers.find((paper) => paper.actorId === guest.id);
  const review = accepted(room, guest, { kind: 'review', id: guestPaper.id, review: 'wrong' });
  assert.equal(review.penalties.length, 2, 'One verdict must settle both matching theories in the inner space');
  assert.deepEqual(review.penalties.map((penalty) => penalty.actorId), previousOrder);
  assert.deepEqual(papers.map((paper) => paper.review), ['wrong', 'wrong']);
  assert.ok(papers.every((paper) => paper.revealed));
  assert.deepEqual(clocks(room), previousClocks.map((time) => time + 1));
  assert.deepEqual(orderIds(room), previousOrder);
  const settled = structuredClone(room);
  for (const paper of papers) {
    const author = room.players.find((player) => player.id === paper.actorId);
    const replay = accepted(room, author, { kind: 'review', id: paper.id, review: 'wrong' });
    assert.equal(replay.alreadyReviewed, true);
    assert.deepEqual(replay.penalties, []);
  }
  assert.deepEqual(room, settled);
});

test('reversing matching review requests preserves the original pawn order', () => {
  const { room, host, guest } = playing();
  const papers = readyPapers(room, {
    [host.id]: { sector: 4, objectType: Obj.COMET },
    [guest.id]: { sector: 4, objectType: Obj.COMET },
  });
  const previousOrder = orderIds(room);
  const previousClocks = clocks(room);
  for (const paper of [...papers].reverse()) {
    const author = room.players.find((player) => player.id === paper.actorId);
    accepted(room, author, { kind: 'review', id: paper.id, review: 'wrong' });
  }
  assert.deepEqual(orderIds(room), previousOrder, 'Network request order must not reorder equally penalized pawns');
  assert.deepEqual(clocks(room), previousClocks.map((time) => time + 1));
});

test('a wrong review leaves matching outer theories private, pending and unpenalized', () => {
  const { room, host, guest } = playing();
  nextPhase(room, 3);
  const inner = publishPhase(room, { [host.id]: { sector: 4, objectType: Obj.COMET } })[0];
  nextPhase(room, 6);
  const outer = publishPhase(room, { [guest.id]: { sector: 4, objectType: Obj.COMET } })[0];
  nextPhase(room, 9);
  publishPhase(room);
  assert.equal(inner.slot, 1);
  assert.equal(outer.slot, 2);
  const previousClocks = clocks(room);
  const beforeReview = viewFor(room, host.id).entries.find((entry) => entry.id === outer.id);
  assert.equal(Object.hasOwn(beforeReview, 'objectType'), false);
  const review = accepted(room, host, { kind: 'review', id: inner.id, review: 'wrong' });
  assert.equal(review.penalties.length, 1);
  assert.equal(outer.review, 'pending');
  assert.equal(outer.revealed, false);
  assert.deepEqual(clocks(room), [previousClocks[0] + 1, previousClocks[1]]);
  const otherPaper = viewFor(room, host.id).entries.find((entry) => entry.id === outer.id);
  assert.equal(Object.hasOwn(otherPaper, 'objectType'), false);
});

test('peer review rejects a higher sector until every lower ready sector is settled', () => {
  const { room, host, guest } = playing();
  const papers = readyPapers(room, {
    [host.id]: { sector: 1, objectType: Obj.COMET },
    [guest.id]: { sector: 2, objectType: Obj.COMET },
  });
  const lower = papers.find((paper) => paper.sector === 1);
  const higher = papers.find((paper) => paper.sector === 2);
  const previousOrder = orderIds(room);
  rejectedWithoutMutation(room, guest, { kind: 'review', id: higher.id, review: 'wrong' });
  accepted(room, host, { kind: 'review', id: lower.id, review: 'wrong' });
  accepted(room, guest, { kind: 'review', id: higher.id, review: 'wrong' });
  assert.deepEqual(orderIds(room), previousOrder);
});

test('only the lowest ready sector is public until it settles and exposes the next sector', () => {
  const { room, host, guest } = playing();
  const papers = readyPapers(room, {
    [host.id]: { sector: 1, objectType: Obj.COMET },
    [guest.id]: { sector: 2, objectType: Obj.COMET },
  });
  const lower = papers.find((paper) => paper.sector === 1);
  const higher = papers.find((paper) => paper.sector === 2);
  const publicLower = viewFor(room, guest.id).entries.find((entry) => entry.id === lower.id);
  const privateHigher = viewFor(room, host.id).entries.find((entry) => entry.id === higher.id);
  assert.equal(publicLower.revealed, true);
  assert.equal(publicLower.objectType, Obj.COMET);
  assert.equal(privateHigher.revealed, false, 'A higher sector must wait for all lower ready sectors');
  assert.equal(Object.hasOwn(privateHigher, 'objectType'), false);
  const ownHigher = viewFor(room, guest.id).entries.find((entry) => entry.id === higher.id);
  assert.equal(ownHigher.objectType, Obj.COMET, 'The owner can still see their private theory');
  accepted(room, host, { kind: 'review', id: lower.id, review: 'wrong' });
  const publicHigher = viewFor(room, host.id).entries.find((entry) => entry.id === higher.id);
  assert.equal(publicHigher.revealed, true);
  assert.equal(publicHigher.objectType, Obj.COMET);
  assert.equal(publicHigher.review, 'pending', 'Revealing the next sector must not judge its theories');
});

test('empty queued phases have distinct absolute event identities exposed by researchView', () => {
  const { room, host, guest } = queuedPhases();
  const first = eventIdentity(room.research);
  const firstViews = [host, guest].map((player) => viewFor(room, player.id).research);
  const pending = structuredClone(room.pendingResearch);
  publishPhase(room);
  const second = eventIdentity(room.research);
  assert.notEqual(second.id, first.id, 'Completing an empty phase must not reuse its identity for the next phase');
  assert.deepEqual(first, { id: 'theory:3', time: 3, sector: 3 });
  assert.deepEqual(second, { id: 'theory:6', time: 6, sector: 6 });
  assert.deepEqual(pending.map(eventIdentity), [second]);
  assert.ok(pending.every((event) => event.kind === 'theory'));
  assert.ok(firstViews.every((view) => view.id === first.id));
  for (const player of room.players) assert.equal(viewFor(room, player.id).research.id, second.id);
});

for (const kind of PHASE_ACTIONS) {
  for (const phaseCase of ['missing', 'stale']) {
    test(`${kind} rejects a ${phaseCase} phaseId without changing the current phase`, () => {
      const { room, host, guest } = queuedPhases();
      const oldPhaseId = room.research.id;
      publishPhase(room);
      assert.equal(room.research?.sector, 6);
      if (kind !== 'research-declare') {
        accepted(room, host, { kind: 'research-declare', count: 1 });
        accepted(room, guest, { kind: 'research-declare', count: 0 });
      }
      const phaseId = phaseCase === 'missing' ? undefined : oldPhaseId;
      const action = kind === 'research-declare'
        ? { kind, phaseId, count: 0 }
        : { kind, phaseId, sector: 4, objectType: Obj.COMET };
      rejectedWithoutMutation(room, host, action);
      if (kind === 'research-declare') {
        accepted(room, host, { kind: 'research-declare', count: 1 });
        accepted(room, guest, { kind: 'research-declare', count: 0 });
      }
      accepted(room, host, { kind: 'research-submit', sector: 4, objectType: Obj.COMET });
      assert.equal(room.research, null);
    });
  }
}

test('legacy theory actions stay rejected with missing, stale or current phase ids', () => {
  const { room, host, guest } = queuedPhases();
  const oldPhaseId = room.research.id;
  publishPhase(room);
  accepted(room, host, { kind: 'research-declare', count: 1 });
  accepted(room, guest, { kind: 'research-declare', count: 0 });
  for (const phaseId of [undefined, oldPhaseId, room.research.id]) {
    rejectedWithoutMutation(room, host, { kind: 'theory', phaseId, sector: 4, type: Obj.COMET });
  }
  accepted(room, host, { kind: 'research-submit', sector: 4, objectType: Obj.COMET });
  assert.equal(room.research, null);
});
