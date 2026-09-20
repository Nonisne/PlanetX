// Online room model: a shared record console plus per-player private data.
//
// Pure logic — no HTTP, no sockets — so it can be unit tested directly. The server
// (server.mjs) is a thin HTTP/SSE shell around this module, and every client renders
// the same console UI from the per-player view this module produces.
//
// What is shared, like the physical board:
//   * the time track (everybody has their own pawn on it, so the order matters)
//   * the visible sky window and its manual nudge
//   * the action log: who surveyed/scanned/researched, every published theory with
//     its peer-review track slot, conference clues, waits and the final locate
// What stays private to the player who did it:
//   * survey counts, scan results, research subject names and clue texts
//   * the object a theory claims, until a peer review reveals that sector
import {
  MAX_TARGET_USES,
  MODES,
  arcSectors,
  conferenceSectors,
  eventsAt,
  modeById,
  mod,
  theorySectors,
  timeLabel,
} from './rules.js';
import {
  actionRounds,
  advanceTheoryTrack,
  consoleSummary,
  consoleView,
  createConsole,
  emptyTopics,
  markTheoryReview,
  nudgeWindow,
  recordConference,
  recordLocate,
  recordResearch,
  recordSurvey,
  recordTarget,
  recordTheory,
  recordWait,
  revealObjects,
  theoriesAwaitingReview,
  theoryLockedSectors,
  theoryQuota,
  timeOf,
  undoLast,
  windowOf,
  TOPIC_IDS,
} from './console.js';
import { scoreBoard } from './score.js';
import { crossedEvents } from './phases.js';
import { Obj, INITIAL_CLUE_TYPES, THEORY_TYPES, apparentType } from './types.js';

/** Object types an initial clue may rule out. */
export const CLUE_TYPES = INITIAL_CLUE_TYPES;

/** App 开局最多给你这么多条"某扇区没有某天体"。 */
export const MAX_SETUP_CLUES = 12;

/** Fields that only the player who produced them may see (until `revealed`). */
export const PRIVATE_KEYS = Object.freeze({
  survey: Object.freeze(['count']),
  target: Object.freeze(['apparent']),
  research: Object.freeze(['name', 'text']),
  theory: Object.freeze(['objectType']),
  located: Object.freeze(['sector', 'left', 'right']),
});

/** The A–F subject names are the same for the whole table, so the host fills them in once. */
export function emptyTopicNames() {
  const out = {};
  for (const id of TOPIC_IDS) out[id] = '';
  return out;
}

/** One player's view of the six subjects: shared name + their private clue text. */
function mergedTopics(room, playerId) {
  const own = room.playerTopics[playerId] || emptyTopics();
  const out = {};
  for (const id of TOPIC_IDS) {
    out[id] = {
      name: (room.topicNames && room.topicNames[id]) || (own[id] && own[id].name) || '',
      clue: (own[id] && own[id].clue) || '',
    };
  }
  return out;
}

/** Keep every player's topic name in step with the shared one. */
function mirrorTopicNames(room) {
  for (const id of Object.keys(room.playerTopics)) {
    for (const topic of TOPIC_IDS) {
      const entry = room.playerTopics[id][topic];
      if (entry) entry.name = room.topicNames[topic] || '';
    }
  }
}

/** The board's conference sectors: 1 in standard mode, 2 in expert. */
function conferenceSectorsOf(room) {
  return conferenceSectors(room.session.mode);
}

const COLORS = ['#5eead4', '#f5b942', '#7c9cff', '#ff8fa3', '#a78bfa', '#7fdcff'];

