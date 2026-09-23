// Renders the whole UI against a minimal DOM stub so that every render path is
// executed at least once without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag) {
  return {
    nodeType: 1,
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    listeners: {},
    className: '',
    textContent: '',
    firstChild: null,
    parent: null,
    append(...kids) {
      for (const kid of kids) {
        this.children.push(kid);
        if (kid && kid.nodeType === 1) kid.parent = this;
        if (!this.firstChild) this.firstChild = kid;
      }
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
      if (key === 'class') this.className = value;
    },
    getAttribute(key) {
      return this.attributes[key];
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) this.children.splice(idx, 1);
      if (child && child.nodeType === 1) child.parent = null;
      this.firstChild = this.children[0] || null;
    },
    closest(selector) {
      let node = this;
      while (node && node.nodeType === 1) {
        if (matches(node, selector)) return node;
        node = node.parent;
      }
      return null;
    },
  };
}

const storage = new Map();
const docListeners = {};

function matches(node, selector) {
  if (selector.startsWith('.')) return (node.className || '').split(/\s+/).includes(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) return node.attributes[selector.slice(1, -1)] !== undefined;
  return false;
}

globalThis.document = {
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
  getElementById: () => makeEl('div'),
  addEventListener: (type, fn) => {
    (docListeners[type] = docListeners[type] || []).push(fn);
  },
};

function fireDocument(type, event) {
  for (const fn of docListeners[type] || []) fn(event);
}

/** A fake click event whose target is an arbitrary element (or null). */
function clickEvent(target) {
  return { target, preventDefault() {}, stopPropagation() {} };
}

globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};
const tabStorage = new Map();
globalThis.sessionStorage = {
  getItem: (k) => (tabStorage.has(k) ? tabStorage.get(k) : null),
  setItem: (k, v) => tabStorage.set(k, String(v)),
  removeItem: (k) => tabStorage.delete(k),
};
// The toast auto-dismiss is dialled down through the app's own timing knob — never by
// patching global timers, which would break real HTTP in the other test files.
const { createApp, appTiming } = await import('../public/ui/app.js');
appTiming.toastMs = 0;

const { visibleSectorsAt, mod, durationLabel, surveyCost, modeById } = await import('../public/src/rules.js');
const { Obj, CODE, CODE_TO_TYPE } = await import('../public/src/types.js');
const { createConsole, consoleView, completeTheoryPhase, recordWait, recordResearch, recordConference, recordLocate, revealObjects, nudgeWindow, recordSurvey, recordTarget, recordTheory, markTheoryReview } = await import('../public/src/console.js');
const { createRoom, addPlayer, applyRoomAction, viewFor, currentPlayer } = await import('../public/src/room.js');
const { renderBoard, GEOMETRY, sectorAngles } = await import('../public/ui/board.js');
const { renderTopicsPanel, renderTheoriesPanel } = await import('../public/ui/notesheet.js');
const { renderModal, renderStatus, renderActionPanel, renderKnowledgePanel, renderLogPanel, renderMapPanel, renderScorePanel } = await import('../public/ui/panels.js');

test('mode selection offers standard and expert builtin puzzles plus fixed tutorial entry', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  app.api.setUi({ modal: { kind: 'start' } });
  assert.match(collectText(root).join(''), /内置谜题/);
  assert.match(collectText(root).join(''), /记录模式/);
  app.api.setUi({ playMode: 'builtin', modeId: 'standard' });
  assert.match(collectText(root).join(''), /12 扇区/);
  assert.match(collectText(root).join(''), /服务/);
  assert.equal(findAll(root, (element) => element.className.split(/\s+/).includes('mode-option')).length, 2);
  assert.match(collectText(root).join(''), /双人教学/);
  app.api.setUi({ playMode: 'record' });
  assert.equal(findAll(root, (element) => element.className.split(/\s+/).includes('mode-option')).length, 2);
});

test('builtin lobby states the four-player total includes the host', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  app.api.setUi({ playMode: 'builtin', modal: { kind: 'lobby' } });
  const text = collectText(root).join('');
  assert.match(text, /1–4 人（含房主与 Bot）/);
  assert.match(text, /Bot 对手/);
  assert.equal(findAll(root, (element) => element.attributes?.['data-with-bots'] !== undefined).length, 4);
  assert.doesNotMatch(text, /最多 6 人/);
});

test('builtin waiting-room copy explains automatic delivery of the shared initial count', () => {
  const state = uiSliceState({ playMode: 'builtin', phase: 'lobby', amHost: true, playerCount: 1, roomId: 'LOBBY', players: [{ id: 'host', name: '房主', host: true }] });
  const panel = renderActionPanel({ state, api: {} });
  const text = collectText(panel).join('');
  assert.match(text, /全桌统一数量自动分发私有初始线索/);
  assert.doesNotMatch(text, /每人独立选择|领取私有初始线索/);
});

test('builtin action cards ask for queries, not self-reported results', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  const game = { ...app.state.game, playMode: 'builtin', phase: 'play', isMyTurn: true };
  const state = { ...app.state, game, ui: { ...app.state.ui, action: 'scan', pick: [0] } };
  const scan = renderActionPanel({ state, api: app.api });
  const scanConfirm = findButton(scan, '确认扫描');
  assert.ok(scanConfirm);
  assert.equal(Boolean(scanConfirm.disabled || scanConfirm.attributes.disabled), false);
  assert.equal(collectText(scan).join('').includes('记下它是什么'), false);
  state.ui = { ...state.ui, action: 'survey', pick: [0, 1] };
  const survey = renderActionPanel({ state, api: { ...app.api, pickedRange: () => ({ start: 0, size: 2 }) } });
  assert.equal(findAll(survey, (element) => element.tagName === 'input' && element.attributes.type === 'number').length, 0);
  assert.equal(collectText(survey).join('').includes('app 给出的数量'), false);
  state.ui.action = 'research';
  const research = renderActionPanel({ state, api: app.api });
  assert.equal(findAll(research, (element) => element.tagName === 'textarea' || element.tagName === 'input').length, 0);
  assert.match(collectText(research).join(''), /自动|系统/);
});

test('builtin research explains single-fact spatial clues in a persistent collapsed reference', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  const game = { ...app.state.game, playMode: 'builtin', phase: 'play', isMyTurn: true };
  const state = { ...app.state, game, ui: { ...app.state.ui, action: 'research', panels: {} } };
  const api = { ...app.api, setUiQuiet: (patch) => { state.ui = { ...state.ui, ...patch }; } };
  const panel = renderActionPanel({ state, api });
  const reference = findAll(panel, (element) => element.attributes['data-disclosure'] === 'research-terms')[0];
  assert.ok(reference, 'research has a contextual spatial-rules reference');
  assert.equal(reference.attributes.open, undefined, 'help starts collapsed rather than crowding the action');
  const text = collectText(panel).join('');
  assert.match(text, /每个课题只给一条线索/u);
  assert.match(text, /起点未知/u);
  assert.match(text, /跨越最后一格和第 1 格/u);
  assert.match(text, /正对.*6 格/u);
  assert.match(text, /最短环形距离/u);
  assert.match(text, /至少一个.*全部/u);
  fire(reference, 'toggle', { currentTarget: { open: true, isConnected: true } });
  assert.equal(state.ui.panels['research-terms'], true);
  const expanded = renderActionPanel({ state, api });
  assert.equal(findAll(expanded, (element) => element.attributes['data-disclosure'] === 'research-terms')[0].attributes.open, '');
  state.game.playMode = 'record';
  const record = renderActionPanel({ state, api });
  assert.equal(findAll(record, (element) => element.attributes['data-disclosure'] === 'research-terms').length, 0);
  assert.equal(findAll(record, (element) => element.tagName === 'textarea').length, 1);
});

test('builtin setup and tools expose no manual secret editing and locate requests no verdict', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  const game = { ...app.state.game, playMode: 'builtin', phase: 'setup', isMyTurn: true, amHost: true, mySetup: { ready: false, initialClueCount: 4, cluesClaimed: true, clues: [{ sector: 0, type: Obj.COMET }], topics: {} } };
  const state = { ...app.state, game };
  const setup = renderActionPanel({ state, api: app.api });
  assert.match(collectText(setup).join(''), /1 号/);
  assert.match(collectText(setup).join(''), /准备|确认/);
  assert.equal(findAll(setup, (element) => ['input', 'textarea', 'select'].includes(element.tagName)).length, 0);
  game.phase = 'play';
  const status = collectText(renderStatus({ state, api: app.api })).join('');
  assert.equal(status.includes('撤销最后一条'), false);
  assert.equal(status.includes('天窗 ◀'), false);
  state.ui = { ...state.ui, modal: { kind: 'locate' } };
  const locate = collectText(renderModal({ state, api: app.api })).join('');
  assert.equal(locate.includes('app 判定'), false);
  assert.match(locate, /自动判定|系统判定/);
});

test('builtin displays 空域 consistently, identifies system verdicts, and shows cumulative time', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const ownGame = {
    ...app.state.game,
    playMode: 'builtin',
    phase: 'done',
    time: 17,
    timeLabel: '第 2 圈／第 6 格',
    log: [{ id: 1, type: 'located', sector: 2, left: Obj.COMET, right: Obj.EMPTY, cost: 5, correct: true, revealed: true, time: 12 }],
  };
  const state = { ...app.state, game: ownGame };
  const status = collectText(renderStatus({ state, api: app.api })).join('');
  assert.match(status, /17 个时间单位/);
  const history = collectText(renderLogPanel({ state, api: app.api })).join('');
  assert.match(history, /系统判定：正确/);
  assert.match(history, /空域/);
  assert.equal(history.includes('空无一物'), false);
  assert.equal(history.includes('app 判定'), false);
  app.api.setUi({ modal: { kind: 'help' } });
  assert.equal(collectText(root).join('').includes('空无一物'), false);
});

test('builtin app creates a solo room, uses actual query answers, and preserves the offline save', async (context) => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const puzzle = {
    objects: [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: `课题 ${topic}`, clue: `仅自己的线索 ${topic}` }])),
    conferences: { 10: 'X行星的会议线索' },
    startingClues: Array.from({ length: 6 }, () => [
      { sector: 1, objectType: Obj.COMET },
      { sector: 1, objectType: Obj.GAS_CLOUD },
      { sector: 2, objectType: Obj.DWARF_PLANET },
      { sector: 3, objectType: Obj.ASTEROID },
    ]),
  };
  const room = createRoom({ playMode: 'builtin', puzzle });
  const host = room.players[0];
  const calls = [];
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  const snapshot = () => JSON.parse(JSON.stringify(viewFor(room, host.id)));
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    let response;
    if (String(url).endsWith('/modes')) response = { playModes: ['record', 'builtin', 'tutorial'], builtinBoards: ['standard', 'expert'], initialClueCounts: [0, 4, 8, 12] };
    else if (String(url).endsWith('/action')) {
      const result = applyRoomAction(room, host.id, body.action);
      response = { ok: result.ok, error: result.error, entry: result.entry ? { id: result.entry.id, type: result.entry.type } : null, view: snapshot() };
    } else response = { roomId: room.id, playerId: host.id, token: host.token, view: snapshot() };
    return { status: 200, json: async () => response };
  };
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const app = createApp(makeEl('div'));
  app.api.newSession('expert');
  app.api.consoleAction({ kind: 'wait' });
  app.api.setMark(17, CODE.asteroid, 'no');
  const offlineSave = storage.get('planetx.save.v3');
  const offlineNotes = storage.get('planetx.notes.v1');
  app.api.setUi({ modeId: 'standard', playMode: 'builtin' });
  await app.api.startBuiltin();
  assert.equal(app.state.game.playMode, 'builtin');
  assert.equal(app.state.game.phase, 'setup');
  assert.ok(calls.some((call) => call.body?.playMode === 'builtin' && call.body.modeId === 'standard'));
  assert.equal(app.state.game.mySetup.cluesClaimed, true);
  assert.equal(app.state.notes[`1:${CODE.comet}`], 'no');
  await app.api.submitSetup();
  assert.equal(app.state.notes[`1:${CODE.comet}`], 'no');
  app.api.setUi({ action: 'survey', pick: [11, 0] });
  assert.equal(app.api.pickedRange().size, 2);
  app.api.setUi({ action: 'scan', pick: [5], targetResult: null });
  const scan = await app.api.confirmAction();
  assert.equal(scan.ok, true, scan.error);
  assert.equal(app.state.game.knowledge.targets[0].apparent, Obj.EMPTY);
  assert.notEqual(app.state.notes[`5:${CODE.empty}`], 'yes');
  assert.equal(app.state.notes[`5:${CODE.asteroid}`], 'no');
  assert.equal(Object.hasOwn(calls.find((call) => call.body?.action?.kind === 'target').body.action, 'apparent'), false);
  await app.api.consoleAction({ kind: 'research-declare', phaseId: app.state.game.research.id, count: 0 });
  app.api.setUi({ action: 'research', researchTopic: 'A' });
  await app.api.confirmAction();
  assert.equal(app.state.game.topics.A.clue, puzzle.topics.A.clue);
  assert.equal(app.state.game.topics.B.clue, '');
  assert.equal(storage.get('planetx.save.v3'), offlineSave);
  assert.equal(storage.get('planetx.notes.v1'), offlineNotes);
  await app.api.leaveRoom();
  assert.equal(app.state.game.mode.id, 'expert');
  assert.equal(app.state.game.time, 1);
  assert.equal(app.state.notes[`17:${CODE.asteroid}`], 'no');
});

test('builtin creation detects an old server before creating any room or replacing the local game', async (context) => {
  storage.clear();
  tabStorage.clear();
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { status: 200, json: async () => ({ modes: [] }) };
  };
  context.after(() => { globalThis.fetch = previousFetch; });
  const app = createApp(makeEl('div'));
  app.api.consoleAction({ kind: 'wait' });
  app.api.setUi({ modal: { kind: 'start' }, playMode: 'builtin' });
  const result = await app.api.startBuiltin();
  assert.equal(result.ok, false);
  assert.equal(app.state.remote, null);
  assert.equal(app.state.game.time, 1);
  assert.equal(app.state.ui.modal.kind, 'start');
  assert.match(app.state.ui.lobby.error, /重启/);
  assert.deepEqual(requests, ['/api/modes']);
});

test('temporary restore failures preserve builtin identities and allow a later reload', async (context) => {
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const { createRoom, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const { createPuzzle, initialCluesFor } = await import('../server/puzzles.js');
  const puzzle = createPuzzle({ random: () => 0.25 });
  puzzle.startingClues = Array.from({ length: 6 }, () => initialCluesFor(puzzle));
  const room = createRoom({ playMode: 'builtin', puzzle });
  const host = room.players[0];
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'claim-initial-clues', count: 4 }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup' }).ok, true);
  const identity = { roomId: room.id, playerId: host.id, token: host.token };
  for (const failure of ['network', 503]) {
    storage.clear();
    tabStorage.clear();
    tabStorage.set('planetx.room.v1', JSON.stringify(identity));
    globalThis.fetch = async () => {
      if (failure === 'network') throw new TypeError('network unavailable');
      return { status: failure, json: async () => ({ error: 'temporarily unavailable' }) };
    };
    const disconnected = createApp(makeEl('div'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disconnected.state.remote, null);
    assert.deepEqual(JSON.parse(tabStorage.get('planetx.room.v1') || 'null'), identity, String(failure));
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ view: viewFor(room, host.id) }) });
    const restored = createApp(makeEl('div'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(restored.state.remote?.playerId, host.id);
    assert.equal(restored.state.game.phase, 'play');
    assert.equal(restored.state.game.playMode, 'builtin');
  }
});

test('restore clears expired or invalid identities but ignores failures from an abandoned restore', async (context) => {
  storage.clear();
  tabStorage.clear();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const identity = { roomId: 'RESTORE', playerId: 'P1', token: 'restore-token' };
  for (const status of [403, 404]) {
    tabStorage.set('planetx.room.v1', JSON.stringify(identity));
    globalThis.fetch = async () => ({ status, json: async () => ({ error: 'identity unavailable' }) });
    const app = createApp(makeEl('div'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(app.state.remote, null);
    assert.equal(tabStorage.has('planetx.room.v1'), false);
  }
  let finishRestore;
  globalThis.fetch = () => new Promise((resolve) => { finishRestore = resolve; });
  tabStorage.set('planetx.room.v1', JSON.stringify(identity));
  createApp(makeEl('div'));
  const nextIdentity = { roomId: 'NEWROOM', playerId: 'P2', token: 'new-token' };
  tabStorage.set('planetx.room.v1', JSON.stringify(nextIdentity));
  finishRestore({ status: 404, json: async () => ({ error: 'expired' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(tabStorage.get('planetx.room.v1') || 'null'), nextIdentity);
});

test('changing rooms isolates pending actions and ignores old responses and failures', async (context) => {
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const { createRoom, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const { createPuzzle, initialCluesFor } = await import('../server/puzzles.js');
  const puzzle = createPuzzle({ random: () => 0.4 });
  puzzle.startingClues = Array.from({ length: 6 }, () => initialCluesFor(puzzle));
  const identityFor = (room) => ({ roomId: room.id, playerId: room.hostId, token: room.players[0].token, view: viewFor(room, room.hostId) });
  for (const outcome of ['success', 'failure']) {
    storage.clear();
    tabStorage.clear();
    const oldRoom = createRoom({ playMode: 'builtin', puzzle });
    const newRoom = createRoom({ playMode: 'builtin', puzzle });
    assert.equal(applyRoomAction(oldRoom, oldRoom.hostId, { kind: 'start-game' }).ok, true);
    assert.equal(applyRoomAction(oldRoom, oldRoom.hostId, { kind: 'claim-initial-clues', count: 4 }).ok, true);
    assert.equal(applyRoomAction(oldRoom, oldRoom.hostId, { kind: 'setup' }).ok, true);
    let finishOld;
    let failOld;
    let finishNew;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ url, body });
      if (url.endsWith('/modes')) return { status: 200, json: async () => ({ playModes: ['record', 'builtin', 'tutorial'], builtinBoards: ['standard', 'expert'], initialClueCounts: [0, 4, 8, 12] }) };
      if (url.endsWith('/rooms')) return { status: 200, json: async () => identityFor(newRoom) };
      if (url.includes(oldRoom.id)) {
        const result = applyRoomAction(oldRoom, oldRoom.hostId, body.action);
        const response = { status: 200, json: async () => ({ ...result, view: viewFor(oldRoom, oldRoom.hostId) }) };
        return new Promise((resolve, reject) => { finishOld = () => resolve(response); failOld = reject; });
      }
      const result = applyRoomAction(newRoom, newRoom.hostId, body.action);
      const response = { status: 200, json: async () => ({ ...result, view: viewFor(newRoom, newRoom.hostId) }) };
      return new Promise((resolve) => { finishNew = () => resolve(response); });
    };
    const app = createApp(makeEl('div'));
    app.state.remote = identityFor(oldRoom);
    const oldRequest = app.api.consoleAction({ kind: 'wait' });
    const duplicate = await app.api.consoleAction({ kind: 'wait' });
    await app.api.leaveRoom();
    const busyAfterLeaving = app.state.ui.actionBusy;
    const newRequest = app.api.startBuiltin();
    await new Promise((resolve) => setImmediate(resolve));
    const startedNewRequest = calls.filter((call) => call.url.includes(newRoom.id) && call.body?.action?.kind === 'start-game').length;
    app.api.setUi({ toast: { text: '新房间操作中', kind: 'info' } });
    if (outcome === 'success') finishOld();
    else failOld(new TypeError('old connection failed'));
    const oldResult = await oldRequest;
    const busyAfterOldResponse = app.state.ui.actionBusy;
    const toastAfterOldResponse = app.state.ui.toast?.text;
    if (finishNew) finishNew();
    const newResult = await newRequest;
    assert.equal(duplicate.ok, false);
    assert.equal(busyAfterLeaving, false, outcome);
    assert.equal(startedNewRequest, 1, outcome);
    assert.equal(oldResult.ok, false);
    assert.equal(busyAfterOldResponse, true, outcome);
    assert.equal(toastAfterOldResponse, '新房间操作中', outcome);
    assert.equal(newResult.ok, true, newResult.error);
    assert.equal(app.state.remote.roomId, newRoom.id);
    assert.equal(app.state.game.phase, 'setup');
    assert.equal(app.state.ui.actionBusy, false);
  }
});

test('newer room pushes cannot be overwritten by delayed HTTP responses or stale SSE frames', async (context) => {
  storage.clear();
  tabStorage.clear();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  let stream;
  globalThis.EventSource = class {
    constructor() { this.listeners = {}; stream = this; }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    close() {}
    emit(view) { this.listeners.view({ data: JSON.stringify({ view }) }); }
  };
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const { createRoom, addPlayer, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const { createPuzzle, initialCluesFor } = await import('../server/puzzles.js');
  const puzzle = createPuzzle({ random: () => 0.6 });
  puzzle.startingClues = Array.from({ length: 6 }, () => initialCluesFor(puzzle));
  const room = createRoom({ playMode: 'builtin', puzzle });
  const host = room.players[0];
  const guest = addPlayer(room, '乙');
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'claim-initial-clues', count: 4 }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'claim-initial-clues', count: 4 }).ok, true);
  assert.equal(applyRoomAction(room, host.id, { kind: 'setup' }).ok, true);
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup' }).ok, true);
  const snapshot = (revision) => ({ ...JSON.parse(JSON.stringify(viewFor(room, host.id))), revision });
  tabStorage.set('planetx.room.v1', JSON.stringify({ roomId: room.id, playerId: host.id, token: host.token }));
  let finishAction;
  let delayedView;
  globalThis.fetch = async (url, options = {}) => {
    if (!url.endsWith('/action')) return { status: 200, json: async () => ({ view: snapshot(0) }) };
    const result = applyRoomAction(room, host.id, JSON.parse(options.body).action);
    delayedView = snapshot(1);
    return new Promise((resolve) => {
      finishAction = () => resolve({ status: 200, json: async () => ({ ...result, view: delayedView }) });
    });
  };
  const app = createApp(makeEl('div'));
  await new Promise((resolve) => setImmediate(resolve));
  const pending = app.api.consoleAction({ kind: 'wait' });
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, true);
  stream.emit(snapshot(2));
  const pushedCount = app.state.game.recordCount;
  finishAction();
  assert.equal((await pending).ok, true);
  const afterHttp = { revision: app.state.game.revision, count: app.state.game.recordCount, myTurn: app.state.game.isMyTurn };
  stream.emit(delayedView);
  assert.equal(pushedCount, 2);
  assert.deepEqual(afterHttp, { revision: 2, count: 2, myTurn: true });
  assert.equal(app.state.game.revision, 2);
  assert.equal(app.state.game.recordCount, 2);
  assert.equal(app.state.game.isMyTurn, true);
});

