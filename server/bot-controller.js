// Bot controller: schedules bot turns in a live room.
//
// Each bot is attached to a room when it joins. A `setInterval` ticks every
// `tickMs` (default 3000ms) and, for every bot whose turn it is, decides one
// action and applies it. Multiple bots in the same room each get their own
// decision loop, so a 3-bot room still works: bots take turns naturally.
//
// The controller exposes `attachBotController(room)` and
// `detachBotController(room)`. Both are idempotent and safe to call from
// `restoreRoom`, `hydrateRoom`, and the server's room GC.
//
// All state mutation goes through `applyRoomAction` so the existing rules
// (turn order, research phase, peer review, etc.) stay authoritative.

import { applyRoomAction, viewFor } from '../public/src/room.js';
import { decideAction } from './bot.js';

const DEFAULT_TICK_MS = 3000;

function botPlayers(room) {
  if (!room || !Array.isArray(room.players)) return [];
  return room.players.filter((player) => player && player.bot);
}

/**
 * Start the controller for `room` if it is not already running.
 *
 * @param {object} room       the live room
 * @param {object} [options]
 * @param {number} [options.tickMs] override the default 3000ms decision interval
 * @param {Function} [options.onApplied] called after a successful bot action
 *   so the host server can bump revision and SSE-broadcast
 * @returns {Function} a teardown function that stops the controller
 */
export function attachBotController(room, { tickMs = DEFAULT_TICK_MS, onApplied } = {}) {
  if (!room) return () => {};
  if (room.__botController) {
    if (typeof onApplied === 'function') room.__botController.onApplied = onApplied;
    return room.__botController.teardown;
  }

  const controller = { room, tickMs, timer: null, busy: false, teardown: null, onApplied: typeof onApplied === 'function' ? onApplied : null };

  controller.teardown = () => {
    if (controller.timer) {
      clearInterval(controller.timer);
      controller.timer = null;
    }
    if (room.__botController === controller) room.__botController = null;
  };

  controller.timer = setInterval(() => {
    if (controller.busy) return;
    controller.busy = true;
    try {
      stepBots(room, controller);
    } catch (error) {
      // never let a bot crash the server — log to stderr and keep ticking
      // eslint-disable-next-line no-console
      console.error('[bot] tick failed:', error && error.message ? error.message : error);
    } finally {
      controller.busy = false;
    }
  }, tickMs);
  // never keep the process alive solely because of bots
  controller.timer.unref?.();

  room.__botController = controller;
  return controller.teardown;
}

/** Stop and detach the controller from `room`, if any. */
export function detachBotController(room) {
  if (room && room.__botController && room.__botController.teardown) {
    room.__botController.teardown();
  }
}

/**
 * Run one decision round: every bot that should act does so.
 *
 * We intentionally iterate through `botPlayers(room)` rather than the
 * "current player" loop because the bots may be interleaved with humans, and
 * a single tick may need to step more than one bot forward (e.g. when a
 * human has been waiting and the laggard changes).
 */
function stepBots(room, controller) {
  if (!room || room.playMode !== 'builtin' || room.tutorialState) return;
  const bots = botPlayers(room);
  if (!bots.length) return;

  for (const bot of bots) {
    if (!room.players.includes(bot)) continue;
    tickBot(room, bot, controller);
  }
}

function tickBot(room, bot, controller) {
  if (room.phase === 'lobby') return;

  const view = viewFor(room, bot.id);
  if (room.phase === 'play') {
    const needsOffTurn = Boolean(room.research) || Boolean(view.myPendingReviews?.length);
    if (!needsOffTurn && !view.isMyTurn) return;
  }

  const action = decideAction(room, bot.id, view);
  if (!action) return;
  const result = applyRoomAction(room, bot.id, action);
  if (result.ok) {
    controller?.onApplied?.(room, bot, action, result);
    return;
  }
  // a transient refusal is fine — the engine enforces turn order / cooldown,
  // so the next tick will retry when conditions allow
  if (process.env.BOT_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[bot] ${bot.name} refused ${action.kind}: ${result.error}`);
  }
}
