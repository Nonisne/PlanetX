import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderEndgame } from '../public/ui/endgame.js';
import { LABEL, Obj, THEORY_TYPES } from '../public/src/types.js';
import { scoreWinners } from '../public/src/score.js';

function makeElement(tagName) {
  return {
    nodeType: 1,
    tagName,
    children: [],
    attributes: {},
    listeners: {},
    append(...children) {
      this.children.push(...children);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    addEventListener(name, listener) {
      (this.listeners[name] ||= []).push(listener);
    },
    get textContent() {
      return this.children.map((child) => child.textContent).join('');
    },
    get value() {
      if (this.inputValue !== undefined) return this.inputValue;
      if (this.tagName !== 'select') return this.attributes.value || '';
      const selected = this.children.find((child) => child.attributes.selected !== undefined) || this.children[0];
      return selected?.attributes.value || '';
    },
    set value(value) {
      this.inputValue = String(value);
    },
    get disabled() {
      return this.attributes.disabled !== undefined;
    },
  };
}

const previousDocument = globalThis.document;
globalThis.document = {
  createElement: makeElement,
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
};
after(() => {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
});

function findAll(root, predicate) {
  if (!root || root.nodeType !== 1) return [];
  return [
    ...(predicate(root) ? [root] : []),
    ...root.children.flatMap((child) => findAll(child, predicate)),
  ];
}

function select(root, label) {
  const matches = findAll(root, (element) => element.tagName === 'select' && element.attributes['aria-label'] === label);
  assert.equal(matches.length, 1, `Expected one select named ${label}`);
  return matches[0];
}

function button(root, label) {
  const matches = findAll(root, (element) => element.tagName === 'button' && element.textContent === label);
  assert.equal(matches.length, 1, `Expected one button named ${label}`);
  return matches[0];
}

function fire(element, eventName, value) {
  if (value !== undefined) element.value = value;
  for (const listener of element.listeners[eventName] || []) listener({ target: element });
}

function gameFixture(overrides = {}) {
  const sectors = overrides.mode?.sectors || 12;
  return {
    phase: 'final',
    status: 'open',
    mode: { sectors: 12 },
    me: 'second',
    amHost: false,
    theoryOptions: Array.from({ length: sectors }, (unused, sector) => ({ sector, types: THEORY_TYPES.filter((objectType) => objectType !== Obj.COMET || [2, 3, 5, 7, 11, 13, 17].includes(sector + 1)) })),
    ...overrides,
    endgame: {
      firstFinderName: '星河',
      cursorId: 'second',
      cursorName: '月光',
      isMyTurn: true,
      behind: 4,
      quota: 2,
      canReveal: false,
      players: [
        { id: 'first', name: '星河', behind: 0, quota: 0, done: true, choice: 'locate' },
        { id: 'second', name: '月光', behind: 4, quota: 2, done: false, choice: null },
      ],
      ...overrides.endgame,
    },
  };
}

function harness(game = gameFixture(), ui = {}) {
  const view = {
    game,
    ui,
    actions: [],
    patches: [],
    locateCalls: 0,
    render(nextGame = this.game) {
      this.game = nextGame;
      this.root = renderEndgame({ game: this.game, ui: this.ui, api });
      return this.root;
    },
  };
  const api = {
    setUi(patch) {
      view.patches.push(patch);
      view.ui = { ...view.ui, ...patch };
      view.render();
    },
    openLocate() {
      view.locateCalls += 1;
    },
    consoleAction(action) {
      view.actions.push(action);
    },
  };
  view.render();
  return view;
}

function scoresFixture() {
  return {
    finished: true,
    rows: [
      { id: 'first', name: '星河', total: 7, theoryPoints: 4, leaderBonus: 1, locatePoints: 2, correctTheories: 1 },
      { id: 'second', name: '月光', total: 12, theoryPoints: 8, leaderBonus: 2, locatePoints: 2, correctTheories: 2 },
      { id: 'third', name: '银河', total: 12, theoryPoints: 8, leaderBonus: 2, locatePoints: 2, correctTheories: 2 },
    ],
  };
}

test('unrelated phases return null and online phase takes precedence over solo status', () => {
  for (const phase of ['lobby', 'setup', 'open', 'playing', 'research', 'unknown']) {
    const view = harness(gameFixture({ phase, status: 'finished' }));
    assert.equal(view.root, null);
    assert.deepEqual(view.patches, []);
    assert.deepEqual(view.actions, []);
  }
  assert.equal(harness({ status: 'open' }).root, null);
});

test('non-acting players only wait, even when they are the host or match the cursor', () => {
  for (const amHost of [false, true]) {
    const game = gameFixture({ amHost, endgame: { isMyTurn: false } });
    const ui = Object.freeze({ finalTheories: [{ sector: 0, objectType: Obj.COMET }] });
    const view = harness(game, ui);
    assert.match(view.root.textContent, /最后机会/);
    assert.match(view.root.textContent, /星河/);
    assert.match(view.root.textContent, /等待.*月光/);
    assert.equal(findAll(view.root, (element) => ['button', 'select', 'input'].includes(element.tagName)).length, 0);
    assert.deepEqual(view.patches, []);
    assert.deepEqual(view.actions, []);
  }
});

test('final opportunity explains the quota, unchanged pawns and private locate answer', () => {
  const view = harness();
  assert.match(view.root.textContent, /落后\s*4\s*格/);
  assert.match(view.root.textContent, /最多\s*2\s*篇/);
  assert.match(view.root.textContent, /不会移动棋子/);
  assert.match(view.root.textContent, /定位答案.*保密/);
  fire(button(view.root, '尝试定位 X行星'), 'click');
  assert.equal(view.locateCalls, 1);
  assert.deepEqual(view.actions, []);
  fire(button(view.root, '放弃最后机会'), 'click');
  assert.deepEqual(view.actions, [{ kind: 'final-pass' }]);
});

test('theory count offers zero through quota and zero theories submit atomically', () => {
  const view = harness();
  const count = select(view.root, '最终理论数量');
  assert.deepEqual(count.children.map((option) => option.attributes.value), ['0', '1', '2']);
  assert.equal(count.value, '0');
  assert.equal(button(view.root, '提交最终理论').disabled, false);
  fire(button(view.root, '提交最终理论'), 'click');
  assert.deepEqual(view.actions, [{ kind: 'final-theories', theories: [] }]);
});

test('zero quota still permits locate, zero theories and pass without theory fields', () => {
  const view = harness(gameFixture({ endgame: { behind: 0, quota: 0 } }));
  assert.deepEqual(select(view.root, '最终理论数量').children.map((option) => option.attributes.value), ['0']);
  assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, 1);
  fire(button(view.root, '尝试定位 X行星'), 'click');
  fire(button(view.root, '提交最终理论'), 'click');
  fire(button(view.root, '放弃最后机会'), 'click');
  assert.equal(view.locateCalls, 1);
  assert.deepEqual(view.actions, [{ kind: 'final-theories', theories: [] }, { kind: 'final-pass' }]);
});

