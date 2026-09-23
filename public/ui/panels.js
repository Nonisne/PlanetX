// Panels: header, status, map, actions, knowledge, log and modals for the record console.
import { h } from './dom.js';
import { CODE, CODE_TO_TYPE, LABEL, Obj, SURVEY_TYPES, THEORY_TYPES, labelOf } from '../src/types.js';
import {
  BUILTIN_MAX_PLAYERS,
  COST,
  INITIAL_CLUE_COUNTS,
  MAX_TARGET_USES,
  MODE_LIST,
  THEORY_TRACK,
  baseRuleText,
  conferenceSectors,
  durationLabel,
  eventSummary,
  isCometSector,
  mod,
  modeById,
  surveyCost,
  theorySectors,
  theoryPointsFor,
  timeLabel,
  timeShort,
  visibleSectorsAt,
  visibleStartAt,
} from '../src/rules.js';
import { DWARF_BELT_HINT_TEXT, possibleDwarfBands } from '../src/dwarf-belt.js';
import { iconEl, iconLabel } from './icons.js';
import { pendingUiEvents, sectorAnchor } from './board.js';
import { CLUE_TYPES } from '../src/room.js';
import { TYPE_COLOR } from './theme.js';
import { renderEndgame } from './endgame.js';
import { scoreWinners } from '../src/score.js';
import { renderActionHistory } from './history.js';
import { renderDisclosure } from './disclosure.js';
import { tutorialExpected, tutorialFocusProps, tutorialTargetProps } from './tutorial.js';
import { renderTheoriesPanel } from './notesheet.js';

const ALL_SECTOR_CODES = ['planetX', 'asteroid', 'comet', 'gasCloud', 'dwarfPlanet', 'empty'].map((t) => CODE[t]);
const TOPIC_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

function stripCodes(mode, sector) {
  return ALL_SECTOR_CODES.filter((code) => code !== CODE.comet || !Number.isInteger(sector) || isCometSector(mode, sector));
}

const pct = (a, b) => (b && b !== Infinity ? Math.max(0, Math.min(100, (a / b) * 100)) : 0);

/** Remaining physical theory tokens for the current player. */
function theoryTokenMeter(game) {
  const inventory = game.theoryTokenInventory;
  const remaining = game.theoryTokensRemaining;
  if (!inventory || !remaining) return null;
  return h(
    'div',
    { class: 'theory-token-meter', 'aria-label': '理论标记库存' },
    h('p', { class: 'muted small' }, '实体理论标记：用完某类就不能再提交该天体；错误论文移出棋盘，正确论文留在轨道上，都不会退回库存。'),
    h(
      'ul',
      { class: 'theory-token-list' },
      THEORY_TYPES.map((type) => {
        const total = inventory[type] || 0;
        const left = remaining[type] ?? 0;
        const spent = Math.max(0, total - left);
        return h(
          'li',
          { class: `theory-token${left === 0 ? ' exhausted' : ''}`, 'data-object-type': type },
          h('span', { class: 'theory-token-label' }, iconLabel(CODE[type], LABEL[type], { size: 14 })),
          h('span', { class: 'theory-token-count' }, `${left}/${total}`),
          h('span', { class: 'muted small' }, spent ? `已用 ${spent}` : '未使用'),
        );
      }),
    ),
  );
}

/** Record-mode expert helper: list remaining dwarf bands implied by handwritten marks. */
function dwarfBeltHelper({ game, notes }) {
  if (game.mode?.id !== 'expert' || game.tutorial) return null;
  const bands = possibleDwarfBands(notes || {}, game.mode.sectors);
  const recordOnly = game.playMode !== 'builtin';
  return h(
    'div',
    { class: 'dwarf-belt-helper', 'data-play-mode': game.playMode || 'record' },
    h('h4', {}, '矮行星带辅助'),
    DWARF_BELT_HINT_TEXT.map((line) => h('p', { class: 'muted small' }, line)),
    recordOnly
      ? h('p', { class: 'muted small' }, '星图上会淡淡标出仍可能落在某条带内的扇区；只根据你的矮行星标注计算。')
      : null,
    bands.length === 0
      ? h('p', { class: 'lobby-error' }, '当前标注已经排除全部合法矮行星带，请检查「确定存在／不存在」标记。')
      : bands.length <= 8
        ? h('ul', { class: 'dwarf-belt-list' }, bands.map((band) => h('li', { 'data-band-start': band.start }, formatBandLabel(band))))
        : h('p', { class: 'muted small' }, `仍有 ${bands.length} 条可能的带；继续标注矮行星端点或排除带外扇区后会进一步收缩。`),
  );
}

function formatBandLabel(band) {
  return `${band.sectors.map((sector) => sector + 1).join(' → ')}（端点 ${band.endpoints[0] + 1}／${band.endpoints[1] + 1}）`;
}

/** Three way manual marking bubble: 可能存在 / 确定存在 / 不存在. */
function renderMarkPopover({ state, api }) {
  const { ui, game, notes } = state;
  if (!ui.mark) return null;
  const { sector, code } = ui.mark;
  if (code === CODE.comet && !isCometSector(game.mode, sector)) return null;
  const anchor = sectorAnchor(sector, game.mode.sectors);
  const current = notes[`${sector}:${code}`] || 'maybe';
  const expected = tutorialExpected(game);
  const expectedCode = CODE[expected?.type || expected?.objectType] || expected?.code;
  const tutorialMark = game.tutorial?.interaction === 'mark' && expected?.sector === sector && expectedCode === code;
  const expectedMark = expected?.markState || expected?.mark;
  const below = anchor.top < 46;
  const left = Math.max(20, Math.min(80, anchor.left));

  const choice = (value, label, cls) =>
    h(
      'button',
      {
        class: `mark-choice ${cls}${current === value ? ' active' : ''}${tutorialMark && expectedMark === value ? ' tutorial-target' : ''}`,
        'data-tutorial-target': tutorialMark && expectedMark === value ? 'mark' : null,
        'aria-describedby': tutorialMark && expectedMark === value ? 'tutorial-instruction' : null,
        onclick: () => api.setMark(sector, code, value),
      },
      label,
    );

  return h(
    'div',
    {
      class: 'mark-pop',
      style: { left: `${left}%`, top: `${anchor.top}%`, transform: `translate(-50%, ${below ? '18%' : '-118%'})` },
    },
    h(
      'div',
      { class: 'mark-pop-head' },
      h('span', { class: 'mark-pop-title' }, `${sector + 1} 号扇区`),
      h('span', { class: 'cell-icon' }, iconEl(code, 20)),
      h('span', { class: 'mark-pop-name' }, LABEL[CODE_TO_TYPE[code]]),
      h('button', { class: 'mark-close', onclick: () => api.setUi({ mark: null }), title: '关闭' }, '×'),
    ),
    h(
      'div',
      { class: 'mark-choices' },
      choice('maybe', '可能存在', 'maybe'),
      choice('yes', '确定存在', 'yes'),
      choice('no', '不存在', 'no'),
    ),
    h(
      'div',
      { class: 'mark-hint muted small' },
      current === 'yes' ? '已标记为确定存在（✓）' : current === 'no' ? '已标记为不存在（✗，图标被划掉）' : '未标记：纯属你自己的推测',
    ),
  );
}

const ACTION_HINT = {
  idle: '点行动按钮开始记录；点天体图标标注存在/不存在',
  survey: '勘测：在星图上点起点与终点扇区',
  scan: '扫描：在星图上点一个扇区',
  research: '研究：在右侧选择课题 A–F',
  theory: '学术研究：在右侧选择扇区与天体',
};

export function renderMapPanel({ state, api, boardEl, onClearNotes }) {
  const { game, ui, notes } = state;
  const expected = tutorialExpected(game);
  const expectedCode = CODE[expected?.type || expected?.objectType] || expected?.code;
  const hasTheories = (game.knowledge.theories || []).length > 0;
  const sector = ui.selectedSector;
  const target = sector !== null && sector !== undefined ? game.knowledge.targets.find((t) => t.sector === sector) : null;
  const visible = sector !== null && sector !== undefined ? (game.visible || []).includes(sector) : false;

  const detail = h(
    'div',
    { class: 'sector-detail' },
    sector === null || sector === undefined
      ? h('span', { class: 'muted small' }, game.playMode === 'builtin' && (!ui.action || ui.action === 'idle') ? '选择行动获取线索；点天体图标记录自己的推理' : ACTION_HINT[ui.action] || ACTION_HINT.idle)
      : [
          h('span', { class: 'detail-title' }, `${sector + 1} 号扇区`),
          h('span', { class: `pill ${visible ? 'ok' : 'dim'}` }, visible ? '当前可见' : '当前不可见'),
          target
            ? h('span', { class: 'pill icon-pill' }, iconLabel(target.apparent, `已扫描：${labelOf(target.apparent)}`, { size: 14 }))
            : null,
        ],
  );

  const strip = h(
    'div',
    { class: 'mark-strip' },
    h('span', { class: 'muted small' }, sector === null || sector === undefined ? '标注（先选扇区）：' : '标注：'),
    ...stripCodes(game.mode, sector).map((code) => {
      const markState = notes[`${sector}:${code}`] || 'maybe';
      const open = ui.mark && ui.mark.sector === sector && ui.mark.code === code;
      const tutorialMark = game.tutorial?.interaction === 'mark' && expected?.sector === sector && expectedCode === code;
      return h(
        'button',
        {
          class: `mark-chip mark-${markState}${open ? ' open' : ''}${tutorialMark ? ' tutorial-target' : ''}`,
          'data-tutorial-target': tutorialMark ? 'object' : null,
          'aria-describedby': tutorialMark ? 'tutorial-instruction' : null,
          disabled: sector === null || sector === undefined,
          title: `${LABEL[CODE_TO_TYPE[code]]}：${markState === 'yes' ? '确定存在' : markState === 'no' ? '不存在' : '可能存在'}（点击标注）`,
          onclick: () => api.openMark(sector, code),
        },
        iconEl(code, 18),
        h('span', { class: 'mark-chip-name' }, LABEL[CODE_TO_TYPE[code]]),
        h('span', { class: 'mark-chip-tag' }, markState === 'yes' ? '✓' : markState === 'no' ? '✗' : '·'),
      );
    }),
  );

  const legend = h(
    'div',
    { class: 'map-legend small muted' },
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-sample' }, iconEl(CODE.asteroid, 16)), '可能存在'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-sample halo' }, iconEl(CODE.comet, 16)), '确定存在'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-sample struck' }, iconEl(CODE.gasCloud, 16)), '不存在'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-sample' }, iconAtEventSample('conference')), '会议扇区'),
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-sample' }, iconAtEventSample('theory')), '学术研究阶段'),
  );

  const notesCount = Object.keys(notes || {}).length;
  const noteActions = h(
    'div',
    { class: 'map-note-actions' },
    h('span', { class: 'muted small' }, `手写标注 ${notesCount} 处（点图标即可标注）`),
    onClearNotes
      ? h(
          'button',
          { class: 'btn ghost small', disabled: !notesCount, onclick: onClearNotes },
          '清空标注',
        )
      : null,
  );

  return h(
    'section',
    { class: 'card map-card', ...tutorialFocusProps(game, game.tutorial?.focus === 'timeline' ? 'timeline' : 'map') },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, '星图'),
      h('span', { class: 'muted small' }, '我的标注 · 仅自己可见'),
    ),
    h(
      'div',
      { class: 'map-card-body' },
      h(
        'aside',
        { class: 'map-research-rail', 'aria-label': '学术研究提交结果' },
        renderTheoriesPanel({ state, api, game, onReview: api.recordTheoryReview }),
      ),
      h('div', { class: 'map-main' },
        h('div', { class: 'board-wrap' }, boardEl, renderMarkPopover({ state, api })),
        h('div', { class: 'map-side' }, detail, strip, legend,
          h('div', { class: 'map-meta' }, noteActions,
            renderDisclosure(
              { state, api, id: 'map-events', title: '时间轨位置', heading: 'span', className: 'map-event-reference' },
              h('p', { class: 'muted small' }, `会议扇区 ${(game.conferenceSectors || []).join('、')} · 理论阶段 ${(game.theorySectors || []).join('、')}${hasTheories ? ' · 理论轨道 4→1' : ''}`),
            ),
          ),
        ),
      ),
    ),
  );
}

/** A tiny standalone copy of the time-track glyph, for the legend. */
function iconAtEventSample(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('class', 'icon');
  const color = kind === 'conference' ? '#f5b942' : '#a78bfa';
  if (kind === 'conference') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: 1, y: 2, width: 16, height: 11, rx: 3.5, fill: color }).forEach(([k, v]) => rect.setAttribute(k, String(v)));
    const tail = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    tail.setAttribute('d', 'M7 13 L4 17 L10 13 Z');
    tail.setAttribute('fill', color);
    svg.append(rect, tail);
  } else {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: 2, y: 1, width: 14, height: 16, rx: 3, fill: color }).forEach(([k, v]) => rect.setAttribute(k, String(v)));
    const lines = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    lines.setAttribute('d', 'M5 6 H13 M5 9 H13 M5 12 H9');
    lines.setAttribute('stroke', 'rgba(9,14,28,0.75)');
    lines.setAttribute('stroke-width', '1.6');
    lines.setAttribute('stroke-linecap', 'round');
    lines.setAttribute('fill', 'none');
    svg.append(rect, lines);
  }
  return svg;
}