function makeId(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function makeToken() {
  return `${Date.now().toString(36)}-${makeId(16)}`;
}

export function createRoom({ modeId = 'standard', hostName = '主持人', playMode = 'record', puzzle = null } = {}) {
  // an unknown mode must never reach the console (it would have no `mode` at all)
  const mode = modeById(modeId);
  if (!['record', 'builtin'].includes(playMode)) throw new Error('请选择记录模式或内置谜题模式');
  if (playMode === 'builtin' && mode.id !== 'standard') throw new Error('内置谜题目前支持标准 12 扇区棋盘');
  if (playMode === 'builtin' && (!puzzle || puzzle.objects?.length !== mode.sectors || !puzzle.topics || !puzzle.startingClues)) {
    throw new Error('内置谜题尚未生成，请重新创建房间');
  }
  const room = {
    id: makeId(),
    createdAt: Date.now(),
    modeId: mode.id,
    playMode,
    puzzle: playMode === 'builtin' ? puzzle : null,
    session: { ...createConsole({ modeId: mode.id }), topics: null, roomManaged: true },
    players: [],
    playerTopics: {},
    // filled in by the host during setup and shared by the whole table
    topicNames: emptyTopicNames(),
    conferenceRules: {},
    listeners: new Set(),
    // lobby -> setup (initial clues + A–F subject names) -> play -> done
    phase: 'lobby',
    // the open research phase, or null: see openResearchWindow()
    research: null,
    // a conference the table just walked over: { sector, byId } until it is recorded
    conference: null,
    setup: {},
  };
  const host = addPlayer(room, hostName);
  host.host = true;
  room.hostId = host.id;
  if (room.playMode === 'builtin') {
    room.topicNames = Object.fromEntries(TOPIC_IDS.map((topic) => [topic, puzzle.topics[topic].name]));
    mirrorTopicNames(room);
  }
  return room;
}

export function addPlayer(room, name) {
  if (room.playMode === 'builtin' && room.phase !== 'lobby') throw new Error('内置谜题已开始，不能中途加入');
  if (room.playMode === 'builtin' && room.players.length >= 6) throw new Error('内置谜题最多支持 6 名玩家');
  const used = new Set(room.players.map((p) => p.color));
  const player = {
    id: makeId(4),
    name: String(name || '').trim() || `玩家 ${room.players.length + 1}`,
    token: makeToken(),
    color: COLORS.find((c) => !used.has(c)) || COLORS[room.players.length % COLORS.length],
    joinedAt: Date.now(),
    host: false,
  };
  room.players.push(player);
  room.playerTopics[player.id] = emptyTopics();
  if (room.phase === 'setup') {
    // somebody joined after the host started: they still get a setup card
    room.setup[player.id] = { clues: [], noClues: false, topics: { ...emptyTopics() }, ready: false };
  }
  return player;
}

// ---- the time track: one pawn per player ------------------------------------

/**
 * How long a player has spent, plus how long they have been waiting in their current
 * sector. Time is per player, so the pawn that is furthest *behind* acts next — and
 * within one sector the player who got there first is the one who has waited longest
 * ("耗时少"), which also gives them priority in the research phase.
 */
export function spendKey(room, player) {
  let last = 0;
  for (const entry of room.session.entries) {
    if (entry.actorId === player.id && (entry.cost || 0) > 0) last = Math.max(last, entry.id);
  }
  return { clock: timeOf(room.session, player.id), last, join: room.players.indexOf(player) };
}

/** Earlier arrival inside one sector wins: both the turn and the publishing order use it. */
function arrivalFirst(a, b) {
  if (a.last !== b.last) return a.last - b.last;
  return a.join - b.join;
}

function spentLess(a, b) {
  if (a.clock !== b.clock) return a.clock < b.clock;
  return arrivalFirst(a, b) < 0;
}

/** Everybody, least time first: the order in which players act (and publish). */
export function turnOrder(room) {
  return room.players
    .map((player) => ({ player, key: spendKey(room, player) }))
    .sort((a, b) => (spentLess(a.key, b.key) ? -1 : 1))
    .map((row) => row.player);
}

/** The player whose turn it is, or null outside the play phase. */
export function currentPlayer(room) {
  if (room.phase !== 'play') return null;
  return turnOrder(room)[0] || null;
}

/**
 * Who publishes first in a research phase: the same order as the turn order — the player
 * furthest behind goes first, and a tie goes to whoever reached the sector first.
 */
export function researchOrder(room) {
  return turnOrder(room);
}

/** Where a player's pawn stands: elapsed months and the 1-based sector. */
export function pawnOf(room, playerId) {
  const clock = timeOf(room.session, playerId);
  return { time: clock, sector: (clock % room.session.mode.sectors) + 1 };
}

/** Kinds that consume a turn; conferences, theories, reviews and nudges do not. */
const TURN_ACTIONS = new Set(['survey', 'target', 'research', 'wait']);

export function setupDefaults() {
  return { clues: [], noClues: false, topics: { ...emptyTopics() }, ready: false };
}

/** Which setup cards are still missing. */
export function readyCount(room) {
  return room.players.filter((p) => room.setup[p.id] && room.setup[p.id].ready).length;
}

export function playerByToken(room, token) {
  return room.players.find((p) => p.token === token) || null;
}

export function playerById(room, id) {
  return room.players.find((p) => p.id === id) || null;
}

/** The console state as seen by one player: private fields merged in, others stripped. */
export function stateFor(room, playerId) {
  const entries = room.session.entries.map((entry) => {
    const copy = { ...entry };
    delete copy.private;
    delete copy.payload;
    if (entry.actorId === playerId) {
      Object.assign(copy, entry.private || {});
    } else if (!entry.revealed) {
      // a revealed entry (a theorem that a peer review made public) is everybody's
      for (const key of PRIVATE_KEYS[entry.type] || []) delete copy[key];
    }
    return copy;
  });
  const locate = room.session.locate ? { ...room.session.locate } : null;
  const locator = locate?.actorId || [...room.session.entries].reverse().find((entry) => entry.type === 'located')?.actorId;
  if (locate && locator !== playerId && !room.session.revealedObjects) {
    for (const key of PRIVATE_KEYS.located) delete locate[key];
  }
  return {
    ...room.session,
    entries,
    locate,
    actorId: playerId,
    topics: mergedTopics(room, playerId),
  };
}

/** The full payload a client renders from. Must be JSON-safe: it travels over HTTP/SSE. */
export function viewFor(room, playerId) {
  const view = consoleView(stateFor(room, playerId));
  const me = playerById(room, playerId);
  const turnPlayer = currentPlayer(room);
  view.roomId = room.id;
  view.modeId = room.modeId;
  view.playMode = room.playMode || 'record';
  view.me = playerId;
  view.phase = room.phase;
  view.hostId = room.hostId || null;
  view.amHost = playerId === room.hostId;
  view.turnPlayerId = turnPlayer ? turnPlayer.id : null;
  view.turnPlayerName = turnPlayer ? turnPlayer.name : null;
  view.isMyTurn = Boolean(turnPlayer && turnPlayer.id === playerId);
  view.readyCount = readyCount(room);
  view.playerCount = room.players.length;
  view.canStart = playerId === room.hostId && room.phase === 'lobby' && room.players.length >= (room.playMode === 'builtin' ? 1 : 2);
  view.mySetup = me ? room.setup[playerId] || null : null;
  view.topicNames = { ...room.topicNames };
  view.conferenceRules = { ...room.conferenceRules };
  view.conferenceRuleSectors = conferenceSectorsOf(room);
  view.players = room.players.map((p) => {
    const pawn = pawnOf(room, p.id);
    const key = spendKey(room, p);
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      host: p.id === room.hostId,
      ready: Boolean(room.setup[p.id] && room.setup[p.id].ready),
      clues: room.session.entries.filter((e) => e.type === 'research' && e.actorId === p.id).length,
      theories: room.session.entries.filter((e) => e.type === 'theory' && e.actorId === p.id).length,
      scansLeft: MAX_TARGET_USES - room.session.entries.filter((e) => e.type === 'target' && e.actorId === p.id).length,
      time: pawn.time,
      timeLabel: timeLabel(pawn.time, room.session.mode),
      sector: pawn.sector,
      isMe: p.id === playerId,
      isTurn: Boolean(turnPlayer && turnPlayer.id === p.id),
      pendingReviews: theoriesAwaitingReview(room.session).filter((t) => t.actorId === p.id).length,
      // how long they have been waiting in that sector: the board sorts the pawns with it
      arrival: key.last,
      joinIndex: key.join,
    };
  });
  view.research = researchView(room, playerId);
  view.endgame = endgameView(room, playerId);
  view.conference = conferenceView(room);
  view.turnOrder = turnOrder(room).map((p) => p.id);
  // the round table and the score table speak for the whole table, so they are rebuilt
  // from this player's (redacted) log with everybody's names attached
  const mineState = stateFor(room, playerId);
  view.rounds = actionRounds(mineState, view.players);
  view.scores = scoreBoard(mineState, view.players);

  // The sky window is one shared dial and it follows the pawn that is furthest behind:
  // its sector is the window's first visible sector, so the whole table observes from
  // the same place and only that player's crossings can trigger an event.
  const laggard = currentPlayer(room);
  const windowTime = room.endgame ? room.endgame.windowTime : laggard ? timeOf(room.session, laggard.id) : view.time;
  const sharedWindow = windowOf(room.session, windowTime);
  const sharedEvents = eventsAt(room.session.mode, windowTime);
  view.visibleStart = sharedWindow.start;
  view.visible = sharedWindow.sectors;
  view.arrowSector = sharedEvents.sector;
  view.events = sharedEvents;
  view.windowTime = windowTime;
  view.windowPlayerId = laggard ? laggard.id : null;
  view.windowPlayerName = laggard ? laggard.name : null;
  // Sets and Maps do not survive JSON, so hand the client plain arrays
  view.researched = [...view.researched];
  view.theoryLockedSectors = [...view.theoryLockedSectors];
  view.summary = consoleSummary(stateFor(room, playerId));
  return view;
}

