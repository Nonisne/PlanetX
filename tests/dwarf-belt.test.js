import test from 'node:test';
import assert from 'node:assert/strict';
import { CODE } from '../public/src/types.js';
import {
  DWARF_BELT_HINT_TEXT,
  bandSectors,
  dwarfBandConflict,
  dwarfBandCoverage,
  possibleDwarfBands,
} from '../public/src/dwarf-belt.js';
import { MODE_LIST } from '../public/src/rules.js';
import { createConsole, consoleView } from '../public/src/console.js';

function note(sector, state) {
  return { [`${sector}:${CODE.dwarfPlanet}`]: state };
}

function makeEl(tag) {
  return {
    nodeType: 1,
    tagName: tag,
    children: [],
    attributes: {},
    style: {},
    className: '',
    textContent: '',
    append(...kids) {
      for (const kid of kids) this.children.push(kid);
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
      if (key === 'class') this.className = value;
    },
    getAttribute(key) {
      return this.attributes[key];
    },
    addEventListener() {},
  };
}

globalThis.document = {
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
};
globalThis.window = globalThis;


function collectText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  return (node.children || []).map(collectText).join('');
}

function findClass(node, className, out = []) {
  if (node?.nodeType === 1) {
    if ((node.className || '').split(/\s+/).includes(className)) out.push(node);
    for (const child of node.children || []) findClass(child, className, out);
  }
  return out;
}

test('every expert start is a candidate band before any marks', () => {
  const bands = possibleDwarfBands({}, 18);
  assert.equal(bands.length, 18);
  assert.deepEqual(bandSectors(16, 18), [16, 17, 0, 1, 2, 3]);
  assert.equal(dwarfBandConflict({}, 16), null);
  assert.ok(DWARF_BELT_HINT_TEXT.length >= 2);
});

test('confirming a dwarf outside a band eliminates that band', () => {
  const notes = note(10, 'yes');
  assert.match(dwarfBandConflict(notes, 0), /11 号/);
  assert.equal(dwarfBandConflict(notes, 5), null);
  const bands = possibleDwarfBands(notes);
  assert.equal(bands.every((band) => band.sectors.includes(10)), true);
  assert.equal(bands.some((band) => band.start === 0), false);
});

test('ruling out an endpoint eliminates bands that need it', () => {
  const notes = note(0, 'no');
  assert.match(dwarfBandConflict(notes, 0), /端点/);
  assert.match(dwarfBandConflict(notes, 13), /端点/);
  assert.equal(dwarfBandConflict(notes, 1), null);
});

test('too many confirmed dwarfs or too many exclusions make a band impossible', () => {
  const tooMany = { ...note(0, 'yes'), ...note(1, 'yes'), ...note(2, 'yes'), ...note(3, 'yes'), ...note(4, 'yes') };
  assert.match(dwarfBandConflict(tooMany, 0), /超过 4/);
  const tooFew = { ...note(1, 'no'), ...note(2, 'no'), ...note(3, 'no') };
  assert.match(dwarfBandConflict(tooFew, 0), /不足 4/);
});

test('coverage marks only sectors that remain in some possible band', () => {
  const notes = { ...note(0, 'yes'), ...note(5, 'yes'), ...note(10, 'no') };
  const coverage = dwarfBandCoverage(notes);
  assert.equal(coverage.has(0), true);
  assert.equal(coverage.has(5), true);
  assert.equal(coverage.has(10), false);
});

test('record-mode expert board soft-highlights remaining dwarf-band sectors', async () => {
  const { renderBoard } = await import('../public/ui/board.js');
  const session = createConsole({ modeId: 'expert' });
  const game = { ...consoleView(session), playMode: 'record', players: [] };
  const notes = { ...note(0, 'yes'), ...note(5, 'yes') };
  const board = renderBoard({ game, ui: { action: null, pick: [] }, notes, onSector() {}, onMark() {} });
  const highlighted = findClass(board, 'dwarf-band')
    .filter((node) => node.tagName === 'path')
    .map((node) => {
      let current = node;
      while (current && current.attributes?.['data-sector'] === undefined) current = current.parent;
      // walk children tree parents via search
      return null;
    });
  const sectors = [];
  function walk(node, parentSector = null) {
    if (!node || node.nodeType !== 1) return;
    const sector = node.attributes?.['data-sector'] !== undefined ? Number(node.attributes['data-sector']) : parentSector;
    if ((node.className || '').split(/\s+/).includes('dwarf-band') && node.tagName === 'path' && Number.isInteger(sector)) {
      sectors.push(sector);
    }
    for (const child of node.children || []) walk(child, sector);
  }
  walk(board);
  assert.ok(sectors.includes(0));
  assert.ok(sectors.includes(5));
  assert.equal(sectors.includes(10), false);
});

test('knowledge panel shows the dwarf-belt helper and token meter for expert boards', async () => {
  const { renderKnowledgePanel } = await import('../public/ui/panels.js');
  const session = createConsole({ modeId: 'expert' });
  const state = {
    game: {
      ...consoleView(session),
      playMode: 'record',
      mode: MODE_LIST[1],
      knowledge: { clues: [], theories: [], conferences: [], targets: [], surveys: [] },
      mySetup: { clues: [] },
      theoryTokenInventory: consoleView(session).theoryTokenInventory,
      theoryTokensRemaining: consoleView(session).theoryTokensRemaining,
    },
    notes: note(0, 'yes'),
    ui: { disclosures: { knowledge: true, rules: true } },
    remote: null,
  };
  const panel = renderKnowledgePanel({
    state,
    api: { setUi() {}, toggleDisclosure() {}, setDisclosure() {} },
  });
  const text = collectText(panel);
  assert.match(text, /矮行星带辅助/);
  assert.match(text, /实体理论标记/);
  assert.match(text, /端点/);
});
