# Official Rules Repair Implementation Plan

> Execute inline with the executing-plans and test-driven-development workflows. The user approved the three-part repair plan from the rules audit. Do not create a Git repository, commit, replace the framework, or change existing recorded time costs.

**Goal:** Correct all 16 reproduced audit findings and provide usable final-scoring and object-reveal workflows.

**Architecture:** Keep rules and serializable game state outside the DOM. Share crossing arithmetic and theory validation between local and room modes. Add explicit final-opportunity and reveal stages to the room model; keep each locate private until the final reveal. Use immutable publication-phase identifiers for simultaneous leader bonuses. The final board is entered from the official app, not generated or solved here.

**Tech Stack:** Existing JavaScript ES modules, Node HTTP/SSE, DOM/SVG and node:test; no new dependencies.

## Approved design

- Official time-track costs are survey 4/3/2, target 4, research 1, locate 5. Display units remain months.
- Research checks the player's last time-consuming action, ignoring other players and free records.
- Every theory phase advances pending papers once, including zero-submission phases. Revealed incorrect claims are public and penalties are applied exactly once, including claims disproved by another correct paper.
- Duplicate claims and same-phase conflicting claims are rejected. All claims from the same phase share a publication identifier for leader scoring.
- A failed locate continues play and can cross events. A correct locate freezes the sky and pawn positions after paying 5, then enters final opportunities. Eligible players choose one final locate, up to their allowed theories, or pass. Final opportunities cost zero time.
- Only after final opportunities may the host enter the full object list from the official app. All outstanding papers are checked without penalties, then final scores and tie-breaks are shown.
- Single-player recording retains its identity as a record console, not the official bot mode. Crossed theory phases remain pending until explicitly completed, including no-paper phases; final reveal is available locally.
- Persist new local phase/reveal fields. Restore old records unchanged; explain that a fresh game is required for a fully official-cost game.

## Task 1 — Costs, restrictions and privacy

- [x] Run the existing independent audit as the red baseline: `node audit/official-rules.audit.mjs` (16 mismatches expected).
- [x] Add regression tests for exact costs, comet endpoints, own consecutive research, failed locates and locate redaction.
- [x] Update `public/src/rules.js`, `public/src/console.js`, `public/src/room.js`.
- [x] Run `node tests/official-rules.test.js`; verify the new assertions rather than copying implementation-derived expectations.

## Task 2 — Theory phases and scoring

- [x] Add phase-crossing, zero-declaration, duplicate/conflicting paper, review privacy, inferred penalty, duplicate request and simultaneous bonus tests.
- [x] Add shared crossing helpers in `public/src/phases.js`; preserve serializable phase IDs and local pending phases in the engine.
- [x] Update room phase completion, review sequencing and `public/src/score.js` tie-breaking.
- [x] Re-run the focused suite and audit; update obsolete tests whose fixtures assumed incorrect costs or implicit phase completion.

## Task 3 — Final opportunities and reveal

- [x] Add tests for frozen clocks/window, one final action per eligible player, atomic final papers, private guesses, reveal permissions and complete final scoring.
- [x] Add final state and actions (`locate`, `final-theories`, `final-pass`, `reveal-objects`) to `public/src/room.js`; implement shared reveal validation in the record engine.
- [x] Add a focused `public/ui/endgame.js` panel for final opportunities and host/local reveal input. Update the app's local persistence and actions.
- [x] Add UI and real HTTP/SSE tests; verify no secret fields leak through snapshots or log descriptions.

## Task 4 — Integration and evidence

- [x] Update affected original tests, retain their original behavioral coverage, and add the new suite to `tests/all.test.js`.
- [x] Update README and in-app rule descriptions, including legacy-save boundaries.
- [x] Run `node tests/all.test.js` and `node audit/official-rules.audit.mjs --json audit/evidence/rule-checks-after.json`.
- [x] Use an isolated local server for desktop/two-client browser checks and screenshots, then close it.
- [x] Review changes and report exact test results and any remaining limitations; do not claim complete official bot support or server persistence.

## Completion evidence — 2026-09-20

All 177 regression tests and all 23 independent audit checks pass. Independent review added fixes for FIFO phase scheduling, ordered/batched peer review, stale phase requests, sparse reveal arrays and contradictory historical verdicts. Browser checks cover two clients through failed locate, queued theories, zero submissions, private final opportunities, atomic final papers, host-only reveal, shared leader scoring and refresh recovery. See `docs/rules-fix-report-2026-09-20.md` for exact coverage, evidence and retained product boundaries.
