// Record console ("记录台"): a digital play surface and record sheet for playing the
// real board game with the official app.
//
// It deliberately does NOT know the puzzle. Nothing is generated, deduced or
// verified: the player types in every observation, and the page keeps the time track,
// the rotating sky window, the star map and the note sheet in sync.
//
import {
  COST,
  MAX_TARGET_USES,
  THEORY_TRACK,
  TIME_UNITS_PER_SHIFT,
  arcSectors,
  cometSectors,
  conferenceSectors,
  durationLabel,
  eventsAt,
  isCometSector,
  mod,
  modeById,
  surveyCost,
  theorySectors,
  timeLabel,
  timeParts,
  timeShort,
  visibleStartAt,
} from './rules.js';
import { CODE, LABEL, Obj, SURVEY_TYPES, THEORY_TYPES, apparentType } from './types.js';
import { scoreBoard } from './score.js';
import { crossedEvents } from './phases.js';

export const APPARENT_TYPES = SURVEY_TYPES;
export const TOPIC_IDS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

export function emptyTopics() {
  const out = {};
  for (const id of TOPIC_IDS) out[id] = { name: '', clue: '' };
  return out;
}

function fail(error) {
  return { ok: false, error };
}

export function createConsole({ modeId = 'standard', actorId = null } = {}) {
  return {
    kind: 'console',
    mode: modeById(modeId),
    actorId,
    entries: [],
    status: 'open',
    locate: null,
    windowOffset: 0,
    windowTime: null,
    revealedObjects: null,
    undoBarrier: 0,
    topics: emptyTopics(),
    theoryPhases: [],
    completedTheoryPhases: [],
    seq: 1,
  };
}

/** True when an entry belongs to the player this state speaks for. */
function mine(state, entry) {
  if (!state.actorId || !entry || !entry.actorId) return true;
  return entry.actorId === state.actorId;
}

function lastPlayerAction(state) {
  return [...state.entries].reverse().find((entry) => mine(state, entry) && ['survey', 'target', 'research', 'wait', 'located'].includes(entry.type));
}

/**
 * Elapsed time units *of the player this state speaks for*.
 *
 * Time is not a table-wide clock: every player has their own pawn on the time track,
 * so only your own entries (and the penalties you were given) move your clock. Offline
 * there is nobody else, so this is simply the old single clock.
 */
export function consoleTime(state) {
  let total = 0;
  for (const entry of state.entries) {
    if (mine(state, entry)) total += entry.cost || 0;
  }
  return total;
}

/** The same sum for one specific player, used by the room to order the pawns. */
export function timeOf(state, actorId) {
  let total = 0;
  for (const entry of state.entries) {
    if (entry.actorId === actorId) total += entry.cost || 0;
  }
  return total;
}

/**
 * The visible sky window. Time drives it (one sector per time unit) but the player can
 * nudge it, because in the real game the dial follows the pawns — the physical board
 * is the authority, this page is only a mirror of it.
 */
export function windowStartOf(state, time = null) {
  // The window normally follows the clock of whoever this state speaks for (offline that
  // is you; online the room pins it to the laggard's clock through `state.windowTime`).
  const at = time === null ? (state.windowTime ?? consoleTime(state)) : time;
  return mod(visibleStartAt(at, state.mode) + (state.windowOffset || 0), state.mode.sectors);
}

export function windowOf(state, time = null) {
  const start = windowStartOf(state, time);
  const sectors = [];
  for (let k = 0; k < state.mode.visible; k++) sectors.push((start + k) % state.mode.sectors);
  return { start, sectors };
}

/** Move the modelled sky window without spending time (to match the real board). */
export function nudgeWindow(state, delta) {
  if (state.status !== 'open') return fail('终局开始后天窗保持冻结，不能调整');
  state.windowOffset = mod((state.windowOffset || 0) + delta, state.mode.sectors);
  return { ok: true, windowOffset: state.windowOffset };
}

export function isWindowVisible(state, sector, time = null) {
  return windowOf(state, time).sectors.includes(sector);
}

/**
 * Everything the UI needs, shaped so the shared panels keep working.
 * In an online room `state.actorId` selects whose private data this view speaks for:
 * scan markers and researched topics are per player, the theory track is shared.
 */
