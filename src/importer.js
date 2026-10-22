// Bulk import of lawyer listings from a spreadsheet (Google Sheets link or CSV upload).
// Flow: load rows -> store them in a temporary file -> admin maps columns and previews -> import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { db, tx, DATA_DIR, uniqueSlug } from './db.js';
import { createLawyer, updateLawyer, setAreas, setAreaParent, cleanLawyerInput, listAreas } from './models.js';
import { STATES } from './ai/agent.js';
import { normBar } from './duplicates.js';

const importDir = path.join(DATA_DIR, 'imports');
fs.mkdirSync(importDir, { recursive: true });

/** Directory fields a spreadsheet column can be mapped to, with header names we recognise automatically. */
export const IMPORT_FIELDS = [
  ['name', 'Full name', ['name', 'full name', 'lawyer', 'lawyer name', 'attorney', 'attorney name']],
  ['first_name', 'First name', ['first name', 'first', 'firstname', 'given name']],
  ['last_name', 'Last name', ['last name', 'last', 'lastname', 'surname', 'family name']],
  ['firm', 'Firm', ['firm', 'law firm', 'firm name', 'company', 'office', 'practice name']],
  ['title', 'Professional title', ['title', 'position', 'job title', 'role']],
  ['email', 'Email', ['email', 'e-mail', 'email address']],
  ['phone', 'Phone', ['phone', 'telephone', 'phone number', 'tel', 'office phone', 'work phone', 'office']],
  ['phone_ext', 'Phone extension', ['ext', 'extension', 'ext.', 'phone ext', 'phone extension']],
  ['mobile', 'Mobile', ['mobile', 'cell', 'mobile phone', 'cell phone', 'mobile number', 'cell number', 'cellphone']],
  ['website', 'Website', ['website', 'web', 'url', 'site', 'web site', 'website url']],
  ['address', 'Street address', ['address', 'street', 'street address', 'address 1', 'office address']],
  ['city', 'City', ['city', 'town']],
  ['state', 'State', ['state', 'st', 'province', 'region']],
  ['zip', 'ZIP', ['zip', 'zip code', 'zipcode', 'postal code', 'postcode']],
  ['bar_number', 'Bar number', ['bar number', 'bar no', 'bar #', 'bar id', 'license number', 'p number']],
  ['bar_admissions', 'Bar admissions', ['bar admissions', 'admissions', 'admitted', 'licensed in', 'jurisdictions']],
  ['years_experience', 'Years of experience', ['years experience', 'years of experience', 'experience', 'years', 'years in practice']],
  ['languages', 'Languages', ['languages', 'language', 'languages spoken']],
  ['education', 'Education', ['education', 'law school', 'school', 'degrees']],
  ['practice_areas', 'Practice areas', ['practice areas', 'practice area', 'areas', 'specialty', 'specialties', 'specialization', 'areas of practice', 'category', 'categories']],
  ['bio', 'Bio', ['bio', 'biography', 'about', 'description', 'profile', 'summary']],
  ['photo', 'Photo URL', ['photo', 'photo url', 'image', 'image url', 'headshot', 'picture']],
  ['social_linkedin', 'LinkedIn', ['linkedin', 'linkedin url', 'linked in']],
  ['social_facebook', 'Facebook', ['facebook', 'facebook url', 'fb']],
  ['social_instagram', 'Instagram', ['instagram', 'instagram url', 'ig', 'insta']],
  ['social_x', 'X (Twitter)', ['x', 'twitter', 'x (twitter)', 'twitter url']],
  ['social_youtube', 'YouTube', ['youtube', 'youtube url']],
  ['social_tiktok', 'TikTok', ['tiktok', 'tik tok']],
  ['featured', 'Sponsored (yes/no)', ['featured', 'sponsored', 'premium']],
];

const norm = (s) => String(s || '').toLowerCase().replace(/[_.:]+/g, ' ').replace(/-/g, '').replace(/\s+/g, ' ').trim();

/** Guess which spreadsheet header belongs to each field. Returns { field: headerIndex }. */
export function autoMap(headers) {
  const mapping = {};
  const used = new Set();
  for (const [key, , aliases] of IMPORT_FIELDS) {
    const idx = headers.findIndex((h, i) => !used.has(i) && aliases.some((a) => norm(a) === norm(h)));
    if (idx >= 0) { mapping[key] = idx; used.add(idx); }
  }
  return mapping;
}