export function renderHeader({ state, api }) {
  const { game } = state;
  const online = Boolean(state.remote);
  return h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'logo' }, '◍'),
      h('div', {}, h('h1', {}, 'X行星之谜'), h('p', { class: 'muted small' }, game.playMode === 'builtin' ? '内置谜题 · 独立推理，无需外部 app' : '记录模式 · 致敬 The Search for Planet X')),
    ),
    h(
      'div',
      { class: 'topbar-actions' },
      online
        ? h('span', { class: 'pill room-pill' }, `房间 ${state.remote.roomId}`, h('span', { class: `net net-${state.netStatus}` }, state.netStatus === 'online' ? '已连接' : '重连中'))
        : h('span', { class: 'pill' }, '单机记录台'),
      h(
        'button',
        { class: 'btn ghost', 'data-modal-trigger': 'lobby', onclick: () => api.setUi({ modal: { kind: 'lobby' } }) },
        online ? '房间' : '联机',
      ),
      h('button', { class: 'btn ghost', 'data-modal-trigger': 'help', onclick: () => api.setUi({ modal: { kind: 'help' } }) }, '规则'),
      h('button', { class: 'btn ghost', onclick: () => api.saveArchive() }, '存档'),
      h('button', { class: 'btn ghost', 'data-modal-trigger': 'archives', onclick: () => api.openArchiveLibrary() }, '加载存档'),
      h('button', { class: 'btn ghost', 'data-modal-trigger': 'start', onclick: () => api.setUi({ modal: { kind: 'start' } }) }, '新对局'),
    ),
  );
}

/** Name of the player an entry belongs to (online rooms only). */
function actorLabel(game, entry) {
  if (!entry || !entry.actorId || !Array.isArray(game.players)) return null;
  const player = game.players.find((p) => p.id === entry.actorId);
  return player ? player.name : '某位玩家';
}

export const renderStatus = renderConsoleStatus;

function stat(label, value, sub) {
  return h(
    'div',
    { class: 'stat', title: sub },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value),
  );
}

function eventDeparture(sector, mode) {
  return `天窗起点离开 ${sector} 号事件标记（${sector}→${mod(sector, mode.sectors) + 1} 号）`;
}

export function renderConsoleStatus({ state, api }) {
  const { game } = state;
  const start = game.visibleStart;
  const end = mod(start + game.mode.visible - 1, game.mode.sectors);
  const confSectors = game.conferenceSectors || [];
  const theorySectors = game.theorySectors || [];
  const open = game.status === 'open' && (!game.phase || game.phase === 'play');
  const frozen = ['final', 'reveal', 'done', 'finished'].includes(game.phase || game.status);
  const reviewOpen = Boolean(game.awaitingReview?.length);
  const pendingEvents = pendingUiEvents(game);
  const researchOpen = pendingEvents.theory && (game.research || game.theoryPhaseOpen) ? pendingEvents.theory : null;
  const conferenceOpen = pendingEvents.conference && game.conference;
  const dueConference = pendingEvents.conference && !conferenceOpen ? pendingEvents.conference : null;

  return h(
    'section',
    { class: 'card status-card' },
    h(
      'div',
      { class: 'status-grid' },
      stat('我的时间', h('span', {}, game.timeLabel, h('span', { class: 'status-elapsed muted' }, `累计耗时 ${durationLabel(game.time)}`)), `我的棋子在第 ${(game.players || []).find((p) => p.isMe)?.sector || mod(game.time, game.mode.sectors) + 1} 号扇区（已记录 ${game.recordCount} 条）`),
      stat(
        '当前天窗',
        `${start + 1}–${end + 1}`,
        frozen
          ? `终局天窗已冻结：箭头在 ${game.arrowSector} 号扇区`
          : game.windowPlayerName
          ? `跟着最靠后的 ${game.windowPlayerName}：箭头在 ${game.arrowSector} 号扇区`
          : `按我的时间：箭头在 ${game.arrowSector} 号扇区`,
      ),
      stat('扫描剩余', `${game.targetUses} / ${MAX_TARGET_USES}`, '剩余可用的扫描标记'),
      stat(
        '阶段',
        frozen ? '终局' : reviewOpen ? '同行评审' : researchOpen ? '学术研究' : conferenceOpen ? 'X行星会议' : dueConference ? '该开会了' : '自由推理',
        `会议 ${confSectors.join('、')} · 学术研究 ${theorySectors.join('、')}`,
      ),
    ),
    researchOpen
      ? h(
          'div',
          { class: 'deduced-flag event-now' },
          game.phase
            ? `学术研究阶段：${eventDeparture(researchOpen.sector, game.mode)}，全桌先选篇数，再按累计耗时从少到多提交；同格先到者在后，先行动、先提交。`
            : `${eventDeparture(researchOpen.sector, game.mode)}，触发学术研究阶段：可以提交理论，也可以直接完成本阶段。`,
        )
      : conferenceOpen
        ? h(
            'div',
            { class: 'deduced-flag event-now' },
            `X行星会议：${eventDeparture(conferenceOpen.sector, game.mode)}——${game.playMode === 'builtin' ? '系统自动公布本次会议线索。' : '去官方 app 查看规律，然后填进右侧「X行星会议」栏。'}`,
          )
        : dueConference &&
          h(
            'div',
            { class: 'deduced-flag event-now' },
            `${eventDeparture(dueConference.sector, game.mode)}：X行星会议召开，请在右侧「X行星会议」栏记录 app 给出的规律。`,
          ),
    game.phase === 'play' && game.turnPlayerName
      ? h(
          'div',
          { class: `turn-banner${game.isMyTurn ? ' mine' : ''}` },
          h('span', { class: 'turn-label' }, '现在轮到'),
          h('span', { class: 'turn-name' }, game.turnPlayerName),
          h(
            'span',
            { class: 'muted small' },
            game.isMyTurn
              ? '（我的回合）'
              : '（可以先标注和看线索）',
          ),
        )
      : null,
    game.phase === 'lobby' ? h('div', { class: 'turn-banner' }, '开局前：等房主点「开始游戏」') : null,
    game.amSpectator ? h('div', { class: 'turn-banner' }, '观战中：可查看所有人行动结果，不参与操作也不占用游戏名额') : null,
    game.phase === 'setup' && !game.amSpectator
      ? h('div', { class: 'turn-banner' }, `开局准备：${game.playMode === 'builtin' ? `每人自动分发 ${game.initialClueCount ?? 4} 条初始线索，请确认准备` : `填写全桌统一的 ${game.initialClueCount ?? 4} 条初始线索，房主填写课题与会议标题`}（已提交 ${game.readyCount || 0}/${game.playerCount || 0}）`)
      : null,
    frozen ? h('div', { class: 'turn-banner' }, game.phase === 'final' ? `最后机会：等待 ${game.endgame?.cursorName || '其他玩家'}；普通行动已关闭` : game.status === 'finished' ? '全盘已揭示，本局已结束' : '等待填写官方 app 的完整答案，之后结算全部理论') : null,
    renderDisclosure(
      { state, api, id: 'status-tools', title: game.playMode === 'builtin' ? '时间轨与模式说明' : '校准与记录说明', className: 'status-tools', heading: 'span' },
      h('div', { class: 'status-actions' },
      game.playMode !== 'builtin' && h('button', { class: 'btn ghost', disabled: !open, onclick: () => api.nudgeWindow(-1), title: '按实体版的天窗位置手动回退一格' }, '天窗 ◀'),
      game.playMode !== 'builtin' && h('button', { class: 'btn ghost', disabled: !open, onclick: () => api.nudgeWindow(1), title: '按实体版的天窗位置手动前进一格' }, '天窗 ▶'),
      game.playMode !== 'builtin' && h(
        'button',
        { class: 'btn ghost', disabled: !open || game.recordCount === 0, onclick: () => api.consoleAction({ kind: 'undo' }) },
        '撤销最后一条',
      ),
      ),
      h('p', { class: 'small muted' }, `会议 ${confSectors.join('、')} 号；学术研究 ${theorySectors.join('、')} 号，均在天窗起点离开事件标记时触发。${game.windowPlayerName ? `天窗跟随累计耗时最少的 ${game.windowPlayerName}。` : '天窗跟随我的时间。'}累计耗时优先；同格先到者在后，先行动、先提交，后来者排在顺时针前方。`),
      h('p', { class: 'console-note small muted' }, game.playMode === 'builtin'
        ? '内置谜题：观测、会议、同行评审与定位由系统自动判定。查询结果仅本人可见，完整答案只在终局揭晓；不能撤销已获得的线索。'
        : state.remote
        ? '时间轨、行动历史、学术研究与会议线索全桌共享。勘测数量、扫描结果、研究线索和未公开的理论天体仅本人可见；观战者例外，可看到所有人结果。'
        : '本页不生成谜题、不判定对错；请记录官方 app 或实体版给出的结果。'),
    ),
    Array.isArray(game.players)
      ? h(
          'div',
          { class: 'player-bar' },
          ...game.players.map((p) =>
            h(
              'span',
              {
                class: `player-chip${p.isMe ? ' me' : ''}${p.isTurn ? ' turn' : ''}${p.pendingReviews ? ' review' : ''}`,
                style: p.isTurn ? undefined : { borderColor: p.color },
                title: p.isTurn ? '当前正在行动' : undefined,
              },
              h('span', { class: 'dot', style: { background: p.color } }),
              p.name,
              p.host ? h('span', { class: 'muted small' }, ' · 房主') : null,
              p.bot ? h('span', { class: 'muted small' }, ' · Bot') : null,
              p.spectator ? h('span', { class: 'muted small' }, ' · 观战') : null,
              p.spectator ? null : h('span', { class: 'pawn-time' }, `${p.timeLabel} · ${p.sector} 号`),
              p.isTurn ? h('span', { class: 'turn-badge' }, '行动中') : null,
              p.pendingReviews ? h('span', { class: 'muted small warn' }, ' · 待评审') : null,
            ),
          ),
        )
      : null,
  );
}

function researchPhase(game) {
  return game.research || null;
}

/** The record console's action panel: launch an action, then fill in what the app said. */
/** Subjects are a Set locally and an array over the wire; accept both. */
function hasResearched(game, id) {
  const done = game.researched;
  if (!done) return false;
  if (typeof done.has === 'function') return done.has(id);
  return Array.isArray(done) && done.includes(id);
}

/** In an online game you may only act on your own turn. */
function turnBlocked(game) {
  return game.phase === 'play' && game.isMyTurn === false;
}

/** The console's action panel: pick an action, then fill in what the app told you. */
export const renderActionPanel = renderRecordPanel;