/** The open research phase as one player sees it (their own papers stay theirs). */
function researchView(room, playerId) {
  const phase = room.research;
  if (!phase) return null;
  const declared = Object.keys(phase.declares).length;
  const myPicks = phase.picks.filter((pick) => pick.playerId === playerId);
  return {
    id: phase.id,
    sector: phase.sector,
    quota: phase.quota,
    maxDeclare: declarationCapacity(room, playerId),
    playerCount: room.players.length,
    declaredCount: declared,
    allDeclared: declared >= room.players.length,
    myCount: Object.prototype.hasOwnProperty.call(phase.declares, playerId) ? phase.declares[playerId] : null,
    left: phase.left[playerId] || 0,
    order: phase.order.slice(),
    orderNames: phase.order.map((id) => (playerById(room, id) || {}).name || '？'),
    cursorId: phase.cursorId || null,
    cursorName: phase.cursorId ? (playerById(room, phase.cursorId) || {}).name || '？' : null,
    isMyPick: phase.cursorId === playerId && (phase.left[playerId] || 0) > 0,
    // the sector everyone published to is public; the object they claimed is not
    picks: phase.picks.map((pick) => ({ playerId: pick.playerId, sector: pick.sector })),
    myPicks: myPicks.map((pick) => ({ sector: pick.sector, objectType: pick.objectType })),
  };
}

/**
 * The conference prompt, if the table just walked over a conference sector: everybody
 * should look at the app and type the rule in. Recording it (or the host's note from
 * setup) closes the prompt.
 */
function conferenceView(room) {
  const pending = room.conference;
  if (!pending) return null;
  return {
    sector: pending.sector,
    label: `扇区 ${pending.sector} 的 X行星会议`,
    byName: pending.byId ? (playerById(room, pending.byId) || {}).name || '？' : null,
    text: room.conferenceRules[pending.sector] || '',
  };
}

const ACTIONS = {
  survey: recordSurvey,
  target: recordTarget,
  research: recordResearch,
  theory: recordTheory,
  conference: recordConference,
  wait: recordWait,
  locate: recordLocate,
};

const MAX_TOPIC_NAME = 40;
const MAX_CONFERENCE_NOTE = 240;

/** The six shared subject names, as typed by the host. */
function readTopicNames(raw) {
  const names = emptyTopicNames();
  for (const id of TOPIC_IDS) {
    const value = String((raw && raw[id]) || '').trim().slice(0, MAX_TOPIC_NAME);
    names[id] = value;
  }
  return { ok: true, names };
}

