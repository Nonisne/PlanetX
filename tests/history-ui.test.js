import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLogPanel } from '../public/ui/panels.js';
import { GEOMETRY, renderBoard } from '../public/ui/board.js';
import { renderTheoriesPanel } from '../public/ui/notesheet.js';
import { modeById } from '../public/src/rules.js';
import { Obj } from '../public/src/types.js';
import { createConsole, recordLocate, revealObjects } from '../public/src/console.js';

function makeElement(tagName) {
  return {
    nodeType: 1,
    tagName,
    children: [],
    attributes: {},
    style: {},
    dataset: {},
    listeners: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
    get textContent() { return this.children.map(child => child.textContent).join(''); },
  };
}

globalThis.document = {
  createElement: makeElement,
  createElementNS: (namespace, tagName) => makeElement(tagName),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
};

function findAll(root, predicate) {
  if (!root || root.nodeType !== 1) return [];
  return [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => findAll(child, predicate))];
}

function withClass(root, className) {
  return findAll(root, element => (element.attributes.class || '').split(/\s+/).includes(className));
}

function fixture(log = [], overrides = {}) {
  return {
    mode: modeById('standard'),
    me: 'alpha',
    players: [
      { id: 'alpha', name: '阿甲', isMe: true, color: '#5eead4' },
      { id: 'beta', name: '阿乙', isMe: false, color: '#f5b942' },
      { id: 'gamma', name: '阿丙', isMe: false, color: '#7c9cff' },
    ],
    log,
    rounds: [],
    ...overrides,
  };
}

function render(game) {
  const state = { game, ui: { panels: {} } };
  const api = { setUiQuiet: patch => Object.assign(state.ui, patch) };
  return { state, api, panel: renderLogPanel({ state, api }) };
}

function clockBoard(mode, time, overrides = {}) {
  return renderBoard({
    game: { mode, time, knowledge: { targets: [] }, ...overrides },
    ui: {},
    notes: {},
    onSector: () => {},
  });
}

const turnEntries = [
  { id: 11, actorId: 'alpha', type: 'survey', start: 3, size: 3, surveyType: Obj.ASTEROID, count: 2, cost: 4, time: 8 },
  { id: 13, actorId: 'beta', type: 'research', topic: 'B', cost: 1, time: 0 },
  { id: 14, actorId: 'beta', type: 'target', sector: 6, cost: 4, time: 1 },
];

test('one chronological row per actual action, including consecutive actions by one player', () => {
  const game = fixture(turnEntries);
  const before = JSON.stringify(game);
  const { panel } = render(game);
  const rows = withClass(panel, 'history-row');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.attributes['data-history-id']), ['11', '13', '14']);
  assert.deepEqual(rows.map(row => row.attributes['data-actor-id']), ['alpha', 'beta', 'beta']);
  assert.equal(rows[1].children[1].textContent, '—');
  assert.ok(rows[1].children[2].textContent.includes('研究'));
  assert.equal(rows[1].children[3].textContent, '—');
  assert.equal(JSON.stringify(game), before);
});

test('stable player columns, own-column highlighting and no separate result column', () => {
  const game = fixture(turnEntries, { me: 'beta', players: fixture().players.map(player => ({ ...player, isMe: player.id === 'beta' })) });
  const { panel } = render(game);
  const headings = findAll(panel, element => element.tagName === 'th' && element.attributes.scope === 'col');
  assert.deepEqual(headings.map(heading => heading.textContent), ['顺序', '阿甲', '阿乙（我）', '阿丙']);
  assert.ok((headings[2].attributes.class || '').includes('history-mine'));
  assert.equal(headings.some(heading => heading.textContent === '操作结果'), false);
});

test('offline history has just the sequence and one player column', () => {
  const { panel } = render(fixture([{ ...turnEntries[0], actorId: undefined }], { me: undefined, players: undefined }));
  const headings = findAll(panel, element => element.tagName === 'th' && element.attributes.scope === 'col');
  assert.deepEqual(headings.map(heading => heading.textContent), ['顺序', '我']);
  assert.equal(withClass(panel, 'history-row')[0].children.length, 2);
  assert.ok(panel.textContent.includes('2 个'));
});

