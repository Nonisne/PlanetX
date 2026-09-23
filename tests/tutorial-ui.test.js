import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createConsole, consoleView } from '../public/src/console.js';
import { createRoom, addPlayer, applyRoomAction, viewFor } from '../public/src/room.js';
import { CODE, Obj } from '../public/src/types.js';
import { isCometSector } from '../public/src/rules.js';
import { renderActionPanel, renderKnowledgePanel, renderMapPanel, renderModal, renderStatus } from '../public/ui/panels.js';
import { renderBoard } from '../public/ui/board.js';
import * as notesheet from '../public/ui/notesheet.js';

function makeElement(tagName) {
  return {
    nodeType: 1,
    tagName,
    children: [],
    attributes: {},
    listeners: {},
    style: {},
    dataset: {},
    className: '',
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') this.className = String(value);
    },
    getAttribute(name) { return this.attributes[name]; },
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); },
  };
}

globalThis.document = {
  createElement: makeElement,
  createElementNS: (namespace, tagName) => makeElement(tagName),
  createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
};

function elements(root, predicate) {
  if (!root) return [];
  return [root, ...(root.children || []).flatMap(child => elements(child, () => true))].filter(predicate);
}

function textOf(root) {
  return elements(root, element => element.nodeType === 3).map(element => element.textContent).join('');
}

function button(root, text) {
  return elements(root, element => element.tagName === 'button' && textOf(element).includes(text))[0];
}

function fire(element, eventName, value) {
  assert.ok(element, `expected a control for ${eventName}`);
  const event = { target: value === undefined ? element : { value }, currentTarget: element, preventDefault() {}, stopPropagation() {} };
  for (const listener of element.listeners[eventName] || []) listener(event);
}

function stateFor(game = {}, ui = {}) {
  return {
    game: { ...consoleView(createConsole({ modeId: game.mode?.id || 'standard' })), ...game },
    ui: { action: 'idle', pick: [], panels: {}, lobby: {}, ...ui },
    notes: {},
    remote: null,
  };
}

function setupState(modeId = 'standard', initialClueCount = 4) {
  const room = createRoom({ modeId, initialClueCount });
  addPlayer(room, '同行');
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'start-game' }).ok, true);
  const state = stateFor(viewFor(room, room.hostId), { setup: { clues: [], noClues: false, topicNames: {}, conferenceNames: {}, conferences: {} } });
  const calls = [];
  const api = {
    patchSetup(patch) {
      state.ui.setup = { ...state.ui.setup, ...(typeof patch === 'function' ? patch(state.ui.setup) : patch) };
    },
    submitSetup() {
      calls.push(state.ui.setup);
      const draft = state.ui.setup || {};
      return applyRoomAction(room, room.hostId, {
        kind: 'setup',
        clues: draft.clues,
        noClues: draft.noClues,
        topics: draft.topicNames,
        conferences: draft.conferences,
        conferenceNames: draft.conferenceNames,
      });
    },
  };
  return { room, state, api, calls };
}

function tutorialState(patch = {}) {
  return stateFor({
    playMode: 'builtin', phase: 'play', isMyTurn: true,
    tutorial: { stepId: 'observe-map', chapter: 1, chapterCount: 9, title: '认识星图', text: ['点击指定扇区，查看你的初始标记。'], focus: 'map', interaction: 'inspect', actor: 'human', expected: { sector: 4 }, nextLabel: '继续', completed: false, ...patch },
  });
}

