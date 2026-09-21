import test from 'node:test';
import assert from 'node:assert/strict';
import { addPlayer, currentPlayer, viewFor } from '../public/src/room.js';
import { validateBoard } from '../server/puzzles.js';
import { researchClueText, researchFeatureValue } from '../server/research.js';
import { CODE, INITIAL_CLUE_TYPES, Obj } from '../public/src/types.js';
import { isCometSector } from '../public/src/rules.js';

const tutorial = await import('../server/tutorial.js').catch((error) => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});

function makeTutorial() {
  assert.equal(typeof tutorial.createTutorialRoom, 'function', 'tutorial creation API exists');
  return tutorial.createTutorialRoom({ hostName: '新手' });
}

function nextAction(view) {
  const guide = view.tutorial;
  if (guide.interaction === 'action') return { ...guide.expected, stepId: guide.stepId };
  if (guide.interaction === 'inspect') return { kind: 'tutorial-inspect', ...guide.expected, stepId: guide.stepId };
  if (guide.interaction === 'mark') return { kind: 'tutorial-mark', ...guide.expected, stepId: guide.stepId };
  return { kind: 'tutorial-next', stepId: guide.stepId };
}

function replay(room, onStep = () => {}) {
  const snapshots = [];
  for (let count = 0; count < 70; count += 1) {
    const view = viewFor(room, room.hostId);
    assert.ok(view.tutorial, 'current tutorial guide is public');
    snapshots.push(structuredClone(view));
    if (view.tutorial.completed) return snapshots;
    const action = nextAction(view);
    onStep(view, action);
    const result = tutorial.applyTutorialAction(room, room.hostId, action);
    assert.equal(result.ok, true, `${view.tutorial.stepId}: ${result.error}`);
    assert.notEqual(viewFor(room, room.hostId).tutorial.stepId, view.tutorial.stepId);
  }
  assert.fail('tutorial did not reach scoring within its finite script');
}

test('tutorial uses a legal fixed puzzle with six truthful topics and meaningful initial exclusions', () => {
  const room = makeTutorial();
  const puzzle = room.puzzle;
  assert.equal(validateBoard(puzzle.objects), true);
  assert.equal(puzzle.objects.indexOf(Obj.PLANET_X), 5);
  const masks = Object.fromEntries(Object.values(Obj).map((type) => [type, puzzle.objects.reduce((mask, actual, sector) => actual === type ? mask | (1 << sector) : mask, 0)]));
  assert.equal(Object.keys(puzzle.topics).length, 6);
  assert.equal(new Set(Object.values(puzzle.topics).map((topic) => topic.name)).size, 6);
  for (const topic of Object.values(puzzle.topics)) {
    assert.equal(researchFeatureValue(topic.feature, masks, 12), 1);
    assert.equal(topic.clue, researchClueText(topic.feature));
  }
  assert.equal(puzzle.conferences[10], '每个气体云都与X行星相邻。');
  for (const clues of puzzle.startingClues) {
    assert.equal(clues.length, 4);
    for (const clue of clues) {
      assert.ok(INITIAL_CLUE_TYPES.includes(clue.objectType));
      assert.notEqual(puzzle.objects[clue.sector], clue.objectType);
      if (clue.objectType === Obj.COMET) assert.equal(isCometSector(room.session.mode, clue.sector), true);
    }
  }
});

test('tutorial starts a real two-player builtin game and hides future answers and bot credentials', () => {
  const room = makeTutorial();
  const view = viewFor(room, room.hostId);
  assert.equal(room.phase, 'play');
  assert.equal(view.playMode, 'builtin');
  assert.equal(view.mode.sectors, 12);
  assert.equal(view.initialClueCount, 4);
  assert.equal(view.players.length, 2);
  assert.equal(view.mySetup.ready, true);
  assert.equal(view.mySetup.clues.length, 4);
  assert.ok(view.players[1].name.includes('Bot'));
  assert.equal(view.tutorial.chapter, 1);
  assert.equal(view.tutorial.completed, false);
  assert.equal(view.tutorial.interaction, 'continue');
  assert.equal(view.tutorialState, undefined);
  assert.equal(view.puzzle, undefined);
  assert.doesNotMatch(JSON.stringify(view), /每个气体云都与X行星相邻|6 号就是 X/);
  assert.equal(JSON.stringify(view).includes(room.players[1].token), false);
  assert.equal(view.revealedObjects, null);
  assert.deepEqual(view.conferenceNames, { 10: 'X行星和气体云' });
  const before = structuredClone(room);
  assert.throws(() => addPlayer(room, '闯入者'), /教学/);
  assert.deepEqual(room, before);
});

