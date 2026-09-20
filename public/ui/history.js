import { h } from './dom.js';
import { renderDisclosure } from './disclosure.js';
import { labelOf } from '../src/types.js';
import { durationLabel, mod, timeShort } from '../src/rules.js';

function historyPlayers(game, entries) {
  const online = Boolean(game.players?.length);
  const viewer = game.me || game.players?.find(player => player.isMe)?.id || 'me';
  const players = online ? game.players.map(player => ({ ...player, isMe: player.id === viewer })) : [{ id: 'me', name: '我', isMe: true }];
  for (const entry of entries) {
    const actorId = entry.actorId || (online ? 'unassigned' : 'me');
    if (!players.some(player => player.id === actorId)) players.push({ id: actorId, name: '未命名玩家', isMe: false });
  }
  return { players, ownerOf: entry => entry.actorId || (online ? 'unassigned' : 'me') };
}

function describeEntry(entry, game, isMine) {
  const canRead = isMine || (['theory', 'located'].includes(entry.type) && entry.revealed === true);
  const privateResult = '结果未公开';
  const sectors = game.mode.sectors;
  switch (entry.type) {
    case 'survey':
      return {
        operation: `勘测 ${mod(entry.start, sectors) + 1}–${mod(entry.start + entry.size - 1, sectors) + 1} 号 · ${labelOf(entry.surveyType)}`,
        result: canRead && entry.count !== undefined ? `${entry.count} 个` : null,
        hidden: !canRead || entry.count === undefined ? privateResult : null,
      };
    case 'target':
      return { operation: `扫描 ${entry.sector + 1} 号`, result: canRead ? labelOf(entry.apparent) : null, hidden: !canRead || entry.apparent === undefined ? privateResult : null };
    case 'research':
      return { operation: `研究课题 ${entry.topic}`, result: canRead ? entry.text : null, hidden: !canRead || entry.text === undefined ? privateResult : null };
    case 'wait':
      return { operation: `等待 ${durationLabel(entry.cost)}` };
    case 'theory': {
      const review = { pending: '待评审', correct: '评审正确', wrong: '评审错误' }[entry.review] || '待评审';
      const status = entry.review === 'pending' && entry.slot ? `${review} · 轨道 ${entry.slot}` : review;
      return {
        operation: `${entry.final ? '最后机会 · ' : ''}提交理论 ${entry.sector + 1} 号`,
        result: canRead ? labelOf(entry.objectType) : null,
        hidden: !canRead || entry.objectType === undefined ? '天体未公开' : null,
        status: `${entry.revealed ? '已公开 · ' : ''}${status}`,
      };
    }
    case 'conference':
      return { operation: `X行星会议 · ${entry.sector} 号`, result: entry.text, event: true };
    case 'penalty':
      return { operation: `同行评审 · ${Number.isInteger(entry.sector) ? `${entry.sector + 1} 号 · ` : ''}罚时`, event: true };
    case 'located':
      return {
        operation: `${entry.final ? '最后机会 · ' : ''}定位 X行星${canRead && Number.isInteger(entry.sector) ? ` ${entry.sector + 1} 号` : '（扇区保密）'}`,
        result: canRead ? `前邻：${labelOf(entry.left) || '未记录'}；后邻：${labelOf(entry.right) || '未记录'}` : null,
        status: `${game.playMode === 'builtin' ? '系统判定' : 'app 判定'}：${entry.correct === false ? '错误' : '正确'}`,
      };
    default:
      return { operation: '其他记录' };
  }
}

export function renderActionHistory({ state, api }) {
  const { game } = state;
  const entries = game.log || [];
  const { players, ownerOf } = historyPlayers(game, entries);
  const rows = entries.map((entry, index) => {
    const actorId = ownerOf(entry);
    const player = players.find(candidate => candidate.id === actorId);
    return { entry, index, actorId, player, ...describeEntry(entry, game, player.isMe) };
  });

  const content = row => h(
    'div',
    { class: 'history-entry' },
    h('div', { class: 'history-operation' }, row.operation),
    h(
      'div',
      { class: 'history-meta' },
      row.event ? h('span', { class: 'history-event-label' }, '公共事件', ` · ${row.player.name}`) : null,
      h('span', {}, Number.isFinite(row.entry.cost) ? row.entry.cost === 0 ? '不耗时' : `耗时 ${durationLabel(row.entry.cost)}` : '耗时未记录'),
      row.status ? h('span', { class: 'history-state' }, row.status) : null,
    ),
    row.result
      ? renderDisclosure(
          { state, api, id: `history-result-${row.entry.id ?? row.index}`, title: row.event ? '查看事件详情' : '查看结果', className: 'history-result', heading: 'span' },
          h('p', {}, row.result),
          Number.isFinite(row.entry.time) ? h('p', { class: 'muted small' }, `记录时棋子时间：${timeShort(row.entry.time, game.mode)}`) : null,
        )
      : row.hidden ? h('span', { class: 'history-private' }, row.hidden) : null,
  );

  const tableRows = rows.map(row => h(
    'tr',
    {
      class: `history-row${row.event ? ' history-event' : ''}${row.index === rows.length - 1 ? ' history-latest' : ''}`,
      'data-history-id': row.entry.id ?? row.index + 1,
      'data-actor-id': row.actorId,
    },
    h('th', { scope: 'row', class: 'history-sequence' }, String(row.index + 1).padStart(2, '0'), row.index === rows.length - 1 ? h('span', { class: 'history-new' }, '最新') : null),
    row.event
      ? h('td', { colspan: players.length }, content(row))
      : players.map(player => h('td', { class: `history-cell${player.isMe ? ' history-mine' : ''}` }, player.id === row.actorId ? content(row) : h('span', { class: 'history-empty', 'aria-label': '此次未行动' }, '—'))),
  ));
  const latest = rows.at(-1);
  return renderDisclosure(
    {
      state, api, id: 'history', title: '行动历史', className: 'card log-card',
      meta: h('span', { class: 'history-summary' }, h('span', { class: 'history-count' }, `${rows.length} 条`), latest ? h('span', { class: 'history-last' }, `最新：${latest.event ? '公共事件' : latest.player.name} · ${latest.operation}`) : null),
    },
    rows.length
      ? [
          h('div', { class: 'history-toolbar' },
            h('p', { class: 'muted small' }, '每行一次记录，按实际发生顺序排列；他人的私有结果不展示。'),
            h('button', { type: 'button', class: 'btn ghost small', onclick: () => tableRows.at(-1)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, '查看最新'),
          ),
          h('div', { class: 'history-table-wrap', 'data-history-scroll': true, role: 'region', 'aria-label': '行动历史表，可横向滚动查看所有玩家', tabindex: '0' },
            h('table', { class: 'history-table', style: `--history-players: ${players.length}` },
              h('caption', { class: 'sr-only' }, '行动历史：一列一名玩家，一行一次行动；公共事件跨玩家展示。'),
              h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'history-sequence' }, '顺序'), ...players.map(player => h('th', { scope: 'col', class: player.isMe ? 'history-mine' : '', style: { borderTopColor: player.color || 'var(--accent)' } }, player.name, player.isMe && game.players?.length ? '（我）' : '')))),
              h('tbody', {}, ...tableRows),
            ),
          ),
        ]
      : h('p', { class: 'muted small' }, '还没有行动。记录一次观测后，会在这里按玩家和先后顺序展示。'),
  );
}