test('record shared-info edits remain sequential when remote actions have a pending guard', async (context) => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const room = createRoom({ initialClueCount: 0 });
  addPlayer(room, '乙');
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const player of room.players) applyRoomAction(room, player.id, { kind: 'setup', noClues: true });
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const action = JSON.parse(options.body).action;
    calls.push(action.kind);
    const result = applyRoomAction(room, room.hostId, action);
    return { status: 200, json: async () => ({ ...result, view: JSON.parse(JSON.stringify(viewFor(room, room.hostId))) }) };
  };
  context.after(() => { globalThis.fetch = previousFetch; });
  const app = createApp(makeEl('div'));
  app.state.remote = { roomId: room.id, playerId: room.hostId, token: room.players[0].token, view: viewFor(room, room.hostId) };
  app.api.setUi({ tableInfo: { topicNames: { A: '更新名称' }, conferenceNames: { 10: '更新会议标题' }, conferences: { 10: '更新会议线索' } } });
  const result = await app.api.saveTableInfo();
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['set-topic-names', 'set-conference-rules', 'set-conference-names']);
  assert.equal(room.topicNames.A, '更新名称');
  assert.equal(room.conferenceNames[10], '更新会议标题');
  assert.equal(room.conferenceRules[10], '更新会议线索');
});

function countNodes(el) {
  let total = 1;
  for (const kid of el.children) total += kid.children ? countNodes(kid) : 1;
  return total;
}

function walk(node, fn, seen = new Set()) {
  // the `seen` guard keeps a pathological (shared or cyclic) stub tree from exploding
  if (node.nodeType === 1) {
    if (seen.has(node)) return node;
    seen.add(node);
    fn(node);
    for (const kid of node.children || []) walk(kid, fn, seen);
  }
  return node;
}

function findAll(node, predicate, out = []) {
  walk(node, (el) => {
    if (predicate(el)) out.push(el);
  });
  return out;
}

function fire(el, type, extra = {}) {
  for (const fn of el.listeners[type] || []) {
    fn({ target: el, currentTarget: el, preventDefault() {}, stopPropagation() {}, ...extra });
  }
}

// Visible text only: <title> children are tooltips, not printed labels.
function collectText(node, out = [], seen = new Set()) {
  if (node.nodeType === 3) out.push(node.textContent);
  if (seen.has(node)) return out;
  seen.add(node);
  for (const kid of node.children || []) {
    if (kid.tagName === 'title') continue;
    collectText(kid, out, seen);
  }
  return out;
}

test('app renders the record console', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  assert.ok(countNodes(root) > 50, 'should render a substantial tree');
  assert.equal(app.session.kind, 'console');
  assert.equal(app.state.game.kind, 'console');
  globalThis.__app = app;
  globalThis.__root = root;
});

test('topbar exposes manual save and load archive actions', async () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  assert.ok(findButton(root, '存档'), 'save archive button');
  assert.ok(findButton(root, '加载存档'), 'load archive button');

  app.session.entries = [{ id: 1, type: 'wait', cost: 1 }];
  app.session.seq = 2;
  app.state.notes = { '2:A': 'no' };
  app.persist();

  const saved = await app.api.saveArchive();
  assert.equal(saved.ok, true);
  assert.ok(saved.slot?.id);
  assert.equal(app.api.listArchiveSlots().length, 1);

  fire(findButton(root, '加载存档'), 'click');
  assert.equal(app.state.ui.modal?.kind, 'archives');
  assert.ok(findButton(root, '加载'), 'library load button');
  assert.ok(findButton(root, '删除'), 'library delete button');
  assert.ok(findButton(root, '从文件导入'), 'optional file import');

  app.api.requestDeleteArchiveSlot(saved.slot.id);
  assert.equal(app.state.ui.modal.pendingDeleteId, saved.slot.id);
  assert.ok(collectText(root).join('').includes('确认删除'));
  app.api.confirmDeleteArchiveSlot(saved.slot.id);
  assert.equal(app.api.listArchiveSlots().length, 0);

  const { addArchiveSlot } = await import('../public/src/archive.js');
  const pack = {
    version: 1,
    kind: 'console',
    savedAt: new Date().toISOString(),
    console: {
      modeId: 'expert',
      entries: [{ id: 1, type: 'wait', cost: 1 }, { id: 2, type: 'wait', cost: 1 }],
      locate: null,
      status: 'open',
      windowOffset: 2,
      windowTime: null,
      topics: {},
      seq: 3,
      theoryPhases: [],
      completedTheoryPhases: [],
      undoBarrier: 0,
      revealedObjects: null,
      frozenTimes: null,
    },
    notes: { '5:C': 'yes' },
  };
  const imported = addArchiveSlot(pack, { label: '专家测试' });
  assert.equal(imported.ok, true);
  const loaded = await app.api.loadArchiveSlot(imported.slot.id);
  assert.equal(loaded.ok, true);
  assert.equal(app.session.mode.id, 'expert');
  assert.equal(app.session.entries.length, 2);
  assert.equal(app.session.windowOffset, 2);
  assert.deepEqual(app.state.notes, { '5:C': 'yes' });
});

test('the record console renders the action launcher and the time-track markers', () => {
  const { api, state } = globalThis.__app;
  api.setUi({ modal: null });
  assert.equal(state.game.kind, 'console');
  assert.ok(countNodes(globalThis.__root) > 200);

  const tiles = findAll(globalThis.__root, (n) => (n.className || '').split(/\s+/).includes('action-tile'));
  assert.equal(tiles.length, 3, 'survey / scan / research');
  const labels = tiles.map((t) => collectText(t).join(''));
  for (const name of ['勘测', '扫描', '研究']) {
    assert.ok(labels.some((t) => t.includes(name)), `the launcher needs a「${name}」tile`);
  }
  assert.ok(findButton(globalThis.__root, '记录定位结果'), 'locate is still recorded separately');

  // the console never claims to know the answer
  assert.equal(state.game.worlds, undefined);
  assert.equal(findAll(globalThis.__root, (n) => /console-note/.test(n.className || '')).length, 1);

  // events sit on the time track: 1 conference sector + 4 theory sectors
  const markers = findAll(globalThis.__root, (n) => /event-marker/.test(n.className || ''));
  assert.equal(markers.length, 5, 'one conference marker (sector 10) and four theory markers');
  assert.equal(findAll(globalThis.__root, (n) => /event-conference/.test(n.className || '')).length, 1);
  assert.equal(findAll(globalThis.__root, (n) => /event-theory/.test(n.className || '')).length, 4);
});

test('the record console walks an action: launch → pick on the map → fill in → confirm', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  api.setUi({ modal: null });

  const visibleWedges = () => {
    const win = state.game.visible;
    const out = [];
    for (const wedge of findAll(root, (n) => (n.className || '').includes('wedge') && (n.listeners.click || []).length)) {
      let holder = wedge;
      while (holder && holder.attributes['data-sector'] === undefined) holder = holder.parent;
      const idx = Number(holder && holder.attributes['data-sector']);
      if (win.includes(idx)) out.push({ wedge, sector: idx });
    }
    return out;
  };

  const tiles = () => findAll(root, (n) => (n.className || '').split(/\s+/).includes('action-tile'));

  // --- 勘测: launch, click start + end on the map, type the count, confirm ---
  fire(tiles()[0], 'click');
  assert.equal(state.ui.action, 'survey');
  const [w0, w1] = visibleWedges();
  fire(w0.wedge, 'click');
  assert.equal(state.ui.pick.length, 1, 'the first click sets the start sector');
  fire(w1.wedge, 'click');
  assert.equal(state.ui.pick.length, 2, 'the second click sets the end sector');
  const range = api.pickedRange();
  assert.ok(range && range.size >= 1, 'the range is computed from the two picks');
  assert.ok(collectText(root).join('').includes(`耗时 ${durationLabel(surveyCost(range.size))}`), 'the time cost is shown');
  typeInto(findAll(root, (n) => /num-input/.test(n.className || ''))[0], 2);
  fire(findButton(root, '确认勘测'), 'click');
  assert.equal(state.game.time, surveyCost(range.size));
  assert.equal(state.game.knowledge.surveys[0].count, 2);
  assert.equal(state.ui.action, 'idle', 'the flow returns to the launcher');
  finishAppPhases(app);

  // --- 扫描: launch, click one sector, pick what the app said, confirm ---
  fire(tiles()[1], 'click');
  const scanTarget = visibleWedges()[2];
  fire(scanTarget.wedge, 'click');
  api.setUi({ targetResult: Obj.EMPTY });
  fire(findButton(root, '确认扫描'), 'click');
  assert.equal(state.game.knowledge.targets.length, 1);
  assert.equal(state.notes[`${scanTarget.sector}:${CODE.empty}`], 'yes', 'the scan result is auto-filled into the record sheet');
  assert.equal(state.ui.action, 'idle');
  finishAppPhases(app);

  // --- 勘测 with a single sector auto-fills the grid as well ---
  fire(tiles()[0], 'click');
  const solo = visibleWedges().find(({ sector }) => [1, 2, 4, 6, 10].includes(sector));
  fire(solo.wedge, 'click');
  fire(solo.wedge, 'click');
  assert.equal(api.pickedRange().size, 1);
  api.setUi({ surveyType: Obj.COMET });
  typeInto(findAll(root, (n) => /num-input/.test(n.className || ''))[0], 1);
  fire(findButton(root, '确认勘测'), 'click');
  assert.equal(state.notes[`${solo.sector}:${CODE.comet}`], 'yes', 'a one-sector survey is a fact too');
  finishAppPhases(app);

  // --- 研究: pick a topic, type the name and the clue, confirm ---
  fire(tiles()[2], 'click');
  const topics = findAll(root, (n) => (n.className || '').split(/\s+/).includes('topic'));
  assert.equal(topics.length, 6, 'only A–F, no preset subjects');
  assert.ok(collectText(topics[0]).join('').includes('未命名'), 'the subject is the player’s to name');
  fire(topics[1], 'click');
  typeInto(findAll(root, (n) => n.tagName === 'input' && n.attributes.type === 'text')[0], '彗星轨道');
  typeInto(findAll(root, (n) => n.tagName === 'textarea')[0], '两颗彗星相隔 3 格');
  fire(findButton(root, '确认研究'), 'click');
  assert.equal(state.game.topics.B.name, '彗星轨道');
  assert.equal(state.game.knowledge.clues[0].text, '两颗彗星相隔 3 格');
  assert.equal(state.ui.action, 'idle');
  finishAppPhases(app);

  assert.equal(findButton(root, '提交学术研究'), undefined, 'ordinary actions do not include publishing');
  assert.equal(findButton(root, '前进 1 个时间单位'), undefined, 'record mode has no one-step wait');
  for (let i = 0; i < 12 && !state.game.theoryPhaseOpen; i++) assert.equal(api.consoleAction({ kind: 'wait' }).ok, true);
  assert.equal(state.game.theoryPhaseOpen, true, 'the visible-window start left a research marker');
  fire(findButton(root, '提交学术研究'), 'click');
  assert.equal(state.ui.action, 'theory');
  assert.ok(collectText(root).join('').includes('你还能提交 1 篇'), 'the card explains the phase quota');
  api.setUi({ theorySector: 1, theoryType: Obj.COMET });
  fire(findButton(root, '确认提交'), 'click');
  assert.equal(state.game.knowledge.theories.length, 1);
  assert.equal(
    state.game.knowledge.theories[0].sector,
    1,
    'the selected legal comet sector is zero-based',
  );
  assert.equal(state.game.knowledge.theories[0].objectType, Obj.COMET, 'the object is kept locally');

  // the right-side cards show the paper, and offer no verdict while it is still travelling
  const theoriesAfter = renderTheoriesPanel({ game: state.game, onReview: () => {} });
  assert.ok(collectText(theoriesAfter).join('').includes('彗星'));
  assert.equal(findAll(theoriesAfter, (n) => (n.className || '').includes('review-pair')).length, 0, 'slot 4 is too early to answer');
  assert.ok(collectText(theoriesAfter).join('').includes('轨道 4'), 'and the card says where it is');
  finishAppPhases(app);

  // --- X行星会议 on its own sector ---
  const confInput = findAll(root, (n) => n.tagName === 'textarea')[0];
  typeInto(confInput, 'X行星紧邻一颗彗星');
  fire(findButton(root, '记录扇区'), 'click');
  assert.equal(state.game.knowledge.conferences.length, 1);
  assert.equal(state.game.knowledge.conferences[0].sector, 10, 'the standard conference sector');
  assert.equal(state.ui.modal?.kind, 'conference', 'a conference popup announces the new clue');
  assert.ok(String(state.ui.modal?.text || '').includes('X行星紧邻一颗彗星'));
  api.setUi({ modal: null });

  // --- the topics card and the theories card carry the record that the map cannot ---
  const topicsCard = renderTopicsPanel({ game: state.game, draftNames: null, onReview: () => {} });
  const topicsText = collectText(topicsCard).join('');
  assert.ok(topicsText.includes('彗星轨道'), 'the research subject is written down');
  assert.ok(topicsText.includes('两颗彗星相隔 3 格'), 'and the clue text with it');
  const theories = renderTheoriesPanel({ game: state.game, onReview: () => {} });
  const theoriesText = collectText(theories).join('');
  assert.ok(theoriesText.includes('学术研究'), 'published theories are listed');
  assert.ok(findAll(theories, (n) => /review-/.test(n.className || '')).length >= 1, 'with their peer review state');
  const knowledgeText = collectText(root).join('');
  assert.ok(knowledgeText.includes('X行星紧邻一颗彗星'), 'the conference clue is in the knowledge panel');

  // --- undo rewinds the last record ---
  fire(findButton(root, '撤销最后一条'), 'click');
  assert.equal(state.game.knowledge.conferences.length, 0);
});

test('clicking a map icon offers the three marking choices', () => {
  const { state, api, render: rerender } = globalThis.__app;
  api.setUi({ modal: null });

  // the board wires every icon to the marking popover
  let clicked = null;
  const el = renderBoard({
    game: state.game,
    ui: { ...state.ui, assist: { possibilities: true, count: true }, rangeStart: null, rangeSize: 6 },
    notes: {},
    onSector: () => {},
    onMark: (sector, code) => {
      clicked = { sector, code };
    },
  });
  const hits = findAll(el, (n) => /icon-hit/.test(n.className || '') && (n.listeners.click || []).length > 0);
  assert.ok(hits.length >= 60, `every icon should be clickable, got ${hits.length}`);
  fire(hits[0], 'click');
  assert.ok(clicked, 'clicking an icon should report the sector and object');
  assert.equal(typeof clicked.sector, 'number');
  assert.equal(typeof clicked.code, 'number');

  // three way marking through the app api, reflected in notes + rendering
  api.openMark(3, CODE.asteroid);
  assert.deepEqual(state.ui.mark, { sector: 3, code: 2 });
  rerender();
  assert.equal(findAll(globalThis.__root, (n) => /(^|\s)mark-pop(\s|$)/.test(n.className || '')).length, 1, 'the marking bubble is shown');
  assert.equal(findAll(globalThis.__root, (n) => /(^|\s)mark-choice(\s|$)/.test(n.className || '')).length, 3, 'three choices offered');

  api.setMark(3, CODE.asteroid, 'yes');
  assert.equal(state.notes['3:2'], 'yes');
  assert.ok(findAll(globalThis.__root, (n) => /mark-yes/.test(n.className || '')).length > 0, 'confirmed icons get a halo');

  api.setMark(3, CODE.asteroid, 'no');
  assert.equal(state.notes['3:2'], 'no');
  assert.ok(findAll(globalThis.__root, (n) => /mark-no/.test(n.className || '')).length > 0, 'deleted icons are marked');
  assert.ok(findAll(globalThis.__root, (n) => /icon-strike/.test(n.className || '')).length > 0, 'deleted icons are struck through');

  api.setMark(3, CODE.asteroid, 'maybe');
  assert.equal(state.notes['3:2'], undefined, '“可能存在” clears the mark');
  assert.equal(findAll(globalThis.__root, (n) => /icon-strike/.test(n.className || '')).length, 0);
  api.setUi({ mark: null });
});

