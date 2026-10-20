// Query helpers shared by the web routes and the AI agent.
import { db, tx, uniqueSlug, slugify } from './db.js';
import { LAWYER_SOCIAL_KEYS, normalizeSocial } from './social.js';
import { normalizeLanguages } from './languages.js';

export const LAWYER_FIELDS = [
  'name', 'firm', 'title', 'bio', 'email', 'phone', 'website', 'address', 'city', 'state', 'zip',
  'bar_number', 'bar_admissions', 'years_experience', 'languages', 'education',
  'social_linkedin', 'social_facebook', 'social_instagram', 'social_x', 'social_youtube', 'social_tiktok',
];

/**
 * Practice areas with lawyer counts, in tree order: each main category followed by its sub-categories.
 * `lawyer_count` counts active lawyers in the area itself, `total_count` all of its lawyers, and
 * `group_count` active lawyers in the area or any of its sub-categories. Each row also has `depth`
 * (0 main, 1 sub-category), `parent_name`, `children` (sub-category names) and `label` (indented for menus).
 * withLawyersOnly hides areas no active lawyer is listed under (for the public site and the AI assistant);
 * a main category stays when one of its sub-categories has lawyers.
 */
const AREA_ORDER = 'pa.sort_order IS NULL, pa.sort_order, pa.name COLLATE NOCASE';

export function listAreas({ withLawyersOnly = false } = {}) {
  const rows = db.prepare(`
    SELECT pa.*, parent.name AS parent_name,
      (SELECT COUNT(*) FROM lawyer_practice_areas lpa JOIN lawyers l ON l.id = lpa.lawyer_id
       WHERE lpa.area_id = pa.id AND l.status = 'active') AS lawyer_count,
      (SELECT COUNT(*) FROM lawyer_practice_areas lpa WHERE lpa.area_id = pa.id) AS total_count,
      (SELECT COUNT(DISTINCT lpa.lawyer_id) FROM lawyer_practice_areas lpa JOIN lawyers l ON l.id = lpa.lawyer_id
       JOIN practice_areas x ON x.id = lpa.area_id
       WHERE (x.id = pa.id OR x.parent_id = pa.id) AND l.status = 'active') AS group_count
    FROM practice_areas pa LEFT JOIN practice_areas parent ON parent.id = pa.parent_id
    ORDER BY ${AREA_ORDER}`).all();
  const visible = withLawyersOnly ? rows.filter((a) => a.group_count > 0) : rows;
  const ids = new Set(visible.map((a) => a.id));
  const tops = visible.filter((a) => !a.parent_id || !ids.has(a.parent_id));
  const out = [];
  for (const top of tops) {
    const subs = top.parent_id ? [] : visible.filter((a) => a.parent_id === top.id);
    out.push({ ...top, depth: 0, children: subs.map((c) => c.name), label: top.name });
    for (const c of subs) out.push({ ...c, depth: 1, children: [], label: `\u2003${c.name}` });
  }
  return out;
}

/** Main categories only (areas that are not a sub-category), for "sub-category of" menus. */
export function mainAreas() {
  return db.prepare(`SELECT * FROM practice_areas pa WHERE parent_id IS NULL ORDER BY ${AREA_ORDER}`).all();
}

/**
 * Save the organiser's arrangement: [{ id, children: [id, …] }, …] in display order. Areas listed at
 * the top level become main categories, children become their sub-categories. Areas not mentioned keep
 * their place. Returns an error message, or null when saved.
 */
export function saveAreaTree(tree) {
  if (!Array.isArray(tree)) return 'Nothing to save.';
  const exists = new Set(db.prepare('SELECT id FROM practice_areas').all().map((a) => a.id));
  const seen = new Set();
  const plan = [];
  for (const node of tree) {
    const id = Number(node?.id);
    if (!exists.has(id) || seen.has(id)) continue;
    seen.add(id);
    const children = [];
    for (const c of Array.isArray(node.children) ? node.children : []) {
      const cid = Number(c);
      if (!exists.has(cid) || seen.has(cid)) continue;
      seen.add(cid);
      children.push(cid);
    }
    plan.push({ id, children });
  }
  // One level only: an area with sub-categories can't itself be placed under another.
  const parents = new Set(plan.filter((n) => n.children.length).map((n) => n.id));
  if (plan.some((n) => n.children.some((c) => parents.has(c)))) return 'An area with sub-categories cannot be moved under another area.';
  tx(() => {
    const set = db.prepare('UPDATE practice_areas SET parent_id = ?, sort_order = ? WHERE id = ?');
    plan.forEach((n, i) => {
      set.run(null, i, n.id);
      n.children.forEach((c, j) => set.run(n.id, j, c));
    });
  });
  return null;
}

