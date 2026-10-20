// First-run setup shared by the seed script and server start-up:
// the default practice areas and the first admin account.
import bcrypt from 'bcryptjs';
import { db, slugify } from './db.js';

export const AREAS = [
  ['Family Law', 'Divorce, child custody and support, adoption, prenuptial agreements'],
  ['Criminal Defense', 'DUI, misdemeanors, felonies, juvenile cases, expungement'],
  ['Personal Injury', 'Car accidents, slip and fall, medical malpractice, wrongful death'],
  ['Immigration', 'Visas, green cards, citizenship, asylum, deportation defense'],
  ['Employment Law', 'Wrongful termination, discrimination, harassment, unpaid wages'],
  ['Estate Planning', 'Wills, trusts, probate, powers of attorney, elder law'],
  ['Real Estate', 'Purchases and sales, landlord-tenant disputes, evictions, title issues'],
  ['Business Law', 'Business formation, contracts, partnerships, mergers, compliance'],
  ['Bankruptcy', 'Chapter 7 and 13, debt relief, foreclosure defense, creditor harassment'],
  ['Intellectual Property', 'Patents, trademarks, copyrights, licensing, infringement'],
  ['Tax Law', 'IRS audits, tax debt, business tax planning, tax disputes'],
];

/** Add the default practice areas (existing ones are left alone). */
export function ensureAreas() {
  const ins = db.prepare('INSERT OR IGNORE INTO practice_areas (name, slug, description) VALUES (?, ?, ?)');
  for (const [name, desc] of AREAS) ins.run(name, slugify(name), desc);
}

export function ensureUser(email, role, password) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return { id: existing.id, created: false };
  const id = Number(db.prepare('INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)').run(email, bcrypt.hashSync(password, 10), role).lastInsertRowid);
  return { id, created: true };
}

/**
 * On a brand-new database, set up practice areas and create the admin from
 * ADMIN_EMAIL / ADMIN_PASSWORD, so hosts without a terminal need no seed step.
 */
export function bootstrapIfEmpty() {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return;
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = process.env;
  if (!email || !password) {
    console.warn('No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart, or run `npm run seed`.');
    return;
  }
  if (password.length < 8) {
    console.warn('ADMIN_PASSWORD must be at least 8 characters; no admin account was created.');
    return;
  }
  if (!db.prepare('SELECT 1 FROM practice_areas LIMIT 1').get()) ensureAreas();
  ensureUser(email, 'admin', password);
  console.log(`Created admin account ${email}.`);
}