test('the map is the one place a mark lives, and the side cards read the same store', () => {
  const { state, api } = globalThis.__app;
  api.setMark(5, CODE.comet, 'no');
  assert.equal(state.notes['5:1'], 'no');
  const el = renderBoard({
    game: state.game,
    ui: { ...state.ui, assist: { possibilities: true, count: true }, rangeStart: null, rangeSize: 6 },
    notes: state.notes,
    onSector: () => {},
    onMark: () => {},
  });
  assert.ok(findAll(el, (n) => /mark-no/.test(n.className || '')).length > 0, 'the star map shows the mark');
  api.setMark(5, CODE.comet, 'maybe');
  assert.equal(state.notes['5:1'], undefined, 'and clearing it removes the mark');
});

test('clicking outside dismisses the marking bubble and any dialog', () => {
  const { state, api, render: rerender } = globalThis.__app;
  api.setUi({ modal: null });

  // --- marking bubble ---
  api.openMark(2, CODE.asteroid);
  rerender();
  assert.ok(state.ui.mark, 'bubble is open');
  const outside = makeEl('div');
  fireDocument('click', clickEvent(outside));
  assert.equal(state.ui.mark, null, 'clicking elsewhere closes the bubble');

  // clicking the bubble itself must keep it open
  api.openMark(2, CODE.asteroid);
  rerender();
  const bubble = findAll(globalThis.__root, (n) => /(^|\s)mark-pop(\s|$)/.test(n.className || ''))[0];
  assert.ok(bubble, 'bubble rendered');
  fireDocument('click', clickEvent(bubble));
  assert.ok(state.ui.mark, 'clicking inside the bubble keeps it open');

  // clicking another object icon switches the bubble instead of closing it
  const icon = findAll(globalThis.__root, (n) => /poss-icon/.test(n.className || ''))[0];
  fireDocument('click', clickEvent(icon));
  assert.ok(state.ui.mark, 'clicking an object icon keeps the bubble');
  api.setUi({ mark: null });

  // --- dialogs ---
  api.setUi({ modal: { kind: 'help' } });
  rerender();
  assert.equal(state.ui.modal.kind, 'help');
  const dialog = findAll(globalThis.__root, (n) => /(^|\s)modal(\s|$)/.test(n.className || ''))[0];
  assert.ok(dialog, 'dialog rendered');
  fireDocument('click', clickEvent(dialog));
  assert.ok(state.ui.modal, 'clicking inside the dialog keeps it open');
  fireDocument('click', clickEvent(makeEl('div')));
  assert.equal(state.ui.modal, null, 'clicking outside the dialog closes it');

  // the button that opens a dialog must not immediately close it again
  const helpButton = findAll(globalThis.__root, (n) => n.attributes['data-modal-trigger'] === 'help')[0];
  assert.ok(helpButton, 'the rules button is marked as a dialog trigger');
  fireDocument('click', clickEvent(helpButton));
  api.setUi({ modal: { kind: 'help' } });
  assert.equal(state.ui.modal.kind, 'help', 'a dialog opened by a trigger button stays open');

  // Escape closes everything
  fireDocument('keydown', { key: 'Escape' });
  assert.equal(state.ui.modal, null, 'Escape closes the dialog');
  api.openMark(1, CODE.comet);
  fireDocument('keydown', { key: 'Escape' });
  assert.equal(state.ui.mark, null, 'Escape closes the marking bubble');
});

test('the workspace separates the playfield, reference rail and contextual actions', () => {
  const { state } = globalThis.__app;
  const root = globalThis.__root;
  const layout = findAll(root, (n) => (n.className || '').split(/\s+/).includes('layout'))[0];
  assert.ok(layout, 'the layout grid is rendered');
  assert.equal(findAll(layout, (n) => (n.className || '').split(/\s+/).includes('col-notes')).length, 0, 'the note sheet column is gone');
  assert.equal(
    findAll(layout, (n) => (n.className || '').split(/\s+/).includes('notesheet')).length,
    0,
    'and with it the sector × object grid',
  );
  const actions = findAll(layout, (n) => (n.className || '').split(/\s+/).includes('col-actions'))[0];
  assert.ok(actions, 'the right column is there');
  assert.equal(findAll(actions, (n) => /topics-card/.test(n.className || '')).length, 0, 'the A–F subjects belong to the reference rail');
  assert.equal(findAll(actions, (n) => /theories-card/.test(n.className || '')).length, 0, 'so does the theory track');
  const mapBody = findAll(layout, element => (element.className || '').includes('map-card-body'))[0];
  assert.ok(mapBody.children[0].className.includes('map-research-rail'), 'submitted research results sit on the left inside the map');
  assert.ok(mapBody.children[1].className.includes('map-main'), 'the board column follows the research results rail');
  const mapMain = mapBody.children[1];
  assert.ok(mapMain.children[0].className.includes('board-wrap'));
  assert.ok(mapMain.children[1].className.includes('map-side'), 'marking tools follow the board in the DOM');
  assert.ok(findAll(layout, (n) => (n.className || '').split(/\s+/).includes('col-map')).length === 1, 'and the map still has its column');
  void state;
});

function earthBoard(modeId, time, overrides = {}) {
  const mode = modeById(modeId);
  return renderBoard({
    game: { mode, time, knowledge: { targets: [] }, ...overrides },
    ui: {},
    notes: {},
    onSector: () => {},
  });
}

function earthCoordinates(board) {
  const earth = findAll(board, element => element.className === 'earth-marker')[0];
  assert.ok(earth, 'the central solar area includes an Earth marker');
  const coordinates = earth.attributes.transform.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
  assert.ok(coordinates, 'Earth has a deterministic orbital position');
  return { earth, horizontal: Number(coordinates[1]) - GEOMETRY.CX, vertical: Number(coordinates[2]) - GEOMETRY.CY };
}

test('Earth stays at the middle angle of the visible half on both boards, including wrapped windows', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    for (let start = 0; start < mode.sectors; start++) {
      const { horizontal, vertical } = earthCoordinates(earthBoard(modeId, start));
      const expectedAngle = (-90 + (start + (mode.visible - 1) / 2) * 360 / mode.sectors) * Math.PI / 180;
      assert.ok(Math.abs(horizontal - Math.cos(expectedAngle) * GEOMETRY.R_EARTH_ORBIT) < 0.001);
      assert.ok(Math.abs(vertical - Math.sin(expectedAngle) * GEOMETRY.R_EARTH_ORBIT) < 0.001);
    }
  }
});

test('Earth follows the shared visible window rather than the viewer’s personal clock', () => {
  const window = { visibleStart: 9, visible: [9, 10, 11, 0, 1, 2] };
  const early = earthCoordinates(earthBoard('standard', 0, window));
  const later = earthCoordinates(earthBoard('standard', 7, window));
  assert.equal(early.horizontal, later.horizontal);
  assert.equal(early.vertical, later.vertical);
  assert.ok(early.earth.attributes['aria-label'].includes('10–3 号'));
  const fromList = earthCoordinates(earthBoard('standard', 0, { visible: window.visible }));
  assert.equal(fromList.horizontal, early.horizontal);
  assert.equal(fromList.vertical, early.vertical);
});

test('Earth completes one orbit per board lap and returns correctly after time corrections', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const initial = earthCoordinates(earthBoard(modeId, 0));
    const next = earthCoordinates(earthBoard(modeId, 1));
    const full = earthCoordinates(earthBoard(modeId, mode.sectors));
    const previous = earthCoordinates(earthBoard(modeId, -1));
    const wrapped = earthCoordinates(earthBoard(modeId, mode.sectors - 1));
    assert.ok(Math.hypot(initial.horizontal - next.horizontal, initial.vertical - next.vertical) > 1);
    assert.equal(initial.horizontal, full.horizontal);
    assert.equal(initial.vertical, full.vertical);
    assert.equal(previous.horizontal, wrapped.horizontal);
    assert.equal(previous.vertical, wrapped.vertical);
  }
});

test('Earth’s orbit stays clear of the Sun and sector controls, with a readable non-action label', () => {
  const board = earthBoard('standard', 0);
  const { earth, horizontal, vertical } = earthCoordinates(board);
  const sun = findAll(board, element => element.className === 'sun')[0];
  const orbit = findAll(board, element => element.className === 'earth-orbit')[0];
  assert.ok(orbit);
  assert.ok(Math.hypot(horizontal, vertical) - GEOMETRY.EARTH_RADIUS > Number(sun.attributes.r));
  assert.ok(GEOMETRY.R_EARTH_ORBIT + GEOMETRY.EARTH_RADIUS < GEOMETRY.R_INNER);
  assert.equal(earth.attributes.role, 'img');
  assert.ok(earth.attributes['aria-label'].includes('地球'));
  const title = findAll(earth, element => element.tagName === 'title')[0];
  assert.ok(collectText(title).join('').includes('天窗'));
  assert.equal(earth.listeners.click, undefined);
  assert.equal(findAll(board, element => element.className === 'earth-marker').length, 1);
});

test('the longer lap label has a bounded width inside the Earth orbit on both boards', () => {
  for (const modeId of ['standard', 'expert']) {
    for (const units of [0, 17, 2400]) {
      const board = earthBoard(modeId, units);
      const label = findAll(board, (element) => element.className === 'hub-time')[0];
      const width = Number(label.attributes.textLength);
      assert.ok(width > 0 && width <= 98);
      assert.equal(label.attributes.lengthAdjust, 'spacingAndGlyphs');
      const radialLimit = Math.hypot(width / 2, GEOMETRY.CY - Number(label.attributes.y) + 14);
      assert.ok(radialLimit < GEOMETRY.R_EARTH_ORBIT - GEOMETRY.EARTH_RADIUS - 2);
    }
  }
});

test('research topic titles allow long object pairs to wrap within their buttons', async () => {
  const { readFileSync } = await import('node:fs');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const titleRule = styles.match(/\.topic-title\s*\{([^}]+)\}/)?.[1];
  assert.ok(titleRule, 'topic titles have a dedicated style rule');
  assert.match(titleRule, /max-width:\s*100%/, 'titles stay within the button content width');
  assert.match(titleRule, /white-space:\s*normal/, 'long object names wrap instead of being clipped');
  assert.match(titleRule, /overflow-wrap:\s*anywhere/, 'custom names without break points also fit');
});

test('stylesheets are structurally sane', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const css = fs.readFileSync(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');

  const open = (css.match(/{/g) || []).length;
  const close = (css.match(/}/g) || []).length;
  assert.equal(open, close, 'every rule block must be closed');

  const defined = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(defined.has(name), `var(--${name}) is used but never defined`);

  for (const area of ['info', 'map', 'actions']) {
    const tiers = [...css.matchAll(/grid-template-areas:\s*([^;]+);/g)].map((m) => m[1]);
    assert.ok(tiers.length >= 2, 'each responsive tier declares its areas');
    for (const tier of tiers) assert.ok(tier.includes(`'${area}`) || tier.includes(` ${area}`), `tier ${tier} must place the ${area} area`);
  }
  assert.ok(!/grid-template-areas:[^;]*notes/.test(css), 'the note sheet column is gone for good');
});

test('map geometry keeps every icon inside the ring without overlapping', async () => {
  const { state } = globalThis.__app;
  assert.ok(GEOMETRY.COL_PITCH > 23, 'ordinary icon columns have slightly more breathing room');
  assert.ok(GEOMETRY.ROW_PITCH > 22, 'ordinary icon rows have slightly more breathing room');
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const board = renderBoard({ game: { ...state.game, mode }, ui: state.ui, notes: {}, onSector() {}, onMark() {} });
    const sectors = findAll(board, (element) => element.attributes['data-sector'] !== undefined);
    for (const sectorNode of sectors) {
      const sector = Number(sectorNode.attributes['data-sector']);
      const points = findAll(sectorNode, (element) => (element.className || '').includes('icon-hit')).map((circle) => ({
        horizontal: Number(circle.attributes.cx) - GEOMETRY.CX,
        vertical: Number(circle.attributes.cy) - GEOMETRY.CY,
        radius: Number(circle.attributes.r),
      }));
      assert.equal(points.length, [2, 3, 5, 7, 11, 13, 17].includes(sector + 1) ? 6 : 5);
      const [start, end] = sectorAngles(sector, mode.sectors).map((angle) => angle * Math.PI / 180);
      for (const point of points) {
        const radial = Math.hypot(point.horizontal, point.vertical);
        assert.ok(radial - point.radius >= GEOMETRY.R_INNER, `${modeId}/${sector + 1}: clear of the hub`);
        assert.ok(radial + point.radius <= GEOMETRY.R_MARK - GEOMETRY.MARK_SIZE / 2, `${modeId}/${sector + 1}: clear of revealed objects`);
        assert.ok(point.vertical * Math.cos(start) - point.horizontal * Math.sin(start) >= point.radius - 0.01, `${modeId}/${sector + 1}: inside clockwise wedge boundary`);
        assert.ok(point.horizontal * Math.sin(end) - point.vertical * Math.cos(end) >= point.radius - 0.01, `${modeId}/${sector + 1}: inside counterclockwise wedge boundary`);
      }
      for (const [index, point] of points.entries()) {
        for (const other of points.slice(index + 1)) {
          assert.ok(Math.hypot(point.horizontal - other.horizontal, point.vertical - other.vertical) >= point.radius + other.radius, `${modeId}/${sector + 1}: clickable icons do not overlap`);
        }
      }
    }
  }
  for (const cls of ['map-card-body', 'map-side']) {
    const found = findAll(globalThis.__root, (n) => (n.className || '').split(/\s+/).includes(cls));
    assert.equal(found.length, 1, `${cls} should be rendered exactly once`);
  }
});

function typeInto(el, value) {
  el.value = String(value);
  fire(el, 'input');
}

function findButton(root, label) {
  return findAll(root, (n) => n.tagName === 'button' && collectText(n).join('').includes(label))[0];
}

function finishAppPhases(app) {
  for (const phase of [...app.session.theoryPhases]) {
    assert.equal(app.state.game.theoryPhase.id, phase.id);
    assert.equal(app.api.consoleAction({ kind: 'theory-complete' }).ok, true);
  }
}

test('the console survives a save and reload', async () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  app.api.setUi({ modal: null });
  app.api.consoleAction({ kind: 'wait' });
  app.api.consoleAction({ kind: 'research', topic: 'D', text: '两个真正空无一物的扇区相隔 4 格' });
  const { createApp: createAgain } = await import('../public/ui/app.js');
  const restored = createAgain(makeEl('div'));
  assert.equal(restored.session.kind, 'console');
  assert.equal(restored.session.entries.length, 2);
  assert.equal(restored.state.game.time, 2);
  assert.equal(restored.state.game.knowledge.clues[0].text, '两个真正空无一物的扇区相隔 4 格');
});

test('official local phases survive reload and explicitly finish even without papers', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  assert.equal(app.api.consoleAction({ kind: 'target', sector: 0, apparent: Obj.EMPTY }).ok, true);
  assert.equal(app.state.game.theoryPhaseOpen, true);

  const restoredRoot = makeEl('div');
  const restored = createApp(restoredRoot);
  assert.deepEqual(restored.session.theoryPhases, app.session.theoryPhases);
  assert.equal(restored.state.game.theoryPhaseOpen, true);
  assert.equal(findButton(restoredRoot, '记录定位结果'), undefined);
  assert.equal(findButton(restoredRoot, '前进 1 个时间单位'), undefined);
  const finish = findButton(restoredRoot, '完成本阶段');
  assert.ok(finish, 'a crossed phase must offer explicit zero-paper completion');
  fire(finish, 'click');
  assert.equal(restored.state.game.theoryPhaseOpen, false);
  assert.equal(restored.state.game.time, 4);
  assert.equal(restored.session.completedTheoryPhases.length, 1);

  const completed = createApp(makeEl('div'));
  assert.deepEqual(completed.session.completedTheoryPhases, restored.session.completedTheoryPhases);
  assert.equal(completed.session.undoBarrier, restored.session.undoBarrier);
  assert.equal(completed.api.consoleAction({ kind: 'undo' }).ok, false);
});

test('official local locate uses string answers and reaches reveal before final scoring', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  app.api.openLocate();
  fire(findButton(root, 'app 判定：错误'), 'click');
  fire(findButton(root, '确认提交'), 'click');
  assert.equal(app.state.game.status, 'open');
  assert.equal(app.state.game.time, 5);
  assert.equal(app.session.locate.left, Obj.ASTEROID);
  assert.equal(app.state.ui.modal, null);
  assert.equal(app.session.theoryPhases.length, 1, 'time 5 has left marker 3, but not marker 6');
  for (const phase of [...app.session.theoryPhases]) {
    assert.equal(app.state.game.theoryPhase.id, phase.id);
    assert.equal(app.api.consoleAction({ kind: 'theory-complete' }).ok, true);
  }

  const frozenVisible = [...app.state.game.visible];
  app.api.openLocate();
  fire(findButton(root, 'app 判定：正确'), 'click');
  fire(findButton(root, '确认提交'), 'click');
  assert.equal(app.state.game.status, 'reveal');
  assert.equal(app.state.game.time, 10);
  assert.deepEqual(app.state.game.visible, frozenVisible);
  assert.equal(app.state.ui.modal, null);
  assert.ok(findButton(root, '提交揭示结果'));
  assert.equal(findButton(root, '记录定位结果'), undefined);
  assert.equal(app.state.game.scores.finished, false);
  assert.equal(findButton(root, '前进 1 个时间单位'), undefined);
  for (const label of ['天窗 ◀', '天窗 ▶', '撤销最后一条']) {
    assert.ok(Object.hasOwn(findButton(root, label).attributes, 'disabled'), `${label} must be disabled during reveal`);
  }

  const restoredRoot = makeEl('div');
  const restored = createApp(restoredRoot);
  assert.equal(restored.state.game.status, 'reveal');
  assert.deepEqual(restored.state.game.visible, frozenVisible);
  assert.equal(restored.api.nudgeWindow(1).ok, false);
  const objects = Array.from({ length: 12 }, (unused, sector) => sector === 0 ? Obj.PLANET_X : Obj.EMPTY);
  restored.api.setUi({ revealObjects: objects });
  fire(findButton(restoredRoot, '提交揭示结果'), 'click');
  assert.equal(restored.state.game.status, 'finished');
  assert.equal(restored.state.game.scores.finished, true);
  assert.deepEqual(restored.state.game.revealedObjects, objects);
  assert.match(collectText(restoredRoot).join(''), /本局已结束/);

  const finished = createApp(makeEl('div'));
  assert.deepEqual(finished.state.game.revealedObjects, objects);
  finished.api.newSession('expert');
  assert.equal(finished.state.game.status, 'open');
  assert.equal(finished.state.game.revealedObjects, null);
  assert.equal(finished.state.game.visibleStart, 0);
  assert.deepEqual(finished.state.ui.revealObjects, []);
});

test('official upgrade preserves historical recorded costs', () => {
  storage.clear();
  tabStorage.clear();
  storage.set('planetx.save.v3', JSON.stringify({
    modeId: 'standard', status: 'open', entries: [{ id: 1, type: 'target', sector: 0, apparent: Obj.EMPTY, cost: 2, time: 0 }], seq: 2,
  }));
  const app = createApp(makeEl('div'));
  assert.equal(app.state.game.time, 2);
  assert.equal(app.session.entries[0].cost, 2);
  assert.deepEqual(app.session.theoryPhases, []);
});

