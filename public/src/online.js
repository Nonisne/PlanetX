// Client side of the online room: a few fetch calls plus a Server-Sent Events stream.
// The server always answers with a per-player view, so the UI renders exactly the same
// shapes it uses offline.

const API = '/api';

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  return { status: res.status, ...data };
}

export async function listModes() {
  const res = await request('/modes');
  return res.modes || [];
}

export async function createRoom({ name, modeId = 'standard', playMode = 'record', initialClueCount = 4, withBots = 0 }) {
  if (playMode === 'tutorial') {
    modeId = 'standard';
    initialClueCount = 4;
    withBots = 0;
  }
  if (playMode === 'builtin' || playMode === 'tutorial') {
    const capabilities = await request('/modes');
    const label = playMode === 'tutorial' ? '教学模式' : '内置谜题';
    if (!capabilities.playModes?.includes(playMode)) throw new Error(`当前服务尚未支持${label}。请在现有对局结束后重启本地服务，再创建新局。`);
    if (playMode === 'builtin' && !capabilities.builtinBoards?.includes(modeId)) throw new Error('当前服务尚未支持所选的内置棋盘。请结束现有对局并重启本地服务后再试。');
    if (!capabilities.initialClueCounts?.includes(initialClueCount)) throw new Error('当前服务尚未支持房主统一分发初始线索。请在现有对局结束后重启本地服务。');
    if (playMode === 'builtin' && withBots) {
      const maxBots = capabilities.withBots?.max;
      if (!Number.isInteger(maxBots)) throw new Error('当前服务尚未支持 Bot 对手。请在现有对局结束后重启本地服务后再试。');
      if (!Number.isInteger(withBots) || withBots < 0 || withBots > maxBots) throw new Error(`Bot 对手数量只能是 0–${maxBots}`);
    }
  }
  const body = { name, modeId, playMode, initialClueCount };
  if (playMode === 'builtin' && withBots > 0) body.withBots = withBots;
  const res = await request('/rooms', { method: 'POST', body });
  if (!res.token) throw new Error(res.error || '创建房间失败');
  if (playMode === 'builtin' && res.view?.playMode !== 'builtin') throw new Error('服务未创建内置谜题，请更新并重启本地服务后再试。');
  if (playMode === 'tutorial' && (res.view?.playMode !== 'builtin' || !res.view?.tutorial)) throw new Error('服务未创建教学局，请更新并重启本地服务后再试。');
  return res;
}

/** Fetch a full room snapshot for a manual archive (includes tokens / puzzle). */
export async function fetchRoomArchive(room) {
  const res = await request(`/rooms/${room.roomId}/archive?token=${encodeURIComponent(room.token)}`);
  if (!res.room) throw Object.assign(new Error(res.error || '无法导出房间存档'), { status: res.status });
  return res.room;
}

/** Put an archived room back into server memory if the code is free. */
export async function restoreArchivedRoom(snapshot) {
  const res = await request('/rooms/restore', { method: 'POST', body: { room: snapshot } });
  if (!res.roomId) throw Object.assign(new Error(res.error || '无法恢复房间'), { status: res.status });
  return res;
}

export async function joinRoom(roomId, name, { spectator = false } = {}) {
  const res = await request(`/rooms/${String(roomId || '').trim().toUpperCase()}/join`, {
    method: 'POST',
    body: { name, spectator: Boolean(spectator) },
  });
  if (!res.token) throw new Error(res.error || '加入房间失败');
  return res;
}

export async function fetchView(room) {
  const res = await request(`/rooms/${room.roomId}/view?token=${encodeURIComponent(room.token)}`);
  if (!res.view) throw Object.assign(new Error(res.error || '无法读取房间状态'), { status: res.status });
  return res.view;
}

export async function sendAction(room, action) {
  const res = await request(`/rooms/${room.roomId}/action`, { method: 'POST', body: { token: room.token, action } });
  return res;
}

/**
 * Subscribe to room pushes. Returns a handle with `close()`.
 * `onView(view, notice)` fires on every change (including the initial snapshot).
 */
export function openStream(room, { onView, onStatus } = {}) {
  if (typeof EventSource !== 'function') {
    if (onStatus) onStatus('unsupported');
    return { close() {} };
  }
  const url = `${API}/rooms/${room.roomId}/stream?token=${encodeURIComponent(room.token)}`;
  const source = new EventSource(url);
  source.addEventListener('open', () => onStatus && onStatus('online'));
  source.addEventListener('view', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return; // malformed frame: ignore it
    }
    try {
      onView && onView(payload.view, payload.notice);
    } catch (err) {
      // A broken push must never stop the stream, but it should not vanish silently
      // either — otherwise the board simply freezes with no clue why.
      console.warn?.('无法应用房间推送', err);
    }
  });
  source.addEventListener('error', () => onStatus && onStatus('offline'));
  return {
    close() {
      try {
        source.close();
      } catch {
        /* already closed */
      }
    },
    source,
  };
}

const ROOM_KEY = 'planetx.room.v1';
const TUTORIAL_RETURN_KEY = 'planetx.tutorial-return.v1';

// The room identity lives in sessionStorage on purpose: it survives a reload, but two
// tabs / windows of the same browser are two different players (which is exactly what
// you want when you test a table on one machine).
function tabStorage() {
  try {
    return typeof sessionStorage === 'object' && sessionStorage ? sessionStorage : null;
  } catch {
    return null;
  }
}

function persistentStorage() {
  try {
    return typeof localStorage === 'object' && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

export function saveRoom(room) {
  const store = tabStorage();
  try {
    if (store) store.setItem(ROOM_KEY, JSON.stringify(room));
  } catch {
    /* storage unavailable */
  }
  // an identity left behind by an older build would make a second tab join as the
  // same player, so clear it once
  try {
    const persistent = persistentStorage();
    if (persistent) persistent.removeItem(ROOM_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function loadRoom() {
  try {
    const store = tabStorage() || persistentStorage();
    const raw = store && store.getItem(ROOM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.roomId && parsed.token ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRoom() {
  try {
    const store = tabStorage();
    if (store) store.removeItem(ROOM_KEY);
    const persistent = persistentStorage();
    if (persistent) persistent.removeItem(ROOM_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function saveTutorialReturn(room) {
  if (loadTutorialReturn()) return;
  try {
    tabStorage()?.setItem(TUTORIAL_RETURN_KEY, JSON.stringify({ room: room ? { roomId: room.roomId, playerId: room.playerId, token: room.token } : null }));
  } catch {
    return;
  }
}

export function loadTutorialReturn() {
  try {
    const raw = tabStorage()?.getItem(TUTORIAL_RETURN_KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && (value.room === null || (value.room?.roomId && value.room?.token)) ? value : null;
  } catch {
    return null;
  }
}

export function clearTutorialReturn() {
  try {
    tabStorage()?.removeItem(TUTORIAL_RETURN_KEY);
  } catch {
    return;
  }
}
