import test from 'node:test';
import assert from 'node:assert/strict';
import { MODE_LIST, theoryTokenInventory } from '../public/src/rules.js';
import { Obj } from '../public/src/types.js';
import {
  consoleView,
  createConsole,
  recordTheory,
  theoryOptionsFor,
  theoryTokensRemaining,
} from '../public/src/console.js';

function publish(state, sector, type, phaseId = 'phase') {
  return recordTheory(state, { sector, type }, { enforceSchedule: false, phaseId });
}

test('standard and expert theory token inventories match the physical setup', () => {
  assert.deepEqual(theoryTokenInventory(MODE_LIST[0]), { asteroid: 4, comet: 2, gasCloud: 2, dwarfPlanet: 1 });
  assert.deepEqual(theoryTokenInventory(MODE_LIST[1]), { asteroid: 4, comet: 2, gasCloud: 2, dwarfPlanet: 4 });
});

test('standard dwarf inventory is exhausted after one paper and blocks further dwarf claims', () => {
  const state = createConsole({ modeId: 'standard' });
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 1);
  assert.equal(publish(state, 0, Obj.DWARF_PLANET).ok, true);
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 0);
  const blocked = publish(state, 4, Obj.DWARF_PLANET, 'later');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /矮行星理论标记已用完/);
  assert.equal(theoryOptionsFor(state, { phaseId: 'later' }).every((option) => !option.types.includes(Obj.DWARF_PLANET)), true);
  assert.equal(publish(state, 4, Obj.ASTEROID, 'later').ok, true);
});

test('wrong and correct papers both consume tokens and never return them', () => {
  const state = createConsole({ modeId: 'standard' });
  assert.equal(publish(state, 1, Obj.COMET).ok, true);
  assert.equal(publish(state, 2, Obj.COMET, 'second').ok, true);
  assert.equal(theoryTokensRemaining(state).comet, 0);
  const blocked = publish(state, 4, Obj.COMET, 'third');
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /彗星理论标记已用完/);
  const view = consoleView(state);
  assert.deepEqual(view.theoryTokensRemaining.comet, 0);
  assert.equal(view.theoryTokenInventory.comet, 2);
});

test('expert inventory allows four dwarf papers', () => {
  const state = createConsole({ modeId: 'expert' });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(publish(state, index, Obj.DWARF_PLANET, `phase-${index}`).ok, true, `paper ${index + 1}`);
  }
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 0);
  assert.equal(publish(state, 5, Obj.DWARF_PLANET, 'phase-extra').ok, false);
});

test('each actor has a private theory-token pool on a shared console log', () => {
  const state = createConsole({ modeId: 'standard' });
  state.actorId = 'alpha';
  assert.equal(publish(state, 0, Obj.DWARF_PLANET).ok, true);
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 0);
  state.actorId = 'beta';
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 1);
  assert.equal(publish(state, 4, Obj.DWARF_PLANET, 'beta-phase').ok, true);
  assert.equal(theoryTokensRemaining(state).dwarfPlanet, 0);
  state.actorId = 'alpha';
  assert.equal(consoleView(state).theoryTokensRemaining.dwarfPlanet, 0);
});
