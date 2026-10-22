import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ROOT, db, getSettings } from './db.js';
import { SqliteStore, locals, csrfUnlessMultipart, uploadDir } from './middleware.js';
import { bootstrapIfEmpty, applyAdminReset } from './bootstrap.js';
import { themeCss, getTheme } from './theme.js';
import { migrateSlugsToNames, backfillSortNames } from './models.js';
import { normalizeAllLanguages } from './languages.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/admin.js';
import { aiEnabled, MODEL } from './ai/client.js';
import { scheduleBackups } from './backup.js';
import { pruneEvents } from './stats.js';

bootstrapIfEmpty();
scheduleBackups();
pruneEvents();
applyAdminReset();
const renamed = migrateSlugsToNames();
if (renamed) console.log(`Changed ${renamed} lawyer profile URLs to first-last name (old URLs redirect).`);
backfillSortNames();
const tidied = normalizeAllLanguages();
if (tidied) console.log(`Tidied the languages on ${tidied} listings.`);

const app = express();
const prod = process.env.NODE_ENV === 'production';
if (prod) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));
// Version stamp for CSS/JS URLs: changes whenever those files change, so browsers never keep a
// stale copy after an update (they are cached for 7 days otherwise).
app.locals.assetV = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css')))
  .update(fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js')))
  .digest('hex').slice(0, 10);
// Version for the favicon and app icons, so devices fetch new ones (and a fresh manifest) when they change.
app.locals.iconV = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg')))
  .update(fs.readFileSync(path.join(ROOT, 'public', 'icons', 'icon-512.png')))
  .update(fs.readFileSync(path.join(ROOT, 'public', 'icons', 'apple-touch-icon.png')))
  .digest('hex').slice(0, 10);
// Version for the logo files (long-cached), so a new logo shows up straight away.
app.locals.brandV = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(ROOT, 'public', 'brand', 'chaldeanlaw-logo-horizontal.svg')))
  .digest('hex').slice(0, 10);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
    },
  },
}));
// Health check: which app instance answered (helps spot stale duplicate processes behind a proxy).
const instance = crypto.createHash('sha256').update(`${os.hostname()}:${process.pid}:${Date.now()}`).digest('hex').slice(0, 8);
const startedAt = new Date().toISOString();
app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, instance, startedAt, commit: process.env.GIT_COMMIT || null }));

// NOINDEX=1 keeps a test or staging site out of search engines.
const noindex = Boolean(process.env.NOINDEX && process.env.NOINDEX !== '0');
app.get('/robots.txt', (req, res) => res.type('text/plain').send(noindex ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /admin\nDisallow: /dashboard\nDisallow: /invite\n'));
if (noindex) app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
// The service worker must be re-checked by browsers, so it is never cached long-term.
app.get('/sw.js', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(ROOT, 'public', 'sw.js')));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: prod ? '7d' : 0 }));
// Third-party browser scripts, served from our own domain (the CSP only allows our own scripts).
app.get('/vendor/sortable.min.js', (req, res) => res.set('Cache-Control', 'public, max-age=604800').sendFile(path.join(ROOT, 'node_modules', 'sortablejs', 'Sortable.min.js')));
// The installed app's name on phones (iPhone reads it from the apple-mobile-web-app-title tag).
const APP_SHORT_NAME = 'Law Directory';
app.locals.appShortName = APP_SHORT_NAME;
// Install as an app (progressive web app): the manifest names the app after the site and uses its colours.
app.get('/manifest.webmanifest', (req, res) => {
  const s = getSettings();
  const theme = getTheme();
  res.type('application/manifest+json').set('Cache-Control', 'no-cache').send(JSON.stringify({
    name: s.site_name,
    short_name: APP_SHORT_NAME, // under the icon on a phone's home screen; desktops show the full name
    description: s.tagline,
    start_url: '/?source=app',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: theme.theme_primary,
    icons: [
      { src: `/icons/icon-192.png?v=${app.locals.iconV}`, sizes: '192x192', type: 'image/png' },
      { src: `/icons/icon-512.png?v=${app.locals.iconV}`, sizes: '512x512', type: 'image/png' },
      { src: `/icons/maskable-512.png?v=${app.locals.iconV}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});
// Appearance settings as a stylesheet; the URL carries a version, so it can be cached long-term.
app.get('/theme.css', (req, res) => res.type('text/css').set('Cache-Control', 'public, max-age=31536000, immutable').send(themeCss()));

// Pages are per-visitor (sessions, CSRF tokens, sign-in state). Forbid shared caches such as the
// hosting's nginx proxy from storing them, or one visitor's page is served to the next.
app.use((req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Cookie');
  next();
});
app.use('/uploads', express.static(uploadDir, { maxAge: prod ? '7d' : 0 }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));

let secret = process.env.SESSION_SECRET;
if (!secret) {
  if (prod) throw new Error('Set SESSION_SECRET in production.');
  secret = crypto.randomBytes(32).toString('hex');
}
app.use(session({
  store: new SqliteStore(),
  secret,
  resave: false,
  saveUninitialized: false,
  name: 'lf.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: prod, maxAge: 7 * 24 * 3600 * 1000 },
}));

app.use(locals);
app.use(csrfUnlessMultipart);

app.use(publicRoutes);
app.use(authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: "We couldn't find that page." }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  // Admins see the actual error so problems can be reported; visitors get a generic message.
  const detail = req.user?.role === 'admin' ? ` Error details: ${err.message}` : '';
  res.status(500).render('error', { title: 'Something went wrong', message: `An unexpected error occurred. Please try again.${detail}` });
});


const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  console.log(`Chaldean Law running at http://localhost:${port}`);
  console.log(aiEnabled() ? `AI features enabled (${MODEL}).` : 'AI features in offline mode: set ANTHROPIC_API_KEY to enable Claude.');
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use: the site is probably already running in another terminal. Stop it there, or run "npm run update" to restart it.`);
    process.exit(1);
  }
  throw err;
});