export function renderRecordPanel({ state, api }) {
  const { game, ui } = state;
  const phase = game.phase || 'play';
  const tutorial = game.tutorial;
  if (tutorial?.completed && ['done', 'finished'].includes(phase)) return renderEndgame({ game, ui, api });
  if (tutorial && (tutorial.completed || tutorial.interaction !== 'action' || tutorial.actor !== 'human')) {
    return h('section', { class: 'card action-card tutorial-wait' },
      h('h2', {}, tutorial.completed ? '教学已完成' : '教学进行中'),
      h('p', { class: 'muted small' }, tutorial.completed
        ? '可在教学指南中重新教学或退出，查看本局揭晓与计分。'
        : tutorial.interaction === 'inspect' || tutorial.interaction === 'mark'
          ? '请按教学指南在星图中完成查看或标注，无需选择其他行动。'
          : '请使用教学指南中的按钮继续；本步不需要其他行动。'),
    );
  }
  if (phase === 'lobby') return lobbyCard({ game, api });
  if (game.amSpectator) return spectatorCard({ game });
  if (phase === 'setup') return setupCard({ state, api });
  const endgame = renderEndgame({ game, ui, api });
  if (endgame) return endgame;

  const closed = game.status !== 'open';
  const research = researchPhase(game);
  const review = reviewPrompt({ game, api });
  const expected = tutorialExpected(game);
  const expectedAction = expected?.kind === 'target' ? 'scan' : expected?.kind;
  const action = tutorial && ui.action !== expectedAction ? 'idle' : ui.action || 'idle';
  if (game.awaitingReview?.length) {
    return h(
      'section',
      { class: 'card action-card record-card' },
      h('h2', {}, '等待同行评审'),
      review,
      h('p', { class: 'muted small' }, '先完成所有到期论文的评审，再继续行动。未到期的隐藏理论仍然保密。'),
    );
  }
  if (!game.phase && game.theoryPhaseOpen) {
    const used = game.theoryUsedThisPhase || 0;
    return h(
      'section',
      { class: 'card action-card record-card' },
      h('h2', {}, '学术研究阶段'),
      h('p', { class: 'muted small' }, `${eventDeparture(game.theoryPhase.sector, game.mode)}，触发本阶段。已提交 ${used}/${game.theoryQuota} 篇；也可以不提交。`),
      action === 'theory'
        ? theoryCard({ game, ui, api })
        : h('button', { class: 'action-tile', disabled: used >= game.theoryQuota, onclick: () => api.startAction('theory') }, '提交学术研究'),
      h('div', { class: 'action-buttons' }, h('button', { class: 'btn primary', onclick: () => api.consoleAction({ kind: 'theory-complete' }) }, '完成本阶段')),
      h('p', { class: 'muted small' }, '完成时所有未评审论文一起向内推进一格，即使本阶段没有新论文。'),
    );
  }
  // while the research phase runs, the publishing flow replaces the action launcher
  const blocked = !research && turnBlocked(game);
  const waiting = blocked ? `现在轮到 ${game.turnPlayerName || '别人'} 行动` : null;

  return h(
    'section',
    { class: 'card action-card record-card', ...tutorialFocusProps(game, tutorial?.focus) },
    h('h2', {}, '行动', closed ? h('span', { class: 'muted small' }, '（本局已结束）') : null),
    review,
    research ? researchCard({ game, research, ui, api }) : null,
    blocked
      ? h(
          'div',
          { class: 'turn-wait' },
          `等 ${game.turnPlayerName || '其他玩家'} 行动（他耗时最少；你可以标注星图、查看已有线索）`,
        )
      : null,
    research || (tutorial && !['survey', 'scan', 'research'].includes(expectedAction))
      ? null
      : closed || action === 'idle'
        ? actionLauncher({ game, api, closed, blocked, waiting })
        : null,
    !research && action === 'survey' ? surveyCard({ game, ui, api }) : null,
    !research && action === 'scan' ? scanCard({ game, ui, api }) : null,
    !research && action === 'research' ? researchClueCard({ state, game, ui, api }) : null,
    !research && action === 'theory' ? theoryCard({ game, ui, api }) : null,
    !research && action === 'idle' && !closed && game.playMode !== 'builtin' ? conferenceBlock({ state, game, ui, api }) : null,
    research || action !== 'idle' || (tutorial && expectedAction !== 'locate')
      ? null
      : h(
          'div',
          { class: 'action-block locate-block' },
          h('h3', {}, '定位 X行星', h('span', { class: 'muted small' }, game.playMode === 'builtin' ? ' 提交位置与左右邻居，系统判定' : ' 记下你在实体版提交的答案')),
          h(
            'button',
            {
              class: 'btn primary big',
              'data-modal-trigger': 'locate',
              ...tutorialTargetProps('action', expectedAction === 'locate'),
              disabled: closed || blocked,
              onclick: () => api.openLocate(),
            },
            closed ? '本局已结束' : blocked ? `等 ${game.turnPlayerName || '别人'} 行动` : game.playMode === 'builtin' ? '尝试定位 X行星' : '记录定位结果',
          ),
        ),
  );
}

/**
 * When one of my papers has reached the review slot, the app has to be asked and the
 * result typed back in — that is what settles a sector (and a wrong one costs a month).
 */
function reviewPrompt({ game, api }) {
  if (game.playMode === 'builtin') return null;
  const ids = (game.amHost ? game.awaitingReview : game.myPendingReviews) || [];
  if (!ids.length) return null;
  const awaiting = (game.knowledge.theories || []).filter((theory) => theory.review === 'pending' && theory.slot <= 1);
  const nextSector = Math.min(...awaiting.map((theory) => theory.sector));
  const pending = awaiting.filter((theory) => theory.sector === nextSector && ids.includes(theory.id));
  if (!pending.length) return h('p', { class: 'muted small' }, `请等待作者或房主完成 ${nextSector + 1} 号扇区的评审，再处理你的论文。`);
  return h(
    'div',
    { class: 'action-block review-prompt' },
    h('h3', {}, '同行评审', h('span', { class: 'muted small' }, ` ${pending.length} 篇走到了评审轨道最后一格`)),
    ...pending.map((t) =>
      h(
        'div',
        { class: 'review-row' },
        h(
          'span',
          { class: 'row-main' },
          `${t.sector + 1} 号扇区 · ${actorLabel(game, t) || '我'}提交的是 ${labelOf(t.objectType)}`,
        ),
        h('button', { class: 'btn ghost small ok', onclick: () => api.recordTheoryReview(t.id, 'correct') }, '正确'),
        h('button', { class: 'btn ghost small bad', onclick: () => api.recordTheoryReview(t.id, 'wrong') }, '错误（罚 1 个时间单位）'),
      ),
    ),
    h('p', { class: 'muted small' }, '在官方 app 里触发同行评审，然后把结果填回来：正确会公开该扇区，错误会让你的棋子前进 1 个时间单位。'),
  );
}

/** Before the game: the table gathers, the host starts. */
function initialCluePicker({ value = 4, onPick, readOnly = false }) {
  return h('div', { class: 'initial-clue-settings' },
    h('h3', {}, '统一初始线索'),
    h('p', { class: 'muted small' }, `每人 ${value} 条初始线索 · 房主统一设置，开局后锁定。`),
    readOnly ? null : h('div', { class: 'chips initial-clue-counts', role: 'group', 'aria-label': '全桌初始线索数量' },
      INITIAL_CLUE_COUNTS.map(count => h('button', {
        type: 'button',
        class: `chip chip-select${count === value ? ' active' : ''}`,
        'data-initial-clue-count': count,
        'aria-pressed': String(count === value),
        onclick: () => onPick(count),
      }, `${count} 条`)),
    ),
  );
}

function botOpponentPicker({ value = 0, onPick, max = BUILTIN_MAX_PLAYERS - 1 }) {
  const counts = Array.from({ length: max + 1 }, (_, i) => i);
  return h(
    'div',
    { class: 'lobby-field bot-opponent-settings' },
    h('span', { class: 'muted small' }, 'Bot 对手（可选）'),
    h(
      'div',
      { class: 'chips', role: 'group', 'aria-label': 'Bot 对手数量' },
      counts.map((count) =>
        h(
          'button',
          {
            type: 'button',
            class: `chip chip-select${count === value ? ' active' : ''}`,
            'data-with-bots': count,
            'aria-pressed': String(count === value),
            onclick: () => onPick(count),
          },
          count === 0 ? '无' : `${count} 个`,
        ),
      ),
    ),
    h('p', { class: 'muted small' }, countHint(value, max)),
  );
}

function countHint(value, max) {
  if (!value) return `可不加 Bot，也可与真人合计最多 ${max + 1} 人（含你）。Bot 用启发式策略，看不到谜底。`;
  return `将创建 ${value} 个 Bot 对手，与你合计 ${value + 1} 人（上限 ${max + 1}）。开局后 Bot 自动行动。`;
}

function lobbyCard({ game, api }) {
  const players = game.players || [];
  const seated = players.filter((p) => !p.spectator);
  const spectators = players.filter((p) => p.spectator);
  const enough = (game.playerCount || seated.length) >= (game.playMode === 'builtin' ? 1 : 2);
  return h(
    'section',
    { class: 'card action-card record-card' },
    h('h2', {}, '开局前'),
    h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '桌上的玩家', h('span', { class: 'muted small' }, ` ${seated.length} 人${spectators.length ? ` · 观战 ${spectators.length}` : ''}`)),
      h(
        'div',
        { class: 'player-bar' },
        ...players.map((p) =>
          h(
            'span',
            { class: `player-chip${p.id === game.me ? ' me' : ''}`, style: { borderColor: p.color } },
            h('span', { class: 'dot', style: { background: p.color } }),
            p.name,
            p.host ? h('span', { class: 'muted small' }, ' · 房主') : null,
            p.bot ? h('span', { class: 'muted small' }, ' · Bot') : null,
            p.spectator ? h('span', { class: 'muted small' }, ' · 观战') : null,
            p.id === game.me ? h('span', { class: 'muted small' }, ' · 你') : null,
          ),
        ),
      ),
      h('p', { class: 'muted small' }, game.tutorial ? '固定双人教学：你与 Bot「领航员」，无需邀请其他玩家。' : `房间码 ${game.roomId}：让别人在自己的设备上打开本页 → 「联机」→「加入房间」。可选择玩家或观战；观战不占用 ${BUILTIN_MAX_PLAYERS} 个游戏名额。`),
    ),
    initialCluePicker({ value: game.initialClueCount ?? 4, readOnly: !game.amHost || Boolean(game.tutorial), onPick: count => api.setInitialClueCount(count) }),
    h(
      'div',
      { class: 'action-block' },
      h('h3', {}, '开始游戏'),
      enough
        ? h(
            'p',
            { class: 'muted small' },
            game.amHost ? (game.tutorial ? '教学固定使用标准棋盘与 4 条初始线索。' : game.playMode === 'builtin' ? '可以单人开始，也可以先邀请朋友。开始后系统按全桌统一数量自动分发私有初始线索，每人确认准备；开局后不再接受新玩家（观战仍可中途加入）。' : '人齐了就可以开始。开始后每人填写指定数量的初始线索，由房主填写全桌课题名称，然后进入第一轮。') : '等房主点「开始游戏」。',
          )
        : h('p', { class: 'muted small' }, '至少需要 2 名玩家才能开始；单人玩请用「离开房间」回到单机记录台。'),
      h(
        'div',
        { class: 'action-buttons' },
        h(
          'button',
          { class: 'btn primary', disabled: !game.canStart, onclick: () => api.startGame() },
          game.amHost ? (enough ? '开始游戏' : '还差一位玩家') : '等房主开始',
        ),
      ),
    ),
  );
}

function spectatorCard({ game }) {
  const phaseLabel = game.phase === 'setup' ? '开局准备中'
    : game.phase === 'lobby' ? '等待开局'
      : game.phase === 'final' || game.phase === 'reveal' || game.status === 'finished' || game.phase === 'done' ? '本局收尾'
        : '对局进行中';
  return h(
    'section',
    { class: 'card action-card record-card' },
    h('h2', {}, '观战模式'),
    h('p', { class: 'pick-status' }, phaseLabel),
    h('p', { class: 'muted small' }, '你可以查看所有玩家的勘测数量、扫描结果、研究线索与未公开论文内容，但不能提交行动、领取线索或占用游戏名额。'),
    game.turnPlayerName ? h('p', { class: 'muted small' }, `当前行动者：${game.turnPlayerName}`) : null,
  );
}