/**
 * Make an area a sub-category of another (or a main category when parentId is empty).
 * Only one level deep: the parent must be a main category, and an area with sub-categories can't move under another.
 * Returns an error message, or null when saved.
 */
export function setAreaParent(id, parentId) {
  id = Number(id);
  parentId = Number(parentId) || null;
  if (parentId) {
    if (parentId === id) return 'An area cannot be a sub-category of itself.';
    const parent = db.prepare('SELECT * FROM practice_areas WHERE id = ?').get(parentId);
    if (!parent) return 'That main category no longer exists.';
    if (parent.parent_id) return `"${parent.name}" is itself a sub-category, so it cannot have sub-categories.`;
    if (db.prepare('SELECT 1 FROM practice_areas WHERE parent_id = ?').get(id)) return 'This area has its own sub-categories, so it must stay a main category.';
  }
  // A newly grouped area goes to the end of its new list.
  db.prepare('UPDATE practice_areas SET sort_order = CASE WHEN parent_id IS ? THEN sort_order ELSE NULL END, parent_id = ? WHERE id = ?').run(parentId, parentId, id);
  return null;
}

/** Move every lawyer from one practice area to another, then delete the first. */
export function mergeAreas(fromId, intoId) {
  if (Number(fromId) === Number(intoId)) return;
  tx(() => {
    db.prepare('INSERT OR IGNORE INTO lawyer_practice_areas (lawyer_id, area_id) SELECT lawyer_id, ? FROM lawyer_practice_areas WHERE area_id = ?').run(intoId, fromId);
    // Sub-categories of the merged area move under the area it was merged into (if that is a main category).
    const into = db.prepare('SELECT parent_id FROM practice_areas WHERE id = ?').get(intoId);
    db.prepare('UPDATE practice_areas SET parent_id = ? WHERE parent_id = ?').run(into?.parent_id ? null : intoId, fromId);
    db.prepare('DELETE FROM practice_areas WHERE id = ?').run(fromId);
  });
}

/** Delete practice areas that no lawyer (in any status) is listed under, keeping main categories that still have sub-categories. Returns how many. */
export function deleteUnusedAreas() {
  const del = db.prepare(`DELETE FROM practice_areas WHERE id NOT IN (SELECT DISTINCT area_id FROM lawyer_practice_areas)
    AND id NOT IN (SELECT parent_id FROM practice_areas WHERE parent_id IS NOT NULL)`);
  // Twice: removing empty sub-categories can leave their main category empty too.
  return del.run().changes + del.run().changes;
}

export function areasFor(lawyerId) {
  return db.prepare(`SELECT pa.* FROM practice_areas pa JOIN lawyer_practice_areas lpa ON lpa.area_id = pa.id
                     WHERE lpa.lawyer_id = ? ORDER BY pa.name`).all(lawyerId);
}

export function setAreas(lawyerId, areaIds) {
  const ids = [...new Set((areaIds || []).map(Number).filter(Boolean))];
  tx(() => {
    db.prepare('DELETE FROM lawyer_practice_areas WHERE lawyer_id = ?').run(lawyerId);
    const ins = db.prepare('INSERT OR IGNORE INTO lawyer_practice_areas (lawyer_id, area_id) VALUES (?, ?)');
    for (const id of ids) ins.run(lawyerId, id);
  });
}

function attachAreas(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const links = db.prepare(`SELECT lpa.lawyer_id, pa.name, pa.slug FROM lawyer_practice_areas lpa
    JOIN practice_areas pa ON pa.id = lpa.area_id WHERE lpa.lawyer_id IN (${ids.map(() => '?').join(',')})
    ORDER BY pa.name`).all(...ids);
  const by = new Map(ids.map((id) => [id, []]));
  for (const l of links) by.get(l.lawyer_id).push({ name: l.name, slug: l.slug });
  for (const r of rows) r.areas = by.get(r.id);
  return rows;
}

/**
 * Search active lawyers. Every filter is optional.
 * Returns { rows, total } — featured (sponsored) listings sort first.
 */