test('typing a room code enables 「加入房间」 — even across a re-render', async () => {
  storage.clear();
  tabStorage.clear();
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), method: options.method || 'GET', body });
    // the room does not exist in this test: the form must survive the failure
    if (String(url).includes('/join')) return { status: 400, json: async () => ({ error: '房间不存在或已过期' }) };
    return { status: 200, json: async () => ({ ok: true }) };
  };

  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  api.setUi({ modal: { kind: 'lobby' } });

  const joinBtn = () => findButton(root, '加入房间');
  const codeBox = () => findAll(root, (n) => n.attributes.placeholder === '6 位房间码')[0];
  const nameBox = () => findAll(root, (n) => n.attributes.placeholder === '你的名字')[0];
  assert.equal(joinBtn().disabled, true, 'nothing to join before a code is typed');

  // typing the name first, then the code, must keep both — and enable the button
  typeInto(nameBox(), '阿乙');
  typeInto(codeBox(), 'abz234');
  assert.equal(state.ui.lobby.name, '阿乙', 'the name is kept');
  assert.equal(state.ui.lobby.code, 'ABZ234', 'the code is upper-cased');
  assert.equal(joinBtn().disabled, false, 'the join button wakes up as soon as there is a code');

  // a re-render while the form is filled in (an SSE push, a toast timer…) keeps both fields
  app.render();
  assert.equal(state.ui.lobby.name, '阿乙');
  assert.equal(state.ui.lobby.code, 'ABZ234');
  assert.equal(nameBox().value, '阿乙', 'and the inputs are re-drawn with them');
  assert.equal(codeBox().value, 'ABZ234');
  assert.equal(joinBtn().disabled, false, 'still enabled after the re-render');

  // a pasted "房间码：abc-123" loses the noise instead of breaking the join
  typeInto(codeBox(), '房间码：ab c-123');
  assert.equal(state.ui.lobby.code, 'ABC123', 'only the six code characters survive');
  assert.equal(codeBox().value, 'ABC123', 'and the field shows the cleaned code');

  // Enter joins, and the join uses the live form values
  fire(codeBox(), 'keydown', { key: 'Enter' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const joinCall = calls.find((c) => c.url.includes('/join'));
  assert.ok(joinCall, 'Enter sent the join request');
  assert.ok(joinCall.url.includes('ABC123'), 'with the cleaned room code');
  assert.deepEqual(joinCall.body, { name: '阿乙', spectator: false });

  // a failed join keeps the form filled in and explains itself
  assert.ok(collectText(root).join('').includes('房间不存在或已过期'), 'the server error is shown');
  assert.equal(state.ui.lobby.busy, false, 'and the form is usable again');
  assert.equal(codeBox().value, 'ABC123', 'the code is still there after the error');
  assert.equal(joinBtn().disabled, false, 'the join button is still live');

  globalThis.fetch = realFetch;
});

test('the lobby renders and the client speaks the room protocol', async () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const calls = [];
  const fakeView = {
    kind: 'console',
    modeId: 'standard',
    mode: { id: 'standard', name: '标准模式', sectors: 12, visible: 6 },
    roomId: 'ROOM42',
    me: 'P1',
    players: [{ id: 'P1', name: '阿甲', color: '#5eead4', host: true, scansLeft: 2, clues: 0, theories: 0 }],
    status: 'open',
    locate: null,
    time: 0,
    timeLabel: '第 1 圈／第 1 格',
    visibleStart: 0,
    visible: [0, 1, 2, 3, 4, 5],
    windowOffset: 0,
    arrowSector: 1,
    events: { sector: 1, conference: false, conferenceIndex: -1, theory: false, theoryIndex: -1 },
    entries: [],
    log: [],
    knowledge: { surveys: [], targets: [], clues: [], conferences: [], theories: [] },
    researched: new Set(),
    topics: { A: { name: '', clue: '' } },
    targetUses: 2,
    lastWasResearch: false,
    recordCount: 0,
    conferenceSectors: [10],
    theorySectors: [3, 6, 9, 12],
    nextConference: 0,
    nextTheory: 0,
    openTheories: 0,
  };

  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (String(url).endsWith('/api/rooms')) {
      return { status: 200, json: async () => ({ roomId: 'ROOM42', playerId: 'P1', token: 'tok-1', view: fakeView }) };
    }
    return { status: 200, json: async () => ({ ok: true, view: fakeView }) };
  };

  const app = createApp(root);
  app.api.setUi({ modal: { kind: 'lobby' } });
  const bodies = collectText(root).join('');
  assert.ok(bodies.includes('创建房间'), 'the lobby offers to create a room');
  assert.ok(bodies.includes('加入房间'), 'and to join one');
  assert.equal(findAll(root, (n) => n.tagName === 'input' && n.attributes.type === 'text').length, 2, 'name + room code');

  // the board is chosen before the room exists: 12 sectors or 18
  const modeOptions = () => findAll(root, (n) => (n.className || '').split(/\s+/).includes('mode-option'));
  assert.equal(modeOptions().length, 2, 'standard or expert');
  assert.ok(collectText(root).join('').includes('X行星会议在第 10 扇区'), 'standard says where its events sit');
  fire(findAll(modeOptions()[1], (n) => n.tagName === 'input')[0], 'change');
  assert.equal(app.state.ui.modeId, 'expert', 'the pick is remembered');
  assert.ok(collectText(root).join('').includes('X行星会议在第 7、16 扇区'), 'and the expert events are spelled out');

  app.api.setUi({ lobby: { name: '阿甲', code: '', busy: false, error: null }, panels: { history: true, 'history-result-1': true } });
  await app.api.createRoom();
  assert.deepEqual(app.state.ui.panels, { history: true }, 'entering a room clears only previous-game result disclosures');
  assert.ok(
    calls.some((c) => c.url.endsWith('/api/rooms') && c.method === 'POST' && c.body.name === '阿甲' && c.body.modeId === 'expert'),
    'creating posts the name and the chosen board',
  );
  assert.equal(app.state.remote.roomId, 'ROOM42');
  assert.equal(app.state.game.roomId, 'ROOM42', 'the app now renders the server view');
  assert.equal(app.api.isOnline(), true);
  assert.ok(FakeEventSource.last.url.includes('/api/rooms/ROOM42/stream'), 'it subscribes to the room stream');
  assert.ok(FakeEventSource.last.url.includes('token=tok-1'));

  FakeEventSource.last.emit('open', {});
  assert.equal(app.state.netStatus, 'online');

  const text = collectText(root).join('');
  assert.ok(text.includes('ROOM42'), 'the room code is shown');
  assert.ok(text.includes('已连接'), 'the connection status is shown');
  assert.ok(findAll(root, (n) => /player-chip/.test(n.className || '')).length === 1, 'the player list is rendered');

  // a push from the server updates the shared board
  FakeEventSource.last.emit('view', { view: { ...fakeView, time: 6, timeLabel: '第 1 圈／第 7 格' } });
  assert.equal(app.state.game.time, 6, 'the pushed view replaced the local one');
  assert.ok(app.state.game.researched instanceof Set, 'and a JSON push gets its Set back');

  // actions go to the server instead of mutating locally
  calls.length = 0;
  await app.api.consoleAction({ kind: 'wait' });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('/api/rooms/ROOM42/action'));
  assert.deepEqual(calls[0].body.action, { kind: 'wait' });

  app.api.setUiQuiet({ panels: { history: false, 'history-result-2': true } });
  await app.api.leaveRoom();
  assert.deepEqual(app.state.ui.panels, { history: false }, 'leaving a room clears only room-specific result disclosures');
  assert.equal(app.api.isOnline(), false);
  assert.equal(FakeEventSource.last.closed, true, 'leaving closes the stream');
  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

test('the pre-game flow walks lobby → setup → first turn', async () => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor } = await import('../public/src/room.js');

  // A real room drives the real console view: the UI is fed exactly what the server sends.
  const room = createRoom({ modeId: 'standard', hostName: '阿甲' });
  const guest = addPlayer(room, '阿乙');
  let who = room.hostId;
  const viewNow = () => JSON.parse(JSON.stringify(viewFor(room, who))); // JSON, like the wire

  const calls = [];
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: href, method: options.method || 'GET', body });
    if (href.endsWith('/action')) {
      // the real server applies the action and answers with the fresh view: do the same
      const result = applyRoomAction(room, who, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: viewNow() }) };
    }
    if (href.includes('/view')) return { status: 200, json: async () => ({ ok: true, view: viewNow() }) };
    return { status: 200, json: async () => ({ roomId: room.id, playerId: who, token: 'tok-1', view: viewNow() }) };
  };
  const push = () => FakeEventSource.last.emit('view', { view: viewNow() });

  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  await api.createRoom();
  assert.equal(state.remote.roomId, room.id);
  assert.ok(state.game.researched instanceof Set, 'the first view is adopted too');

  // ---- lobby: the player list and a usable start button ----
  let text = collectText(root).join('');
  assert.ok(text.includes('桌上的玩家'), 'the lobby lists the table');
  const lobbyChips = findAll(root, (n) => /player-chip/.test(n.className || '')).map((c) => collectText(c).join(''));
  assert.ok(
    lobbyChips.some((t) => t.includes('阿甲')) && lobbyChips.some((t) => t.includes('阿乙')),
    'both players are listed',
  );
  assert.ok(text.includes('开始游戏'), 'the host sees the start button');
  const startBtn = findButton(root, '开始游戏');
  assert.equal(startBtn.attributes.disabled, undefined, 'the host may start once there are two of them');

  // ---- setup: my clue + the table-wide subjects and conference notes (host only) ----
  await api.startGame();
  push();
  assert.equal(state.game.phase, 'setup');
  text = collectText(root).join('');
  assert.ok(text.includes('初始线索'), 'the setup card asks for the initial clues');
  assert.ok(text.includes('研究课题名称'), 'and for the A–F subject names');
  assert.ok(text.includes('X行星会议'), 'and for conference titles and notes');
  assert.ok(text.includes('本局 1 场：10 号扇区'), 'a standard board has one conference');
  assert.equal(
    findAll(root, (n) => n.tagName === 'input' && n.attributes.placeholder === '课题 C 的名称').length,
    1,
    'all six subject name fields exist',
  );
  assert.equal(findAll(root, (n) => (n.className || '').split(/\s+/).includes('topic-name-row')).length, 6, 'A through F');
  assert.equal(findAll(root, (n) => (n.className || '').split(/\s+/).includes('conf-row')).length, 1, 'one conference field');

  // adding a clue through the real button, then naming subjects through the real inputs
  fire(findButton(root, '+ 添加一条线索'), 'click');
  assert.equal(state.ui.setup.clues.length, 1, 'the draft clue was added');
  assert.equal(findAll(root, (n) => n.className === 'clue-row').length, 1, 'and it is rendered as a row');
  const clueRow = findAll(root, (node) => node.className === 'clue-row')[0];
  const clueTypeSelect = findAll(clueRow, (node) => node.tagName === 'select')[1];
  assert.deepEqual(
    findAll(clueTypeSelect, (node) => node.tagName === 'option').map((option) => option.attributes.value),
    [Obj.ASTEROID, Obj.GAS_CLOUD, Obj.DWARF_PLANET],
    'a non-prime sector omits the impossible comet exclusion as well as empty and Planet X',
  );
  assert.ok(collectText(root).join('').includes('有效线索 1/4 条'), 'the shared-count progress is shown');

  for (let index = 0; index < 3; index += 1) fire(findButton(root, '+ 添加一条线索'), 'click');
  const initialClues = state.ui.setup.clues.map(clue => ({ ...clue }));
  assert.equal(findAll(root, element => element.className === 'clue-row').length, 4, 'exactly the host count of rows');
  assert.ok(collectText(root).join('').includes('有效线索 4/4 条'));
  assert.equal(findButton(root, '+ 添加一条线索'), undefined, 'no fifth clue when the host selected four');

  const nameInput = (id) => findAll(root, (n) => n.attributes.placeholder === `课题 ${id} 的名称`)[0];
  typeInto(nameInput('C'), '小行星带');
  typeInto(nameInput('D'), '气体云走廊');
  assert.equal(state.ui.setup.topicNames.C, '小行星带', 'typing goes into the shared draft');
  assert.equal(state.ui.setup.topicNames.D, '气体云走廊', 'and a second field does not drop the first');
  typeInto(findAll(root, element => Number(element.attributes['data-conference-name']) === 10)[0], '彗星的邻居');
  typeInto(findAll(root, element => element.tagName === 'textarea')[0], 'X行星紧邻一颗彗星');
  assert.equal(state.ui.setup.conferenceNames[10], '彗星的邻居');
  assert.equal(state.ui.setup.conferences[10], 'X行星紧邻一颗彗星', 'the conference note lands in the draft too');

  // the guest finishes first, then the host submits: that flips the room to the first turn
  assert.equal(applyRoomAction(room, guest.id, { kind: 'setup', clues: initialClues, topics: { A: '气体云' } }).ok, true);
  await api.submitSetup();
  assert.deepEqual(room.setup[room.hostId].clues, initialClues, 'all four distinct draft clues reached the server');
  assert.equal(room.topicNames.C, '小行星带', 'the host’s A–F names became the table’s');
  assert.equal(room.topicNames.A, '', 'and the guest’s attempt to name A was ignored');
  assert.equal(room.conferenceRules[10], 'X行星紧邻一颗彗星', 'the conference note is shared');
  const guestView = viewFor(room, guest.id);
  assert.equal(guestView.topicNames.C, '小行星带', 'the guest reads the same subject names');
  assert.equal(guestView.conferenceNames[10], '彗星的邻居', 'and the same public conference title');
  assert.deepEqual(guestView.knowledge.conferences, [], 'the conference body has not been earned yet');
  assert.equal(state.game.phase, 'play', 'everybody ready -> the first round');
  assert.equal(state.notes[`0:${CODE.asteroid}`], 'no', 'my own accepted initial clue also lands in my note sheet');

  const tiles = () => findAll(root, (n) => (n.className || '').split(/\s+/).includes('action-tile'));

  // the host can still fix the table-wide information from the room dialog
  api.setUi({ modal: { kind: 'lobby' } });
  assert.ok(collectText(root).join('').includes('全桌共享信息'), 'the room dialog offers the table info');
  const modalName = findAll(root, (n) => n.attributes.placeholder === '课题 D 的名称')[0];
  assert.equal(modalName.value, '气体云走廊', 'seeded with what the host typed during setup');
  typeInto(modalName, '气体云走廊（改）');
  fire(findButton(root, '保存全桌信息'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(room.topicNames.D, '气体云走廊（改）', 'the edit reached the server');
  assert.equal(viewFor(room, guest.id).topicNames.D, '气体云走廊（改）', 'and the whole table');
  api.setUi({ modal: null });

  // ---- play: the turn banner and the launcher ----
  text = collectText(root).join('');
  assert.ok(text.includes('现在轮到'), 'the current player is announced');
  assert.ok(text.includes('阿甲'), 'by name');
  assert.equal(tiles().length, 3, 'the acting player gets the three ordinary actions');

  // the research action opens with the subject names filled in during setup
  fire(tiles().find((t) => collectText(t)[0].trim() === '研究'), 'click');
  assert.equal(state.ui.action, 'research');
  text = collectText(root).join('');
  assert.ok(text.includes('小行星带'), 'the subject name from setup is offered');
  assert.ok(text.includes('未命名'), 'and the unnamed ones are still pickable');

  // ---- the other player's screen waits its turn ----
  api.cancelAction(); // a different screen: nothing is open there
  who = guest.id;
  push();
  assert.equal(state.game.isMyTurn, false);
  assert.equal(state.game.turnPlayerName, '阿甲');
  text = collectText(root).join('');
  assert.ok(text.includes('等 阿甲 行动'), 'the waiting player is told whose turn it is');
  assert.equal(tiles().length, 3, 'the ordinary action tiles are still visible');
  assert.ok(
    tiles().every((t) => t.attributes.disabled !== undefined),
    'but they are disabled out of turn',
  );

  // the host waits a month, so the guest's screen is told it is their turn
  who = room.hostId;
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'wait' }).ok, true);
  who = guest.id;
  push();
  assert.equal(state.game.isMyTurn, true);
  assert.ok(collectText(root).join('').includes('轮到你行动了'), 'taking over the turn is announced');
  const usable = (title) => tiles().find((t) => collectText(t)[0].trim() === title);
  for (const title of ['勘测', '扫描', '研究']) {
    assert.equal(usable(title).attributes.disabled, undefined, `${title} is usable again`);
  }
  // publishing is never a plain tile in a room: it waits for a research phase
  assert.equal(findButton(root, '提交学术研究'), undefined, 'theory submission is absent outside its triggered phase');

  // the guest opens a form and the turn moves on: the stale form is dropped
  fire(tiles().find((t) => collectText(t)[0].trim() === '研究'), 'click');
  assert.equal(state.ui.action, 'research');
  assert.equal(applyRoomAction(room, guest.id, { kind: 'wait' }).ok, true);
  push();
  assert.equal(state.game.isMyTurn, false);
  assert.equal(state.ui.action, 'idle', 'a form for an action I can no longer take is dropped');
  assert.ok(collectText(root).join('').includes('等 阿甲 行动'));

  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

test('the solo console can be started on the 18 sector board', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  assert.equal(state.game.mode.sectors, 12, 'a fresh console is the standard board');

  api.setUi({ modal: { kind: 'start' } });
  const options = findAll(root, (n) => (n.className || '').split(/\s+/).includes('mode-option'));
  assert.equal(options.length, 2, 'both boards are offered offline too');
  assert.ok(collectText(root).join('').includes('记录模式'));
  fire(findAll(options[1], (n) => n.tagName === 'input')[0], 'change');
  fire(findButton(root, '开始'), 'click');

  assert.equal(state.session.mode.id, 'expert');
  assert.equal(state.game.mode.sectors, 18, 'the console switched to the expert board');
  assert.equal(state.game.visible.length, 9, 'the expert sky window shows 9 sectors');
  assert.equal(state.game.conferenceSectors.join(','), '7,16');
  assert.equal(state.game.time, 0, 'and the clock is back to zero');
  assert.equal(state.session.entries.length, 0);

  // the ring grows with the board (the map is now the only sector × object view)
  const markers = findAll(root, (n) => /event-marker/.test(n.className || ''));
  assert.equal(markers.length, 8, 'two conferences and six theory phases on the 18 sector track');
  const icons = findAll(root, (n) => /poss-icon/.test(n.className || ''));
  assert.equal(icons.length, 5 * 18 + 7, 'only seven prime-numbered sectors offer a comet icon');

  // and recording still works on the bigger ring
  assert.equal(api.consoleAction({ kind: 'conference', sector: 7, text: 'X行星在两颗矮行星之间' }).ok, true);
  assert.equal(api.consoleAction({ kind: 'conference', sector: 10, text: 'nope' }).ok, false, 'sector 10 is not an expert conference');
  assert.equal(api.consoleAction({ kind: 'target', sector: 17, apparent: Obj.EMPTY }).ok, false, 'sector 18 sits outside the month-1 window');
  const win = state.game.visible;
  assert.equal(api.consoleAction({ kind: 'target', sector: win[win.length - 1], apparent: Obj.EMPTY }).ok, true, 'a visible expert sector scans fine');
});