test('expert builtin choices and host count selection are available before creation', () => {
  for (const kind of ['start', 'lobby']) {
    const state = stateFor({}, { modal: { kind }, playMode: 'builtin', modeId: 'expert', initialClueCount: 8 });
    const api = { setUi(patch) { Object.assign(state.ui, patch); } };
    const modal = renderModal({ state, api });
    const boards = elements(modal, element => element.attributes?.name === 'board-mode');
    assert.deepEqual(boards.map(element => element.attributes.value), ['standard', 'expert']);
    assert.equal(boards.find(element => element.attributes.value === 'expert').attributes.checked, '');
    assert.doesNotMatch(textOf(modal), /尚不包含专家|目前仅支持标准/);
    const choices = elements(modal, element => element.attributes?.['data-initial-clue-count'] !== undefined);
    assert.deepEqual(choices.map(element => Number(element.attributes['data-initial-clue-count'])), [0, 4, 8, 12]);
    fire(choices[3], 'click');
    assert.equal(state.ui.initialClueCount, 12);
    const builtin = elements(modal, element => element.attributes?.name === 'play-mode' && element.attributes.value === 'builtin')[0];
    fire(builtin, 'change');
    assert.equal(state.ui.modeId, 'expert');
  }
});

test('tutorial creation is fixed to standard and four clues without inviting other players', () => {
  for (const kind of ['start', 'lobby']) {
    const state = stateFor({}, { modal: { kind }, playMode: 'builtin', modeId: 'expert', initialClueCount: 12 });
    const calls = [];
    const api = { setUi(patch) { Object.assign(state.ui, patch); }, startBuiltin() { calls.push({ ...state.ui }); } };
    let modal = renderModal({ state, api });
    const tutorial = elements(modal, element => element.attributes?.name === 'play-mode' && element.attributes.value === 'tutorial')[0];
    fire(tutorial, 'change');
    assert.equal(state.ui.playMode, 'tutorial');
    assert.equal(state.ui.modeId, 'standard');
    assert.equal(state.ui.initialClueCount, 4);
    modal = renderModal({ state, api });
    assert.match(textOf(modal), /12 扇区/);
    assert.match(textOf(modal), /4 条/);
    assert.match(textOf(modal), /领航员|Bot/);
    assert.doesNotMatch(textOf(modal), /其他人.*加入|房主给你的|邀请朋友|加入房间|1–4 人/);
    assert.equal(elements(modal, element => element.attributes?.name === 'board-mode').length, 0);
    assert.equal(elements(modal, element => element.attributes?.['data-initial-clue-count'] !== undefined).length, 0);
    fire(button(modal, '开始双人教学'), 'click');
    assert.equal(calls.length, 1);
  }
});

test('record creation offers the shared clue count for a solo sheet and a room', () => {
  const state = stateFor({}, { playMode: 'record', modal: { kind: 'start' }, initialClueCount: 8 });
  let modal = renderModal({ state, api: {} });
  assert.equal(elements(modal, element => element.attributes?.['data-initial-clue-count'] !== undefined).length, 4);
  state.ui.modal.kind = 'lobby';
  modal = renderModal({ state, api: {} });
  assert.equal(elements(modal, element => element.attributes?.['data-initial-clue-count'] !== undefined).length, 4);
});

test('room lobby exposes the count API only to the host and shows guests the shared value', () => {
  const room = createRoom({ initialClueCount: 8 });
  const guest = addPlayer(room, '同行');
  for (const player of room.players) {
    const calls = [];
    const state = stateFor(viewFor(room, player.id));
    const panel = renderActionPanel({ state, api: { setInitialClueCount(count) {
      calls.push(count);
      assert.equal(applyRoomAction(room, player.id, { kind: 'set-initial-clue-count', count }).ok, true);
    } } });
    const choices = elements(panel, element => element.attributes?.['data-initial-clue-count'] !== undefined);
    assert.match(textOf(panel), new RegExp(`${room.initialClueCount} 条`));
    assert.doesNotMatch(textOf(panel), /每人独立选择|领取私有初始线索/);
    if (player.id === guest.id) assert.equal(choices.length, 0);
    else {
      assert.equal(choices.length, 4);
      fire(choices[1], 'click');
      assert.deepEqual(calls, [4]);
      assert.equal(room.initialClueCount, 4);
    }
  }
});

