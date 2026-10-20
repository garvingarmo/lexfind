// The list of languages lawyers can tick (Admin → Lawyer profiles). Stored on each lawyer as "English, Arabic".
import { db, getSettings, setSetting } from './db.js';

export const DEFAULT_LANGUAGES = ['English', 'Arabic', 'Chaldean', 'Spanish'];

export function getLanguageOptions() {
  try {
    const list = JSON.parse(getSettings().language_options || 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch { /* fall through */ }
  return DEFAULT_LANGUAGES;
}

/** Save the list from a textarea (one per line, or comma-separated). */
export function saveLanguageOptions(text) {
  const seen = new Set();
  const list = String(text || '').split(/[\n,;]+/).map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 40))
    .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  setSetting('language_options', JSON.stringify(list.length ? list : DEFAULT_LANGUAGES));
  return list;
}

/**
 * Turn ticked boxes (array) or typed text ("english; Arabic/Chaldean") into "English, Arabic, Chaldean",
 * using the admin list's spelling where it matches and keeping anything else as typed.
 */
export function normalizeLanguages(value) {
  const opts = getLanguageOptions();
  const byLower = new Map(opts.map((o) => [o.toLowerCase(), o]));
  const parts = (Array.isArray(value) ? value : String(value || '').split(/[,;/|\n]+/)).map((s) => String(s).trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const v = byLower.get(p.toLowerCase()) || p.slice(0, 40);
    if (!seen.has(v.toLowerCase())) { seen.add(v.toLowerCase()); out.push(v); }
  }
  // Keep the admin list's order, then any extras.
  out.sort((a, b) => (opts.indexOf(a) === -1 ? 999 : opts.indexOf(a)) - (opts.indexOf(b) === -1 ? 999 : opts.indexOf(b)));
  return out.join(', ') || null;
}

/** Split a stored or typed languages value into names. */
export const splitLanguages = (v) => String(v || '').split(/[,;/|\n]+/).map((s) => s.trim()).filter(Boolean);

/** One-time tidy of languages typed before the checkbox list existed ("english; arabic/Chaldean"). */
export function normalizeAllLanguages() {
  if (db.prepare("SELECT value FROM settings WHERE key = 'languages_normalized'").get()) return 0;
  let n = 0;
  for (const r of db.prepare('SELECT id, languages FROM lawyers WHERE languages IS NOT NULL').all()) {
    const v = normalizeLanguages(r.languages);
    if (v !== r.languages) { db.prepare('UPDATE lawyers SET languages = ? WHERE id = ?').run(v, r.id); n++; }
  }
  setSetting('languages_normalized', '1');
  return n;
}

/** Languages that appear on listings but aren't in the admin list (so the admin can add them). */
export function unlistedLanguages() {
  const opts = new Set(getLanguageOptions().map((o) => o.toLowerCase()));
  const found = new Map();
  for (const r of db.prepare('SELECT languages FROM lawyers WHERE languages IS NOT NULL').all()) {
    for (const l of r.languages.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!opts.has(l.toLowerCase())) found.set(l.toLowerCase(), { name: l, count: (found.get(l.toLowerCase())?.count || 0) + 1 });
    }
  }
  return [...found.values()].sort((a, b) => b.count - a.count);
}
