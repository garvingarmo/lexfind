// Members-only directory: search, lawyer profiles, the blog and the AI tools need an approved lawyer login
// (or an admin). Switched in Admin → Lawyer profiles → Search results; on by default.
import { db, getSettings } from './db.js';
import { mailEnabled, sendMail } from './mailer.js';
import { renderEmail } from './emails.js';

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