test('new theory fields start blank and incomplete theories cannot submit', () => {
  const view = harness();
  fire(select(view.root, '最终理论数量'), 'change', '1');
  assert.deepEqual(view.patches, [{ finalTheories: [{ sector: '', objectType: '' }] }]);
  assert.equal(select(view.root, '理论 1 扇区').value, '');
  assert.equal(select(view.root, '理论 1 天体').value, '');
  assert.deepEqual(select(view.root, '理论 1 天体').children.map((option) => option.attributes.value), ['']);
  assert.equal(select(view.root, '理论 1 天体').disabled, true);
  assert.equal(button(view.root, '提交最终理论').disabled, true);
  fire(button(view.root, '提交最终理论'), 'click');
  fire(select(view.root, '理论 1 扇区'), 'change', '1');
  assert.equal(button(view.root, '提交最终理论').disabled, true);
  fire(button(view.root, '提交最终理论'), 'click');
  assert.deepEqual(view.actions, []);
  fire(select(view.root, '理论 1 扇区'), 'change', '');
  assert.equal(view.ui.finalTheories[0].sector, '');
});

test('two theories retain independent drafts and submit exactly one zero-based payload', () => {
  const view = harness();
  fire(select(view.root, '最终理论数量'), 'change', '2');
  fire(select(view.root, '理论 1 扇区'), 'change', '1');
  fire(select(view.root, '理论 1 天体'), 'change', Obj.COMET);
  fire(select(view.root, '理论 2 扇区'), 'change', '11');
  fire(select(view.root, '理论 2 天体'), 'change', Obj.GAS_CLOUD);
  const theories = [{ sector: 1, objectType: Obj.COMET }, { sector: 11, objectType: Obj.GAS_CLOUD }];
  assert.deepEqual(view.ui.finalTheories, theories);
  assert.equal(button(view.root, '提交最终理论').disabled, false);
  assert.equal(select(view.root, '理论 1 扇区').value, '1');
  assert.equal(select(view.root, '理论 2 扇区').value, '11');
  assert.deepEqual(view.actions, []);
  fire(button(view.root, '提交最终理论'), 'click');
  assert.deepEqual(view.actions, [{ kind: 'final-theories', theories }]);
  assert.notStrictEqual(view.actions[0].theories, view.ui.finalTheories);
  assert.notStrictEqual(view.actions[0].theories[0], view.ui.finalTheories[0]);
});