/** The shared conference notes: one per conference sector of this board (1 or 2). */
function readConferenceRules(room, raw) {
  const allowed = conferenceSectorsOf(room);
  const rules = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const sector = Number(key);
    if (!allowed.includes(sector)) continue; // a note for a sector this board does not use
    const text = String(value == null ? '' : value).trim().slice(0, MAX_CONFERENCE_NOTE);
    if (text) rules[sector] = text;
  }
  return { ok: true, rules };
}

/**
 * Apply one player's action to the shared room.
 * Room-level actions (start-game / setup / skip-turn) drive the phases; recording
 * actions are validated by the same console engine the offline mode uses, with
 * `actorId` set so per-player rules are enforced for that player only.
 */
const RECORD_ONLY_ACTIONS = new Set(['review', 'conference', 'undo', 'nudge', 'reveal-objects', 'set-topic-names', 'set-conference-rules', 'skip-turn']);

function resolveBuiltinAction(room, action) {
  const objects = room.puzzle.objects;
  if (action.kind === 'survey') {
    const validRange = Number.isInteger(action.start) && action.start >= 0 && action.start < objects.length &&
      Number.isInteger(action.size) && action.size >= 1 && action.size <= room.session.mode.visible;
    const count = validRange ? arcSectors(action.start, action.size, objects.length).filter((sector) => apparentType(objects[sector]) === action.type).length : 0;
    return { ...action, count };
  }
  if (action.kind === 'target') return { ...action, apparent: apparentType(objects[action.sector]) };
  if (action.kind === 'research') {
    const topic = Object.hasOwn(room.puzzle.topics, action.topic) ? room.puzzle.topics[action.topic] : null;
    return { ...action, name: topic?.name || '', text: topic?.clue || '' };
  }
  if (action.kind === 'locate') {
    const correct = Number.isInteger(action.sector) && objects[action.sector] === Obj.PLANET_X &&
      objects[mod(action.sector - 1, objects.length)] === action.left && objects[mod(action.sector + 1, objects.length)] === action.right;
    return { ...action, correct };
  }
  return action;
}

function settleBuiltin(room) {
  if (room.conference && room.phase === 'play') {
    const sector = room.conference.sector;
    const text = room.puzzle.conferences[sector];
    const recorded = act(room, playerById(room, room.conference.byId) || room.players[0], { kind: 'conference', sector, text }, { fn: recordConference });
    if (!recorded.ok) return recorded;
    room.conferenceRules[sector] = text;
    room.conference = null;
  }
  while (room.phase === 'play' && theoriesAwaitingReview(room.session).length) {
    const theory = theoriesAwaitingReview(room.session).sort((first, second) => first.sector - second.sector || first.id - second.id)[0];
    const reviewed = reviewTheory(room, room.hostId, { id: theory.id, review: room.puzzle.objects[theory.sector] === theory.objectType ? 'correct' : 'wrong' });
    if (!reviewed.ok) return reviewed;
    if (room.conference) {
      const settled = settleBuiltin(room);
      if (!settled.ok) return settled;
    }
  }
  if (room.phase === 'reveal') {
    const revealed = revealObjects(room.session, room.puzzle.objects);
    if (!revealed.ok) return revealed;
    room.phase = 'done';
  }
  return { ok: true };
}

export function applyRoomAction(room, playerId, action) {
  if (!playerById(room, playerId)) return { ok: false, error: '你不在这个房间里' };
  if (!action || typeof action !== 'object') return { ok: false, error: '行动格式不合法' };
  if (room.playMode === 'builtin' && RECORD_ONLY_ACTIONS.has(action.kind)) {
    return { ok: false, error: '内置谜题由系统自动判定，不能手动修改结果或时间轨' };
  }
  const resolved = room.playMode === 'builtin' ? resolveBuiltinAction(room, action) : action;
  const result = applyAction(room, playerId, resolved);
  if (result.ok && room.playMode === 'builtin') {
    const settled = settleBuiltin(room);
    if (!settled.ok) return settled;
  }
  return result;
}