export function consoleView(state) {
  const time = consoleTime(state);
  const surveys = state.entries.filter((e) => e.type === 'survey');
  const targets = state.entries.filter((e) => e.type === 'target');
  const clues = state.entries.filter((e) => e.type === 'research');
  const conferences = state.entries.filter((e) => e.type === 'conference');
  const theories = state.entries.filter((e) => e.type === 'theory');
  const myTargets = targets.filter((e) => mine(state, e));
  const myClues = clues.filter((e) => mine(state, e));
  const researched = new Set(myClues.map((e) => e.topic));
  const last = lastPlayerAction(state);
  const window = windowOf(state);
  const events = eventsAt(state.mode, state.windowTime ?? time);
  const confSectors = conferenceSectors(state.mode);
  const theorySectorList = theorySectors(state.mode);
  const nextConference = confSectors.findIndex((sector) => !conferences.some((c) => c.sector === sector));
  const nextTheory = theorySectorList.findIndex((sector) => !theories.some((t) => t.sector === sector));
  const locked = theoryLockedSectors(state);
  const awaiting = theoriesAwaitingReview(state);

  return {
    kind: 'console',
    mode: state.mode,
    status: state.status,
    revealedObjects: state.revealedObjects || null,
    endgame: !state.roomManaged && state.status === 'reveal' ? { canReveal: true } : null,
    locate: state.locate,
    time,
    timeLabel: timeLabel(time, state.mode),
    visibleStart: window.start,
    visible: window.sectors,
    windowOffset: state.windowOffset || 0,
    arrowSector: events.sector,
    events,
    entries: state.entries,
    log: state.entries,
    knowledge: { surveys, targets, clues, conferences, theories },
    researched,
    topics: state.topics,
    targetUses: MAX_TARGET_USES - myTargets.length,
    lastWasResearch: Boolean(last && last.type === 'research' && mine(state, last)),
    recordCount: state.entries.length,
    conferenceSectors: confSectors,
    theorySectors: theorySectorList,
    conferenceSchedule: confSectors,
    theorySchedule: theorySectorList,
    nextConference,
    nextTheory,
    openTheories: theories.filter((t) => t.review === 'pending').length,
    theoryQuota: theoryQuota(state.mode),
    theoryPhaseOpen: Boolean(state.theoryPhases?.length) && !awaiting.length,
    theoryPhase: state.theoryPhases?.[0] || null,
    theoryUsedThisPhase: theoriesThisPhase(state).length,
    theoryLockedSectors: [...locked],
    theoryOptions: theoryOptionsFor(state),
    myPendingReviews: awaiting.filter((t) => mine(state, t)).map((t) => t.id),
    awaitingReview: awaiting.map((t) => t.id),
    // the log as a table of rounds, and the running score
    rounds: actionRounds(state),
    scores: scoreBoard(state),
  };
}

function push(state, entry) {
  // stamp the actor so per-player clocks and per-player privacy work off the log alone
  const actorId = entry.actorId !== undefined ? entry.actorId : state.actorId || undefined;
  const withMeta = { ...entry, id: state.seq++, time: consoleTime(state), actorId };
  state.entries.push(withMeta);
  if (!state.roomManaged && entry.cost > 0 && !(entry.type === 'located' && entry.correct)) {
    closeTheoryPhase(state, withMeta.time, consoleTime(state));
  }
  return { ok: true, entry: withMeta };
}

/** How many papers one player may publish in a single research phase. */
export function theoryQuota(mode) {
  return mode.id === 'expert' ? 2 : 1;
}

/** Papers I have already published while standing on the current theory sector. */
export function theoriesThisPhase(state) {
  const phase = state.theoryPhases?.[0];
  return phase ? state.entries.filter((entry) => entry.type === 'theory' && mine(state, entry) && entry.publicationPhase === phase.id) : [];
}

/** Sectors whose contents are public: a paper there was peer reviewed as correct. */
export function theoryLockedSectors(state) {
  const out = new Set();
  for (const entry of state.entries) {
    if (entry.type === 'theory' && entry.review === 'correct' && entry.revealed) out.add(entry.sector);
  }
  return out;
}

