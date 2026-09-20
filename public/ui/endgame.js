import { h } from './dom.js';
import { LABEL, Obj, THEORY_TYPES } from '../src/types.js';
import { scoreWinners } from '../src/score.js';

const REVEAL_TYPES = Object.values(Obj);

function selectField(label, value, options, onChange) {
  return h(
    'label',
    {},
    label,
    h(
      'select',
      { 'aria-label': label, onchange: (event) => onChange(event.target.value) },
      options.map((option) => h('option', { value: option.value, selected: option.value === value }, option.text)),
    ),
  );
}

function renderFinal({ game, ui, api }) {
  const endgame = game.endgame || {};
  const heading = [
    h('h2', {}, '最后机会'),
    h('p', {}, endgame.firstFinderName ? `${endgame.firstFinderName} 已率先找到 X行星。` : '已有玩家找到 X行星。'),
    h('p', { class: 'muted small' }, '最后机会的任何选择都不会移动棋子；定位答案继续保密，直到全盘揭示。'),
  ];
  if (!endgame.isMyTurn) {
    const cursorName = endgame.cursorName || endgame.players?.find((player) => player.id === endgame.cursorId)?.name;
    return h(
      'section',
      { class: 'card action-card record-card' },
      heading,
      h('div', { class: 'action-block' }, h('p', { class: 'muted' }, `等待 ${cursorName || '其他玩家'} 完成最后机会。`)),
    );
  }

  const quota = Number.isInteger(endgame.quota) ? Math.max(0, endgame.quota) : 0;
  const theories = Array.from(ui.finalTheories || [], (theory) => ({
    sector: theory?.sector ?? '',
    objectType: theory?.objectType ?? '',
  }));
  const canSubmit = theories.length <= quota && theories.every((theory) =>
    Number.isInteger(theory.sector) && theory.sector >= 0 && theory.sector < game.mode.sectors && THEORY_TYPES.includes(theory.objectType),
  );
  const sectorOptions = [
    { value: '', text: '请选择扇区' },
    ...Array.from({ length: game.mode.sectors }, (unused, sector) => ({ value: sector, text: `${sector + 1} 号` })),
  ];
  const typeOptions = [{ value: '', text: '请选择天体' }, ...THEORY_TYPES.map((objectType) => ({ value: objectType, text: LABEL[objectType] }))];
  const updateTheory = (index, patch) => api.setUi({
    finalTheories: theories.map((theory, theoryIndex) => theoryIndex === index ? { ...theory, ...patch } : theory),
  });

  return h(
    'section',
    { class: 'card action-card record-card' },
    heading,
    h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '轮到你的最后机会'),
      h('p', {}, `你落后 ${endgame.behind ?? 0} 格，可以尝试定位，或提交最多 ${quota} 篇最终理论，也可以放弃。`),
      h('div', { class: 'action-buttons' }, h('button', { class: 'btn', onclick: () => api.openLocate() }, '尝试定位 X行星')),
    ),
    h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '最终理论'),
      h(
        'div',
        { class: 'range-row' },
        selectField(
          '最终理论数量',
          theories.length,
          Array.from({ length: quota + 1 }, (unused, count) => ({ value: count, text: `${count} 篇` })),
          (value) => {
            const count = Number(value);
            if (value === '' || !Number.isInteger(count) || count < 0 || count > quota) return;
            api.setUi({
              finalTheories: Array.from({ length: count }, (unused, index) => theories[index] || { sector: '', objectType: '' }),
            });
          },
        ),
      ),
      theories.map((theory, index) => h(
        'div',
        { class: 'range-row' },
        selectField(`理论 ${index + 1} 扇区`, theory.sector, sectorOptions, (value) => updateTheory(index, { sector: value === '' ? '' : Number(value) })),
        selectField(`理论 ${index + 1} 天体`, theory.objectType, typeOptions, (value) => updateTheory(index, { objectType: value })),
      )),
      h('p', { class: 'muted small' }, '可选择 0 篇；所选理论必须全部填写完，再一次性提交。'),
      h(
        'div',
        { class: 'action-buttons' },
        h('button', {
          class: 'btn primary',
          disabled: !canSubmit,
          onclick: () => {
            if (canSubmit) api.consoleAction({ kind: 'final-theories', theories: theories.map((theory) => ({ ...theory })) });
          },
        }, '提交最终理论'),
        h('button', { class: 'btn ghost', onclick: () => api.consoleAction({ kind: 'final-pass' }) }, '放弃最后机会'),
      ),
    ),
  );
}

