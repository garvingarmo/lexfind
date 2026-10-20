// Site administration: listings, practice areas, sponsored ads, blog, inquiries, settings, AI research.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx, getSettings, setSetting, DEFAULT_SETTINGS, uniqueSlug, slugify } from '../db.js';
import { listAreas, listLawyers, getLawyer, cleanLawyerInput, createLawyer, updateLawyer, setAreas } from '../models.js';
import { requireRole, flash, upload, uploadedPath, verifyCsrf } from '../middleware.js';
import { startEnrichment, getEnrichment, diffRows, applyEnrichment } from '../ai/enrich.js';
import { aiEnabled } from '../ai/client.js';

const router = Router();
router.use(requireRole('admin'));

const count = (sql, ...p) => db.prepare(sql).get(...p).n;

router.get('/', (req, res) => {
  const stats = {
    active: count("SELECT COUNT(*) n FROM lawyers WHERE status = 'active'"),
    pending: count("SELECT COUNT(*) n FROM lawyers WHERE status = 'pending'"),
    featured: count('SELECT COUNT(*) n FROM lawyers WHERE featured = 1'),
    inquiries30: count("SELECT COUNT(*) n FROM inquiries WHERE created_at > datetime('now','-30 days')"),
    posts: count("SELECT COUNT(*) n FROM posts WHERE status = 'published'"),
    ads: count('SELECT COUNT(*) n FROM ads WHERE active = 1'),
    adImpr: count('SELECT COALESCE(SUM(impressions),0) n FROM ads'),
    adClicks: count('SELECT COALESCE(SUM(clicks),0) n FROM ads'),
  };
  const pending = listLawyers({ status: 'pending' }).slice(0, 8);
  const jobs = db.prepare(`SELECT e.*, l.name FROM enrichments e JOIN lawyers l ON l.id = e.lawyer_id
                           WHERE e.status IN ('ready','running','error') ORDER BY e.id DESC LIMIT 8`).all();
  res.render('admin/index', { title: 'Admin', stats, pending, jobs, aiOn: aiEnabled() });
});

// --- Lawyers ---------------------------------------------------------------

router.get('/lawyers', (req, res) => {
  const status = ['pending', 'active', 'suspended'].includes(req.query.status) ? req.query.status : '';
  const q = (req.query.q || '').toString().slice(0, 100);
  res.render('admin/lawyers', { title: 'Lawyers', rows: listLawyers({ status, q }), status, q });
});

router.get('/lawyers/new', (req, res) => {
  res.render('admin/lawyer-edit', { title: 'New lawyer', l: { areas: [], status: 'active' }, areas: listAreas(), selected: new Set(), login: null });
});

function adminFields(body) {
  const data = cleanLawyerInput(body);
  if (data.state) data.state = data.state.toUpperCase().slice(0, 2);
  data.status = ['pending', 'active', 'suspended'].includes(body.status) ? body.status : 'pending';
  data.featured = body.featured ? 1 : 0;
  data.verified = body.verified ? 1 : 0;
  return data;
}

function saveLogin(lawyerId, body) {
  const email = (body.login_email || '').trim();
  const password = body.login_password || '';
  if (!email) return null;
  const l = getLawyer('id', lawyerId);
  if (l.user_id) {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, l.user_id);
    if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), l.user_id);
    return null;
  }
  if (password.length < 8) return 'Set a password of at least 8 characters to create the lawyer login.';
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return 'A user with that login email already exists.';
  const uid = Number(db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'lawyer')").run(email, bcrypt.hashSync(password, 10)).lastInsertRowid);
  db.prepare('UPDATE lawyers SET user_id = ? WHERE id = ?').run(uid, lawyerId);
  return null;
}

router.post('/lawyers/new', upload.single('photo'), verifyCsrf, (req, res) => {
  const data = adminFields(req.body);
  if (!data.name) { flash(req, 'error', 'Name is required.'); return res.redirect('/admin/lawyers/new'); }
  if (req.file) data.photo = uploadedPath(req.file);
  const id = createLawyer(data);
  setAreas(id, [].concat(req.body.areas || []));
  const err = saveLogin(id, req.body);
  flash(req, err ? 'error' : 'success', err || 'Lawyer created.');
  res.redirect(`/admin/lawyers/${id}`);
});

