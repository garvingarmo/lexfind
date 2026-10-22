import { Router } from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { db } from '../db.js';
import { searchLawyers, getLawyer, listAreas, pickAd, featuredLawyers } from '../models.js';
import { flash, rateLimit } from '../middleware.js';
import { chat } from '../ai/agent.js';
import { aiEnabled } from '../ai/client.js';
import { getSections } from '../homepage.js';
import { lawyerSocial } from '../social.js';
import { getLanguageOptions } from '../languages.js';
import { getProfileSettings, getSearchSettings } from '../profileSettings.js';
import { mailEnabled, sendMail } from '../mailer.js';
import { getSettings } from '../db.js';
import { exportRows, allMatchingIds, buildPdf, resultsEmail, recentShares, logShare, MAX_EXPORT } from '../exportResults.js';
import { baseUrl } from '../invites.js';
import { requireMember, isMember } from '../members.js';
import { track } from '../stats.js';
import { renderEmail, detailsBlock, quoteBlock } from '../emails.js';
import { referrer, checkReferral, saveReferral, sendReferral } from '../referrals.js';

const router = Router();

const SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2']),
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
};

export const cleanHtml = (html) => sanitizeHtml(html || '', SANITIZE).replace(/<(p|b|strong|em|i|u)>\s*<\/\1>/g, '').replace(/<(p|b|strong|em|i|u)>\s*<\/\1>/g, '');
export const renderMarkdown = (md) => cleanHtml(marked.parse(md || ''));
/** Blog posts written in the visual editor are HTML; older ones are Markdown. */
export const renderPost = (post) => (post.format === 'html' ? cleanHtml(post.body) : renderMarkdown(post.body));

router.get('/', (req, res) => {
  const posts = db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 3").all();
  const states = db.prepare("SELECT DISTINCT state FROM lawyers WHERE status = 'active' AND state IS NOT NULL ORDER BY state").all().map((r) => r.state);
  res.render('index', {
    title: null, areas: listAreas({ withLawyersOnly: true }), featured: featuredLawyers(4), posts, states,
    ad: pickAd('home_banner'), aiOn: aiEnabled(), sections: getSections(),
  });
});

router.get('/lawyers', requireMember, (req, res) => {
  const search = getSearchSettings();
  const f = {
    q: (req.query.q || '').toString().slice(0, 200),
    area: (req.query.area || '').toString(),
    city: (req.query.city || '').toString().slice(0, 80),
    state: (req.query.state || '').toString().slice(0, 2),
    language: (req.query.language || '').toString().slice(0, 40),
    sort: (req.query.sort || search.defaultSort).toString(),
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
  };
  const perPage = 12;
  const { rows, total } = searchLawyers({ ...f, sponsoredFirst: search.sponsoredFirst, perPage });
  if (f.page === 1) track('search', { user: req.user, detail: { q: f.q, area: f.area, city: f.city, state: f.state, language: f.language, results: total } });
  const states = db.prepare("SELECT DISTINCT state FROM lawyers WHERE status = 'active' AND state IS NOT NULL ORDER BY state").all().map((r) => r.state);
  const languages = getLanguageOptions();
  const qs = (overrides) => {
    const p = new URLSearchParams();
    const merged = { q: f.q, area: f.area, city: f.city, state: f.state, language: f.language, sort: f.sort, page: f.page, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'sort' && v === search.defaultSort) && !(k === 'page' && v === 1)) p.set(k, v);
    return `/lawyers${p.toString() ? `?${p}` : ''}`;
  };
  res.render('search', {
    title: 'Find a lawyer', f, rows, total, mailOn: mailEnabled(), maxExport: MAX_EXPORT, pages: Math.ceil(total / perPage), areas: listAreas({ withLawyersOnly: true }), states, languages,
    ad: pickAd('search_sidebar'), qs,
  });
});

// --- Selected results: select all, PDF export, email ----------------------------------

function searchFilters(src) {
  return {
    q: (src.q || '').toString().slice(0, 200),
    area: (src.area || '').toString(),
    city: (src.city || '').toString().slice(0, 80),
    state: (src.state || '').toString().slice(0, 2),
    language: (src.language || '').toString().slice(0, 40),
  };
}

const selectedIds = (body) => [].concat(body.ids || []).flatMap((v) => String(v).split(',')).map(Number).filter(Boolean).slice(0, MAX_EXPORT);

// Ids of every lawyer matching the current filters, for "Select all N results".
router.get('/lawyers-select-all.json', requireMember, (req, res) => {
  res.json({ ids: allMatchingIds(searchLawyers, searchFilters(req.query)), max: MAX_EXPORT });
});

const exportLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'Too many exports. Please wait a few minutes.' });
router.post('/lawyers/export.pdf', requireMember, exportLimit, async (req, res) => {
  const rows = exportRows(selectedIds(req.body), baseUrl(req));
  if (!rows.length) {
    flash(req, 'error', 'Select at least one lawyer to export.');
    return res.redirect('/lawyers');
  }
  const pdf = await buildPdf(rows, { referredBy: referrer(req) });
  const stamp = new Date().toISOString().slice(0, 10);
  track('pdf_export', { user: req.user, detail: { lawyers: rows.length } });
  res.type('application/pdf').attachment(`lawyers-${stamp}.pdf`).send(pdf);
});

const shareLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'You have sent several emails already. Please try again later.' });
router.post('/lawyers/email-results', requireMember, shareLimit, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot
  const to = String(b.to || '').trim();
  const fromName = String(b.from_name || '').trim().slice(0, 80);
  const note = String(b.note || '').trim().slice(0, 500);
  if (!mailEnabled()) return res.status(503).json({ error: 'Emailing results is not available on this site yet.' });
  if (!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(to) || to.length > 200) return res.status(400).json({ error: 'Please enter one valid email address.' });
  if (recentShares(req.ip) >= 5) return res.status(429).json({ error: 'You have sent several emails already. Please try again later.' });
  const rows = exportRows(selectedIds(b), baseUrl(req));
  if (!rows.length) return res.status(400).json({ error: 'Select at least one lawyer first.' });
  try {
    const { subject, text, html } = resultsEmail(rows, { fromName, note, siteUrl: baseUrl(req) });
    const pdf = await buildPdf(rows, { note, referredBy: referrer(req) });
    await sendMail({ to, subject, text, html, attachments: [{ filename: 'lawyers.pdf', content: pdf, contentType: 'application/pdf' }] });
    logShare(req.ip, to, rows.length);
    track('email_results', { user: req.user, detail: { lawyers: rows.length } });
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    console.error('email results failed:', e.message);
    res.status(502).json({ error: 'The email could not be sent right now. Please try again, or use Export PDF instead.' });
  }
});

router.get('/practice-areas/:slug', requireMember, (req, res) => res.redirect(`/lawyers?area=${encodeURIComponent(req.params.slug)}`));

// A lawyer can always see their own profile, even before approval.
const ownProfileOrMember = (req, res, next) => (req.lawyer && req.lawyer.slug === req.params.slug ? next() : requireMember(req, res, next));

router.get('/lawyers/:slug', ownProfileOrMember, (req, res, next) => {
  const lawyer = getLawyer('slug', req.params.slug);
  if (!lawyer) {
    // Old profile address: send visitors (and search engines) to the current one.
    const moved = db.prepare('SELECT l.slug FROM slug_redirects r JOIN lawyers l ON l.id = r.lawyer_id WHERE r.old_slug = ?').get(req.params.slug);
    if (moved) return res.redirect(301, `/lawyers/${moved.slug}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  }
  const isOwner = req.lawyer && lawyer && req.lawyer.id === lawyer.id;
  if (!lawyer || (lawyer.status !== 'active' && !isOwner && req.user?.role !== 'admin')) return next();
  if (!isOwner) track('profile_view', { user: req.user, lawyerId: lawyer.id });
  res.render('lawyer', { title: lawyer.name, lawyer, canRefer: isMember(req) && !isOwner && lawyer.status === 'active', referDraft: (() => { const d = req.session.referDraft || {}; delete req.session.referDraft; return d; })(), bioHtml: renderMarkdown(lawyer.bio), ad: pickAd('profile_sidebar'), isOwner, query: req.query, social: lawyerSocial(lawyer) });
});

const inquiryLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
/** Email a new inquiry to the lawyer and/or the admins, per Admin → Lawyer profiles. Runs in the background. */
function notifyInquiry(lawyer, q, siteUrl) {
  if (!mailEnabled()) return;
  const pf = getProfileSettings();
  const to = [];
  if (pf.notify_lawyer && lawyer.email) to.push(lawyer.email);
  if (pf.notify_admin) to.push(...db.prepare("SELECT email FROM users WHERE role = 'admin'").all().map((u) => u.email));
  if (!to.length) return;
  const email = renderEmail('inquiry', {
    lawyer_name: lawyer.name,
    sender_name: q.name,
    via: q.source === 'assistant' ? ' (from the AI lawyer match)' : '',
    sender_details: detailsBlock([['Name', q.name], ['Email', q.email, `mailto:${q.email}`], ['Phone', q.phone, q.phone && `tel:${q.phone.replace(/[^\d+]/g, '')}`]]),
    message: quoteBlock(q.message, 'Message'),
  }, { siteUrl });
  for (const addr of [...new Set(to)]) {
    sendMail({ to: addr, ...email, replyTo: q.email })
      .catch((e) => console.error('inquiry email failed:', e.message));
  }
}

router.post('/lawyers/:slug/contact', requireMember, inquiryLimit, (req, res, next) => {
  const lawyer = getLawyer('slug', req.params.slug);
  if (!lawyer || lawyer.status !== 'active') return next();
  const { name, email, phone, message, website } = req.body;
  if (website) return res.redirect(`/lawyers/${lawyer.slug}`); // honeypot
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || !message?.trim()) {
    flash(req, 'error', 'Please enter your name, a valid email and a message.');
    return res.redirect(`/lawyers/${lawyer.slug}#contact`);
  }
  const inquiry = {
    name: name.trim().slice(0, 120), email: email.trim().slice(0, 200), phone: (phone || '').trim().slice(0, 40),
    message: message.trim().slice(0, 5000), source: req.body.source === 'assistant' ? 'assistant' : 'profile',
  };
  db.prepare('INSERT INTO inquiries (lawyer_id, name, email, phone, message, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lawyer.id, inquiry.name, inquiry.email, inquiry.phone, inquiry.message, inquiry.source);
  notifyInquiry(lawyer, inquiry, baseUrl(req));
  track('inquiry', { user: req.user, lawyerId: lawyer.id });
  flash(req, 'success', `Your message was sent to ${lawyer.name}. They will contact you directly.`);
  res.redirect(`/lawyers/${lawyer.slug}`);
});

const referLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: 'You have sent a lot of referrals. Please wait a while and try again.' });
router.post('/lawyers/:slug/refer', requireMember, referLimit, async (req, res, next) => {
  const lawyer = getLawyer('slug', req.params.slug);
  if (!lawyer || lawyer.status !== 'active') return next();
  const back = `/lawyers/${lawyer.slug}`;
  if (req.lawyer && req.lawyer.id === lawyer.id) { flash(req, 'error', 'You cannot refer a client to yourself.'); return res.redirect(back); }
  const { errors, data } = checkReferral(req.body);
  if (errors.length) {
    req.session.referDraft = req.body;
    flash(req, 'error', `Please add ${errors.join(', ')}.`);
    return res.redirect(`${back}#refer`);
  }
  const from = referrer(req);
  const id = saveReferral(lawyer, from, data);
  track('referral', { user: req.user, lawyerId: lawyer.id });
  let emailed = false;
  try { emailed = await sendReferral(id, lawyer, from, data, baseUrl(req)); } catch (e) { console.error('referral email failed:', e.message); }
  flash(req, 'success', emailed
    ? `Referral sent. ${lawyer.name} has been emailed ${data.client_name}'s details, and you've been sent a copy.`
    : `Referral saved. ${lawyer.name} will see it on their dashboard${lawyer.email ? '' : ', and our team has been asked to pass it on'}.`);
  res.redirect(back);
});

