import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { SqliteStore, locals, csrfUnlessMultipart, uploadDir } from './middleware.js';
import { bootstrapIfEmpty, applyAdminReset } from './bootstrap.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/admin.js';
import { aiEnabled, MODEL } from './ai/client.js';

bootstrapIfEmpty();
applyAdminReset();

const app = express();
const prod = process.env.NODE_ENV === 'production';
if (prod) app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(ROOT, 'views'));

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
// NOINDEX=1 keeps a test or staging site out of search engines.
const noindex = Boolean(process.env.NOINDEX && process.env.NOINDEX !== '0');
app.get('/robots.txt', (req, res) => res.type('text/plain').send(noindex ? 'User-agent: *\nDisallow: /\n' : 'User-agent: *\nDisallow: /admin\nDisallow: /dashboard\nDisallow: /invite\n'));
if (noindex) app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
app.use(express.static(path.join(ROOT, 'public'), { maxAge: prod ? '7d' : 0 }));
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
