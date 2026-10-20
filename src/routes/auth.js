import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.js';
import { createLawyer, setAreas, listAreas } from '../models.js';
import { flash, rateLimit } from '../middleware.js';
import { checkInvite, acceptInvite } from '../invites.js';
import { requestReset, findReset, setPassword } from '../passwords.js';
import { mailEnabled } from '../mailer.js';
import { membersOnly } from '../members.js';

const router = Router();
const authLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Try again in a few minutes.' });

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  res.render('login', { title: 'Sign in' });
});

router.post('/login', authLimit, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    flash(req, 'error', 'Incorrect email or password.');
    return res.redirect('/login');
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.id;
    res.redirect(returnTo || (user.role === 'admin' ? '/admin' : '/dashboard'));
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.render('register', { title: 'List your practice', areas: listAreas(), form: {} });
});

router.post('/register', authLimit, (req, res) => {
  const b = req.body;
  const errors = [];
  if (!b.name?.trim()) errors.push('Name is required.');
  if (!/^\S+@\S+\.\S+$/.test(b.email || '')) errors.push('A valid email is required.');
  if ((b.password || '').length < 8) errors.push('Password must be at least 8 characters.');
  if (b.password !== b.password2) errors.push('Passwords do not match.');
  if (!b.city?.trim() || !b.state?.trim()) errors.push('City and state are required.');
  if (!b.bar_number?.trim()) errors.push('Bar number is required so we can verify your listing.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get((b.email || '').trim())) errors.push('An account with this email already exists.');
  if (errors.length) {
    return res.status(422).render('register', { title: 'List your practice', areas: listAreas(), form: b, flash: errors.map((msg) => ({ type: 'error', msg })) });
  }
  const userId = tx(() => {
    const uid = Number(db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'lawyer')")
      .run(b.email.trim(), bcrypt.hashSync(b.password, 10)).lastInsertRowid);
    const lid = createLawyer({
      name: b.name.trim().slice(0, 120), firm: (b.firm || '').trim().slice(0, 160) || null, email: b.email.trim(),
      phone: (b.phone || '').trim().slice(0, 40) || null, city: b.city.trim().slice(0, 80), state: b.state.trim().toUpperCase().slice(0, 2),
      bar_number: b.bar_number.trim().slice(0, 60),
    });
    db.prepare('UPDATE lawyers SET user_id = ? WHERE id = ?').run(uid, lid);
    setAreas(lid, [].concat(b.areas || []));
    return uid;
  });
  req.session.regenerate(() => {
    req.session.userId = userId;
    flash(req, 'success', `Welcome! Complete your profile below. Your listing will go live${membersOnly() ? ', and you will get access to the directory and AI tools,' : ''} once our team verifies it.`);
    res.redirect('/dashboard/profile');
  });
});

router.get('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  res.render('password', { title: 'Change password' });
});

router.post('/account/password', (req, res) => {
  if (!req.user) return res.redirect('/login');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { current, password, password2 } = req.body;
  if (!bcrypt.compareSync(current || '', u.password_hash)) flash(req, 'error', 'Current password is incorrect.');
  else if ((password || '').length < 8) flash(req, 'error', 'New password must be at least 8 characters.');
  else if (password !== password2) flash(req, 'error', 'New passwords do not match.');
  else {
    setPassword(u.id, password);
    flash(req, 'success', 'Password updated. Use your new password next time you sign in.');
  }
  res.redirect('/account/password');
});

// --- Claim a listing from an invitation link -------------------------------------

router.get('/invite/:token', (req, res) => {
  const check = checkInvite(req.params.token);
  res.render('invite', { title: 'Claim your listing', ...check, form: { email: check.invite?.email || check.lawyer?.email || '' } });
});

router.post('/invite/:token', authLimit, (req, res) => {
  const check = checkInvite(req.params.token);
  const email = (req.body.email || '').trim();
  const errors = [];
  if (!check.problem) {
    if (!/^\S+@\S+\.\S+$/.test(email)) errors.push('Please enter a valid email address.');
    if ((req.body.password || '').length < 8) errors.push('Password must be at least 8 characters.');
    if (req.body.password !== req.body.password2) errors.push('Passwords do not match.');
    if (!req.body.confirm) errors.push('Please confirm that you are this lawyer or are authorized to manage the listing.');
  }
  if (check.problem || errors.length) {
    return res.status(check.problem ? 400 : 422).render('invite', {
      title: 'Claim your listing', ...check, form: { email }, flash: errors.map((msg) => ({ type: 'error', msg })),
    });
  }
  let userId;
  try {
    userId = acceptInvite(check.invite, email, req.body.password);
  } catch (e) {
    return res.status(422).render('invite', { title: 'Claim your listing', ...check, form: { email }, flash: [{ type: 'error', msg: e.message }] });
  }
  req.session.regenerate(() => {
    req.session.userId = userId;
    flash(req, 'success', 'Welcome! Your login is set up. Review your profile below and keep it up to date.');
    res.redirect('/dashboard/profile');
  });
});

// --- Forgot password ----------------------------------------------------------------

const resetLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: 'Too many reset requests. Please try again later.' });

router.get('/forgot-password', (req, res) => {
  res.render('forgot', { title: 'Forgot password', sent: false, mailOn: mailEnabled() });
});

router.post('/forgot-password', resetLimit, async (req, res) => {
  if (mailEnabled()) {
    try {
      await requestReset(req.body.email, req);
    } catch (e) {
      console.error('password reset email failed:', e.message);
      return res.status(502).render('forgot', { title: 'Forgot password', sent: false, mailOn: true, flash: [{ type: 'error', msg: 'We could not send the email right now. Please try again in a few minutes.' }] });
    }
  }
  res.render('forgot', { title: 'Forgot password', sent: true, mailOn: mailEnabled() });
});

router.get('/reset-password/:token', (req, res) => {
  res.render('reset', { title: 'Choose a new password', valid: Boolean(findReset(req.params.token)), token: req.params.token });
});

router.post('/reset-password/:token', authLimit, (req, res) => {
  const reset = findReset(req.params.token);
  const render = (msg) => res.status(422).render('reset', { title: 'Choose a new password', valid: Boolean(reset), token: req.params.token, flash: [{ type: 'error', msg }] });
  if (!reset) return render('This reset link is no longer valid.');
  if ((req.body.password || '').length < 8) return render('Password must be at least 8 characters.');
  if (req.body.password !== req.body.password2) return render('Passwords do not match.');
  setPassword(reset.user_id, req.body.password);
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(reset.user_id);
  req.session.regenerate(() => {
    req.session.userId = reset.user_id;
    flash(req, 'success', 'Your password has been changed and you are signed in.');
    res.redirect(user.role === 'admin' ? '/admin' : '/dashboard');
  });
});

export default router;
