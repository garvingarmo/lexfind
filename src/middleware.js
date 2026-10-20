import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import session from 'express-session';
import multer from 'multer';
import { db, ROOT, DATA_DIR, getSettings } from './db.js';
import { getLawyer } from './models.js';
import { textHelpers } from './texts.js';
import { getTheme, themeVersion, fontUrl } from './theme.js';
import { getSiteSocial, socialIcon } from './social.js';
import { getProfileSettings } from './profileSettings.js';

/** express-session store backed by the app's SQLite database. */
export class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.prepare('INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires')
        .run(sid, JSON.stringify(sess), expires);
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try { db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); cb?.(null); } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

/** Template locals: settings, current user, flash messages, CSRF token. */
export function locals(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  res.locals.settings = getSettings();
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || [];
  delete req.session.flash;
  res.locals.user = null;
  if (req.session.userId) {
    const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(req.session.userId);
    if (user) {
      req.user = user;
      if (user.role === 'lawyer') req.lawyer = getLawyer('user', user.id);
      res.locals.user = user;
      res.locals.myLawyer = req.lawyer || null;
    }
  }
  // Admins can switch on "Edit page" to change wording by clicking it.
  const editMode = Boolean(req.user?.role === 'admin' && req.session.editMode && !req.path.startsWith('/admin') && !req.path.startsWith('/dashboard'));
  res.locals.editMode = editMode;
  Object.assign(res.locals, textHelpers(res.locals.settings, editMode));
  const theme = getTheme();
  res.locals.theme = theme;
  res.locals.themeV = themeVersion(theme);
  res.locals.fontUrl = fontUrl(theme.theme_font);
  res.locals.siteSocial = getSiteSocial();
  res.locals.socialIcon = socialIcon;
  res.locals.pf = getProfileSettings();
  next();
}

export function flash(req, type, msg) {
  (req.session.flash ||= []).push({ type, msg });
}

/** Rejects state-changing requests that lack the session's CSRF token. */
export function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body?._csrf || req.get('x-csrf-token');
  const expected = req.session.csrf;
  if (token && expected && token.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) return next();
  res.status(403);
  if (req.is('json') || req.accepts(['html', 'json']) === 'json') return res.json({ error: 'Invalid or missing CSRF token. Reload the page and try again.' });
  return res.render('error', { title: 'Session expired', message: 'Your form session expired. Go back, reload the page and try again.' });
}

/** Multipart forms are parsed by multer, so CSRF is checked after it rather than globally. */
export function csrfUnlessMultipart(req, res, next) {
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  flash(req, 'info', 'Please sign in to continue.');
  res.redirect('/login');
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireLogin(req, res, next);
    if (req.user.role !== role) return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have access to this page.' });
    next();
  };
}

/** Small fixed-window rate limiter keyed by session or IP. */
export function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.session?.userId ? `u${req.session.userId}` : req.ip;
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) h = { n: 0, reset: now + windowMs };
    h.n++;
    hits.set(key, h);
    if (h.n > max) return res.status(429).json({ error: message || 'Too many requests. Please wait a moment.' });
    next();
  };
}

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || (process.env.DATA_DIR ? path.join(DATA_DIR, 'uploads') : path.join(ROOT, 'public', 'uploads')));
fs.mkdirSync(uploadDir, { recursive: true });

const imageUpload = (files) => multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype];
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024, files },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype)),
});

export const upload = imageUpload(1);
export const uploadTwo = imageUpload(2);

export const uploadedPath = (file) => (file ? `/uploads/${file.filename}` : null);
