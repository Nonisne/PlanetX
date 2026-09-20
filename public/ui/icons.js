// Vector icons for the six astronomical objects, drawn in a 24x24 box so they can
// be scaled to any size (star map marks, note sheet rows, buttons, result screen).
import { h, s } from './dom.js';
import { CODE, CODE_TO_TYPE } from '../src/types.js';
import { TYPE_COLOR } from './theme.js';

const CRATER = 'rgba(6,10,21,0.85)';

const SHAPES = {
  // irregular rock with craters
  [CODE.asteroid]: (c) => [
    { tag: 'path', attrs: { d: 'M12 3.4 18.8 6.1 20.6 12.7 17.1 19.5 9.1 20.8 3.8 15.4 4.6 7.9Z', fill: c } },
    { tag: 'circle', attrs: { cx: 9.6, cy: 10, r: 1.85, fill: CRATER } },
    { tag: 'circle', attrs: { cx: 15.4, cy: 14.4, r: 1.25, fill: CRATER } },
  ],
  // bright nucleus with a tail
  [CODE.comet]: (c) => [
    { tag: 'path', attrs: { d: 'M2.6 20.6 12.6 10.2', stroke: c, 'stroke-width': 2.5, 'stroke-linecap': 'round', opacity: 0.5, fill: 'none' } },
    { tag: 'path', attrs: { d: 'M4.8 14.6 9.8 9.2', stroke: c, 'stroke-width': 1.6, 'stroke-linecap': 'round', opacity: 0.36, fill: 'none' } },
    { tag: 'circle', attrs: { cx: 15.2, cy: 8.8, r: 4.9, fill: c } },
  ],
  // puffy cloud
  [CODE.gasCloud]: (c) => [
    { tag: 'circle', attrs: { cx: 8.2, cy: 14.3, r: 3.5, fill: c } },
    { tag: 'circle', attrs: { cx: 13.4, cy: 12, r: 4.6, fill: c } },
    { tag: 'circle', attrs: { cx: 17.5, cy: 14.9, r: 2.9, fill: c } },
    { tag: 'rect', attrs: { x: 5.5, y: 13.6, width: 13.2, height: 4.8, rx: 2.4, fill: c } },
  ],
  // round body with a ring
  [CODE.dwarfPlanet]: (c) => [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 5.3, fill: c } },
    { tag: 'ellipse', attrs: { cx: 12, cy: 12, rx: 10.3, ry: 3.3, fill: 'none', stroke: c, 'stroke-width': 1.5, opacity: 0.85, transform: 'rotate(-18 12 12)' } },
  ],
  // dashed hollow circle: nothing there
  [CODE.empty]: (c) => [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 7.3, fill: 'none', stroke: c, 'stroke-width': 1.7, 'stroke-dasharray': '3.4 3.2' } },
  ],
  // faint disc crossed out: the hidden planet
  [CODE.planetX]: (c) => [
    { tag: 'circle', attrs: { cx: 12, cy: 12, r: 7.9, fill: c, 'fill-opacity': 0.22, stroke: c, 'stroke-width': 1.5 } },
    { tag: 'path', attrs: { d: 'M8.6 8.6 15.4 15.4M15.4 8.6 8.6 15.4', stroke: c, 'stroke-width': 2.5, 'stroke-linecap': 'round', fill: 'none' } },
  ],
};

function shapesFor(code, color) {
  const factory = SHAPES[code];
  return factory ? factory(color || TYPE_COLOR[code]) : [];
}

function iconClass(code) {
  return `icon icon-${CODE_TO_TYPE[code] || code}`;
}

/** A standalone <svg> icon element of the given size (top-left at 0,0). */
export function iconEl(code, size, color) {
  const el = s('svg', { x: 0, y: 0, width: size, height: size, viewBox: '0 0 24 24', class: iconClass(code), 'aria-hidden': 'true', focusable: 'false' });
  for (const shape of shapesFor(code, color)) el.append(s(shape.tag, shape.attrs));
  return el;
}

/**
 * An icon group centred on (cx, cy) — handy inside a bigger SVG.
 * `struck` draws a red slash over it ("this object is not here"), `onclick` makes it
 * clickable via an invisible hit circle (SVG groups have no hit area of their own).
 */
export function iconAt(code, size, cx, cy, { color, className = '', halo = false, struck = false, onclick = null, title = null } = {}) {
  const g = s('g', { class: `icon-wrap ${className}`.trim() });
  if (title) g.append(s('title', {}, title));
  if (halo) g.append(s('circle', { cx, cy, r: size * 0.68, class: 'icon-halo', stroke: color || TYPE_COLOR[code] }));
  const el = s('svg', { x: cx - size / 2, y: cy - size / 2, width: size, height: size, viewBox: '0 0 24 24', class: iconClass(code), 'aria-hidden': 'true', focusable: 'false' });
  for (const shape of shapesFor(code, color)) el.append(s(shape.tag, shape.attrs));
  g.append(el);
  if (struck) {
    const r = size * 0.42;
    g.append(s('path', { d: `M${cx - r} ${cy - r} L${cx + r} ${cy + r} M${cx + r} ${cy - r} L${cx - r} ${cy + r}`, class: 'icon-strike' }));
  }
  if (onclick) {
    g.setAttribute('class', `${g.getAttribute('class')} clickable`.trim());
    g.append(s('circle', { cx, cy, r: size * 0.55, class: 'icon-hit', onclick }));
  }
  return g;
}

/** An icon plus a text label, for buttons and lists. */
export function iconLabel(code, label, { size = 15, color } = {}) {
  return h('span', { class: 'icon-label' }, h('span', { class: 'icon-holder' }, iconEl(code, size, color)), h('span', { class: 'icon-text' }, label));
}

export { TYPE_COLOR };
