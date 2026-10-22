// Finding and merging duplicate lawyer listings (e.g. a lawyer who registers although they were imported).
//
// Definite matches: the same bar number, or the same email. Likely matches: the same name (first + last,
// ignoring middle initials and suffixes) in the same city or state, the same mobile number, or the same
// office phone together with the same last name. An office phone alone is not a match: colleagues at a
// firm often share one.
import { db, tx } from './db.js';
import { getLawyer, nameWords } from './models.js';

db.exec(`CREATE TABLE IF NOT EXISTS duplicate_dismissals (
  a INTEGER NOT NULL, b INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (a, b)
);`);

export const normBar = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const normEmail = (v) => String(v || '').trim().toLowerCase();
/** The last 10 digits, so "+1 (248) 555-0123" and "248.555.0123" compare equal. */
export const normPhone = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const nameKey = (name) => { const w = nameWords(name); return w.length ? `${w[0]} ${w[w.length - 1]}` : ''; };
const lastName = (name) => { const w = nameWords(name); return w[w.length - 1] || ''; };
const norm = (v) => String(v || '').trim().toLowerCase();

/** Lawyer rows plus the email of their login, if any. */
function allLawyers() {
  return db.prepare(`SELECT l.id, l.name, l.firm, l.email, l.phone, l.mobile, l.city, l.state, l.bar_number, l.status,
      l.user_id, l.slug, l.created_at, u.email AS login_email
    FROM lawyers l LEFT JOIN users u ON u.id = l.user_id`).all();
}

/**
 * Why `a` and `b` look like the same lawyer: { strength: 'definite' | 'likely' | null, reasons: [...] }.
 * `a` may be a listing or the details someone just typed into the registration form.
 */
export function compare(a, b) {
  const reasons = [];
  let strength = null;
  const definite = (r) => { reasons.push(r); strength = 'definite'; };
  const likely = (r) => { reasons.push(r); strength ??= 'likely'; };
  if (normBar(a.bar_number) && normBar(a.bar_number) === normBar(b.bar_number)) definite('same bar number');
  const emailsA = new Set([normEmail(a.email), normEmail(a.login_email)].filter(Boolean));
  if ([normEmail(b.email), normEmail(b.login_email)].some((e) => e && emailsA.has(e))) definite('same email');
  const sameName = nameKey(a.name) && nameKey(a.name) === nameKey(b.name);
  const samePlace = (norm(a.city) && norm(a.city) === norm(b.city)) || (norm(a.state) && norm(a.state) === norm(b.state));
  if (sameName && samePlace) likely(`same name in ${norm(a.city) === norm(b.city) && a.city ? b.city : b.state}`);
  const mobilesA = new Set([normPhone(a.mobile)].filter((p) => p.length >= 7));
  if (mobilesA.size && [normPhone(b.mobile), normPhone(b.phone)].some((p) => mobilesA.has(p))) likely('same mobile number');
  const phoneA = normPhone(a.phone);
  if (phoneA.length >= 7 && phoneA === normPhone(b.phone) && lastName(a.name) && lastName(a.name) === lastName(b.name)) {
    likely('same office phone and last name');
  }
  return { strength, reasons };
}

/** Existing listings that look like `candidate` (strongest first). */
export function findMatches(candidate, { excludeId } = {}) {
  return allLawyers()
    .filter((l) => l.id !== excludeId)
    .map((l) => ({ lawyer: l, ...compare(candidate, l) }))
    .filter((m) => m.strength)
    .sort((x, y) => (x.strength === y.strength ? 0 : x.strength === 'definite' ? -1 : 1));
}

/** Matches for a saved listing, leaving out pairs an admin marked "Not a duplicate". */
export function matchesFor(lawyerId) {
  const me = allLawyers().find((l) => l.id === Number(lawyerId));
  if (!me) return [];
  const dismissed = new Set(db.prepare('SELECT a, b FROM duplicate_dismissals WHERE a = ? OR b = ?').all(me.id, me.id).map((r) => (r.a === me.id ? r.b : r.a)));
  return findMatches(me, { excludeId: me.id }).filter((m) => !dismissed.has(m.lawyer.id));
}