test('theory drafts update through setUi without mutating the supplied UI or game', () => {
  const theory = Object.freeze({ sector: 2, objectType: Obj.ASTEROID });
  const draft = Object.freeze([theory]);
  const ui = Object.freeze({ finalTheories: draft, anotherDraft: 'keep me' });
  const game = gameFixture();
  const originalGame = structuredClone(game);
  const view = harness(game, ui);
  assert.deepEqual(view.patches, []);
  fire(select(view.root, '理论 1 天体'), 'change', Obj.COMET);
  assert.deepEqual(view.patches, [{ finalTheories: [{ sector: 2, objectType: Obj.COMET }] }]);
  assert.equal(theory.objectType, Obj.ASTEROID);
  assert.equal(view.ui.anotherDraft, 'keep me');
  assert.deepEqual(game, originalGame);
  fire(select(view.root, '最终理论数量'), 'change', '2');
  assert.deepEqual(view.ui.finalTheories, [{ sector: 2, objectType: Obj.COMET }, { sector: '', objectType: '' }]);
  fire(select(view.root, '最终理论数量'), 'change', '1');
  assert.deepEqual(view.ui.finalTheories, [{ sector: 2, objectType: Obj.COMET }]);
});

test('theory sector choices cover the full 12-sector or 18-sector board', () => {
  for (const sectors of [12, 18]) {
    const view = harness(gameFixture({ mode: { sectors } }));
    fire(select(view.root, '最终理论数量'), 'change', '1');
    const field = select(view.root, '理论 1 扇区');
    assert.equal(field.children.length, sectors + 1);
    assert.equal(field.children[0].attributes.value, '');
    assert.equal(field.children[sectors].attributes.value, String(sectors - 1));
    assert.match(field.children[sectors].textContent, new RegExp(`${sectors} 号`));
  }
});

test('final theory choices use only server-provided sectors and each sector’s ordinary object types', () => {
  const view = harness(gameFixture({ theoryOptions: [{ sector: 1, types: [Obj.GAS_CLOUD] }, { sector: 4, types: [Obj.COMET, Obj.DWARF_PLANET] }] }));
  fire(select(view.root, '最终理论数量'), 'change', '1');
  assert.deepEqual(select(view.root, '理论 1 扇区').children.map((option) => option.attributes.value), ['', '1', '4']);
  assert.ok(select(view.root, '理论 1 扇区').children.every((option) => !option.disabled));
  assert.doesNotMatch(select(view.root, '理论 1 扇区').textContent, /已公开/);
  fire(select(view.root, '理论 1 扇区'), 'change', '1');
  assert.deepEqual(select(view.root, '理论 1 天体').children.map((option) => option.attributes.value), ['', Obj.GAS_CLOUD]);
  fire(select(view.root, '理论 1 天体'), 'change', Obj.GAS_CLOUD);
  assert.equal(button(view.root, '提交最终理论').disabled, false);
  fire(select(view.root, '理论 1 扇区'), 'change', '4');
  assert.equal(view.ui.finalTheories[0].objectType, '', 'changing sector clears an ineligible object instead of silently submitting it');
  assert.deepEqual(select(view.root, '理论 1 天体').children.map((option) => option.attributes.value), ['', Obj.COMET, Obj.DWARF_PLANET]);
  assert.equal(button(view.root, '提交最终理论').disabled, true);
});

