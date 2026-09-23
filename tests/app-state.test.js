import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, applyRoomAction, createRoom, viewFor } from '../public/src/room.js';
import { CODE, Obj, THEORY_TYPES } from '../public/src/types.js';
import { createServer, rooms } from '../server.mjs';
import { inMemoryFetch } from './server-dispatch.js';
import { createRoom as createOnlineRoom, fetchView, loadRoom, loadTutorialReturn, saveRoom } from '../public/src/online.js';

function makeElement(tagName) {
  return {
    nodeType: 1, tagName, children: [], attributes: {}, style: {}, dataset: {}, listeners: {}, firstChild: null,
    append(...children) { this.children.push(...children); this.firstChild = this.children[0] || null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, handler) { this.listeners[name] = handler; },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); this.firstChild = this.children[0] || null; },
  };
}

const storage = new Map();
const tabStorage = new Map();
const originalGlobals = Object.fromEntries(['document', 'localStorage', 'sessionStorage', 'fetch'].map((key) => [key, globalThis[key]]));
globalThis.document = {
  createElement: makeElement,
  createElementNS: (namespace, tagName) => makeElement(tagName),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
};
const storageAdapter = (store) => ({ getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) });
globalThis.localStorage = storageAdapter(storage);
globalThis.sessionStorage = storageAdapter(tabStorage);
const { createApp, appTiming } = await import('../public/ui/app.js');
appTiming.toastMs = 0;
test.beforeEach(() => { storage.clear(); tabStorage.clear(); });
test.after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const [key, value] of Object.entries(originalGlobals)) globalThis[key] = value;
});

function setupTable() {
  const room = createRoom({ initialClueCount: 4 });
  const guest = addPlayer(room, '来宾');
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'start-game' }).ok, true);
  const host = room.players[0];
  const identity = { roomId: room.id, playerId: host.id, token: host.token };
  let revision = 0;
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/action$/);
    const action = JSON.parse(options.body).action;
    const result = applyRoomAction(room, host.id, action);
    if (result.ok) revision += 1;
    return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: { ...viewFor(room, host.id), revision } }) };
  };
  const app = createApp(makeElement('div'));
  app.state.remote = { ...identity, view: viewFor(room, host.id) };
  app.render();
  return { room, guest, host, identity, app };
}

function puzzleFixture() {
  const objects = [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID];
  // Reconstruct the startingClues pool the same way builtin-room.test.js does
  const pool = objects.flatMap((actual, sector) =>
    THEORY_TYPES
      .filter((objectType) => objectType !== actual && (objectType !== Obj.COMET || [1, 2, 4, 6, 10].includes(sector)))
      .map((objectType) => ({ sector, type: objectType }))).slice(0, 12);
  return {
    objects,
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `研究 ${topic}`, clue: `私有线索 ${topic}` }])),
    conferences: { 10: 'X行星会议专属线索' },
    startingClues: [pool],
  };
}

function setupBuiltinPlayTable(context) {
  const server = createServer();
  globalThis.fetch = inMemoryFetch(server);
  context.after(() => server.close());
  const puzzle = puzzleFixture();
  const room = createRoom({ playMode: 'builtin', puzzle, hostName: '甲', initialClueCount: 4 });
  const host = room.players[0];
  // Advance from lobby → play: start-game then each player claims clues and confirms ready
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'claim-initial-clues', count: 4 }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup' }).ok, true);
  assert.equal(room.phase, 'play');
  const identity = { roomId: room.id, playerId: host.id, token: host.token };
  let revision = 0;
  globalThis.fetch = async (url, options) => {
    const action = JSON.parse(options.body).action;
    const result = applyRoomAction(room, host.id, action);
    if (result.ok) revision += 1;
    return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: { ...viewFor(room, host.id), revision } }) };
  };
  const app = createApp(makeElement('div'));
  app.state.remote = { ...identity, view: viewFor(room, host.id) };
  app.state.notes = {};
  app.render();
  return { room, host, identity, app };
}

