// Invitation links that let an existing (e.g. imported) lawyer listing be claimed:
// the lawyer opens a one-time link, sets a password, and gets a login tied to that listing.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, tx, getSettings } from './db.js';
import { getLawyer } from './models.js';
import { mailEnabled, sendMail } from './mailer.js';
import { renderEmail } from './emails.js';

export { mailEnabled };

export const INVITE_DAYS = 30;

/** Public base URL for links: PUBLIC_URL if set, otherwise the address the admin is using. */
export function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const host = req.get('x-forwarded-host') || req.get('host');
  const proto = req.get('x-forwarded-proto')?.split(',')[0] || req.protocol;
  return `${proto}://${host}`;
}

export const inviteUrl = (req, token) => `${baseUrl(req)}/invite/${token}`;

/** Create a fresh invite for a lawyer, revoking any earlier unused ones. */
export function createInvite(lawyerId, adminId) {
  const token = crypto.randomBytes(24).toString('base64url');
  const lawyer = getLawyer('id', lawyerId);
  return tx(() => {
    db.prepare('UPDATE invites SET revoked = 1 WHERE lawyer_id = ? AND used_at IS NULL').run(lawyerId);
    const id = Number(db.prepare(`INSERT INTO invites (lawyer_id, token, email, created_by, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', ?))`).run(lawyerId, token, lawyer?.email || null, adminId, `+${INVITE_DAYS} days`).lastInsertRowid);
    return getInviteById(id);
  });
}

export function getInviteById(id) {
  return db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
}

/** The current usable invite for a lawyer, if any. */
export function activeInvite(lawyerId) {
  return db.prepare(`SELECT * FROM invites WHERE lawyer_id = ? AND used_at IS NULL AND revoked = 0
    AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`).get(lawyerId);
}

/** Look up an invite by token; returns { invite, lawyer, problem } where problem explains why it can't be used. */
export function checkInvite(token) {
  const invite = typeof token === 'string' && token.length < 100 ? db.prepare('SELECT * FROM invites WHERE token = ?').get(token) : null;
  if (!invite) return { problem: 'This invitation link is not valid. Please check you copied the whole link, or ask us for a new one.' };
  const lawyer = getLawyer('id', invite.lawyer_id);
  if (!lawyer) return { problem: 'The listing for this invitation no longer exists.' };
  if (invite.used_at || lawyer.user_id) return { invite, lawyer, problem: 'This listing has already been claimed. Please sign in instead.', claimed: true };
  if (invite.revoked) return { invite, lawyer, problem: 'This invitation link has been replaced by a newer one. Please use the most recent link we sent you.' };
  if (invite.expires_at <= db.prepare("SELECT datetime('now') AS n").get().n) return { invite, lawyer, problem: 'This invitation link has expired. Please contact us for a new one.' };
  return { invite, lawyer };
}

/** Create the lawyer's login and link it to the listing. Returns the new user id. */
export function acceptInvite(invite, email, password) {
  return tx(() => {
    const lawyer = getLawyer('id', invite.lawyer_id);
    if (lawyer.user_id) throw new Error('This listing has already been claimed.');
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new Error('An account with this email already exists. Sign in, or use a different email.');
    const userId = Number(db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'lawyer')").run(email, bcrypt.hashSync(password, 10)).lastInsertRowid);
    db.prepare("UPDATE lawyers SET user_id = ?, updated_at = datetime('now') WHERE id = ?").run(userId, lawyer.id);
    db.prepare("UPDATE lawyers SET email = ? WHERE id = ? AND (email IS NULL OR email = '')").run(email, lawyer.id);
    db.prepare("UPDATE invites SET used_at = datetime('now') WHERE id = ?").run(invite.id);
    return userId;
  });
}

/** Login status for each lawyer, for admin lists: 'login' | 'invited' | 'expired' | 'none'. */
export function inviteStatuses() {
  const rows = db.prepare(`SELECT l.id, l.user_id,
      (SELECT MAX(expires_at) FROM invites i WHERE i.lawyer_id = l.id AND i.used_at IS NULL AND i.revoked = 0) AS expires_at,
      (SELECT MAX(sent_at) FROM invites i WHERE i.lawyer_id = l.id AND i.used_at IS NULL AND i.revoked = 0) AS sent_at
    FROM lawyers l`).all();
  const now = db.prepare("SELECT datetime('now') AS n").get().n;
  return new Map(rows.map((r) => [r.id, {
    status: r.user_id ? 'login' : r.expires_at ? (r.expires_at > now ? 'invited' : 'expired') : 'none',
    sent_at: r.sent_at,
    expires_at: r.expires_at,
  }]));
}

// --- Email ------------------------------------------------------------------

export function inviteEmail(lawyer, url, expiresAt) {
  const expires = new Date(`${expiresAt.replace(' ', 'T')}Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return renderEmail('invite', { lawyer_name: lawyer.name, claim_link: url, expires }, { siteUrl: url.replace(/\/invite\/.*$/, '') });
}

export async function sendInvite(invite, req) {
  const lawyer = getLawyer('id', invite.lawyer_id);
  if (!invite.email) throw new Error(`${lawyer.name} has no email address.`);
  const { subject, text, html } = inviteEmail(lawyer, inviteUrl(req, invite.token), invite.expires_at);
  await sendMail({ to: invite.email, subject, text, html });
  db.prepare("UPDATE invites SET sent_at = datetime('now') WHERE id = ?").run(invite.id);
}

/** Send several invitations one after another in the background, spaced out to respect mail-server limits. */
export function sendInBackground(invites, req) {
  const base = { get: (h) => req.get(h), protocol: req.protocol };
  (async () => {
    for (const inv of invites) {
      try { await sendInvite(inv, base); } catch (e) { console.error(`[invite ${inv.id}] email failed:`, e.message); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
}