function renderReveal({ game, ui, api }) {
  const canReveal = game.endgame?.canReveal && (game.phase == null || game.amHost);
  if (!canReveal) {
    return h(
      'section',
      { class: 'card action-card record-card' },
      h('h2', {}, '揭示棋盘'),
      h('div', { class: 'action-block' }, h('p', { class: 'muted' }, '等待获准揭示后，由房主或单机玩家填写完整棋盘。')),
    );
  }

  const sectors = game.mode.sectors;
  const objects = Array.from({ length: sectors }, (unused, sector) =>
    REVEAL_TYPES.includes(ui.revealObjects?.[sector]) ? ui.revealObjects[sector] : '',
  );
  const filled = objects.filter((objectType) => objectType !== '').length;
  const planetCount = objects.filter((objectType) => objectType === Obj.PLANET_X).length;
  const canSubmit = filled === sectors && planetCount === 1;
  const options = [{ value: '', text: '请选择天体' }, ...REVEAL_TYPES.map((objectType) => ({ value: objectType, text: LABEL[objectType] }))];

  return h(
    'section',
    { class: 'card action-card record-card' },
    h('h2', {}, '揭示棋盘'),
    h(
      'div',
      { class: 'action-block' },
      h('p', {}, `请按官方答案填写全部 ${sectors} 个扇区，且恰好有 1 个 X行星。未知扇区不能当作空域。`),
      h(
        'div',
        { class: 'locate-grid' },
        objects.map((objectType, sector) => selectField(`${sector + 1} 号扇区`, objectType, options, (value) => api.setUi({
          revealObjects: objects.map((current, index) => index === sector ? value : current),
        }))),
      ),
      h('p', { class: 'muted small', 'aria-live': 'polite' }, `已填写 ${filled}/${sectors} 个扇区 · X行星 ${planetCount}/1。`),
      h(
        'div',
        { class: 'action-buttons' },
        h('button', {
          class: 'btn primary',
          disabled: !canSubmit,
          onclick: () => {
            if (canSubmit) api.consoleAction({ kind: 'reveal-objects', objects: [...objects] });
          },
        }, '提交揭示结果'),
      ),
    ),
  );
}

function renderFinished({ game }) {
  const scores = game.scores;
  const rows = scores?.rows || [];
  const winners = scoreWinners(scores);
  const objects = game.revealedObjects || [];
  return h(
    'section',
    { class: 'card score-card' },
    h('h2', {}, '本局已结束'),
    h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '最终积分'),
      rows.length ? [
        h('p', {}, winners.length ? `获胜：${winners.map((row) => row.name).join('、')}` : '暂无获胜者'),
        h('ul', { class: 'score-list' }, rows.map((row) => h('li', {}, `${row.name} · `, h('span', { class: 'total' }, `${row.total} 分`)))),
      ] : h('p', { class: 'muted small' }, '暂无积分记录。'),
    ),
    objects.length ? h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '公开棋盘'),
      h('div', { class: 'chips' }, objects.map((objectType, sector) =>
        h('span', { class: 'chip chip-type' }, `${sector + 1} 号 · ${LABEL[objectType] || '未公开'}`),
      )),
    ) : null,
  );
}

export function renderEndgame({ game, ui, api }) {
  const phase = game.phase ?? game.status;
  if (phase === 'final') return renderFinal({ game, ui, api });
  if (phase === 'reveal') return renderReveal({ game, ui, api });
  if (phase === 'done' || phase === 'finished') return renderFinished({ game });
  return null;
}
