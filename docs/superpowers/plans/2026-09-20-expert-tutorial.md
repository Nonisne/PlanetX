# Expert and Tutorial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Preserve pre-existing changes. Do not commit, create branches, or restart live services.

**Goal:** Implement the approved expert built-in mode, host-controlled setup, persistent conference headings, record-mode corrections, and a complete scripted two-player tutorial.

**Architecture:** Extend the puzzle engine independently; room rules remain the authority for both modes. A server-only tutorial orchestrator calls normal room actions and exposes only current-step guidance. The DOM consumes public conference metadata and a narrow tutorial projection.

**Tech Stack:** JavaScript ES modules, Node HTTP/SSE, DOM/SVG and `node:test`; no new dependencies.

**Status (2026-09-21):** Implementation, spec review, independent code-quality review and available pure/in-memory verification are complete. Real-socket and browser checks remain explicitly blocked below. Delivery details: `docs/expert-tutorial-report-2026-09-21.md`.

## Task 1: Expert engine

Files: `server/puzzles.js`, `server/research.js`, new expert engine helper if needed; `tests/puzzles.test.js`, `tests/research.test.js`, new expert puzzle tests.

- [x] Add failing tests for 18-object inventory, exact six-sector dwarf band with dwarf endpoints, seven prime comet sectors, two true conferences and all observation-equivalent alternatives.
- [x] Implement bounded expert generation and per-mode validation without allocating all expert boards at room creation. Add public conference names to both modes.
- [x] Keep standard sampling and exact solver semantics; run both targeted engine suites and existing standard exhaustive certification.

```js
const puzzle = createPuzzle({ modeId: 'expert', random: seeded });
assert.equal(validateBoard(puzzle.objects), true);
assert.deepEqual(Object.keys(puzzle.conferences), ['7', '16']);
assert.equal(initialCluesFor(puzzle, { count: 12 }).length, 12);
```

## Task 2: Host configuration and record parity

Files: `public/src/room.js`, `server.mjs`, `public/ui/app.js`, `public/src/online.js`; room, builtin, client, server and official-rule tests.

- [x] Test host-only lobby changes, strict counts, automatic built-in delivery, fixed-count record setup, and no mutation on invalid record exclusions.
- [x] Add `initialClueCount`, `conferenceNames` and lobby count action; deal built-in cards on start and make old claim requests idempotent-only.
- [x] Move all initial marking behind authoritative accepted views and test failed requests, refresh, resubmission removal and isolation.
- [x] Parameterize old zero-clue fixtures explicitly; cover both record board sizes and preserve departure/review/turn behavior.

```js
const room = createRoom({ initialClueCount: 8 });
assert.equal(applyRoomAction(room, guest.id, { kind: 'set-initial-clue-count', count: 4 }).ok, false);
assert.equal(applyRoomAction(room, room.hostId, { kind: 'set-initial-clue-count', count: 4 }).ok, true);
```

## Task 3: Sidebar, setup and tutorial surfaces

Files: `public/ui/panels.js`, `public/ui/notesheet.js`, `public/ui/board.js`, new `public/ui/tutorial.js`, `public/styles.css`; `tests/ui.smoke.test.js` and focused UI tests.

- [x] Test expert availability, always-present conference headings without unrevealed text, host controls and player read-only count display.
- [x] Render the approved tutorial view and three callbacks without adding rule logic to the UI; implement current-target highlights and narrow-screen control styles. Real-browser validation remains pending below.
- [x] Update setup copy and exact-count manual rows; test accessible progress, wrong-step controls, completed tutorial and no hidden Bot data. The 28 focused and 78 smoke UI tests pass, including record conference corrections.

```js
const guide = renderTutorialGuide({ game, api });
assert.match(collectText(guide).join(''), game.tutorial.title);
assert.doesNotMatch(collectText(guide).join(''), hiddenBotResult);
```

## Task 4: Scripted tutorial runtime and integration

Files: new `server/tutorial.js`, `server.mjs`, `public/src/room.js`, `public/src/online.js`, `public/ui/app.js`; new `tests/tutorial.test.js`, HTTP and client tests, `tests/all.test.js`.

- [x] Validate the fixed board and six research statements; write a full failing room-action replay before adding the orchestrator.
- [x] Use normal room actions for setup, 4/4/1/4-cost Bot moves, all declarations/submissions, automatic reviews/conference and final pass.
- [x] Expose only current-step view; reject stale step ids, wrong actors, out-of-step actions, joins and private Bot credentials without mutating time or quota.
- [x] Integrate real map inspection/marking, tutorial continue and entry; save/restore the original room identity and notes on exit and isolate restart.
- [x] Verify full lesson, correct and incorrect inputs, refresh/restore, final score and server-only secret routing through HTTP/SSE handlers using in-memory dispatch; real sockets remain pending environment approval.
- [x] Cover cancellation and stale entry responses without blocking newer navigation; recover accepted human marks after response loss without exposing future guidance, weakening replay checks or restoring later manual clears.

```js
const before = JSON.stringify(room);
assert.equal(applyTutorialAction(room, human.id, { kind: 'tutorial-next', stepId: 'stale' }).ok, false);
assert.equal(JSON.stringify(room), before);
```

## Task 5: Review and delivery

- [x] Review integration against the spec, then run independent code-quality reviews of engine, main integration and UI; address and re-review introduced issues.
- [x] Run all 21 non-launcher suites with `PUZZLE_EXHAUSTIVE=1 PLANETX_TEST_TRANSPORT=memory`: 458 passed, 0 failed, 0 skipped. Check syntax of 48 JavaScript files and run `git diff --check`; retain evidence in `audit/evidence/expert-tutorial-memory-tests-2026-09-21.txt`.
- [ ] **Blocked — real sockets:** Run `PUZZLE_EXHAUSTIVE=1 node tests/all.test.js` and `PLANETX_TEST_TRANSPORT=http node tests/tutorial-server.test.js` once local-listener approval is available. The escalation did not execute because approval infrastructure was unavailable; this run excludes the launcher suite and does not overwrite its historical intermittent failure.
- [ ] **Blocked — browser authentication:** Play through a tutorial and an expert room on an isolated service, including narrow viewport and public/private sidebar checks. Browser setup returned `Codex auth token is unavailable`; static/DOM checks are not a substitute for screenshots or real interactions.
- [x] Update README and delivery report, close owned review agents, and document safe restart after existing games end. No new QA service/tab or viewport change was made, so there is none to clean up; live services and existing workspace changes are preserved.