test('final theory row count is capped by available distinct sectors, including no remaining sectors', () => {
  for (const available of [[], [{ sector: 1, types: [Obj.ASTEROID] }]]) {
    const view = harness(gameFixture({ theoryOptions: available }));
    assert.deepEqual(select(view.root, '最终理论数量').children.map((option) => Number(option.attributes.value)), Array.from({ length: available.length + 1 }, (unused, count) => count));
    fire(select(view.root, '最终理论数量'), 'change', '2');
    assert.deepEqual(view.patches, [], 'a stale count cannot exceed available sectors');
    fire(button(view.root, '提交最终理论'), 'click');
    assert.deepEqual(view.actions, [{ kind: 'final-theories', theories: [] }]);
  }
});

test('final theory rows omit sectors used by another draft and reject duplicates or stale server options', () => {
  const game = gameFixture({ theoryOptions: [{ sector: 1, types: [Obj.ASTEROID, Obj.COMET] }, { sector: 4, types: [Obj.GAS_CLOUD] }] });
  const view = harness(game, { finalTheories: [{ sector: 1, objectType: Obj.COMET }, { sector: '', objectType: '' }] });
  assert.deepEqual(select(view.root, '理论 2 扇区').children.map((option) => option.attributes.value), ['', '4']);
  for (const finalTheories of [
    [{ sector: 1, objectType: Obj.COMET }, { sector: 1, objectType: Obj.ASTEROID }],
    [{ sector: 4, objectType: Obj.COMET }],
    [{ sector: 8, objectType: Obj.ASTEROID }],
  ]) {
    const invalid = harness(game, { finalTheories });
    assert.equal(button(invalid.root, '提交最终理论').disabled, true);
    fire(button(invalid.root, '提交最终理论'), 'click');
    assert.deepEqual(invalid.actions, []);
  }
  const stale = harness(gameFixture({ theoryOptions: [] }), { finalTheories: [{ sector: 1, objectType: Obj.COMET }] });
  assert.equal(button(stale.root, '提交最终理论').disabled, true);
  assert.deepEqual(select(stale.root, '理论 1 扇区').children.map((option) => option.attributes.value), ['']);
});

test('solo final status renders the same final controls', () => {
  const view = harness(gameFixture({ phase: undefined, status: 'final', me: undefined }));
  assert.match(view.root.textContent, /最后机会/);
  fire(button(view.root, '尝试定位 X行星'), 'click');
  assert.equal(view.locateCalls, 1);
});

test('authorized reveal has exactly 12 or 18 blank fields offering all six labeled objects', () => {
  for (const sectors of [12, 18]) {
    const game = gameFixture({ phase: 'reveal', mode: { sectors }, amHost: true, endgame: { canReveal: true } });
    const view = harness(game);
    assert.match(view.root.textContent, /揭示棋盘/);
    assert.match(view.root.textContent, /全部.*扇区/);
    assert.match(view.root.textContent, /恰好.*1.*X行星/);
    assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, sectors);
    for (let sector = 0; sector < sectors; sector += 1) {
      const field = select(view.root, `${sector + 1} 号扇区`);
      assert.equal(field.value, '');
      assert.equal(field.children[0].attributes.value, '');
      assert.equal(field.children[0].attributes.selected, '');
      assert.deepEqual(field.children.slice(1).map((option) => option.attributes.value).sort(), Object.values(Obj).sort());
      for (const option of field.children.slice(1)) assert.equal(option.textContent, LABEL[option.attributes.value]);
    }
    assert.equal(button(view.root, '提交揭示结果').disabled, true);
    assert.deepEqual(view.patches, []);
    assert.deepEqual(view.actions, []);
    assert.equal(view.ui.revealObjects, undefined);
  }
});

test('nonhosts and viewers without reveal permission only see waiting, never drafts', () => {
  const cases = [
    { amHost: false, canReveal: false },
    { amHost: false, canReveal: true },
    { amHost: true, canReveal: false },
  ];
  for (const { amHost, canReveal } of cases) {
    const game = gameFixture({ phase: 'reveal', amHost, endgame: { canReveal } });
    const view = harness(game, { revealObjects: Array(12).fill(Obj.GAS_CLOUD) });
    assert.match(view.root.textContent, /等待/);
    assert.doesNotMatch(view.root.textContent, /气体云/);
    assert.equal(findAll(view.root, (element) => ['select', 'input', 'button'].includes(element.tagName)).length, 0);
    assert.deepEqual(view.patches, []);
    assert.deepEqual(view.actions, []);
  }
});