/** After the start: initial clues + the six subject names, then the first round. */
function setupCard({ state, api }) {
  const { game, ui } = state;
  const mine = game.mySetup || { clues: [], noClues: false, topics: {}, ready: false };
  const count = game.initialClueCount ?? 4;
  if (game.playMode === 'builtin') {
    const claimed = mine.cluesClaimed === true;
    const canReady = claimed && !mine.ready && !ui.actionBusy;
    return h(
      'section',
      { class: 'card action-card record-card builtin-setup' },
      h('h2', {}, '你的初始线索'),
      h('p', { class: 'muted small' }, `全桌统一 ${count} 条初始线索，由房主在开局前设置；开局后不能更改数量或重新抽取。`),
      claimed
        ? h('p', { class: 'pick-status' }, `已自动收到 ${count} 条初始线索。${count === 0 ? '没有初始排除线索，可以直接确认准备。' : '排除信息已同步到你的星图。'}`)
        : h('p', { class: 'pick-status', role: 'status' }, '正在同步房间分发的初始线索，请稍候。'),
      claimed && h('ul', { class: 'builtin-clues' }, (mine.clues || []).map((clue) => h('li', {}, `${clue.sector + 1} 号扇区没有${LABEL[clue.type]}。`))),
      h('p', { class: 'muted small' }, '初始线索只排除小行星、彗星、气体云或矮行星，不提供空域信息；线索和标注仅你自己可见。'),
      h('p', { class: 'muted small' }, '研究 A–F 获取更多线索；会议线索会随时间轨推进自动公布。扫描显示空域时，仍有可能是 X行星。'),
      readyList(game),
      h('button', { class: 'btn primary big', disabled: !canReady, onclick: () => { if (canReady) api.submitSetup(); } }, mine.ready ? game.tutorial ? '已准备，等待教学继续' : '已准备，等待其他玩家' : '我已准备，开始推理'),
    );
  }
  const draft = ui.setup || api.setupDraft();
  // edits merge into the live draft (not a stale render-time copy), so several
  // text fields can be typed into without clobbering each other
  const patch = (fnOrPatch, quiet = false) => api.patchSetup(fnOrPatch, quiet);

  if (mine.ready) {
    return h(
      'section',
      { class: 'card action-card record-card' },
      h('h2', {}, '开局准备'),
      h('div', { class: 'action-block' }, h('div', { class: 'turn-wait good' }, '你已提交，等其他人填写…')),
      sharedInfoBlock({ game, api, readOnly: true }),
      readyList(game),
      h(
        'div',
        { class: 'action-buttons' },
        h('button', { class: 'btn ghost', onclick: () => api.reopenSetup() }, '重新填写'),
      ),
    );
  }

  const clues = draft.clues || [];
  const clueTypes = sector => CLUE_TYPES.filter(type => type !== Obj.COMET || isCometSector(game.mode, sector));
  const validClues = clues.filter(clue => Number.isInteger(clue.sector) && clue.sector >= 0 && clue.sector < game.mode.sectors && clueTypes(clue.sector).includes(clue.type));
  const uniqueCount = new Set(validClues.map(clue => `${clue.sector}:${clue.type}`)).size;
  const canSubmit = !ui.actionBusy && (count === 0 || (clues.length === count && uniqueCount === count));
  const clueRows = clues.map((clue, index) =>
    h(
      'div',
      { class: 'clue-row' },
      h(
        'select',
        {
          'aria-label': `第 ${index + 1} 条线索的扇区`,
          onchange: event => {
            const sector = Number(event.target.value);
            patch(current => ({ noClues: false, clues: current.clues.map((entry, clueIndex) => clueIndex === index ? { ...entry, sector, type: clueTypes(sector).includes(entry.type) ? entry.type : clueTypes(sector)[0] } : entry) }));
          },
        },
        Array.from({ length: game.mode.sectors }, (unused, sector) =>
          h('option', { value: sector, selected: sector === clue.sector }, `${sector + 1} 号`),
        ),
      ),
      h('span', { class: 'muted small' }, '没有'),
      h(
        'select',
        {
          'aria-label': `第 ${index + 1} 条线索排除的天体`,
          onchange: event => patch(current => ({ noClues: false, clues: current.clues.map((entry, clueIndex) => clueIndex === index ? { ...entry, type: event.target.value } : entry) })),
        },
        clueTypes(clue.sector).map(type => h('option', { value: type, selected: type === clue.type }, LABEL[type])),
      ),
      h(
        'button',
        { class: 'btn ghost small', 'aria-label': `删除第 ${index + 1} 条线索`, onclick: () => patch(current => ({ clues: current.clues.filter((entry, clueIndex) => clueIndex !== index) })) },
        '删除',
      ),
    ),
  );

  return h(
    'section',
    { class: 'card action-card record-card' },
    h('h2', {}, '开局准备'),
    h(
      'div',
      { class: 'action-block' },
      h(
        'h3',
        {},
        '① 初始线索',
        h('span', { class: 'muted small' }, ` 全桌统一 ${count} 条，请填写相同数量的不同排除线索`),
      ),
      count === 0 ? h('p', { class: 'muted small' }, '房主设置了 0 条初始线索，无需填写。') : clueRows,
      count === 0
        ? null
        : h(
            'div',
            { class: 'clue-add' },
            h('span', { class: 'muted small', role: 'status' }, `有效线索 ${uniqueCount}/${count} 条${validClues.length > uniqueCount ? ' · 有重复项，请修改或删除' : ''}${validClues.length < clues.length ? ' · 有不合法的线索，请修改' : ''}`),
            clues.length >= count
              ? null
              : h(
                  'button',
                  { class: 'btn ghost small', onclick: () => patch(current => {
                    const currentClues = current.clues || [];
                    if (currentClues.length >= count) return {};
                    const available = Array.from({ length: game.mode.sectors }, (unused, sector) => clueTypes(sector).map(type => ({ sector, type }))).flat();
                    const next = available.find(candidate => !currentClues.some(entry => entry.sector === candidate.sector && entry.type === candidate.type));
                    return next ? { noClues: false, clues: [...currentClues, next] } : {};
                  }) },
                  '+ 添加一条线索',
                ),
          ),
      h('p', { class: 'muted small' }, '只记录小行星、彗星、气体云或矮行星的排除线索，不提供空域信息，别人看不到。'),
    ),
    sharedInfoBlock({ game, api, readOnly: !game.amHost, draft, onPatch: (fn) => patch(fn, true) }),
    readyList(game),
    h(
      'div',
      { class: 'action-buttons' },
      h(
        'button',
        { class: 'btn primary', disabled: !canSubmit, onclick: () => {
          if (!canSubmit) return;
          patch({ noClues: count === 0, ...(count === 0 ? { clues: [] } : {}) }, true);
          api.submitSetup();
        } },
        game.readyCount + 1 >= game.playerCount ? '完成，开始第一轮' : '完成，等其他人',
      ),
    ),
  );
}

/**
 * ② the six subject names and ③ the conference notes. Both are the same for the whole
 * table (the notes only exist on the sectors this board holds a conference on), so the
 * host fills them in once and everybody else reads them.
 */
function sharedInfoBlock({ game, api, readOnly, onPatch, draft }) {
  const names = (draft && draft.topicNames) || game.topicNames || {};
  const conferenceNames = (draft && draft.conferenceNames) || game.conferenceNames || {};
  const rules = readOnly ? Object.fromEntries((game.knowledge.conferences || []).map(entry => [entry.sector, entry.text])) : (draft && draft.conferences) || game.conferenceRules || {};
  const confSectors = game.conferenceRuleSectors || game.conferenceSectors || [];
  const edit = (fn) => onPatch && onPatch(fn);

  const nameInputs = h(
    'div',
    { class: 'topic-names' },
    TOPIC_IDS.map((id) => {
      const input = h('input', {
        class: 'text-input slim',
        type: 'text',
        disabled: readOnly,
        placeholder: `课题 ${id} 的名称`,
        oninput: (e) => edit((s) => ({ topicNames: { ...(s.topicNames || {}), [id]: e.target.value } })),
      });
      input.value = names[id] || '';
      return h('label', { class: 'topic-name-row' }, h('span', { class: 'row-tag' }, id), input);
    }),
  );

  const confInputs = confSectors.map((sector) => {
    const titleInput = h('input', {
      class: 'text-input slim',
      type: 'text',
      disabled: readOnly,
      'data-conference-name': sector,
      'aria-label': `${sector} 号会议标题`,
      placeholder: `X行星会议 · ${sector} 号`,
      oninput: event => edit(current => ({ conferenceNames: { ...(current.conferenceNames || {}), [sector]: event.target.value } })),
    });
    titleInput.value = conferenceNames[sector] || '';
    const input = h('textarea', {
      class: 'text-input',
      rows: 2,
      disabled: readOnly,
      'aria-label': `${sector} 号会议线索正文`,
      placeholder: `扇区 ${sector} 的 X行星会议规律`,
      oninput: (e) => edit((s) => ({ conferences: { ...(s.conferences || {}), [sector]: e.target.value } })),
    });
    input.value = rules[sector] || '';
    return h('div', { class: 'conf-row' },
      h('span', { class: 'row-tag' }, `扇区 ${sector}`),
      h('div', { class: 'conf-fields' },
        h('label', {}, h('span', { class: 'muted small' }, '公开标题'), titleInput),
        h('label', {}, h('span', { class: 'muted small' }, '会议线索正文（召开后公开）'), input),
      ),
    );
  });

  return h(
    'div',
    { class: 'action-block shared-block' },
    h(
      'h3',
      {},
      '② 研究课题名称',
      h('span', { class: 'muted small' }, readOnly ? ' 全桌一致，由房主填写' : ' A–F 六个课题名，全桌一致，只有房主填'),
    ),
    nameInputs,
    h(
      'h3',
      { class: 'shared-gap' },
      '③ X行星会议',
      h('span', { class: 'muted small' }, confSectors.length > 1 ? ` 本局 2 场：${confSectors.join('、')} 号扇区` : ` 本局 1 场：${confSectors.join('、')} 号扇区`),
    ),
    confInputs,
    h(
      'p',
      { class: 'muted small' },
      readOnly
        ? '标题全桌可见；会议召开后才公开线索正文，可在行动栏补记。'
        : '标题从开局就公开，留空使用默认名称。线索正文与标题分开记录，会议召开后才公开；也可以开会时在行动栏补记。',
    ),
  );
}

function readyList(game) {
  const players = game.players || [];
  return h(
    'div',
    { class: 'action-block' },
    h('h3', {}, '准备情况', h('span', { class: 'muted small' }, ` ${game.readyCount || 0}/${players.length}`)),
    h(
      'div',
      { class: 'player-bar' },
      ...players.map((p) =>
        h(
          'span',
          { class: `player-chip${p.ready ? ' ready' : ''}`, style: { borderColor: p.color } },
          h('span', { class: 'dot', style: { background: p.color } }),
          p.name,
          h('span', { class: 'muted small' }, p.ready ? ' · 已提交' : game.playMode === 'builtin' ? ' · 未准备' : ' · 填写中'),
        ),
      ),
    ),
  );
}

function actionLauncher({ game, api, closed, blocked = false, waiting = null }) {
  const expected = tutorialExpected(game);
  const expectedKind = expected?.kind === 'target' ? 'scan' : expected?.kind;
  const tile = (kind, title, desc, disabled = false) =>
    game.tutorial && kind !== expectedKind ? null : h(
      'button',
      { class: `action-tile${game.tutorial ? ' tutorial-target' : ''}`, 'data-tutorial-target': game.tutorial ? 'action' : null, 'aria-describedby': game.tutorial ? 'tutorial-instruction' : null, disabled: closed || blocked || disabled, onclick: () => api.startAction(kind) },
      h('span', { class: 'tile-title' }, title),
      h('span', { class: 'tile-desc small muted' }, blocked && waiting ? waiting : desc),
    );
  return h(
    'div',
    { class: 'action-block' },
    h('h3', {}, '选择行动', h('span', { class: 'muted small' }, game.playMode === 'builtin' ? ' 选行动 → 提交查询 → 获取线索' : ' 选行动 → 选扇区 → 填写结果')),
    h(
      'div',
      { class: 'action-tiles' },
      tile('survey', '勘测', `范围数量 · ${surveyCost(3)}/${surveyCost(6)}/${surveyCost(9)} 个时间单位`),
      tile('scan', '扫描', `单个扇区 · ${durationLabel(COST.target)} · 剩 ${game.targetUses} 次`, game.targetUses <= 0),
      tile('research', '研究', `A–F 课题线索 · ${durationLabel(COST.research)}`, game.lastWasResearch),
    ),
  );
}

function cardShell(title, hint, body, actions, className = '') {
  return h(
    'div',
    { class: `action-block active-action${className ? ` ${className}` : ''}` },
    h('h3', {}, title, h('span', { class: 'muted small' }, ` ${hint}`)),
    ...body,
    h('div', { class: 'action-buttons' }, ...actions),
  );
}

function confirmButtons(api, label, disabled) {
  return [
    h('button', { class: 'btn primary', disabled, onclick: () => { if (!disabled) api.confirmAction(); } }, label),
    h('button', { class: 'btn ghost', onclick: () => api.cancelAction() }, '取消'),
  ];
}

function surveyCard({ game, ui, api }) {
  const expected = tutorialExpected(game);
  const picks = ui.pick || [];
  const range = api.pickedRange();
  const visible = game.visible || visibleSectorsAt(game.time, game.mode);
  const endpoints = visible.filter((sector) => ui.surveyType !== Obj.COMET || isCometSector(game.mode, sector));
  const validRange = range && range.size <= game.mode.visible
    && endpoints.includes(range.start)
    && endpoints.includes(mod(range.start + range.size - 1, game.mode.sectors))
    && Array.from({ length: range.size }, (unused, offset) => mod(range.start + offset, game.mode.sectors)).every((sector) => visible.includes(sector));
  const endpointField = (label, index) => h('label', {}, label, h('select', {
    'aria-label': `勘测${label}`,
    ...tutorialTargetProps(index === 0 ? 'start' : 'end', expected?.kind === 'survey'),
    disabled: index === 1 && !endpoints.includes(picks[0]),
    onchange: (event) => {
      const sector = event.target.value === '' ? null : Number(event.target.value);
      if (sector !== null && !endpoints.includes(sector)) return;
      if (index === 1 && !endpoints.includes(picks[0])) return;
      api.setUi({ pick: index === 0 ? sector === null ? [] : [sector] : sector === null ? [picks[0]] : [picks[0], sector], selectedSector: sector });
    },
  },
  h('option', { value: '', selected: !endpoints.includes(picks[index]) }, `请选择${label}`),
  endpoints.map((sector) => h('option', { value: sector, selected: sector === picks[index] }, `${sector + 1} 号`))));
  const countInput = h('input', {
    class: 'num-input',
    type: 'number',
    min: 0,
    max: range ? range.size : 9,
    value: String(ui.surveyCount ?? 0),
    oninput: (e) => api.setUiQuiet({ surveyCount: Number(e.target.value) }),
  });
  const status =
    picks.length === 0
      ? '在星图上点「起点」扇区'
      : picks.length === 1
        ? `起点已选 ${picks[0] + 1} 号，再点「终点」扇区`
        : range
          ? `范围：${range.start + 1}–${mod(range.start + range.size - 1, game.mode.sectors) + 1} 号（${range.size} 格）· 耗时 ${durationLabel(surveyCost(range.size))}`
          : '';
  return cardShell(
    '勘测',
    '在星图上点起止扇区，自动算范围与耗时',
    [
      h('p', { class: 'pick-status' }, status),
      h('div', { class: 'range-row' }, endpointField('起点', 0), endpointField('终点', 1)),
      ui.surveyType === Obj.COMET ? h('p', { class: 'muted small' }, '彗星勘测的起点和终点必须是当前可见的质数编号扇区；中间可以经过其他扇区。') : null,
      h(
        'div',
        { class: 'chips' },
        SURVEY_TYPES.map((type) =>
          h(
            'button',
            {
              class: `chip chip-select${ui.surveyType === type ? ' active' : ''}`,
              ...tutorialTargetProps('type', expected?.kind === 'survey' && (expected.type || expected.surveyType) === type),
              style: ui.surveyType === type ? { borderColor: TYPE_COLOR[CODE[type]] } : {},
              onclick: () => api.setUi({ surveyType: type }),
            },
            iconLabel(CODE[type], LABEL[type], { size: 15 }),
          ),
        ),
      ),
      game.playMode === 'builtin' ? h('p', { class: 'muted small' }, '提交后系统返回该范围的天体数量，仅你可见，并自动记入行动历史。') : h(
        'div',
        { class: 'result-row' },
        h('span', { class: 'muted small' }, 'app 给出的数量'),
        countInput,
        h('span', { class: 'muted small' }, '个'),
      ),
    ],
    confirmButtons(api, '确认勘测', !validRange || ui.actionBusy),
  );
}