function applyAction(room, playerId, action) {
  const player = playerById(room, playerId);
  if (!player) return { ok: false, error: '你不在这个房间里' };
  const kind = action && action.kind;
  const isHost = playerId === room.hostId;

  if (room.phase === 'final') return finalAction(room, player, action);
  if (room.phase === 'reveal') {
    if (!isHost || kind !== 'reveal-objects') return { ok: false, error: '等待房主填写 app 最终揭晓结果' };
    const result = revealObjects(room.session, action.objects);
    if (result.ok) room.phase = 'done';
    return result;
  }
  if (room.phase === 'done') return { ok: false, error: '本局已结束' };

  // ---- lobby ----
  if (kind === 'start-game') {
    if (!isHost) return { ok: false, error: '只有房主可以开始游戏' };
    if (room.phase !== 'lobby') return { ok: false, error: '游戏已经开始过了' };
    if (room.players.length < 2 && room.playMode !== 'builtin') return { ok: false, error: '至少需要 2 名玩家才能开始（单人请用单机记录台）' };
    room.phase = 'setup';
    for (const [index, participant] of room.players.entries()) {
      const card = setupDefaults();
      if (room.playMode === 'builtin') {
        card.clues = room.puzzle.startingClues[index].map((clue) => ({ sector: clue.sector, type: clue.objectType }));
        card.topics = mergedTopics(room, participant.id);
      }
      room.setup[participant.id] = card;
    }
    return { ok: true, phase: room.phase };
  }

  // ---- setup: initial clues + the shared A–F names + the conference notes ----
  if (kind === 'setup' || kind === 'setup-reopen') {
    if (room.phase !== 'setup') return { ok: false, error: '现在不是填写开局信息的阶段' };

    // fill in your card again: the table is still waiting for the others
    if (kind === 'setup-reopen') {
      if (room.setup[playerId]) room.setup[playerId].ready = false;
      return { ok: true, phase: room.phase, ready: readyCount(room) };
    }

    const card = room.setup[playerId] || setupDefaults();
    if (room.playMode === 'builtin') {
      card.ready = true;
      room.setup[playerId] = card;
      if (readyCount(room) === room.players.length) room.phase = 'play';
      return { ok: true, phase: room.phase, ready: readyCount(room) };
    }
    const rawClues = action.noClues ? [] : Array.isArray(action.clues) ? action.clues : [];
    if (rawClues.length > MAX_SETUP_CLUES) return { ok: false, error: `初始线索最多填 ${MAX_SETUP_CLUES} 条` };
    const clues = [];
    for (const clue of rawClues) {
      const sector = Number(clue && clue.sector);
      const type = clue && clue.type;
      if (!Number.isInteger(sector) || sector < 0 || sector >= room.session.mode.sectors) {
        return { ok: false, error: '初始线索的扇区编号不合法' };
      }
      if (!CLUE_TYPES.includes(type)) return { ok: false, error: '初始线索的天体只能是：小行星／彗星／气体云／矮行星' };
      if (clues.some((c) => c.sector === sector && c.type === type)) continue;
      clues.push({ sector, type });
    }

    // the six subject names are printed on everybody's sheet, so only the host types them
    if (isHost && action.topics) {
      const names = readTopicNames(action.topics);
      if (!names.ok) return names;
      room.topicNames = names.names;
      mirrorTopicNames(room);
    }
    // the conference notes are shared knowledge too, but they only exist in 1 or 2 places
    if (isHost && action.conferences) {
      const rules = readConferenceRules(room, action.conferences);
      if (!rules.ok) return rules;
      room.conferenceRules = rules.rules;
    }

    const topics = {};
    for (const id of TOPIC_IDS) {
      topics[id] = { name: room.topicNames[id] || '', clue: (card.topics[id] && card.topics[id].clue) || '' };
    }
    room.setup[playerId] = { clues, noClues: Boolean(action.noClues), topics, ready: true };
    room.playerTopics[playerId] = topics;
    if (readyCount(room) === room.players.length) room.phase = 'play';
    return { ok: true, phase: room.phase, ready: readyCount(room) };
  }

  // ---- the host may correct the table-wide setup information later on ----
  if (kind === 'set-topic-names' || kind === 'set-conference-rules') {
    if (!isHost) return { ok: false, error: '只有房主可以修改全桌共享的开局信息' };
    if (room.phase !== 'setup' && room.phase !== 'play') return { ok: false, error: '开局信息只能在对局中修改' };
    if (kind === 'set-topic-names') {
      const names = readTopicNames(action.names || {});
      if (!names.ok) return names;
      room.topicNames = names.names;
      mirrorTopicNames(room);
      return { ok: true, names: room.topicNames };
    }
    const rules = readConferenceRules(room, action.rules || {});
    if (!rules.ok) return rules;
    room.conferenceRules = rules.rules;
    return { ok: true, rules: room.conferenceRules };
  }

  if (kind === 'skip-turn') {
    if (!isHost) return { ok: false, error: '只有房主可以跳过' };
    if (room.phase !== 'play') return { ok: false, error: '现在不是行动阶段' };
    // in a research phase "skip" hands the table forward instead of moving a pawn
    if (room.research) return skipResearchStep(room);
    if (theoriesAwaitingReview(room.session).length) return { ok: false, error: '先完成同行评审，不能跳过罚时结算' };
    return act(room, currentPlayer(room), { kind: 'wait' }, { skipped: true });
  }

  if (room.phase === 'lobby') return { ok: false, error: '游戏还没开始（房主先点「开始游戏」）' };
  if (room.phase === 'setup') return { ok: false, error: '请先填写初始线索与 A–F 课题名称' };

  // ---- the research phase: declare how many papers, then publish in time order ----
  if (kind === 'research-declare' || kind === 'research-submit') {
    if (!room.research) return { ok: false, error: '现在不是学术研究阶段' };
    if (action.phaseId !== room.research.id) return { ok: false, error: '学术研究阶段已变化，请按最新阶段重新提交' };
  }
  if (kind === 'research-declare') return declareResearch(room, playerId, action.count);

  if (kind === 'research-submit') {
    if (!room.research) return { ok: false, error: '现在不是学术研究阶段' };
    return publishTheory(room, playerId, action);
  }

  if (kind === 'nudge') return nudgeWindow(room.session, action.delta);

  if (kind === 'conference') {
    const res = act(room, player, action, { fn: recordConference });
    // writing the clue down answers the prompt the crossing opened
    if (res.ok && room.conference && Number(room.conference.sector) === Number(action.sector)) room.conference = null;
    return res;
  }

  if (kind === 'review') return reviewTheory(room, playerId, action);

  if (room.phase === 'done') return { ok: false, error: '本局已结束' };

  // free actions that never consume a turn
  if (kind === 'undo') {
    if (room.research) return { ok: false, error: '学术研究阶段已经开始，等这一步走完再撤销' };
    const last = room.session.entries[room.session.entries.length - 1];
    if (!last) return { ok: false, error: '没有可以撤销的记录' };
    if (last.actorId && last.actorId !== playerId) return { ok: false, error: '只能撤销自己刚做的那一步' };
    // the pawns are derived from the log, so popping the last entry winds the actor's
    // clock back and the turn order follows automatically
    return undoLast(room.session);
  }

  if (TURN_ACTIONS.has(kind) || kind === 'locate') {
    if (room.research) {
      return { ok: false, error: '现在是学术研究阶段：先选要提交的篇数，再按时间顺序提交' };
    }
    if (theoriesAwaitingReview(room.session).length) return { ok: false, error: '先完成同行评审，再继续行动' };
    const who = currentPlayer(room);
    if (who && who.id !== playerId) return { ok: false, error: `现在轮到 ${who.name} 行动（他耗时最少，天窗也跟着他走）` };
  }

  if (kind === 'theory') {
    // publishing is not a free action any more: it belongs to a triggered phase
    return { ok: false, error: '提交学术研究只在时间轨箭头越过学术研究扇区后触发，届时全桌一起提交' };
  }

  const fn = ACTIONS[kind];
  if (!fn) return { ok: false, error: `未知的行动：${kind}` };
  return act(room, player, action, { fn });
}