const recordNames = {
  topicNames: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((id) => [id, `课题${id}`])),
  conferenceNames: { 10: '彗星的邻居' },
  conferences: {},
};
const validClues = [
  { sector: 0, type: Obj.GAS_CLOUD }, { sector: 1, type: Obj.ASTEROID },
  { sector: 2, type: Obj.COMET }, { sector: 3, type: Obj.DWARF_PLANET },
];
const keyOf = (clue) => `${clue.sector}:${CODE[clue.type]}`;

test('rejected record setup keeps the draft and never auto-marks rejected clues', async () => {
  const { app } = setupTable();
  app.api.setMark(9, CODE[Obj.ASTEROID], 'yes');
  const notes = { ...app.state.notes };
  const draft = { clues: validClues.slice(0, 3), noClues: false, topicNames: { A: '待提交' }, conferences: {} };
  app.api.setUi({ setup: draft });
  const result = await app.api.submitSetup();
  assert.equal(result.ok, false);
  assert.deepEqual(app.state.notes, notes);
  assert.deepEqual(app.state.ui.setup, draft);
});

test('a zero-count multi-sector survey auto-marks every surveyed sector as "no" for that type', async (context) => {
  withServer(context);
  const { app } = setupBuiltinPlayTable(context);
  // pick sectors 3 and 5 → size 3 covering 3/4/5; all visible in window 1-6.
  // Sector 3=EMPTY, 4=PLANET_X, 5=COMET → ASTEROID count = 0 → all marked "no".
  app.api.setUi({ action: 'survey', surveyType: Obj.ASTEROID, pick: [3, 5] });
  const result = await app.api.confirmAction();
  assert.equal(result.ok, true, result.error);
  assert.equal(app.state.notes[`3:${CODE[Obj.ASTEROID]}`], 'no');
  assert.equal(app.state.notes[`4:${CODE[Obj.ASTEROID]}`], 'no');
  assert.equal(app.state.notes[`5:${CODE[Obj.ASTEROID]}`], 'no');
  // Other object types in those sectors remain untouched
  assert.equal(app.state.notes[`3:${CODE[Obj.COMET]}`], undefined);
  assert.equal(app.state.notes[`4:${CODE[Obj.GAS_CLOUD]}`], undefined);
});

test('a zero-count single-sector survey marks that one sector as "no"', async (context) => {
  withServer(context);
  const { app } = setupBuiltinPlayTable(context);
  // pick sector 5 twice → single-sector range (size 1); sector 5=COMET, ASTEROID count=0
  app.api.setUi({ action: 'survey', surveyType: Obj.ASTEROID, pick: [5, 5] });
  const result = await app.api.confirmAction();
  assert.equal(result.ok, true, result.error);
  assert.equal(app.state.notes[`5:${CODE[Obj.ASTEROID]}`], 'no');
});

test('a non-zero multi-sector survey does not auto-mark anything', async (context) => {
  withServer(context);
  const { app } = setupBuiltinPlayTable(context);
  // pick sectors 2 and 4 → size 3 covering 2/3/4, all visible (window 1-6)
  app.api.setUi({ action: 'survey', surveyType: Obj.GAS_CLOUD, pick: [2, 4] });
  const result = await app.api.confirmAction();
  assert.equal(result.ok, true, result.error);
  for (const offset of [2, 3, 4]) {
    assert.equal(app.state.notes[`${offset}:${CODE[Obj.GAS_CLOUD]}`], undefined, `sector ${offset} must remain unmarked when count > 0`);
  }
});

test('accepted record clues synchronize, survive refresh, and preserve later manual marks', async () => {
  const { app, room, host, identity } = setupTable();
  app.api.setUi({ setup: { clues: validClues, noClues: false, ...recordNames } });
  assert.equal((await app.api.submitSetup()).ok, true);
  for (const clue of validClues) assert.equal(app.state.notes[keyOf(clue)], 'no');
  assert.equal(app.state.ui.setup, null);
  app.api.setMark(0, CODE[Obj.GAS_CLOUD], 'yes');
  app.api.setMark(9, CODE[Obj.ASTEROID], 'yes');
  const refreshed = createApp(makeElement('div'));
  refreshed.state.remote = { ...identity, view: viewFor(room, host.id) };
  refreshed.state.notes = JSON.parse(storage.get(`planetx.notes.${room.id}.${host.id}`));
  refreshed.render();
  assert.equal(refreshed.state.notes[keyOf(validClues[0])], 'yes');
  assert.equal(refreshed.state.notes[keyOf(validClues[1])], 'no');
  assert.equal(refreshed.state.notes[`9:${CODE[Obj.ASTEROID]}`], 'yes');
});