function scanCard({ game, ui, api }) {
  const sector = (ui.pick || [])[0];
  return cardShell(
    '扫描',
    game.playMode === 'builtin' ? '选择一个可见扇区，系统返回扫描结果' : '在星图上点一个扇区，记下它是什么',
    [
      h(
        'p',
        { class: 'pick-status' },
        Number.isInteger(sector) ? `扇区：${sector + 1} 号 · 耗时 ${durationLabel(COST.target)} · 剩 ${game.targetUses} 次` : '在星图上点一个扇区',
      ),
      game.playMode !== 'builtin' && h(
        'div',
        { class: 'chips' },
        SURVEY_TYPES.map((type) =>
          h(
            'button',
            {
              class: `chip chip-select${ui.targetResult === type ? ' active' : ''}`,
              style: ui.targetResult === type ? { borderColor: TYPE_COLOR[CODE[type]] } : {},
              onclick: () => api.setUi({ targetResult: type }),
            },
            iconLabel(CODE[type], LABEL[type], { size: 15 }),
          ),
        ),
      ),
      h('p', { class: 'muted small' }, game.playMode === 'builtin' ? '结果仅你可见。显示「空域」时也可能是 X行星，不会把它误标成确定的真正空域。' : '确认后会自动在星图上给这个格子的天体打 ✓（扇区必须落在可见天窗里）。'),
    ],
    confirmButtons(api, '确认扫描', !Number.isInteger(sector) || (game.playMode !== 'builtin' && !ui.targetResult) || game.targetUses <= 0 || ui.actionBusy),
  );
}

function researchClueCard({ state, game, ui, api }) {
  const topics = game.topics || {};
  const expected = tutorialExpected(game);
  const nameInput = h('input', {
    class: 'text-input',
    type: 'text',
    placeholder: '课题名称（例如：彗星的分布）',
    oninput: (e) => api.setUiQuiet({ topicName: e.target.value }),
  });
  nameInput.value = ui.topicName || (topics[ui.researchTopic] && topics[ui.researchTopic].name) || '';
  const clueInput = h('textarea', {
    class: 'text-input',
    rows: 3,
    placeholder: '把 app 给出的规律原文抄在这里',
    oninput: (e) => api.setUiQuiet({ clueText: e.target.value }),
  });
  clueInput.value = ui.clueText || '';
  return cardShell(
    '研究',
    `选一个课题（A–F），${durationLabel(COST.research)}`,
    [
      h(
        'div',
        { class: 'topic-grid six' },
        TOPIC_IDS.map((id) => {
          const used = hasResearched(game, id);
          const chosen = ui.researchTopic === id;
          const stored = topics[id] && topics[id].name;
          return h(
            'button',
            {
              class: `topic${used ? ' done' : ''}${chosen ? ' chosen' : ''}`,
              ...tutorialTargetProps('topic', expected?.kind === 'research' && expected.topic === id),
              disabled: used,
              title: used ? '已研究' : `课题 ${id}`,
              onclick: () => api.setUi({ researchTopic: id, topicName: (topics[id] && topics[id].name) || '' }),
            },
            h('span', { class: 'topic-id' }, id),
            h('span', { class: 'topic-title' }, stored || (used ? '已研究' : '未命名')),
          );
        }),
      ),
      h('p', { class: 'muted small' }, game.playMode === 'builtin' ? '每个课题只给一条线索，系统自动提供，仅你可见，并写入研究面板和行动历史。' : '课题名由房主一次填好、全桌共用；你抄下来的规律原文只有自己看得到，并且会写进记录表。'),
      game.playMode === 'builtin' && renderDisclosure(
        { state, api, id: 'research-terms', title: '研究线索怎么读', heading: 'h3' },
        h('p', { class: 'muted small' }, '连续范围：所有同类天体位于某段至多 N 格的连续区域；起点未知，可跨越最后一格和第 1 格。'),
        h('p', { class: 'muted small' }, '同类间隔：没有任何一颗位于其他同类的 N 格以内，N 从 1 格算起，按最短环形距离，包含恰好 N 格。矮行星不用这条；专家盘的矮行星已固定在连续 6 格内。'),
        h('p', { class: 'muted small' }, `相邻是左右一格；正对相隔半圈，本盘为 ${game.mode.sectors / 2} 格。`),
        h('p', { class: 'muted small' }, 'N 格以内按最短环形距离计算，包含恰好 N 格，相邻为 1 格。'),
        h('p', { class: 'muted small' }, '“至少一个”也可能全部符合；“每个A”分别至少对应一个B，并不要求每个B都被对应。'),
      ),
      game.playMode !== 'builtin' && nameInput,
      game.playMode !== 'builtin' && clueInput,
      game.lastWasResearch ? h('p', { class: 'muted small' }, '刚记录过研究，先做别的行动。') : null,
    ],
    confirmButtons(api, '确认研究', !ui.researchTopic || game.lastWasResearch || hasResearched(game, ui.researchTopic)),
  );
}

/** The offline console publishes straight from the card; a room drives its own phase. */
function theoryChoices({ game, ui, api, label }) {
  const options = game.theoryOptions || [];
  const expected = tutorialExpected(game);
  const selected = options.find((option) => option.sector === ui.theorySector);
  const types = selected?.types || [];
  return {
    sector: selected?.sector,
    valid: types.includes(ui.theoryType),
    field: h('label', {}, label, h('select', {
      'aria-label': label,
      ...tutorialTargetProps('sector', Number.isInteger(expected?.sector)),
      onchange: (event) => {
        const sector = Number(event.target.value);
        if (event.target.value !== '' && options.some((option) => option.sector === sector)) api.setUi({ theorySector: sector });
      },
    },
    selected ? null : h('option', { value: '', selected: true }, options.length ? '请选择扇区' : '没有可提交的扇区'),
    options.map((option) => h('option', { value: option.sector, selected: option.sector === selected?.sector }, `${option.sector + 1} 号${expected?.sector === option.sector ? ' · 教学目标' : ''}`)))),
    chips: h('div', { class: 'chips' }, types.map((type) => h('button', {
      class: `chip chip-select${ui.theoryType === type ? ' active' : ''}`,
      ...tutorialTargetProps('type', (expected?.objectType || expected?.type) === type),
      style: ui.theoryType === type ? { borderColor: TYPE_COLOR[CODE[type]] } : {},
      onclick: () => api.setUi({ theoryType: type }),
    }, iconLabel(CODE[type], LABEL[type], { size: 15 })))),
  };
}

function theoryCard({ game, ui, api }) {
  const schedule = game.theorySectors || [];
  const open = Boolean(game.theoryPhaseOpen);
  const quota = game.theoryQuota || 1;
  const used = game.theoryUsedThisPhase || 0;
  const pending = (game.knowledge.theories || []).filter((t) => t.review === 'pending');
  const choices = theoryChoices({ game, ui, api, label: '扇区' });
  return cardShell(
    '提交学术研究',
    `天窗起点离开 ${schedule.join('、')} 号事件标记后进行`,
    [
      open
        ? h('p', { class: 'pick-status' }, `正在处理 ${game.theoryPhase?.sector || game.arrowSector} 号阶段：你还能提交 ${Math.max(0, quota - used)} 篇。`)
        : h(
            'p',
            { class: 'lobby-error' },
            `现在不是学术研究阶段：箭头在 ${game.arrowSector} 号扇区，学术研究扇区是 ${schedule.join('、')} 号。`,
          ),
      h(
        'div',
        { class: 'range-row' },
        choices.field,
        h(
          'span',
          { class: 'muted small' },
          pending.length
            ? `完成本阶段后 ${pending.length} 条未评审理论会各推进一格：${pending.map((t) => `${t.sector + 1} 号 ${t.slot}→${Math.max(1, t.slot - 1)}`).join('，')}`
            : '还没有未评审的理论',
        ),
      ),
      choices.chips,
      theoryTokenMeter(game),
      h(
        'p',
        { class: 'muted small' },
        `新论文落在轨道 ${THEORY_TRACK[0]}；点击「完成本阶段」后整条轨道向内推进一格，同阶段论文一起到达评审格。`,
      ),
    ],
    confirmButtons(api, '确认提交', !open || used >= quota || !choices.valid || ui.actionBusy),
    'research-submission',
  );
}

function researchCard({ game, research, ui, api }) {
  const players = game.players || [];
  const expected = tutorialExpected(game);
  const mine = research.myCount;
  const declared = research.declaredCount;
  const maxDeclare = Math.min(research.maxDeclare ?? research.quota, (game.theoryOptions || []).length);

  if (mine === null) {
    return h(
      'div',
      { class: 'action-block research-open' },
      h(
        'h3',
        {},
        '学术研究阶段',
        h('span', { class: 'muted small' }, ` 扇区 ${research.sector} · 已选 ${declared}/${research.playerCount}`),
      ),
      h(
        'p',
        { class: 'muted small' },
        `${game.mode.name}：这个阶段每人最多提交 ${research.quota} 篇。所有人选完后按累计耗时从少到多依次提交；同格先到者在后，先行动、先提交。选定篇数后不能更改。`,
      ),
      maxDeclare < research.quota && h('p', { class: 'muted small' }, `按尚可提交的不同扇区与剩余理论标记计算，你本阶段最多可提交 ${maxDeclare} 篇；选择 0 篇仍会推进评审轨道。`),
      theoryTokenMeter(game),
      h(
        'div',
        { class: 'action-buttons' },
        Array.from({ length: research.quota + 1 }, (unused, count) =>
          h(
            'button',
            {
              class: `btn${count ? ' primary' : ' ghost'}`,
              ...tutorialTargetProps('count', expected?.kind === 'research-declare' && expected.count === count),
              disabled: count > maxDeclare,
              onclick: () => {
                if (count <= maxDeclare) api.consoleAction({ kind: 'research-declare', phaseId: research.id, count });
              },
            },
            count === 0 ? '这阶段不提交' : `提交 ${count} 篇`,
          ),
        ),
      ),
    );
  }

  if (!research.allDeclared) {
    return h(
      'div',
      { class: 'action-block research-open' },
      h('h3', {}, '学术研究阶段', h('span', { class: 'muted small' }, ` 扇区 ${research.sector}`)),
      h('div', { class: 'turn-wait good' }, `你已经选了提交 ${mine} 篇，等其他人选完（${declared}/${research.playerCount}）`),
    );
  }

  if (!research.isMyPick) {
    return h(
      'div',
      { class: 'action-block research-open' },
      h('h3', {}, '学术研究阶段', h('span', { class: 'muted small' }, ` 扇区 ${research.sector}`)),
      h(
        'div',
        { class: 'turn-wait' },
        research.left > 0
          ? `等 ${research.cursorName || '别人'} 提交完，再轮到你（你还剩 ${research.left} 篇）`
          : `你的名额用完了，等其他人提交（现在轮到 ${research.cursorName || '别人'}）`,
      ),
      h('p', { class: 'muted small' }, `提交顺序（累计耗时少者优先；同格先到者在后，先提交）：${research.orderNames.join(' → ')}`),
      research.picks.length ? picksList({ game, research, players }) : null,
    );
  }

  const choices = theoryChoices({ game, ui, api, label: '提交到扇区' });
  const pending = (game.knowledge.theories || []).filter((t) => t.review === 'pending');
  return h(
    'div',
    { class: 'action-block research-open' },
    h(
      'h3',
      {},
      '轮到你提交学术研究',
      h('span', { class: 'muted small' }, ` 还剩 ${research.left} 篇 · 扇区 ${research.sector} 阶段`),
    ),
    h('p', { class: 'muted small' }, `提交顺序（累计耗时少者优先；同格先到者在后，先提交）：${research.orderNames.join(' → ')}`),
    h(
      'div',
      { class: 'range-row' },
      choices.field,
      h(
        'span',
        { class: 'muted small' },
        pending.length
          ? `已有 ${pending.length} 篇未评审：本阶段结束后统一推进一格`
          : '还没有未评审的理论',
      ),
    ),
    choices.chips,
    theoryTokenMeter(game),
    h('p', { class: 'muted small' }, '你提交的天体只有自己看得到；别人只会看到你在哪个扇区提交了研究。'),
    h(
      'div',
      { class: 'action-buttons' },
      h(
        'button',
        {
          class: 'btn primary',
          disabled: !choices.valid || ui.actionBusy,
          onclick: () => {
            if (choices.valid && !ui.actionBusy) api.consoleAction({ kind: 'research-submit', phaseId: research.id, sector: choices.sector, objectType: ui.theoryType });
          },
        },
        `确认提交（第 ${mine - research.left + 1}/${mine} 篇）`,
      ),
    ),
    research.picks.length ? picksList({ game, research, players }) : null,
  );
}