test('builtin setup only displays delivered host-count clues and confirms readiness', () => {
  for (const count of [0, 4, 8, 12]) {
    const state = stateFor({ playMode: 'builtin', phase: 'setup', initialClueCount: count, mySetup: { initialClueCount: count, cluesClaimed: true, ready: false, clues: count ? [{ sector: 1, type: Obj.GAS_CLOUD }] : [] } }, { initialClueCount: count === 4 ? 12 : 4 });
    let submissions = 0;
    const api = { submitSetup() { submissions += 1; } };
    const panel = renderActionPanel({ state, api });
    assert.match(textOf(panel), new RegExp(`${count} 条`));
    assert.doesNotMatch(textOf(panel), /独立选择|领取初始线索/);
    const status = renderStatus({ state, api });
    assert.doesNotMatch(textOf(status), /独立选择|领取初始线索/);
    assert.match(textOf(status), new RegExp(`${count} 条`));
    assert.equal(elements(panel, element => element.attributes?.['data-initial-clue-count'] !== undefined).length, 0);
    fire(button(panel, '我已准备'), 'click');
    assert.equal(submissions, 1);
    state.game.mySetup.ready = true;
    fire(button(renderActionPanel({ state, api }), '已准备'), 'click');
    assert.equal(submissions, 1);
  }
});

test('record setup requires exactly the shared count of unique valid exclusions on both boards', () => {
  for (const modeId of ['standard', 'expert']) {
    const { room, state, api, calls } = setupState(modeId);
    const render = () => renderActionPanel({ state, api });
    let panel = render();
    assert.match(textOf(panel), /4 条/);
    assert.doesNotMatch(textOf(panel), /最多 12|我没有任何初始线索/);
    fire(button(panel, '完成'), 'click');
    assert.equal(calls.length, 0);
    for (let index = 0; index < 4; index += 1) {
      fire(button(render(), '+ 添加一条线索'), 'click');
    }
    assert.equal(new Set(state.ui.setup.clues.map(clue => `${clue.sector}:${clue.type}`)).size, 4);
    assert.ok(state.ui.setup.clues.every(clue => clue.type !== Obj.COMET || isCometSector(state.game.mode, clue.sector)));
    panel = render();
    assert.equal(button(panel, '+ 添加一条线索'), undefined);
    assert.equal(button(panel, '完成').attributes.disabled, '', 'names are still required');
    const sectors = state.game.conferenceRuleSectors || state.game.conferenceSectors || [];
    state.ui.setup.topicNames = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((id) => [id, `课题${id}`]));
    state.ui.setup.conferenceNames = Object.fromEntries(sectors.map((sector) => [sector, `会议${sector}`]));
    panel = render();
    assert.equal(button(panel, '完成').attributes.disabled, undefined);
    const validClues = state.ui.setup.clues.map(clue => ({ ...clue }));
    state.ui.setup.clues[3] = { ...state.ui.setup.clues[0] };
    panel = render();
    assert.equal(button(panel, '完成').attributes.disabled, '');
    assert.match(textOf(panel), /重复/);
    fire(button(panel, '完成'), 'click');
    assert.equal(calls.length, 0);
    state.ui.setup.clues = validClues;
    const submitted = api.submitSetup();
    assert.equal(submitted.ok, true, submitted.error);
    assert.equal(calls.length, 1);
    assert.equal(room.setup[room.hostId].ready, true);
    assert.deepEqual(room.setup[room.hostId].clues, validClues);
  }
});

test('record exclusion selectors omit impossible comets and clear a stale comet when changing sector', () => {
  const { state, api } = setupState('expert');
  state.ui.setup.clues = [{ sector: 0, type: Obj.ASTEROID }, { sector: 1, type: Obj.COMET }];
  const panel = renderActionPanel({ state, api });
  const rows = elements(panel, element => element.className === 'clue-row');
  const firstTypes = elements(rows[0], element => element.tagName === 'option').map(element => element.attributes.value);
  const secondTypes = elements(rows[1], element => element.tagName === 'option').map(element => element.attributes.value);
  assert.equal(firstTypes.includes(Obj.COMET), false);
  assert.equal(secondTypes.includes(Obj.COMET), true);
  fire(elements(rows[1], element => element.tagName === 'select')[0], 'change', '3');
  assert.equal(state.ui.setup.clues[1].sector, 3);
  assert.notEqual(state.ui.setup.clues[1].type, Obj.COMET);
});