test('the online research phase renders declare → publish → review', async () => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor, currentPlayer } = await import('../public/src/room.js');

  const room = createRoom({ modeId: 'standard', hostName: '阿甲', initialClueCount: 0 });
  const guest = addPlayer(room, '阿乙');
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const p of room.players) applyRoomAction(room, p.id, { kind: 'setup', noClues: true });
  let who = room.hostId;
  const viewNow = () => JSON.parse(JSON.stringify(viewFor(room, who)));

  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/action')) {
      const result = applyRoomAction(room, who, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: viewNow() }) };
    }
    return { status: 200, json: async () => ({ roomId: room.id, playerId: who, token: 'tok-1', view: viewNow() }) };
  };
  const push = () => FakeEventSource.last.emit('view', { view: viewNow() });

  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  await api.createRoom();

  // the pawns walk until somebody crosses sector 3, which opens the phase
  for (let i = 0; i < 8 && !room.research; i++) {
    who = currentPlayer(room).id;
    await api.consoleAction({ kind: 'wait' });
    push();
  }
  who = room.hostId;
  push();
  assert.ok(state.game.research, 'the phase is open');
  assert.equal(state.game.research.sector, 3);
  let text = collectText(root).join('');
  assert.ok(text.includes('学术研究阶段'), 'the action panel switches to the phase');
  assert.ok(text.includes('已选 0/2'), 'and counts the declarations');
  const actions = findAll(root, (n) => (n.className || '').split(/\s+/).includes('col-actions'))[0];
  assert.ok(collectText(actions).join('').includes('学术研究阶段'), 'submission controls stay in the right action panel');
  assert.equal(findAll(root, (n) => (n.className || '').includes('research-map-hint')).length, 0);
  assert.ok(findAll(root, (n) => (n.className || '').includes('map-research-rail'))[0], 'results table stays inside the star map');

  // declaring happens for everybody at once and cannot be changed
  fire(findButton(root, '提交 1 篇'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.game.research.myCount, 1, 'my declaration stuck');
  assert.equal(findButton(root, '提交 1 篇'), undefined, 'and the choice cannot be changed');

  who = guest.id;
  applyRoomAction(room, guest.id, { kind: 'research-declare', phaseId: room.research.id, count: 1 });
  push();
  assert.equal(state.game.research.allDeclared, true);
  const cursor = state.game.research.cursorId;
  assert.equal(cursor === guest.id || cursor === room.hostId, true, 'the order is one of the two players');
  assert.equal(state.game.research.orderNames.length, 2, 'both players publish');

  // the player who is not at the cursor is told to wait (whichever one that is)
  who = cursor === guest.id ? room.hostId : guest.id;
  push();
  assert.equal(state.game.research.isMyPick, false, 'not my turn to publish');
  text = collectText(root).join('');
  assert.ok(/等 .* 提交完|你的名额用完了/.test(text), 'the waiting player is told whose turn it is');
  assert.equal(findButton(root, '确认提交'), undefined, 'and is not offered the publish button');

  // the first publisher goes, then the other screen gets the publishing card
  const firstPlayer = cursor === guest.id ? guest : room.players[0];
  const secondPlayer = cursor === guest.id ? room.players[0] : guest;
  assert.equal(applyRoomAction(room, firstPlayer.id, { kind: 'research-submit', phaseId: room.research.id, sector: 6, objectType: Obj.COMET }).ok, true);
  who = secondPlayer.id;
  push();
  assert.equal(state.game.research.isMyPick, true, 'now it is my turn to publish');
  text = collectText(root).join('');
  assert.ok(text.includes('轮到你提交学术研究'), 'the card says so');
  const picksText = findAll(root, (n) => (n.className || '').split(/\s+/).includes('pick-row'))
    .map((row) => collectText(row).join(''))
    .join(' | ');
  assert.ok(picksText.includes('7 号扇区'), 'and lists where the other player published');
  assert.ok(!picksText.includes('彗星'), 'without leaking the object they claimed');
  api.setUi({ theorySector: 1, theoryType: Obj.COMET });
  fire(findButton(root, '确认提交'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.game.research, null, 'the phase closed');
  const minePaper = state.game.knowledge.theories.find((t) => t.actorId === secondPlayer.id);
  assert.equal(minePaper.objectType, Obj.COMET, 'my own object is on my screen');
  assert.equal(state.game.knowledge.theories.find((t) => t.actorId === firstPlayer.id).objectType, undefined, 'the other one is not');

  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

test('the peer review prompt pays for a wrong answer', async () => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor, currentPlayer } = await import('../public/src/room.js');
  const room = createRoom({ modeId: 'standard', hostName: '阿甲', initialClueCount: 0 });
  const guest = addPlayer(room, '阿乙');
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const p of room.players) applyRoomAction(room, p.id, { kind: 'setup', noClues: true });
  let who = room.hostId;
  const viewNow = () => JSON.parse(JSON.stringify(viewFor(room, who)));
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/action')) {
      const result = applyRoomAction(room, who, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: viewNow() }) };
    }
    return { status: 200, json: async () => ({ roomId: room.id, playerId: who, token: 'tok-1', view: viewNow() }) };
  };
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  await api.createRoom();
  const push = () => FakeEventSource.last.emit('view', { view: viewNow() });

  const pass = (count) => {
    for (const p of room.players) applyRoomAction(room, p.id, { kind: 'research-declare', phaseId: room.research.id, count });
  };
  const walk = () => {
    for (let i = 0; i < 24 && !room.research; i++) applyRoomAction(room, currentPlayer(room).id, { kind: 'wait' });
    return room.research;
  };
  const publish = (sector, objectType) => {
    const player = room.players.find((p) => p.id === room.research.cursorId);
    return applyRoomAction(room, player.id, { kind: 'research-submit', phaseId: room.research.id, sector, objectType });
  };
  /** Publish for whoever is at the cursor until this phase is done. */
  const publishRest = (sector, objectType) => {
    for (let guard = 0; guard < 6 && room.research && room.research.order.length; guard++) {
      const res = publish(sector, objectType);
      if (!res.ok) throw new Error(`stuck publishing: ${res.error}`);
    }
  };
  walk();
  pass(1);
  const myTurnFirst = room.research.cursorId === room.hostId;
  // the host publishes one paper about sector 4 and notes its id, whoever goes first
  let mineId = null;
  if (myTurnFirst) mineId = publish(4, Obj.GAS_CLOUD).entry.id;
  else {
    publish(8, Obj.DWARF_PLANET);
    mineId = publish(4, Obj.GAS_CLOUD).entry.id;
  }
  publishRest(8, Obj.DWARF_PLANET);
  for (let phase = 0; phase < 2; phase++) {
    walk();
    pass(0);
  }
  who = room.hostId;
  push();
  const paper = state.game.knowledge.theories.find((t) => t.id === mineId);
  assert.ok(paper, 'my paper is on the board');
  assert.equal(paper.slot, 1, 'my paper reached the review slot');
  let text = collectText(root).join('');
  assert.ok(text.includes('同行评审'), 'the action panel prompts for the review');
  assert.ok(text.includes('提交的是 气体云'), 'and reminds me what I claimed');

  const before = state.game.players.find((p) => p.isMe).time;
  const mineReview = findAll(root, (node) => (node.className || '').includes('review-row') && collectText(node).join('').includes('气体云'))[0];
  const button = findButton(mineReview, '错误（罚 1 个时间单位）');
  assert.ok(button, 'the wrong answer is offered');
  fire(button, 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.game.players.find((p) => p.isMe).time, before + 1, 'a wrong review costs a month');
  text = collectText(root).join('');
  assert.ok(text.includes('评审错误'), 'and the app says why');
  // the reviewed paper is settled, so it is no longer offered (other papers of mine may be)
  assert.equal(state.game.myPendingReviews.includes(mineId), false, 'the answered paper is off the list');
  const stillOffered = (state.game.myPendingReviews || []).length;
  assert.equal(typeof stillOffered, 'number');

  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});


test('the setup card can be filled in again, and an expert table asks for two conferences', async () => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const room = createRoom({ modeId: 'standard', hostName: '阿甲' });
  const guest = addPlayer(room, '阿乙');
  const viewNow = () => JSON.parse(JSON.stringify(viewFor(room, room.hostId)));

  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {
      this.closed = true;
    }
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const body = options.body ? JSON.parse(options.body) : null;
    if (href.endsWith('/action')) {
      const result = applyRoomAction(room, room.hostId, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: viewNow() }) };
    }
    return { status: 200, json: async () => ({ roomId: room.id, playerId: room.hostId, token: 'tok-1', view: viewNow() }) };
  };

  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  await api.createRoom();
  await api.startGame();

  for (let index = 0; index < 4; index += 1) fire(findButton(root, '+ 添加一条线索'), 'click');
  const initialClues = state.ui.setup.clues.map(clue => ({ ...clue }));
  typeInto(findAll(root, (n) => n.attributes.placeholder === '课题 A 的名称')[0], '小行星带');
  await api.submitSetup();
  assert.equal(room.phase, 'setup', 'the guest has not finished');
  assert.equal(room.setup[room.hostId].ready, true);
  assert.equal(room.topicNames.A, '小行星带');
  let text = collectText(root).join('');
  assert.ok(text.includes('你已提交'), 'the host sees the waiting card');
  const sharedName = findAll(root, (n) => n.attributes.placeholder === '课题 A 的名称')[0];
  assert.equal(sharedName.value, '小行星带', 'with the shared subject names on it');
  assert.equal(
    findAll(root, (n) => (n.className || '').split(/\s+/).includes('conf-row')).length,
    1,
    'and the one conference note of a standard board',
  );

  // 「重新填写」 asks the server for the card back
  fire(findButton(root, '重新填写'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(room.setup[room.hostId].ready, false, 'the server reopened the card');
  assert.equal(state.game.mySetup.ready, false);
  text = collectText(root).join('');
  assert.ok(text.includes('① 初始线索'), 'the form is back');
  const draft = api.setupDraft();
  assert.equal(draft.clues.length, 4, 'with every clue that was typed before');
  assert.equal(draft.topicNames.A, '小行星带', 'and the subject names');
  assert.equal(findAll(root, element => element.className === 'clue-row').length, 4, 'rendered as four rows again');

  // and submitting it a second time keeps everything
  await api.submitSetup();
  assert.deepEqual(room.setup[room.hostId].clues, initialClues, 'the clues survived the round trip');
  assert.equal(room.topicNames.A, '小行星带', 'and so did the shared subject names');

  // ---- an expert table has two conference notes instead of one ----
  const expert = createRoom({ modeId: 'expert', hostName: '甲', initialClueCount: 0 });
  addPlayer(expert, '乙');
  applyRoomAction(expert, expert.hostId, { kind: 'start-game' });
  const expertRoot = makeEl('div');
  const expertApp = createApp(expertRoot);
  const expertView = () => JSON.parse(JSON.stringify(viewFor(expert, expert.hostId)));
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/action')) {
      const result = applyRoomAction(expert, expert.hostId, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: expertView() }) };
    }
    return { status: 200, json: async () => ({ roomId: expert.id, playerId: expert.hostId, token: 'tok-2', view: expertView() }) };
  };
  await expertApp.api.createRoom();
  await expertApp.api.startGame();
  const expertText = collectText(expertRoot).join('');
  assert.ok(expertText.includes('本局 2 场：7、16 号扇区'), 'the expert card spells out both conferences');
  assert.equal(findAll(expertRoot, (n) => (n.className || '').split(/\s+/).includes('conf-row')).length, 2, 'two note fields');
  const confInputs = findAll(expertRoot, (n) => n.tagName === 'textarea');
  typeInto(confInputs[0], 'X行星在两颗矮行星之间');
  assert.equal(expertApp.state.ui.setup.conferences[7], 'X行星在两颗矮行星之间', 'the first conference note');
  typeInto(confInputs[1], 'X行星不与气体云相邻');
  assert.equal(expertApp.state.ui.setup.conferences[16], 'X行星不与气体云相邻', 'the second one, without losing the first');
  await expertApp.api.submitSetup();
  assert.deepEqual(expert.conferenceRules, { 7: 'X行星在两颗矮行星之间', 16: 'X行星不与气体云相邻' });

  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

test('pawns preserve clockwise arrival and join order in every quadrant and occupancy without changing turn priority', () => {
  const { state } = globalThis.__app;
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    for (const sector of [1, Math.floor(mode.sectors / 4) + 1, Math.floor(mode.sectors / 2) + 1, Math.floor(mode.sectors * 3 / 4) + 1]) {
      for (const count of [1, 2, 3, 4, 6]) {
        const players = Array.from({ length: count }, (unused, index) => ({
          id: `player-${index}`, name: `玩家${index}`, color: '#5eead4', sector,
          time: index === count - 1 ? sector - 1 : sector - 1 + mode.sectors,
          arrival: Math.floor(index / 2), joinIndex: index, isTurn: index === count - 1,
        })).reverse();
        const original = structuredClone(players);
        const board = renderBoard({ game: { ...state.game, mode, players }, ui: state.ui, notes: {}, onSector() {}, onMark() {} });
        const [start, end] = sectorAngles(sector - 1, mode.sectors);
        const pawns = findAll(board, (element) => (element.className || '').split(/\s+/).includes('pawn'));
        const dots = pawns.map((pawn) => {
          const dot = findAll(pawn, (element) => (element.className || '').includes('pawn-dot'))[0];
          const horizontal = Number(dot.attributes.cx) - GEOMETRY.CX;
          const vertical = Number(dot.attributes.cy) - GEOMETRY.CY;
          return { id: pawn.attributes['data-player'], horizontal, vertical, radius: Number(dot.attributes.r), angle: mod(Math.atan2(vertical, horizontal) * 180 / Math.PI - start, 360) };
        });
        assert.equal(dots.length, count);
        assert.deepEqual(dots.slice().sort((first, second) => first.angle - second.angle).map((dot) => dot.id), Array.from({ length: count }, (unused, index) => `player-${index}`), `${modeId}/${sector}/${count}: earlier arrivals stand behind, never screen-left sorted`);
        for (const [index, dot] of dots.entries()) {
          assert.ok(Math.abs(Math.hypot(dot.horizontal, dot.vertical) - GEOMETRY.R_PAWN) < 0.001);
          assert.ok(dot.angle > 0 && dot.angle < end - start);
          for (const other of dots.slice(index + 1)) assert.ok(Math.hypot(dot.horizontal - other.horizontal, dot.vertical - other.vertical) > dot.radius + other.radius, 'crowded pawns remain separate');
        }
        assert.equal(pawns.find((pawn) => pawn.className.split(/\s+/).includes('turn')).attributes['data-player'], `player-${count - 1}`, 'absolute elapsed time still decides the supplied turn');
        assert.deepEqual(players, original, 'drawing does not reorder server state');
      }
    }
  }
});

test('a conference crossing is announced and asks for the app’s rule', async () => {
  storage.clear();
  tabStorage.clear();
  const { createRoom, addPlayer, applyRoomAction, viewFor, currentPlayer } = await import('../public/src/room.js');
  const room = createRoom({ modeId: 'standard', hostName: '阿甲', initialClueCount: 0 });
  const guest = addPlayer(room, '阿乙');
  applyRoomAction(room, room.hostId, { kind: 'start-game' });
  for (const p of room.players) applyRoomAction(room, p.id, { kind: 'setup', noClues: true });
  let who = room.hostId;
  const viewNow = () => JSON.parse(JSON.stringify(viewFor(room, who)));
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;
  class FakeEventSource {
    constructor() {
      this.listeners = {};
      FakeEventSource.last = this;
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    emit(type, data) {
      for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) });
    }
    close() {}
  }
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    if (String(url).endsWith('/action')) {
      const result = applyRoomAction(room, who, body.action);
      return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: viewNow() }) };
    }
    return { status: 200, json: async () => ({ roomId: room.id, playerId: who, token: 'tok-1', view: viewNow() }) };
  };
  const push = () => FakeEventSource.last.emit('view', { view: viewNow() });

  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  await api.createRoom();

  // walk the pawns until a conference sector is crossed
  for (let i = 0; i < 30 && !room.conference; i++) {
    who = currentPlayer(room).id;
    await api.consoleAction({ kind: 'wait' });
    for (let guard = 0; guard < 6 && room.research; guard++) {
      for (const p of room.players) applyRoomAction(room, p.id, { kind: 'research-declare', phaseId: room.research.id, count: 0 });
    }
  }
  who = room.hostId;
  push();
  assert.ok(state.game.conference, 'the app knows about the crossing');
  let text = collectText(root).join('');
  assert.ok(text.includes('X行星会议'), 'the panel shows the conference');
  assert.ok(text.includes('去官方 app 查看'), 'and tells the table to look at the app');
  assert.ok(text.includes('扇区 10'), 'naming the sector that was crossed');

  // writing the rule down answers it
  const box = findAll(root, (n) => n.tagName === 'textarea')[0];
  typeInto(box, 'X行星紧邻一颗彗星');
  fire(findButton(root, '记录扇区 10 的会议'), 'click');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(state.game.conference, null, 'the prompt is gone');
  assert.equal(state.game.knowledge.conferences[0].text, 'X行星紧邻一颗彗星', 'and the clue is shared');

  globalThis.fetch = realFetch;
  globalThis.EventSource = realEventSource;
});

test('the record is a chronological player table and the score panel adds up', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;

  // one round: my survey, my scan, then a wait. Each pick has to come from the window as
  // it is *now* — surveys and scans are limited to the visible sky.
  assert.equal(api.consoleAction({ kind: 'survey', type: Obj.ASTEROID, start: state.game.visible[0], size: 6, count: 2 }).ok, true);
  finishAppPhases(app);
  assert.equal(api.consoleAction({ kind: 'target', sector: state.game.visible[1], apparent: Obj.EMPTY }).ok, true);
  finishAppPhases(app);
  assert.equal(api.consoleAction({ kind: 'wait' }).ok, true);

  const table = findAll(root, (n) => (n.className || '').split(/\s+/).includes('history-table'))[0];
  assert.ok(table, 'the log renders as a table');
  const head = collectText(findAll(table, element => element.tagName === 'thead')[0]).join('');
  assert.ok(head.includes('顺序') && head.includes('我'), 'sequence and a column per player');
  assert.equal(head.includes('操作结果'), false, 'results belong to the acting player cell');
  const rows = findAll(table, (n) => n.tagName === 'tr');
  assert.equal(rows.length, 1 + 3, 'a header plus one round per action (offline has a single player)');
  const cells = rows[1].children;
  assert.equal(cells.length, 2, 'offline there is only sequence and me');
  const firstRow = collectText(rows[1]).join('|');
  assert.ok(firstRow.includes('勘测') && firstRow.includes('2 个'), 'the operation and its result sit side by side');
  const tableText = collectText(table).join('|');
  assert.ok(tableText.includes('扫描') && tableText.includes('空域'), 'and so does the scan');
  assert.ok(tableText.includes('等待 1 个时间单位'), 'the wait is recorded too');

  // the score panel is rendered and explains its numbers
  const score = findAll(root, (n) => (n.className || '').split(/\s+/).includes('score-table'))[0];
  assert.ok(score, 'the score table is on the page');
  const scoreText = collectText(root).join('');
  assert.ok(scoreText.includes('理论分'), 'with the point table in the footnote');
  assert.ok(scoreText.includes('第一个正确定位 X行星 +10'), 'and the locate rule');
});

test('the locate dialog records what the app decided', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  api.openLocate();
  let text = collectText(root).join('');
  assert.ok(text.includes('app 判定：正确（进入终局）'), 'the dialog asks for the app verdict');
  assert.ok(text.includes('app 判定：错误（继续，只花时间）'));

  // a wrong attempt costs time but does not end the session
  fire(findButton(root, 'app 判定：错误（继续，只花时间）'), 'click');
  fire(findButton(root, '确认提交'), 'click');
  assert.equal(state.game.status, 'open', 'the game continues');
  assert.equal(state.game.locate.correct, false);
  assert.equal(state.game.time, 5, 'and it still cost five months');
  assert.equal(state.game.scores.rows[0].located, false, 'a failed locate scores nothing');

  finishAppPhases(app);
  api.openLocate();
  fire(findButton(root, 'app 判定：正确（进入终局）'), 'click');
  fire(findButton(root, '确认提交'), 'click');
  assert.equal(state.game.status, 'reveal', 'finding Planet X begins the reveal stage');
  assert.equal(state.game.scores.rows[0].located, true);
  assert.equal(state.game.scores.rows[0].locatePoints, 10, 'the first finder scores ten');
});

