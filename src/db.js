import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'directory.db'));
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
`);

export const DEFAULT_SETTINGS = {
  site_name: 'LexFind',
  tagline: 'Find the right lawyer for your legal matter',
  hero_title: 'The right lawyer, matched to your situation',
  hero_subtitle: 'Search our directory of attorneys, or describe your legal matter and our AI assistant will recommend lawyers who fit.',
  disclaimer: 'LexFind is a directory and referral tool, not a law firm. Information on this site, including responses from the AI assistant, is not legal advice and does not create an attorney-client relationship.',
  about_body: '## About LexFind\n\nLexFind helps people find attorneys who handle their kind of legal matter, close to where they live.\n\nAttorneys maintain their own listings, and our team reviews every profile before it is published.',
  footer_text: '© LexFind. All rights reserved.',
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULT_SETTINGS };
  for (const r of rows) out[r.key] = r.value;
  return out;
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

/** Run fn inside a transaction. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
