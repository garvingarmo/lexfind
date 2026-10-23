// Members-only directory: search, lawyer profiles, the blog and the AI tools need an approved lawyer login
// (or an admin). Switched in Admin → Lawyer profiles → Search results; on by default.
import { db, getSettings } from './db.js';
import { mailEnabled, sendMail } from './mailer.js';
import { renderEmail, detailsBlock } from './emails.js';
import { getLawyer } from './models.js';
import { matchesFor } from './duplicates.js';

export function membersOnly() {
  return getSettings().members_only !== '0';
}

/** Admins, and lawyers whose listing has been approved (status "active"). */
export function isMember(req) {
  return Boolean(req.user && (req.user.role === 'admin' || (req.user.role === 'lawyer' && req.lawyer?.status === 'active')));
}

const wantsJson = (req) => req.path.startsWith('/api/') || req.path.endsWith('.json') || req.get('accept')?.includes('application/json');

/** Route guard: lets members through; sends everyone else to sign in, or explains a pending approval. */
export function requireMember(req, res, next) {
  if (!membersOnly() || isMember(req)) return next();
  const pending = req.user?.role === 'lawyer';
  if (wantsJson(req) || req.method !== 'GET' && !req.is('application/x-www-form-urlencoded')) {
    return res.status(pending ? 403 : 401).json({ error: pending ? 'Your membership is awaiting approval.' : 'Please sign in as a member to use this.' });
  }
  if (pending) return res.status(403).render('members-pending', { title: 'Membership pending', l: req.lawyer });
  if (req.method === 'GET') req.session.returnTo = req.originalUrl;
  req.session.flash = [...(req.session.flash || []), { type: 'info', msg: 'The directory, guides and AI tools are for members only. Please sign in, or register as a lawyer to apply.' }];
  res.redirect('/login');
}

/**
 * Call before changing listing statuses; the returned function emails lawyers whose listing has just
 * become active that they now have member access.
 */
export function watchApprovals(ids, siteUrl) {
  const before = new Map(ids.map((id) => [Number(id), db.prepare('SELECT status FROM lawyers WHERE id = ?').get(id)?.status]));
  return () => {
    if (!mailEnabled() || !membersOnly()) return;
    for (const [id, was] of before) {
      if (was === 'active') continue;
      const l = db.prepare("SELECT l.name, u.email FROM lawyers l JOIN users u ON u.id = l.user_id WHERE l.id = ? AND l.status = 'active'").get(id);
      if (!l) continue;
      sendMail({ to: l.email, ...renderEmail('approved', { name: l.name, login_link: `${siteUrl}/login` }, { siteUrl }) })
        .catch((e) => console.error('approval email failed:', e.message));
    }
  };
}

/**
 * A lawyer registered: email every admin so they can approve them, and confirm receipt to the lawyer.
 * Runs in the background; failures are logged, never shown to the person registering.
 */
export function notifyRegistration(lawyerId, siteUrl, { sameAs = null } = {}) {
  if (!mailEnabled()) return;
  const l = getLawyer('id', lawyerId);
  if (!l) return;
  // Listings this may duplicate (e.g. the lawyer was imported before registering), with a link to merge.
  const dups = matchesFor(l.id);
  if (sameAs && !dups.some((m) => m.lawyer.id === sameAs)) {
    const s = getLawyer('id', sameAs);
    if (s) dups.unshift({ lawyer: s, strength: 'likely', reasons: [] });
  }
  const dupRows = dups.slice(0, 3).map((m) => [
    m.lawyer.id === sameAs ? 'Says they are' : 'Possible duplicate of',
    `${m.lawyer.name} (#${m.lawyer.id}${m.lawyer.city ? `, ${m.lawyer.city}` : ''})${m.reasons.length ? ` — ${m.reasons.join(', ')}` : ''}`,
    `${siteUrl}/admin/merge?a=${m.lawyer.id}&b=${l.id}`,
  ]);
  const tel = (n) => n && `tel:${n.replace(/[^\d+]/g, '')}`;
  const details = detailsBlock([
    ['Name', l.name], ['Firm', l.firm], ['Email', l.email, l.email && `mailto:${l.email}`],
    ['Phone', l.phone && `${l.phone}${l.phone_ext ? ` ext. ${l.phone_ext}` : ''}`, tel(l.phone)], ['Mobile', l.mobile, tel(l.mobile)],
    ['Address', [l.address, l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')], ['Bar number', l.bar_number],
    ['Practice areas', (l.areas || []).map((a) => a.name).join(', ')],
    ...dupRows,
  ]);
  const toAdmins = renderEmail('registration_admin', { lawyer_name: l.name, review_link: `${siteUrl}/admin/lawyers/${l.id}`, applicant_details: details }, { siteUrl });
  for (const { email } of db.prepare("SELECT email FROM users WHERE role = 'admin'").all()) {
    sendMail({ to: email, replyTo: l.email || undefined, ...toAdmins }).catch((e) => console.error('registration email to admin failed:', e.message));
  }
  if (l.email) {
    sendMail({ to: l.email, ...renderEmail('registration_received', { lawyer_name: l.name, profile_link: `${siteUrl}/dashboard/profile` }, { siteUrl }) })
      .catch((e) => console.error('registration confirmation failed:', e.message));
  }
}