test('the theory card only offers the four claimable objects', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;
  for (let i = 0; i < 12 && !state.game.theoryPhaseOpen; i++) api.consoleAction({ kind: 'wait' });
  fire(findAll(root, (n) => (n.className || '').split(/\s+/).includes('action-tile') && collectText(n)[0].trim() === '提交学术研究')[0], 'click');
  const card = findAll(root, (n) => (n.className || '').split(/\s+/).includes('active-action'))[0];
  assert.ok(card, 'the publishing card is open');
  api.setUi({ theorySector: 1 });
  const currentCard = findAll(root, (element) => (element.className || '').split(/\s+/).includes('active-action'))[0];
  const cardText = collectText(currentCard).join('');
  for (const label of ['小行星', '彗星', '气体云', '矮行星']) assert.ok(cardText.includes(label), `${label} can be claimed`);
  assert.equal(cardText.includes('空域'), false, 'but an empty sector may be Planet X, so it is not offered');
  const chosen = findAll(currentCard, (element) => (element.className || '').includes('chip-select'));
  assert.equal(chosen.length, 4, 'four chips, not five');
});

test('the layout keeps exactly three columns: knowledge, map and actions', () => {
  const { state, api } = globalThis.__app;
  api.setUi({ modal: null });
  const root = globalThis.__root;
  const layout = findAll(root, (n) => (n.className || '').split(/\s+/).includes('layout'))[0];
  assert.ok(layout, 'the layout grid is rendered');
  for (const area of ['col-info', 'col-map', 'col-actions']) {
    assert.equal(
      findAll(layout, (n) => (n.className || '').split(/\s+/).includes(area)).length,
      1,
      `${area} should be rendered exactly once`,
    );
  }
  assert.equal(findAll(layout, (n) => /col-notes/.test(n.className || '')).length, 0, 'the note sheet column is gone');
  const information = findAll(layout, element => (element.className || '').split(/\s+/).includes('col-info'))[0];
  assert.equal(findAll(information, element => (element.className || '').includes('topics-card')).length, 1);
  assert.equal(findAll(information, element => (element.className || '').includes('theories-card')).length, 0, 'submitted research results sit inside the star map');
  const mapColumn = findAll(layout, element => (element.className || '').split(/\s+/).includes('col-map'))[0];
  assert.equal(findAll(mapColumn, element => (element.className || '').includes('theories-card')).length, 1);
  assert.equal(findAll(mapColumn, element => (element.className || '').includes('map-research-rail')).length, 1);
  assert.equal(findAll(layout, element => /(?:log-card|score-card)/.test(element.className || '')).length, 0, 'history and score must not squeeze the playfield');
  const secondary = findAll(root, element => (element.className || '').includes('workspace-secondary'))[0];
  assert.ok(secondary, 'a full-width secondary region follows the workspace');
  assert.equal(findAll(secondary, element => (element.className || '').includes('log-card')).length, 1);
  assert.equal(findAll(secondary, element => (element.className || '').includes('score-card')).length, 1);
  void state;
});

test('new sessions reset reused history result ids without clearing panel preferences', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  assert.equal(app.api.consoleAction({ kind: 'research', topic: 'A', text: '第一局线索' }).ok, true);
  const result = findAll(root, element => element.attributes['data-disclosure'] === 'history-result-1')[0];
  result.open = true;
  fire(result, 'toggle');
  app.api.setUiQuiet({ panels: { ...app.state.ui.panels, history: true, 'basic-rules': false } });
  app.api.newSession('standard');
  assert.equal(app.api.consoleAction({ kind: 'research', topic: 'A', text: '第二局线索' }).ok, true);
  const nextResult = findAll(root, element => element.attributes['data-disclosure'] === 'history-result-1')[0];
  assert.equal(nextResult.attributes.open, undefined);
  assert.deepEqual(app.state.ui.panels, { history: true, 'basic-rules': false });
});

test('reference panels are folded and disclosure state survives app redraws', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  app.api.setUi({ modal: null });
  for (const panelId of ['rules', 'topics', 'theories', 'history', 'score', 'status-tools']) {
    const panel = findAll(root, element => element.attributes['data-disclosure'] === panelId)[0];
    assert.ok(panel, `${panelId} exists`);
    assert.equal(panel.tagName, 'details');
    assert.equal(panel.attributes.open, undefined, `${panelId} starts folded`);
  }
  const history = findAll(root, element => element.attributes['data-disclosure'] === 'history')[0];
  history.open = true;
  fire(history, 'toggle');
  assert.equal(app.state.ui.panels.history, true);
  app.api.setUi({ selectedSector: 3 });
  const nextHistory = findAll(root, element => element.attributes['data-disclosure'] === 'history')[0];
  assert.equal(nextHistory.attributes.open, '');
});

test('knowledge shows private clues before collapsed base rules', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const game = {
    ...app.state.game,
    me: 'alpha',
    mySetup: { clues: [{ sector: 2, type: Obj.COMET }] },
    knowledge: { ...app.state.game.knowledge, clues: [{ actorId: 'alpha', topic: 'A', text: '我的研究规律' }, { actorId: 'beta', topic: 'B' }] },
  };
  const panel = renderKnowledgePanel({ state: { ...app.state, game }, api: app.api });
  const text = collectText(panel).join('');
  assert.ok(text.includes('3 号') && text.includes('没有') && text.includes('彗星'));
  assert.ok(text.indexOf('我的研究规律') < text.indexOf('基础规律'));
  assert.ok(text.includes('1/6'));
});

test('conference entry is contextual and locating does not compete with an active action', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  const initial = renderActionPanel({ state: app.state, api: app.api });
  const conference = findAll(initial, element => element.attributes['data-disclosure'] === 'conference-entry')[0];
  assert.ok(conference);
  assert.equal(conference.attributes.open, undefined);
  app.api.startAction('survey');
  const active = renderActionPanel({ state: app.state, api: app.api });
  assert.equal(findButton(active, '记录定位结果'), undefined);
  app.api.setUi({ action: 'idle' });
  assert.equal(app.api.consoleAction({ kind: 'wait', units: 9 }).ok, true);
  finishAppPhases(app);
  assert.equal(app.state.game.events.conference, true, 'the current marker is 10, but its conference has not departed');
  const entering = renderActionPanel({ state: app.state, api: app.api });
  assert.equal(findAll(entering, (element) => element.attributes['data-disclosure'] === 'conference-due-10').length, 0, 'entering marker 10 does not trigger its conference');
  const enteringStatus = collectText(renderStatus({ state: app.state, api: app.api })).join('');
  assert.match(enteringStatus, /自由推理/);
  assert.doesNotMatch(enteringStatus, /该开会了|离开 9 号事件标记/);
  assert.equal(app.api.consoleAction({ kind: 'research', topic: 'A', text: '会议前的研究' }).ok, true);
  assert.equal(app.state.game.time, 10);
  assert.equal(app.state.game.events.conference, false, 'the current marker is now 11');
  const due = renderActionPanel({ state: app.state, api: app.api });
  const dueEntry = findAll(due, element => element.attributes['data-disclosure'] === 'conference-due-10')[0];
  assert.equal(dueEntry?.attributes.open, '');
});

test('every recordable action goes through the api and lands in the log', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const { api, state } = app;

  // Survey and scan only cover visible sectors, and each one slides the window on, so take
  // the scan first and read the window again for the survey.
  const targetSector = state.game.visible[0];
  assert.equal(api.consoleAction({ kind: 'target', sector: targetSector, apparent: Obj.EMPTY }).ok, true);
  finishAppPhases(app);
  const win = state.game.visible;
  assert.equal(api.consoleAction({ kind: 'survey', type: Obj.ASTEROID, start: win[0], size: 6, count: 2 }).ok, true);
  finishAppPhases(app);
  assert.equal(api.consoleAction({ kind: 'research', topic: 'A', name: '小行星带', text: '编号之和为 30' }).ok, true);
  finishAppPhases(app);
  assert.equal(api.consoleAction({ kind: 'wait' }).ok, true);
  finishAppPhases(app);
  const early = api.consoleAction({ kind: 'theory', sector: 4, type: Obj.COMET });
  assert.equal(early.ok, false, 'not while the arrow is elsewhere');
  assert.match(state.ui.toast.text, /学术研究.*天窗起点离开/, 'and the app explains departure timing');
  for (let i = 0; i < 12 && !state.game.theoryPhaseOpen; i++) assert.equal(api.consoleAction({ kind: 'wait' }).ok, true);
  assert.equal(state.game.theoryPhaseOpen, true, 'the visible-window start left a research marker');
  assert.equal(api.consoleAction({ kind: 'theory', sector: 4, type: Obj.COMET }).ok, true, 'now it may be published');
  finishAppPhases(app);
  assert.equal(api.consoleAction({ kind: 'conference', sector: 10, text: 'X行星紧邻一颗彗星' }).ok, true);
  assert.equal(api.consoleAction({ kind: 'locate', sector: 4, left: Obj.COMET, right: Obj.EMPTY }).ok, true);
  assert.equal(state.session.status, 'reveal');
  const objects = Array.from({ length: 12 }, (unused, sector) => sector === 4 ? Obj.PLANET_X : Obj.EMPTY);
  assert.equal(api.consoleAction({ kind: 'reveal-objects', objects }).ok, true);
  assert.equal(state.session.status, 'finished');

  const counts = state.game.log.reduce((acc, e) => ({ ...acc, [e.type]: (acc[e.type] || 0) + 1 }), {});
  const waits = counts.wait;
  assert.deepEqual(counts, { survey: 1, target: 1, research: 1, wait: waits, theory: 1, conference: 1, located: 1 });
  assert.equal(state.game.time, 3 + 4 + 1 + waits + 5, 'months add up: survey, scan, research, waits, locate');
  assert.equal(api.consoleSummary().theories, 1);
  assert.equal(countNodes(root) > 100, true);
});

test('map clicks set the survey range and are clamped to the window', () => {
  const { state } = globalThis.__app;
  const win = visibleSectorsAt(state.game.time, state.game.mode);
  const onSector = (sector) => {
    state.ui.mapMode = 'survey';
    state.ui.selectedSector = sector;
  };
  // exercise the board renderer with every assist combination and a range
  for (const possibilities of [true, false]) {
    for (const count of [true, false]) {
      const ui = { ...state.ui, assist: { possibilities, count }, rangeStart: win[2], rangeSize: 4 };
      const el = renderBoard({ game: state.game, ui, notes: { [`${win[0]}:2`]: 'yes', [`${win[0]}:1`]: 'yes', [`${win[1]}:3`]: 'yes' }, onSector });
      assert.ok(countNodes(el) > 20);
    }
  }
  assert.ok(win.length > 0);
});

test('the map draws every mark and the side cards render without the grid', () => {
  const { state } = globalThis.__app;
  const notes = { '0:2': 'yes', '1:1': 'no', '2:5': 'yes' };
  const el = renderBoard({
    game: state.game,
    ui: { ...state.ui, assist: { possibilities: true, count: true }, rangeStart: null, rangeSize: 6 },
    notes,
    onSector: () => {},
    onMark: () => {},
  });
  assert.ok(countNodes(el) > 50);
  const withClass = (name) => findAll(el, (n) => (n.className || '').split(/\s+/).includes(name)).length;
  assert.equal(withClass('mark-yes'), 2, 'two “exists” marks');
  // exact class match: `mark-no` is a prefix of `mark-none`, which every unmarked icon carries
  assert.equal(withClass('mark-no'), 1, 'one “does not exist” mark');
  assert.equal(withClass('mark-none'), 62, 'all other legal icons stay unmarked; seven forbidden comet slots are absent');
  const topics = renderTopicsPanel({ game: state.game, draftNames: null, onReview: () => {} });
  const theories = renderTheoriesPanel({ game: state.game, onReview: () => {} });
  assert.ok(countNodes(topics) > 10 && countNodes(theories) > 3, 'both side cards render');
});

test('modal variants render: help, locate, conference, result, start', () => {
  const { state, api } = globalThis.__app;
  const cases = [
    { kind: 'help' },
    { kind: 'conference', text: 'X行星紧邻一颗彗星', label: '第一次学术会议' },
    { kind: 'result' },
    { kind: 'start' },
  ];
  for (const modal of cases) {
    api.setUi({ modal });
    const el = renderModal({ state, api });
    assert.ok(el, `modal ${modal.kind} should render`);
    assert.ok(countNodes(el) > 3);
  }
  api.openLocate();
  assert.equal(state.ui.modal.kind, 'locate');
  const locate = renderModal({ state, api });
  assert.ok(countNodes(locate) > 10);
  api.setUi({ modal: null });
});

async function initialClueApp(context, { failClaim = false, mismatchedView = false } = {}) {
  storage.clear();
  tabStorage.clear();
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const { createRoom, addPlayer, applyRoomAction, viewFor } = await import('../public/src/room.js');
  const ownClues = [
    { sector: 1, objectType: Obj.COMET },
    { sector: 1, objectType: Obj.GAS_CLOUD },
    { sector: 2, objectType: Obj.DWARF_PLANET },
    { sector: 3, objectType: Obj.ASTEROID },
  ];
  const foreignClues = [
    { sector: 10, objectType: Obj.COMET },
    { sector: 9, objectType: Obj.GAS_CLOUD },
    { sector: 10, objectType: Obj.DWARF_PLANET },
    { sector: 11, objectType: Obj.GAS_CLOUD },
  ];
  const room = createRoom({ playMode: 'builtin', puzzle: {
    objects: [Obj.ASTEROID, Obj.ASTEROID, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.PLANET_X, Obj.COMET, Obj.GAS_CLOUD, Obj.EMPTY, Obj.DWARF_PLANET, Obj.ASTEROID, Obj.ASTEROID],
    topics: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((topic) => [topic, { name: topic, clue: `线索 ${topic}` }])),
    conferences: { 10: '会议线索' },
    startingClues: [ownClues, foreignClues],
  } });
  const host = room.players[0];
  const guest = addPlayer(room, '另一位玩家');
  assert.equal(applyRoomAction(room, host.id, { kind: 'start-game' }).ok, true);
  const identity = { roomId: room.id, playerId: host.id, token: host.token };
  const roomNotesKey = `planetx.notes.${room.id}.${host.id}`;
  const handwritten = { [`7:${CODE.asteroid}`]: 'yes', [`5:${CODE.planetX}`]: 'no' };
  storage.set(roomNotesKey, JSON.stringify(handwritten));
  tabStorage.set('planetx.room.v1', JSON.stringify(identity));
  const calls = [];
  const snapshot = () => JSON.parse(JSON.stringify(viewFor(room, mismatchedView ? guest.id : host.id)));
  globalThis.fetch = async (url, options = {}) => {
    const action = options.body ? JSON.parse(options.body).action : null;
    if (!action) return { status: 200, json: async () => ({ view: snapshot() }) };
    calls.push(action);
    const result = failClaim && action.kind === 'claim-initial-clues'
      ? { ok: false, error: '领取失败，请稍后重试' }
      : applyRoomAction(room, host.id, action);
    return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: snapshot() }) };
  };
  const root = makeEl('div');
  const app = createApp(root);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.state.remote?.playerId, host.id);
  return { app, root, calls, ownClues, foreignClues, roomNotesKey, handwritten };
}

test('initial clue app automatically marks its own delivery and keeps same-count retries idempotent', async (context) => {
  const { app, calls, ownClues, foreignClues, handwritten } = await initialClueApp(context);
  const expectedNotes = { ...handwritten, ...Object.fromEntries(ownClues.map(clue => [`${clue.sector}:${CODE[clue.objectType]}`, 'no'])) };
  assert.deepEqual(app.state.notes, expectedNotes, 'automatic delivery imports only this player’s clues and preserves handwritten notes');
  for (const clue of foreignClues) assert.equal(app.state.notes[`${clue.sector}:${CODE[clue.objectType]}`], undefined);
  assert.equal(typeof app.api.claimInitialClues, 'function', 'the app exposes the agreed claim handler');
  const result = await app.api.claimInitialClues(4);
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ kind: 'claim-initial-clues', count: 4 }]);
  assert.equal(app.state.game.mySetup.cluesClaimed, true);
  assert.equal(app.state.game.mySetup.ready, false, 'retrying never presses Ready');
  assert.equal(app.state.game.phase, 'setup');
  assert.deepEqual(app.state.notes, expectedNotes);
});

