import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
// DATA_DIR keeps the database (and, by default, uploads) outside the code folder on hosts that redeploy it.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, 'directory.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'lawyer' CHECK (role IN ('lawyer','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lawyers (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  firm TEXT,
  title TEXT,
  bio TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  bar_number TEXT,
  bar_admissions TEXT,
  years_experience INTEGER,
  languages TEXT,
  education TEXT,
  fee_structure TEXT,
  hourly_rate TEXT,
  free_consultation INTEGER NOT NULL DEFAULT 0,
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  featured INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  last_enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS practice_areas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS lawyer_practice_areas (
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  area_id INTEGER NOT NULL REFERENCES practice_areas(id) ON DELETE CASCADE,
  PRIMARY KEY (lawyer_id, area_id)
);

CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  image TEXT,
  link_url TEXT NOT NULL,
  cta TEXT DEFAULT 'Learn more',
  placement TEXT NOT NULL CHECK (placement IN ('home_banner','search_sidebar','profile_sidebar','blog_sidebar')),
  lawyer_id INTEGER REFERENCES lawyers(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  weight INTEGER NOT NULL DEFAULT 1,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  excerpt TEXT,
  body TEXT NOT NULL DEFAULT '',
  cover_image TEXT,
  author TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'profile',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Clients one member refers to another lawyer (from a lawyer profile → "Refer a client").
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  to_lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  from_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  from_lawyer_id INTEGER REFERENCES lawyers(id) ON DELETE SET NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_email TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  matter TEXT,
  emailed INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS enrichments (
  id INTEGER PRIMARY KEY,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ready','applied','rejected','error')),
  proposed_json TEXT,
  sources_json TEXT,
  notes TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lawyers_status ON lawyers(status);
CREATE INDEX IF NOT EXISTS idx_lawyers_loc ON lawyers(state, city);
CREATE INDEX IF NOT EXISTS idx_inquiries_lawyer ON inquiries(lawyer_id);
CREATE INDEX IF NOT EXISTS idx_enrich_lawyer ON enrichments(lawyer_id);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  email TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  sent_at TEXT,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_lawyer ON invites(lawyer_id);

-- Search results emailed by visitors (for rate limiting).
CREATE TABLE IF NOT EXISTS result_shares (
  id INTEGER PRIMARY KEY,
  ip TEXT,
  recipient TEXT,
  lawyer_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Old profile addresses, so links keep working after a lawyer's URL changes.
CREATE TABLE IF NOT EXISTS slug_redirects (
  old_slug TEXT PRIMARY KEY,
  lawyer_id INTEGER NOT NULL REFERENCES lawyers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`);

// Columns added after the first release, applied to existing databases on start-up.
function addColumn(table, column, definition) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return !exists;
}
if (addColumn('lawyers', 'is_sample', 'INTEGER NOT NULL DEFAULT 0')) {
  // Databases seeded before this column existed: the sample lawyers all use @example.com addresses.
  db.exec("UPDATE lawyers SET is_sample = 1 WHERE email LIKE '%@example.com'");
}
if (addColumn('ads', 'is_sample', 'INTEGER NOT NULL DEFAULT 0')) {
  db.exec("UPDATE ads SET is_sample = 1 WHERE lawyer_id IN (SELECT id FROM lawyers WHERE is_sample = 1) OR title = 'Advertise your practice here'");
}
addColumn('lawyers', 'sort_name', 'TEXT');
addColumn('lawyers', 'mobile', 'TEXT'); // mobile / cell number, alongside the office phone // "last first", for sorting by surname
for (const n of ['linkedin', 'facebook', 'instagram', 'x', 'youtube', 'tiktok']) addColumn('lawyers', `social_${n}`, 'TEXT');
addColumn('practice_areas', 'sort_order', 'INTEGER'); // admin's drag-and-drop order; unsorted areas follow alphabetically
addColumn('practice_areas', 'parent_id', 'INTEGER REFERENCES practice_areas(id) ON DELETE SET NULL'); // sub-category of
addColumn('posts', 'format', "TEXT NOT NULL DEFAULT 'markdown'");
if (addColumn('posts', 'is_sample', 'INTEGER NOT NULL DEFAULT 0')) {
  db.exec("UPDATE posts SET is_sample = 1 WHERE author IN ('LexFind Editorial Team', 'Chaldean Law Editorial Team')");
}

export const DEFAULT_SETTINGS = {
  site_name: 'Chaldean Law',
  site_url: 'https://chaldeanlaw.com',
  tagline: 'Find the right lawyer for your legal matter',
  hero_title: 'The right lawyer, matched to your situation',
  hero_subtitle: 'Search our directory of attorneys, or describe your legal matter and our AI assistant will recommend lawyers who fit.',
  disclaimer: 'Chaldean Law is a directory and referral tool, not a law firm. Information on this site, including responses from the AI assistant, is not legal advice and does not create an attorney-client relationship.',
  about_body: '## About Chaldean Law\n\nChaldean Law helps people find attorneys who handle their kind of legal matter, close to where they live.\n\nAttorneys maintain their own listings, and our team reviews every profile before it is published.',
  footer_text: '© Chaldean Law · chaldeanlaw.com. All rights reserved.',
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (!r.key.startsWith('secret_')) out[r.key] = r.value;
  return out;
}

/**
 * Credentials saved from Admin → Integrations (API key, SMTP). Kept out of getSettings() so they
 * never reach page templates. Environment variables take precedence over these.
 */
export function getSecret(name) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(`secret_${name}`)?.value || '';
}

export function setSecret(name, value) {
  if (value) setSetting(`secret_${name}`, value);
  else db.prepare('DELETE FROM settings WHERE key = ?').run(`secret_${name}`);
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function uniqueSlug(table, base, excludeId = null) {
  let slug = slugify(base);
  let n = 1;
  const stmt = db.prepare(`SELECT id FROM ${table} WHERE slug = ? AND id IS NOT ?`);
  while (stmt.get(slug, excludeId)) slug = `${slugify(base)}-${++n}`;
  return slug;
}

/** Run fn inside a transaction. Nested calls join the outer transaction. */
let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}
