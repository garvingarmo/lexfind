// Site administration: listings, practice areas, sponsored ads, blog, inquiries, settings, AI research.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx, getSettings, setSetting, getSecret, setSecret, DEFAULT_SETTINGS, uniqueSlug, slugify } from '../db.js';
import { listAreas, listLawyers, getLawyer, cleanLawyerInput, createLawyer, updateLawyer, setAreas, mergeAreas, deleteUnusedAreas, mainAreas, setAreaParent, saveAreaTree, setLawyerSlug, nameSlug } from '../models.js';
import { requireRole, flash, upload, uploadTwo, uploadedPath, verifyCsrf } from '../middleware.js';
import { startEnrichment, getEnrichment, diffRows, applyEnrichment } from '../ai/enrich.js';
import { aiEnabled, apiKey, getClient, MODEL } from '../ai/client.js';
import { mailConfig, mailEnabled as smtpEnabled, sendMail, PROVIDERS } from '../mailer.js';
import multer from 'multer';
import { cleanHtml, renderPost } from './public.js';
import { TEXT_GROUPS, TEXT_DEFAULTS, loadTexts, saveTexts } from '../texts.js';
import { FONTS, THEME_DEFAULTS, getTheme, saveTheme, allFontsUrl } from '../theme.js';
import { SECTIONS, getSections, saveSections } from '../homepage.js';
import { NETWORKS, SOCIAL_KEYS, saveSiteSocial, socialIcon } from '../social.js';
import { PROFILE_OPTIONS, getProfileSettings, saveProfileSettings, SORT_LABELS, getSearchSettings, saveSearchSettings } from '../profileSettings.js';
import { getLanguageOptions, saveLanguageOptions, unlistedLanguages } from '../languages.js';
import { watchApprovals } from '../members.js';
import { allReferrals } from '../referrals.js';
import { listBackups, backupPath, streamFullBackup } from '../backup.js';
import { baseUrl } from '../invites.js';
import { createInvite, activeInvite, inviteStatuses, inviteUrl, mailEnabled, sendInvite, sendInBackground } from '../invites.js';
import { IMPORT_FIELDS, autoMap, fetchSheet, stageCsv, loadStaged, discardStaged, rowToLawyer, runImport, deleteSampleData, deleteAllLawyers, templateCsv } from '../importer.js';

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
  res.render('admin/lawyers', { title: 'Lawyers', rows: listLawyers({ status, q }), status, q, inv: inviteStatuses(), areas: listAreas() });
});

// Bulk actions on the lawyers ticked in the list.
const BULK = {
  active: ["UPDATE lawyers SET status = 'active', verified = 1, updated_at = datetime('now') WHERE id = ?", 'set to active'],
  pending: ["UPDATE lawyers SET status = 'pending', updated_at = datetime('now') WHERE id = ?", 'set to pending'],
  suspended: ["UPDATE lawyers SET status = 'suspended', updated_at = datetime('now') WHERE id = ?", 'suspended'],
  verify: ["UPDATE lawyers SET verified = 1 WHERE id = ?", 'marked verified'],
  unverify: ["UPDATE lawyers SET verified = 0 WHERE id = ?", 'marked not verified'],
  feature: ["UPDATE lawyers SET featured = 1 WHERE id = ?", 'marked sponsored'],
  unfeature: ["UPDATE lawyers SET featured = 0 WHERE id = ?", 'no longer sponsored'],
  add_area: ['INSERT OR IGNORE INTO lawyer_practice_areas (lawyer_id, area_id) VALUES (?, ?)', 'given the practice area'],
  remove_area: ['DELETE FROM lawyer_practice_areas WHERE lawyer_id = ? AND area_id = ?', 'removed from the practice area'],
};