test('private fields from another actor never reach text or attributes, even in an unredacted fixture', () => {
  const game = fixture([
    { ...turnEntries[0], actorId: 'beta', count: 937 },
    { id: 2, actorId: 'beta', type: 'target', sector: 0, apparent: '秘密天体', cost: 4 },
    { id: 3, actorId: 'beta', type: 'research', topic: 'C', name: '秘密课题名称', text: '他人的秘密线索', cost: 1 },
    { id: 4, actorId: 'beta', type: 'theory', sector: 2, objectType: '未公开论文天体', review: 'pending', slot: 3, cost: 0 },
    { id: 5, actorId: 'beta', type: 'located', sector: 8, left: '秘密前邻', right: '秘密后邻', correct: false, cost: 5 },
    { id: 6, actorId: 'beta', type: 'mystery', private: { text: '秘密扩展字段' }, payload: '秘密载荷', cost: 0 },
  ]);
  const { panel } = render(game);
  const output = JSON.stringify(panel);
  for (const secret of ['937', '秘密天体', '秘密课题名称', '他人的秘密线索', '未公开论文天体', '秘密前邻', '秘密后邻', '秘密扩展字段', '秘密载荷']) {
    assert.equal(output.includes(secret), false, secret);
  }
  assert.ok(panel.textContent.includes('结果未公开'));
  assert.ok(panel.textContent.includes('扇区保密'));
});

test('own private results and publicly reviewed theories are available as expandable details', () => {
  const { panel } = render(fixture([
    { ...turnEntries[1], actorId: 'alpha', text: '我的完整研究线索' },
    { id: 22, actorId: 'beta', type: 'theory', sector: 7, objectType: Obj.GAS_CLOUD, revealed: true, review: 'correct', slot: 1, cost: 0 },
  ]));
  const details = withClass(panel, 'history-result');
  assert.equal(details.length, 2);
  assert.ok(panel.textContent.includes('我的完整研究线索'));
  assert.ok(panel.textContent.includes('气体云'));
  assert.ok(panel.textContent.includes('评审正确'));
  assert.ok(details.every(detail => detail.tagName === 'details' && detail.attributes.open === undefined));
});

test('another player’s locate remains private until the real endgame reveal makes it public', () => {
  const session = createConsole({ actorId: 'beta' });
  assert.equal(recordLocate(session, { sector: 8, left: Obj.GAS_CLOUD, right: Obj.DWARF_PLANET }).ok, true);
  const before = render(fixture(session.entries)).panel;
  assert.ok(before.textContent.includes('扇区保密'));
  assert.equal(before.textContent.includes('前邻：气体云'), false);

  const objects = Array(12).fill(Obj.EMPTY);
  objects[7] = Obj.GAS_CLOUD;
  objects[8] = Obj.PLANET_X;
  objects[9] = Obj.DWARF_PLANET;
  assert.equal(revealObjects(session, objects).ok, true);
  const after = render(fixture(session.entries)).panel;
  assert.ok(after.textContent.includes('定位 X行星 9 号'));
  assert.ok(after.textContent.includes('前邻：气体云；后邻：矮行星'));
  assert.equal(after.textContent.includes('扇区保密'), false);
});

test('conferences and review penalties are separate public-event rows spanning the players', () => {
  const { panel } = render(fixture([
    turnEntries[0],
    { id: 15, actorId: 'beta', type: 'conference', sector: 10, text: '公开会议线索', cost: 0 },
    { id: 16, actorId: 'gamma', type: 'penalty', sector: 4, theoryId: 8, cost: 1 },
  ]));
  const events = withClass(panel, 'history-event');
  assert.equal(events.length, 2);
  assert.equal(events[0].children[1].attributes.colspan, '3');
  assert.equal(events[1].children[1].attributes.colspan, '3');
  assert.ok(events[0].textContent.includes('公开会议线索'));
  assert.ok(events[1].textContent.includes('阿丙'));
  assert.ok(events[1].textContent.includes('评审'));
});

