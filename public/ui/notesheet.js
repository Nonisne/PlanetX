// The player's record cards for the right sidebar: the A–F subjects and the papers on
// the peer-review track. The old sector × object grid is gone — the star map shows the
// same thing, and the round table records every operation.
import { h } from './dom.js';
import { CODE, labelOf } from '../src/types.js';
import { conferenceSectors, durationLabel, timeShort } from '../src/rules.js';
import { iconEl } from './icons.js';
import { renderDisclosure } from './disclosure.js';
import { tutorialFocusProps } from './tutorial.js';

export function renderConferencesPanel({ state, api }) {
  const { game } = state;
  const sectors = game.conferenceSectors || conferenceSectors(game.mode);
  const names = game.conferenceNames || {};
  const conferences = game.knowledge?.conferences || [];
  return h(
    'section',
    { class: 'card conferences-card', 'aria-label': 'X行星会议', ...tutorialFocusProps(game, 'conference') },
    h('h2', {}, 'X行星会议'),
    h('ul', { class: 'conference-list' }, sectors.map(sector => {
      const earned = conferences.find(entry => entry.sector === sector);
      return h('li', { class: 'conference-row', 'data-conference-sector': sector },
        h('h3', { class: 'conference-title' }, names[sector]?.trim() || `X行星会议 · ${sector} 号`),
        h('span', { class: `conference-status small${earned ? ' ok' : ' muted'}` }, `${sector} 号 · ${earned ? '已公开' : '未召开'}`),
        earned ? h('p', { class: 'clue-text' }, game.conferenceRules?.[sector] || earned.text) : h('p', { class: 'muted small' }, '会议召开后公布线索。'),
      );
    })),
    game.playMode !== 'builtin' && game.status === 'open'
      ? h('p', { class: 'muted small' }, '会议结束后，在行动栏记录会议线索。')
      : null,
  );
}

export function renderTopicsPanel({ game, draftNames, state, api }) {
  const topics = game.topics || {};
  const ids = ['A', 'B', 'C', 'D', 'E', 'F'];
  const clues = game.knowledge.clues.filter(clue => !game.me || clue.actorId === game.me);
  return renderDisclosure(
    { state, api, id: 'topics', title: '研究课题', meta: `${clues.length}/6`, className: 'card topics-card' },
    ...ids.map((id) => {
      const stored = topics[id] || {};
      const entry = clues.find((clue) => clue.topic === id);
      const title = stored.name || (draftNames && draftNames[id]) || (entry && entry.name) || '';
      return h(
        'div',
        { class: `record-row${entry ? '' : ' empty'}` },
        h('span', { class: 'row-tag' }, id),
        h(
          'span',
          { class: 'row-main' },
          h('span', { class: 'row-name' }, title || '未命名'),
          entry ? h('span', { class: 'clue-text' }, entry.text) : h('span', { class: 'muted small' }, '　未研究'),
        ),
      );
    }),
    h(
      'p',
      { class: 'muted small' },
      game.playMode === 'builtin' ? '课题名称由系统提供，全桌一致；已查询的规律只有你自己看得到。' : '课题名是全桌共享的（房主填一次）；下面每条规律原文只有你自己看得到。',
    ),
  );
}

/** The papers on the peer-review track, with the two review answers for your own. */
export function renderTheoriesPanel({ game, onReview, state, api }) {
  const theories = (game.knowledge && game.knowledge.theories) || [];
  const label = { pending: '未评审', correct: '正确', wrong: '错误' };
  const sitting = theories.filter((t) => t.review === 'pending');
  const nextSector = Math.min(...sitting.filter((theory) => theory.slot <= 1).map((theory) => theory.sector));
  const bySector = new Map();
  for (const theory of theories) {
    if (!bySector.has(theory.sector)) bySector.set(theory.sector, []);
    bySector.get(theory.sector).push(theory);
  }
  if (!theories.length) {
    return renderDisclosure({ state, api, id: 'theories', title: '学术研究', meta: '0 篇', className: 'card theories-card' }, h('p', { class: 'muted small' }, '还没有提交过学术研究。'));
  }
  return renderDisclosure(
    { state, api, id: 'theories', title: '学术研究', meta: `${theories.length} 篇`, open: Number.isFinite(nextSector), className: 'card theories-card' },
    sitting.length
      ? h('p', { class: 'muted small' }, `其中 ${sitting.length} 篇还在评审轨道上；推进到轨道 1 才能确认对错。`)
      : null,
    h('table', { class: 'theories-table' },
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, '扇区'), h('th', { scope: 'col' }, '论文与评审轨道'))),
      h('tbody', {}, [...bySector].sort(([first], [second]) => first - second).map(([sector, papers]) => h('tr', {},
        h('th', { scope: 'row' }, `${sector + 1} 号`),
        h('td', {}, papers.map((theory) => {
          const hidden = theory.objectType === undefined || theory.objectType === null;
          const isMine = theory.actorId === undefined || theory.actorId === null || theory.actorId === game.me;
          const author = (game.players || []).find((player) => player.id === theory.actorId);
          const awaiting = theory.review === 'pending' && theory.slot <= 1;
          return h('div', { class: `theory-paper${awaiting ? ' awaiting' : ''}`, 'data-theory-id': theory.id },
            h('span', { class: 'theory-author', style: { borderColor: author?.color || 'var(--line)' } },
              h('span', { class: 'dot', style: { background: author?.color || 'var(--accent)' } }),
              author?.name || (isMine ? '我' : '未知玩家'),
            ),
            h('span', { class: 'theory-object', title: hidden ? '天体未公开' : labelOf(theory.objectType) },
              hidden ? h('span', { class: 'muted' }, '? 天体未公开') : [iconEl(CODE[theory.objectType] || theory.objectType, 16), labelOf(theory.objectType)],
            ),
            Number.isInteger(theory.slot) ? h('span', { class: `track track-${theory.slot}`, title: '评审轨道位置（4 → 1）' }, `轨道 ${theory.slot}`) : null,
            game.status === 'open' && awaiting && sector === nextSector && onReview && isMine
              ? h('span', { class: 'review-pair' },
                h('button', { class: 'review-ok', title: 'app 说这篇正确', onclick: () => onReview(theory.id, 'correct') }, '正确'),
                h('button', { class: 'review-bad', title: `app 说这篇错误：罚 ${durationLabel(1)}`, onclick: () => onReview(theory.id, 'wrong') }, '错误'),
              )
              : h('span', { class: `review review-${theory.review}` }, label[theory.review] || '未评审'),
            theory.revealed ? h('span', { class: 'muted small' }, '已公开') : null,
          );
        })),
      ))),
    ),
  );
}

