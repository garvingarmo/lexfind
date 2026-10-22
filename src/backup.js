// Backups (Admin → Backups): a nightly copy of the database kept for 14 days, and a one-click download
// of everything that isn't in the code repository — the database and uploaded photos and logos.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, DATA_DIR, tx, uniqueSlug } from './db.js';
import { uploadDir } from './middleware.js';

export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAYS = 14;
const NAME = /^directory-(\d{4}-\d{2}-\d{2})\.db$/;

/** Write a consistent copy of the live database to `file` (safe while the site is running). */
function snapshot(file) {
  fs.rmSync(file, { force: true });
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

/** Saved nightly copies, newest first: [{ name, date, size }]. */
export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter((f) => NAME.test(f)).sort().reverse()
    .map((name) => ({ name, date: name.match(NAME)[1], size: fs.statSync(path.join(BACKUP_DIR, name)).size }));
}

export const backupPath = (name) => (NAME.test(name) ? path.join(BACKUP_DIR, name) : null);

/** Make today's copy if there isn't one yet, and delete copies older than KEEP_DAYS. */
export function nightlyBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const file = path.join(BACKUP_DIR, `directory-${today}.db`);
  if (!fs.existsSync(file)) {
    snapshot(`${file}.tmp`);
    fs.renameSync(`${file}.tmp`, file);
    console.log(`[backup] saved ${path.basename(file)}`);
  }
  for (const b of listBackups().slice(KEEP_DAYS)) fs.rmSync(path.join(BACKUP_DIR, b.name), { force: true });
}

/** Run the nightly backup now and then every hour (it only copies once per day). */
export function scheduleBackups() {
  const run = () => { try { nightlyBackup(); } catch (e) { console.error('[backup] failed:', e.message); } };
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}

// Minimal tar writer (ustar), so a full backup is one .tar.gz without extra dependencies.
function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0');
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(Math.floor(mtime / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${oct(sum, 7)}\0`, 148, 8);
  return h;
}

function* walk(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) yield* walk(full, rel);
    else if (entry.isFile() && entry.name !== '.gitkeep') yield [full, rel];
  }
}

/** Stream a .tar.gz of the database (a fresh consistent copy) and all uploads to `out`. */
export function streamFullBackup(out) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = path.join(BACKUP_DIR, `download-${process.pid}-${Date.now()}.db`);
  snapshot(tmp);
  const gzip = zlib.createGzip();
  gzip.pipe(out);
  const add = (file, name) => {
    const data = fs.readFileSync(file);
    gzip.write(tarHeader(name, data.length, fs.statSync(file).mtimeMs));
    gzip.write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) gzip.write(Buffer.alloc(pad));
  };
  try {
    add(tmp, 'chaldean-law-backup/data/directory.db');
    for (const [file, rel] of walk(uploadDir, 'chaldean-law-backup/uploads')) add(file, rel);
    gzip.write(Buffer.alloc(1024)); // end of archive
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  gzip.end();
}

// --- Restoring deleted lawyers from a nightly copy -------------------------------------------

/** Run fn with the backup attached as schema "bk" (read-only use), always detaching afterwards. */
function withBackup(name, fn) {
  const file = backupPath(name);
  if (!file || !fs.existsSync(file)) throw new Error('That backup no longer exists.');
  db.exec(`ATTACH DATABASE '${file.replace(/'/g, "''")}' AS bk`);
  try { return fn(); } finally { db.exec('DETACH DATABASE bk'); }
}

/** Columns present in both the live table and the backup's (backups made before a new column was added lack it). */
function sharedColumns(table) {
  const live = new Set(db.prepare(`PRAGMA main.table_info(${table})`).all().map((c) => c.name));
  return db.prepare(`PRAGMA bk.table_info(${table})`).all().map((c) => c.name).filter((c) => live.has(c));
}

/**
 * Copy rows matching `where` from the backup into the live table, skipping ids that already exist.
 * `exprs` replaces a column's value with an SQL expression (e.g. to clear links to rows that are gone).
 */