// Search result orderings. "relevance" (best match) is also what the AI assistant uses.
export const SORTS = {
  relevance: 'l.verified DESC, l.years_experience IS NULL, l.years_experience DESC, l.sort_name',
  last_name: 'l.sort_name, l.name',
  name: 'l.name COLLATE NOCASE',
  experience: 'l.years_experience IS NULL, l.years_experience DESC, l.sort_name',
  newest: 'l.created_at DESC, l.sort_name',
};

export function searchLawyers({ q, area, city, state, language, sort = 'relevance', sponsoredFirst = true, page = 1, perPage = 12 } = {}) {
  const where = ["l.status = 'active'"];
  const params = [];
  if (q) {
    const terms = String(q).trim().split(/\s+/).filter(Boolean).slice(0, 8);
    for (const t of terms) {
      where.push(`(l.name LIKE ? OR l.firm LIKE ? OR l.bio LIKE ? OR l.city LIKE ? OR EXISTS (
        SELECT 1 FROM lawyer_practice_areas x JOIN practice_areas p ON p.id = x.area_id
        WHERE x.lawyer_id = l.id AND (p.name LIKE ? OR p.description LIKE ?)))`);
      const like = `%${t}%`;
      params.push(like, like, like, like, like, like);
    }
  }
  if (area) {
    where.push(`EXISTS (SELECT 1 FROM lawyer_practice_areas x JOIN practice_areas p ON p.id = x.area_id
                WHERE x.lawyer_id = l.id AND (p.slug = ? OR p.name LIKE ?
                  OR p.parent_id IN (SELECT id FROM practice_areas WHERE slug = ? OR name LIKE ?)))`);
    params.push(area, area, area, area);
  }
  if (city) { where.push('l.city LIKE ?'); params.push(city); }
  if (state) { where.push('UPPER(l.state) = UPPER(?)'); params.push(state); }
  if (language) { where.push('l.languages LIKE ?'); params.push(`%${language}%`); }

  const order = `${sponsoredFirst ? 'l.featured DESC, ' : ''}${SORTS[sort] || SORTS.relevance}`;

  const whereSql = where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS n FROM lawyers l WHERE ${whereSql}`).get(...params).n;
  const limit = Math.min(Math.max(Number(perPage) || 12, 1), 50);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const rows = db.prepare(`SELECT l.* FROM lawyers l WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  return { rows: attachAreas(rows), total };
}

export function getLawyer(where, value) {
  const col = { id: 'id', slug: 'slug', user: 'user_id' }[where];
  const row = db.prepare(`SELECT * FROM lawyers WHERE ${col} = ?`).get(value);
  if (row) attachAreas([row]);
  return row;
}