/** Run one recording action through the shared engine and move the actor's pawn. */
function act(room, player, action, { fn = ACTIONS[action && action.kind], skipped = false, engineOptions } = {}) {
  const kind = action.kind;
  if (!player) return { ok: false, error: '没有可以行动的玩家' };
  if (!fn) return { ok: false, error: `未知的行动：${kind}` };

  const before = windowTimeOf(room);
  const ctx = { ...room.session, actorId: player.id, topics: { ...(room.playerTopics[player.id] || emptyTopics()) } };
  // The visible sky window is one shared dial: it stands on the laggard's month and every
  // player observes the same sectors. Pin it here so survey/scan checks (which read the
  // window off the state) validate against the table's window, not the actor's own clock.
  ctx.windowTime = before;
  // the engine works on name+clue, but only the clue text is this player's own
  for (const id of TOPIC_IDS) ctx.topics[id] = { ...(ctx.topics[id] || { name: '', clue: '' }), name: room.topicNames[id] || ctx.topics[id]?.name || '' };
  const res = fn(ctx, action, engineOptions);
  if (!res.ok) return res;
  if (res.entry && res.entry.actorId === undefined) res.entry.actorId = player.id;
  // status/locate/seq live outside the entries list, so copy the scalars back — without
  // `seq` every entry would be stamped with the same id
  room.session.status = ctx.status;
  room.session.locate = ctx.locate;
  room.session.seq = ctx.seq;
  room.playerTopics[player.id] = ctx.topics;

  // a research action names the subject it used: adopt it table-wide if nobody had yet
  if (kind === 'research') {
    const named = ctx.topics[action.topic];
    if (named && named.name && !room.topicNames[action.topic]) {
      room.topicNames[action.topic] = named.name;
      mirrorTopicNames(room);
    }
  }

  if (kind === 'locate' && res.entry.correct) {
    beginEndgame(room, player, before, res.entry);
    return res;
  }

  if (TURN_ACTIONS.has(kind) || kind === 'locate') {
    // the shared window may have moved (it follows whoever is furthest behind): whatever
    // it passed over sets off a research phase or a conference reminder
    windowEvents(room, before, windowTimeOf(room), player.id);
  }
  if (skipped) res.skipped = true;
  return res;
}

function beginEndgame(room, finder, windowTime, entry) {
  const frozenTimes = Object.fromEntries(room.players.map((player) => [player.id, timeOf(room.session, player.id)]));
  const players = turnOrder(room).filter((player) => player.id !== finder.id && frozenTimes[finder.id] > frozenTimes[player.id]).map((player) => {
    const behind = frozenTimes[finder.id] - frozenTimes[player.id];
    return { id: player.id, name: player.name, behind, quota: behind <= 3 ? 1 : 2, done: false, choice: null };
  });
  room.endgame = { firstFinderId: finder.id, firstFinderName: finder.name, frozenTimes, windowTime, publicationPhase: `final:${entry.id}`, players };
  room.research = null;
  room.pendingResearch = null;
  room.conference = null;
  advanceEndgame(room);
}

function advanceEndgame(room) {
  room.endgame.cursorId = room.endgame.players.find((player) => !player.done)?.id || null;
  room.phase = room.endgame.cursorId ? 'final' : 'reveal';
  room.session.status = room.phase;
}

function endgameView(room, playerId) {
  if (!room.endgame) return null;
  const ending = room.endgame;
  const own = ending.players.find((player) => player.id === playerId);
  return {
    firstFinderId: ending.firstFinderId,
    firstFinderName: ending.firstFinderName,
    cursorId: ending.cursorId,
    cursorName: playerById(room, ending.cursorId)?.name || null,
    isMyTurn: room.phase === 'final' && ending.cursorId === playerId,
    behind: own?.behind || 0,
    quota: own?.quota || 0,
    canReveal: room.phase === 'reveal' && room.hostId === playerId,
    players: ending.players.map((player) => ({ ...player })),
  };
}