function copyRows(table, where, params = [], exprs = {}) {
  const cols = sharedColumns(table);
  if (!cols.length) return 0;
  const list = cols.map((c) => `"${c}"`).join(', ');
  const select = cols.map((c) => exprs[c] || `"${c}"`).join(', ');
  const idCheck = cols.includes('id') ? `AND id NOT IN (SELECT id FROM main.${table})` : '';
  return db.prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${select} FROM bk.${table} WHERE ${where} ${idCheck}`).run(...params).changes;
}

// Keep a link only if what it points to exists on the site now.
const ifExists = (col, table) => `CASE WHEN "${col}" IN (SELECT id FROM main.${table}) THEN "${col}" END`;

/** Lawyers in a nightly copy who are no longer on the site. */
export function deletedLawyers(name) {
  return withBackup(name, () => db.prepare(`SELECT b.id, b.name, b.firm, b.city, b.state, b.email, b.status, b.user_id,
      (SELECT email FROM bk.users u WHERE u.id = b.user_id) AS login_email
    FROM bk.lawyers b WHERE b.id NOT IN (SELECT id FROM main.lawyers) ORDER BY b.name COLLATE NOCASE`).all());
}

/**
 * Put a deleted lawyer back from a nightly copy: the listing, its practice areas, its login (when the
 * email isn't in use by another account now), and its inquiries and referrals. Returns a summary.
 */
export function restoreLawyer(name, lawyerId) {
  return withBackup(name, () => {
    const b = db.prepare('SELECT * FROM bk.lawyers WHERE id = ?').get(lawyerId);
    if (!b) throw new Error('That lawyer is not in this backup.');
    if (db.prepare('SELECT 1 FROM main.lawyers WHERE id = ?').get(lawyerId)) throw new Error(`${b.name} is already on the site.`);
    const notes = [];
    tx(() => {
      // The login first, so the listing can point at it.
      let userId = null;
      const u = b.user_id && db.prepare('SELECT * FROM bk.users WHERE id = ?').get(b.user_id);
      if (u) {
        const clash = db.prepare('SELECT id FROM main.users WHERE id = ? OR email = ? COLLATE NOCASE').get(u.id, u.email);
        if (clash) notes.push(`the login ${u.email} was not restored because that email or account is in use now`);
        else { copyRows('users', 'id = ?', [u.id]); userId = u.id; notes.push(`login ${u.email} restored`); }
      }
      // Another listing may have taken its web address since; give it a free one if so.
      let slug = b.slug;
      if (db.prepare('SELECT 1 FROM main.lawyers WHERE slug = ?').get(slug)) {
        slug = uniqueSlug('lawyers', b.slug, lawyerId);
        notes.push(`its web address is now /lawyers/${slug}`);
      }
      copyRows('lawyers', 'id = ?', [lawyerId], {
        user_id: userId ? String(Number(userId)) : 'NULL',
        slug: `'${slug.replace(/'/g, "''")}'`,
      });
      if (!db.prepare('SELECT 1 FROM main.lawyers WHERE id = ?').get(lawyerId)) throw new Error(`${b.name} could not be restored.`);
      const areas = db.prepare(`INSERT OR IGNORE INTO main.lawyer_practice_areas (lawyer_id, area_id)
        SELECT lawyer_id, area_id FROM bk.lawyer_practice_areas WHERE lawyer_id = ? AND area_id IN (SELECT id FROM main.practice_areas)`).run(lawyerId).changes;
      notes.push(`${areas} practice area${areas === 1 ? '' : 's'}`);
      const inquiries = copyRows('inquiries', 'lawyer_id = ?', [lawyerId]);
      const referrals = copyRows('referrals', 'to_lawyer_id = ?', [lawyerId], {
        from_user_id: ifExists('from_user_id', 'users'), from_lawyer_id: ifExists('from_lawyer_id', 'lawyers'),
      });
      if (inquiries) notes.push(`${inquiries} inquir${inquiries === 1 ? 'y' : 'ies'}`);
      if (referrals) notes.push(`${referrals} referral${referrals === 1 ? '' : 's'}`);
      copyRows('slug_redirects', 'lawyer_id = ? AND old_slug NOT IN (SELECT old_slug FROM main.slug_redirects)', [lawyerId]);
      // Referrals this lawyer sent are kept on the site with the sender cleared; point them back.
      db.prepare('UPDATE main.referrals SET from_lawyer_id = ? WHERE from_lawyer_id IS NULL AND id IN (SELECT id FROM bk.referrals WHERE from_lawyer_id = ?)').run(lawyerId, lawyerId);
      if (userId) db.prepare('UPDATE main.referrals SET from_user_id = ? WHERE from_user_id IS NULL AND id IN (SELECT id FROM bk.referrals WHERE from_user_id = ?)').run(userId, userId);
    });
    return { name: b.name, slug: db.prepare('SELECT slug FROM main.lawyers WHERE id = ?').get(lawyerId).slug, notes };
  });
}