test('solo reveal uses status and still requires canReveal', () => {
  for (const canReveal of [false, true]) {
    const game = gameFixture({ phase: undefined, status: 'reveal', amHost: false, me: undefined, endgame: { canReveal } });
    const view = harness(game);
    assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, canReveal ? 12 : 0);
    if (!canReveal) assert.match(view.root.textContent, /等待/);
  }
});

test('missing, sparse and unknown reveal entries stay blank instead of becoming empty sectors', () => {
  const sparse = Array(12);
  sparse[11] = Obj.PLANET_X;
  const unknown = Array(12).fill(Obj.EMPTY);
  unknown[0] = 'unknown';
  unknown[11] = Obj.PLANET_X;
  const drafts = [[Obj.PLANET_X], sparse, unknown];
  for (const revealObjects of drafts) {
    const view = harness(gameFixture({ phase: 'reveal', amHost: true, endgame: { canReveal: true } }), { revealObjects });
    const blankSector = revealObjects[0] === Obj.PLANET_X ? 1 : 0;
    const field = select(view.root, `${blankSector + 1} 号扇区`);
    assert.equal(field.value, '');
    assert.equal(field.children[0].attributes.selected, '');
    assert.equal(button(view.root, '提交揭示结果').disabled, true);
    fire(button(view.root, '提交揭示结果'), 'click');
    assert.deepEqual(view.actions, []);
  }
});

test('fully filled reveal requires exactly one Planet X, not zero or two', () => {
  for (const planetCount of [0, 2]) {
    const revealObjects = Array(12).fill(Obj.EMPTY);
    revealObjects.fill(Obj.PLANET_X, 0, planetCount);
    const view = harness(gameFixture({ phase: 'reveal', amHost: true, endgame: { canReveal: true } }), { revealObjects });
    assert.equal(button(view.root, '提交揭示结果').disabled, true);
    fire(button(view.root, '提交揭示结果'), 'click');
    assert.deepEqual(view.actions, []);
  }
});

test('choosing every sector sends one exact reveal-objects payload for either board size', () => {
  for (const sectors of [12, 18]) {
    const view = harness(gameFixture({ phase: 'reveal', mode: { sectors }, amHost: true, endgame: { canReveal: true } }));
    const otherObjects = [...THEORY_TYPES, Obj.EMPTY];
    const objects = Array.from({ length: sectors }, (unused, sector) => sector === sectors - 1 ? Obj.PLANET_X : otherObjects[sector % otherObjects.length]);
    for (let sector = 0; sector < sectors; sector += 1) {
      assert.equal(button(view.root, '提交揭示结果').disabled, true);
      fire(select(view.root, `${sector + 1} 号扇区`), 'change', objects[sector]);
    }
    assert.deepEqual(view.ui.revealObjects, objects);
    assert.equal(button(view.root, '提交揭示结果').disabled, false);
    assert.deepEqual(view.actions, []);
    fire(button(view.root, '提交揭示结果'), 'click');
    assert.deepEqual(view.actions, [{ kind: 'reveal-objects', objects }]);
    assert.notStrictEqual(view.actions[0].objects, view.ui.revealObjects);
    fire(select(view.root, '1 号扇区'), 'change', '');
    assert.equal(view.ui.revealObjects[0], '');
    assert.equal(button(view.root, '提交揭示结果').disabled, true);
    fire(button(view.root, '提交揭示结果'), 'click');
    assert.equal(view.actions.length, 1);
    assert.deepEqual(view.actions[0].objects, objects);
  }
});

test('reveal edits only replace the UI draft and preserve explicitly selected empty sectors', () => {
  const draft = Object.freeze([Obj.PLANET_X, Obj.EMPTY]);
  const ui = Object.freeze({ revealObjects: draft, finalTheories: [] });
  const game = gameFixture({ phase: 'reveal', amHost: true, endgame: { canReveal: true } });
  const originalGame = structuredClone(game);
  const view = harness(game, ui);
  assert.equal(select(view.root, '2 号扇区').value, Obj.EMPTY);
  fire(select(view.root, '3 号扇区'), 'change', Obj.COMET);
  const expected = [Obj.PLANET_X, Obj.EMPTY, Obj.COMET, ...Array(9).fill('')];
  assert.deepEqual(view.patches, [{ revealObjects: expected }]);
  assert.deepEqual(draft, [Obj.PLANET_X, Obj.EMPTY]);
  assert.strictEqual(view.ui.finalTheories, ui.finalTheories);
  assert.deepEqual(game, originalGame);
});