export function theoryOptionsFor(state, { phaseId = state.theoryPhases?.[0]?.id || null } = {}) {
  const locked = theoryLockedSectors(state);
  const ownTheories = state.entries.filter((entry) => entry.type === 'theory' && mine(state, entry));
  const options = [];
  for (let sector = 0; sector < state.mode.sectors; sector++) {
    if (locked.has(sector)) continue;
    const previous = ownTheories.filter((entry) => entry.sector === sector);
    if (phaseId && previous.some((entry) => entry.publicationPhase === phaseId)) continue;
    const types = THEORY_TYPES.filter((type) =>
      (type !== Obj.COMET || isCometSector(state.mode, sector)) && !previous.some((entry) => entry.objectType === type),
    );
    if (types.length) options.push({ sector, types });
  }
  return options;
}

function openOrFail(state) {
  if (state.status !== 'open') return fail('这次记录已经结束了，请开一局新的');
  return null;
}

function turnOrFail(state) {
  const closed = openOrFail(state);
  if (closed) return closed;
  if (!state.roomManaged && (state.theoryPhases?.length || theoriesAwaitingReview(state).length)) {
    return fail('先完成学术研究阶段与同行评审，再继续行动');
  }
  return null;
}

function rangeOf(state, start, size) {
  return arcSectors(start, size, state.mode.sectors);
}

// ---- recording actions ------------------------------------------------------

export function recordSurvey(state, { type, start, size, count }) {
  const closed = turnOrFail(state);
  if (closed) return closed;
  if (!SURVEY_TYPES.includes(type)) return fail('不能勘测该类天体');
  const maxSize = Math.min(9, state.mode.visible);
  if (!Number.isInteger(size) || size < 1 || size > maxSize) return fail(`范围大小必须是 1–${maxSize} 格`);
  if (!Number.isInteger(start) || start < 0 || start >= state.mode.sectors) return fail('起始扇区不合法');
  if (!Number.isInteger(count) || count < 0 || count > size) return fail(`app 给出的数量应该是 0–${size} 之间的整数`);

  const range = rangeOf(state, start, size);
  if (type === 'comet') {
    const allowed = cometSectors(state.mode);
    if (!allowed.includes(range[0] + 1) || !allowed.includes(range[range.length - 1] + 1)) {
      return fail(`彗星勘测的起点和终点必须是 ${allowed.join('、')} 号扇区之一`);
    }
  }
  const hidden = range.filter((s) => !isWindowVisible(state, s));
  if (hidden.length) {
    return fail(
      `勘测只能在可见天窗内进行：${hidden.map((s) => s + 1).join('、')} 号扇区不在窗口（当前可见 ${windowOf(state)
        .sectors.map((s) => s + 1)
        .join('、')} 号）`,
    );
  }
  return push(state, { type: 'survey', surveyType: type, start, size, count, cost: surveyCost(size) });
}

export function recordTarget(state, { sector, apparent }) {
  const closed = turnOrFail(state);
  if (closed) return closed;
  const usedByMe = state.entries.filter((e) => e.type === 'target' && mine(state, e)).length;
  if (MAX_TARGET_USES - usedByMe <= 0) return fail('扫描标记已经用完了');
  if (!Number.isInteger(sector) || sector < 0 || sector >= state.mode.sectors) return fail('扇区编号不合法');
  if (!APPARENT_TYPES.includes(apparent)) return fail('扫描结果只能是：小行星／彗星／气体云／矮行星／空域');
  if (!isWindowVisible(state, sector)) {
    return fail(
      `扫描只能在可见天窗内进行：${sector + 1} 号扇区不在窗口（当前可见 ${windowOf(state)
        .sectors.map((s) => s + 1)
        .join('、')} 号）`,
    );
  }
  return push(state, { type: 'target', sector, apparent, cost: COST.target });
}

export function recordResearch(state, { topic, name, text }) {
  const closed = turnOrFail(state);
  if (closed) return closed;
  if (!TOPIC_IDS.includes(topic)) return fail('未知的研究主题（只能选 A–F）');
  if (state.entries.filter((e) => e.type === 'research' && mine(state, e)).some((e) => e.topic === topic)) {
    return fail('这个课题已经研究过了');
  }
  const last = lastPlayerAction(state);
  if (last && last.type === 'research' && mine(state, last)) return fail('不能连续两轮进行研究');
  const trimmedName = String(name || '').trim();
  const trimmedText = String(text || '').trim();
  state.topics[topic] = { name: trimmedName, clue: trimmedText };
  return push(state, {
    type: 'research',
    topic,
    name: trimmedName || `课题 ${topic}`,
    text: trimmedText || '（未记录线索内容）',
    cost: COST.research,
  });
}