/** Every pair of listings that look like duplicates, for the report. */
export function duplicatePairs() {
  const rows = allLawyers();
  const dismissed = new Set(db.prepare('SELECT a, b FROM duplicate_dismissals').all().map((r) => `${r.a}:${r.b}`));
  // Only compare listings that share at least one key, rather than every pair.
  const buckets = new Map();
  const add = (key, l) => { if (!key) return; if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(l); };
  for (const l of rows) {
    add(normBar(l.bar_number) && `bar:${normBar(l.bar_number)}`, l);
    for (const e of new Set([normEmail(l.email), normEmail(l.login_email)])) add(e && `email:${e}`, l);
    add(nameKey(l.name) && `name:${nameKey(l.name)}`, l);
    for (const p of new Set([normPhone(l.mobile), normPhone(l.phone)])) add(p.length >= 7 && `phone:${p}`, l);
  }
  const pairs = new Map();
  for (const group of buckets.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [a, b] = group[i].id < group[j].id ? [group[i], group[j]] : [group[j], group[i]];
        const key = `${a.id}:${b.id}`;
        if (pairs.has(key) || dismissed.has(key)) continue;
        const c = compare(a, b);
        if (c.strength) pairs.set(key, { a, b, ...c });
      }
    }
  }
  return [...pairs.values()].sort((x, y) => (x.strength === y.strength ? y.b.id - x.b.id : x.strength === 'definite' ? -1 : 1));
}

export function dismissPair(id1, id2) {
  const [a, b] = [Number(id1), Number(id2)].sort((x, y) => x - y);
  db.prepare('INSERT OR IGNORE INTO duplicate_dismissals (a, b) VALUES (?, ?)').run(a, b);
}

// --- Merging ---------------------------------------------------------------------------------

// Columns that belong to the row itself rather than to the lawyer's details.
const NOT_DETAILS = new Set(['id', 'slug', 'user_id', 'created_at', 'updated_at', 'sort_name', 'status', 'featured', 'verified', 'hidden', 'is_sample', 'last_enriched_at']);
const STATUS_RANK = { active: 3, pending: 2, suspended: 1 };

/** The fields that would be filled in on the kept listing from the other one (for the preview). */
export function fillsFrom(keep, remove) {
  const cols = db.prepare('PRAGMA table_info(lawyers)').all().map((c) => c.name).filter((c) => !NOT_DETAILS.has(c));
  return cols.filter((c) => (keep[c] == null || keep[c] === '') && remove[c] != null && remove[c] !== '');
}

/**
 * Merge listing `removeId` into `keepId`: blank details are filled from the other listing, practice areas
 * are combined, the login moves over (when the kept listing has none, or `useLogin` = 'remove'), and
 * inquiries, referrals, research, invitations, ads, statistics and the old web address move to the kept
 * listing. The other listing is then deleted. Returns a summary.
 */