test('zero-clue record setup needs no personal opt-out or extra rows', () => {
  const { state, api, calls } = setupState('standard', 0);
  let panel = renderActionPanel({ state, api });
  assert.match(textOf(panel), /0 条/);
  assert.equal(button(panel, '+ 添加一条线索'), undefined);
  assert.equal(elements(panel, element => element.attributes?.type === 'checkbox').length, 0);
  assert.equal(button(panel, '完成').attributes.disabled, '');
  state.ui.setup.topicNames = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((id) => [id, `课题${id}`]));
  state.ui.setup.conferenceNames = { 10: '彗星的邻居' };
  panel = renderActionPanel({ state, api });
  fire(button(panel, '完成'), 'click');
  assert.equal(calls.length, 1);
});

test('record hosts edit conference titles separately from unrevealed body text', () => {
  const { state, api } = setupState('expert');
  let panel = renderActionPanel({ state, api });
  const titles = elements(panel, element => element.attributes?.['data-conference-name'] !== undefined);
  assert.deepEqual(titles.map(element => element.attributes['data-conference-name']), ['7', '16']);
  fire(titles[0], 'input', '相邻的线索');
  fire(titles[1], 'input', '最后的距离');
  assert.deepEqual(state.ui.setup.conferenceNames, { 7: '相邻的线索', 16: '最后的距离' });
  assert.deepEqual(state.ui.setup.conferences, {});
  state.game.amHost = false;
  state.game.conferenceRules = { 7: 'FUTURE-CONFERENCE-SECRET' };
  state.ui.setup.conferences = { 7: 'FUTURE-CONFERENCE-SECRET' };
  panel = renderActionPanel({ state, api });
  assert.equal(elements(panel, element => element.tagName === 'textarea' && element.value === 'FUTURE-CONFERENCE-SECRET').length, 0);
});

test('conference card keeps every public title visible while only rendering earned text', () => {
  assert.equal(typeof notesheet.renderConferencesPanel, 'function');
  const state = stateFor({ mode: createConsole({ modeId: 'expert' }).mode, playMode: 'builtin', conferenceSectors: [7, 16], conferenceNames: { 7: '邻接之谜', 16: '距离之谜' }, conferenceRules: { 16: 'FUTURE-CONFERENCE-SECRET' } }, { panels: { knowledge: false, conferences: false } });
  state.game.knowledge.conferences = [{ sector: 7, text: '已经公开的会议关系' }];
  const panel = notesheet.renderConferencesPanel({ state, api: {} });
  assert.equal(panel.tagName, 'section');
  assert.match(textOf(panel), /邻接之谜/);
  assert.match(textOf(panel), /距离之谜/);
  assert.match(textOf(panel), /7 号/);
  assert.match(textOf(panel), /16 号/);
  assert.match(textOf(panel), /已公开/);
  assert.match(textOf(panel), /未召开/);
  assert.match(textOf(panel), /已经公开的会议关系/);
  assert.doesNotMatch(textOf(panel), /FUTURE-CONFERENCE-SECRET/);
  const knowledge = renderKnowledgePanel({ state, api: {} });
  assert.doesNotMatch(textOf(knowledge), /已经公开的会议关系|FUTURE-CONFERENCE-SECRET/);
  state.game.conferenceNames[16] = '';
  assert.match(textOf(notesheet.renderConferencesPanel({ state, api: {} })), /X行星会议 · 16 号/);
});

