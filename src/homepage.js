// Homepage section order and visibility (Admin → Homepage). The search hero always comes first.
// A section can also be limited to signed-in members (approved lawyers and admins).
import { getSettings, setSetting } from './db.js';

export const SECTIONS = {
  ad: 'Sponsored banner',
  areas: 'Browse by practice area',
  featured: 'Featured lawyers',
  how: 'How it works',
  guides: 'Legal guides',
  cta: '"Are you a lawyer?" box',
};

// Sections shown only to signed-in members unless the admin changes it.
const MEMBERS_ONLY_DEFAULT = new Set(['areas', 'featured', 'guides']);

/** Ordered sections as [{ id, label, visible, membersOnly }], including any added since the setting was saved. */
export function getSections() {
  let saved = [];
  try { saved = JSON.parse(getSettings().home_sections || '[]'); } catch { saved = []; }
  const make = (id, s = {}) => ({
    id, label: SECTIONS[id], visible: s.visible !== false,
    membersOnly: typeof s.membersOnly === 'boolean' ? s.membersOnly : MEMBERS_ONLY_DEFAULT.has(id),
  });
  const list = saved.filter((s) => SECTIONS[s.id]).map((s) => make(s.id, s));
  for (const id of Object.keys(SECTIONS)) if (!list.some((s) => s.id === id)) list.push(make(id));
  return list;
}

export function saveSections(order, visibleIds, membersOnlyIds = []) {
  const visible = new Set(visibleIds);
  const members = new Set(membersOnlyIds);
  const ids = order.filter((id) => SECTIONS[id]);
  for (const id of Object.keys(SECTIONS)) if (!ids.includes(id)) ids.push(id);
  setSetting('home_sections', JSON.stringify(ids.map((id) => ({ id, visible: visible.has(id), membersOnly: members.has(id) }))));
}