/** Turn a Google Sheets share link into its CSV export URL. Only Google hosts are allowed. */
export function sheetCsvUrl(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error('That does not look like a valid link.'); }
  if (u.hostname !== 'docs.google.com') throw new Error('Please paste a Google Sheets link (docs.google.com/spreadsheets/…).');
  const m = u.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('Could not find the sheet ID in that link.');
  const gid = u.searchParams.get('gid') || (u.hash.match(/gid=(\d+)/) || [])[1];
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv${gid ? `&gid=${gid}` : ''}`;
}

export async function fetchSheet(link) {
  const res = await fetch(sheetCsvUrl(link), { redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || type.includes('text/html')) {
    throw new Error('Google did not return the sheet. In Google Sheets click Share → General access → "Anyone with the link" (Viewer), then try again. Or use File → Download → CSV and upload the file instead.');
  }
  return res.text();
}

/** Parse CSV text and save it for the mapping step. Returns a token. */
export function stageCsv(text, source) {
  let records;
  try {
    records = parse(text.replace(/^﻿/, ''), { relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    throw new Error(`Could not read the file as CSV: ${e.message}`);
  }
  if (records.length < 2) throw new Error('The sheet needs a header row plus at least one lawyer.');
  if (records.length > 5001) throw new Error('Please import 5,000 rows or fewer at a time.');
  const [headers, ...rows] = records;
  const token = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(importDir, `${token}.json`), JSON.stringify({ headers, rows, source, created: Date.now() }));
  // Clean up staged imports older than a day.
  for (const f of fs.readdirSync(importDir)) {
    const p = path.join(importDir, f);
    if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.rmSync(p, { force: true });
  }
  return token;
}

export function loadStaged(token) {
  if (!/^[a-f0-9]{24}$/.test(token || '')) return null;
  const p = path.join(importDir, `${token}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

export function discardStaged(token) {
  if (/^[a-f0-9]{24}$/.test(token || '')) fs.rmSync(path.join(importDir, `${token}.json`), { force: true });
}

const STATE_CODES = new Set(Object.values(STATES));
function normState(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (STATE_CODES.has(s.toUpperCase())) return s.toUpperCase();
  return STATES[s.toLowerCase().replace(/\./g, '')] || s.slice(0, 40);
}

const yes = (v) => /^(y|yes|true|1|x|✓|✔|free)$/i.test(String(v || '').trim());

/**
 * Split a cell like "Family Law, Licensing (ABC, Tobacco, etc.) / Probate" into practice areas.
 * Separators are , ; | / and new lines, except inside brackets.
 */
export function splitAreas(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text || '')) {
    if (ch === '(' || ch === '[') depth++;
    if ((ch === ')' || ch === ']') && depth > 0) depth--;
    if (depth === 0 && /[,;|/\n]/.test(ch)) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  const seen = new Set();
  return out.map((a) => a.replace(/\s+/g, ' ').trim())
    .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
}

/** Convert one spreadsheet row into listing data using the column mapping. */
export function rowToLawyer(row, mapping) {
  const get = (key) => (mapping[key] != null && mapping[key] !== '' ? String(row[mapping[key]] ?? '').trim() : '');
  const name = get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ');
  const raw = {};
  for (const [key] of IMPORT_FIELDS) if (!['name', 'first_name', 'last_name', 'practice_areas', 'photo', 'featured'].includes(key)) raw[key] = get(key);
  raw.name = name;
  if (raw.years_experience) raw.years_experience = (raw.years_experience.match(/\d+/) || [''])[0];
  const data = cleanLawyerInput(raw);
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === '') delete data[k];
  if (data.state) data.state = normState(data.state);
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) delete data.email;
  const photo = get('photo');
  if (/^https:\/\/\S+$/i.test(photo)) data.photo = photo.slice(0, 500);
  if (mapping.featured != null && mapping.featured !== '') data.featured = yes(get('featured')) ? 1 : 0;
  const areas = splitAreas(get('practice_areas'));
  return { data, areas };
}

/**
 * Import staged rows. Options:
 *  status: 'active' | 'pending'; mode: 'update' (match existing by email, else name+city) | 'skip' duplicates;
 *  createAreas: add practice areas that don't exist yet.
 */