export function listLawyers({ status, q } = {}) {
  const where = ['1=1'];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (q) { where.push('(name LIKE ? OR firm LIKE ? OR email LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  return attachAreas(db.prepare(`SELECT * FROM lawyers WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params));
}

/** Pick only known profile fields from a form body and normalise types. */
export function cleanLawyerInput(body) {
  const out = {};
  for (const f of LAWYER_FIELDS) {
    if (!(f in body)) continue;
    let v = body[f];
    if (f === 'languages') v = normalizeLanguages(v);
    else if (f === 'years_experience') v = v === '' || v == null ? null : Math.max(0, Math.min(80, parseInt(v, 10) || 0));
    else v = v == null ? null : String(v).trim().slice(0, f === 'bio' ? 6000 : 500) || null;
    out[f] = v;
  }
  if (out.website && !/^https?:\/\//i.test(out.website)) out.website = `https://${out.website}`;
  for (const k of LAWYER_SOCIAL_KEYS) {
    const f = `social_${k}`;
    if (f in out) out[f] = normalizeSocial(k, out[f]) || null; // unusable links are dropped
  }
  return out;
}

const NAME_EXTRAS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'esq', 'esquire', 'jd', 'phd', 'llm', 'md', 'cpa', 'dr', 'mr', 'mrs', 'ms', 'miss', 'hon', 'atty', 'attorney']);

/** The meaningful words of a name: no nicknames, credentials, titles, suffixes or middle initials. */
function nameWords(name) {
  const words = String(name || '')
    .replace(/\([^)]*\)/g, ' ')        // (nicknames)
    .split(',')[0]                      // ", Esq." and other credentials after a comma
    .split(/\s+/)
    .map((w) => slugify(w.replace(/['’]/g, '')))
    .filter((w) => w && w !== 'item' && !NAME_EXTRAS.has(w.replace(/-/g, '')));
  const named = words.filter((w) => w.replace(/-/g, '').length > 1); // drop middle initials like "A."
  if (named.length) words.splice(0, words.length, ...named);
  return words;
}

/** Profile URL from a name: first and last name only ("Steven A. Elia, Esq." → "steven-elia"). */
export function nameSlug(name) {
  const words = nameWords(name);
  if (!words.length) return slugify(name);
  return words.length === 1 ? words[0] : `${words[0]}-${words[words.length - 1]}`;
}

/** Sort key "last first" ("Steven A. Elia" → "elia steven"), for sorting by surname. */
export function sortName(name) {
  const words = nameWords(name);
  if (!words.length) return String(name || '').toLowerCase();
  return words.length === 1 ? words[0] : `${words[words.length - 1]} ${words[0]}`;
}

/** Fill in sort_name for lawyers saved before it existed. */
export function backfillSortNames() {
  const rows = db.prepare('SELECT id, name FROM lawyers WHERE sort_name IS NULL').all();
  for (const r of rows) db.prepare('UPDATE lawyers SET sort_name = ? WHERE id = ?').run(sortName(r.name), r.id);
  return rows.length;
}
/** Give a lawyer a new URL and keep the old one as a redirect. */
export function setLawyerSlug(id, wanted) {
  const l = db.prepare('SELECT slug FROM lawyers WHERE id = ?').get(id);
  const slug = uniqueSlug('lawyers', wanted, id);
  if (!l || l.slug === slug) return l?.slug;
  tx(() => {
    db.prepare('DELETE FROM slug_redirects WHERE old_slug = ?').run(slug);
    db.prepare('INSERT OR REPLACE INTO slug_redirects (old_slug, lawyer_id) VALUES (?, ?)').run(l.slug, id);
    db.prepare("UPDATE lawyers SET slug = ?, updated_at = datetime('now') WHERE id = ?").run(slug, id);
  });
  return slug;
}

/** One-time switch of existing profile URLs to first-last name, with redirects from the old ones. */
export function migrateSlugsToNames() {
  if (db.prepare("SELECT value FROM settings WHERE key = 'slug_style'").get()?.value === 'name') return 0;
  let changed = 0;
  for (const l of db.prepare('SELECT id, name, slug FROM lawyers ORDER BY id').all()) {
    if (setLawyerSlug(l.id, nameSlug(l.name)) !== l.slug) changed++;
  }
  db.prepare("INSERT INTO settings (key, value) VALUES ('slug_style', 'name') ON CONFLICT(key) DO UPDATE SET value = 'name'").run();
  return changed;
}

export function createLawyer(data) {
  data = { ...data, sort_name: sortName(data.name) };
  const slug = uniqueSlug('lawyers', nameSlug(data.name));
  const fields = Object.keys(data);
  const r = db.prepare(`INSERT INTO lawyers (slug, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')})`)
    .run(slug, ...fields.map((f) => data[f]));
  return Number(r.lastInsertRowid);
}

export function updateLawyer(id, data) {
  if (data.name) data = { ...data, sort_name: sortName(data.name) };
  const fields = Object.keys(data);
  if (!fields.length) return;
  db.prepare(`UPDATE lawyers SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...fields.map((f) => data[f]), id);
}

/** Pick an active ad for a placement, weighted, and count the impression. */
export function pickAd(placement) {
  const ads = db.prepare(`SELECT * FROM ads WHERE placement = ? AND active = 1
    AND (starts_at IS NULL OR starts_at = '' OR starts_at <= date('now'))
    AND (ends_at IS NULL OR ends_at = '' OR ends_at >= date('now'))`).all(placement);
  if (!ads.length) return null;
  const total = ads.reduce((s, a) => s + Math.max(1, a.weight), 0);
  let r = Math.random() * total;
  const ad = ads.find((a) => (r -= Math.max(1, a.weight)) < 0) || ads[0];
  db.prepare('UPDATE ads SET impressions = impressions + 1 WHERE id = ?').run(ad.id);
  return ad;
}

export function featuredLawyers(limit = 4) {
  return attachAreas(db.prepare(`SELECT * FROM lawyers WHERE status = 'active' AND featured = 1 ORDER BY RANDOM() LIMIT ?`).all(limit));
}