// --- AI assistant ---------------------------------------------------------

router.get('/assistant', requireMember, (req, res) => {
  res.render('assistant', { title: 'AI lawyer match', aiOn: aiEnabled(), initial: (req.query.q || '').toString().slice(0, 2000) });
});

const chatLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'You have sent a lot of messages. Please wait a few minutes and try again.' });
router.post('/api/assistant', requireMember, chatLimit, async (req, res) => {
  const text = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Please describe your legal matter.' });
  let history = req.session.assistant || [];
  if (history.length > 60) history = []; // keep stored sessions bounded
  try {
    const { reply, recommendations, history: next } = await chat(history, text);
    req.session.assistant = next;
    track('ai_message', { user: req.user, detail: { recommended: recommendations.length } });
    res.json({
      reply,
      recommendations: recommendations.map(({ lawyer: l, reason }) => ({
        reason, name: l.name, firm: l.firm, slug: l.slug, city: l.city, state: l.state, photo: l.photo,
        years_experience: l.years_experience, verified: !!l.verified,
        languages: l.languages, areas: l.areas.map((a) => a.name),
      })),
    });
  } catch (e) {
    console.error('assistant error', e);
    res.status(502).json({ error: 'The assistant is temporarily unavailable. You can still search the directory.' });
  }
});

router.post('/api/assistant/reset', requireMember, (req, res) => {
  req.session.assistant = [];
  res.json({ ok: true });
});

// --- Ads ------------------------------------------------------------------

router.get('/ad/:id', (req, res, next) => {
  const ad = db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return next();
  db.prepare('UPDATE ads SET clicks = clicks + 1 WHERE id = ?').run(ad.id);
  res.redirect(ad.link_url);
});

// --- Blog & pages ---------------------------------------------------------

router.get('/blog', requireMember, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 9;
  const total = db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'published'").get().n;
  const posts = db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ? OFFSET ?").all(perPage, (page - 1) * perPage);
  res.render('blog', { title: 'Legal guides & news', posts, page, pages: Math.ceil(total / perPage) });
});

router.get('/blog/:slug', requireMember, (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  if (!post || (post.status !== 'published' && req.user?.role !== 'admin')) return next();
  const recent = db.prepare("SELECT title, slug FROM posts WHERE status = 'published' AND id != ? ORDER BY published_at DESC LIMIT 5").all(post.id);
  res.render('post', { title: post.title, post, html: renderPost(post), recent, ad: pickAd('blog_sidebar') });
});

router.get('/about', (req, res) => {
  res.render('page', { title: 'About', html: renderMarkdown(res.locals.settings.about_body) });
});

export default router;