for (const modeId of ['standard', 'expert']) {
  test(`${modeId} record conference corrections appear for every player only after publication`, () => {
    const { room } = setupState(modeId, 0);
    for (const player of room.players) {
      assert.equal(applyRoomAction(room, player.id, { kind: 'setup', noClues: true }).ok, true);
    }
    const sectors = viewFor(room, room.hostId).conferenceSectors;
    const sector = sectors[0];
    const original = '原先记录的会议关系';
    const corrected = '房主更正后的会议关系';
    const rules = Object.fromEntries(sectors.map(conferenceSector => [conferenceSector, `FUTURE-BODY-${conferenceSector}`]));
    rules[sector] = original;
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-rules', rules }).ok, true);
    for (const player of room.players) {
      const state = stateFor(viewFor(room, player.id));
      const visible = textOf(notesheet.renderConferencesPanel({ state, api: {} }));
      assert.doesNotMatch(visible, /FUTURE-BODY/);
      assert.ok(!visible.includes(original));
    }

    assert.equal(applyRoomAction(room, room.hostId, { kind: 'conference', sector, text: original }).ok, true);
    for (const player of room.players) {
      const state = stateFor(viewFor(room, player.id));
      assert.ok(textOf(notesheet.renderConferencesPanel({ state, api: {} })).includes(original));
    }
    assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-rules', rules: { ...rules, [sector]: corrected } }).ok, true);
    for (const player of room.players) {
      const state = stateFor(viewFor(room, player.id));
      assert.equal(state.game.conferenceRules[sector], corrected);
      assert.equal(state.game.knowledge.conferences.find(entry => entry.sector === sector).text, original);
      const visible = textOf(notesheet.renderConferencesPanel({ state, api: {} }));
      assert.ok(visible.includes(corrected), `${modeId} ${player.name} should see the saved correction`);
      assert.ok(!visible.includes(original));
      assert.doesNotMatch(visible, /FUTURE-BODY/);
    }

    assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-rules', rules: {} }).ok, true);
    for (const player of room.players) {
      const state = stateFor(viewFor(room, player.id));
      assert.ok(textOf(notesheet.renderConferencesPanel({ state, api: {} })).includes(original));
    }
  });
}

test('tutorial guide renders accessible progress and only the current human target', async () => {
  const { renderTutorialGuide } = await import('../public/ui/tutorial.js');
  const state = tutorialState();
  state.game.tutorial.futureSteps = ['FUTURE-TUTORIAL-SECRET'];
  const guide = renderTutorialGuide({ game: state.game, api: {} });
  assert.match(textOf(guide), /认识星图/);
  assert.match(textOf(guide), /5 号/);
  assert.match(textOf(guide), /星图/);
  assert.doesNotMatch(textOf(guide), /FUTURE-TUTORIAL-SECRET/);
  const progress = elements(guide, element => element.attributes?.role === 'progressbar')[0];
  assert.equal(progress?.attributes['aria-valuenow'], '1');
  assert.equal(progress?.attributes['aria-valuemax'], '9');
  assert.equal(elements(guide, element => element.attributes?.id === 'tutorial-instruction').length, 1);
  assert.equal(button(guide, '继续'), undefined);
  assert.equal(renderTutorialGuide({ game: stateFor().game, api: {} }), null);
});

test('tutorial navigation uses only the three agreed callbacks and never displays bot expectations', async () => {
  const { renderTutorialGuide } = await import('../public/ui/tutorial.js');
  const calls = [];
  const api = { tutorialNext() { calls.push('next'); }, restartTutorial() { calls.push('restart'); }, exitTutorial() { calls.push('exit'); } };
  const state = tutorialState({ interaction: 'continue', actor: 'bot', nextLabel: '观看 Bot', expected: { sector: 10, topic: 'BOT-HIDDEN-TOPIC' } });
  let guide = renderTutorialGuide({ game: state.game, api });
  assert.doesNotMatch(textOf(guide), /BOT-HIDDEN-TOPIC|11 号/);
  fire(button(guide, '观看 Bot'), 'click');
  assert.deepEqual(calls, ['next']);
  for (const interaction of ['inspect', 'mark', 'action']) {
    state.game.tutorial = { ...state.game.tutorial, interaction, actor: 'human', expected: { sector: 4 }, nextLabel: '继续' };
    guide = renderTutorialGuide({ game: state.game, api });
    assert.equal(button(guide, '继续'), undefined);
    assert.ok(button(guide, '退出教学'));
  }
  state.game.tutorial = { ...state.game.tutorial, completed: true, interaction: 'complete', focus: 'score' };
  guide = renderTutorialGuide({ game: state.game, api });
  fire(button(guide, '重新教学'), 'click');
  fire(button(guide, '退出教学'), 'click');
  assert.deepEqual(calls, ['next', 'restart', 'exit']);
});

