// Backups (Admin → Backups): a nightly copy of the database kept for 14 days, and a one-click download
// of everything that isn't in the code repository — the database and uploaded photos and logos.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { db, DATA_DIR } from './db.js';
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
