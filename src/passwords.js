// "Forgot password" links. Only a hash of each token is stored; links expire after an hour and work once.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, tx, getSettings } from './db.js';
import { sendMail } from './mailer.js';
import { baseUrl } from './invites.js';

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Email a reset link if the address belongs to an account. Silent otherwise, so emails can't be probed. */
export async function requestReset(email, req) {
  const user = db.prepare('SELECT id, email FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user) return;
  const recent = db.prepare("SELECT COUNT(*) n FROM password_resets WHERE user_id = ? AND created_at > datetime('now', '-1 hour')").get(user.id).n;
  if (recent >= 5) return;
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+1 hour'))").run(user.id, hash(token));
  const site = getSettings().site_name;
  const url = `${baseUrl(req)}/reset-password/${token}`;
  await sendMail({
    to: user.email,
    subject: `Reset your ${site} password`,
    text: `Someone asked to reset the password for your ${site} account.\n\nChoose a new password here:\n${url}\n\nThis link works once and expires in 1 hour. If you didn't ask for this, ignore this email; your password stays the same.\n\n${site}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2333;max-width:560px">
<p>Someone asked to reset the password for your <strong>${site}</strong> account.</p>
<p style="margin:28px 0"><a href="${url}" style="background:#1f3a5f;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Choose a new password</a></p>
<p style="font-size:13px;color:#5d6677">Or copy this link into your browser:<br><a href="${url}">${url}</a></p>
<p style="font-size:13px;color:#5d6677">This link works once and expires in 1 hour. If you didn't ask for this, ignore this email; your password stays the same.</p></div>`,
  });
}

/** Returns the pending reset for a token, or null if it is unknown, used or expired. */
export function findReset(token) {
  if (typeof token !== 'string' || token.length > 100) return null;
  return db.prepare("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')").get(hash(token)) || null;
}

/** Set a user's password and sign them out everywhere else. */
export function setPassword(userId, password) {
  tx(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), userId);
    db.prepare("UPDATE password_resets SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(userId);
    db.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"userId":${Number(userId)},%`);
    db.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"userId":${Number(userId)}}`);
  });
}
