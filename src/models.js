// Query helpers shared by the web routes and the AI agent.
import { db, tx, uniqueSlug, slugify } from './db.js';
import { LAWYER_SOCIAL_KEYS, normalizeSocial } from './social.js';
import { normalizeLanguages } from './languages.js';

export const LAWYER_FIELDS = [
  'name', 'firm', 'title', 'bio', 'email', 'phone', 'website', 'address', 'city', 'state', 'zip',
  'bar_number', 'bar_admissions', 'years_experience', 'languages', 'education', 'fee_structure',
  'hourly_rate', 'free_consultation',
  'social_linkedin', 'social_facebook', 'social_instagram', 'social_x', 'social_youtube', 'social_tiktok',
];

/**
 * Practice areas with lawyer counts. `lawyer_count` counts active lawyers, `total_count` all of them.
 * withLawyersOnly hides areas no active lawyer is listed under (for the public site and the AI assistant).
 */
export function listAreas({ withLawyersOnly = false } = {}) {
  const rows = db.prepare(`
    SELECT pa.*,
      (SELECT COUNT(*) FROM lawyer_practice_areas lpa JOIN lawyers l ON l.id = lpa.lawyer_id
       WHERE lpa.area_id = pa.id AND l.status = 'active') AS lawyer_count,
      (SELECT COUNT(*) FROM lawyer_practice_areas lpa WHERE lpa.area_id = pa.id) AS total_count
    FROM practice_areas pa ORDER BY pa.name COLLATE NOCASE`).all();
  return withLawyersOnly ? rows.filter((a) => a.lawyer_count > 0) : rows;
}

/** Move every lawyer from one practice area to another, then delete the first. */
export function mergeAreas(fromId, intoId) {
  if (Number(fromId) === Number(intoId)) return;
  tx(() => {
    db.prepare('INSERT OR IGNORE INTO lawyer_practice_areas (lawyer_id, area_id) SELECT lawyer_id, ? FROM lawyer_practice_areas WHERE area_id = ?').run(intoId, fromId);
    db.prepare('DELETE FROM practice_areas WHERE id = ?').run(fromId);
  });
}

/** Delete practice areas that no lawyer (in any status) is listed under. Returns how many. */
export function deleteUnusedAreas() {
  return db.prepare('DELETE FROM practice_areas WHERE id NOT IN (SELECT DISTINCT area_id FROM lawyer_practice_areas)').run().changes;
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
export function searchLawyers({ q, area, city, state, language, freeConsult, sort = 'relevance', page = 1, perPage = 12 } = {}) {
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
                WHERE x.lawyer_id = l.id AND (p.slug = ? OR p.name LIKE ?))`);
    params.push(area, area);
  }
  if (city) { where.push('l.city LIKE ?'); params.push(city); }
  if (state) { where.push('UPPER(l.state) = UPPER(?)'); params.push(state); }
  if (language) { where.push('l.languages LIKE ?'); params.push(`%${language}%`); }
  if (freeConsult) where.push('l.free_consultation = 1');

  const order = {
    relevance: 'l.featured DESC, l.verified DESC, l.years_experience DESC',
    experience: 'l.featured DESC, l.years_experience DESC',
    name: 'l.featured DESC, l.name ASC',
    newest: 'l.featured DESC, l.created_at DESC',
  }[sort] || 'l.featured DESC, l.verified DESC, l.years_experience DESC';

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
    if (!(f in body) && f !== 'free_consultation') continue;
    let v = body[f];
    if (f === 'free_consultation') v = v === 'on' || v === '1' || v === 1 || v === true ? 1 : 0;
    else if (f === 'languages') v = normalizeLanguages(v);
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

/** Profile URL from a name: first and last name only ("Steven A. Elia, Esq." → "steven-elia"). */
export function nameSlug(name) {
  const words = String(name || '')
    .replace(/\([^)]*\)/g, ' ')        // (nicknames)
    .split(',')[0]                      // ", Esq." and other credentials after a comma
    .split(/\s+/)
    .map((w) => slugify(w.replace(/['’]/g, '')))
    .filter((w) => w && w !== 'item' && !NAME_EXTRAS.has(w.replace(/-/g, '')));
  const named = words.filter((w) => w.replace(/-/g, '').length > 1); // drop middle initials like "A."
  if (named.length) words.splice(0, words.length, ...named);
  if (!words.length) return slugify(name);
  return words.length === 1 ? words[0] : `${words[0]}-${words[words.length - 1]}`;
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
  const slug = uniqueSlug('lawyers', nameSlug(data.name));
  const fields = Object.keys(data);
  const r = db.prepare(`INSERT INTO lawyers (slug, ${fields.join(', ')}) VALUES (?, ${fields.map(() => '?').join(', ')})`)
    .run(slug, ...fields.map((f) => data[f]));
  return Number(r.lastInsertRowid);
}

export function updateLawyer(id, data) {
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
