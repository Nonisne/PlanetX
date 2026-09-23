// Manual archive pack/unpack for console sessions and online rooms.
import { createConsole } from './console.js';

export const ARCHIVE_VERSION = 1;

function fail(error) {
  return { ok: false, error };
}

function seatList(players) {
  return (players || []).map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    host: Boolean(player.host),
    spectator: Boolean(player.spectator),
  }));
}

/** Build a downloadable archive from the live app state. */
export function buildArchive({ remote, session, notes, roomSnapshot }) {
  const savedAt = new Date().toISOString();
  if (remote && roomSnapshot) {
    return {
      version: ARCHIVE_VERSION,
      kind: 'online',
      savedAt,
      room: roomSnapshot,
      notesByPlayer: { [remote.playerId]: { ...(notes || {}) } },
      seats: seatList(roomSnapshot.players),
    };
  }
  return {
    version: ARCHIVE_VERSION,
    kind: 'console',
    savedAt,
    console: {
      modeId: session.mode?.id || 'standard',
      entries: session.entries || [],
      locate: session.locate || null,
      status: session.status || 'open',
      windowOffset: session.windowOffset || 0,
      windowTime: session.windowTime ?? null,
      topics: session.topics || {},
      seq: session.seq || 1,
      theoryPhases: session.theoryPhases || [],
      completedTheoryPhases: session.completedTheoryPhases || [],
      undoBarrier: session.undoBarrier || 0,
      revealedObjects: session.revealedObjects || null,
      frozenTimes: session.frozenTimes || null,
    },
    notes: { ...(notes || {}) },
  };
}

export function parseArchive(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return fail('存档不是合法的 JSON');
    }
  }
  if (!data || typeof data !== 'object') return fail('存档无效');
  if (data.version !== ARCHIVE_VERSION) return fail('存档版本不受支持');
  if (data.kind === 'console') {
    if (!data.console || typeof data.console !== 'object') return fail('单机存档缺少对局数据');
    return { ok: true, archive: data };
  }
  if (data.kind === 'online') {
    if (!data.room || !data.room.id || !Array.isArray(data.room.players)) return fail('联机存档缺少房间数据');
    return { ok: true, archive: data };
  }
  return fail('未知的存档类型');
}

/** Apply a console archive onto an existing session object (mutates). */
export function applyConsoleArchive(session, archive) {
  const saved = archive.console;
  const next = createConsole({ modeId: saved.modeId || 'standard' });
  Object.assign(session, next, {
    entries: Array.isArray(saved.entries) ? saved.entries : [],
    locate: saved.locate || null,
    status: saved.status || 'open',
    windowOffset: saved.windowOffset || 0,
    windowTime: Number.isFinite(saved.windowTime) ? saved.windowTime : null,
    topics: { ...next.topics, ...(saved.topics || {}) },
    seq: saved.seq || (saved.entries?.length || 0) + 1,
    theoryPhases: Array.isArray(saved.theoryPhases) ? saved.theoryPhases : [],
    completedTheoryPhases: Array.isArray(saved.completedTheoryPhases) ? saved.completedTheoryPhases : [],
    undoBarrier: Number.isInteger(saved.undoBarrier) ? saved.undoBarrier : 0,
    revealedObjects: Array.isArray(saved.revealedObjects) ? saved.revealedObjects : null,
    frozenTimes: saved.frozenTimes || null,
  });
  return { notes: archive.notes && typeof archive.notes === 'object' ? { ...archive.notes } : {} };
}

export function seatToken(archive, playerId) {
  const player = archive.room?.players?.find((entry) => entry.id === playerId);
  return player?.token || null;
}

export function notesForSeat(archive, playerId) {
  const pack = archive.notesByPlayer?.[playerId];
  return pack && typeof pack === 'object' ? { ...pack } : {};
}

export function downloadArchive(archive, filename) {
  const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || `planetx-${archive.kind}-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readArchiveFile(file) {
  const text = await file.text();
  return parseArchive(text);
}