/** Who has published where in this phase: sectors are public, objects are not. */
function picksList({ game, research, players }) {
  return h(
    'div',
    { class: 'picks-list' },
    h('h3', {}, '这一阶段已提交', h('span', { class: 'muted small' }, ' 只公开扇区')),
    ...research.picks.map((pick) => {
      const who = players.find((p) => p.id === pick.playerId);
      const bought = research.myPicks.filter((p) => p.sector === pick.sector);
      return h(
        'div',
        { class: 'pick-row' },
        h('span', { class: 'dot', style: { background: (who && who.color) || '#888' } }),
        h('span', { class: 'row-main' }, `${(who && who.name) || '？'} → ${pick.sector + 1} 号扇区`),
        bought.length ? h('span', { class: 'muted small' }, `（我提交的是 ${labelOf(bought[0].objectType)}）`) : null,
      );
    }),
  );
}

function conferenceBlock({ state, game, ui, api }) {
  const pending = pendingUiEvents(game).conference;
  const prompt = pending && game.conference;
  const sectors = game.conferenceSectors || [];
  const recorded = new Set((game.knowledge.conferences || []).map((c) => c.sector));
  const rules = game.conferenceRules || {};
  const missing = sectors.filter((s) => !recorded.has(s));
  const target = pending ? pending.sector : missing[0];

  if (target === undefined) {
    return renderDisclosure(
      { state, api, id: 'conference-entry', title: 'X行星会议', meta: '已记录', className: 'action-block conference-entry', heading: 'h3' },
      h('p', { class: 'muted small' }, '本局的会议线索都已经记录完了。'),
    );
  }

  const due = Boolean(pending);
  const known = prompt ? prompt.text : !game.me || game.amHost ? rules[target] || '' : '';
  const input = h('textarea', {
    class: 'text-input',
    rows: 2,
    placeholder: '把 app 给出的 X行星规律原文抄在这里',
    oninput: (e) => api.setUiQuiet({ conferenceText: e.target.value }),
  });
  input.value = ui.conferenceText || known;
  return renderDisclosure(
    { state, api, id: prompt || due ? `conference-due-${target}` : 'conference-entry', title: 'X行星会议', meta: `${target} 号${prompt || due ? ' · 待记录' : ''}`, open: Boolean(prompt || due), className: `action-block conference-entry${prompt ? ' conference-due' : due ? ' due' : ''}`, heading: 'h3' },
    prompt
      ? h(
          'p',
          { class: 'pick-status' },
          `${eventDeparture(prompt.sector, game.mode)}：去官方 app 查看这次 X行星会议公布给全桌的规律，然后填在这里（全桌共享）。`,
        )
      : h(
          'p',
          { class: 'muted small' },
          due
            ? `${eventDeparture(target, game.mode)}，该开会了——把规律抄下来。`
            : `还没记录：${missing.join('、')} 号扇区。天窗起点离开对应事件标记时（或实体版已经开完）可以在这里补记。`,
        ),
    input,
    h(
      'div',
      { class: 'action-buttons' },
      h(
        'button',
        { class: 'btn primary', onclick: () => api.consoleAction({ kind: 'conference', sector: target, text: input.value }) },
        `记录扇区 ${target} 的会议`,
      ),
    ),
  );
}

export function renderKnowledgePanel({ state, api }) {
  const { game } = state;
  const rules = baseRuleText(game.mode);
  const isMine = entry => !game.me || entry.actorId === game.me;
  const clues = game.knowledge.clues.filter(isMine);
  const observations = (game.log || []).filter(entry => isMine(entry) && ['survey', 'target'].includes(entry.type));
  const initialClues = game.mySetup?.clues || [];
  return renderDisclosure(
    { state, api, id: 'knowledge', title: '推理线索', className: 'card knowledge-card', open: !(typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches) },
    initialClues.length ? h('div', { class: 'clue-group' },
      h('h3', {}, `初始线索（${initialClues.length}）`),
      h('ul', { class: 'clue-list' }, initialClues.map(clue => h('li', {}, `${clue.sector + 1} 号没有${labelOf(clue.type)}`))),
    ) : null,
    observations.length ? h('div', { class: 'clue-group' },
      h('h3', {}, `观测结果（${observations.length}）`),
      h('ul', { class: 'clue-list' }, observations.map(entry => h('li', {}, entry.type === 'survey'
        ? `${entry.start + 1}–${mod(entry.start + entry.size - 1, game.mode.sectors) + 1} 号 · ${labelOf(entry.surveyType)} ${entry.count ?? '未记录'} 个`
        : `${entry.sector + 1} 号 · ${labelOf(entry.apparent) || '未记录'}`))),
    ) : null,
    h(
      'div',
      { class: 'clue-group' },
      h('h3', {}, `研究线索（${clues.length}/6）`),
      clues.length === 0
        ? h('p', { class: 'muted small' }, '还没有研究任何主题。')
        : h('ul', { class: 'clue-list' }, clues.map(clue => h('li', {}, h('span', { class: 'topic-tag' }, clue.topic), clue.text))),
    ),
    renderDisclosure(
      { state, api, id: 'rules', title: '基础规律', heading: 'h3', className: 'rule-reference' },
      h('ul', { class: 'rule-list' }, rules.map(rule => h('li', {}, rule))),
      dwarfBeltHelper({ game, notes: state.notes }),
    ),
    theoryTokenMeter(game),
  );
}

export const renderLogPanel = renderActionHistory;

/** The running score table, built from what the app told the table. */
export function renderScorePanel({ state, api }) {
  const { game } = state;
  const board = game.scores;
  if (!board || !board.rows.length) return null;
  const best = Math.max(...board.rows.map((r) => r.total));
  const winners = scoreWinners(board);
  const objectTypes = SURVEY_TYPES.filter((objectType) => objectType !== Obj.EMPTY);
  return renderDisclosure(
    { state, api, id: 'score', title: '积分详情', meta: board.finished ? '本局已结束' : '实时统计', className: 'card score-card', open: board.finished },
    board.rows.map((row) => h('div', { class: 'score-table-wrap', role: 'region', 'aria-label': `${row.name}的积分明细`, tabindex: 0 },
      h('table', { class: 'score-table', 'data-player': row.id },
        h('caption', {}, h('span', { class: 'score-name' }, h('span', { class: 'dot', style: { background: row.color || 'var(--accent)' } }), row.name)),
        h('thead', {}, h('tr', {},
          objectTypes.map((objectType) => h('th', { scope: 'col' },
            iconLabel(CODE[objectType], LABEL[objectType], { size: 16 }),
            h('span', { class: 'score-unit' }, `${theoryPointsFor(game.mode, objectType)} 分/篇`),
          )),
          h('th', { scope: 'col' }, '首对奖励', h('span', { class: 'score-unit' }, '+1/扇区')),
          h('th', { scope: 'col' }, '定位X行星'),
          h('th', { scope: 'col' }, '合计'),
        )),
        h('tbody', {}, h('tr', { class: (board.finished ? winners.some((winner) => winner.id === row.id) : row.total === best && best > 0) ? 'best' : '' },
          objectTypes.map((objectType) => h('td', {}, String((row.theories || [])
            .filter((theory) => (CODE_TO_TYPE[theory.objectType] || theory.objectType) === objectType)
            .reduce((total, theory) => total + (theory.points || 0), 0)))),
          h('td', {}, String(row.leaderBonus || 0)),
          h('td', {}, String(row.locatePoints || 0)),
          h('td', { class: 'score-total' }, String(row.total)),
        )),
      ),
    )),
    h(
      'p',
      { class: 'muted small' },
      `理论分：${objectTypes.map((objectType) => `${LABEL[objectType]} ${theoryPointsFor(game.mode, objectType)}`).join(' · ')}；每个最早阶段提交正确理论的扇区 +${board.leaderBonus}（同阶段共享）；第一个正确定位 X行星 +${board.locateFirst}，已计入定位列，不再重复加分。最后机会定位正确按冻结时落后格数每格 +${board.locatePerSector}。同分依次比较定位分、首对奖励，仍同分则并列。`,
    ),
  );
}

export function describeLog(entry, game) {
  const who = actorLabel(game, entry);
  const prefix = who ? `${who}：` : '';
  const hidden = '（结果未公开）';
  switch (entry.type) {
    case 'survey': {
      const a = mod(entry.start, game.mode.sectors) + 1;
      const b = mod(entry.start + entry.size - 1, game.mode.sectors) + 1;
      const result = entry.count === undefined ? hidden : `${entry.count} 个`;
      return `${prefix}勘测「${LABEL[entry.surveyType]}」${a}–${b} → ${result}`;
    }
    case 'target':
      return `${prefix}扫描 ${entry.sector + 1} 号扇区 → ${entry.apparent === undefined ? hidden : labelOf(entry.apparent)}`;
    case 'research':
      return `${prefix}研究课题 ${entry.topic}${entry.text === undefined ? hidden : `：${entry.text}`}`;
    case 'theory':
      return `${prefix}提交学术研究：${entry.sector + 1} 号扇区${
        entry.objectType === undefined ? '（天体未公开）' : `是${labelOf(entry.objectType)}`
      }（轨道 ${entry.slot}${entry.review === 'pending' ? '，待评审' : entry.review === 'correct' ? '，评审正确' : '，评审错误'}）${
        entry.revealed ? ' · 已公开' : ''
      }`;
    case 'penalty':
      return `${prefix}同行评审错误，耗时 ${durationLabel(entry.cost)}`;
    case 'conference':
      return `${prefix}${entry.label || '会议'}：${entry.text}`;
    case 'wait':
      return `${prefix}等待了 ${durationLabel(entry.cost)}`;
    case 'located':
      return `${prefix}记录定位：${Number.isInteger(entry.sector) ? `${entry.sector + 1} 号扇区` : '扇区保密'}，${entry.correct === false ? '错误' : '正确'}`;
    default:
      return `${prefix}${entry.type}`;
  }
}

export function renderToast({ state }) {
  const { ui } = state;
  if (!ui.toast) return null;
  return h('div', { class: `toast toast-${ui.toast.kind || 'info'}` }, ui.toast.text);
}

/**
 * 12 sectors or 18? The choice belongs to whoever opens the table (and to a solo
 * console before it starts), because it decides the ring, the sky window and where the
 * conference / theory phases sit on the time track.
 */
