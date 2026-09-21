import { h } from './dom.js';
import { CODE_TO_TYPE, labelOf } from '../src/types.js';
import { mod } from '../src/rules.js';

const FOCUS_LABELS = {
  map: '星图',
  timeline: '时间轨',
  survey: '勘测',
  target: '扫描',
  research: '研究课题',
  theory: '学术研究',
  conference: 'X行星会议',
  locate: '定位 X行星',
  score: '计分',
};

const MARK_LABELS = { maybe: '可能存在', yes: '确定存在', no: '不存在' };

export function tutorialExpected(game) {
  const tutorial = game.tutorial;
  return tutorial && !tutorial.completed && tutorial.interaction !== 'complete' && tutorial.actor === 'human' ? tutorial.expected || null : null;
}

export function tutorialFocusProps(game, focus) {
  return game.tutorial && !game.tutorial.completed && game.tutorial.focus === focus
    ? { 'data-tutorial-focus': focus, 'aria-describedby': 'tutorial-instruction' }
    : {};
}

export function tutorialTargetProps(target, active) {
  return active ? { 'data-tutorial-target': target, 'aria-describedby': 'tutorial-instruction' } : {};
}

function expectedTargets(game) {
  const expected = tutorialExpected(game);
  if (!expected) return [];
  const targets = [];
  if (Number.isInteger(expected.sector)) targets.push(`扇区：${expected.sector + 1} 号`);
  if (Number.isInteger(expected.start) && Number.isInteger(expected.size)) {
    targets.push(`勘测范围：${expected.start + 1}–${mod(expected.start + expected.size - 1, game.mode.sectors) + 1} 号（${expected.size} 格）`);
  }
  const objectType = expected.type || expected.objectType || expected.surveyType || CODE_TO_TYPE[expected.code];
  if (objectType) targets.push(`天体：${labelOf(objectType)}`);
  if (expected.topic) targets.push(`研究课题：${expected.topic}`);
  if (Number.isInteger(expected.count)) targets.push(expected.kind === 'research-declare' ? `提交篇数：${expected.count} 篇` : `数量：${expected.count}`);
  const mark = expected.markState || expected.mark;
  if (MARK_LABELS[mark]) targets.push(`标记：${MARK_LABELS[mark]}`);
  if (expected.left) targets.push(`左邻：${labelOf(expected.left)}`);
  if (expected.right) targets.push(`右邻：${labelOf(expected.right)}`);
  return targets;
}

export function renderTutorialGuide({ game, api }) {
  const tutorial = game.tutorial;
  if (!tutorial) return null;
  const stepId = tutorial.stepId;
  const completed = tutorial.completed || tutorial.interaction === 'complete';
  const chapterCount = Math.max(1, tutorial.chapterCount || 1);
  const chapter = Math.max(1, Math.min(chapterCount, tutorial.chapter || 1));
  const focus = FOCUS_LABELS[tutorial.focus] || '教学';
  const targets = completed ? [] : expectedTargets(game);
  const instruction = tutorial.interaction === 'inspect'
    ? '请在星图中选择指定扇区，完成后教学会继续。'
    : tutorial.interaction === 'mark'
      ? '请使用星图的标注按钮完成指定标记。'
      : tutorial.interaction === 'action'
        ? '请在下方使用真实行动控件完成本步；不会自动替你操作。'
        : null;
  return h(
    'section',
    { class: 'card tutorial-guide', 'aria-labelledby': 'tutorial-title', 'data-tutorial-step': stepId, 'data-tutorial-focus': tutorial.focus },
    h('div', { class: 'tutorial-heading' },
      h('span', { class: 'tutorial-chapter' }, `双人教学 · 第 ${chapter}/${chapterCount} 章`),
      h('span', { class: 'pill' }, completed ? '已完成' : tutorial.actor === 'bot' ? '观看 Bot' : '轮到你'),
    ),
    h('h2', { id: 'tutorial-title' }, tutorial.title),
    h('div', { class: 'tutorial-progress', role: 'progressbar', 'aria-label': '教学章节进度', 'aria-valuemin': 1, 'aria-valuemax': chapterCount, 'aria-valuenow': chapter, 'aria-valuetext': `第 ${chapter} 章，共 ${chapterCount} 章${completed ? '，教学完成' : ''}` },
      h('span', { style: { width: `${chapter / chapterCount * 100}%` } }),
    ),
    h('div', { id: 'tutorial-instruction', class: 'tutorial-instruction', 'aria-live': 'polite', 'aria-atomic': 'true' },
      ...(tutorial.text || []).map(paragraph => h('p', {}, paragraph)),
      !completed && h('p', { class: 'tutorial-focus-label' }, `当前关注：${focus}`),
      targets.length ? h('ul', { class: 'tutorial-targets', 'aria-label': '本步操作目标' }, targets.map(target => h('li', {}, target))) : null,
      !completed && instruction ? h('p', { class: 'muted small' }, instruction) : null,
    ),
    h('div', { class: 'tutorial-navigation', role: 'group', 'aria-label': '教学导航' },
      !completed && tutorial.interaction === 'continue'
        ? h('button', { class: 'btn primary', onclick: () => api.tutorialNext(stepId) }, tutorial.actor === 'bot' ? '观看 Bot' : tutorial.nextLabel || '继续')
        : null,
      h('button', { class: `btn ${completed ? 'primary' : 'ghost'}`, onclick: () => api.restartTutorial() }, '重新教学'),
      h('button', { class: 'btn ghost', onclick: () => api.exitTutorial() }, '退出教学'),
    ),
  );
}