export function recordTheory(state, { sector, type }, { enforceSchedule = true, phaseId = null, final = false, stationSector = null } = {}) {
  const closed = openOrFail(state);
  if (closed && !(final && state.status === 'final')) return closed;
  if (!Number.isInteger(sector) || sector < 0 || sector >= state.mode.sectors) return fail('扇区编号不合法');
  if (!THEORY_TYPES.includes(type)) {
    return fail('理论只能针对：小行星／彗星／气体云／矮行星（空域可能是 X行星，不能作为理论提交）');
  }
  if (type === Obj.COMET && !isCometSector(state.mode, sector)) {
    return fail('彗星只能在质数编号的扇区提交理论');
  }

  // a sector whose contents are known can never be researched again
  if (theoryLockedSectors(state).has(sector)) {
    return fail(`${sector + 1} 号扇区的研究已经公开（已有一篇正确的学术研究），不能再提交`);
  }

  const publicationPhase = phaseId || state.theoryPhases?.[0]?.id || null;
  if (enforceSchedule) {
    const schedule = theorySectors(state.mode);
    const arrow = eventsAt(state.mode, consoleTime(state)).sector;
    if (!state.theoryPhases?.length || theoriesAwaitingReview(state).length) {
      return fail(`提交学术研究只在天窗起点离开 ${schedule.join('、')} 号扇区后进行（现在在 ${arrow} 号扇区）`);
    }
    const quota = theoryQuota(state.mode);
    if (theoriesThisPhase(state).length >= quota) {
      return fail(`这个学术研究阶段你已经提交过 ${quota} 篇了`);
    }
  }

  const previous = state.entries.filter((entry) => entry.type === 'theory' && mine(state, entry) && entry.sector === sector);
  if (previous.some((entry) => entry.objectType === type)) return fail('不能在同一扇区重复提交相同天体的理论');
  if (publicationPhase && previous.some((entry) => entry.publicationPhase === publicationPhase)) {
    return fail('同一学术研究阶段不能在同一扇区提交两种天体');
  }

  // the object you think sits there is yours alone until a review reveals the sector.
  // Every paper of this phase starts on space 4; the track steps forward once the phase
  // is over, so the whole round shares a space.
  const res = push(state, {
    type: 'theory',
    sector,
    objectType: type,
    publicationPhase,
    slot: THEORY_TRACK[0],
    stationSector: stationSector ?? state.theoryPhases?.[0]?.sector ?? eventsAt(state.mode, consoleTime(state)).sector,
    review: 'pending',
    revealed: false,
    cost: COST.theory,
  });
  res.advanced = [];
  return res;
}

/**
 * Move every face-down paper one space closer to review (never past space 1).
 *
 * This is the conveyor: it runs once a research phase is over, and it moves *all*
 * face-down papers — including the ones just published, which is why a round's papers
 * stay together on one space.
 */
export function advanceTheoryTrack(state) {
  const advanced = [];
  for (const entry of state.entries) {
    if (entry.type !== 'theory' || entry.review !== 'pending') continue;
    if (entry.slot > 1) {
      entry.slot -= 1;
      advanced.push({ id: entry.id, sector: entry.sector, slot: entry.slot });
    }
  }
  revealNextReviewSector(state);
  return advanced;
}

export function closeTheoryPhase(state, beforeTime, afterTime) {
  if (state.roomManaged || state.status !== 'open' || afterTime <= beforeTime) return [];
  const pending = state.theoryPhases || (state.theoryPhases = []);
  const completed = state.completedTheoryPhases || [];
  const added = crossedEvents(state.mode, beforeTime, afterTime).filter((event) => event.kind === 'theory' && !completed.includes(event.id) && !pending.some((phase) => phase.id === event.id));
  pending.push(...added);
  return added;
}

export function completeTheoryPhase(state) {
  const phase = state.theoryPhases?.[0];
  if (state.status !== 'open' || !phase) return fail('现在没有待完成的学术研究阶段');
  if (theoriesAwaitingReview(state).length) return fail('先完成同行评审');
  const advanced = advanceTheoryTrack(state);
  for (const entry of state.entries) {
    if (entry.publicationPhase === phase.id) entry.phaseClosed = true;
  }
  state.theoryPhases.shift();
  (state.completedTheoryPhases || (state.completedTheoryPhases = [])).push(phase.id);
  state.undoBarrier = state.seq - 1;
  return { ok: true, advanced };
}

