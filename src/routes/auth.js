import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, tx } from '../db.js';
import { createLawyer, setAreas, listAreas, getLawyer } from '../models.js';
import { flash, rateLimit } from '../middleware.js';
import { checkInvite, acceptInvite, baseUrl, createInvite, sendInvite } from '../invites.js';
import { requestReset, findReset, setPassword } from '../passwords.js';
import { mailEnabled } from '../mailer.js';
import { membersOnly, notifyRegistration } from '../members.js';
import { track } from '../stats.js';
import { findMatches } from '../duplicates.js';

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
    track('login', { user });
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
  // Already in the directory (e.g. imported)? Ask before creating a second listing.
  const matches = findMatches(regDetails(b));
  if (matches.length) {
    req.session.pendingRegistration = { form: { ...b, password: undefined, password2: undefined }, hash: bcrypt.hashSync(b.password, 10), ids: matches.map((m) => m.lawyer.id), at: Date.now() };
    return res.render('register-match', { title: 'Are you already listed?', matches: matches.map(publicMatch) });
  }
  completeRegistration(req, res, b, bcrypt.hashSync(b.password, 10));
});

// The "Is this you?" step: claim an existing listing by email link, or carry on registering.
router.post('/register/match', authLimit, async (req, res) => {
  const p = req.session.pendingRegistration;
  if (!p || Date.now() - p.at > 60 * 60 * 1000) {
    delete req.session.pendingRegistration;
    flash(req, 'error', 'That registration timed out. Please fill in the form again.');
    return res.redirect('/register');
  }
  const id = Number(req.body.lawyer_id);
  const listing = p.ids.includes(id) ? getLawyer('id', id) : null;
  if (req.body.action === 'claim' && listing && !listing.user_id && listing.email) {
    try {
      await sendInvite(createInvite(listing.id, null), req);
    } catch (e) {
      console.error('claim email failed:', e.message);
      flash(req, 'error', 'We could not send the email just now. Please try again in a few minutes, or contact us.');
      return res.render('register-match', { title: 'Are you already listed?', matches: p.ids.map((i) => getLawyer('id', i)).filter(Boolean).map((l) => publicMatch({ lawyer: l })) });
    }
    delete req.session.pendingRegistration;
    return res.render('register-claim-sent', { title: 'Check your email', email: maskEmail(listing.email) });
  }
  delete req.session.pendingRegistration;
  // "This is me" for a listing we can't email a link for: register, and tell the admins which listing to merge with.
  const sameAs = req.body.action === 'mine' && listing ? listing.id : null;
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get((p.form.email || '').trim())) {
    flash(req, 'error', 'An account with this email already exists.');
    return res.redirect('/login');
  }
  completeRegistration(req, res, p.form, p.hash, { sameAs });
});

/** The registration form as a candidate for duplicate checks. */
const regDetails = (b) => ({ name: b.name, email: b.email, phone: b.phone, mobile: b.mobile, city: b.city, state: b.state, bar_number: b.bar_number });

/** What the person registering may see of a matching listing (no contact details, just a masked email). */
const publicMatch = (m) => ({
  id: m.lawyer.id, name: m.lawyer.name, firm: m.lawyer.firm, place: [m.lawyer.city, m.lawyer.state].filter(Boolean).join(', '),
  claimed: Boolean(m.lawyer.user_id), email: m.lawyer.email ? maskEmail(m.lawyer.email) : null,
});

const maskEmail = (e) => e.replace(/^(.)(.*)(@.*)$/, (_, a, mid, dom) => `${a}${'•'.repeat(Math.min(mid.length, 6))}${dom}`);

/** Create the login and pending listing, notify the admins, and sign the new lawyer in. */
function completeRegistration(req, res, b, passwordHash, { sameAs = null } = {}) {
  const userId = tx(() => {
    const uid = Number(db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, 'lawyer')")
      .run(b.email.trim(), passwordHash).lastInsertRowid);
    const lid = createLawyer({
      name: b.name.trim().slice(0, 120), firm: (b.firm || '').trim().slice(0, 160) || null, email: b.email.trim(),
      phone: (b.phone || '').trim().slice(0, 40) || null, phone_ext: (b.phone_ext || '').trim().slice(0, 10) || null, mobile: (b.mobile || '').trim().slice(0, 40) || null, city: b.city.trim().slice(0, 80), state: b.state.trim().toUpperCase().slice(0, 2),
      address: (b.address || '').trim().slice(0, 200) || null, zip: (b.zip || '').trim().slice(0, 10) || null,
      bar_number: b.bar_number.trim().slice(0, 60),
    });
    db.prepare('UPDATE lawyers SET user_id = ? WHERE id = ?').run(uid, lid);
    setAreas(lid, [].concat(b.areas || []));
    return uid;
  });
  track('register', { user: { id: userId, role: 'lawyer' } });
  const lawyerId = db.prepare('SELECT id FROM lawyers WHERE user_id = ?').get(userId)?.id;
  if (lawyerId) notifyRegistration(lawyerId, baseUrl(req), { sameAs });
  req.session.regenerate(() => {
    req.session.userId = userId;
    flash(req, 'success', `Welcome! Complete your profile below. Your listing will go live${membersOnly() ? ', and you will get access to the directory and AI tools,' : ''} once our team verifies it.`);
    res.redirect('/dashboard/profile');
  });
}

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