test('tutorial Next captures its rendered step id and restart stays available midlesson', async () => {
  const { renderTutorialGuide } = await import('../public/ui/tutorial.js');
  const state = tutorialState({ interaction: 'continue', stepId: 'rendered-step' });
  const calls = [];
  const guide = renderTutorialGuide({ game: state.game, api: { tutorialNext(stepId) { calls.push(stepId); }, restartTutorial() { calls.push('restart'); } } });
  state.game.tutorial.stepId = 'newer-step';
  fire(button(guide, '继续'), 'click');
  assert.deepEqual(calls, ['rendered-step']);
  fire(button(guide, '重新教学'), 'click');
  assert.deepEqual(calls, ['rendered-step', 'restart']);
});

test('tutorial inspection, marking, narration and bot turns do not invite ordinary actions', () => {
  for (const [interaction, actor] of [['inspect', 'human'], ['mark', 'human'], ['continue', 'human'], ['continue', 'bot'], ['action', 'bot']]) {
    const state = tutorialState({ interaction, actor });
    state.ui.action = 'survey';
    const panel = renderActionPanel({ state, api: { pickedRange() { return { start: 4, size: 1 }; } } });
    assert.equal(elements(panel, element => ['button', 'input', 'select', 'textarea'].includes(element.tagName)).length, 0);
    assert.match(textOf(panel), /教学/);
    assert.doesNotMatch(textOf(panel), /确认勘测|尝试定位|选择行动/);
  }
});

test('tutorial human action keeps the real query widgets and highlights the expected control', () => {
  const state = tutorialState({ interaction: 'action', focus: 'survey', expected: { kind: 'survey', start: 4, size: 1, type: Obj.GAS_CLOUD } });
  const calls = [];
  const api = { startAction(kind) { calls.push(kind); }, pickedRange() { return { start: 4, size: 1 }; }, confirmAction() { calls.push('confirm'); } };
  let panel = renderActionPanel({ state, api });
  fire(button(panel, '勘测'), 'click');
  assert.deepEqual(calls, ['survey']);
  assert.equal(button(panel, '尝试定位'), undefined);
  assert.ok(elements(panel, element => element.attributes?.['data-tutorial-focus'] === 'survey').length);
  state.ui = { ...state.ui, action: 'survey', surveyType: Obj.GAS_CLOUD, pick: [4, 4] };
  panel = renderActionPanel({ state, api });
  fire(button(panel, '确认勘测'), 'click');
  assert.deepEqual(calls, ['survey', 'confirm']);
});

