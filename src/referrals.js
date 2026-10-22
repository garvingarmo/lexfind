// Client referrals between members: a member refers a client to a lawyer from that lawyer's profile.
// The lawyer is emailed the client's details (reply goes to the referring member), the member gets a copy.
import { db, getSettings } from './db.js';
import { mailEnabled, sendMail } from './mailer.js';
import { getProfileSettings } from './profileSettings.js';
import { renderEmail, detailsBlock, quoteBlock } from './emails.js';

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
  const member = [from.name, from.firm].filter(Boolean).join(', ');
  const lawyer = [to.name, to.firm].filter(Boolean).join(', ');
  const lawyerLink = `${siteUrl}/lawyers/${to.slug}`;
  const tel = (n) => n && `tel:${n.replace(/[^\d+]/g, '')}`;
  const common = {
    lawyer_name: to.name, lawyer, member_name: from.name, member, client_name: data.client_name, lawyer_link: lawyerLink,
    client_details: detailsBlock([['Client', data.client_name], ['Email', data.client_email, `mailto:${data.client_email}`], ['Phone', data.client_phone, tel(data.client_phone)]]),
    matter: quoteBlock(data.matter, 'About the matter'),
    member_details: detailsBlock([
      ['Referred by', member, from.slug && `${siteUrl}/lawyers/${from.slug}`],
      ['Email', from.email, `mailto:${from.email}`], ['Phone', from.phone, tel(from.phone)],
    ]),
  };
  const sends = [];
  const toLawyer = Boolean(to.email);

  if (toLawyer) {
    sends.push(sendMail({ to: to.email, replyTo: from.email, ...renderEmail('referral_lawyer', { ...common, referrals_link: `${siteUrl}/dashboard/referrals` }, { siteUrl }) }));
  }
  sends.push(sendMail({
    to: from.email,
    ...renderEmail('referral_copy', {
      ...common,
      delivery_note: toLawyer ? `${to.name} has been emailed these details.` : `${to.name} has no email address on file, so our team has been asked to pass this on.`,
    }, { siteUrl }),
  }));
  if (getProfileSettings().notify_admin || !toLawyer) {
    const adminEmail = renderEmail('referral_admin', {
      ...common,
      delivery_note: toLawyer ? '' : `${to.name} has no email address on file — please forward this referral to them.`,
    }, { siteUrl });
    for (const { email } of db.prepare("SELECT email FROM users WHERE role = 'admin'").all()) {
      if (email === from.email) continue;
      sends.push(sendMail({ to: email, replyTo: from.email, ...adminEmail }));
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