test('record resubmission removes only revoked automatic exclusions, including after reload', async () => {
  const { app, room, host, identity } = setupTable();
  app.api.setUi({ setup: { clues: validClues, noClues: false, ...recordNames } });
  assert.equal((await app.api.submitSetup()).ok, true);
  app.api.setMark(0, CODE[Obj.GAS_CLOUD], 'no');
  const refreshed = createApp(makeElement('div'));
  refreshed.state.remote = { ...identity, view: viewFor(room, host.id) };
  refreshed.state.notes = JSON.parse(storage.get(`planetx.notes.${room.id}.${host.id}`));
  refreshed.render();
  assert.equal((await refreshed.api.reopenSetup()).ok, true);
  const changed = [validClues[2], validClues[3], { sector: 4, type: Obj.DWARF_PLANET }, { sector: 5, type: Obj.ASTEROID }];
  refreshed.api.setUi({ setup: { clues: changed, noClues: false, ...recordNames } });
  assert.equal((await refreshed.api.submitSetup()).ok, true);
  assert.equal(refreshed.state.notes[keyOf(validClues[0])], 'no', 'an explicitly retained manual mark is not removed');
  assert.equal(refreshed.state.notes[keyOf(validClues[1])], undefined, 'the revoked automatic mark is removed');
  for (const clue of changed) assert.equal(refreshed.state.notes[keyOf(clue)], 'no');
});

test('another player setup view never marks the current player notes', () => {
  const { app, room, guest } = setupTable();
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', clues: validClues }).ok, true);
  app.state.remote.view = viewFor(room, guest.id);
  app.render();
  assert.deepEqual(app.state.notes, {});
});

test('refresh repairs missing automatic marks but not deliberately cleared manual marks', async () => {
  const { app, room, host, identity } = setupTable();
  app.api.setUi({ setup: { clues: validClues, noClues: false, ...recordNames } });
  assert.equal((await app.api.submitSetup()).ok, true);
  await app.api.setMark(validClues[0].sector, CODE[validClues[0].type], 'maybe');
  const refreshed = createApp(makeElement('div'));
  refreshed.state.remote = { ...identity, view: viewFor(room, host.id) };
  refreshed.state.notes = {};
  refreshed.render();
  assert.equal(refreshed.state.notes[keyOf(validClues[0])], undefined);
  for (const clue of validClues.slice(1)) assert.equal(refreshed.state.notes[keyOf(clue)], 'no');
});

test('invalid initial-mark metadata does not prevent accepted clues from restoring', async () => {
  const { app, room, host, identity } = setupTable();
  app.api.setUi({ setup: { clues: validClues, noClues: false, ...recordNames } });
  assert.equal((await app.api.submitSetup()).ok, true);
  storage.set(`planetx.notes.${room.id}.${host.id}.initial-clues`, 'null');
  const refreshed = createApp(makeElement('div'));
  refreshed.state.remote = { ...identity, view: viewFor(room, host.id) };
  refreshed.state.notes = {};
  assert.doesNotThrow(() => refreshed.render());
  for (const clue of validClues) assert.equal(refreshed.state.notes[keyOf(clue)], 'no');
});

function withServer(context) {
  const server = createServer();
  globalThis.fetch = inMemoryFetch(server);
  context.after(() => server.close());
}

