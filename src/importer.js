// Bulk import of lawyer listings from a spreadsheet (Google Sheets link or CSV upload).
// Flow: load rows -> store them in a temporary file -> admin maps columns and previews -> import.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { db, tx, ROOT, uniqueSlug } from './db.js';
import { createLawyer, updateLawyer, setAreas, cleanLawyerInput, listAreas } from './models.js';
import { STATES } from './ai/agent.js';

const importDir = path.join(ROOT, 'data', 'imports');
fs.mkdirSync(importDir, { recursive: true });

/** Directory fields a spreadsheet column can be mapped to, with header names we recognise automatically. */
export const IMPORT_FIELDS = [
  ['name', 'Full name', ['name', 'full name', 'lawyer', 'lawyer name', 'attorney', 'attorney name']],
  ['first_name', 'First name', ['first name', 'first', 'firstname', 'given name']],
  ['last_name', 'Last name', ['last name', 'last', 'lastname', 'surname', 'family name']],
  ['firm', 'Firm', ['firm', 'law firm', 'firm name', 'company', 'office', 'practice name']],
  ['title', 'Professional title', ['title', 'position', 'job title', 'role']],
  ['email', 'Email', ['email', 'e-mail', 'email address']],
  ['phone', 'Phone', ['phone', 'telephone', 'phone number', 'tel', 'mobile', 'cell', 'office phone']],
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
  ['fee_structure', 'Fee structure', ['fees', 'fee structure', 'fee', 'billing']],
  ['hourly_rate', 'Hourly rate', ['hourly rate', 'rate', 'hourly']],
  ['free_consultation', 'Free consultation (yes/no)', ['free consultation', 'free consult', 'consultation']],
  ['photo', 'Photo URL', ['photo', 'photo url', 'image', 'image url', 'headshot', 'picture']],
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

/** Convert one spreadsheet row into listing data using the column mapping. */
export function rowToLawyer(row, mapping) {
  const get = (key) => (mapping[key] != null && mapping[key] !== '' ? String(row[mapping[key]] ?? '').trim() : '');
  const name = get('name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ');
  const raw = {};
  for (const [key] of IMPORT_FIELDS) if (!['name', 'first_name', 'last_name', 'practice_areas', 'photo', 'featured'].includes(key)) raw[key] = get(key);
  raw.name = name;
  raw.free_consultation = yes(get('free_consultation')) ? '1' : '';
  if (raw.years_experience) raw.years_experience = (raw.years_experience.match(/\d+/) || [''])[0];
  const data = cleanLawyerInput(raw);
  if (mapping.free_consultation == null || mapping.free_consultation === '') delete data.free_consultation;
  for (const k of Object.keys(data)) if (data[k] === null || data[k] === '') delete data[k];
  if (data.state) data.state = normState(data.state);
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) delete data.email;
  const photo = get('photo');
  if (/^https:\/\/\S+$/i.test(photo)) data.photo = photo.slice(0, 500);
  if (mapping.featured != null && mapping.featured !== '') data.featured = yes(get('featured')) ? 1 : 0;
  const areas = get('practice_areas').split(/[,;|\/\n]+/).map((a) => a.trim()).filter(Boolean);
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
  const findByEmail = db.prepare('SELECT id FROM lawyers WHERE email = ? COLLATE NOCASE');
  const findByNameCity = db.prepare('SELECT id FROM lawyers WHERE name = ? COLLATE NOCASE AND IFNULL(city, \'\') = ? COLLATE NOCASE');

  tx(() => {
    if (deleteSample) result.removedSample = deleteSampleData();
    staged.rows.forEach((row, i) => {
      const line = i + 2; // spreadsheet row number (header is row 1)
      if (row.every((c) => !String(c || '').trim())) return;
      const { data, areas } = rowToLawyer(row, mapping);
      if (!data.name) { result.errors.push(`Row ${line}: no name, skipped.`); result.skipped++; return; }

      const areaIds = [];
      for (const a of areas) {
        let id = areaByName.get(a.toLowerCase());
        if (!id && createAreas) {
          id = Number(db.prepare('INSERT INTO practice_areas (name, slug) VALUES (?, ?)').run(a.slice(0, 80), uniqueSlug('practice_areas', a)).lastInsertRowid);
          areaByName.set(a.toLowerCase(), id);
          result.newAreas.push(a);
        }
        if (id) areaIds.push(id);
      }

      const existing = (data.email && findByEmail.get(data.email)) || findByNameCity.get(data.name, data.city || '');
      if (existing) {
        if (mode === 'skip') { result.skipped++; return; }
        updateLawyer(existing.id, data);
        if (areaIds.length) setAreas(existing.id, areaIds);
        result.updated++;
      } else {
        const id = createLawyer({ ...data, status, verified: verified ? 1 : 0 });
        setAreas(id, areaIds);
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

export function templateCsv() {
  const headers = ['Name', 'Firm', 'Title', 'Email', 'Phone', 'Website', 'Address', 'City', 'State', 'ZIP', 'Bar Number', 'Bar Admissions',
    'Years Experience', 'Languages', 'Education', 'Practice Areas', 'Free Consultation', 'Fee Structure', 'Hourly Rate', 'Bio', 'Photo URL'];
  const example = ['Jane Example', 'Example Law PLLC', 'Attorney', 'jane@examplelaw.com', '(248) 555-0100', 'https://examplelaw.com', '123 Main St',
    'Southfield', 'MI', '48075', 'P12345', 'Michigan (2010)', '15', 'English, Arabic, Chaldean (Sureth)', 'J.D., Wayne State University',
    'Family Law, Immigration', 'Yes', 'Hourly', '$250', 'Jane represents families in Metro Detroit.', ''];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  return `${headers.map(q).join(',')}\n${example.map(q).join(',')}\n`;
}

