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

router.get('/lawyers', (req, res) => {
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
  const states = db.prepare("SELECT DISTINCT state FROM lawyers WHERE status = 'active' AND state IS NOT NULL ORDER BY state").all().map((r) => r.state);
  const languages = getLanguageOptions();
  const qs = (overrides) => {
    const p = new URLSearchParams();
    const merged = { q: f.q, area: f.area, city: f.city, state: f.state, language: f.language, sort: f.sort, page: f.page, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'sort' && v === search.defaultSort) && !(k === 'page' && v === 1)) p.set(k, v);
    return `/lawyers${p.toString() ? `?${p}` : ''}`;
  };
  res.render('search', {
    title: 'Find a lawyer', f, rows, total, pages: Math.ceil(total / perPage), areas: listAreas({ withLawyersOnly: true }), states, languages,
    ad: pickAd('search_sidebar'), qs,
  });
});

router.get('/practice-areas/:slug', (req, res) => res.redirect(`/lawyers?area=${encodeURIComponent(req.params.slug)}`));

router.get('/lawyers/:slug', (req, res, next) => {
  const lawyer = getLawyer('slug', req.params.slug);
  if (!lawyer) {
    // Old profile address: send visitors (and search engines) to the current one.
    const moved = db.prepare('SELECT l.slug FROM slug_redirects r JOIN lawyers l ON l.id = r.lawyer_id WHERE r.old_slug = ?').get(req.params.slug);
    if (moved) return res.redirect(301, `/lawyers/${moved.slug}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
  }
  const isOwner = req.lawyer && lawyer && req.lawyer.id === lawyer.id;
  if (!lawyer || (lawyer.status !== 'active' && !isOwner && req.user?.role !== 'admin')) return next();
  res.render('lawyer', { title: lawyer.name, lawyer, bioHtml: renderMarkdown(lawyer.bio), ad: pickAd('profile_sidebar'), isOwner, query: req.query, social: lawyerSocial(lawyer) });
});

const inquiryLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
/** Email a new inquiry to the lawyer and/or the admins, per Admin → Lawyer profiles. Runs in the background. */
function notifyInquiry(lawyer, q) {
  if (!mailEnabled()) return;
  const pf = getProfileSettings();
  const to = [];
  if (pf.notify_lawyer && lawyer.email) to.push(lawyer.email);
  if (pf.notify_admin) to.push(...db.prepare("SELECT email FROM users WHERE role = 'admin'").all().map((u) => u.email));
  if (!to.length) return;
  const site = getSettings().site_name;
  const via = q.source === 'assistant' ? ` (via the ${site} AI lawyer match)` : '';
  const text = `New inquiry for ${lawyer.name} from ${site}${via}

Name: ${q.name}
Email: ${q.email}${q.phone ? `\nPhone: ${q.phone}` : ''}

${q.message}

Reply directly to this person by email or phone. This message was sent through your directory listing.`;
  for (const addr of [...new Set(to)]) {
    sendMail({ to: addr, subject: `New inquiry from ${q.name} via ${site}`, text, replyTo: q.email })
      .catch((e) => console.error('inquiry email failed:', e.message));
  }
}

router.post('/lawyers/:slug/contact', inquiryLimit, (req, res, next) => {
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
  notifyInquiry(lawyer, inquiry);
  flash(req, 'success', `Your message was sent to ${lawyer.name}. They will contact you directly.`);
  res.redirect(`/lawyers/${lawyer.slug}`);
});

// --- AI assistant ---------------------------------------------------------

router.get('/assistant', (req, res) => {
  res.render('assistant', { title: 'AI lawyer match', aiOn: aiEnabled(), initial: (req.query.q || '').toString().slice(0, 2000) });
});

const chatLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, message: 'You have sent a lot of messages. Please wait a few minutes and try again.' });
router.post('/api/assistant', chatLimit, async (req, res) => {
  const text = (req.body?.message || '').toString().trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: 'Please describe your legal matter.' });
  let history = req.session.assistant || [];
  if (history.length > 60) history = []; // keep stored sessions bounded
  try {
    const { reply, recommendations, history: next } = await chat(history, text);
    req.session.assistant = next;
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

router.post('/api/assistant/reset', (req, res) => {
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

router.get('/blog', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 9;
  const total = db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'published'").get().n;
  const posts = db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ? OFFSET ?").all(perPage, (page - 1) * perPage);
  res.render('blog', { title: 'Legal guides & news', posts, page, pages: Math.ceil(total / perPage) });
});

router.get('/blog/:slug', (req, res, next) => {
  const post = db.prepare('SELECT * FROM posts WHERE slug = ?').get(req.params.slug);
  if (!post || (post.status !== 'published' && req.user?.role !== 'admin')) return next();
  const recent = db.prepare("SELECT title, slug FROM posts WHERE status = 'published' AND id != ? ORDER BY published_at DESC LIMIT 5").all(post.id);
  res.render('post', { title: post.title, post, html: renderPost(post), recent, ad: pickAd('blog_sidebar') });
});

router.get('/about', (req, res) => {
  res.render('page', { title: 'About', html: renderMarkdown(res.locals.settings.about_body) });
});

export default router;