function findElement(root, predicate) {
  if (predicate(root)) return root;
  for (const child of root.children || []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

async function restoredApp() {
  const app = createApp(makeElement('div'));
  for (let attempt = 0; attempt < 20 && !app.state.remote; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(app.state.remote, 'saved room is restored');
  return app;
}

async function reachTutorialMark(app) {
  for (let step = 0; step < 60 && app.state.game.tutorial.interaction !== 'mark'; step += 1) {
    const guide = app.state.game.tutorial;
    const result = guide.interaction === 'action' ? await app.api.consoleAction(guide.expected)
      : guide.interaction === 'inspect' ? await app.api.consoleAction({ kind: 'tutorial-inspect', ...guide.expected })
        : await app.api.tutorialNext();
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(app.state.game.tutorial.interaction, 'mark');
}

test('tutorial entry, restart and exit preserve the offline session and private notes', async (context) => {
  withServer(context);
  const app = createApp(makeElement('div'));
  app.api.consoleAction({ kind: 'research', topic: 'A', name: '原课题', text: '原线索' });
  app.api.setMark(9, CODE[Obj.ASTEROID], 'yes');
  const originalSession = structuredClone(app.session);
  const originalNotes = { ...app.state.notes };
  assert.equal(typeof app.api.startTutorial, 'function');
  assert.equal((await app.api.startTutorial()).ok, true);
  const firstRoom = app.room().roomId;
  assert.equal(app.state.game.playMode, 'builtin');
  assert.ok(app.state.game.tutorial);
  assert.equal(app.state.notes[`9:${CODE[Obj.ASTEROID]}`], undefined);
  assert.deepEqual(loadTutorialReturn(), { room: null });
  assert.equal((await app.api.tutorialNext()).ok, true);
  assert.equal(app.state.game.tutorial.interaction, 'inspect');
  assert.equal((await app.api.restartTutorial()).ok, true);
  assert.notEqual(app.room().roomId, firstRoom);
  assert.equal(app.state.game.tutorial.interaction, 'continue');
  assert.deepEqual(loadTutorialReturn(), { room: null });
  assert.equal((await app.api.exitTutorial()).ok, true);
  assert.equal(app.room(), null);
  assert.deepEqual(app.session, originalSession);
  assert.deepEqual(app.state.notes, originalNotes);
  assert.equal(loadRoom(), null);
  assert.equal(loadTutorialReturn(), null);
});

test('tutorial reload restores progress then exits back to the original online identity and notes', async (context) => {
  withServer(context);
  const ordinary = await createOnlineRoom({ name: '原房主', initialClueCount: 0 });
  const app = createApp(makeElement('div'));
  app.state.remote = { ...ordinary, view: ordinary.view };
  app.render();
  app.api.setMark(8, CODE[Obj.COMET], 'yes');
  const normalRoomBefore = structuredClone(rooms.get(ordinary.roomId));
  assert.equal(typeof app.api.startTutorial, 'function');
  assert.equal((await app.api.startTutorial()).ok, true);
  assert.equal((await app.api.tutorialNext()).ok, true);
  const stepId = app.state.game.tutorial.stepId;
  const refreshed = await restoredApp();
  assert.equal(refreshed.state.game.tutorial.stepId, stepId);
  assert.equal(refreshed.state.notes[`8:${CODE[Obj.COMET]}`], undefined);
  assert.equal((await refreshed.api.exitTutorial()).ok, true);
  assert.equal(refreshed.room().roomId, ordinary.roomId);
  assert.equal(refreshed.room().playerId, ordinary.playerId);
  assert.equal(loadRoom().token, ordinary.token);
  assert.equal(refreshed.state.notes[`8:${CODE[Obj.COMET]}`], 'yes');
  assert.deepEqual(rooms.get(ordinary.roomId), normalRoomBefore);
});

test('tutorial real map inspection and marking advance only after accepted input', async (context) => {
  withServer(context);
  const root = makeElement('div');
  const app = createApp(root);
  assert.equal(typeof app.api.startTutorial, 'function');
  assert.equal((await app.api.startTutorial()).ok, true);
  const earlyMark = await app.api.setMark(5, CODE[Obj.PLANET_X], 'yes');
  assert.equal(earlyMark.ok, false);
  assert.equal(app.state.notes[`5:${CODE[Obj.PLANET_X]}`], undefined);
  await app.api.tutorialNext();
  const inspectId = app.state.game.tutorial.stepId;
  const sector = findElement(root, (element) => element.attributes?.['data-sector'] === 0);
  const wedge = findElement(sector, (element) => element.listeners?.click);
  assert.ok(wedge);
  await wedge.listeners.click({ preventDefault() {}, stopPropagation() {} });
  assert.notEqual(app.state.game.tutorial.stepId, inspectId);
  for (let step = 0; step < 60 && app.state.game.tutorial.interaction !== 'mark'; step += 1) {
    const guide = app.state.game.tutorial;
    const result = guide.interaction === 'action' ? await app.api.consoleAction(guide.expected) : await app.api.tutorialNext();
    assert.equal(result.ok, true, result.error);
  }
  assert.equal(app.state.game.tutorial.interaction, 'mark');
  const markId = app.state.game.tutorial.stepId;
  assert.equal((await app.api.setMark(4, CODE[Obj.PLANET_X], 'yes')).ok, false);
  assert.equal(app.state.game.tutorial.stepId, markId);
  assert.equal(app.state.notes[`4:${CODE[Obj.PLANET_X]}`], undefined);
  assert.equal((await app.api.setMark(5, CODE[Obj.PLANET_X], 'yes')).ok, true);
  assert.equal(app.state.notes[`5:${CODE[Obj.PLANET_X]}`], 'yes');
  assert.equal(app.state.game.tutorial.expected.kind, 'locate');
});

for (const recovery of ['reload', 'view']) {
  test(`accepted tutorial marks recover from a lost response through ${recovery}`, async (context) => {
    withServer(context);
    const app = createApp(makeElement('div'));
    assert.equal((await app.api.startTutorial()).ok, true);
    await reachTutorialMark(app);
    const { stepId, expected } = app.state.game.tutorial;
    const markKey = `${expected.sector}:${expected.code}`;
    const originalFetch = globalThis.fetch;
    let dropResponse = true;
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (dropResponse && options?.body && JSON.parse(options.body).action?.kind === 'tutorial-mark') {
        dropResponse = false;
        throw new Error('已接受的教学标记响应丢失');
      }
      return response;
    };
    assert.equal((await app.api.setMark(expected.sector, expected.code, expected.markState)).ok, false);
    const recovered = recovery === 'reload' ? await restoredApp() : app;
    if (recovery === 'view') {
      recovered.state.remote.view = await fetchView(recovered.room());
      recovered.render();
    }
    assert.notEqual(recovered.state.game.tutorial.stepId, stepId);
    assert.equal(recovered.state.game.tutorial.expected.kind, 'locate');
    assert.equal(recovered.state.notes[markKey], expected.markState);
    const storedNotes = JSON.parse(storage.get(`planetx.notes.${recovered.room().roomId}.${recovered.room().playerId}`));
    assert.equal(storedNotes[markKey], expected.markState);
    assert.equal((await recovered.api.consoleAction({ kind: 'tutorial-mark', stepId, ...expected })).ok, false);
    for (let step = 0; step < 10 && !recovered.state.game.tutorial.completed; step += 1) {
      const guide = recovered.state.game.tutorial;
      const result = guide.interaction === 'action' ? await recovered.api.consoleAction(guide.expected) : await recovered.api.tutorialNext();
      assert.equal(result.ok, true, result.error);
    }
    assert.equal(recovered.state.game.tutorial.completed, true);
    assert.equal((await recovered.api.setMark(expected.sector, expected.code, 'maybe')).ok, true);
    const cleared = await restoredApp();
    assert.equal(cleared.state.notes[markKey], undefined, 'recovery does not undo a later manual clear');
  });
}

test('an undelivered tutorial mark stays unmarked after reload until a real accepted retry', async (context) => {
  withServer(context);
  const app = createApp(makeElement('div'));
  assert.equal((await app.api.startTutorial()).ok, true);
  await reachTutorialMark(app);
  const { stepId, expected } = app.state.game.tutorial;
  const markKey = `${expected.sector}:${expected.code}`;
  const originalFetch = globalThis.fetch;
  let dropRequest = true;
  globalThis.fetch = async (url, options) => {
    if (dropRequest && options?.body && JSON.parse(options.body).action?.kind === 'tutorial-mark') {
      dropRequest = false;
      throw new Error('教学标记请求未送达');
    }
    return originalFetch(url, options);
  };
  assert.equal((await app.api.setMark(expected.sector, expected.code, expected.markState)).ok, false);
  const refreshed = await restoredApp();
  assert.equal(refreshed.state.game.tutorial.stepId, stepId);
  assert.equal(refreshed.state.notes[markKey], undefined);
  assert.equal((await refreshed.api.setMark(expected.sector, expected.code, expected.markState)).ok, true);
  assert.equal(refreshed.state.notes[markKey], expected.markState);
});

for (const droppedResponse of [false, true]) {
  test(`cancelled tutorial entry releases the lobby without disturbing a newer request (${droppedResponse ? 'lost response' : 'late response'})`, async (context) => {
    withServer(context);
    const ordinary = await createOnlineRoom({ name: '原房主', initialClueCount: 0 });
    const app = createApp(makeElement('div'));
    app.state.remote = { ...ordinary, view: ordinary.view };
    app.render();
    const originalFetch = globalThis.fetch;
    const requests = [];
    const gates = Array.from({ length: 2 }, () => {
      let release;
      let signal;
      const response = new Promise((resolve) => { release = resolve; });
      const started = new Promise((resolve) => { signal = resolve; });
      return { response, started, release, signal };
    });
    let created = 0;
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (String(url).endsWith('/rooms')) {
        const index = created++;
        gates[index].signal();
        await gates[index].response;
        if (index === 0 && droppedResponse) throw new Error('教学创建响应丢失');
      }
      return response;
    };
    try {
      requests.push(app.api.startTutorial());
      await gates[0].started;
      app.api.patchLobby({ name: '继续教学' });
      await app.api.leaveRoom();
      assert.equal(app.room(), null);
      assert.equal(app.state.ui.lobby.busy, false, 'leaving releases the cancelled entry');
      requests.push(app.api.startTutorial());
      await gates[1].started;
      gates[0].release();
      assert.equal((await requests[0]).ok, false);
      assert.equal(app.state.ui.lobby.busy, true, 'the older request cannot clear the newer busy state');
      assert.equal(app.state.ui.lobby.error, null);
      assert.equal(app.room(), null);
      gates[1].release();
      assert.equal((await requests[1]).ok, true);
      assert.equal(app.state.ui.lobby.busy, false);
      assert.ok(app.state.game.tutorial);
      assert.equal(app.state.ui.lobby.name, '继续教学');
    } finally {
      for (const gate of gates) gate.release();
      await Promise.allSettled(requests);
    }
  });
}

for (const releaseDuringCreation of [false, true]) {
  test(`tutorial entry retains a saved normal identity while reload restoration is pending (${releaseDuringCreation ? 'during creation' : 'after creation'})`, async (context) => {
    withServer(context);
    const ordinary = await createOnlineRoom({ name: '原房主', initialClueCount: 0 });
    saveRoom({ roomId: ordinary.roomId, playerId: ordinary.playerId, token: ordinary.token });
    storage.set(`planetx.notes.${ordinary.roomId}.${ordinary.playerId}`, JSON.stringify({ '8:2': 'yes' }));
    const originalFetch = globalThis.fetch;
    let releaseRestore;
    let releaseCreate;
    let signalRestore;
    let signalCreate;
    const restoreStarted = new Promise((resolve) => { signalRestore = resolve; });
    const createStarted = new Promise((resolve) => { signalCreate = resolve; });
    const restoreGate = new Promise((resolve) => { releaseRestore = resolve; });
    const createGate = new Promise((resolve) => { releaseCreate = resolve; });
    let holdRestore = true;
    globalThis.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (String(url).includes(`/rooms/${ordinary.roomId}/view`) && holdRestore) {
        holdRestore = false;
        signalRestore();
        await restoreGate;
      } else if (String(url).endsWith('/rooms')) {
        signalCreate();
        await createGate;
      }
      return response;
    };
    const app = createApp(makeElement('div'));
    await restoreStarted;
    assert.equal(app.room(), null);
    const starting = app.api.startTutorial();
    await createStarted;
    if (releaseDuringCreation) {
      releaseRestore();
      await new Promise((resolve) => setImmediate(resolve));
    }
    releaseCreate();
    const result = await starting;
    releaseRestore();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(result.ok, true, result.error);
    assert.ok(app.state.game.tutorial);
    assert.equal(loadTutorialReturn().room?.roomId, ordinary.roomId);
    assert.equal((await app.api.exitTutorial()).ok, true);
    assert.equal(app.room().roomId, ordinary.roomId);
    assert.deepEqual(app.state.notes, { '8:2': 'yes' });
  });
}
