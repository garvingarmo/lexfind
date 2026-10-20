// Client referrals between members: a member refers a client to a lawyer from that lawyer's profile.
// The lawyer is emailed the client's details (reply goes to the referring member), the member gets a copy.
import { db, getSettings } from './db.js';
import { mailEnabled, sendMail } from './mailer.js';
import { getProfileSettings } from './profileSettings.js';

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/** Who is referring: the member's own listing details, or the admin's account. */
export function referrer(req) {
  const l = req.lawyer;
  return {
    userId: req.user.id,
    lawyerId: l?.id || null,
    name: l?.name || `${getSettings().site_name} team`,
    firm: l?.firm || '',
    email: req.user.email,
    phone: l?.phone || '',
    slug: l?.slug || null,
  };
}

/** Validate the form; returns { errors, data }. */
export function checkReferral(body) {
  const data = {
    client_name: clean(body.client_name, 120),
    client_email: clean(body.client_email, 200),
    client_phone: clean(body.client_phone, 40),
    matter: clean(body.matter, 3000),
  };
  const errors = [];
  if (!data.client_name) errors.push("the client's name");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.client_email)) errors.push("the client's email address");
  if (data.client_phone.replace(/\D/g, '').length < 7) errors.push("the client's phone number");
  if (!body.consent) errors.push('confirmation that the client agreed to be referred');
  return { errors, data };
}

export function saveReferral(to, from, data) {
  return Number(db.prepare(`INSERT INTO referrals (to_lawyer_id, from_user_id, from_lawyer_id, from_name, from_email,
      client_name, client_email, client_phone, matter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(to.id, from.userId, from.lawyerId, from.name, from.email, data.client_name, data.client_email, data.client_phone, data.matter || null)
    .lastInsertRowid);
}

/**
 * Email the referral to the lawyer (reply-to the referring member), a copy to the member, and to the
 * admins when Admin → Lawyer profiles asks for inquiry copies. Resolves to true when the lawyer was emailed.
 */
export async function sendReferral(id, to, from, data, siteUrl) {
  if (!mailEnabled()) return false;
  const site = getSettings().site_name;
  const fromLine = [from.name, from.firm].filter(Boolean).join(', ');
  const fromContact = [from.email, from.phone].filter(Boolean).join(' · ');
  const details = `Client: ${data.client_name}
Email: ${data.client_email}
Phone: ${data.client_phone}
${data.matter ? `\nAbout the matter:\n${data.matter}\n` : ''}`;
  const fromProfile = from.slug ? `\nReferring member's profile: ${siteUrl}/lawyers/${from.slug}` : '';
  const sends = [];
  let toLawyer = false;

  if (to.email) {
    toLawyer = true;
    sends.push(sendMail({
      to: to.email,
      replyTo: from.email,
      subject: `Client referral from ${from.name} via ${site}`,
      text: `Hello ${to.name},

${fromLine} has referred a client to you through ${site}.

${details}
Referred by: ${fromLine}
Contact: ${fromContact}${fromProfile}

Please contact the client directly. Reply to this email to reach ${from.name}.

Your referrals: ${siteUrl}/dashboard/referrals`,
    }));
  }
  sends.push(sendMail({
    to: from.email,
    subject: `Your referral of ${data.client_name} to ${to.name}`,
    text: `You referred a client to ${to.name}${to.firm ? ` (${to.firm})` : ''} through ${site}.

${details}
${toLawyer ? `${to.name} has been emailed these details.` : `${to.name} has no email address on file, so our team has been asked to pass this on.`}

Lawyer's profile: ${siteUrl}/lawyers/${to.slug}`,
  }));
  if (getProfileSettings().notify_admin || !to.email) {
    for (const { email } of db.prepare("SELECT email FROM users WHERE role = 'admin'").all()) {
      if (email === from.email) continue;
      sends.push(sendMail({
        to: email,
        replyTo: from.email,
        subject: `Referral: ${from.name} → ${to.name}${to.email ? '' : ' (lawyer has no email; please forward)'}`,
        text: `${fromLine} (${fromContact}) referred a client to ${to.name} (${siteUrl}/lawyers/${to.slug}).\n\n${details}`,
      }));
    }
  }
  const results = await Promise.allSettled(sends);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error('referral email failed:', r.reason?.message));
  const lawyerOk = toLawyer && results[0].status === 'fulfilled';
  if (lawyerOk) db.prepare('UPDATE referrals SET emailed = 1 WHERE id = ?').run(id);
  return lawyerOk;
}

const LIST_SQL = `SELECT r.*, t.name AS to_name, t.slug AS to_slug, f.slug AS from_slug
  FROM referrals r JOIN lawyers t ON t.id = r.to_lawyer_id LEFT JOIN lawyers f ON f.id = r.from_lawyer_id`;

export const referralsReceived = (lawyerId) => db.prepare(`${LIST_SQL} WHERE r.to_lawyer_id = ? ORDER BY r.created_at DESC LIMIT 200`).all(lawyerId);
export const referralsSent = (userId) => db.prepare(`${LIST_SQL} WHERE r.from_user_id = ? ORDER BY r.created_at DESC LIMIT 200`).all(userId);
export const allReferrals = () => db.prepare(`${LIST_SQL} ORDER BY r.created_at DESC LIMIT 300`).all();