test('full tutorial uses legal actions, departure events, later-arrival order, review penalty and real scoring', () => {
  const room = makeTutorial();
  const bot = room.players[1];
  const snapshots = replay(room);
  assert.equal(room.phase, 'done');
  assert.equal(snapshots.at(-1).tutorial.interaction, 'complete');
  const actions = room.session.entries.filter((entry) => entry.actorId === room.hostId && entry.cost > 0);
  assert.deepEqual(actions.map((entry) => entry.type), ['survey', 'target', 'research', 'survey', 'located']);
  assert.deepEqual(actions.map((entry) => entry.cost), [4, 4, 1, 4, 5]);
  const botActions = room.session.entries.filter((entry) => entry.actorId === bot.id && entry.cost > 0 && entry.type !== 'penalty');
  assert.deepEqual(botActions.map((entry) => entry.cost), [4, 4, 1, 4]);
  const phases = snapshots.filter((view) => view.research);
  assert.deepEqual([...new Set(phases.map((view) => view.research.sector))], [3, 6, 9, 12]);
  const firstPublishing = phases.find((view) => view.research.sector === 3 && view.research.allDeclared);
  assert.deepEqual(firstPublishing.research.order, [room.hostId, bot.id]);
  const tied = snapshots.find((view) => view.players.every((player) => player.time === 4));
  assert.equal(tied.turnOrder[0], room.hostId);
  assert.ok(tied.players[1].arrival > tied.players[0].arrival);
  const papers = room.session.entries.filter((entry) => entry.type === 'theory');
  assert.deepEqual(papers.map((entry) => [entry.sector, entry.objectType, entry.review]), [
    [4, Obj.GAS_CLOUD, 'correct'], [2, Obj.DWARF_PLANET, 'correct'], [7, Obj.ASTEROID, 'wrong'],
  ]);
  assert.equal(room.session.entries.find((entry) => entry.type === 'penalty').actorId, bot.id);
  const beforeLocate = snapshots.find((view) => view.tutorial.expected?.kind === 'locate');
  assert.deepEqual(beforeLocate.players.map((player) => player.time), [13, 14]);
  assert.equal(beforeLocate.turnPlayerId, room.hostId);
  assert.equal(beforeLocate.knowledge.conferences.length, 1);
  assert.equal(beforeLocate.knowledge.conferences[0].sector, 10);
  assert.ok(beforeLocate.knowledge.theories.some((theory) => theory.sector === 2 && theory.review === 'correct'));
  const result = viewFor(room, room.hostId);
  assert.deepEqual(result.revealedObjects, room.puzzle.objects);
  assert.equal(result.scores.finished, true);
  assert.deepEqual(result.scores.rows.map((row) => [row.total, row.theoryPoints, row.leaderBonus, row.locatePoints]), [[15, 4, 1, 10], [5, 4, 1, 0]]);
  assert.equal(result.endgame.players[0].choice, 'final-pass');
  assert.equal(currentPlayer(room), null);
});

test('each tutorial step rejects wrong actor, wrong input and replays without changing game state', () => {
  const room = makeTutorial();
  const bot = room.players[1];
  let previousAction = null;
  replay(room, (view, action) => {
    for (const invalid of [
      { kind: 'wait', stepId: view.tutorial.stepId },
      { ...action, stepId: 'stale-step' },
      ...(previousAction ? [previousAction] : []),
    ]) {
      const before = structuredClone(room);
      assert.equal(tutorial.applyTutorialAction(room, room.hostId, invalid).ok, false);
      assert.deepEqual(room, before);
    }
    const before = structuredClone(room);
    assert.equal(tutorial.applyTutorialAction(room, bot.id, action).ok, false);
    assert.deepEqual(room, before);
    if (view.tutorial.expected) {
      const fields = Object.keys(view.tutorial.expected).filter((field) => field !== 'kind');
      for (const field of fields) {
        assert.equal(tutorial.applyTutorialAction(room, room.hostId, { ...action, [field]: null }).ok, false, `invalid ${field}`);
        assert.deepEqual(room, before);
      }
    }
    if (view.tutorial.actor === 'bot') assert.equal(view.tutorial.expected, null);
    if (view.tutorial.interaction === 'mark') assert.deepEqual(view.tutorial.expected, { sector: 5, code: CODE[Obj.PLANET_X], markState: 'yes' });
    previousAction = action;
  });
});

test('bot private discoveries stay hidden and tutorial rooms do not share mutable game state', () => {
  const room = makeTutorial();
  const other = makeTutorial();
  const original = structuredClone(other);
  const snapshots = replay(room);
  for (const view of snapshots.filter((snapshot) => snapshot.phase !== 'done')) {
    const botLog = view.log.filter((entry) => entry.actorId !== room.hostId);
    for (const entry of botLog) {
      if (entry.type === 'target') assert.equal(entry.apparent, undefined);
      if (entry.type === 'survey') assert.equal(entry.count, undefined);
      if (entry.type === 'research') assert.equal(entry.text, undefined);
      if (entry.type === 'theory' && !entry.revealed) assert.equal(entry.objectType, undefined);
    }
    assert.equal(JSON.stringify(view).includes(room.players[1].token), false);
    assert.equal(view.tutorialState, undefined);
  }
  assert.deepEqual(other, original);
});

test('current tutorial guidance does not disclose a Bot verdict before its official review', () => {
  const room = makeTutorial();
  const snapshots = replay(room);
  const beforeReview = snapshots.find((view) => view.tutorial.stepId.endsWith(':bot-declare-fourth'));
  const paper = beforeReview.knowledge.theories.find((theory) => theory.sector === 7);
  assert.equal(paper.review, 'pending');
  assert.equal(paper.revealed, false);
  assert.doesNotMatch(JSON.stringify(beforeReview.tutorial), /错误|罚时/);
  const afterReview = snapshots.find((view) => view.tutorial.stepId.endsWith(':review-wrong'));
  assert.match(JSON.stringify(afterReview.tutorial), /错误/);
});