export function runImport(staged, mapping, { status = 'active', mode = 'update', createAreas = true, verified = false, deleteSample = false } = {}) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [], newAreas: [] };
  const areaByName = new Map(listAreas().map((a) => [a.name.toLowerCase(), a.id]));
  const findArea = (name) => areaByName.get(name.toLowerCase());
  const newArea = (name) => {
    const id = Number(db.prepare('INSERT INTO practice_areas (name, slug) VALUES (?, ?)').run(name.slice(0, 80), uniqueSlug('practice_areas', name)).lastInsertRowid);
    areaByName.set(name.toLowerCase(), id);
    result.newAreas.push(name);
    return id;
  };
  const findByEmail = db.prepare('SELECT id FROM lawyers WHERE email = ? COLLATE NOCASE');
  // Bar numbers are compared ignoring spaces, dashes and case ("P-12345" = "p12345").
  const byBar = new Map();
  for (const r of db.prepare("SELECT id, bar_number FROM lawyers WHERE bar_number IS NOT NULL AND bar_number <> ''").all()) {
    if (normBar(r.bar_number) && !byBar.has(normBar(r.bar_number))) byBar.set(normBar(r.bar_number), { id: r.id });
  }
  const findByNameCity = db.prepare('SELECT id FROM lawyers WHERE name = ? COLLATE NOCASE AND IFNULL(city, \'\') = ? COLLATE NOCASE');

  tx(() => {
    if (deleteSample) result.removedSample = deleteSampleData();
    staged.rows.forEach((row, i) => {
      const line = i + 2; // spreadsheet row number (header is row 1)
      if (row.every((c) => !String(c || '').trim())) return;
      const { data, areas } = rowToLawyer(row, mapping);
      if (!data.name) { result.errors.push(`Row ${line}: no name, skipped.`); result.skipped++; return; }

      const areaIds = [];
      for (const entry of areas) {
        // "Family Law > Divorce" puts the lawyer in the Divorce sub-category of Family Law.
        const [parentName, a] = entry.includes('>') ? entry.split('>').map((x) => x.trim()).slice(-2) : [null, entry];
        if (!a) continue;
        let id = findArea(a);
        if (!id && createAreas) id = newArea(a);
        if (id && parentName) {
          const parentId = findArea(parentName) || (createAreas ? newArea(parentName) : null);
          const current = db.prepare('SELECT parent_id FROM practice_areas WHERE id = ?').get(id);
          if (parentId && !current.parent_id) setAreaParent(id, parentId); // keeps an existing grouping
        }
        if (id) areaIds.push(id);
      }

      const existing = (normBar(data.bar_number) && byBar.get(normBar(data.bar_number)))
        || (data.email && findByEmail.get(data.email)) || findByNameCity.get(data.name, data.city || '');
      if (existing) {
        if (mode === 'skip') { result.skipped++; return; }
        updateLawyer(existing.id, data);
        if (areaIds.length) setAreas(existing.id, areaIds);
        result.updated++;
      } else {
        const id = createLawyer({ ...data, status, verified: verified ? 1 : 0 });
        setAreas(id, areaIds);
        if (normBar(data.bar_number)) byBar.set(normBar(data.bar_number), { id });
        result.created++;
      }
    });
  });
  return result;
}

/** Remove all demo content created by the seed script. */
export function deleteSampleData() {
  return tx(() => {
    const users = db.prepare('SELECT user_id FROM lawyers WHERE is_sample = 1 AND user_id IS NOT NULL').all().map((r) => r.user_id);
    const lawyers = db.prepare('DELETE FROM lawyers WHERE is_sample = 1').run().changes;
    for (const u of users) db.prepare("DELETE FROM users WHERE id = ? AND role = 'lawyer'").run(u);
    const ads = db.prepare('DELETE FROM ads WHERE is_sample = 1').run().changes;
    const posts = db.prepare('DELETE FROM posts WHERE is_sample = 1').run().changes;
    return { lawyers, ads, posts };
  });
}

/**
 * Remove every lawyer listing (with their logins, inquiries, invitations and AI research),
 * optionally all practice areas too, so a fresh import starts clean. Admin accounts are kept.
 */
export function deleteAllLawyers({ areas = false } = {}) {
  return tx(() => {
    const users = db.prepare('SELECT user_id FROM lawyers WHERE user_id IS NOT NULL').all().map((r) => r.user_id);
    const lawyers = db.prepare('DELETE FROM lawyers').run().changes;
    for (const u of users) db.prepare("DELETE FROM users WHERE id = ? AND role = 'lawyer'").run(u);
    const removedAreas = areas ? db.prepare('DELETE FROM practice_areas').run().changes : 0;
    return { lawyers, logins: users.length, areas: removedAreas };
  });
}

export function templateCsv() {
  const headers = ['Name', 'Firm', 'Title', 'Email', 'Phone', 'Website', 'Address', 'City', 'State', 'ZIP', 'Bar Number', 'Bar Admissions',
    'Years Experience', 'Languages', 'Education', 'Practice Areas', 'Fee Structure', 'Hourly Rate', 'Bio', 'Photo URL'];
  const example = ['Jane Example', 'Example Law PLLC', 'Attorney', 'jane@examplelaw.com', '(248) 555-0100', 'https://examplelaw.com', '123 Main St',
    'Southfield', 'MI', '48075', 'P12345', 'Michigan (2010)', '15', 'English, Arabic, Chaldean (Sureth)', 'J.D., Wayne State University',
    'Family Law, Immigration', 'Hourly', '$250', 'Jane represents families in Metro Detroit.', ''];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return `${headers.map(q).join(',')}\n${example.map(q).join(',')}\n`;
}