test('actual recorded cost is retained and only the newest row is highlighted', () => {
  const { panel } = render(fixture([{ ...turnEntries[0], cost: 2 }, turnEntries[1]]));
  const rows = withClass(panel, 'history-row');
  assert.ok(rows[0].textContent.includes('耗时 2 个时间单位'));
  assert.equal(withClass(panel, 'history-latest').length, 1);
  assert.ok((rows[1].attributes.class || '').includes('history-latest'));
  assert.ok(rows[1].textContent.includes('最新'));
});

test('history displays stored costs and clocks using each board’s time units and lap length', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const game = fixture([
      { id: 1, actorId: 'alpha', type: 'target', sector: 0, apparent: Obj.COMET, cost: 4, time: mode.sectors - 1 },
      { id: 2, actorId: 'alpha', type: 'research', topic: 'A', text: '自己的线索', cost: 1, time: mode.sectors },
      { id: 3, actorId: 'alpha', type: 'wait', cost: 2, time: mode.sectors + 1 },
      { id: 4, actorId: 'gamma', type: 'penalty', sector: 4, theoryId: 8, cost: 1, time: mode.sectors + 3 },
    ], { mode });
    const before = structuredClone(game);
    const { panel } = render(game);
    const rows = withClass(panel, 'history-row');
    assert.ok(rows[0].textContent.includes(`记录时棋子时间：第 1 圈／第 ${mode.sectors} 格`));
    assert.ok(rows[1].textContent.includes('记录时棋子时间：第 2 圈／第 1 格'));
    assert.ok(rows[0].textContent.includes('耗时 4 个时间单位'));
    assert.ok(rows[2].textContent.includes('等待 2 个时间单位'));
    assert.ok(rows[2].textContent.includes('耗时 2 个时间单位'));
    assert.ok(rows[3].textContent.includes('耗时 1 个时间单位'));
    assert.doesNotMatch(panel.textContent, /\d+\s*(?:年|个月|月)/);
    assert.deepEqual(game, before);
  }
});

test('board clocks and pawn durations use the displayed board’s lap length', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    for (const [units, expected] of [[mode.sectors - 1, `第 1 圈／第 ${mode.sectors} 格`], [mode.sectors, '第 2 圈／第 1 格']]) {
      const board = clockBoard(mode, units, {
        players: [{ id: 'alpha', name: '阿甲', color: '#5eead4', sector: units % mode.sectors + 1, time: units, isMe: true, isTurn: true }],
      });
      assert.equal(withClass(board, 'hub-time')[0].textContent, expected);
      const pawnTitle = findAll(withClass(board, 'pawn')[0], element => element.tagName === 'title')[0];
      assert.ok(pawnTitle.textContent.includes(`已用 ${units} 个时间单位`));
      assert.doesNotMatch(board.textContent, /\d+\s*(?:年|个月|月)/);
    }
  }
});

test('displayed personal clocks leave Earth on the shared visible window’s orbital midpoint', () => {
  for (const modeId of ['standard', 'expert']) {
    const mode = modeById(modeId);
    const visibleStart = mode.sectors - 2;
    const sharedWindow = {
      visibleStart,
      visible: Array.from({ length: mode.visible }, (unused, offset) => (visibleStart + offset) % mode.sectors),
    };
    const first = withClass(clockBoard(mode, 0, sharedWindow), 'earth-marker')[0];
    const later = withClass(clockBoard(mode, mode.sectors + 4, sharedWindow), 'earth-marker')[0];
    assert.equal(later.attributes.transform, first.attributes.transform);
    assert.equal(later.attributes['aria-label'], first.attributes['aria-label']);
    const coordinates = first.attributes.transform.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    assert.ok(coordinates);
    const angle = (-90 + (visibleStart + (mode.visible - 1) / 2) * 360 / mode.sectors) * Math.PI / 180;
    assert.ok(Math.abs(Number(coordinates[1]) - GEOMETRY.CX - Math.cos(angle) * GEOMETRY.R_EARTH_ORBIT) < 0.001);
    assert.ok(Math.abs(Number(coordinates[2]) - GEOMETRY.CY - Math.sin(angle) * GEOMETRY.R_EARTH_ORBIT) < 0.001);
    const initialOrbit = withClass(clockBoard(mode, 0), 'earth-marker')[0].attributes.transform;
    assert.equal(withClass(clockBoard(mode, mode.sectors), 'earth-marker')[0].attributes.transform, initialOrbit);
    assert.notEqual(withClass(clockBoard(mode, 1), 'earth-marker')[0].attributes.transform, initialOrbit);
  }
});