/** Theories that have reached slot 1 and are waiting for the app's peer review. */
export function theoriesAwaitingReview(state) {
  return state.entries.filter((e) => e.type === 'theory' && e.review === 'pending' && e.slot <= 1);
}

function revealNextReviewSector(state) {
  const awaiting = theoriesAwaitingReview(state);
  const sector = Math.min(...awaiting.map((entry) => entry.sector));
  for (const entry of awaiting) {
    if (entry.sector === sector) entry.revealed = true;
  }
}

/**
 * Peer review results arrive from the app; amend an already recorded theory.
 *
 * A paper can only be checked once it has travelled all the way to slot 1 — that is when
 * the app is asked about it, so an earlier answer would be a guess.
 *
 * * correct — the sector's contents become public: every paper about that sector is
 *   revealed, and the others are settled by comparing their object with the correct one.
 * * wrong — the author loses a time unit (the penalty entry moves their own pawn).
 *
 * Once a sector has a revealed correct paper it is locked for further research, which
 * `recordTheory` enforces.
 */
export function markTheoryReview(state, id, review, { playerOrder = [] } = {}) {
  if (state.status !== 'open') return fail('终局请通过最终揭晓结算论文，不能再进行罚时评审');
  const entry = state.entries.find((e) => e.id === id && e.type === 'theory');
  if (!entry) return fail('找不到这条学术研究记录');
  if (!['correct', 'wrong'].includes(review)) return fail('评审结果只能是 correct/wrong，已评审的论文不能重置');
  if (entry.review !== 'pending') {
    return entry.review === review ? { ok: true, entry, alreadyReviewed: true, penalties: [] } : fail('这篇研究已经评审，不能重复更改结果');
  }
  if (entry.slot > 1) {
    return fail(`这篇研究还在评审轨道 ${entry.slot}，推进到 1 才能确认对错`);
  }
  const nextSector = Math.min(...theoriesAwaitingReview(state).map((theory) => theory.sector));
  if (entry.sector !== nextSector) return fail(`请先完成 ${nextSector + 1} 号扇区的同行评审，再按扇区编号继续`);

  entry.review = review;
  entry.revealed = true;
  const revealed = [];
  const rejected = review === 'wrong' ? [entry] : [];
  if (review === 'correct') {
    entry.revealed = true;
    for (const other of state.entries) {
      if (other.type !== 'theory' || other.sector !== entry.sector || other.id === entry.id) continue;
      other.revealed = true;
      if (other.review === 'pending') {
        other.review = other.objectType === entry.objectType ? 'correct' : 'wrong';
        other.reviewInferred = true; // settled by the revealed sector, not by its own review
        if (other.review === 'wrong') rejected.push(other);
      }
      revealed.push(other.id);
    }
  } else {
    for (const other of theoriesAwaitingReview(state)) {
      if (other.sector !== entry.sector || other.objectType !== entry.objectType) continue;
      other.review = 'wrong';
      other.revealed = true;
      other.reviewInferred = true;
      rejected.push(other);
      revealed.push(other.id);
    }
  }

  rejected.sort((first, second) => {
    const firstOrder = playerOrder.indexOf(first.actorId);
    const secondOrder = playerOrder.indexOf(second.actorId);
    return firstOrder - secondOrder || first.id - second.id;
  });
  const penalties = [];
  for (const rejectedEntry of rejected) {
    if (state.entries.some((record) => record.type === 'penalty' && record.theoryId === rejectedEntry.id)) continue;
    const res = push(state, {
      type: 'penalty',
      reason: 'wrong-theory',
      theoryId: rejectedEntry.id,
      sector: rejectedEntry.sector,
      actorId: rejectedEntry.actorId,
      cost: 1,
    });
    res.entry.time = rejectedEntry.actorId ? timeOf(state, rejectedEntry.actorId) : consoleTime(state);
    penalties.push(res.entry);
  }
  state.undoBarrier = state.seq - 1;
  revealNextReviewSector(state);
  return { ok: true, entry, revealed, penalty: penalties[0] || null, penalties };
}

