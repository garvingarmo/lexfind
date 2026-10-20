// Site administration: listings, practice areas, sponsored ads, blog, inquiries, settings, AI research.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx, getSettings, setSetting, DEFAULT_SETTINGS, uniqueSlug, slugify } from '../db.js';
import { listAreas, listLawyers, getLawyer, cleanLawyerInput, createLawyer, updateLawyer, setAreas } from '../models.js';
import { requireRole, flash, upload, uploadedPath, verifyCsrf } from '../middleware.js';
import { startEnrichment, getEnrichment, diffRows, applyEnrichment } from '../ai/enrich.js';
import { aiEnabled } from '../ai/client.js';
import multer from 'multer';
import { createInvite, activeInvite, inviteStatuses, inviteUrl, mailEnabled, sendInvite, sendInBackground } from '../invites.js';
import { IMPORT_FIELDS, autoMap, fetchSheet, stageCsv, loadStaged, discardStaged, rowToLawyer, runImport, deleteSampleData, templateCsv } from '../importer.js';

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
    unclaimed: count('SELECT COUNT(*) n FROM lawyers WHERE user_id IS NULL'),
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
  res.render('admin/lawyers', { title: 'Lawyers', rows: listLawyers({ status, q }), status, q, inv: inviteStatuses() });
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
  const invite = l.user_id ? null : activeInvite(l.id);
  res.render('admin/lawyer-edit', {
    title: `Edit ${l.name}`, l, areas: listAreas(), selected: new Set(l.areas.map((a) => a.slug)), login,
    invite, inviteLink: invite ? inviteUrl(req, invite.token) : null, mailOn: mailEnabled(),
  });
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

// --- Import lawyers from Google Sheets / CSV ------------------------------------------

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

router.get('/import', (req, res) => {
  const sample = {
    lawyers: count('SELECT COUNT(*) n FROM lawyers WHERE is_sample = 1'),
    ads: count('SELECT COUNT(*) n FROM ads WHERE is_sample = 1'),
    posts: count('SELECT COUNT(*) n FROM posts WHERE is_sample = 1'),
  };
  res.render('admin/import', { title: 'Import lawyers', sample, total: count('SELECT COUNT(*) n FROM lawyers') });
});

router.get('/import/template.csv', (req, res) => {
  res.type('text/csv').attachment('lawyers-template.csv').send(templateCsv());
});

router.post('/import', csvUpload.single('file'), verifyCsrf, async (req, res) => {
  try {
    let text;
    let source;
    if (req.file) {
      text = req.file.buffer.toString('utf8');
      source = req.file.originalname;
    } else if (req.body.sheet_url?.trim()) {
      text = await fetchSheet(req.body.sheet_url);
      source = 'Google Sheet';
    } else {
      throw new Error('Paste your Google Sheet link or choose a CSV file.');
    }
    res.redirect(`/admin/import/${stageCsv(text, source)}`);
  } catch (e) {
    flash(req, 'error', e.message);
    res.redirect('/admin/import');
  }
});

function mappingFrom(body, headers) {
  const mapping = {};
  for (const [key] of IMPORT_FIELDS) {
    const v = body[`map_${key}`];
    if (v !== undefined && v !== '' && Number(v) >= 0 && Number(v) < headers.length) mapping[key] = Number(v);
  }
  return mapping;
}

router.get('/import/:token', (req, res, next) => {
  const staged = loadStaged(req.params.token);
  if (!staged) { flash(req, 'error', 'That import has expired. Please load the sheet again.'); return res.redirect('/admin/import'); }
  const mapping = req.query.remap ? mappingFrom(req.query, staged.headers) : autoMap(staged.headers);
  const filled = staged.rows.filter((r) => r.some((c) => String(c || '').trim()));
  const preview = filled.slice(0, 8).map((r) => rowToLawyer(r, mapping));
  const hasName = mapping.name != null || mapping.first_name != null || mapping.last_name != null;
  res.render('admin/import-map', { title: 'Match columns', token: req.params.token, staged, rowCount: filled.length, mapping, preview, hasName, IMPORT_FIELDS, areas: listAreas() });
});

router.post('/import/:token/run', (req, res) => {
  const staged = loadStaged(req.params.token);
  if (!staged) { flash(req, 'error', 'That import has expired. Please load the sheet again.'); return res.redirect('/admin/import'); }
  const mapping = mappingFrom(req.body, staged.headers);
  if (mapping.name == null && mapping.first_name == null && mapping.last_name == null) {
    flash(req, 'error', 'Choose which column holds the lawyer\'s name.');
    return res.redirect(`/admin/import/${req.params.token}`);
  }
  const result = runImport(staged, mapping, {
    status: req.body.status === 'pending' ? 'pending' : 'active',
    mode: req.body.mode === 'skip' ? 'skip' : 'update',
    createAreas: Boolean(req.body.create_areas),
    verified: Boolean(req.body.verified),
    deleteSample: Boolean(req.body.delete_sample),
  });
  discardStaged(req.params.token);
  res.render('admin/import-done', { title: 'Import complete', result, source: staged.source });
});