function playModePicker({ value, onPick }) {
  const options = [
    { id: 'record', title: '记录模式', detail: '配合实体版／官方 app，手动记录结果。支持 12／18 扇区。' },
    { id: 'builtin', title: '内置谜题', detail: '标准 12 扇区／专家 18 扇区原创谜题，系统出题、查询、评审与结算。' },
    { id: 'tutorial', title: '双人教学', detail: '你与 Bot「领航员」逐步练习，从认识星图到定位与结算。' },
  ];
  return h('div', { class: 'play-mode-picker', role: 'group', 'aria-label': '游戏模式' }, options.map((option) =>
    h('label', { class: `play-mode-option${option.id === value ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'play-mode', value: option.id, checked: option.id === value, onchange: () => onPick(option.id) }),
      h('span', {}, h('strong', {}, option.title), h('span', { class: 'muted small' }, option.detail)),
    ),
  ));
}

function modePicker({ value, onPick }) {
  const chosen = modeById(value);
  return h(
    'div',
    { class: 'mode-block' },
    h(
      'div',
      { class: 'mode-picker' },
      ...MODE_LIST.map((mode) =>
        h(
          'label',
          { class: `mode-option${mode.id === chosen.id ? ' active' : ''}` },
          h('input', {
            type: 'radio',
            name: 'board-mode',
            value: mode.id,
            checked: mode.id === chosen.id,
            onchange: () => onPick(mode.id),
          }),
          h('span', { class: 'mode-name' }, mode.name),
          h('span', { class: 'muted small' }, `${mode.sectors} 个扇区 · 天窗 ${mode.visible} 格`),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, `${chosen.name}：${eventSummary(chosen)}`),
  );
}

export function renderModal({ state, api }) {
  const { ui, game } = state;
  const modal = ui.modal;
  if (!modal) return null;
  if (modal.kind === 'locate' && game.tutorial && (game.tutorial.interaction !== 'action' || tutorialExpected(game)?.kind !== 'locate')) return null;

  const close = () => api.setUi({ modal: null });
  let title = '';
  let body = null;
  let actions = [h('button', { class: 'btn', onclick: close }, '关闭')];

  if (modal.kind === 'help') {
    title = '规则速查';
    body = h(
      'div',
      { class: 'modal-body' },
      h('h3', {}, '目标'),
      h('p', {}, '确定 X行星所在的扇区，并说对它左右相邻扇区里的天体；最终总分最高者获胜。'),
      h('h3', {}, '行动与时间'),
      h(
        'ul',
        {},
        h('li', {}, `勘测：选择一类天体和一个连续范围，得知该范围内这类天体的数量。1–3 格耗时 ${durationLabel(surveyCost(3))}，4–6 格耗时 ${durationLabel(surveyCost(6))}，7–9 格耗时 ${durationLabel(surveyCost(9))}（范围越宽越划算；标准棋盘最多选 6 格）。`),
        h('li', {}, `扫描：得知一个扇区的观测结果（X行星会显示为「空域」）。全场只有 ${MAX_TARGET_USES} 次，每次耗时 ${durationLabel(COST.target)}。`),
        h('li', {}, `研究：获得一条本局专属规律，耗时 ${durationLabel(COST.research)}，自己的相邻两次行动不能都是研究；每个主题只能研究一次。`),
        h('li', {}, `定位：提交 X行星扇区与左右邻居，耗时 ${durationLabel(COST.locate)}。答错只损失时间。`),
      ),
      h('h3', {}, '时间与可见天区'),
      h(
        'p',
        {},
        `时间以「时间单位」计，每单位让行动者的棋子前进一格。当前位置显示「第几圈／第几格」，从第 1 圈／第 1 格开始：标准棋盘 12 格一圈，专家棋盘 18 格一圈，不对应月份或年份。当前棋盘 ${game.mode.sectors} 格，每圈 ${game.mode.sectors} 个时间单位，同时可见 ${game.mode.visible} 个连续扇区。天窗跟随全桌累计耗时最少的玩家，跨圈也按总耗时比较；同格先到者在后，先行动、先提交，后来者站在顺时针前方。地球位于可见窗口中线；勘测与扫描必须在可见范围内，彗星勘测起止点还必须是质数编号扇区。`,
      ),
      h('h3', {}, 'X行星会议'),
      h(
        'p',
        {},
        `会议挂在时间轨的 ${conferenceSectors(game.mode).join('、')} 号扇区上（标准模式 1 次、专家模式 2 次）。天窗起点离开事件标记时召开：${conferenceSectors(game.mode).map((sector) => `${sector}→${mod(sector, game.mode.sectors) + 1} 号（首圈时间 ${sector}）`).join('、')}，不是进入标记时。内置谜题自动公布会议线索；记录模式把官方 app 给出的规律抄进会议栏。`,
      ),
      h('h3', {}, '学术研究 / 同行评审'),
      h(
        'p',
        {},
        `天窗起点离开论文事件标记时触发阶段：${theorySectors(game.mode).map((sector) => `${sector}→${mod(sector, game.mode.sectors) + 1} 号（首圈时间 ${sector}）`).join('、')}。可以在尚未公开正确答案的扇区发表理论；不能重复自己的同一主张，也不能在同一阶段向同一扇区提交不同天体，之后的阶段可以在未揭晓扇区尝试不同天体。每个论文阶段结束时所有未评审论文推进一格：${THEORY_TRACK.join(' → ')}，零提交也照常推进。到达 1 时按扇区顺序评审：内置谜题自动判定，记录模式填写官方 app 结果。错误主张也公开，每篇错误论文只处罚 1 个时间单位。每人有固定数量的实体理论标记（标准盘矮行星 1 枚，专家盘 4 枚；小行星 4、彗星 2、气体云 2）；某类用完就不能再提交该天体，对错都不退回。`,
      ),
      h('h3', {}, '最后机会与揭示'),
      h('p', {}, '首次正确定位后冻结天窗。落后 1–3 格的玩家可提交最多 1 篇理论，落后 4–5 格可提交最多 2 篇；也可改为定位或放弃，均不移动棋子。全部完成后，内置谜题自动揭晓棋盘；记录模式由房主填写官方 app 答案。剩余理论统一结算，不再罚时。内置单人是独立解谜，不含官方单人机器人。'),
      h('p', { class: 'muted small' }, '旧记录的数值耗时不变，仅按棋盘格数重新显示圈／格。内置谜题答案保存在本地服务进程中，刷新可恢复；服务重启后可用顶栏「存档／加载存档」从本机存档库恢复房间。'),
    );
  } else if (modal.kind === 'locate') {
    title = game.playMode === 'builtin' ? '定位 X行星' : '记录定位结果';
    const n = game.mode.sectors;
    const types = ['asteroid', 'comet', 'gasCloud', 'dwarfPlanet', 'empty'];
    const cur = ui.locate || { sector: 0, left: 'asteroid', right: 'asteroid', correct: true };
    const final = game.phase === 'final';
    const cost = final ? 0 : COST.locate;
    const expected = tutorialExpected(game);
    const guidance = expected ? { 'aria-describedby': 'tutorial-locate-instruction' } : {};
    body = h(
      'div',
      { class: 'modal-body' },
      h(
        'p',
        { class: 'muted' },
        game.playMode === 'builtin'
          ? `提交 X行星位置与左右邻居，由系统自动判定。${final ? '这是最后一次机会，不消耗时间；提交后不能改为发表理论。' : `耗时 ${durationLabel(cost)}，答错继续游戏。`}答案在所有玩家完成最后机会后自动揭晓。`
          : final
          ? '这是你唯一的最后机会，不再消耗时间或移动棋子。请记录官方 app 的判定；提交后不能再改为发表理论。答案在全盘揭示前保密。'
          : `记录你向官方 app 提交的答案与判定，消耗 ${durationLabel(cost)}。正确后进入最后机会／揭示阶段，错误则继续游戏；答案在全盘揭示前保密。`,
      ),
      expected ? h('p', { class: 'tutorial-focus-label', id: 'tutorial-locate-instruction' }, `教学目标：${expected.sector + 1} 号 · 左邻：${labelOf(expected.left)} · 右邻：${labelOf(expected.right)}`) : null,
      h(
        'div',
        { class: 'locate-grid' },
        h(
          'label',
          {},
          'X行星扇区',
          h(
            'select',
            { ...guidance, 'aria-label': 'X行星扇区', 'data-tutorial-target': expected ? 'locate-sector' : null, onchange: event => api.setUi({ locate: { ...cur, sector: Number(event.target.value) } }) },
            Array.from({ length: n }, (_, i) => h('option', { value: i, selected: i === cur.sector }, `${i + 1} 号`)),
          ),
        ),
        h(
          'label',
          {},
          '左邻居（顺时针前一格）',
          h(
            'select',
            { ...guidance, 'aria-label': '左邻居', 'data-tutorial-target': expected ? 'left' : null, onchange: event => api.setUi({ locate: { ...cur, left: event.target.value } }) },
            types.map((t) => h('option', { value: t, selected: t === cur.left }, LABEL[t])),
          ),
        ),
        h(
          'label',
          {},
          '右邻居（顺时针后一格）',
          h(
            'select',
            { ...guidance, 'aria-label': '右邻居', 'data-tutorial-target': expected ? 'right' : null, onchange: event => api.setUi({ locate: { ...cur, right: event.target.value } }) },
            types.map((t) => h('option', { value: t, selected: t === cur.right }, LABEL[t])),
          ),
        ),
      ),
      game.playMode !== 'builtin' && h(
        'div',
        { class: 'action-buttons' },
        h(
          'button',
          {
            class: `btn${cur.correct === false ? '' : ' primary'}`,
            onclick: () => api.setUi({ locate: { ...cur, correct: true } }),
          },
          'app 判定：正确（进入终局）',
        ),
        h(
          'button',
          {
            class: `btn${cur.correct === false ? ' primary' : ''}`,
            onclick: () => api.setUi({ locate: { ...cur, correct: false } }),
          },
          'app 判定：错误（继续，只花时间）',
        ),
      ),
    );
    actions = [
      h('button', { class: 'btn ghost', onclick: close }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            const res = api.doAction({
              kind: 'locate',
              sector: cur.sector,
              left: cur.left,
              right: cur.right,
              ...(game.playMode === 'builtin' ? {} : { correct: cur.correct !== false }),
            });
            if (res && typeof res.then === 'function') res.then((result) => { if (result?.ok) close(); });
            else if (res?.ok) close();
          },
        },
        `确认提交（${durationLabel(cost)}）`,
      ),
    ];
  } else if (modal.kind === 'conference') {
    title = modal.label || 'X行星会议';
    body = h(
      'div',
      { class: 'modal-body' },
      Number.isInteger(modal.sector)
        ? h('p', { class: 'muted' }, `天窗已离开 ${modal.sector} 号会议扇区，全体同时得知一条关于 X行星的规律：`)
        : h('p', { class: 'muted' }, '全体与会者同时得知一条关于 X行星的规律：'),
      h('blockquote', { class: 'clue-quote' }, modal.text),
      h('p', { class: 'muted small' }, '线索已写入星图左侧「X行星会议」栏，可随时回看。'),
    );
    actions = [h('button', { class: 'btn primary', onclick: close }, '知道了')];
  } else if (modal.kind === 'result' && game.kind === 'console') {
    title = '定位已记录';
    const summary = api.consoleSummary();
    body = h(
      'div',
      { class: 'modal-body' },
      h('p', {}, `你在 ${summary.timeLabel} 记下了定位结果。本页不判定对错——结果以实体版／官方 app 为准。`),
      h(
        'ul',
        { class: 'score-list' },
        h('li', {}, `耗时 ${summary.durationLabel || durationLabel(summary.units ?? summary.months)}`),
        h('li', {}, `勘测 ${summary.surveys} 次 · 扫描 ${summary.targets} 次 · 等待 ${summary.waits} 次`),
        h('li', {}, `研究线索 ${summary.clues} 条 · 会议线索 ${summary.conferences} 条`),
        summary.locate && h('li', { class: 'total' }, `记录的 X行星位置：${summary.locate.sector + 1} 号扇区`),
      ),
      h('p', { class: 'muted small' }, '想改的话关掉这个窗口，用「撤销最后一条」即可。'),
    );
    actions = [
      h('button', { class: 'btn ghost', onclick: close }, '关闭'),
      h('button', { class: 'btn primary', 'data-modal-trigger': 'again', onclick: () => api.setUi({ modal: { kind: 'start' } }) }, '开新的一局'),
    ];
  } else if (modal.kind === 'start') {
    title = '开始新的一局';
    const picked = modeById(ui.modeId || game.mode.id);
    const playMode = ui.playMode || 'record';
    const lobby = ui.lobby || {};
    body = h(
      'div',
      { class: 'modal-body' },
      h(
        'p',
        { class: 'muted' },
        '先选择游玩方式。内置谜题可以独立完成一整局；记录模式用于同步实体版或官方 app。',
      ),
      playModePicker({ value: playMode, onPick: nextMode => api.setUi({ playMode: nextMode, ...(nextMode === 'tutorial' ? { modeId: 'standard', initialClueCount: 4, withBots: 0 } : nextMode !== 'builtin' ? { withBots: 0 } : {}) }) }),
      playMode === 'tutorial'
        ? h('div', { class: 'builtin-mode-note' }, h('strong', {}, '标准 12 扇区 · 固定 4 条初始线索'), h('p', { class: 'muted small' }, '固定一名真人与 Bot「领航员」。按教学指南完成真实行动，手动观看 Bot 演示，直到定位与结算；退出后恢复原房间与笔记。需要本地服务保持运行。'))
        : h('div', { class: 'lobby-field' }, h('span', { class: 'muted small' }, '新一局用哪块棋盘'), modePicker({ value: picked.id, onPick: (id) => api.setUi({ modeId: id }) })),
      playMode === 'builtin' && initialCluePicker({ value: ui.initialClueCount ?? 4, onPick: count => api.setUi({ initialClueCount: count }) }),
      playMode === 'builtin' && botOpponentPicker({ value: ui.withBots ?? 0, onPick: count => api.setUi({ withBots: count }) }),
      playMode === 'builtin' && h('div', { class: 'builtin-mode-note' }, h('strong', {}, `${picked.name} ${picked.sectors} 扇区 · 单人解谜`), h('p', { class: 'muted small' }, '初始线索 → 观测／研究 → 论文评审 → 定位 → 自动揭晓。需要本地服务保持运行；可加 Bot 对手，或多人对到「联机」创建内置谜题房间。不会覆盖你的本地记录存档。')),
      playMode === 'record' && h('p', { class: 'muted small' }, '开始新记录局会清空本地记录与手写笔记，时间回到第 1 圈／第 1 格。可用顶栏「加载存档」从本机存档库恢复。'),
      state.remote && playMode !== 'tutorial' && h('p', { class: 'muted small' }, '开始新局会离开当前房间视图，但不会删除房间或影响其他玩家。'),
      lobby.error && h('p', { class: 'lobby-error' }, lobby.error),
    );
    actions = [
      h('button', { class: 'btn ghost', onclick: close }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          'data-modal-trigger': 'new-game',
          disabled: lobby.busy,
          onclick: () => {
            if (playMode === 'builtin' || playMode === 'tutorial') return api.startBuiltin();
            api.newSession(picked.id);
            close();
          },
        },
        lobby.busy ? '正在创建谜题…' : playMode === 'tutorial' ? '开始双人教学' : playMode === 'builtin' ? '开始内置谜题' : '开始',
      ),
    ];
  } else if (modal.kind === 'lobby') {
    const online = Boolean(state.remote);
    const lobby = ui.lobby || { name: '', code: '', busy: false, error: null };
    // The code field must enable 「加入房间」 as you type. Typing goes through the quiet
    // path (no re-render, so the caret stays put), which also means the button has to be
    // synced by hand — otherwise it stays grey until something else triggers a render.
    const joinButton = h('button', { class: 'btn', onclick: () => api.joinRoom() }, '加入房间');
    const syncJoin = (next) => {
      const busy = Boolean((next && next.busy) || lobby.busy);
      joinButton.disabled = busy || !String((next && next.code) || '').trim();
    };
    // people paste codes with spaces, dashes or a "房间码：" prefix: keep the 6 characters
    const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    const nameInput = h('input', {
      class: 'text-input',
      type: 'text',
      placeholder: '你的名字',
      oninput: (e) => api.patchLobby({ name: e.target.value }),
    });
    nameInput.value = lobby.name || '';
    const codeInput = h('input', {
      class: 'text-input',
      type: 'text',
      maxlength: 6,
      placeholder: '6 位房间码',
      oninput: (e) => {
        const code = normalizeCode(e.target.value);
        if (e.target.value !== code) e.target.value = code;
        syncJoin(api.patchLobby({ code }));
      },
      onkeydown: (e) => {
        if (e && e.key === 'Enter' && !joinButton.disabled) {
          e.preventDefault?.();
          api.joinRoom();
        }
      },
    });
    codeInput.value = lobby.code || '';
    syncJoin(lobby);

    if (online) {
      title = game.tutorial ? '双人教学' : '房间';
      body = h(
        'div',
        { class: 'modal-body' },
        !game.tutorial && h('p', {}, `房间码：`, h('b', { class: 'room-code' }, state.remote.roomId)),
        h('p', { class: 'muted small' }, `棋盘：${game.mode.name}（${game.mode.sectors} 个扇区）· ${eventSummary(game.mode)}`),
        h('p', { class: 'muted small' }, game.tutorial ? '你与 Bot「领航员」的固定双人教学，不接受其他玩家加入。' : '把这 6 位码念给同桌的人，他们在自己的设备上打开本页、点「联机」→「加入房间」即可。'),
        initialCluePicker({ value: game.initialClueCount ?? 4, readOnly: !game.amHost || game.phase !== 'lobby' || Boolean(game.tutorial), onPick: count => api.setInitialClueCount(count) }),
        h(
          'div',
          { class: 'player-bar' },
          ...(game.players || []).map((p) =>
            h(
              'span',
              { class: `player-chip${p.id === game.me ? ' me' : ''}`, style: { borderColor: p.color } },
              h('span', { class: 'dot', style: { background: p.color } }),
              p.name,
              p.host ? h('span', { class: 'muted small' }, ' · 房主') : null,
              p.bot ? h('span', { class: 'muted small' }, ' · Bot') : null,
              p.spectator ? h('span', { class: 'muted small' }, ' · 观战') : null,
            ),
          ),
        ),
        h('p', { class: 'muted small' }, `连接状态：${state.netStatus === 'online' ? '已连接（实时同步）' : '正在重连…'}`),
        h('p', { class: 'muted small' }, '勘测数量、扫描结果、研究课题与线索只有本人可见（观战者可见全部）；时间轨、天窗、日志、学术研究与会议线索全桌共享。'),
        game.playMode !== 'builtin' && game.amHost && (game.phase === 'setup' || game.phase === 'play')
          ? h(
              'div',
              { class: 'shared-edit' },
              h('h3', {}, '全桌共享信息', h('span', { class: 'muted small' }, ' A–F 课题名、会议标题与线索正文，由房主填写')),
              sharedInfoBlock({ game, api, readOnly: false, draft: ui.tableInfo, onPatch: (fn) => api.patchTableInfo(fn, true) }),
              h(
                'div',
                { class: 'action-buttons' },
                h('button', { class: 'btn', onclick: () => api.saveTableInfo() }, '保存全桌信息'),
              ),
            )
          : null,
      );
      actions = [
        h('button', { class: 'btn ghost', onclick: close }, '关闭'),
        game.tutorial ? h('button', { class: 'btn', onclick: () => api.exitTutorial() }, '退出教学') : h('button', { class: 'btn', onclick: () => api.leaveRoom() }, '离开房间（回到单机）'),
      ];
    } else {
      const playMode = ui.playMode || 'record';
      const tutorial = playMode === 'tutorial';
      title = tutorial ? '双人教学' : '联机 · 同一张桌子上玩';
      body = h(
        'div',
        { class: 'modal-body' },
        h('p', { class: 'muted' }, tutorial ? '固定一名真人与 Bot「领航员」，逐步完成观测、论文、会议与定位。' : '一台设备开房间，其他人用房间码加入：时间轨与天窗共享，观测结果各自保密。'),
        h('label', { class: 'lobby-field' }, h('span', { class: 'muted small' }, '你的名字'), nameInput),
        playModePicker({ value: playMode, onPick: nextMode => api.setUi({ playMode: nextMode, ...(nextMode === 'tutorial' ? { modeId: 'standard', initialClueCount: 4, withBots: 0 } : nextMode !== 'builtin' ? { withBots: 0 } : {}) }) }),
        tutorial
          ? h('p', { class: 'builtin-mode-note small' }, '标准 12 扇区 · 固定 4 条初始线索。教学期间按步骤操作，退出后恢复原房间与笔记。')
          : h('div', { class: 'lobby-field' }, h('span', { class: 'muted small' }, '棋盘（房主选，全桌一致）'), modePicker({ value: ui.modeId, onPick: (id) => api.setUi({ modeId: id }) })),
        !tutorial && initialCluePicker({ value: ui.initialClueCount ?? 4, onPick: count => api.setUi({ initialClueCount: count }) }),
        playMode === 'builtin' && botOpponentPicker({ value: ui.withBots ?? 0, onPick: count => api.setUi({ withBots: count }) }),
        playMode === 'builtin' && h('p', { class: 'builtin-mode-note small' }, `支持标准／专家棋盘 · 1–${BUILTIN_MAX_PLAYERS} 人（含房主与 Bot），可单人开始。开局后锁定玩家；系统自动分发初始线索并处理谜题与结算。`),
        h(
          'div',
          { class: 'lobby-actions' },
          h('button', { class: 'btn primary', disabled: lobby.busy, onclick: () => tutorial ? api.startBuiltin() : api.createRoom() }, lobby.busy ? '处理中…' : tutorial ? '开始双人教学' : '创建房间'),
        ),
        !tutorial && h('hr', { class: 'lobby-sep' }),
        !tutorial && h(
          'label',
          { class: 'lobby-field' },
          h('span', { class: 'muted small' }, '房间码（6 位，回车即可加入）'),
          codeInput,
        ),
        !tutorial && h(
          'div',
          { class: 'lobby-field' },
          h('span', { class: 'muted small' }, '加入身份'),
          h(
            'div',
            { class: 'chips', role: 'group', 'aria-label': '加入身份' },
            h(
              'button',
              {
                type: 'button',
                class: `chip chip-select${lobby.spectator ? '' : ' active'}`,
                'aria-pressed': String(!lobby.spectator),
                onclick: () => api.patchLobby({ spectator: false }),
              },
              '玩家',
            ),
            h(
              'button',
              {
                type: 'button',
                class: `chip chip-select${lobby.spectator ? ' active' : ''}`,
                'aria-pressed': String(Boolean(lobby.spectator)),
                onclick: () => api.patchLobby({ spectator: true }),
              },
              '观战',
            ),
          ),
          h('p', { class: 'muted small' }, '观战可看所有人行动结果，不参与操作，也不占用游戏名额。'),
        ),
        !tutorial && h('div', { class: 'lobby-actions' }, joinButton),
        !tutorial && h('p', { class: 'muted small' }, '房主给你的 6 位房间码，大小写都行、粘贴时带了空格或横线也没关系；填好按钮就会亮，回车同样可以加入。'),
        lobby.error ? h('p', { class: 'lobby-error' }, lobby.error) : null,
        h('p', { class: 'muted small' }, '房间保存在服务器内存里：服务器重启后房间会消失。可用顶栏「存档」写入本机存档库，再用「加载存档」恢复并选择身份。'),
      );
      actions = [h('button', { class: 'btn ghost', onclick: close }, '关闭')];
    }
  } else if (modal.kind === 'archives') {
    const slots = typeof api.listArchiveSlots === 'function' ? api.listArchiveSlots() : [];
    const pendingDeleteId = modal.pendingDeleteId || null;
    const lobby = ui.lobby || {};
    title = '我的存档';
    body = h(
      'div',
      { class: 'modal-body' },
      h('p', { class: 'muted' }, '存档保存在本浏览器中。点「加载」恢复对局；联机存档还会让你选择座位身份。'),
      slots.length
        ? h(
            'div',
            { class: 'archive-list' },
            ...slots.map((slot) => {
              const pending = pendingDeleteId === slot.id;
              return h(
                'div',
                { class: `archive-row${pending ? ' pending-delete' : ''}` },
                h(
                  'div',
                  { class: 'archive-row-main' },
                  h('strong', {}, slot.label || '未命名存档'),
                  h('p', { class: 'muted small' }, `${slot.kind === 'online' ? '联机' : '单机'} · ${slot.summary || ''}`),
                ),
                pending
                  ? h(
                      'div',
                      { class: 'archive-row-actions' },
                      h('span', { class: 'muted small' }, '确认删除？'),
                      h('button', { type: 'button', class: 'btn small', onclick: () => api.cancelDeleteArchiveSlot() }, '取消'),
                      h('button', { type: 'button', class: 'btn small bad', onclick: () => api.confirmDeleteArchiveSlot(slot.id) }, '删除'),
                    )
                  : h(
                      'div',
                      { class: 'archive-row-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          class: 'btn small primary',
                          disabled: lobby.busy,
                          onclick: () => api.loadArchiveSlot(slot.id),
                        },
                        '加载',
                      ),
                      h('button', { type: 'button', class: 'btn small ghost', onclick: () => api.exportArchiveSlot(slot.id) }, '导出'),
                      h('button', { type: 'button', class: 'btn small ghost', onclick: () => api.requestDeleteArchiveSlot(slot.id) }, '删除'),
                    ),
              );
            }),
          )
        : h('p', { class: 'archive-empty muted' }, '还没有存档。对局中点顶栏「存档」即可写入这里。'),
      lobby.error ? h('p', { class: 'lobby-error' }, lobby.error) : null,
    );
    actions = [
      h('button', { class: 'btn ghost', onclick: () => api.importArchiveFile() }, '从文件导入'),
      h('button', { class: 'btn', onclick: close }, '关闭'),
    ];
  } else if (modal.kind === 'archive-seat') {
    const archive = modal.archive;
    const seats = archive?.seats || (archive?.room?.players || []).map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      host: Boolean(player.host),
      spectator: Boolean(player.spectator),
    }));
    const lobby = ui.lobby || {};
    title = '选择存档中的身份';
    body = h(
      'div',
      { class: 'modal-body' },
      h('p', { class: 'muted' }, `房间 ${String(archive?.room?.id || '').toUpperCase()} 已就绪。请选择你在存档里的座位，令牌来自存档文件，不会新建玩家。`),
      h(
        'div',
        { class: 'player-bar archive-seat-list' },
        ...(seats || []).map((seat) =>
          h(
            'button',
            {
              type: 'button',
              class: 'btn archive-seat-btn',
              disabled: lobby.busy,
              style: seat.color ? { borderColor: seat.color } : undefined,
              onclick: () => api.selectArchiveSeat(seat.id),
            },
            h('span', { class: 'dot', style: seat.color ? { background: seat.color } : undefined }),
            seat.name || '未命名',
            seat.host ? h('span', { class: 'muted small' }, ' · 房主') : null,
            seat.spectator ? h('span', { class: 'muted small' }, ' · 观战') : null,
          ),
        ),
      ),
      lobby.error ? h('p', { class: 'lobby-error' }, lobby.error) : null,
      h('p', { class: 'muted small' }, '存档含谜底与座位令牌，勿发到公开群。选错座位可再加载一次并换人。'),
    );
    actions = [h('button', { class: 'btn ghost', disabled: lobby.busy, onclick: close }, '取消')];
  }

  return h(
    'div',
    { class: 'modal-backdrop', onclick: (e) => e.target === e.currentTarget && close() },
    h('div', { class: 'modal' }, h('h2', {}, title), body, h('div', { class: 'modal-actions' }, actions)),
  );
}