router.get('/lawyers/:id', (req, res, next) => {
  const l = getLawyer('id', req.params.id);
  if (!l) return next();
  const login = l.user_id ? db.prepare('SELECT email FROM users WHERE id = ?').get(l.user_id) : null;
  res.render('admin/lawyer-edit', { title: `Edit ${l.name}`, l, areas: listAreas(), selected: new Set(l.areas.map((a) => a.slug)), login });
});

router.post('/lawyers/:id', upload.single('photo'), verifyCsrf, (req, res, next) => {
  const l = getLawyer('id', req.params.id);
  if (!l) return next();
  const data = adminFields(req.body);
  if (!data.name) { flash(req, 'error', 'Name is required.'); return res.redirect(`/admin/lawyers/${l.id}`); }
  if (req.file) data.photo = uploadedPath(req.file);
  if (req.body.remove_photo) data.photo = null;
  if (req.body.slug && slugify(req.body.slug) !== l.slug) data.slug = uniqueSlug('lawyers', req.body.slug, l.id);
  updateLawyer(l.id, data);
  setAreas(l.id, [].concat(req.body.areas || []));
  const err = saveLogin(l.id, req.body);
  flash(req, err ? 'error' : 'success', err || 'Saved.');
  res.redirect(`/admin/lawyers/${l.id}`);
});

router.post('/lawyers/:id/status', (req, res) => {
  const s = ['pending', 'active', 'suspended'].includes(req.body.status) ? req.body.status : null;
  if (s) db.prepare("UPDATE lawyers SET status = ?, verified = CASE WHEN ? = 'active' THEN 1 ELSE verified END, updated_at = datetime('now') WHERE id = ?").run(s, s, req.params.id);
  flash(req, 'success', 'Status updated.');
  res.redirect(req.get('referer') || '/admin/lawyers');
});

router.post('/lawyers/:id/delete', (req, res) => {
  tx(() => {
    const l = db.prepare('SELECT user_id FROM lawyers WHERE id = ?').get(req.params.id);
    db.prepare('DELETE FROM lawyers WHERE id = ?').run(req.params.id);
    if (l?.user_id) db.prepare("DELETE FROM users WHERE id = ? AND role = 'lawyer'").run(l.user_id);
  });
  flash(req, 'success', 'Lawyer deleted.');
  res.redirect('/admin/lawyers');
});

// --- AI research on any listing ---------------------------------------------

router.get('/lawyers/:id/research', (req, res, next) => {
  const l = getLawyer('id', req.params.id);
  if (!l) return next();
  const jobs = db.prepare('SELECT * FROM enrichments WHERE lawyer_id = ? ORDER BY id DESC LIMIT 10').all(l.id);
  res.render('research/start', { title: `AI research: ${l.name}`, l, jobs, aiOn: aiEnabled(), base: `/admin/lawyers/${l.id}/research` });
});

router.post('/lawyers/:id/research', (req, res) => {
  try {
    const id = startEnrichment(Number(req.params.id), req.user.id);
    res.redirect(`/admin/lawyers/${req.params.id}/research/${id}`);
  } catch (e) {
    flash(req, 'error', e.message);
    res.redirect(`/admin/lawyers/${req.params.id}/research`);
  }
});

function job(req, res, next) {
  const j = getEnrichment(req.params.jobId);
  if (!j || j.lawyer_id !== Number(req.params.id)) return next('route');
  req.job = j;
  next();
}

