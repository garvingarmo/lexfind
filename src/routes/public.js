import { Router } from 'express';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { db } from '../db.js';
import { searchLawyers, getLawyer, listAreas, pickAd, featuredLawyers } from '../models.js';
import { flash, rateLimit } from '../middleware.js';
import { chat } from '../ai/agent.js';
import { aiEnabled } from '../ai/client.js';

const router = Router();

export const renderMarkdown = (md) => sanitizeHtml(marked.parse(md || ''), {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2']),
  allowedAttributes: { a: ['href', 'title', 'target', 'rel'], img: ['src', 'alt', 'title'] },
});

router.get('/', (req, res) => {
  const posts = db.prepare("SELECT * FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 3").all();
  const states = db.prepare("SELECT DISTINCT state FROM lawyers WHERE status = 'active' AND state IS NOT NULL ORDER BY state").all().map((r) => r.state);
  res.render('index', {
    title: null, areas: listAreas({ withLawyersOnly: true }), featured: featuredLawyers(4), posts, states,
    ad: pickAd('home_banner'), aiOn: aiEnabled(),
  });
});

router.get('/lawyers', (req, res) => {
  const f = {
    q: (req.query.q || '').toString().slice(0, 200),
    area: (req.query.area || '').toString(),
    city: (req.query.city || '').toString().slice(0, 80),
    state: (req.query.state || '').toString().slice(0, 2),
    language: (req.query.language || '').toString().slice(0, 40),
    freeConsult: req.query.free === '1',
    sort: (req.query.sort || 'relevance').toString(),
    page: Math.max(1, parseInt(req.query.page, 10) || 1),
  };
  const perPage = 12;
  const { rows, total } = searchLawyers({ ...f, perPage });
  const states = db.prepare("SELECT DISTINCT state FROM lawyers WHERE status = 'active' AND state IS NOT NULL ORDER BY state").all().map((r) => r.state);
  const languages = [...new Set(db.prepare("SELECT languages FROM lawyers WHERE status = 'active' AND languages IS NOT NULL").all()
    .flatMap((r) => r.languages.split(',').map((s) => s.trim())).filter(Boolean))].sort();
  const qs = (overrides) => {
    const p = new URLSearchParams();
    const merged = { q: f.q, area: f.area, city: f.city, state: f.state, language: f.language, free: f.freeConsult ? '1' : '', sort: f.sort, page: f.page, ...overrides };
    for (const [k, v] of Object.entries(merged)) if (v && !(k === 'sort' && v === 'relevance') && !(k === 'page' && v === 1)) p.set(k, v);
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
  const isOwner = req.lawyer && lawyer && req.lawyer.id === lawyer.id;
  if (!lawyer || (lawyer.status !== 'active' && !isOwner && req.user?.role !== 'admin')) return next();
  res.render('lawyer', { title: lawyer.name, lawyer, bioHtml: renderMarkdown(lawyer.bio), ad: pickAd('profile_sidebar'), isOwner, query: req.query });
});

const inquiryLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
router.post('/lawyers/:slug/contact', inquiryLimit, (req, res, next) => {
  const lawyer = getLawyer('slug', req.params.slug);
  if (!lawyer || lawyer.status !== 'active') return next();
  const { name, email, phone, message, website } = req.body;
  if (website) return res.redirect(`/lawyers/${lawyer.slug}`); // honeypot
  if (!name?.trim() || !/^\S+@\S+\.\S+$/.test(email || '') || !message?.trim()) {
    flash(req, 'error', 'Please enter your name, a valid email and a message.');
    return res.redirect(`/lawyers/${lawyer.slug}#contact`);
  }
  db.prepare('INSERT INTO inquiries (lawyer_id, name, email, phone, message, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lawyer.id, name.trim().slice(0, 120), email.trim().slice(0, 200), (phone || '').trim().slice(0, 40), message.trim().slice(0, 5000),
      req.body.source === 'assistant' ? 'assistant' : 'profile');
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
        years_experience: l.years_experience, free_consultation: !!l.free_consultation, verified: !!l.verified,
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
  res.render('post', { title: post.title, post, html: renderMarkdown(post.body), recent, ad: pickAd('blog_sidebar') });
});

router.get('/about', (req, res) => {
  res.render('page', { title: 'About', html: renderMarkdown(res.locals.settings.about_body) });
});

export default router;
