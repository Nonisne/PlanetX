import { conferenceSectors, theorySectors } from './rules.js';

export function crossedEvents(mode, before, after) {
  const events = [];
  for (let time = before + 1; time <= after; time += 1) {
    const sector = (time % mode.sectors) + 1;
    if (theorySectors(mode).includes(sector)) events.push({ kind: 'theory', id: `theory:${time}`, time, sector });
    if (conferenceSectors(mode).includes(sector)) events.push({ kind: 'conference', id: `conference:${time}`, time, sector });
  }
  return events;
}