function scanBlock({ game }) {
  const scans = game.knowledge.targets;
  if (!scans.length) return null;
  return h(
    'div',
    { class: 'record-block' },
    h('h3', {}, `扫描结果（${scans.length}）`),
    ...scans.map((t) =>
      h(
        'div',
        { class: 'record-row' },
        h('span', { class: 'cell-icon' }, iconEl(t.apparent, 16)),
        h('span', { class: 'row-main' }, `${t.sector + 1} 号扇区 · ${LABEL[CODE_TO_TYPE[t.apparent]]}`),
        h('span', { class: 'time muted' }, timeShort(t.time, game.mode)),
      ),
    ),
  );
}

/** 提交的学术研究 + 评审轨道位置 + 同行评审结果（可以点按修改评审）。 */
function theoryBlock({ game, onReview }) {
  const theories = game.knowledge.theories;
  if (!theories || !theories.length) return null;
  const label = { pending: '未评审', correct: '正确', wrong: '错误' };
  const awaiting = theories.filter((t) => t.review === 'pending' && t.slot <= 1);
  return h(
    'div',
    { class: 'record-block' },
    h('h3', {}, `学术研究（${theories.length}）`),
    awaiting.length
      ? h(
          'div',
          { class: 'review-call small' },
          `有 ${awaiting.length} 条理论已推进到评审轨道最后一格：去 app 触发同行评审，再点下面的结果按钮填回来。`,
        )
      : null,
    ...theories.map((t) => {
      // the object is the author's secret until a peer review reveals the sector
      const shown = t.objectType === undefined || t.objectType === null;
      const isMine = t.actorId === undefined || t.actorId === null || t.actorId === game.me;
      return h(
        'div',
        { class: `record-row${t.review === 'pending' && t.slot <= 1 ? ' awaiting' : ''}` },
        h('span', { class: 'cell-icon' }, shown ? h('span', { class: 'muted' }, '?') : iconEl(t.objectType, 16)),
        h(
          'span',
          { class: 'row-main' },
          `${t.sector + 1} 号扇区 · ${shown ? '天体未公开' : labelOf(t.objectType)}`,
          t.revealed ? h('span', { class: 'muted small' }, '（已公开）') : null,
        ),
        t.review === 'pending' ? h('span', { class: `track track-${t.slot}`, title: '评审轨道位置（4 → 1）' }, `轨道 ${t.slot}`) : null,
        t.review === 'pending' && t.slot <= 1 && onReview && isMine
          ? h(
              'span',
              { class: 'review-pair' },
              h('button', { class: 'review-ok', title: 'app 说这篇正确', onclick: () => onReview(t.id, 'correct') }, '正确'),
              h('button', { class: 'review-bad', title: `app 说这篇错误：罚 ${durationLabel(1)}`, onclick: () => onReview(t.id, 'wrong') }, '错误'),
            )
          : h('span', { class: `review review-${t.review}` }, t.review === 'pending' && t.slot > 1 ? `轨道 ${t.slot}（到 1 才能确认）` : label[t.review] || '未评审'),
      );
    }),
  );
}

function conferenceBlock({ game }) {
  const confs = game.knowledge.conferences || [];
  const rules = game.conferenceRules || {};
  const sectors = game.conferenceRuleSectors || [];
  // the host's shared notes first (they are the table's knowledge), then what was recorded
  const known = sectors.filter((s) => rules[s] && !confs.some((c) => c.sector === s));
  if (!confs.length && !known.length) return null;
  return h(
    'div',
    { class: 'record-block' },
    h('h3', {}, `X行星会议线索（${confs.length + known.length}）`),
    ...known.map((sector) =>
      h('div', { class: 'record-row' }, h('span', { class: 'row-tag' }, `扇区 ${sector}`), h('span', { class: 'row-main' }, rules[sector])),
    ),
    ...confs.map((c) =>
      h('div', { class: 'record-row' }, h('span', { class: 'row-tag' }, `扇区 ${c.sector}`), h('span', { class: 'row-main' }, c.text)),
    ),
  );
}
