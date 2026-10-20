import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import crypto from 'node:crypto';
import path from 'node:path';
import { ROOT, db } from './db.js';
import { SqliteStore, locals, csrfUnlessMultipart } from './middleware.js';
import publicRoutes from './routes/public.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import adminRoutes from './routes/admin.js';
import { aiEnabled, MODEL } from './ai/client.js';

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  console.warn('No users yet. Run `npm run seed` to create an admin account and sample data.');
}

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
app.use(express.static(path.join(ROOT, 'public'), { maxAge: prod ? '7d' : 0 }));
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
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`LexFind running at http://localhost:${port}`);
  console.log(aiEnabled() ? `AI features enabled (${MODEL}).` : 'AI features in offline mode: set ANTHROPIC_API_KEY to enable Claude.');
});