router.post('/sample-data/delete', (req, res) => {
  const r = deleteSampleData();
  flash(req, 'success', `Removed ${r.lawyers} sample lawyers, ${r.ads} sample ads and ${r.posts} sample blog posts.`);
  res.redirect('/admin/import');
});

// --- Invitations ------------------------------------------------------------------

router.get('/invites', (req, res) => {
  const filter = ['none', 'invited', 'expired', 'login'].includes(req.query.status) ? req.query.status : 'unclaimed';
  const statuses = inviteStatuses();
  const rows = listLawyers({ q: (req.query.q || '').toString().slice(0, 100) })
    .map((l) => ({ ...l, inv: statuses.get(l.id), invite: activeInvite(l.id) }))
    .filter((l) => (filter === 'unclaimed' ? l.inv.status !== 'login' : l.inv.status === filter))
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = { none: 0, invited: 0, expired: 0, login: 0 };
  for (const v of statuses.values()) counts[v.status]++;
  res.render('admin/invites', {
    title: 'Invitations', rows, counts, filter, q: req.query.q || '', mailOn: mailEnabled(),
    linkFor: (inv) => inviteUrl(req, inv.token),
  });
});

const selectedIds = (body) => [].concat(body.ids || []).map(Number).filter(Boolean);

router.post('/invites/create', (req, res) => {
  let ids = selectedIds(req.body);
  if (req.body.scope === 'all_new') {
    const statuses = inviteStatuses();
    ids = [...statuses].filter(([, v]) => v.status === 'none' || v.status === 'expired').map(([id]) => id);
  }
  if (!ids.length) { flash(req, 'error', 'Select at least one lawyer.'); return res.redirect('/admin/invites'); }
  for (const id of ids) createInvite(id, req.user.id);
  flash(req, 'success', `Created ${ids.length} invitation link${ids.length === 1 ? '' : 's'}. Copy them below, download them as a spreadsheet${mailEnabled() ? ', or email them' : ''}.`);
  res.redirect('/admin/invites?status=invited');
});

router.post('/invites/send', (req, res) => {
  if (!mailEnabled()) { flash(req, 'error', 'Email sending is not set up. Add the SMTP settings first.'); return res.redirect('/admin/invites'); }
  let ids = selectedIds(req.body);
  if (req.body.scope === 'all_unsent') {
    ids = db.prepare("SELECT lawyer_id FROM invites WHERE used_at IS NULL AND revoked = 0 AND sent_at IS NULL AND expires_at > datetime('now')").all().map((r) => r.lawyer_id);
  }
  const invites = ids.map((id) => activeInvite(id)).filter((i) => i && i.email);
  if (!invites.length) { flash(req, 'error', 'None of the selected lawyers have an active invitation and an email address.'); return res.redirect('/admin/invites?status=invited'); }
  sendInBackground(invites, req);
  flash(req, 'success', `Sending ${invites.length} invitation email${invites.length === 1 ? '' : 's'} in the background (about ${Math.ceil(invites.length * 1.5 / 60)} min). Refresh this page to see the "Emailed" dates.`);
  res.redirect('/admin/invites?status=invited');
});

router.get('/invites/export.csv', (req, res) => {
  const rows = db.prepare(`SELECT i.*, l.name, l.firm, l.city, l.state, l.phone FROM invites i JOIN lawyers l ON l.id = i.lawyer_id
    WHERE i.used_at IS NULL AND i.revoked = 0 AND i.expires_at > datetime('now') AND l.user_id IS NULL ORDER BY l.name`).all();
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Firm', 'Email', 'Phone', 'City', 'State', 'Invitation link', 'Expires'].map(q).join(',')];
  for (const r of rows) lines.push([r.name, r.firm, r.email, r.phone, r.city, r.state, inviteUrl(req, r.token), r.expires_at.slice(0, 10)].map(q).join(','));
  res.type('text/csv').attachment('invitation-links.csv').send(`${lines.join('\n')}\n`);
});

router.post('/lawyers/:id/invite', (req, res) => {
  const l = getLawyer('id', req.params.id);
  if (l && !l.user_id) {
    createInvite(l.id, req.user.id);
    flash(req, 'success', 'New invitation link created. Any earlier link for this lawyer no longer works.');
  }
  res.redirect(`/admin/lawyers/${req.params.id}#invite`);
});

router.post('/lawyers/:id/invite/send', async (req, res) => {
  const inv = activeInvite(Number(req.params.id));
  try {
    if (!inv) throw new Error('Create an invitation link first.');
    if (!mailEnabled()) throw new Error('Email sending is not set up.');
    await sendInvite(inv, req);
    flash(req, 'success', `Invitation emailed to ${inv.email}.`);
  } catch (e) {
    flash(req, 'error', `Could not send: ${e.message}`);
  }
  res.redirect(`/admin/lawyers/${req.params.id}#invite`);
});

router.post('/lawyers/:id/invite/revoke', (req, res) => {
  db.prepare('UPDATE invites SET revoked = 1 WHERE lawyer_id = ? AND used_at IS NULL').run(req.params.id);
  flash(req, 'success', 'Invitation link cancelled.');
  res.redirect(`/admin/lawyers/${req.params.id}#invite`);
});

export default router;