router.get('/lawyers/:id/research/:jobId', job, (req, res) => {
  const l = getLawyer('id', req.job.lawyer_id);
  res.render('research/review', { title: 'Review AI suggestions', l, job: req.job, rows: diffRows(l, req.job.proposed), base: `/admin/lawyers/${l.id}/research` });
});
router.get('/lawyers/:id/research/:jobId/status', job, (req, res) => res.json({ status: req.job.status }));
router.post('/lawyers/:id/research/:jobId/apply', job, (req, res) => {
  if (req.job.status === 'ready') applyEnrichment(req.job, [].concat(req.body.fields || []));
  flash(req, 'success', 'Selected updates applied.');
  res.redirect(`/admin/lawyers/${req.params.id}`);
});
router.post('/lawyers/:id/research/:jobId/reject', job, (req, res) => {
  db.prepare("UPDATE enrichments SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(req.job.id);
  res.redirect(`/admin/lawyers/${req.params.id}/research`);
});

// --- Practice areas ------------------------------------------------------------

router.get('/areas', (req, res) => res.render('admin/areas', { title: 'Practice areas', rows: listAreas() }));

router.post('/areas', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Name is required.'); return res.redirect('/admin/areas'); }
  try {
    if (req.body.id) db.prepare('UPDATE practice_areas SET name = ?, description = ? WHERE id = ?').run(name, req.body.description || null, req.body.id);
    else db.prepare('INSERT INTO practice_areas (name, slug, description) VALUES (?, ?, ?)').run(name, uniqueSlug('practice_areas', name), req.body.description || null);
    flash(req, 'success', 'Practice area saved.');
  } catch {
    flash(req, 'error', 'A practice area with that name already exists.');
  }
  res.redirect('/admin/areas');
});

router.post('/areas/:id/delete', (req, res) => {
  db.prepare('DELETE FROM practice_areas WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Practice area deleted.');
  res.redirect('/admin/areas');
});

// --- Sponsored ads ---------------------------------------------------------------

const PLACEMENTS = { home_banner: 'Home page banner', search_sidebar: 'Search results sidebar', profile_sidebar: 'Lawyer profile sidebar', blog_sidebar: 'Blog sidebar' };

router.get('/ads', (req, res) => {
  const rows = db.prepare('SELECT a.*, l.name AS lawyer_name FROM ads a LEFT JOIN lawyers l ON l.id = a.lawyer_id ORDER BY a.active DESC, a.id DESC').all();
  res.render('admin/ads', { title: 'Sponsored ads', rows, PLACEMENTS });
});

router.get('/ads/:id', (req, res, next) => {
  const ad = req.params.id === 'new' ? { active: 1, weight: 1, placement: 'search_sidebar', cta: 'Learn more' } : db.prepare('SELECT * FROM ads WHERE id = ?').get(req.params.id);
  if (!ad) return next();
  const lawyers = db.prepare("SELECT id, name FROM lawyers WHERE status = 'active' ORDER BY name").all();
  res.render('admin/ad-edit', { title: ad.id ? 'Edit ad' : 'New ad', ad, PLACEMENTS, lawyers });
});