router.post('/lawyers/bulk', (req, res) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  const action = req.body.action;
  const back = req.get('referer')?.includes('/admin/lawyers') ? req.get('referer') : '/admin/lawyers';
  if (!ids.length) { flash(req, 'error', 'Tick at least one lawyer first.'); return res.redirect(back); }
  const n = `${ids.length} lawyer${ids.length === 1 ? '' : 's'}`;

  if (action === 'delete') {
    tx(() => {
      for (const id of ids) {
        const l = db.prepare('SELECT user_id FROM lawyers WHERE id = ?').get(id);
        db.prepare('DELETE FROM lawyers WHERE id = ?').run(id);
        if (l?.user_id) db.prepare("DELETE FROM users WHERE id = ? AND role = 'lawyer'").run(l.user_id);
      }
    });
    flash(req, 'success', `Deleted ${n}.`);
    return res.redirect(back);
  }
  if (action === 'invite') {
    const eligible = ids.filter((id) => !getLawyer('id', id)?.user_id);
    for (const id of eligible) createInvite(id, req.user.id);
    flash(req, 'success', `Created invitation links for ${eligible.length} of ${n}${eligible.length < ids.length ? ' (the others already have a login)' : ''}.`);
    return res.redirect('/admin/invites?status=invited');
  }
  const op = BULK[action];
  if (!op) { flash(req, 'error', 'Choose an action.'); return res.redirect(back); }
  let area = null;
  if (action === 'add_area' || action === 'remove_area') {
    area = db.prepare('SELECT * FROM practice_areas WHERE id = ?').get(req.body.area_id);
    if (!area) { flash(req, 'error', 'Choose a practice area.'); return res.redirect(back); }
  }
  const notify = watchApprovals(ids, baseUrl(req));
  tx(() => {
    const stmt = db.prepare(op[0]);
    for (const id of ids) area ? stmt.run(id, area.id) : stmt.run(id);
  });
  notify();
  flash(req, 'success', `${n} ${op[1]}${area ? ` "${area.name}"` : ''}.`);
  res.redirect(back);
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
  const notify = watchApprovals([l.id], baseUrl(req));
  updateLawyer(l.id, data);
  notify();
  if (req.body.slug && slugify(req.body.slug) !== l.slug) setLawyerSlug(l.id, req.body.slug);
  setAreas(l.id, [].concat(req.body.areas || []));
  const err = saveLogin(l.id, req.body);
  flash(req, err ? 'error' : 'success', err || 'Saved.');
  res.redirect(`/admin/lawyers/${l.id}`);
});

router.post('/lawyers/:id/status', (req, res) => {
  const s = ['pending', 'active', 'suspended'].includes(req.body.status) ? req.body.status : null;
  const notify = watchApprovals([req.params.id], baseUrl(req));
  if (s) db.prepare("UPDATE lawyers SET status = ?, verified = CASE WHEN ? = 'active' THEN 1 ELSE verified END, updated_at = datetime('now') WHERE id = ?").run(s, s, req.params.id);
  notify();
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

router.get('/areas', (req, res) => res.render('admin/areas', { title: 'Practice areas', rows: listAreas(), mains: mainAreas() }));

router.post('/areas', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) { flash(req, 'error', 'Name is required.'); return res.redirect('/admin/areas'); }
  try {
    let id = Number(req.body.id);
    if (id) db.prepare('UPDATE practice_areas SET name = ?, description = ? WHERE id = ?').run(name, req.body.description || null, id);
    else id = Number(db.prepare('INSERT INTO practice_areas (name, slug, description) VALUES (?, ?, ?)').run(name, uniqueSlug('practice_areas', name), req.body.description || null).lastInsertRowid);
    const err = 'parent_id' in req.body ? setAreaParent(id, req.body.parent_id) : null;
    if (err) flash(req, 'error', `Saved "${name}", but ${err.charAt(0).toLowerCase()}${err.slice(1)}`);
    else flash(req, 'success', 'Practice area saved.');
  } catch {
    flash(req, 'error', 'A practice area with that name already exists.');
  }
  res.redirect('/admin/areas');
});

router.post('/areas/order.json', (req, res) => {
  const err = saveAreaTree(req.body?.tree);
  if (err) return res.status(400).json({ error: err });
  res.json({ ok: true });
});

router.post('/areas/:id/merge', (req, res) => {
  const from = db.prepare('SELECT * FROM practice_areas WHERE id = ?').get(req.params.id);
  const into = db.prepare('SELECT * FROM practice_areas WHERE id = ?').get(req.body.into);
  if (!from || !into || from.id === into.id) {
    flash(req, 'error', 'Choose a different practice area to merge into.');
  } else {
    mergeAreas(from.id, into.id);
    flash(req, 'success', `Merged "${from.name}" into "${into.name}". Its lawyers are now listed under "${into.name}".`);
  }
  res.redirect('/admin/areas');
});