test('online and solo finished aliases show final scores and every tied winner without controls', () => {
  const states = [
    { phase: 'done', status: 'final' },
    { phase: 'finished' },
    { phase: undefined, status: 'done' },
    { phase: undefined, status: 'finished' },
  ];
  for (const state of states) {
    const scores = scoresFixture();
    const originalScores = structuredClone(scores);
    const view = harness(gameFixture({ ...state, scores }));
    assert.match(view.root.textContent, /本局已结束/);
    assert.match(view.root.textContent, /最终积分/);
    const winners = findAll(view.root, (element) => element.tagName === 'p' && element.textContent.startsWith('获胜：'));
    assert.equal(winners.length, 1);
    assert.equal(winners[0].textContent, `获胜：${scoreWinners(scores).map((row) => row.name).join('、')}`);
    assert.match(winners[0].textContent, /月光、银河/);
    assert.doesNotMatch(winners[0].textContent, /星河/);
    const rows = findAll(view.root, (element) => element.tagName === 'li');
    assert.deepEqual(rows.map((row) => row.textContent), ['星河 · 7 分', '月光 · 12 分', '银河 · 12 分']);
    assert.equal(findAll(view.root, (element) => ['button', 'input', 'select'].includes(element.tagName)).length, 0);
    assert.deepEqual(scores, originalScores);
    assert.deepEqual(view.patches, []);
    assert.deepEqual(view.actions, []);
  }
});

test('finished objects use the public board and LABEL rather than a private reveal draft', () => {
  const revealedObjects = [Obj.PLANET_X, ...THEORY_TYPES, ...Array(7).fill(Obj.EMPTY)];
  const view = harness(gameFixture({ phase: 'done', scores: scoresFixture(), revealedObjects }), { revealObjects: Array(12).fill(Obj.EMPTY) });
  assert.match(view.root.textContent, /公开棋盘/);
  const sectors = findAll(view.root, (element) => element.attributes.class?.split(' ').includes('chip-type'));
  assert.deepEqual(sectors.map((sector) => sector.textContent), revealedObjects.map((objectType, sector) => `${sector + 1} 号 · ${LABEL[objectType]}`));
  assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, 0);
});

test('finished winner selection follows scoreWinners for a single winner and zero scores', () => {
  const singleWinner = scoresFixture();
  singleWinner.rows.pop();
  const zeroScores = { rows: [{ id: 'first', name: '星河', total: 0, correctTheories: 0, locatePoints: 0 }] };
  for (const scores of [singleWinner, zeroScores]) {
    const view = harness(gameFixture({ phase: 'done', scores }));
    const winners = scoreWinners(scores);
    const expected = winners.length ? `获胜：${winners.map((row) => row.name).join('、')}` : '暂无获胜者';
    assert.ok(findAll(view.root, (element) => element.tagName === 'p').some((element) => element.textContent === expected));
  }
});

test('finished views without scores or revealed objects show a compact result', () => {
  for (const scores of [undefined, { rows: [] }]) {
    const view = harness(gameFixture({ phase: 'done', scores }));
    assert.match(view.root.textContent, /本局已结束/);
    assert.match(view.root.textContent, /暂无积分记录/);
    assert.doesNotMatch(view.root.textContent, /undefined|NaN/);
    assert.equal(findAll(view.root, (element) => ['button', 'select'].includes(element.tagName)).length, 0);
  }
});