export function mergeLawyers(keepId, removeId, { status, useLogin = 'keep' } = {}) {
  keepId = Number(keepId); removeId = Number(removeId);
  if (keepId === removeId) throw new Error('Choose two different listings.');
  const keep = db.prepare('SELECT * FROM lawyers WHERE id = ?').get(keepId);
  const remove = db.prepare('SELECT * FROM lawyers WHERE id = ?').get(removeId);
  if (!keep || !remove) throw new Error('One of these listings no longer exists.');
  const notes = [];
  tx(() => {
    const filled = fillsFrom(keep, remove);
    if (filled.length) {
      db.prepare(`UPDATE lawyers SET ${filled.map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`).run(...filled.map((c) => remove[c]), keepId);
      notes.push(`filled in ${filled.length} detail${filled.length === 1 ? '' : 's'}`);
    }
    // Login: a listing has at most one.
    let deleteUser = null;
    if (remove.user_id && (!keep.user_id || useLogin === 'remove')) {
      if (keep.user_id) deleteUser = keep.user_id;
      db.prepare('UPDATE lawyers SET user_id = NULL WHERE id = ?').run(removeId);
      db.prepare('UPDATE lawyers SET user_id = ? WHERE id = ?').run(remove.user_id, keepId);
      notes.push('moved the login');
    } else if (remove.user_id) {
      deleteUser = remove.user_id;
    }
    const newStatus = STATUS_RANK[status] ? status : (STATUS_RANK[remove.status] > STATUS_RANK[keep.status] ? remove.status : keep.status);
    db.prepare(`UPDATE lawyers SET status = ?, featured = MAX(featured, ?), verified = MAX(verified, ?), updated_at = datetime('now') WHERE id = ?`)
      .run(newStatus, remove.featured || 0, remove.verified || 0, keepId);
    const areas = db.prepare('INSERT OR IGNORE INTO lawyer_practice_areas (lawyer_id, area_id) SELECT ?, area_id FROM lawyer_practice_areas WHERE lawyer_id = ?').run(keepId, removeId).changes;
    if (areas) notes.push(`added ${areas} practice area${areas === 1 ? '' : 's'}`);
    const moved = [
      ['inquiries', 'lawyer_id'], ['referrals', 'to_lawyer_id'], ['referrals', 'from_lawyer_id'], ['enrichments', 'lawyer_id'],
      ['invites', 'lawyer_id'], ['ads', 'lawyer_id'], ['events', 'lawyer_id'], ['slug_redirects', 'lawyer_id'],
    ].reduce((n, [t, c]) => n + db.prepare(`UPDATE ${t} SET ${c} = ? WHERE ${c} = ?`).run(keepId, removeId).changes, 0);
    if (moved) notes.push(`moved ${moved} related record${moved === 1 ? '' : 's'} (inquiries, referrals, history)`);
    if (deleteUser) {
      // Referrals sent from the login being removed now count as sent from the kept login.
      const keptUser = db.prepare('SELECT user_id FROM lawyers WHERE id = ?').get(keepId).user_id;
      db.prepare('UPDATE referrals SET from_user_id = ? WHERE from_user_id = ?').run(keptUser, deleteUser);
    }
    db.prepare('DELETE FROM lawyers WHERE id = ?').run(removeId);
    if (deleteUser) {
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'lawyer'").run(deleteUser);
      db.prepare('DELETE FROM sessions WHERE data LIKE ? OR data LIKE ?').run(`%"userId":${deleteUser},%`, `%"userId":${deleteUser}}%`);
      notes.push('removed the extra login');
    }
    // The removed listing's address now leads to the kept one.
    db.prepare('INSERT OR REPLACE INTO slug_redirects (old_slug, lawyer_id) VALUES (?, ?)').run(remove.slug, keepId);
    db.prepare('DELETE FROM duplicate_dismissals WHERE a IN (?, ?) OR b IN (?, ?)').run(keepId, removeId, keepId, removeId);
  });
  return { kept: getLawyer('id', keepId), notes };
}

/** Both listings with what each has, for the side-by-side comparison. */
export function comparison(id1, id2) {
  const get = (id) => db.prepare(`SELECT l.*, u.email AS login_email FROM lawyers l LEFT JOIN users u ON u.id = l.user_id WHERE l.id = ?`).get(id);
  const a = get(id1); const b = get(id2);
  if (!a || !b) return null;
  const areas = (id) => db.prepare('SELECT pa.name FROM practice_areas pa JOIN lawyer_practice_areas x ON x.area_id = pa.id WHERE x.lawyer_id = ? ORDER BY pa.name').all(id).map((r) => r.name);
  const counts = (id) => ({
    inquiries: db.prepare('SELECT COUNT(*) n FROM inquiries WHERE lawyer_id = ?').get(id).n,
    referrals: db.prepare('SELECT COUNT(*) n FROM referrals WHERE to_lawyer_id = ? OR from_lawyer_id = ?').get(id, id).n,
  });
  return { a: { ...a, areas: areas(a.id), ...counts(a.id) }, b: { ...b, areas: areas(b.id), ...counts(b.id) }, ...compare(a, b) };
}