function finalAction(room, player, action) {
  const current = room.endgame.players.find((candidate) => candidate.id === room.endgame.cursorId);
  const hostSkip = player.id === room.hostId && action.kind === 'skip-turn';
  if (!current || (!hostSkip && player.id !== current.id)) return { ok: false, error: '现在不是你的最后得分机会' };
  const kind = hostSkip ? 'final-pass' : action.kind;
  if (!['locate', 'final-theories', 'final-pass'].includes(kind)) return { ok: false, error: '最后机会只能定位、提交论文或放弃，棋子不再移动' };
  let result = { ok: true };
  if (kind !== 'final-pass') {
    const context = { ...room.session, entries: room.session.entries.map((entry) => ({ ...entry })), actorId: current.id };
    if (kind === 'locate') {
      result = recordLocate(context, action, { final: true, distanceBehind: current.behind });
    } else {
      const theories = action.theories;
      if (!Array.isArray(theories) || theories.length > current.quota) return { ok: false, error: `最后最多可以提交 ${current.quota} 篇论文` };
      for (const theory of theories) {
        if (!theory || typeof theory !== 'object') return { ok: false, error: '论文格式不合法' };
        result = recordTheory(context, { sector: theory.sector, type: theory.objectType }, { enforceSchedule: false, phaseId: room.endgame.publicationPhase, final: true });
        if (!result.ok) return result;
      }
    }
    if (!result.ok) return result;
    room.session.entries.push(...context.entries.slice(room.session.entries.length));
    room.session.seq = context.seq;
  }
  current.choice = kind;
  current.done = true;
  advanceEndgame(room);
  return result;
}

/**
 * Which theory sectors the *shared window* passed while moving from `before` to `after`.
 * The window follows the pawn furthest behind, and its start sector is that pawn's month,
 * so `month t` points at sector `t % n + 1`. A one-month penalty moves it just like an
 * action does — but only when the penalised player was the one setting the window.
 */
export function crossedTheorySectors(mode, before, after) {
  return crossedEvents(mode, before, after).filter((event) => event.kind === 'theory').map((event) => event.sector);
}

/** The first research sector the window passed, or 0. */
export function crossedTheorySector(mode, before, after) {
  return crossedTheorySectors(mode, before, after)[0] || 0;
}

/** Which conference sectors the window passed (same arithmetic, different schedule). */
export function crossedConferenceSectors(mode, before, after) {
  return crossedEvents(mode, before, after).filter((event) => event.kind === 'conference').map((event) => event.sector);
}

/** The first conference sector the window passed, or 0. */
export function crossedConferenceSector(mode, before, after) {
  return crossedConferenceSectors(mode, before, after)[0] || 0;
}

/** Where the shared window starts right now: the month of the pawn furthest behind. */
export function windowTimeOf(room) {
  const laggard = currentPlayer(room);
  return laggard ? timeOf(room.session, laggard.id) : 0;
}

/**
 * Whatever a move of the shared window sets off: a research phase for every research
 * sector it passed, plus a reminder for the first conference sector it passed.
 */
function windowEvents(room, before, after, byId) {
  if (after <= before) return;
  for (const event of crossedEvents(room.session.mode, before, after)) {
    if (event.kind === 'theory') queueResearch(room, event);
  }
  const conference = crossedConferenceSector(room.session.mode, before, after);
  if (conference) queueConference(room, conference, byId);
}

/**
 * The conference prompt: opened when the window walks over a conference sector that has
 * not been recorded yet. It never blocks the table — it just asks for the app's rule.
 */
function queueConference(room, sector, playerId) {
  if (room.conference) return room.conference; // one prompt at a time
  if (room.session.entries.some((e) => e.type === 'conference' && e.sector === sector)) return null; // already written down
  room.conference = { sector, byId: playerId };
  return room.conference;
}

/**
 * A research phase: everybody declares at once, then publishes from the pawn furthest
 * behind. If one is already running the new one waits its turn in `pendingResearch`.
 */
function queueResearch(room, event) {
  const pending = room.pendingResearch || (room.pendingResearch = []);
  if (room.research?.id !== event.id && !pending.some((queued) => queued.id === event.id)) pending.push(event);
  return nextResearch(room);
}

function openResearchWindow(room, event) {
  room.research = {
    id: event.id,
    time: event.time,
    sector: event.sector,
    quota: theoryQuota(room.session.mode),
    declares: {},
    order: [],
    left: {},
    cursorId: null,
    picks: [],
  };
  return room.research;
}

/** Close the running phase, stepping the track on, then open whatever was queued. */
function closeResearch(room) {
  const phase = room.research;
  // The phase is over, so the conveyor moves: every face-down paper (this round's included)
  // steps one space closer to review, which is what keeps a round's papers together.
  if (phase) phase.advanced = advanceTheoryTrack(room.session);
  room.session.undoBarrier = room.session.seq - 1;
  room.research = null;
  if (theoriesAwaitingReview(room.session).length) return null;
  return nextResearch(room);
}

function nextResearch(room) {
  if (room.research || theoriesAwaitingReview(room.session).length) return room.research;
  const pending = room.pendingResearch || [];
  const next = pending.shift();
  if (!pending.length) room.pendingResearch = null;
  if (next !== undefined) openResearchWindow(room, next);
  return room.research;
}

function declarationCapacity(room, playerId) {
  const phase = room.research;
  const locked = theoryLockedSectors(room.session);
  const ownTheories = room.session.entries.filter((entry) => entry.type === 'theory' && (!entry.actorId || entry.actorId === playerId));
  let capacity = 0;
  for (let sector = 0; sector < room.session.mode.sectors && capacity < phase.quota; sector++) {
    if (locked.has(sector)) continue;
    const previous = ownTheories.filter((entry) => entry.sector === sector);
    if (previous.some((entry) => entry.publicationPhase === phase.id)) continue;
    if (THEORY_TYPES.some((objectType) => !previous.some((entry) => entry.objectType === objectType))) capacity++;
  }
  return capacity;
}

