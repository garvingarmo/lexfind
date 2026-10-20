// Homepage section order and visibility (Admin → Homepage). The search hero always comes first.
import { getSettings, setSetting } from './db.js';

export const SECTIONS = {
  ad: 'Sponsored banner',
  areas: 'Browse by practice area',
  featured: 'Featured lawyers',
  how: 'How it works',
  guides: 'Legal guides',
  cta: '"Are you a lawyer?" box',
};

/** Ordered sections as [{ id, label, visible }], including any added since the setting was saved. */
export function getSections() {
  let saved = [];
  try { saved = JSON.parse(getSettings().home_sections || '[]'); } catch { saved = []; }
  const list = saved.filter((s) => SECTIONS[s.id]).map((s) => ({ id: s.id, label: SECTIONS[s.id], visible: s.visible !== false }));
  for (const id of Object.keys(SECTIONS)) if (!list.some((s) => s.id === id)) list.push({ id, label: SECTIONS[id], visible: true });
  return list;
}

export function saveSections(order, visibleIds) {
  const visible = new Set(visibleIds);
  const ids = order.filter((id) => SECTIONS[id]);
  for (const id of Object.keys(SECTIONS)) if (!ids.includes(id)) ids.push(id);
  setSetting('home_sections', JSON.stringify(ids.map((id) => ({ id, visible: visible.has(id) }))));
}
