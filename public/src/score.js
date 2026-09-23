// End-of-game scoring, derived from the shared log.
//
// The page never judges anything itself: a theory counts when its peer review said it was
// correct, and a locate counts when the player told us the app confirmed it. Everything
// here is therefore a tally of what the table typed in.
//
//   * every confirmed theory is worth its object's points (rules.js THEORY_POINTS)
//   * the first player to publish a *correct* theory about a sector gets the leader bonus
import { COST, LEADER_BONUS, LOCATE_POINTS, locatePointsFor, theoryPointsFor } from './rules.js';

/** True when this paper's author was told it was right. */
function isCorrect(entry) {
  return entry.type === 'theory' && entry.review === 'correct';
}

/** The earliest correct paper per sector: its author takes that sector's leader bonus. */
export function leaderSectors(entries) {
  const first = new Map();
  for (const entry of entries) {
    if (!isCorrect(entry)) continue;
    const current = first.get(entry.sector);
    if (!current || (entry.id || 0) < (current[0].id || 0)) first.set(entry.sector, [entry]);
    else if (entry.publicationPhase && entry.publicationPhase === current[0].publicationPhase) current.push(entry);
  }
  return first;
}

/** Locates the app confirmed; an entry recorded before the flag existed counts as found. */
function successfulLocates(entries) {
  return entries.filter((e) => e.type === 'located' && e.correct !== false);
}

/**
 * The score table: one row per player, plus the totals.
 * `players` may be omitted for the offline console, where everything is yours.
 * `frozenTimes` (optional): explicit `{ [playerId]: timeUnits }` map of the frozen clock
 * values captured at the moment the first player correctly located Planet X. When provided,
 * later-finders' scores use these frozen values directly. When absent, falls back to
 * `(firstFind.time + COST.locate - myFind.time)` — equivalent only when the first finder's
 * cost equals the official locate cost (5); the fallback keeps the offline console working.
 */
export function scoreBoard(state, players, frozenTimes) {
  const entries = state.entries || [];
  const list = players && players.length ? players : [{ id: 'me', name: '我' }];
  const solo = list.length === 1;
  // the offline console writes entries without an actor: they all belong to its one player
  const ownerOf = (entry) => entry.actorId || (solo ? list[0].id : null);
  const mode = state.mode;
  const leaders = leaderSectors(entries);
  const finds = successfulLocates(entries);
  const firstFind = finds[0] || null;

  const rows = list.map((player) => {
    const mine = entries.filter((e) => isCorrect(e) && ownerOf(e) === player.id);
    const details = mine.map((t) => ({
      sector: t.sector,
      objectType: t.objectType,
      points: theoryPointsFor(mode, t.objectType),
    }));
    const theoryPoints = details.reduce((n, d) => n + d.points, 0);
    const leader = [...leaders.values()].filter((claims) => claims.some((entry) => ownerOf(entry) === player.id)).length * LEADER_BONUS;
    const myFind = finds.find((f) => ownerOf(f) === player.id) || null;
    const locatePoints = !myFind
      ? 0
      : myFind === firstFind
        ? LOCATE_POINTS.first
        : locatePointsFor(
            myFind.distanceBehind ??
            (frozenTimes && firstFind && myFind
              ? (frozenTimes[firstFind.actorId] ?? firstFind.time + COST.locate) - (frozenTimes[ownerOf(myFind)] ?? myFind.time)
              : (firstFind.time || 0) + (firstFind.cost ?? COST.locate) - (myFind.time || 0)
            )
          );
    return {
      id: player.id,
      name: player.name,
      color: player.color || null,
      correctTheories: details.length,
      theories: details,
      theoryPoints,
      leaderBonus: leader,
      located: Boolean(myFind),
      locatePoints,
      total: theoryPoints + leader + locatePoints,
    };
  });

  return {
    rows,
    // the tables the UI prints in its footnote, so the numbers are never a mystery
    theoryPoints: mode && mode.id === 'expert' ? '小行星 2 · 彗星 3 · 气体云 4 · 矮行星 2' : '小行星 2 · 彗星 3 · 气体云 4 · 矮行星 4',
    leaderBonus: LEADER_BONUS,
    locateFirst: LOCATE_POINTS.first,
    locatePerSector: LOCATE_POINTS.perSectorBehind,
    leaders: [...leaders.keys()].sort((a, b) => a - b),
    firstFinderId: firstFind ? ownerOf(firstFind) : null,
    finished: state.status === 'finished',
  };
}

/** The winning row(s) — ties are reported as a list. */
export function scoreWinners(board) {
  if (!board || !board.rows.length) return [];
  let winners = board.rows;
  for (const key of ['total', 'locatePoints', 'leaderBonus']) {
    const best = Math.max(...winners.map((row) => row[key] || 0));
    winners = winners.filter((row) => (row[key] || 0) === best);
  }
  return winners;
}
