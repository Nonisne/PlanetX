// App shell for the record console: one session, one view, one set of handlers.
//
// The console never generates or judges anything — it mirrors the physical game:
// the calendar, the rotating sky window, the star map, the record sheet and the
// time-track events (X planet conferences and theory phases).
import { h, mount } from './dom.js';
import { Obj, CODE, LABEL, SURVEY_TYPES, INITIAL_CLUE_TYPES } from '../src/types.js';
import { arcSectors, isCometSector, mod, visibleSectorsAt } from '../src/rules.js';
import {
  completeTheoryPhase,
  consoleSummary,
  consoleView,
  createConsole,
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
  undoLast,
} from '../src/console.js';
import { renderBoard } from './board.js';
import { renderConferencesPanel, renderTopicsPanel } from './notesheet.js';
import { renderTutorialGuide } from './tutorial.js';
import { clearRoom, clearTutorialReturn, createRoom, fetchView, joinRoom, loadRoom, loadTutorialReturn, openStream, saveRoom, saveTutorialReturn, sendAction } from '../src/online.js';
import {
  renderActionPanel,
  renderHeader,
  renderKnowledgePanel,
  renderLogPanel,
  renderScorePanel,
  renderMapPanel,
  renderModal,
  renderStatus,
  renderToast,
} from './panels.js';

const SAVE_KEY = 'planetx.save.v3';
const LEGACY_KEYS = ['planetx.save.v2', 'planetx.save.v1'];
const NOTES_KEY = 'planetx.notes.v1';

/** Timings tests can dial down without patching global timers. */
export const appTiming = { toastMs: 3200 };

function notesKey(remote) {
  return remote ? `planetx.notes.${remote.roomId}.${remote.playerId}` : NOTES_KEY;
}