test('initial clue app refresh restores delivered clues even when the notes cache only has handwritten marks', async (context) => {
  const { app, ownClues, handwritten, roomNotesKey } = await initialClueApp(context);
  const expectedNotes = { ...handwritten, ...Object.fromEntries(ownClues.map((clue) => [`${clue.sector}:${CODE[clue.objectType]}`, 'no'])) };
  assert.equal(app.state.game.mySetup.ready, false);
  assert.deepEqual(app.state.notes, expectedNotes, 'joining a delivered setup restores the exclusions');
  storage.set(roomNotesKey, JSON.stringify(handwritten));
  const refreshed = createApp(makeEl('div'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(refreshed.state.notes, expectedNotes, 'refresh restores facts without discarding unrelated notes');
});

test('initial clue app does not import another player’s delivered setup into this player’s notes', async (context) => {
  const { app, handwritten } = await initialClueApp(context, { mismatchedView: true });
  assert.equal(app.state.game.mySetup.cluesClaimed, true);
  assert.notEqual(app.state.game.me, app.state.remote.playerId);
  assert.deepEqual(app.state.notes, handwritten);
});

test('initial clue app failed retry leaves already-delivered clues and readiness unchanged', async (context) => {
  const { app, calls } = await initialClueApp(context, { failClaim: true });
  const before = { ...app.state.notes };
  assert.equal(typeof app.api.claimInitialClues, 'function', 'the app exposes the agreed claim handler');
  const result = await app.api.claimInitialClues(4);
  assert.equal(result.ok, false);
  assert.deepEqual(calls, [{ kind: 'claim-initial-clues', count: 4 }]);
  assert.deepEqual(app.state.notes, before);
  assert.equal(app.state.game.mySetup.cluesClaimed, true);
  assert.equal(app.state.game.mySetup.ready, false);
});

test('app refuses forbidden comet endpoints even through previously rendered map callbacks', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const callbacks = new Map(findAll(root, (element) => element.attributes['data-sector'] !== undefined).map((sector) => [
    Number(sector.attributes['data-sector']),
    findAll(sector, (element) => (element.className || '').split(/\s+/).includes('wedge'))[0].listeners.click[0],
  ]));
  app.api.startAction('survey');
  app.api.setUi({ surveyType: Obj.COMET });
  callbacks.get(0)();
  assert.deepEqual(app.state.ui.pick, [], 'sector 1 is not a prime-numbered endpoint');
  assert.equal(app.state.ui.selectedSector, null);
  callbacks.get(1)();
  assert.deepEqual(app.state.ui.pick, [1]);
  callbacks.get(3)();
  callbacks.get(6)();
  assert.deepEqual(app.state.ui.pick, [1], 'neither non-prime 4 nor currently hidden prime 7 can finish the range');
  callbacks.get(2)();
  assert.deepEqual(app.state.ui.pick, [1, 2]);
});

function uiSliceState(game = {}, ui = {}) {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  return { ...app.state, game: { ...app.state.game, ...game }, ui: { ...app.state.ui, ...ui } };
}

test('status player chips highlight the active turn with a turn badge', () => {
  const state = uiSliceState({
    phase: 'play',
    isMyTurn: false,
    turnPlayerName: 'Bot1',
    players: [
      { id: 'me', name: '我', color: '#5eead4', host: true, isMe: true, isTurn: false, timeLabel: '第 1 圈 / 第 1 格', sector: 1 },
      { id: 'bot', name: 'Bot1', color: '#fbbf24', bot: true, isMe: false, isTurn: true, timeLabel: '第 1 圈 / 第 2 格', sector: 2 },
    ],
  });
  const status = renderStatus({ state, api: {} });
  const chips = findAll(status, (element) => (element.className || '').includes('player-chip'));
  assert.equal(chips.length, 2);
  const active = chips.find((chip) => (chip.className || '').split(/\s+/).includes('turn'));
  const idle = chips.find((chip) => !(chip.className || '').split(/\s+/).includes('turn'));
  assert.ok(active, 'active player chip has turn class');
  assert.match(collectText(active).join(''), /行动中/);
  assert.ok(findAll(active, (element) => (element.className || '') === 'turn-badge').length === 1);
  assert.equal(active.style?.borderColor, undefined, 'turn highlight is not overridden by player color');
  assert.doesNotMatch(collectText(idle).join(''), /行动中/);
  assert.equal(idle.style?.borderColor, '#5eead4');
});

test('approved initial clue setup displays the locked host count and never offers a personal claim', () => {
  for (const count of [0, 4, 8, 12]) {
    const state = uiSliceState({ playMode: 'builtin', phase: 'setup', initialClueCount: count, mySetup: { initialClueCount: count, cluesClaimed: false, clues: [], ready: false } }, { initialClueCount: count === 4 ? 8 : 4 });
    const calls = [];
    const api = {
      submitSetup() { calls.push({ kind: 'setup' }); },
    };
    const render = () => renderActionPanel({ state, api });
    let panel = render();
    const choices = findAll(panel, (element) => element.attributes['data-initial-clue-count'] !== undefined);
    assert.deepEqual(choices, []);
    const ready = findButton(panel, '我已准备');
    assert.ok(Object.hasOwn(ready.attributes, 'disabled'));
    fire(ready, 'click');
    assert.deepEqual(calls, [], 'readiness cannot precede the authoritative delivery');
    assert.equal(findButton(panel, '领取初始线索'), undefined);
    state.game.mySetup = { initialClueCount: count, cluesClaimed: true, ready: false, clues: count ? [{ sector: 1, type: Obj.GAS_CLOUD }] : [] };
    state.ui.initialClueCount = count === 4 ? 8 : 4;
    panel = render();
    const locked = findAll(panel, (element) => element.attributes['data-initial-clue-count'] !== undefined);
    assert.deepEqual(locked, [], 'there is no personal count control after starting');
    assert.equal(calls.length, 0, 'there is no reroll or count-changing action');
    assert.match(collectText(panel).join(''), new RegExp(`已自动收到 ${count} 条`));
    if (count) assert.match(collectText(panel).join(''), /2 号扇区没有气体云/);
    const unlockedReady = findButton(panel, '我已准备');
    assert.equal(unlockedReady.attributes.disabled, undefined);
    fire(unlockedReady, 'click');
    assert.deepEqual(calls.at(-1), { kind: 'setup' });
  }
});

test('approved map omits forbidden comet glyphs, click slots, mark chips and stale popovers on both boards', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const state = uiSliceState({ mode, visible: visibleSectorsAt(0, mode) }, { selectedSector: 0, mark: { sector: 0, code: CODE.comet } });
    state.notes = { [`0:${CODE.comet}`]: 'yes' };
    const marks = [];
    const board = renderBoard({ game: state.game, ui: state.ui, notes: state.notes, onSector() {}, onMark: (sector, code) => marks.push({ sector, code }) });
    const sectors = findAll(board, (element) => element.attributes['data-sector'] !== undefined);
    for (const sectorNode of sectors) {
      const sector = Number(sectorNode.attributes['data-sector']);
      const legal = [2, 3, 5, 7, 11, 13, 17].includes(sector + 1);
      assert.equal(findAll(sectorNode, (element) => (element.className || '').split(/\s+/).includes('icon-comet')).length, legal ? 1 : 0);
      findAll(sectorNode, (element) => (element.className || '').includes('icon-hit')).forEach((hit) => fire(hit, 'click'));
    }
    assert.ok(marks.every((mark) => mark.code !== CODE.comet || [2, 3, 5, 7, 11, 13, 17].includes(mark.sector + 1)));
    const panel = renderMapPanel({ state, api: {}, boardEl: board });
    const strip = findAll(panel, (element) => element.className === 'mark-strip')[0];
    assert.doesNotMatch(collectText(strip).join(''), /彗星/);
    assert.equal(findAll(panel, (element) => element.className === 'mark-pop').length, 0);
  }
});

test('approved comet surveys offer only visible prime-numbered endpoints in selects and SVG wedges', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const visible = visibleSectorsAt(mode.sectors - 2, mode);
    const allowed = visible.filter((sector) => [2, 3, 5, 7, 11, 13, 17].includes(sector + 1));
    const state = uiSliceState({ mode, visible, visibleStart: visible[0] }, { action: 'survey', surveyType: Obj.COMET, pick: [] });
    const api = { pickedRange: () => null, setUi(patch) { state.ui = { ...state.ui, ...patch }; } };
    let panel = renderActionPanel({ state, api });
    for (const label of ['勘测起点', '勘测终点']) {
      const select = findAll(panel, (element) => element.tagName === 'select' && element.attributes['aria-label'] === label)[0];
      assert.ok(select, `${label} is available without relying on map clicks`);
      assert.deepEqual(select.children.filter((option) => option.attributes.value !== '').map((option) => Number(option.attributes.value)), allowed);
      assert.ok(select.children.every((option) => option.attributes.disabled === undefined), 'invalid sectors are omitted rather than disabled');
    }
    const start = findAll(panel, (element) => element.attributes['aria-label'] === '勘测起点')[0];
    fire(start, 'change', { target: { value: String(allowed[0]) } });
    assert.deepEqual(state.ui.pick, [allowed[0]]);
    panel = renderActionPanel({ state, api });
    const end = findAll(panel, (element) => element.attributes['aria-label'] === '勘测终点')[0];
    fire(end, 'change', { target: { value: String(allowed[1]) } });
    assert.deepEqual(state.ui.pick, [allowed[0], allowed[1]]);
    const selected = [];
    const board = renderBoard({ game: state.game, ui: state.ui, notes: {}, onSector: (sector) => selected.push(sector), onMark() {} });
    findAll(board, (element) => (element.className || '').split(/\s+/).includes('wedge')).forEach((wedge) => fire(wedge, 'click'));
    assert.deepEqual(selected.sort((first, second) => first - second), [...allowed].sort((first, second) => first - second));
    state.ui.pick = [0, 1];
    const invalid = renderActionPanel({ state, api: { ...api, pickedRange: () => ({ start: 0, size: 2 }) } });
    assert.ok(Object.hasOwn(findButton(invalid, '确认勘测').attributes, 'disabled'), 'a stale non-prime endpoint cannot be confirmed');
  }
});

test('approved regular and triggered research selectors consume per-sector theoryOptions without re-deriving locks', () => {
  for (const online of [false, true]) {
    const state = uiSliceState({
      phase: online ? 'play' : undefined,
      theoryPhaseOpen: true,
      theoryPhase: { sector: 3 },
      theoryOptions: [{ sector: 1, types: [Obj.GAS_CLOUD] }, { sector: 4, types: [Obj.COMET, Obj.DWARF_PLANET] }],
      theoryLockedSectors: [2, 8],
      research: online ? { id: 'phase-3', sector: 3, myCount: 1, allDeclared: true, isMyPick: true, left: 1, orderNames: ['甲', '乙'], picks: [], myPicks: [] } : null,
    }, { action: 'theory', theorySector: 1, theoryType: Obj.GAS_CLOUD });
    state.game.knowledge = { ...state.game.knowledge, theories: [{ id: 'older', actorId: state.game.me, sector: 1, objectType: Obj.ASTEROID, review: 'wrong', slot: 1 }] };
    const api = { setUi(patch) { state.ui = { ...state.ui, ...patch }; }, confirmAction() {}, cancelAction() {}, consoleAction() {} };
    let panel = renderActionPanel({ state, api });
    const sectorSelect = findAll(panel, (element) => element.tagName === 'select')[0];
    assert.deepEqual(sectorSelect.children.map((option) => Number(option.attributes.value)), [1, 4]);
    assert.ok(sectorSelect.children.every((option) => option.attributes.disabled === undefined));
    assert.doesNotMatch(collectText(sectorSelect).join(''), /已公开/);
    const chips = findAll(panel, (element) => (element.className || '').split(/\s+/).includes('chip-select'));
    assert.deepEqual(chips.map((chip) => collectText(chip).join('')), ['气体云'], 'another type at an older attempted sector remains available');
    state.ui.theoryType = Obj.ASTEROID;
    panel = renderActionPanel({ state, api });
    assert.ok(Object.hasOwn(findButton(panel, '确认提交').attributes, 'disabled'));
    state.ui.theorySector = 4;
    state.ui.theoryType = Obj.COMET;
    panel = renderActionPanel({ state, api });
    assert.deepEqual(findAll(panel, (element) => (element.className || '').split(/\s+/).includes('chip-select')).map((chip) => collectText(chip).join('')), ['彗星', '矮行星']);
    assert.equal(findButton(panel, '确认提交').attributes.disabled, undefined);
  }
});

function activeEventMarkers(game) {
  const board = renderBoard({ game, ui: {}, notes: {}, onSector() {}, onMark() {} });
  return findAll(board, (element) => matches(element, '.event-marker') && matches(element, '.active')).map((marker) => {
    const title = marker.children.find((element) => element.tagName === 'title');
    return {
      kind: matches(marker, '.event-theory') ? 'theory' : 'conference',
      sector: Number(collectText(title).join('').match(/离开 (\d+) 号/)[1]),
    };
  });
}

function completeConsoleEventPhases(session, beforeTime = Infinity) {
  while (session.theoryPhases[0]?.time < beforeTime) assert.equal(completeTheoryPhase(session).ok, true);
}

function createEventRoom(modeId = 'standard') {
  const room = createRoom({ modeId, hostName: '先到者', initialClueCount: 0 });
  addPlayer(room, '后到者');
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'start-game' }).ok, true);
  for (const player of room.players) assert.equal(applyRoomAction(room, player.id, { kind: 'setup', noClues: true }).ok, true);
  return room;
}

function completeRoomEventPhase(room) {
  const phaseId = room.research.id;
  for (const player of room.players) assert.equal(applyRoomAction(room, player.id, { kind: 'research-declare', phaseId, count: 0 }).ok, true);
}

function advanceEventRoom(room, targetTime) {
  while (viewFor(room, room.hostId).windowTime < targetTime) {
    if (room.research) completeRoomEventPhase(room);
    else if (room.conference) assert.equal(applyRoomAction(room, room.hostId, { kind: 'conference', sector: room.conference.sector, text: '已记录的会议' }).ok, true);
    else assert.equal(applyRoomAction(room, currentPlayer(room).id, { kind: 'wait' }).ok, true);
  }
}

for (const [modeId, marker, kind] of [['standard', 3, 'theory'], ['standard', 10, 'conference'], ['expert', 7, 'conference'], ['expert', 16, 'conference']]) {
  test(`event UI follows real console ${modeId} ${kind} departure at ${marker}`, () => {
    const session = createConsole({ modeId });
    assert.equal(recordWait(session, marker - 1).ok, true);
    completeConsoleEventPhases(session);
    for (const sector of consoleView(session).conferenceSectors.filter((sector) => sector < marker)) {
      assert.equal(recordConference(session, { sector, text: '先前会议' }).ok, true);
    }
    const entering = consoleView(session);
    assert.equal(entering.events[kind], true);
    assert.deepEqual(activeEventMarkers(entering), [], 'standing on a marker does not activate it');
    assert.equal(recordResearch(session, { topic: 'A', text: '推进一个时间单位' }).ok, true);
    const game = consoleView(session);
    assert.equal(game.time, marker);
    assert.equal(game.events[kind], false, 'eventsAt continues to describe the new current marker');
    const state = uiSliceState(game);
    const status = collectText(renderStatus({ state, api: {} })).join('');
    assert.match(status, new RegExp(`天窗起点离开 ${marker} 号.*${marker}→${marker + 1}`));
    assert.doesNotMatch(status, /箭头走到|到达或越过|棋子越过/);
    assert.deepEqual(activeEventMarkers(game), [{ kind, sector: marker }]);
    if (kind === 'conference') {
      const panel = renderActionPanel({ state, api: {} });
      const entry = findAll(panel, (element) => element.attributes['data-disclosure'] === `conference-due-${marker}`)[0];
      assert.equal(entry?.attributes.open, '', 'a departed offline conference opens its entry form');
    }
    const help = collectText(renderModal({ state: { ...state, ui: { ...state.ui, modal: { kind: 'help' } } }, api: {} })).join('');
    assert.match(help, new RegExp(`${marker}→${marker + 1}`));
    assert.match(help, /先到者在后.*先行动.*先提交/);
  });
}

test('event UI defers an overdue offline conference until earlier theory phases finish', () => {
  const session = createConsole();
  assert.equal(recordWait(session, 11).ok, true);
  completeConsoleEventPhases(session, 9);
  const pending = consoleView(session);
  assert.equal(pending.theoryPhase.sector, 9);
  assert.equal(pending.time, 11);
  assert.deepEqual(activeEventMarkers(pending), [{ kind: 'theory', sector: 9 }]);
  const pendingState = uiSliceState(pending);
  assert.match(collectText(renderStatus({ state: pendingState, api: {} })).join(''), /离开 9 号事件标记/);
  assert.equal(findAll(renderActionPanel({ state: pendingState, api: {} }), (element) => /^conference-due-/.test(element.attributes['data-disclosure'] || '')).length, 0);
  assert.equal(completeTheoryPhase(session).ok, true);
  assert.equal(nudgeWindow(session, 4).ok, true);
  const due = consoleView(session);
  assert.equal(due.visibleStart, 3, 'manual window placement does not change elapsed departure time');
  const dueState = uiSliceState(due);
  assert.match(collectText(renderStatus({ state: dueState, api: {} })).join(''), /离开 10 号事件标记/);
  assert.deepEqual(activeEventMarkers(due), [{ kind: 'conference', sector: 10 }]);
  const entry = findAll(renderActionPanel({ state: dueState, api: {} }), (element) => element.attributes['data-disclosure'] === 'conference-due-10')[0];
  assert.equal(entry?.attributes.open, '');
  assert.equal(recordConference(session, { sector: 10, text: '会议已记录' }).ok, true);
  const completed = consoleView(session);
  assert.deepEqual(activeEventMarkers(completed), []);
  assert.match(collectText(renderStatus({ state: uiSliceState(completed), api: {} })).join(''), /自由推理/);
});

test('event UI pauses queued markers and conference reminders during offline peer review', () => {
  const session = createConsole();
  assert.equal(recordSurvey(session, { type: Obj.ASTEROID, start: 0, size: 1, count: 1 }).ok, true);
  const paper = recordTheory(session, { sector: 0, type: Obj.GAS_CLOUD });
  assert.equal(paper.ok, true);
  assert.equal(completeTheoryPhase(session).ok, true);
  assert.equal(recordSurvey(session, { type: Obj.ASTEROID, start: 4, size: 1, count: 0 }).ok, true);
  assert.equal(completeTheoryPhase(session).ok, true);
  assert.equal(recordTarget(session, { sector: 8, apparent: Obj.ASTEROID }).ok, true);
  assert.equal(consoleView(session).theoryPhase.sector, 9);
  assert.equal(completeTheoryPhase(session).ok, true);
  const blocked = consoleView(session);
  assert.equal(blocked.time, 12);
  assert.deepEqual(blocked.awaitingReview, [paper.entry.id]);
  assert.equal(blocked.theoryPhase.sector, 12);
  assert.equal(blocked.theoryPhaseOpen, false);
  assert.equal(completeTheoryPhase(session).ok, false);
  assert.deepEqual(activeEventMarkers(blocked), [], 'review blocks both the queued theory and the later conference');
  const state = uiSliceState(blocked);
  const status = collectText(renderStatus({ state, api: {} })).join('');
  assert.match(status, /同行评审/);
  assert.doesNotMatch(status, /该开会了|天窗起点离开 \d+ 号|自由推理/);
  assert.match(collectText(renderActionPanel({ state, api: {} })).join(''), /等待同行评审/);
  assert.equal(markTheoryReview(session, paper.entry.id, 'wrong').ok, true);
  const resumed = consoleView(session);
  assert.equal(resumed.awaitingReview.length, 0);
  assert.equal(resumed.theoryPhaseOpen, true);
  assert.ok(activeEventMarkers(resumed).some((marker) => marker.kind === 'theory' && marker.sector === 12));
  assert.doesNotMatch(collectText(renderStatus({ state: uiSliceState(resumed), api: {} })).join(''), /同行评审/);
});

test('event SVG follows real shared pending phases, not a leading viewer clock or wrapped marker', () => {
  for (const modeId of ['standard', 'expert']) {
    const room = createEventRoom(modeId);
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.EMPTY, correct: false }).ok, true);
    const initial = viewFor(room, room.hostId);
    assert.equal(initial.time, 5);
    assert.equal(initial.windowTime, 0);
    assert.deepEqual(activeEventMarkers(initial), []);
    advanceEventRoom(room, 2);
    const entering = viewFor(room, room.hostId);
    assert.equal(entering.events.theory, true);
    assert.equal(entering.research, null);
    assert.deepEqual(activeEventMarkers(entering), []);
    for (const windowTime of [3, room.session.mode.sectors]) {
      advanceEventRoom(room, windowTime);
      const game = viewFor(room, room.hostId);
      assert.equal(game.windowTime, windowTime);
      assert.equal(game.events.theory, false);
      assert.equal(game.research.sector, windowTime);
      assert.deepEqual(activeEventMarkers(game), [{ kind: 'theory', sector: windowTime }]);
      completeRoomEventPhase(room);
      assert.deepEqual(activeEventMarkers(viewFor(room, room.hostId)), [], 'completion removes the highlight without moving the window');
    }
  }
});

test('event UI follows a real room conference after departure and until its prompt is recorded', () => {
  const room = createEventRoom();
  advanceEventRoom(room, 9);
  completeRoomEventPhase(room);
  const entering = viewFor(room, room.hostId);
  assert.equal(entering.events.conference, true);
  assert.equal(entering.conference, null);
  assert.match(collectText(renderStatus({ state: uiSliceState(entering), api: {} })).join(''), /自由推理/);
  const researcherId = currentPlayer(room).id;
  assert.equal(applyRoomAction(room, researcherId, { kind: 'research', topic: 'A', text: '先到下一格' }).ok, true);
  const ahead = viewFor(room, researcherId);
  assert.equal(ahead.time, 10);
  assert.equal(ahead.windowTime, 9);
  assert.equal(ahead.conference, null);
  assert.deepEqual(activeEventMarkers(ahead), []);
  assert.match(collectText(renderStatus({ state: uiSliceState(ahead), api: {} })).join(''), /自由推理/);
  assert.equal(applyRoomAction(room, currentPlayer(room).id, { kind: 'research', topic: 'A', text: '天窗离开会议标记' }).ok, true);
  for (const windowTime of [10, 11]) {
    const game = viewFor(room, room.hostId);
    assert.equal(game.windowTime, windowTime);
    assert.equal(game.events.conference, false);
    assert.equal(game.conference.sector, 10);
    const state = uiSliceState(game);
    assert.match(collectText(renderStatus({ state, api: {} })).join(''), /离开 10 号事件标记/);
    assert.deepEqual(activeEventMarkers(game), [{ kind: 'conference', sector: 10 }]);
    const entry = findAll(renderActionPanel({ state, api: {} }), (element) => element.attributes['data-disclosure'] === 'conference-due-10')[0];
    assert.equal(entry?.attributes.open, '');
    if (windowTime === 10) {
      for (const player of room.players) assert.equal(applyRoomAction(room, currentPlayer(room).id, { kind: 'wait' }).ok, true);
    }
  }
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'conference', sector: 10, text: '会议已记录' }).ok, true);
  const completed = viewFor(room, room.hostId);
  assert.equal(completed.conference, null);
  assert.deepEqual(activeEventMarkers(completed), []);
  assert.match(collectText(renderStatus({ state: uiSliceState(completed), api: {} })).join(''), /自由推理/);
});