router.post('/ads/:id', upload.single('image'), verifyCsrf, (req, res) => {
  const b = req.body;
  let link = (b.link_url || '').trim();
  const lawyerId = Number(b.lawyer_id) || null;
  if (!link && lawyerId) link = `/lawyers/${getLawyer('id', lawyerId)?.slug}`;
  if (!b.title?.trim() || !(link.startsWith('/') || /^https?:\/\//i.test(link)) || !PLACEMENTS[b.placement]) {
    flash(req, 'error', 'Title, a valid link (http(s):// or /path, or a linked lawyer) and placement are required.');
    return res.redirect(`/admin/ads/${req.params.id}`);
  }
  const data = {
    title: b.title.trim().slice(0, 120), body: (b.body || '').trim().slice(0, 400) || null, link_url: link, cta: (b.cta || 'Learn more').slice(0, 40),
    placement: b.placement, lawyer_id: lawyerId, active: b.active ? 1 : 0, starts_at: b.starts_at || null, ends_at: b.ends_at || null,
    weight: Math.max(1, Math.min(100, parseInt(b.weight, 10) || 1)),
  };
  if (req.file) data.image = uploadedPath(req.file);
  if (b.remove_image) data.image = null;
  const keys = Object.keys(data);
  if (req.params.id === 'new') {
    db.prepare(`INSERT INTO ads (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k]));
  } else {
    db.prepare(`UPDATE ads SET ${keys.map((k) => `${k} = ?`).join(',')} WHERE id = ?`).run(...keys.map((k) => data[k]), req.params.id);
  }
  flash(req, 'success', 'Ad saved.');
  res.redirect('/admin/ads');
});

router.post('/ads/:id/delete', (req, res) => {
  db.prepare('DELETE FROM ads WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Ad deleted.');
  res.redirect('/admin/ads');
});

// --- Blog ------------------------------------------------------------------------

router.get('/posts', (req, res) => {
  res.render('admin/posts', { title: 'Blog posts', rows: db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all() });
});

router.get('/posts/:id', (req, res, next) => {
  const post = req.params.id === 'new' ? { status: 'draft', author: getSettings().site_name + ' Editorial Team' } : db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return next();
  res.render('admin/post-edit', { title: post.id ? 'Edit post' : 'New post', post });
});

router.post('/posts/:id', upload.single('cover_image'), verifyCsrf, (req, res) => {
  const b = req.body;
  if (!b.title?.trim()) { flash(req, 'error', 'Title is required.'); return res.redirect(`/admin/posts/${req.params.id}`); }
  const isNew = req.params.id === 'new';
  const existing = isNew ? null : db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  const status = b.status === 'published' ? 'published' : 'draft';
  const data = {
    title: b.title.trim().slice(0, 200), excerpt: (b.excerpt || '').trim().slice(0, 500) || null, body: b.body || '',
    author: (b.author || '').trim().slice(0, 120) || null, status,
    slug: uniqueSlug('posts', b.slug?.trim() || b.title, existing?.id ?? null),
    published_at: status === 'published' ? (existing?.published_at || new Date().toISOString().slice(0, 19).replace('T', ' ')) : existing?.published_at || null,
  };
  if (req.file) data.cover_image = uploadedPath(req.file);
  if (b.remove_cover) data.cover_image = null;
  const keys = Object.keys(data);
  let id = existing?.id;
  if (isNew) id = Number(db.prepare(`INSERT INTO posts (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => data[k])).lastInsertRowid);
  else db.prepare(`UPDATE posts SET ${keys.map((k) => `${k} = ?`).join(',')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => data[k]), id);
  flash(req, 'success', 'Post saved.');
  res.redirect(`/admin/posts/${id}`);
});

router.post('/posts/:id/delete', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  flash(req, 'success', 'Post deleted.');
  res.redirect('/admin/posts');
});

// --- Inquiries ---------------------------------------------------------------------

router.get('/inquiries', (req, res) => {
  const rows = db.prepare('SELECT i.*, l.name AS lawyer_name, l.slug FROM inquiries i JOIN lawyers l ON l.id = i.lawyer_id ORDER BY i.created_at DESC LIMIT 200').all();
  res.render('admin/inquiries', { title: 'Inquiries', rows });
});

// --- Site content & settings ------------------------------------------------------------

router.get('/settings', (req, res) => res.render('admin/settings', { title: 'Site content', keys: Object.keys(DEFAULT_SETTINGS) }));

router.post('/settings', (req, res) => {
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in req.body) setSetting(k, String(req.body[k]).slice(0, 20000));
  flash(req, 'success', 'Site content saved.');
  res.redirect('/admin/settings');
});

// --- Admin users -------------------------------------------------------------------------

router.get('/users', (req, res) => {
  res.render('admin/users', { title: 'Admin users', rows: db.prepare("SELECT id, email, created_at FROM users WHERE role = 'admin' ORDER BY id").all() });
});

router.post('/users', (req, res) => {
  const { email, password } = req.body;
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) flash(req, 'error', 'Valid email and an 8+ character password are required.');
  else if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email.trim())) flash(req, 'error', 'That email is already in use.');
  else {
    db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'admin')").run(email.trim(), bcrypt.hashSync(password, 10));
    flash(req, 'success', 'Admin user added.');
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req, res) => {
  if (Number(req.params.id) === req.user.id) flash(req, 'error', 'You cannot delete your own account.');
  else { db.prepare("DELETE FROM users WHERE id = ? AND role = 'admin'").run(req.params.id); flash(req, 'success', 'Admin removed.'); }
  res.redirect('/admin/users');
});

export default router;