test('theory review tooltip describes the unchanged one-unit penalty', () => {
  const game = fixture([], {
    status: 'open',
    knowledge: { theories: [{ id: 7, actorId: 'alpha', sector: 2, objectType: Obj.COMET, review: 'pending', slot: 1 }] },
  });
  const state = { game, ui: { panels: {} } };
  const reviews = [];
  const panel = renderTheoriesPanel({
    game,
    state,
    api: { setUiQuiet: patch => Object.assign(state.ui, patch) },
    onReview: (theoryId, verdict) => reviews.push({ theoryId, verdict }),
  });
  const wrong = withClass(panel, 'review-bad')[0];
  assert.equal(wrong.attributes.title, 'app 说这篇错误：罚 1 个时间单位');
  for (const listener of wrong.listeners.click || []) listener();
  assert.deepEqual(reviews, [{ theoryId: 7, verdict: 'wrong' }]);
});

test('historical actors absent from the current roster retain their own column', () => {
  const { panel } = render(fixture([{ ...turnEntries[0], actorId: 'former' }]));
  const headings = findAll(panel, element => element.tagName === 'th' && element.attributes.scope === 'col');
  assert.equal(headings.length, 5);
  assert.ok(headings[4].textContent.includes('未命名玩家'));
  assert.ok(withClass(panel, 'history-row')[0].children[4].textContent.includes('勘测'));
});

test('history uses a caption, row headers and a keyboard-scrollable region', () => {
  const { panel } = render(fixture(turnEntries));
  assert.equal(findAll(panel, element => element.tagName === 'caption').length, 1);
  assert.equal(findAll(panel, element => element.tagName === 'th' && element.attributes.scope === 'row').length, 3);
  const region = withClass(panel, 'history-table-wrap')[0];
  assert.equal(region?.attributes.role, 'region');
  assert.equal(region?.attributes.tabindex, '0');
});

test('expanding the history survives the next render without an action or rerender side effect', () => {
  const harness = render(fixture(turnEntries));
  assert.equal(harness.panel.tagName, 'details');
  harness.panel.open = true;
  for (const listener of harness.panel.listeners.toggle || []) listener({ currentTarget: harness.panel, target: harness.panel });
  assert.equal(harness.state.ui.panels.history, true);
  const next = renderLogPanel(harness);
  assert.equal(next.attributes.open, '');
});

test('disclosure close and interleaved result toggles preserve preferences and ignore detached events', () => {
  const harness = render(fixture(turnEntries));
  const result = withClass(harness.panel, 'history-result')[0];
  const toggle = (element, open, connected = true) => {
    element.open = open;
    element.isConnected = connected;
    for (const listener of element.listeners.toggle || []) listener({ currentTarget: element });
  };
  toggle(harness.panel, true);
  toggle(result, true);
  toggle(harness.panel, false);
  assert.equal(harness.state.ui.panels.history, false);
  assert.equal(harness.state.ui.panels['history-result-11'], true);
  toggle(result, false, false);
  assert.equal(harness.state.ui.panels['history-result-11'], true);
  const next = renderLogPanel(harness);
  assert.equal(next.attributes.open, undefined);
  const nextResult = withClass(next, 'history-result')[0];
  assert.equal(nextResult.attributes.open, '');
  toggle(nextResult, false);
  assert.equal(harness.state.ui.panels['history-result-11'], false);
});

test('an empty history has a useful state and no fabricated action row', () => {
  const { panel } = render(fixture());
  assert.ok(panel.textContent.includes('还没有行动'));
  assert.equal(withClass(panel, 'history-row').length, 0);
});