test('tutorial targets are highlighted on the map and keyboard reachable without exposing bot targets', () => {
  const state = tutorialState();
  const selected = [];
  let board = renderBoard({ game: state.game, ui: state.ui, notes: state.notes, onSector: sector => selected.push(sector) });
  let target = elements(board, element => element.attributes?.['data-tutorial-target'] === 'sector')[0];
  assert.ok(target);
  assert.equal(target.attributes['aria-describedby'], 'tutorial-instruction');
  assert.equal(target.attributes.tabindex, '0');
  assert.match(target.attributes['aria-label'], /5 号.*教学/);
  for (const listener of target.listeners.keydown || []) listener({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(selected, [4]);
  state.game.tutorial = { ...state.game.tutorial, actor: 'bot', interaction: 'continue' };
  board = renderBoard({ game: state.game, ui: state.ui, notes: state.notes, onSector: sector => selected.push(sector) });
  assert.equal(elements(board, element => element.attributes?.['data-tutorial-target'] !== undefined).length, 0);
});

test('tutorial marking highlights the current object and state without bypassing real mark controls', () => {
  const state = tutorialState({ interaction: 'mark', expected: { sector: 4, code: CODE.gasCloud, markState: 'yes' } });
  state.ui.selectedSector = 4;
  state.ui.mark = { sector: 4, code: CODE.gasCloud };
  const calls = [];
  const panel = renderMapPanel({ state, boardEl: makeElement('svg'), api: { setMark(...args) { calls.push(args); } } });
  const choice = elements(panel, element => element.tagName === 'button' && element.attributes?.['data-tutorial-target'] === 'mark')[0];
  assert.ok(choice);
  assert.match(textOf(choice), /确定存在/);
  assert.equal(choice.attributes['aria-describedby'], 'tutorial-instruction');
  fire(choice, 'click');
  assert.deepEqual(calls, [[4, CODE.gasCloud, 'yes']]);
});

test('started room modal exposes a read-only count even to the host', () => {
  const { state } = setupState('expert', 8);
  state.remote = { roomId: state.game.roomId };
  state.ui.modal = { kind: 'lobby' };
  const modal = renderModal({ state, api: {} });
  assert.match(textOf(modal), /8 条/);
  assert.equal(elements(modal, element => element.attributes?.['data-initial-clue-count'] !== undefined).length, 0);
});

test('real guest views show conference titles independently without leaking prefilled future bodies', () => {
  const { room } = setupState('expert', 0);
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-names', names: { 7: '第一场公开标题', 16: '第二场公开标题' } }).ok, true);
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-rules', rules: { 7: 'FUTURE-RECORD-BODY', 16: 'LATER-RECORD-BODY' } }).ok, true);
  const state = stateFor(viewFor(room, room.players[1].id), { setup: { clues: [], noClues: true }, panels: { knowledge: false } });
  const panel = notesheet.renderConferencesPanel({ state, api: {} });
  assert.match(textOf(panel), /第一场公开标题/);
  assert.match(textOf(panel), /第二场公开标题/);
  assert.doesNotMatch(textOf(panel), /FUTURE-RECORD-BODY|LATER-RECORD-BODY/);
  const setup = renderActionPanel({ state, api: {} });
  assert.equal(elements(setup, element => /RECORD-BODY/.test(element.value || '')).length, 0);
});

test('tutorial research and declaration targets highlight only the expected topic or count', () => {
  const state = tutorialState({ interaction: 'action', focus: 'research', expected: { kind: 'research', topic: 'A' } });
  state.ui.action = 'research';
  let panel = renderActionPanel({ state, api: {} });
  let targets = elements(panel, element => element.tagName === 'button' && element.attributes?.['data-tutorial-target'] === 'topic');
  assert.equal(targets.length, 1);
  assert.match(textOf(targets[0]), /A/);
  assert.equal(targets[0].attributes['aria-describedby'], 'tutorial-instruction');
  state.game.tutorial = { ...state.game.tutorial, focus: 'theory', expected: { kind: 'research-declare', count: 1, phaseId: 'phase-3' } };
  state.game.research = { id: 'phase-3', sector: 3, myCount: null, declaredCount: 0, playerCount: 2, quota: 1, maxDeclare: 1 };
  state.game.theoryOptions = [{ sector: 4, types: [Obj.GAS_CLOUD] }];
  const actions = [];
  panel = renderActionPanel({ state, api: { consoleAction(action) { actions.push(action); } } });
  targets = elements(panel, element => element.tagName === 'button' && element.attributes?.['data-tutorial-target'] === 'count');
  assert.equal(targets.length, 1);
  fire(targets[0], 'click');
  assert.deepEqual(actions, [{ kind: 'research-declare', phaseId: 'phase-3', count: 1 }]);
});

test('tutorial paper targets highlight the expected sector and object without submitting on behalf of the player', () => {
  const state = tutorialState({ interaction: 'action', focus: 'theory', expected: { kind: 'research-submit', sector: 4, objectType: Obj.GAS_CLOUD, phaseId: 'phase-3' } });
  state.game.research = { id: 'phase-3', sector: 3, myCount: 1, allDeclared: true, isMyPick: true, left: 1, orderNames: ['我', '领航员'], picks: [] };
  state.game.theoryOptions = [{ sector: 4, types: [Obj.ASTEROID, Obj.GAS_CLOUD] }];
  state.ui.theorySector = 4;
  state.ui.theoryType = Obj.ASTEROID;
  const actions = [];
  const panel = renderActionPanel({ state, api: { setUi(patch) { Object.assign(state.ui, patch); }, consoleAction(action) { actions.push(action); } } });
  const target = elements(panel, element => element.tagName === 'button' && element.attributes?.['data-tutorial-target'] === 'type')[0];
  assert.ok(target);
  assert.match(textOf(target), /气体云/);
  fire(target, 'click');
  assert.equal(state.ui.theoryType, Obj.GAS_CLOUD);
  assert.deepEqual(actions, []);
  assert.ok(elements(panel, element => element.tagName === 'select' && element.attributes?.['aria-describedby'] === 'tutorial-instruction').length);
});

test('tutorial ignores a stale locate dialog outside a human locate action', () => {
  const state = tutorialState();
  state.ui.modal = { kind: 'locate' };
  assert.ok(renderModal({ state, api: {} }) === null);
});

test('tutorial locate dialog keeps the current expected answers visible and labels each real input', () => {
  const state = tutorialState({ interaction: 'action', focus: 'locate', expected: { kind: 'locate', sector: 5, left: Obj.GAS_CLOUD, right: Obj.GAS_CLOUD } });
  state.ui.modal = { kind: 'locate' };
  const modal = renderModal({ state, api: {} });
  const instruction = elements(modal, element => element.attributes?.id === 'tutorial-locate-instruction')[0];
  assert.ok(instruction);
  assert.match(textOf(instruction), /6 号/);
  assert.match(textOf(instruction), /左邻.*气体云.*右邻.*气体云/);
  const fields = elements(modal, element => element.tagName === 'select');
  assert.equal(fields.length, 3);
  assert.ok(fields.every(field => field.attributes['aria-describedby'] === 'tutorial-locate-instruction'));
  assert.ok(fields.every(field => field.attributes['data-tutorial-target'] !== undefined));
});

test('completed tutorial keeps the public board reveal and final scores visible', () => {
  const state = tutorialState({ completed: true, interaction: 'complete', focus: 'score' });
  state.game.phase = 'done';
  state.game.revealedObjects = [Obj.GAS_CLOUD, Obj.PLANET_X];
  const panel = renderActionPanel({ state, api: {} });
  assert.match(textOf(panel), /最终积分/);
  assert.match(textOf(panel), /公开棋盘/);
  assert.match(textOf(panel), /2 号.*X行星/);
  assert.equal(elements(panel, element => element.tagName === 'button').length, 0);
});

test('record conference entry does not prefill a future body for a guest', () => {
  const { room } = setupState('standard', 0);
  for (const player of room.players) assert.equal(applyRoomAction(room, player.id, { kind: 'setup', noClues: true }).ok, true);
  assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-conference-rules', rules: { 10: 'FUTURE-RECORD-BODY' } }).ok, true);
  const state = stateFor(viewFor(room, room.players[1].id));
  const panel = renderActionPanel({ state, api: {} });
  assert.equal(elements(panel, element => element.tagName === 'textarea' && element.value === 'FUTURE-RECORD-BODY').length, 0);
});

test('tutorial and conference layouts stay in document flow with narrow-screen wrapping', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const guide = styles.match(/\.tutorial-guide\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(guide, /min-width:\s*0/);
  assert.match(guide, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(guide, /position:\s*(fixed|absolute)|min-width:\s*\d{3}px/);
  const actions = styles.match(/\.tutorial-navigation\s*\{([^}]+)\}/)?.[1] || '';
  assert.match(actions, /flex-wrap:\s*wrap/);
  assert.match(styles, /\.tutorial-navigation \.btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(styles, /\.conference-row\s*\{[^}]*min-width:\s*0/);
});