test('phase and permission transitions replace controls without mutating or submitting UI drafts', () => {
  const ui = Object.freeze({
    finalTheories: Object.freeze([Object.freeze({ sector: 1, objectType: Obj.COMET })]),
    revealObjects: Object.freeze([Obj.PLANET_X, ...Array(11).fill(Obj.EMPTY)]),
  });
  const view = harness(gameFixture(), ui);
  assert.equal(select(view.root, '理论 1 天体').value, Obj.COMET);
  view.render(gameFixture({ endgame: { isMyTurn: false, cursorId: 'third', cursorName: '银河' } }));
  assert.match(view.root.textContent, /等待.*银河/);
  assert.equal(findAll(view.root, (element) => ['button', 'select'].includes(element.tagName)).length, 0);
  view.render(gameFixture({ phase: 'reveal', endgame: { canReveal: true } }));
  assert.match(view.root.textContent, /等待/);
  assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, 0);
  view.render(gameFixture({ phase: 'reveal', amHost: true, endgame: { canReveal: true } }));
  assert.equal(select(view.root, '1 号扇区').value, Obj.PLANET_X);
  assert.equal(button(view.root, '提交揭示结果').disabled, false);
  view.render(gameFixture({ phase: 'done', scores: scoresFixture(), revealedObjects: ui.revealObjects }));
  assert.match(view.root.textContent, /本局已结束/);
  assert.equal(findAll(view.root, (element) => ['button', 'select'].includes(element.tagName)).length, 0);
  view.render(gameFixture({ phase: 'open', status: 'finished' }));
  assert.equal(view.root, null);
  assert.strictEqual(view.ui, ui);
  assert.deepEqual(view.patches, []);
  assert.deepEqual(view.actions, []);
});

test('invalid theory count changes cannot exceed quota or silently clear the draft', () => {
  for (const count of ['', '-1', '1.5', '3', 'unknown']) {
    const ui = { finalTheories: [{ sector: 0, objectType: Obj.COMET }] };
    const view = harness(gameFixture(), ui);
    fire(select(view.root, '最终理论数量'), 'change', count);
    assert.deepEqual(view.patches, [], `Invalid count ${count} must be ignored`);
    assert.strictEqual(view.ui, ui);
    assert.deepEqual(view.actions, []);
  }
});

test('invalid or over-quota theory drafts never submit, including non-theory object types', () => {
  const invalidDrafts = [
    [{ sector: '', objectType: Obj.COMET }],
    [{ sector: '0', objectType: Obj.COMET }],
    [{ sector: -1, objectType: Obj.COMET }],
    [{ sector: 12, objectType: Obj.COMET }],
    [{ sector: 0.5, objectType: Obj.COMET }],
    [{ sector: 0, objectType: Obj.EMPTY }],
    [{ sector: 0, objectType: Obj.PLANET_X }],
    [{ sector: 0, objectType: 'unknown' }],
    [undefined],
    Array.from({ length: 3 }, (unused, sector) => ({ sector, objectType: Obj.COMET })),
  ];
  for (const finalTheories of invalidDrafts) {
    const view = harness(gameFixture(), { finalTheories });
    assert.equal(button(view.root, '提交最终理论').disabled, true);
    fire(button(view.root, '提交最终理论'), 'click');
    assert.deepEqual(view.actions, []);
  }
});

test('waiting views do not reveal private locate answers or a board before finished', () => {
  for (const phase of ['final', 'reveal']) {
    const view = harness(gameFixture({
      phase,
      locate: { sector: 8, left: Obj.GAS_CLOUD, right: Obj.DWARF_PLANET },
      revealedObjects: Array(12).fill(Obj.GAS_CLOUD),
      endgame: { isMyTurn: false, canReveal: false },
    }));
    assert.doesNotMatch(view.root.textContent, /9 号|气体云|矮行星/);
    assert.equal(findAll(view.root, (element) => element.tagName === 'select').length, 0);
    assert.deepEqual(view.actions, []);
  }
});

test('all sidecar classes already exist in the shared stylesheet', () => {
  const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  const games = [
    gameFixture(),
    gameFixture({ endgame: { isMyTurn: false } }),
    gameFixture({ phase: 'reveal', amHost: true, endgame: { canReveal: true } }),
    gameFixture({ phase: 'reveal' }),
    gameFixture({ phase: 'done', scores: scoresFixture(), revealedObjects: [Obj.PLANET_X] }),
  ];
  for (const game of games) {
    const elements = findAll(harness(game).root, (element) => Boolean(element.attributes.class));
    for (const element of elements) {
      for (const className of element.attributes.class.split(/\s+/)) {
        assert.match(styles, new RegExp(`\\.${className}(?![\\w-])`), `Missing existing CSS class: ${className}`);
      }
    }
  }
});