export function recordConference(state, { sector, text }) {
  const closed = openOrFail(state);
  if (closed) return closed;
  const schedule = conferenceSectors(state.mode);
  const index = Number.isInteger(sector) ? schedule.indexOf(sector) : -1;
  if (index < 0) return fail(`X行星会议只在这些扇区召开：${schedule.join('、')}`);
  if (state.entries.some((e) => e.type === 'conference' && e.sector === sector)) return fail('这次会议已经记录过了');
  const trimmed = String(text || '').trim();
  return push(state, {
    type: 'conference',
    index,
    sector,
    label: `扇区 ${sector} 的 X行星会议`,
    text: trimmed || '（未记录线索内容）',
    scheduledTime: sector * TIME_UNITS_PER_SHIFT,
    cost: 0,
  });
}

export function recordWait(state, units = COST.wait) {
  const closed = turnOrFail(state);
  if (closed) return closed;
  const duration = Number.isInteger(units) && units > 0 ? units : COST.wait;
  return push(state, { type: 'wait', cost: duration });
}

/**
 * Record what you told the app. `correct` is the app's verdict: only a correct locate
 * ends the game (an unsuccessful attempt just costs the time).
 */
export function recordLocate(state, { sector, left, right, correct = true }, { final = false, distanceBehind = null } = {}) {
  const closed = final ? (state.status === 'final' ? null : fail('现在不是最后得分机会')) : turnOrFail(state);
  if (closed) return closed;
  if (!Number.isInteger(sector) || sector < 0 || sector >= state.mode.sectors) return fail('扇区编号不合法');
  if (!SURVEY_TYPES.includes(left) || !SURVEY_TYPES.includes(right)) return fail('请选择左右相邻扇区的天体');
  if (typeof correct !== 'boolean') return fail('请明确填写 app 判定的正确或错误');
  const windowTime = state.windowTime ?? consoleTime(state);
  const found = correct !== false;
  const res = push(state, { type: 'located', sector, left, right, correct: found, cost: final ? 0 : COST.locate, final, distanceBehind });
  if (!final) state.locate = { sector, left, right, correct: found, time: res.entry.time, actorId: res.entry.actorId };
  if (found && !final) {
    state.status = 'reveal';
    if (!state.roomManaged) state.windowTime = windowTime;
  }
  return res;
}

export function revealObjects(state, objects) {
  if (state.status !== 'reveal') return fail('请先完成所有玩家的最后得分机会');
  if (!Array.isArray(objects) || objects.length !== state.mode.sectors || Array.from(objects).some((objectType) => !Object.values(Obj).includes(objectType))) {
    return fail(`请按扇区顺序完整填写 ${state.mode.sectors} 个 app 揭晓结果`);
  }
  if (objects.filter((objectType) => objectType === Obj.PLANET_X).length !== 1) return fail('揭晓结果必须恰好包含一颗 X行星');
  const conflict = state.entries.find((entry) => entry.type === 'theory' && entry.review !== 'pending' &&
    (entry.review === 'correct') !== (objects[entry.sector] === entry.objectType));
  if (conflict) return fail(`${conflict.sector + 1} 号扇区的揭晓结果与已有同行评审结论冲突，请核对官方 app`);
  for (const entry of state.entries) {
    if (entry.type === 'theory') {
      if (entry.review === 'pending') {
        entry.review = objects[entry.sector] === entry.objectType ? 'correct' : 'wrong';
        entry.finalReview = true;
      }
      entry.revealed = true;
    }
    if (entry.type === 'located') entry.revealed = true;
  }
  state.revealedObjects = [...objects];
  state.status = 'finished';
  return { ok: true };
}

export function undoLast(state) {
  if (state.entries.length === 0) return fail('没有可以撤销的记录');
  if (state.status !== 'open') return fail('最后机会与最终揭晓开始后不能撤销');
  const last = state.entries[state.entries.length - 1];
  if (last.id <= (state.undoBarrier || 0) || last.type === 'penalty') return fail('这条记录已参与阶段结算，不能单独撤销');
  const removed = state.entries.pop();
  if (!state.roomManaged) state.theoryPhases = (state.theoryPhases || []).filter((phase) => phase.time <= consoleTime(state));
  if (removed.type === 'located') {
    state.locate = null;
    state.status = 'open';
  }
  return { ok: true, removed };
}

// ---- the round table --------------------------------------------------------

/** A turn action is what fills a round; free actions are filed under the same round. */
const ROUND_ACTIONS = new Set(['survey', 'target', 'research', 'wait']);