function loadSave() {
  try {
    const raw = [SAVE_KEY, ...LEGACY_KEYS].map((k) => localStorage.getItem(k)).find(Boolean);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function loadNotes(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function createApp(root) {
  const save = loadSave();
  const session = createConsole({ modeId: (save && save.modeId) || 'standard' });
  if (save) {
    session.entries = Array.isArray(save.entries) ? save.entries : [];
    session.locate = save.locate || null;
    session.status = save.status || 'open';
    session.windowOffset = save.windowOffset || 0;
    session.topics = { ...session.topics, ...(save.topics || {}) };
    session.seq = save.seq || session.entries.length + 1;
    session.theoryPhases = Array.isArray(save.theoryPhases) ? save.theoryPhases : [];
    session.completedTheoryPhases = Array.isArray(save.completedTheoryPhases) ? save.completedTheoryPhases : [];
    session.undoBarrier = Number.isInteger(save.undoBarrier) ? save.undoBarrier : 0;
    session.revealedObjects = Array.isArray(save.revealedObjects) ? save.revealedObjects : null;
    session.windowTime = Number.isFinite(save.windowTime) ? save.windowTime : null;
  }

  const state = {
    session,
    notes: loadNotes(NOTES_KEY),
    game: null,
    // online room: when set, the shared state comes from the server and every action
    // is sent there; `view` is the current per-player snapshot
    remote: null,
    stream: null,
    netStatus: 'offline',
    tutorialReturn: loadTutorialReturn(),
    ui: {
      selectedSector: null,
      surveyType: Obj.ASTEROID,
      surveyCount: 0,
      targetResult: null,
      researchTopic: null,
      topicName: '',
      clueText: '',
      conferenceText: '',
      // action flow: idle | survey | scan | research | theory
      action: 'idle',
      pick: [],
      theorySector: 0,
      theoryType: Obj.COMET,
      modal: null,
      locate: null,
      finalTheories: [],
      revealObjects: [],
      mark: null,
      toast: null,
      setup: null,
      initialClueCount: 4,
      // the host's room-dialog draft of the table-wide setup information
      tableInfo: null,
      panels: {},
      lobby: { name: '', code: '', busy: false, error: null, spectator: false },
      // which board (12 or 18 sectors) the next session / room uses
      modeId: null,
      playMode: 'record',
      actionBusy: false,
      // conference clue waiting to popup after a blocking modal closes
      pendingConference: null,
    },
  };
  let lobbyRequestId = 0;

  /**
   * Views travel as JSON, and `researched` is a Set locally: a Set serialises to `{}`,
   * so put a real Set back. Anything that is not an array is treated as empty rather
   * than being fed to `new Set()` (which throws on a plain object).
   */
  function adoptRemote(view) {
    if (!view) return view;
    const researched = view.researched;
    if (!(researched instanceof Set)) view.researched = new Set(Array.isArray(researched) ? researched : []);
    return view;
  }

  function syncInitialClues(game) {
    if (!state.remote || game.me !== state.remote.playerId || !game.mySetup?.cluesClaimed) return;
    const keys = [...new Set((game.mySetup.clues || [])
      .filter((clue) => Number.isInteger(clue.sector) && clue.sector >= 0 && clue.sector < game.mode.sectors && INITIAL_CLUE_TYPES.includes(clue.type) && (clue.type !== Obj.COMET || isCometSector(game.mode, clue.sector)))
      .map((clue) => `${clue.sector}:${CODE[clue.type]}`))].sort();
    const signature = JSON.stringify(keys);
    const cached = state.remote.initialClueSync || loadNotes(`${notesKey(state.remote)}.initial-clues`);
    const previous = cached && typeof cached === 'object' && !Array.isArray(cached) ? cached : {};
    state.remote.initialClueSync = previous;
    const owned = new Set(Array.isArray(previous.owned) ? previous.owned : []);
    let restored = false;
    for (const key of owned) {
      if (keys.includes(key) && state.notes[key] === undefined) {
        state.notes[key] = 'no';
        restored = true;
      }
    }
    if (previous.signature === signature) {
      if (restored) persist();
      return;
    }
    let priorKeys = [];
    try { priorKeys = JSON.parse(previous.signature || '[]'); } catch { priorKeys = []; }
    for (const key of owned) {
      if (keys.includes(key)) continue;
      if (state.notes[key] === 'no') delete state.notes[key];
      owned.delete(key);
    }
    for (const key of keys) {
      if (Array.isArray(priorKeys) && priorKeys.includes(key)) continue;
      state.notes[key] = 'no';
      owned.add(key);
    }
    state.remote.initialClueSync = { signature, owned: [...owned] };
    persist();
  }

  function writeNote(key, markState) {
    const sync = state.remote?.initialClueSync;
    if (sync?.owned) sync.owned = sync.owned.filter((ownedKey) => ownedKey !== key);
    if (markState === 'yes' || markState === 'no') state.notes[key] = markState;
    else delete state.notes[key];
  }

  function syncTutorialMark(game) {
    const remote = state.remote;
    if (!remote || !game.tutorial || game.me !== remote.playerId) return;
    if (remote.pendingTutorialMark === undefined) remote.pendingTutorialMark = loadNotes(`${notesKey(remote)}.tutorial-mark`);
    const pending = remote.pendingTutorialMark;
    if (!pending || typeof pending.stepId !== 'string' || !pending.stepId) return;
    if (!Number.isInteger(pending.revision) || !Number.isInteger(game.revision) || game.revision <= pending.revision) return;
    if (game.tutorial.stepId === pending.stepId || !Number.isInteger(pending.sector) || pending.sector < 0 || pending.sector >= game.mode.sectors) return;
    if (!Object.values(CODE).includes(pending.code) || !['yes', 'no', 'maybe'].includes(pending.markState)) return;
    writeNote(`${pending.sector}:${pending.code}`, pending.markState);
    remote.pendingTutorialMark = null;
    persist();
  }

  function view() {
    state.game = state.remote ? adoptRemote(state.remote.view) : consoleView(session);
    syncInitialClues(state.game);
    syncTutorialMark(state.game);
    const options = state.game.theoryOptions || [];
    const selected = options.find((option) => option.sector === state.ui.theorySector) || options[0];
    state.ui.theorySector = selected?.sector ?? null;
    if (!selected?.types.includes(state.ui.theoryType)) state.ui.theoryType = selected?.types[0] ?? null;
    return state.game;
  }

  function render() {
    const previousHistory = root.querySelector?.('[data-history-scroll]');
    const historyScroll = previousHistory ? { top: previousHistory.scrollTop, left: previousHistory.scrollLeft } : null;
    view();
    const boardEl = renderBoard({ game: state.game, ui: state.ui, notes: state.notes, onSector, onMark: openMark });
    mount(
      root,
      renderHeader({ state, api }),
      renderStatus({ state, api }),
      h(
        'main',
        { class: 'layout' },
        h(
          'aside',
          { class: 'col-info', 'aria-label': '推理线索与参考' },
          renderKnowledgePanel({ state, api }),
          renderTopicsPanel({
            state,
            api,
            game: state.game,
            draftNames: state.ui.setup && state.ui.setup.topicNames,
            onReview: recordTheoryReview,
          }),
          renderConferencesPanel({ state, api }),
        ),
        h('div', { class: 'col-map' }, renderMapPanel({ state, api, boardEl, onClearNotes: clearNotes })),
        h('aside', { class: 'col-actions', 'aria-label': '当前行动' }, renderTutorialGuide({ game: state.game, api }), renderActionPanel({ state, api })),
      ),
      h('section', { class: 'workspace-secondary', 'aria-label': '行动历史与积分' }, renderLogPanel({ state, api }), renderScorePanel({ state, api })),
      renderToast({ state }),
      renderModal({ state, api }),
    );
    const nextHistory = root.querySelector?.('[data-history-scroll]');
    if (nextHistory && historyScroll) {
      nextHistory.scrollTop = historyScroll.top;
      nextHistory.scrollLeft = historyScroll.left;
    }
  }

  function persist() {
    if (state.remote) {
      try {
        localStorage.setItem(notesKey(state.remote), JSON.stringify(state.notes));
        if (state.remote.initialClueSync) localStorage.setItem(`${notesKey(state.remote)}.initial-clues`, JSON.stringify(state.remote.initialClueSync));
        if (state.remote.pendingTutorialMark !== undefined) {
          const pendingKey = `${notesKey(state.remote)}.tutorial-mark`;
          if (state.remote.pendingTutorialMark) localStorage.setItem(pendingKey, JSON.stringify(state.remote.pendingTutorialMark));
          else localStorage.removeItem(pendingKey);
        }
      } catch {
        /* storage unavailable */
      }
      return;
    }
    try {
      localStorage.setItem(
        SAVE_KEY,
        JSON.stringify({
          kind: 'console',
          modeId: session.mode.id,
          entries: session.entries,
          locate: session.locate,
          status: session.status,
          windowOffset: session.windowOffset || 0,
          topics: session.topics,
          seq: session.seq,
          theoryPhases: session.theoryPhases,
          completedTheoryPhases: session.completedTheoryPhases,
          undoBarrier: session.undoBarrier,
          revealedObjects: session.revealedObjects,
          windowTime: session.windowTime,
        }),
      );
      localStorage.setItem(NOTES_KEY, JSON.stringify(state.notes));
    } catch {
      /* storage unavailable: keep playing without persistence */
    }
  }

  // ---- online rooms ---------------------------------------------------------

  function applyRemoteView(next) {
    const current = state.remote.view;
    if (Number.isInteger(current?.revision) && Number.isInteger(next?.revision) && next.revision < current.revision) return false;
    state.remote.view = adoptRemote(next);
    if (current?.tutorial?.stepId !== next?.tutorial?.stepId && next?.tutorial) {
      state.ui.action = 'idle';
      state.ui.pick = [];
      state.ui.modal = null;
      state.ui.mark = null;
      state.ui.locate = null;
      state.ui.researchTopic = null;
    }
    return true;
  }

  function applyServerResult(res, action) {
    if (res.view) {
      const prev = state.remote?.view;
      applyRemoteView(res.view);
      if (res.ok) {
        const kind = action && action.kind;
        if (['locate', 'final-theories', 'final-pass', 'reveal-objects'].includes(kind)) {
          state.ui.modal = null;
          state.ui.action = 'idle';
          state.ui.pick = [];
          state.ui.finalTheories = [];
        }
        noticeNewConferences(prev, res.view);
        const resultEntry = res.view.log?.find((entry) => entry.id === res.entry?.id);
        if (res.warning) toast(res.warning, 'bad');
        else if (res.view.playMode === 'builtin' && resultEntry && ['survey', 'target', 'research', 'located'].includes(resultEntry.type)) {
          if (resultEntry.type === 'survey') toast(`勘测结果：${LABEL[resultEntry.surveyType]} ${resultEntry.count} 个，已写入私有记录`, 'clue');
          if (resultEntry.type === 'target') toast(`扫描结果：${LABEL[resultEntry.apparent]}${resultEntry.apparent === Obj.EMPTY ? '（仍可能是 X行星）' : ''}`, 'clue');
          if (resultEntry.type === 'research') toast(`已获得课题 ${resultEntry.topic} 的线索，请查看研究线索面板`, 'clue');
          if (resultEntry.type === 'located') toast(resultEntry.correct ? '定位正确！最后机会结束后自动揭晓并结算' : '定位不正确：位置或邻居不符，请继续推理', resultEntry.correct ? 'ok' : 'bad');
        }
        else if (kind === 'research-declare') {
          toast(action.count ? `已选：这个阶段提交 ${action.count} 篇（不能改）` : '已选：这个阶段不提交', 'clue');
        } else if (kind === 'research-submit') {
          const waiting = (res.view.knowledge.theories || []).filter((t) => t.review === 'pending' && t.slot <= 1).length;
          toast(res.view.playMode === 'builtin' ? '已提交学术研究；到期后系统自动评审' : waiting ? '已提交；有理论推进到评审格，去 app 触发同行评审' : '已提交学术研究', waiting ? 'clue' : 'ok');
        } else if (kind === 'review') {
          if (action.review === 'correct') toast('评审正确：该扇区的内容对全桌公开，之后不能再研究它', 'ok');
          else if (action.review === 'wrong') toast('评审错误：你的棋子被罚前进 1 个时间单位', 'bad');
          else toast('已记录', 'ok');
        } else if (kind === 'claim-initial-clues') {
          toast(`已领取 ${res.view.mySetup.initialClueCount} 条初始线索，并同步到星图`, 'clue');
        } else if (kind === 'setup') {
          if (res.view.phase === 'play') toast('所有人都准备好了，第一轮开始！', 'clue');
          else if (res.view.playMode === 'builtin') toast('已准备，等待其他玩家确认私有线索', 'clue');
          else if (res.view.amHost) toast('已提交（含 A–F 课题名与会议线索），等其他人填写', 'clue');
          else toast('已提交，等其他人填写', 'clue');
        } else if (kind === 'setup-reopen') {
          toast('可以重新填写了（其他人在等你）', 'clue');
        } else if (kind === 'set-topic-names' || kind === 'set-conference-rules' || kind === 'set-conference-names') {
          toast('全桌共享的开局信息已更新', 'ok');
        } else if (kind === 'start-game') {
          toast(res.view.playMode === 'builtin' ? `已为每人分发 ${res.view.initialClueCount} 条初始线索并标记到星图，请确认准备` : `开局准备：每人填写 ${res.view.initialClueCount} 条初始线索，房主填写课题与会议标题`, 'clue');
        } else if (kind === 'set-initial-clue-count') {
          toast(`全体玩家的初始线索已统一为 ${res.view.initialClueCount} 条`, 'ok');
        } else if (kind === 'skip-turn') {
          toast(`已跳到 ${res.view.turnPlayerName || '下一位'}`, 'ok');
        } else if (kind?.startsWith('tutorial-')) {
          toast(res.view.tutorial.completed ? '教学完成，可以查看本局得分' : res.view.tutorial.title, 'clue');
        } else if (state.ui.modal?.kind === 'conference') {
          /* conference popup already carries the news */
        } else toast('已记录', 'ok');
      } else if (res.error) {
        toast(res.error, 'bad');
      }
    }
    persist();
    render();
    return res;
  }

  async function remoteAction(action) {
    const remote = state.remote;
    if (!remote || remote.actionPending) return { ok: false, error: '请等待当前行动完成' };
    if (remote.view.tutorial) action = { ...action, stepId: action.stepId ?? remote.view.tutorial.stepId };
    remote.actionPending = true;
    state.ui.actionBusy = true;
    render();
    try {
      const result = await sendAction(remote, action);
      if (state.remote !== remote) return { ok: false, error: '已离开原房间' };
      return applyServerResult(result, action);
    } catch {
      if (state.remote !== remote) return { ok: false, error: '已离开原房间' };
      const result = { ok: false, error: '暂时无法连接服务，请保持服务运行并重连，先核对行动历史再重试。' };
      toast(result.error, 'bad');
      return result;
    } finally {
      remote.actionPending = false;
      if (state.remote === remote) {
        state.ui.actionBusy = false;
        render();
      }
    }
  }

  /** Actions that only make sense on your own turn — an open form is dropped when it ends. */
  const TURN_FORMS = new Set(['survey', 'scan', 'research']);

  /**
   * People need to know when the table moves on: the banner always shows whose turn it
   * is, and a turn change also says so. A stale form for an action I can no longer take
   * is closed rather than left sitting there looking usable.
   */
  function followTurn(prev, next) {
    if (prev && next && (prev.phase !== next.phase || prev.endgame?.cursorId !== next.endgame?.cursorId)) {
      state.ui.action = 'idle';
      state.ui.pick = [];
      state.ui.modal = null;
      state.ui.locate = null;
      state.ui.finalTheories = [];
      state.ui.revealObjects = [];
    }
    if (!prev || !next || prev.turnPlayerId === next.turnPlayerId) return;
    if (next.phase !== 'play' || !next.turnPlayerId) return;
    if (!next.isMyTurn && TURN_FORMS.has(state.ui.action)) state.ui.action = 'idle';
    if (next.isMyTurn) toast('轮到你行动了', 'ok');
    else if (!state.ui.toast) toast(`轮到 ${next.turnPlayerName} 行动`, 'info');
  }

  function attachStream() {
    if (state.stream) state.stream.close();
    const remote = state.remote;
    state.stream = openStream(remote, {
      onStatus: (status) => {
        if (state.remote !== remote) return;
        state.netStatus = status;
        render();
      },
      onView: (view, notice) => {
        if (state.remote !== remote) return;
        const prev = state.remote.view;
        if (!applyRemoteView(view)) return;
        if (notice && notice.kind === 'player-joined') toast(`${notice.name} 加入了房间`, 'clue');
        if (notice && notice.kind === 'action' && notice.by && notice.byId !== state.remote.playerId) toast(`${notice.by} 记录了${ACTION_NAMES[notice.action] || '一步'}`, 'info');
        followTurn(prev, state.remote.view);
        noticeNewConferences(prev, state.remote.view);
        render();
      },
    });
  }

  async function enterRoom(room, viewFromServer) {
    clearHistoryResults();
    state.remote = {
      roomId: room.roomId,
      playerId: room.playerId,
      token: room.token,
      view: adoptRemote(viewFromServer || room.view),
    };
    state.notes = loadNotes(notesKey(state.remote));
    saveRoom({ roomId: room.roomId, playerId: room.playerId, token: room.token });
    state.ui.modal = null;
    state.ui.lobby = { ...state.ui.lobby, busy: false, error: null };
    state.ui.finalTheories = [];
    state.ui.revealObjects = [];
    state.ui.locate = null;
    state.ui.setup = null;
    state.ui.initialClueCount = state.remote.view.initialClueCount ?? 4;
    state.ui.action = 'idle';
    state.ui.actionBusy = false;
    state.ui.pick = [];
    state.ui.mark = null;
    state.ui.selectedSector = null;
    state.ui.playMode = state.remote.view.tutorial ? 'tutorial' : state.remote.view.playMode || 'record';
    attachStream();
    render();
  }

  function beginLobbyRequest() {
    lobbyRequestId += 1;
    state.ui.lobby = { ...state.ui.lobby, busy: true, error: null };
    render();
    return lobbyRequestId;
  }

  async function doCreateRoom() {
    if (state.ui.playMode === 'tutorial') return startTutorial();
    const lobby = state.ui.lobby;
    beginLobbyRequest();
    try {
      const room = await createRoom({ name: lobby.name, modeId: state.ui.modeId || 'standard', playMode: state.ui.playMode || 'record', initialClueCount: state.ui.initialClueCount });
      await enterRoom(room);
      toast(`房间 ${room.roomId} 已创建，把房间码发给同桌的人`, 'clue');
    } catch (err) {
      state.ui.lobby = { ...state.ui.lobby, busy: false, error: err.message };
      render();
    }
  }

  async function startBuiltin() {
    if (state.ui.playMode === 'tutorial') return startTutorial();
    if (state.ui.lobby.busy) return { ok: false };
    beginLobbyRequest();
    try {
      const room = await createRoom({ name: state.ui.lobby.name || '我', modeId: state.ui.modeId || 'standard', playMode: 'builtin', initialClueCount: state.ui.initialClueCount });
      await enterRoom(room);
      return await startGame();
    } catch (error) {
      state.ui.lobby = { ...state.ui.lobby, busy: false, error: error.message || '无法创建谜题，请检查本地服务' };
      render();
      return { ok: false, error: state.ui.lobby.error };
    }
  }

  async function startTutorial() {
    if (state.ui.lobby.busy || state.remote?.actionPending) return { ok: false, error: '请等待当前操作完成后再开始教学' };
    const previousRemote = state.remote;
    const wasTutorial = Boolean(previousRemote?.view.tutorial);
    const returnState = previousRemote
      ? { room: { roomId: previousRemote.roomId, playerId: previousRemote.playerId, token: previousRemote.token } }
      : state.tutorialReturn || loadTutorialReturn() || { room: loadRoom() };
    persist();
    const requestId = beginLobbyRequest();
    const isCurrentRequest = () => requestId === lobbyRequestId && state.remote === previousRemote;
    try {
      const room = await createRoom({ name: state.ui.lobby.name || '我', playMode: 'tutorial' });
      if (!isCurrentRequest()) return { ok: false, error: '当前房间已变化' };
      if (!wasTutorial) {
        state.tutorialReturn = returnState;
        clearTutorialReturn();
        saveTutorialReturn(returnState.room);
      }
      await enterRoom(room);
      toast('教学局已准备好：跟着右侧引导逐步操作', 'clue');
      return { ok: true };
    } catch (error) {
      if (!isCurrentRequest()) return { ok: false, error: '当前房间已变化' };
      state.ui.lobby = { ...state.ui.lobby, busy: false, error: error.message || '无法开始教学' };
      toast(state.ui.lobby.error, 'bad');
      render();
      return { ok: false, error: state.ui.lobby.error };
    } finally {
      if (requestId === lobbyRequestId) {
        state.ui.lobby = { ...state.ui.lobby, busy: false };
        render();
      }
    }
  }

  function tutorialNext(stepId = state.game.tutorial?.stepId) {
    return remoteAction({ kind: 'tutorial-next', stepId });
  }

  function restartTutorial() {
    if (!state.remote?.view.tutorial) return { ok: false, error: '当前不是教学局' };
    return startTutorial();
  }

  async function exitTutorial() {
    const remote = state.remote;
    if (!remote?.view.tutorial) return { ok: false, error: '当前不是教学局' };
    if (remote.actionPending || state.ui.lobby.busy) return { ok: false, error: '请等待当前操作完成后退出教学' };
    const previous = state.tutorialReturn || loadTutorialReturn() || { room: null };
    beginLobbyRequest();
    let expired = false;
    try {
      if (previous.room) {
        let view;
        try {
          view = await fetchView(previous.room);
        } catch (error) {
          if (![401, 403, 404, 410].includes(error.status)) throw error;
          expired = true;
        }
        if (state.remote !== remote) return { ok: false, error: '当前房间已变化' };
        if (view) await enterRoom(previous.room, view);
        else await detachRoom();
      } else {
        await detachRoom();
      }
      clearTutorialReturn();
      state.tutorialReturn = null;
      toast(expired ? '原房间已过期，已返回单机记录台；原私人笔记仍保留' : previous.room ? '已返回原来的普通对局' : '已返回原来的单机记录台', expired ? 'bad' : 'ok');
      return { ok: true };
    } catch (error) {
      toast('暂时无法恢复原房间，教学与返回身份都已保留，请稍后重试', 'bad');
      return { ok: false, error: error.message };
    } finally {
      state.ui.lobby = { ...state.ui.lobby, busy: false };
      render();
    }
  }

  async function doJoinRoom() {
    const lobby = state.ui.lobby;
    beginLobbyRequest();
    try {
      const room = await joinRoom(lobby.code, lobby.name, { spectator: Boolean(lobby.spectator) });
      await enterRoom(room);
      toast(room.view?.amSpectator ? `已以观战身份加入房间 ${room.roomId}` : `已加入房间 ${room.roomId}`, 'clue');
    } catch (err) {
      state.ui.lobby = { ...state.ui.lobby, busy: false, error: err.message };
      render();
    }
  }

  async function leaveRoom() {
    if (state.remote?.view.tutorial) return exitTutorial();
    return detachRoom();
  }

  async function detachRoom() {
    lobbyRequestId += 1;
    clearHistoryResults();
    if (state.stream) state.stream.close();
    state.stream = null;
    state.remote = null;
    state.ui.lobby = { ...state.ui.lobby, busy: false, error: null };
    state.ui.actionBusy = false;
    state.netStatus = 'offline';
    clearRoom();
    state.notes = loadNotes(NOTES_KEY);
    state.ui.modal = null;
    state.ui.setup = null;
    state.ui.finalTheories = [];
    state.ui.revealObjects = [];
    state.ui.locate = null;
    state.ui.mark = null;
    state.ui.pick = [];
    state.ui.action = 'idle';
    state.ui.playMode = 'record';
    render();
  }

  /** Host starts the game: lobby -> setup. */
  function startGame() {
    return remoteAction({ kind: 'start-game' });
  }

  function claimInitialClues(count = state.ui.initialClueCount) {
    return remoteAction({ kind: 'claim-initial-clues', count });
  }

  function setInitialClueCount(count) {
    return remoteAction({ kind: 'set-initial-clue-count', count });
  }

  /** Submit my initial clues — plus, for the host, the table-wide subjects and notes. */
  async function submitSetup() {
    const ui = state.ui;
    const mine = state.game.mySetup || {};
    const draft = (state.game.playMode !== 'builtin' && ui.setup) || {
      clues: (mine.clues || []).map((c) => ({ ...c })),
      noClues: Boolean(mine.noClues),
      topicNames: { ...(state.game.topicNames || {}) },
      conferences: { ...(state.game.conferenceRules || {}) },
      conferenceNames: { ...(state.game.conferenceNames || {}) },
    };
    const submittedDraft = state.ui.setup;
    const action = state.game.playMode === 'builtin' ? { kind: 'setup' } : { kind: 'setup', clues: draft.clues, noClues: draft.noClues };
    if (state.game.amHost && state.game.playMode !== 'builtin') {
      action.topics = draft.topicNames || {};
      action.conferences = draft.conferences || {};
      action.conferenceNames = draft.conferenceNames || state.game.conferenceNames || {};
    }
    const res = await remoteAction(action);
    if (res.ok && state.ui.setup === submittedDraft) state.ui.setup = null;
    render();
    return res;
  }

  /** Fill my setup card in again — the other players just keep waiting. */
  function reopenSetup() {
    state.ui.setup = null;
    return remoteAction({ kind: 'setup-reopen' });
  }

  /** The host corrects the table-wide information from the room dialog. */
  async function saveTableInfo() {
    const info = state.ui.tableInfo;
    if (!info) return { ok: false, error: '没有要保存的内容' };
    // a draft that only touched one of the two fields must not wipe the other
    const names = info.topicNames || state.game.topicNames || {};
    const rules = info.conferences || state.game.conferenceRules || {};
    const named = await remoteAction({ kind: 'set-topic-names', names });
    if (!named.ok) return named;
    const recorded = await remoteAction({ kind: 'set-conference-rules', rules });
    if (!recorded.ok) return recorded;
    const headings = await remoteAction({ kind: 'set-conference-names', names: info.conferenceNames || state.game.conferenceNames || {} });
    if (!headings.ok) return headings;
    state.ui.tableInfo = null;
    render();
    return { ok: true };
  }

  /** The empty lobby form, used to seed `ui.lobby` if it is ever missing. */
  function emptyLobby() {
    return { name: '', code: '', busy: false, error: null, spectator: false };
  }

  /** The setup card's draft, seeded from the server view the first time it is touched. */
  function setupDraft() {
    const g = state.game || {};
    const mine = g.mySetup || {};
    return {
      clues: (mine.clues || []).map((c) => ({ ...c })),
      noClues: Boolean(mine.noClues),
      topicNames: { ...(g.topicNames || {}) },
      conferences: { ...(g.conferenceRules || {}) },
      conferenceNames: { ...(g.conferenceNames || {}) },
    };
  }

  /** The room dialog's draft of the same table-wide information. */
  function tableDraft() {
    const g = state.game || {};
    return { topicNames: { ...(g.topicNames || {}) }, conferences: { ...(g.conferenceRules || {}) }, conferenceNames: { ...(g.conferenceNames || {}) } };
  }

  /**
   * Merge a patch into `ui.setup` (or `ui.tableInfo`) as it is *now*.
   * Text fields must not merge into a stale render-time copy, otherwise typing into a
   * second field would drop the first one.
   */
  function patchUiState(key, fnOrPatch, quiet, seed) {
    const current = state.ui[key] || (seed ? seed() : {});
    const patch = typeof fnOrPatch === 'function' ? fnOrPatch(current) : fnOrPatch;
    const next = { ...current, ...(patch || {}) };
    if (quiet) setUiQuiet({ [key]: next });
    else setUi({ [key]: next });
    return next;
  }

  function skipTurn() {
    return remoteAction({ kind: 'skip-turn' });
  }

  /** Rejoin the room saved in this browser, if the server still knows it. */
  async function restoreRoom() {
    const saved = loadRoom();
    if (!saved) return false;
    const isCurrentRestore = () => {
      const current = loadRoom();
      return !state.remote && !state.ui.lobby.busy && current?.roomId === saved.roomId && current?.token === saved.token;
    };
    try {
      const view = await fetchView(saved);
      if (!isCurrentRestore()) return false;
      await enterRoom(saved, view);
      return true;
    } catch (error) {
      if (isCurrentRestore()) {
        if ([401, 403, 404, 410].includes(error.status)) clearRoom();
        else toast('暂时无法恢复房间，身份已保留。请确认服务运行后刷新重试。', 'bad');
      }
      return false;
    }
  }

  function conferenceModalPayload(entry, game) {
    if (!entry) return null;
    return {
      kind: 'conference',
      label: game?.conferenceNames?.[entry.sector] || entry.label || `X行星会议 · ${entry.sector} 号`,
      text: entry.text,
      sector: entry.sector,
    };
  }

  const BLOCKING_MODALS = new Set(['help', 'start', 'lobby', 'locate', 'result']);

  /** Popup when a new conference clue becomes public so it is not only a silent left-rail update. */
  function noticeNewConferences(prev, next) {
    if (!next?.knowledge) return;
    const before = new Set((prev?.knowledge?.conferences || []).map((entry) => entry.sector));
    const added = (next.knowledge.conferences || []).filter((entry) => !before.has(entry.sector));
    if (!added.length) return;
    const latest = added[added.length - 1];
    const current = state.ui.modal;
    if (current && BLOCKING_MODALS.has(current.kind)) {
      state.ui.pendingConference = latest;
      if (!state.ui.toast) toast(`X行星会议已召开（${latest.sector} 号扇区），关闭当前窗口后查看线索`, 'clue');
      return;
    }
    state.ui.pendingConference = null;
    state.ui.modal = conferenceModalPayload(latest, next);
  }

  function flushPendingConference() {
    const pending = state.ui.pendingConference;
    if (!pending || state.ui.modal) return;
    state.ui.pendingConference = null;
    state.ui.modal = conferenceModalPayload(pending, state.game || state.remote?.view);
  }

  function setUi(patch) {
    const closingModal = 'modal' in patch && patch.modal === null;
    Object.assign(state.ui, patch);
    if (patch.surveyType === Obj.COMET && state.ui.action === 'survey') {
      const game = view();
      state.ui.pick = (state.ui.pick || []).filter((sector) => isCometSector(game.mode, sector) && visibleOf(game).includes(sector));
      state.ui.selectedSector = state.ui.pick.at(-1) ?? null;
    }
    if (closingModal) flushPendingConference();
    render();
  }

  /** Update state without re-rendering — used by text inputs so typing keeps focus. */
  function setUiQuiet(patch) {
    Object.assign(state.ui, patch);
  }

  function clearHistoryResults() {
    state.ui.panels = Object.fromEntries(Object.entries(state.ui.panels || {}).filter(([id]) => !id.startsWith('history-result-')));
  }

  function toast(text, kind = 'info') {
    state.ui.toast = { text, kind };
    render();
    setTimeout(() => {
      if (state.ui.toast && state.ui.toast.text === text) {
        state.ui.toast = null;
        render();
      }
    }, appTiming.toastMs);
  }

  function visibleOf(g) {
    return Array.isArray(g.visible) ? g.visible : visibleSectorsAt(g.time, g.mode);
  }

  // ---- recording ------------------------------------------------------------

  function consoleAction(action) {
    if (state.remote) return remoteAction(action);
    const prevConferences = (consoleView(session).knowledge?.conferences || []).map((entry) => entry.sector);
    const res =
      action.kind === 'survey'
        ? recordSurvey(session, action)
        : action.kind === 'target'
          ? recordTarget(session, action)
          : action.kind === 'research'
            ? recordResearch(session, action)
            : action.kind === 'theory'
              ? recordTheory(session, action)
              : action.kind === 'conference'
                ? recordConference(session, action)
                : action.kind === 'wait'
                  ? recordWait(session, action.units ?? action.months)
                  : action.kind === 'locate'
                    ? recordLocate(session, action)
                    : action.kind === 'theory-complete'
                      ? completeTheoryPhase(session)
                      : action.kind === 'reveal-objects'
                        ? revealObjects(session, action.objects)
                        : action.kind === 'undo'
                          ? undoLast(session)
                          : { ok: false, error: `不支持该操作：${action.kind}` };

    if (!res.ok) {
      toast(res.error, 'bad');
      return res;
    }
    if (['locate', 'theory-complete', 'reveal-objects'].includes(action.kind)) {
      state.ui.modal = null;
      state.ui.action = 'idle';
      state.ui.pick = [];
    }
    const nextView = consoleView(session);
    noticeNewConferences({ knowledge: { conferences: prevConferences.map((sector) => ({ sector })) } }, nextView);
    if (res.warning) {
      toast(res.warning, 'bad');
    } else if (action.kind === 'undo') {
      toast('已撤销最后一条记录', 'ok');
    } else if (action.kind === 'theory-complete') {
      const waiting = session.entries.filter((e) => e.type === 'theory' && e.review === 'pending' && e.slot <= 1).length;
      toast(
        waiting
          ? `本阶段已完成；${waiting} 条理论到达评审格，请填写 app 评审结果`
          : '本阶段已完成，所有未评审理论各推进一格',
        waiting ? 'clue' : 'ok',
      );
    } else if (action.kind === 'theory') toast('已提交理论；完成本阶段后统一推进', 'ok');
    else if (action.kind === 'locate') toast(action.correct === false ? '定位错误：耗时 5 个时间单位，继续游戏' : '定位正确：天窗已冻结，请按官方 app 揭示棋盘', action.correct === false ? 'bad' : 'clue');
    else if (action.kind === 'reveal-objects') toast('棋盘已揭示，最终积分已结算', 'ok');
    else if (action.kind === 'survey') toast('已记录勘测结果', 'ok');
    else if (action.kind === 'target') toast('已记录扫描结果', 'ok');
    else if (action.kind === 'research') toast('已记录研究线索', 'ok');
    else if (action.kind === 'conference' || state.ui.modal?.kind === 'conference') {
      /* conference popup already shows the clue */
    }
    else toast('已记录', 'ok');

    persist();
    render();
    return res;
  }

  /** Range implied by the two sectors picked on the map (clockwise, shortest way). */
  function pickedRange() {
    const [a, b] = state.ui.pick || [];
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
    const n = view().mode.sectors;
    const forward = mod(b - a, n) + 1;
    const backward = mod(a - b, n) + 1;
    if (forward <= 9 || forward <= backward) return { start: a, size: forward, sectors: arcSectors(a, forward, n) };
    return { start: b, size: backward, sectors: arcSectors(b, backward, n) };
  }

  function startAction(kind) {
    state.ui.action = kind;
    state.ui.pick = [];
    state.ui.selectedSector = null;
    if (kind === 'theory') {
      const option = view().theoryOptions?.[0];
      state.ui.theorySector = option?.sector ?? null;
      state.ui.theoryType = option?.types[0] ?? null;
    }
    render();
  }

  function cancelAction() {
    state.ui.action = 'idle';
    state.ui.pick = [];
    render();
  }

  /** Shared tail of every confirm: auto-fill the facts, clear the card, re-render. */
  function finishConfirm(kind, payload, res) {
    if (!res || !res.ok) return res;
    if (state.game.playMode === 'builtin') {
      const entry = res.view?.log?.find((record) => record.id === res.entry?.id);
      if (entry?.type === 'target') payload = { ...payload, apparent: entry.apparent };
      if (entry?.type === 'survey') payload = { ...payload, count: entry.count };
    }
    // what the app told you is a fact: write it straight into the record sheet
    if (kind === 'scan') {
      if (state.game.playMode === 'builtin' && payload.apparent === Obj.EMPTY) {
        for (const objectType of SURVEY_TYPES.filter((type) => type !== Obj.EMPTY)) writeNote(`${payload.sector}:${CODE[objectType]}`, 'no');
      } else if (CODE[payload.apparent]) writeNote(`${payload.sector}:${CODE[payload.apparent]}`, 'yes');
    } else if (kind === 'survey' && payload.size === 1) {
      if (!(state.game.playMode === 'builtin' && payload.type === Obj.EMPTY && payload.count === 1)) {
        writeNote(`${payload.start}:${CODE[payload.type]}`, payload.count === 1 ? 'yes' : 'no');
      }
    }
    state.ui.action = 'idle';
    state.ui.pick = [];
    state.ui.surveyCount = 0;
    state.ui.topicName = '';
    state.ui.clueText = '';
    state.ui.targetResult = null;
    state.ui.researchTopic = null;
    persist();
    render();
    return res;
  }

  /** Confirm the active action card and auto-fill whatever is a plain fact. */
  function confirmAction() {
    const ui = state.ui;
    const kind = ui.action;
    let payload = null;
    if (kind === 'survey') {
      const range = pickedRange();
      if (!range) {
        toast('请先在星图上点起点和终点', 'bad');
        return { ok: false };
      }
      if (range.size > 9) {
        toast('勘测范围最多 9 个扇区', 'bad');
        return { ok: false };
      }
      payload = { kind: 'survey', type: ui.surveyType, start: range.start, size: range.size, ...(state.game.playMode === 'builtin' ? {} : { count: Number(ui.surveyCount) }) };
    } else if (kind === 'scan') {
      const sector = (ui.pick || [])[0];
      if (!Number.isInteger(sector)) {
        toast('请先在星图上点一个扇区', 'bad');
        return { ok: false };
      }
      if (!ui.targetResult && state.game.playMode !== 'builtin') {
        toast('请选择 app 给出的扫描结果', 'bad');
        return { ok: false };
      }
      payload = { kind: 'target', sector, ...(state.game.playMode === 'builtin' ? {} : { apparent: ui.targetResult }) };
    } else if (kind === 'research') {
      if (!ui.researchTopic) {
        toast('请先选择一个课题（A–F）', 'bad');
        return { ok: false };
      }
      payload = { kind: 'research', topic: ui.researchTopic, ...(state.game.playMode === 'builtin' ? {} : { name: ui.topicName, text: ui.clueText }) };
    } else if (kind === 'theory') {
      if (!Number.isInteger(ui.theorySector)) {
        toast('请选择要发表理论的扇区', 'bad');
        return { ok: false };
      }
      payload = { kind: 'theory', sector: ui.theorySector, type: ui.theoryType };
    } else {
      return { ok: false };
    }

    const res = consoleAction(payload);
    // the online path answers asynchronously; the offline one is immediate
    if (res && typeof res.then === 'function') return res.then((settled) => finishConfirm(kind, payload, settled));
    return finishConfirm(kind, payload, res);
  }

  function recordTheoryReview(id, review) {
    if (state.remote) {
      return remoteAction({ kind: 'review', id, review });
    }
    const res = markTheoryReview(session, id, review);
    if (res.ok && review === 'wrong') toast('评审错误：你的棋子前进 1 个时间单位', 'bad');
    else if (res.ok && review === 'correct') toast('评审正确：该扇区的内容对全桌公开', 'ok');
    persist();
    render();
    return res;
  }

  // ---- map + record sheet ---------------------------------------------------

  function onSector(sector) {
    view();
    state.ui.mark = null; // clicking the map itself dismisses the marking popover
    const visible = visibleOf(state.game);

    if (state.game.tutorial?.interaction === 'inspect') {
      state.ui.selectedSector = sector;
      return remoteAction({ kind: 'tutorial-inspect', sector });
    }

    // You may only survey or scan inside the visible sky, so a hidden sector is refused
    // here and again by the engine (which is what actually validates the record).
    if ((state.ui.action === 'survey' || state.ui.action === 'scan') && !visible.includes(sector)) {
      toast(`只能选天窗内的扇区：当前可见 ${visible.map((s) => s + 1).join('、')} 号`, 'bad');
      return;
    }
    if (state.ui.action === 'survey' && state.ui.surveyType === Obj.COMET && !isCometSector(state.game.mode, sector)) {
      toast('彗星勘测的起点和终点只能选择可见的质数编号扇区', 'bad');
      return;
    }

    if (state.ui.action === 'survey' || state.ui.action === 'scan') {
      state.ui.selectedSector = sector;
      const picks = state.ui.pick || [];
      if (state.ui.action === 'survey') {
        state.ui.pick = picks.length >= 2 ? [sector] : [...picks, sector];
      } else {
        state.ui.pick = [sector];
      }
      render();
      return;
    }

    state.ui.selectedSector = sector;
    render();
  }

  function toggleNote(sector, code) {
    const key = `${sector}:${code}`;
    const cur = state.notes[key];
    if (state.game.tutorial) return setMark(sector, code, !cur ? 'yes' : cur === 'yes' ? 'no' : 'maybe');
    writeNote(key, !cur ? 'yes' : cur === 'yes' ? 'no' : 'maybe');
    persist();
    render();
  }

  /** Open the three-way marking choice for one object in one sector. */
  function openMark(sector, code) {
    state.ui.mark = { sector, code };
    state.ui.selectedSector = sector;
    render();
  }

  /** state: 'yes' (确定存在) | 'no' (不存在) | 'maybe' (可能存在, clears the mark). */
  async function setMark(sector, code, markState) {
    if (state.game.tutorial && !state.game.tutorial.completed) {
      if (state.game.tutorial.interaction !== 'mark') {
        const error = '请先完成当前教学步骤，得到足够证据后再标记推理结果';
        toast(error, 'bad');
        return { ok: false, error };
      }
      const remote = state.remote;
      const guide = state.game.tutorial;
      if (remote && !remote.actionPending && guide.expected?.sector === sector && guide.expected.code === code && guide.expected.markState === markState) {
        remote.pendingTutorialMark = { stepId: guide.stepId, revision: state.game.revision, sector, code, markState };
        persist();
      }
      const result = await remoteAction({ kind: 'tutorial-mark', stepId: guide.stepId, sector, code, markState });
      if (!result.ok || state.remote !== remote) return result;
      if (remote.pendingTutorialMark === null) return result;
      remote.pendingTutorialMark = null;
    }
    const key = `${sector}:${code}`;
    writeNote(key, markState);
    persist();
    render();
    return { ok: true };
  }

  function clearNotes() {
    state.notes = {};
    if (state.remote?.initialClueSync) state.remote.initialClueSync.owned = [];
    if (state.remote) state.remote.pendingTutorialMark = null;
    persist();
    render();
  }

  function newSession(modeId) {
    if (state.remote?.view.tutorial) return exitTutorial();
    if (state.remote) leaveRoom();
    clearHistoryResults();
    Object.assign(session, createConsole({ modeId: modeId || session.mode.id }), { seq: 1 });
    state.notes = {};
    state.ui.modal = null;
    state.ui.selectedSector = null;
    state.ui.researchTopic = null;
    state.ui.targetResult = null;
    state.ui.mark = null;
    state.ui.action = 'idle';
    state.ui.pick = [];
    state.ui.topicName = '';
    state.ui.clueText = '';
    state.ui.conferenceText = '';
    state.ui.locate = null;
    state.ui.finalTheories = [];
    state.ui.revealObjects = [];
    state.ui.playMode = 'record';
    persist();
    render();
  }

  function openLocate() {
    state.ui.locate = state.ui.locate || { sector: 0, left: 'asteroid', right: 'asteroid' };
    state.ui.modal = { kind: 'locate' };
    render();
  }

  const api = {
    setUi,
    setUiQuiet,
    doAction: consoleAction,
    consoleAction,
    newSession,
    startBuiltin,
    startTutorial,
    tutorialNext,
    restartTutorial,
    exitTutorial,
    openLocate,
    openMark,
    setMark,
    toggleNote,
    clearNotes,
    startAction,
    cancelAction,
    confirmAction,
    recordTheoryReview,
    pickedRange,
    createRoom: doCreateRoom,
    joinRoom: doJoinRoom,
    leaveRoom,
    startGame,
    claimInitialClues,
    setInitialClueCount,
    submitSetup,
    reopenSetup,
    saveTableInfo,
    setupDraft,
    tableDraft,
    patchSetup: (fnOrPatch, quiet = false) => patchUiState('setup', fnOrPatch, quiet, setupDraft),
    patchTableInfo: (fnOrPatch, quiet = false) => patchUiState('tableInfo', fnOrPatch, quiet, tableDraft),
    // the lobby form always types quietly (no re-render), so its fields are merged into
    // the live state and the caller gets the merged object back to sync dependent UI
    patchLobby: (fnOrPatch) => patchUiState('lobby', fnOrPatch, true, emptyLobby),
    skipTurn,
    isOnline: () => Boolean(state.remote),
    consoleSummary: () => state.game.summary || consoleSummary(session),
    nudgeWindow: (delta) => {
      if (state.remote) return remoteAction({ kind: 'nudge', delta });
      const result = nudgeWindow(session, delta);
      if (!result.ok) return result;
      persist();
      render();
      return result;
    },
  };

  // Clicking anywhere outside a popup dismisses it; Escape closes it too.
  if (typeof document.addEventListener === 'function') {
    document.addEventListener(
      'click',
      (event) => {
        const target = event && event.target;
        if (!target || typeof target.closest !== 'function') return;
        let changed = false;
        if (state.ui.mark && !target.closest('.mark-pop') && !target.closest('.poss-icon') && !target.closest('.mark-chip')) {
          state.ui.mark = null;
          changed = true;
        }
        if (state.ui.modal && !target.closest('.modal') && !target.closest('[data-modal-trigger]')) {
          state.ui.modal = null;
          flushPendingConference();
          changed = true;
        }
        if (changed) render();
      },
      true,
    );
    document.addEventListener('keydown', (event) => {
      if (!event || event.key !== 'Escape') return;
      if (!state.ui.mark && !state.ui.modal) return;
      state.ui.mark = null;
      state.ui.modal = null;
      flushPendingConference();
      render();
    });
  }

  render();
  restoreRoom();
  return { state, render, api, persist, session, room: () => state.remote };
}

/** Human names for the log/notice lines. */
const ACTION_NAMES = {
  survey: '一次勘测',
  target: '一次扫描',
  research: '一条研究线索',
  theory: '一条学术研究',
  conference: '会议线索',
  wait: '1 个时间单位的等待',
  locate: '定位结果',
  review: '评审结果',
  nudge: '天窗位置',
};

export function start() {
  const root = document.getElementById('app');
  if (!root) return null;
  return createApp(root);
}