test('event UI never highlights conferences or research in real frozen final and revealed views', () => {
  const room = createEventRoom();
  advanceEventRoom(room, 10);
  assert.equal(viewFor(room, room.hostId).conference.sector, 10);
  assert.equal(applyRoomAction(room, currentPlayer(room).id, { kind: 'locate', sector: 0, left: Obj.EMPTY, right: Obj.EMPTY, correct: true }).ok, true);
  for (const phase of ['final', 'reveal', 'done']) {
    const game = viewFor(room, room.hostId);
    assert.equal(game.phase, phase);
    assert.equal(game.windowTime, 10);
    assert.deepEqual(activeEventMarkers(game), []);
    const status = renderStatus({ state: uiSliceState(game), api: {} });
    assert.match(collectText(status).join(''), /终局/);
    assert.equal(findAll(status, (element) => matches(element, '.event-now')).length, 0);
    if (phase === 'final') assert.equal(applyRoomAction(room, room.endgame.cursorId, { kind: 'final-pass' }).ok, true);
    if (phase === 'reveal') assert.equal(applyRoomAction(room, room.hostId, { kind: 'reveal-objects', objects: Array.from({ length: 12 }, (unused, sector) => sector === 0 ? Obj.PLANET_X : Obj.EMPTY) }).ok, true);
  }
  const session = createConsole();
  assert.equal(recordWait(session, 9).ok, true);
  completeConsoleEventPhases(session);
  assert.equal(recordLocate(session, { sector: 0, left: Obj.EMPTY, right: Obj.EMPTY, correct: true }).ok, true);
  for (const status of ['reveal', 'finished']) {
    const game = consoleView(session);
    assert.equal(game.status, status);
    assert.equal(game.visibleStart, 9);
    assert.equal(game.time, 14, 'the personal locate cost cannot trigger the next frozen conference');
    assert.deepEqual(activeEventMarkers(game), []);
    const panel = renderStatus({ state: uiSliceState(game), api: {} });
    assert.equal(findAll(panel, (element) => matches(element, '.event-now')).length, 0);
    if (status === 'reveal') assert.equal(revealObjects(session, Array.from({ length: 12 }, (unused, sector) => sector === 0 ? Obj.PLANET_X : Obj.EMPTY)).ok, true);
  }
});

test('approved normal actions omit waiting and publishing while triggered research retains padded controls', async () => {
  for (const playMode of ['record', 'builtin']) {
    const state = uiSliceState({ playMode, phase: 'play', isMyTurn: true }, { action: 'idle' });
    const panel = renderActionPanel({ state, api: {} });
    assert.equal(findAll(panel, (element) => element.className === 'action-tile').length, 3);
    assert.equal(findButton(panel, '提交学术研究'), undefined);
    assert.equal(findButton(panel, '等待 1'), undefined);
    state.game.research = { id: 'research', sector: 3, myCount: null, declaredCount: 0, playerCount: 1, quota: 1, maxDeclare: 1 };
    state.game.theoryOptions = [{ sector: 1, types: [Obj.ASTEROID] }];
    assert.ok(findButton(renderActionPanel({ state, api: {} }), '提交 1 篇'), 'declare controls stay in the right action panel');
    const map = renderMapPanel({ state, api: { recordTheoryReview() {}, openMark() {}, setUi() {} }, boardEl: makeEl('div'), onClearNotes: null });
    assert.equal(findButton(map, '提交 1 篇'), undefined, 'the map rail only keeps the results table');
    assert.ok(findAll(map, (element) => (element.className || '').includes('theories-card')).length, 'submitted results remain inside the map');
  }
  const { readFileSync } = await import('node:fs');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles.match(/\.research-open,\s*\.record-card \.research-open\s*\{([^}]+)\}/)?.[1] || '', /padding:\s*(?:1[6-9]|[2-9]\d)px/);
});

test('approved academic progress groups multiple papers into two columns with authors, slots and per-view privacy', () => {
  const state = uiSliceState({ me: 'mine', status: 'open', players: [{ id: 'mine', name: '甲', color: '#5eead4' }, { id: 'other', name: '乙', color: '#f5b942' }] });
  state.game.knowledge = { ...state.game.knowledge, theories: [
    { id: 'own', actorId: 'mine', sector: 1, objectType: Obj.ASTEROID, review: 'pending', slot: 1 },
    { id: 'hidden', actorId: 'other', sector: 1, review: 'pending', slot: 2 },
    { id: 'public', actorId: 'other', sector: 1, objectType: Obj.GAS_CLOUD, revealed: true, review: 'correct', slot: 1 },
    { id: 'later', actorId: 'mine', sector: 5, objectType: Obj.DWARF_PLANET, review: 'pending', slot: 3 },
  ] };
  const reviews = [];
  const panel = renderTheoriesPanel({ game: state.game, onReview: (id, verdict) => reviews.push({ id, verdict }) });
  const table = findAll(panel, (element) => element.tagName === 'table')[0];
  assert.ok(table, 'academic progress is a real table');
  const rows = findAll(table, (element) => element.tagName === 'tr');
  assert.equal(rows.length, 3, 'one header and one row per occupied sector');
  assert.ok(rows.every((row) => row.children.length === 2));
  assert.deepEqual(rows.slice(1).map((row) => collectText(row.children[0]).join('')), ['2 号', '6 号']);
  const papers = findAll(table, (element) => element.attributes['data-theory-id'] !== undefined);
  assert.equal(papers.length, 4);
  assert.equal(findAll(table, (element) => (element.className || '').split(/\s+/).includes('track')).length, 4);
  const hidden = papers.find((paper) => paper.attributes['data-theory-id'] === 'hidden');
  assert.match(collectText(hidden).join(''), /乙/);
  assert.match(collectText(hidden).join(''), /未公开|\?/);
  assert.doesNotMatch(collectText(hidden).join(''), /小行星|气体云|矮行星|彗星/);
  assert.equal(findAll(hidden, (element) => element.tagName === 'svg').length, 0, 'a neighbor’s public paper does not reveal this paper’s object');
  assert.equal(findAll(hidden, (element) => element.tagName === 'button').length, 0);
  fire(findButton(papers.find((paper) => paper.attributes['data-theory-id'] === 'own'), '正确'), 'click');
  assert.deepEqual(reviews, [{ id: 'own', verdict: 'correct' }]);
});

test('approved public scores use a two-row per-player table with object unit values and actual sums, never an extra first-X bonus', async () => {
  for (const modeId of ['standard', 'expert']) {
    const dwarfPoints = modeId === 'expert' ? 2 : 4;
    const rows = [
      { id: 'mine', name: '甲', theories: [{ objectType: Obj.ASTEROID, points: 2 }, { objectType: Obj.ASTEROID, points: 2 }, { objectType: Obj.COMET, points: 3 }, { objectType: Obj.GAS_CLOUD, points: 4 }, { objectType: Obj.DWARF_PLANET, points: dwarfPoints }], leaderBonus: 2, located: true, locatePoints: 10, total: 23 + dwarfPoints },
      { id: 'other', name: '乙', theories: [{ objectType: Obj.GAS_CLOUD, points: 4 }], leaderBonus: 1, located: false, locatePoints: 0, total: 5 },
      { id: 'waiting', name: '丙', theories: [], leaderBonus: 0, located: false, locatePoints: 0, total: 0 },
    ];
    const state = uiSliceState({ mode: modeById(modeId), me: 'mine', scores: { rows, firstFinderId: 'mine', finished: false, locateFirst: 10, locatePerSector: 2, leaderBonus: 1 } });
    const panel = renderScorePanel({ state, api: {} });
    const tables = findAll(panel, (element) => element.tagName === 'table');
    assert.equal(tables.length, rows.length, 'all players’ public scores remain visible');
    for (const [index, table] of tables.entries()) {
      const tableRows = findAll(table, (element) => element.tagName === 'tr');
      assert.equal(tableRows.length, 2);
      assert.ok(tableRows.every((row) => row.children.length === 7));
      assert.match(collectText(table).join(''), new RegExp(rows[index].name));
      const headings = tableRows[0].children.map((cell) => collectText(cell).join(''));
      for (const [typeIndex, label, points] of [[0, '小行星', 2], [1, '彗星', 3], [2, '气体云', 4], [3, '矮行星', dwarfPoints]]) assert.match(headings[typeIndex], new RegExp(`${label}.*${points}.*分`));
      assert.match(headings[4], /首对奖励.*\+1.*扇区/);
      assert.match(headings[5], /定位\s*X行星/);
      assert.equal(headings[6], '合计');
      const values = tableRows[1].children.map((cell) => Number(collectText(cell).join('')));
      assert.deepEqual(values, index === 0 ? [4, 3, 4, dwarfPoints, 2, 10, 23 + dwarfPoints] : index === 1 ? [0, 0, 4, 0, 1, 0, 5] : [0, 0, 0, 0, 0, 0, 0]);
      assert.equal(values.slice(0, -1).reduce((sum, value) => sum + value, 0), values.at(-1));
    }
  }
  const { readFileSync } = await import('node:fs');
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.score-table-wrap\s*\{[^}]*overflow-x:\s*auto/);
});

test('app theory defaults omit revealed sectors but keep a different allowed type at a previously attempted sector', () => {
  storage.clear();
  tabStorage.clear();
  const root = makeEl('div');
  const app = createApp(root);
  const game = {
    ...app.state.game, me: 'viewer', phase: 'play', isMyTurn: true, theoryPhaseOpen: true, theoryPhase: { sector: 6 },
    theoryLockedSectors: [0],
    theoryOptions: [{ sector: 1, types: [Obj.GAS_CLOUD] }, { sector: 4, types: [Obj.COMET, Obj.DWARF_PLANET] }],
    knowledge: { ...app.state.game.knowledge, theories: [
      { id: 'revealed', actorId: 'viewer', sector: 0, objectType: Obj.ASTEROID, review: 'correct', revealed: true, slot: 1 },
      { id: 'earlier-phase', actorId: 'viewer', sector: 1, objectType: Obj.ASTEROID, review: 'wrong', slot: 1 },
    ] },
  };
  app.state.remote = { roomId: 'THEORY-UI', playerId: 'viewer', token: 'fixture', view: game };
  app.api.startAction('theory');
  assert.equal(app.state.ui.theorySector, 1, 'the default skips the revealed sector without discarding an earlier attempted sector');
  assert.equal(app.state.ui.theoryType, Obj.GAS_CLOUD, 'the previously attempted identical claim is not reused');
  const selector = findAll(root, (element) => element.tagName === 'select' && element.attributes['aria-label'] === '扇区')[0];
  assert.deepEqual(selector.children.map((option) => Number(option.attributes.value)), [1, 4]);
  app.api.setUi({ theorySector: 1, theoryType: Obj.ASTEROID });
  assert.equal(app.state.ui.theorySector, 1);
  assert.equal(app.state.ui.theoryType, Obj.GAS_CLOUD);
  game.theoryOptions = [{ sector: 4, types: [Obj.COMET] }];
  app.render();
  assert.equal(app.state.ui.theorySector, 4, 'a same-phase used sector is removed when the server options change');
  assert.equal(app.state.ui.theoryType, Obj.COMET);
});

test('app switching survey type to comet clears invalid old endpoints while retaining visible prime picks', () => {
  storage.clear();
  tabStorage.clear();
  const app = createApp(makeEl('div'));
  for (const modeId of ['standard', 'expert']) {
    app.api.newSession(modeId);
    app.api.startAction('survey');
    const hiddenPrime = modeId === 'standard' ? 10 : 16;
    for (const [picks, expected] of [[[0, 3], []], [[1, 3], [1]], [[0, 2], [2]], [[1, 2], [1, 2]], [[1, hiddenPrime], [1]]]) {
      app.api.setUi({ surveyType: Obj.ASTEROID, pick: picks, selectedSector: picks.at(-1) });
      app.api.setUi({ surveyType: Obj.COMET });
      assert.deepEqual(app.state.ui.pick, expected, `${modeId}: remove forbidden or invisible endpoints`);
      assert.equal(app.state.ui.selectedSector, expected.at(-1) ?? null);
      if (expected.length < 2) assert.equal(app.api.pickedRange(), null);
    }
  }
});

test('integrated tutorial uses real rendered controls through reveal, restart and isolated exit', async context => {
  storage.clear();
  tabStorage.clear();
  const { createTutorialRoom, applyTutorialAction } = await import('../server/tutorial.js');
  const previousFetch = globalThis.fetch;
  const previousEventSource = globalThis.EventSource;
  globalThis.EventSource = undefined;
  const rooms = new Map();
  const results = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.endsWith('/modes')) return { status: 200, json: async () => ({ playModes: ['record', 'builtin', 'tutorial'], builtinBoards: ['standard', 'expert'], initialClueCounts: [0, 4, 8, 12] }) };
    const body = options.body ? JSON.parse(options.body) : null;
    if (path.endsWith('/rooms')) {
      assert.equal(body.playMode, 'tutorial');
      assert.equal(body.modeId, 'standard');
      assert.equal(body.initialClueCount, 4);
      const room = createTutorialRoom({ hostName: body.name });
      rooms.set(room.id, room);
      return { status: 200, json: async () => ({ roomId: room.id, playerId: room.hostId, token: room.players[0].token, view: JSON.parse(JSON.stringify(viewFor(room, room.hostId))) }) };
    }
    const room = rooms.get(path.split('/')[3]);
    assert.ok(room, `expected a tutorial room for ${path}`);
    const result = body?.action ? applyTutorialAction(room, room.hostId, body.action) : { ok: true };
    if (body?.action) results.push({ action: body.action, result });
    return { status: result.ok ? 200 : 400, json: async () => ({ ...result, view: JSON.parse(JSON.stringify(viewFor(room, room.hostId))) }) };
  };
  context.after(() => {
    globalThis.fetch = previousFetch;
    globalThis.EventSource = previousEventSource;
    tabStorage.clear();
  });
  const root = makeEl('div');
  const app = createApp(root);
  app.api.newSession('expert');
  await app.api.setMark(17, CODE.asteroid, 'no');
  const offlineSave = storage.get('planetx.save.v3');
  const offlineNotes = storage.get('planetx.notes.v1');
  const press = async control => {
    assert.ok(control, 'expected a rendered tutorial control');
    fire(control, 'click');
    await new Promise(resolve => setImmediate(resolve));
  };
  const markedControl = target => findAll(root, element => element.tagName === 'button' && element.attributes['data-tutorial-target'] === target)[0];
  const sectorControl = sector => {
    const group = findAll(root, element => element.attributes['data-sector'] === sector)[0];
    return findAll(group, element => matches(element, '.wedge'))[0];
  };
  app.api.setUi({ playMode: 'tutorial', modal: { kind: 'start' } });
  await press(findButton(root, '开始双人教学'));
  assert.equal(app.state.game.playMode, 'builtin');
  assert.equal(app.state.game.initialClueCount, 4);
  const roomId = app.state.remote.roomId;
  const staleNext = findButton(root, '继续');
  await press(staleNext);
  const inspectedStep = app.state.game.tutorial.stepId;
  await press(staleNext);
  assert.equal(results.at(-1).result.ok, false, 'an old Next button cannot advance a different step');
  assert.equal(app.state.game.tutorial.stepId, inspectedStep);
  results.length = 0;
  let steps = 0;
  while (!app.state.game.tutorial.completed && steps < 80) {
    const tutorial = app.state.game.tutorial;
    const expected = tutorial.expected;
    const guide = findAll(root, element => matches(element, '.tutorial-guide'))[0];
    assert.equal(guide.parent.className, 'col-actions');
    assert.equal(guide.parent.children[0], guide, 'the guide precedes contextual actions');
    const conferences = findAll(root, element => matches(element, '.conferences-card'))[0];
    assert.equal(conferences.parent.className, 'col-info');
    if (tutorial.interaction === 'continue') await press(findButton(guide, tutorial.actor === 'bot' ? '观看 Bot' : tutorial.nextLabel));
    else if (tutorial.interaction === 'inspect') await press(sectorControl(expected.sector));
    else if (tutorial.interaction === 'mark') {
      const object = findAll(root, element => element.tagName === 'g' && element.attributes['data-tutorial-target'] === 'object')[0];
      await press(findAll(object, element => matches(element, '.icon-hit'))[0]);
      await press(markedControl('mark'));
    } else if (expected.kind === 'survey') {
      await press(findButton(root, '勘测'));
      await press(markedControl('type'));
      await press(sectorControl(expected.start));
      await press(sectorControl(mod(expected.start + expected.size - 1, app.state.game.mode.sectors)));
      await press(findButton(root, '确认勘测'));
    } else if (expected.kind === 'target') {
      await press(findButton(root, '扫描'));
      await press(sectorControl(expected.sector));
      await press(findButton(root, '确认扫描'));
    } else if (expected.kind === 'research') {
      await press(findButton(root, '研究'));
      await press(markedControl('topic'));
      await press(findButton(root, '确认研究'));
    } else if (expected.kind === 'research-declare') await press(markedControl('count'));
    else if (expected.kind === 'research-submit') {
      const select = findAll(root, element => element.tagName === 'select' && element.attributes['data-tutorial-target'] === 'sector')[0];
      fire(select, 'change', { target: { value: String(expected.sector) } });
      await press(markedControl('type'));
      await press(findButton(root, '确认提交'));
    } else if (expected.kind === 'locate') {
      await press(findButton(root, '尝试定位'));
      for (const [index, value] of [expected.sector, expected.left, expected.right].entries()) {
        const modal = findAll(root, element => matches(element, '.modal'))[0];
        const select = findAll(modal, element => element.tagName === 'select')[index];
        fire(select, 'change', { target: { value: String(value) } });
      }
      await press(findButton(root, '确认提交'));
    } else assert.fail(`unhandled human tutorial action: ${expected.kind}`);
    assert.notEqual(app.state.game.tutorial.stepId, tutorial.stepId, `the rendered controls complete ${tutorial.title}`);
    assert.equal(results.at(-1).result.ok, true, results.at(-1).result.error);
    steps += 1;
  }
  assert.ok(app.state.game.tutorial.completed);
  assert.equal(app.state.game.phase, 'done');
  assert.match(collectText(root).join(''), /最终积分/);
  assert.match(collectText(root).join(''), /公开棋盘/);
  assert.equal(app.state.game.revealedObjects.length, 12);
  assert.equal(storage.get('planetx.save.v3'), offlineSave);
  assert.equal(storage.get('planetx.notes.v1'), offlineNotes);
  await press(findButton(root, '重新教学'));
  assert.notEqual(app.state.remote.roomId, roomId);
  assert.equal(app.state.game.tutorial.completed, false);
  assert.notEqual(app.state.notes[`5:${CODE.planetX}`], 'yes');
  await press(findButton(root, '退出教学'));
  assert.equal(app.state.remote, null);
  assert.equal(app.state.game.mode.id, 'expert');
  assert.deepEqual(app.state.notes, { [`17:${CODE.asteroid}`]: 'no' });
});
