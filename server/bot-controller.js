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
 * @returns {Function} a teardown function that stops the controller
 */
export function attachBotController(room, { tickMs = DEFAULT_TICK_MS } = {}) {
  if (!room) return () => {};
  if (room.__botController) return room.__botController.teardown;

  const controller = { room, tickMs, timer: null, busy: false, teardown: null };

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
      stepBots(room);
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
function stepBots(room) {
  if (!room || room.tutorialState) return; // the tutorial script runs its own bot
  const bots = botPlayers(room);
  if (!bots.length) return;

  for (const bot of bots) {
    if (!room.players.includes(bot)) continue;
    tickBot(room, bot);
  }
}

function tickBot(room, bot) {
  if (room.phase === 'lobby' || room.phase === 'setup') {
    const view = viewFor(room, bot.id);
    const setupAction = decideAction(room, bot.id, view);
    if (setupAction) applyRoomAction(room, bot.id, setupAction);
    return;
  }
  if (room.phase === 'final' || room.phase === 'reveal' || room.phase === 'done') {
    const view = viewFor(room, bot.id);
    const action = decideAction(room, bot.id, view);
    if (action) applyRoomAction(room, bot.id, action);
    return;
  }
  // play phase: only act when it is the bot's turn (or there is a research phase)
  if (!room.research && !viewIsMyTurn(room, bot.id)) return;
  const view = viewFor(room, bot.id);
  const action = decideAction(room, bot.id, view);
  if (!action) return;
  const result = applyRoomAction(room, bot.id, action);
  // a transient refusal is fine — the engine enforces turn order / cooldown,
  // so the next tick will retry when conditions allow
  if (!result.ok && process.env.BOT_DEBUG) {
    // eslint-disable-next-line no-console
    console.log(`[bot] ${bot.name} refused ${action.kind}: ${result.error}`);
  }
}

/** True when it is the bot's normal turn (the engine's currentPlayer is the bot). */
function viewIsMyTurn(room, botId) {
  const view = viewFor(room, botId);
  return Boolean(view && view.isMyTurn);
}