router.post('/areas/delete-unused', (req, res) => {
  const n = deleteUnusedAreas();
  flash(req, 'success', n ? `Deleted ${n} practice area${n === 1 ? '' : 's'} with no lawyers.` : 'There were no unused practice areas.');
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
  res.render('admin/post-edit', { title: post.id ? 'Edit post' : 'New post', post, bodyHtml: post.id ? renderPost(post) : '' });
});

router.post('/posts/:id', upload.single('cover_image'), verifyCsrf, (req, res) => {
  const b = req.body;
  if (!b.title?.trim()) { flash(req, 'error', 'Title is required.'); return res.redirect(`/admin/posts/${req.params.id}`); }
  const isNew = req.params.id === 'new';
  const existing = isNew ? null : db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  const status = b.status === 'published' ? 'published' : 'draft';
  const data = {
    title: b.title.trim().slice(0, 200), excerpt: (b.excerpt || '').trim().slice(0, 500) || null, body: cleanHtml(b.body || ''), format: 'html',
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

router.get('/backups', (req, res) => res.render('admin/backups', { title: 'Backups', rows: listBackups() }));

router.get('/backups/download', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/gzip').attachment(`chaldean-law-backup-${stamp}.tar.gz`);
  streamFullBackup(res);
});

router.get('/backups/:name', (req, res, next) => {
  const file = backupPath(req.params.name);
  if (!file) return next();
  res.download(file, req.params.name, (err) => { if (err && !res.headersSent) next(); });
});

router.get('/referrals', (req, res) => res.render('admin/referrals', { title: 'Referrals', rows: allReferrals() }));

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

router.post('/lawyers/delete-all', (req, res) => {
  if ((req.body.confirm || '').trim() !== 'DELETE') {
    flash(req, 'error', 'Type DELETE in capitals to confirm. Nothing was deleted.');
    return res.redirect('/admin/import#start-over');
  }
  const r = deleteAllLawyers({ areas: Boolean(req.body.areas) });
  flash(req, 'success', `Deleted ${r.lawyers} lawyers and ${r.logins} lawyer logins${req.body.areas ? ` and ${r.areas} practice areas` : ''}. You can import your sheet again now.`);
  res.redirect('/admin/import');
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

// --- Integrations: Anthropic API key and outgoing email ------------------------------

const mask = (v) => (v ? `••••${String(v).slice(-4)}` : '');

router.get('/integrations', (req, res) => {
  const mail = mailConfig();
  // Suggest the usual mailbox for this domain until something is saved.
  const domain = (() => { try { return new URL(getSettings().site_url).hostname.replace(/^www\./, ''); } catch { return ''; } })();
  const suggest = { user: domain ? `noreply@${domain}` : '', from: domain ? `${getSettings().site_name} <noreply@${domain}>` : '' };
  const missing = mail.provider === 'smtp'
    ? [!mail.host && 'mail server', !mail.from && '"send emails as" address', mail.user && !mail.pass && 'password'].filter(Boolean)
    : [!mail.apiKey && 'API key', !mail.from && '"send emails as" address'].filter(Boolean);
  res.render('admin/integrations', {
    suggest, missing, PROVIDERS,
    title: 'Integrations',
    ai: { on: aiEnabled(), fromEnv: Boolean(process.env.ANTHROPIC_API_KEY), masked: mask(apiKey()), model: MODEL },
    mail: { ...mail, pass: undefined, apiKey: undefined, passMasked: mask(mail.pass), keyMasked: mask(mail.apiKey), on: smtpEnabled(), fromEnv: Boolean(process.env.SMTP_HOST || process.env.MAIL_PROVIDER) },
  });
});

router.post('/integrations/ai', (req, res) => {
  const key = (req.body.api_key || '').trim();
  if (req.body.remove) { setSecret('anthropic_api_key', ''); flash(req, 'success', 'Anthropic API key removed.'); }
  else if (!key) flash(req, 'error', 'Paste your API key first.');
  else if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) flash(req, 'error', 'That does not look like an Anthropic API key (it should start with sk-ant-).');
  else { setSecret('anthropic_api_key', key); flash(req, 'success', 'API key saved. Click "Test connection" to check it.'); }
  res.redirect('/admin/integrations');
});

router.post('/integrations/ai/test', async (req, res) => {
  try {
    if (!aiEnabled()) throw new Error('No API key saved yet.');
    const m = await getClient().models.retrieve(MODEL);
    flash(req, 'success', `Connected to Claude (${m.display_name || m.id}). The AI assistant and profile research are on.`);
  } catch (e) {
    const msg = e.status === 401 ? 'The key was rejected. Check you copied all of it, or create a new key.'
      : e.status === 403 ? 'The key has no access. Check your Anthropic account billing.'
      : e.message;
    flash(req, 'error', `Could not connect: ${msg}`);
  }
  res.redirect('/admin/integrations');
});

router.post('/integrations/mail', (req, res) => {
  const b = req.body;
  if (b.remove) {
    for (const k of ['mail_provider', 'mail_api_key', 'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'mail_from']) setSecret(k, '');
    flash(req, 'success', 'Email settings removed.');
    return res.redirect('/admin/integrations');
  }
  const provider = PROVIDERS[b.mail_provider] ? b.mail_provider : 'smtp';
  const from = (b.mail_from || '').trim();
  setSecret('mail_provider', provider);
  setSecret('mail_from', from);
  let missing;
  if (provider === 'smtp') {
    const host = (b.smtp_host || '').trim();
    const user = (b.smtp_user || '').trim();
    setSecret('smtp_host', host);
    setSecret('smtp_port', String(parseInt(b.smtp_port, 10) || 465));
    setSecret('smtp_user', user);
    if (b.smtp_pass) setSecret('smtp_pass', b.smtp_pass);
    missing = [!host && 'Mail server', !from && 'Send emails as', user && !mailConfig().pass && 'Password'];
  } else {
    // Keys are per service, so a new key is needed when switching services.
    const key = (b.mail_api_key || '').trim();
    if (key) setSecret('mail_api_key', key);
    missing = [!mailConfig().apiKey && 'API key', !from && 'Send emails as'];
  }
  missing = missing.filter(Boolean);
  if (missing.length) flash(req, 'error', `Saved, but email is still off. Please fill in: ${missing.join(', ')}.`);
  else flash(req, 'success', `Email settings saved (${PROVIDERS[provider]}). Email is on. Click "Send test email" to check them.`);
  res.redirect('/admin/integrations');
});

router.post('/integrations/mail/test', async (req, res) => {
  const to = String(req.body.to || '').trim() || req.user.email;
  try {
    if (!smtpEnabled()) throw new Error('Email is not set up yet.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`"${to}" is not an email address.`);
    const info = await sendMail({
      to,
      subject: `${getSettings().site_name}: test email`,
      text: 'This test email confirms your website can send email (password resets and lawyer invitations).',
      html: '<p>This test email confirms your website can send email (password resets and lawyer invitations).</p>',
    });
    console.log(`[mail] test email to ${to}: ${info.response}`);
    flash(req, 'success', `Test email handed to the mail server for ${to} (server reply: ${info.response}). Check the inbox and spam folder${mailConfig().provider === 'smtp' ? "; if it hasn't arrived in a few minutes, look it up in cPanel → Email → Track Delivery" : ''}.`);
  } catch (e) {
    flash(req, 'error', `Could not send: ${e.message}`);
  }
  res.redirect('/admin/integrations');
});

// --- Visual editing: edit mode, texts, appearance, homepage sections ---------------------

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

router.post('/edit-mode', (req, res) => {
  req.session.editMode = Boolean(req.body.on);
  res.redirect(safeNext(req.body.next));
});

// Saves wording changed on the page in edit mode (JSON: { changes: { key: text } }).
router.post('/texts.json', (req, res) => {
  const changes = req.body?.changes;
  if (!changes || typeof changes !== 'object') return res.status(400).json({ error: 'No changes sent.' });
  saveTexts(changes);
  res.json({ ok: true, saved: Object.keys(changes).length });
});

router.get('/texts', (req, res) => {
  const saved = loadTexts();
  const current = (key) => res.locals.t(key);
  res.render('admin/texts', { title: 'Texts', groups: TEXT_GROUPS, current, changed: (k) => current(k) !== TEXT_DEFAULTS[k], q: (req.query.q || '').toString(), savedCount: Object.keys(saved).length });
});

router.post('/texts', (req, res) => {
  const changes = {};
  for (const key of Object.keys(TEXT_DEFAULTS)) if (`text__${key}` in req.body) changes[key] = req.body[`text__${key}`];
  if (req.body.reset && TEXT_DEFAULTS[req.body.reset] !== undefined) changes[req.body.reset] = TEXT_DEFAULTS[req.body.reset];
  saveTexts(changes);
  flash(req, 'success', req.body.reset ? 'Restored the original wording.' : 'Texts saved.');
  res.redirect(`/admin/texts${req.body.group ? `#${encodeURIComponent(req.body.group)}` : ''}`);
});

router.get('/appearance', (req, res) => {
  res.render('admin/appearance', { title: 'Appearance', theme: getTheme(), FONTS, THEME_DEFAULTS, allFonts: allFontsUrl() });
});

router.post('/appearance', uploadTwo.fields([{ name: 'logo', maxCount: 1 }, { name: 'hero_image', maxCount: 1 }]), verifyCsrf, (req, res) => {
  const b = req.body;
  if (b.reset) {
    saveTheme({ ...THEME_DEFAULTS });
    flash(req, 'success', 'Appearance reset to the original design.');
    return res.redirect('/admin/appearance');
  }
  const values = { theme_primary: b.theme_primary, theme_accent: b.theme_accent, theme_font: b.theme_font, theme_logo_text: b.theme_logo_text ? '1' : '0' };
  if (req.files?.logo?.[0]) values.theme_logo = uploadedPath(req.files.logo[0]);
  else if (b.remove_logo) values.theme_logo = '';
  if (req.files?.hero_image?.[0]) values.theme_hero_image = uploadedPath(req.files.hero_image[0]);
  else if (b.remove_hero) values.theme_hero_image = '';
  saveTheme(values);
  flash(req, 'success', 'Appearance saved. Open the site in a new tab to see it.');
  res.redirect('/admin/appearance');
});

router.get('/homepage', (req, res) => {
  res.render('admin/homepage', { title: 'Homepage sections', sections: getSections() });
});

router.post('/install-app', (req, res) => {
  setSetting('install_prompt', req.body.install_prompt ? '1' : '0');
  flash(req, 'success', req.body.install_prompt ? 'Visitors will be offered the app.' : 'The "install the app" prompt is off.');
  res.redirect('/admin/homepage#install');
});

router.post('/homepage', (req, res) => {
  const order = String(req.body.order || '').split(',').filter(Boolean);
  saveSections(order.length ? order : Object.keys(SECTIONS), [].concat(req.body.visible || []), [].concat(req.body.members_only || []));
  flash(req, 'success', 'Homepage sections saved.');
  res.redirect('/admin/homepage');
});

// Image upload for the visual blog editor; returns { url }.
router.post('/uploads/image', upload.single('image'), verifyCsrf, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose a JPG, PNG, WebP or GIF image under 3 MB.' });
  res.json({ url: uploadedPath(req.file) });
});

// --- Social media links and lawyer profile settings --------------------------------------

router.get('/social', (req, res) => {
  const s = getSettings();
  res.render('admin/social', { title: 'Social media', networks: SOCIAL_KEYS.map((k) => ({ key: k, ...NETWORKS[k], url: s[`social_${k}`] || '' })), socialIcon });
});

router.post('/social', (req, res) => {
  const errors = saveSiteSocial(req.body);
  if (errors.length) errors.forEach((m) => flash(req, 'error', m));
  else flash(req, 'success', 'Social media links saved. They appear as icons in the site footer.');
  res.redirect('/admin/social');
});

router.get('/profile-settings', (req, res) => {
  res.render('admin/profile-settings', { title: 'Lawyer profiles', options: PROFILE_OPTIONS, pf: getProfileSettings(), mailOn: smtpEnabled(), languages: getLanguageOptions(), unlisted: unlistedLanguages(), SORT_LABELS, search: getSearchSettings() });
});

router.post('/search-settings', (req, res) => {
  saveSearchSettings(req.body);
  flash(req, 'success', 'Search result settings saved.');
  res.redirect('/admin/profile-settings#search');
});

router.post('/languages', (req, res) => {
  const list = saveLanguageOptions(req.body.language_options);
  flash(req, 'success', `Language list saved (${list.length} languages).`);
  res.redirect('/admin/profile-settings#languages');
});

router.post('/profile-settings', (req, res) => {
  saveProfileSettings(req.body);
  flash(req, 'success', 'Lawyer profile settings saved.');
  res.redirect('/admin/profile-settings');
});

export default router;
