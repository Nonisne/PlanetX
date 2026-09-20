import { h } from './dom.js';

export function renderDisclosure({ state, api, id, title, meta, open = false, className = '', heading = 'h2' }, ...children) {
  return h(
    'details',
    {
      class: `panel-disclosure ${className}`.trim(),
      'data-disclosure': id,
      open: state?.ui?.panels?.[id] ?? open,
      ontoggle: event => {
        const element = event.currentTarget;
        if (element.isConnected === false || !state?.ui || !api?.setUiQuiet) return;
        api.setUiQuiet({ panels: { ...state.ui.panels, [id]: element.open } });
      },
    },
    h('summary', {}, h(heading, { class: 'disclosure-title' }, title), meta ? h('span', { class: 'disclosure-meta' }, meta) : null),
    h('div', { class: 'disclosure-content' }, ...children),
  );
}