/** One line per entry, shaped for the round table: an operation and its result. */
function entryLine(entry, mode) {
  const hidden = '（结果未公开）';
  const n = (mode && mode.sectors) || 12;
  switch (entry.type) {
    case 'survey': {
      const a = mod(entry.start, n) + 1;
      const b = mod(entry.start + entry.size - 1, n) + 1;
      return {
        type: 'survey',
        turn: true,
        op: `勘测 ${a}–${b} 号 · ${LABEL[entry.surveyType] || entry.surveyType}`,
        result: entry.count === undefined ? hidden : `${entry.count} 个`,
      };
    }
    case 'target':
      return {
        type: 'target',
        turn: true,
        op: `扫描 ${entry.sector + 1} 号`,
        result: entry.apparent === undefined ? hidden : LABEL[entry.apparent] || String(entry.apparent),
      };
    case 'research':
      return {
        type: 'research',
        turn: true,
        op: `研究 课题 ${entry.topic}`,
        result: entry.text === undefined ? hidden : entry.text,
      };
    case 'wait':
      return { type: 'wait', turn: true, op: `等待 ${durationLabel(entry.cost)}`, result: '' };
    case 'theory':
      return {
        type: 'theory',
        turn: false,
        op: `提交学术研究 ${entry.sector + 1} 号`,
        result:
          entry.objectType === undefined || entry.objectType === null
            ? '天体未公开'
            : `${LABEL[entry.objectType] || entry.objectType}${entry.revealed ? '（已公开）' : ''}`,
      };
    case 'conference':
      return { type: 'conference', turn: false, op: `会议 ${entry.sector} 号`, result: entry.text === undefined ? hidden : entry.text };
    case 'located':
      return {
        type: 'located',
        turn: false,
        op: Number.isInteger(entry.sector) ? `定位 X行星 ${entry.sector + 1} 号` : '定位 X行星（扇区保密）',
        result: entry.correct === false ? 'app 判定：错误' : 'app 判定：正确',
      };
    case 'penalty':
      return { type: 'penalty', turn: false, op: `评审错误 · 罚 ${durationLabel(entry.cost)}`, result: '' };
    default:
      return { type: entry.type, turn: false, op: entry.type, result: '' };
  }
}

/**
 * The action log as a table of rounds: every round collects one turn action per player
 * (whoever acts twice in a row simply gets two cells), and the free actions of that
 * stretch of play are filed along with them. My own cells carry the result; for other
 * players the private numbers are already gone from the entry I receive.
 */
export function actionRounds(state, players = []) {
  const ids = (players.length ? players.map((p) => p.id) : [state.actorId || 'me']).filter(Boolean);
  const viewerId = state.actorId || (ids.length === 1 ? ids[0] : null) || 'me';
  const rounds = [];
  let current = null;
  const everyoneActed = (round) => ids.every((id) => (round.cells[id] || []).some((cell) => cell.turn));
  const open = () => {
    // `mine` tells the UI which column is the reader's own, even in the offline console
    current = { index: rounds.length + 1, cells: {}, order: [], mine: viewerId };
    rounds.push(current);
    return current;
  };

  for (const entry of state.entries) {
    const line = entryLine(entry, state.mode);
    if (!current || everyoneActed(current)) open();
    const id = entry.actorId || viewerId;
    if (!current.cells[id]) {
      current.cells[id] = [];
      current.order.push(id);
    }
    current.cells[id].push({ ...line, id: entry.id, time: timeShort(entry.time || 0, state.mode) });
  }
  return rounds;
}

/** A short summary of the session, shown when the player records their locate. */
export function consoleSummary(state) {
  const view = consoleView(state);
  const laps = view.time / state.mode.sectors;
  const duration = durationLabel(view.time);
  return {
    units: view.time,
    laps,
    durationLabel: duration,
    months: view.time,
    years: laps,
    yearsLabel: duration,
    surveys: view.knowledge.surveys.length,
    scans: view.knowledge.targets.length,
    clues: view.knowledge.clues.length,
    conferences: view.knowledge.conferences.length,
    theories: view.knowledge.theories.length,
    waits: state.entries.filter((e) => e.type === 'wait').length,
    locate: view.locate,
    timeShort: timeShort(view.time, state.mode),
    timeLabel: timeLabel(view.time, state.mode),
    parts: timeParts(view.time, state.mode),
  };
}

export { LABEL, CODE, apparentType, MAX_TARGET_USES, theorySectors, conferenceSectors, eventsAt };
