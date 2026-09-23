// Manual archive pack/unpack for console sessions and online rooms.
// Archives live in a local library (localStorage); optional JSON export/import remains available.
import { createConsole } from './console.js';

export const ARCHIVE_VERSION = 1;
export const LIBRARY_KEY = 'planetx.archive-library.v1';

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

function newSlotId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function libraryStorage() {
  try {
    return typeof localStorage === 'object' && localStorage ? localStorage : null;
  } catch {
    return null;
  }
}

function readLibrary() {
  const store = libraryStorage();
  if (!store) return { slots: [] };
  try {
    const raw = store.getItem(LIBRARY_KEY);
    if (!raw) return { slots: [] };
    const parsed = JSON.parse(raw);
    return { slots: Array.isArray(parsed?.slots) ? parsed.slots : [] };
  } catch {
    return { slots: [] };
  }
}

function writeLibrary(library) {
  const store = libraryStorage();
  if (!store) throw new Error('本机无法保存存档库（存储不可用）');
  store.setItem(LIBRARY_KEY, JSON.stringify({ slots: library.slots || [] }));
}

function formatSavedAt(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function archiveSummary(archive) {
  if (!archive) return '';
  if (archive.kind === 'online') {
    const seats = archive.seats?.length || archive.room?.players?.length || 0;
    const phase = archive.room?.phase || '';
    return `房间 ${String(archive.room?.id || '').toUpperCase()} · ${seats} 人${phase ? ` · ${phase}` : ''}`;
  }
  const mode = archive.console?.modeId === 'expert' ? '专家 18 扇区' : '标准 12 扇区';
  const steps = Array.isArray(archive.console?.entries) ? archive.console.entries.length : 0;
  return `${mode} · ${steps} 步`;
}

export function defaultArchiveLabel(archive) {
  const when = formatSavedAt(archive?.savedAt);
  if (archive?.kind === 'online') {
    return `联机 ${String(archive.room?.id || '').toUpperCase()}${when ? ` · ${when}` : ''}`;
  }
  const mode = archive?.console?.modeId === 'expert' ? '专家' : '标准';
  return `单机 ${mode}${when ? ` · ${when}` : ''}`;
}

function publicSlot(slot) {
  if (!slot) return null;
  return {
    id: slot.id,
    label: slot.label,
    kind: slot.kind,
    savedAt: slot.savedAt,
    summary: slot.summary,
  };
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

/** List library slots (newest first), without the heavy archive payload. */
export function listArchiveSlots() {
  return readLibrary()
    .slots.map(publicSlot)
    .filter(Boolean)
    .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
}

export function getArchiveSlot(id) {
  const slot = readLibrary().slots.find((entry) => entry.id === id);
  return slot || null;
}

/** Persist an archive into the local library. */
export function addArchiveSlot(archive, { label } = {}) {
  const parsed = parseArchive(archive);
  if (!parsed.ok) return parsed;
  const pack = parsed.archive;
  if (!pack.savedAt) pack.savedAt = new Date().toISOString();
  const slot = {
    id: newSlotId(),
    label: (label && String(label).trim()) || defaultArchiveLabel(pack),
    kind: pack.kind,
    savedAt: pack.savedAt,
    summary: archiveSummary(pack),
    archive: pack,
  };
  try {
    const library = readLibrary();
    library.slots.unshift(slot);
    writeLibrary(library);
  } catch (error) {
    return fail(error.message || '无法写入存档库');
  }
  return { ok: true, slot: publicSlot(slot) };
}

export function deleteArchiveSlot(id) {
  const library = readLibrary();
  const next = library.slots.filter((entry) => entry.id !== id);
  if (next.length === library.slots.length) return fail('存档不存在');
  try {
    writeLibrary({ slots: next });
  } catch (error) {
    return fail(error.message || '无法删除存档');
  }
  return { ok: true };
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