function declareResearch(room, playerId, count) {
  const phase = room.research;
  if (!phase) return { ok: false, error: '现在不是学术研究阶段' };
  if (phase.order.length) return { ok: false, error: '篇数已经定了，现在按顺序提交' };
  if (Object.prototype.hasOwnProperty.call(phase.declares, playerId)) {
    return { ok: false, error: '你已经选过篇数了（不能更改）' };
  }
  const declaredCount = Number(count);
  if (!Number.isInteger(declaredCount) || declaredCount < 0 || declaredCount > phase.quota) {
    return { ok: false, error: `篇数只能是 0 到 ${phase.quota}（${room.session.mode.name}）` };
  }
  const capacity = declarationCapacity(room, playerId);
  if (declaredCount > capacity) return { ok: false, error: `本阶段你最多可提交 ${capacity} 篇论文（按尚可提交的不同扇区计算）` };
  phase.declares[playerId] = declaredCount;
  if (Object.keys(phase.declares).length >= room.players.length) startResearchPublishing(room);
  return { ok: true, count: declaredCount, research: phase };
}

function startResearchPublishing(room) {
  const phase = room.research;
  for (const player of room.players) {
    if (!Object.prototype.hasOwnProperty.call(phase.declares, player.id)) phase.declares[player.id] = 0;
  }
  const publishers = researchOrder(room).filter((p) => (phase.declares[p.id] || 0) > 0);
  phase.order = publishers.map((p) => p.id);
  for (const player of publishers) phase.left[player.id] = phase.declares[player.id];
  phase.cursorId = phase.order[0] || null;
  if (!phase.cursorId) closeResearch(room); // everybody passed
  return phase;
}

/** The current publisher hands the turn to the next one, or closes the phase. */
function advanceResearch(room) {
  const phase = room.research;
  if (!phase) return null;
  for (const id of phase.order) {
    if ((phase.left[id] || 0) > 0) {
      phase.cursorId = id;
      return phase;
    }
  }
  closeResearch(room);
  return null;
}

/** The host can push a stuck research phase along. */
function skipResearchStep(room) {
  const phase = room.research;
  if (!phase) return { ok: false, error: '现在不是学术研究阶段' };
  if (!phase.order.length) {
    startResearchPublishing(room); // nobody left to declare: take 0 from the missing ones
    return { ok: true, skipped: true, phase: 'declare' };
  }
  if (phase.cursorId) phase.left[phase.cursorId] = 0;
  advanceResearch(room);
  return { ok: true, skipped: true };
}

/** Publish one paper inside the open phase: only the player at the cursor, object private. */
function publishTheory(room, playerId, action) {
  const phase = room.research;
  if (!phase.order.length) return { ok: false, error: '先等所有人选好要提交的篇数' };
  if (phase.cursorId !== playerId) {
    const who = playerById(room, phase.cursorId);
    return { ok: false, error: `按"靠后的先提交"，现在轮到 ${who ? who.name : '别人'}` };
  }
  if ((phase.left[playerId] || 0) <= 0) return { ok: false, error: '你这个阶段的名额已经用完了' };
  const player = playerById(room, playerId);
  // the phase itself is the schedule, so the engine only has to check the hard rules; the
  // track steps forward when the phase closes, not on each paper
  const res = act(room, player, { kind: 'theory', sector: action.sector, type: action.objectType }, {
    fn: recordTheory,
    engineOptions: { enforceSchedule: false, phaseId: phase.id },
  });
  if (!res.ok) return res;
  const entry = res.entry;
  phase.left[playerId] -= 1;
  phase.picks.push({ playerId, sector: entry.sector, objectType: entry.objectType, id: entry.id });
  advanceResearch(room);
  return res;
}

/** Peer review: the author (or the host) reports what the app said. */
function reviewTheory(room, playerId, action) {
  const entry = room.session.entries.find((e) => e.id === action.id && e.type === 'theory');
  if (!entry) return { ok: false, error: '找不到这条学术研究记录' };
  const isHost = playerId === room.hostId;
  if (entry.actorId && entry.actorId !== playerId && !isHost) {
    return { ok: false, error: '只有这篇研究的作者（或房主）可以填写评审结果' };
  }
  const authorId = entry.actorId || playerId;
  const windowBefore = windowTimeOf(room);
  const res = markTheoryReview(room.session, action.id, action.review, { playerOrder: turnOrder(room).map((player) => player.id) });
  if (!res.ok) return res;
  if (res.penalties?.length) {
    windowEvents(room, windowBefore, windowTimeOf(room), authorId);
  }
  if (!room.research && !theoriesAwaitingReview(room.session).length) nextResearch(room);
  return res;
}

/** The clock/cursor writes above moved the phase; keep the helper names honest. */
export function isHostTurn(room, playerId) {
  const who = currentPlayer(room);
  return !who || who.id === playerId;
}

export function roomSummary(room) {
  return {
    id: room.id,
    modeId: room.modeId,
    playMode: room.playMode || 'record',
    players: room.players.map((p) => ({ id: p.id, name: p.name, host: Boolean(p.host), color: p.color })),
    entries: room.session.entries.length,
  };
}

export { MODES, consoleView, consoleSummary };
