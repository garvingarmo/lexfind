// Lawyer self-service: maintain the listing, read inquiries, run AI research on their own profile.
import { Router } from 'express';
import { db } from '../db.js';
import { listAreas, cleanLawyerInput, updateLawyer, setAreas, getLawyer } from '../models.js';
import { requireRole, flash, upload, uploadedPath, verifyCsrf } from '../middleware.js';
import { startEnrichment, getEnrichment, diffRows, applyEnrichment } from '../ai/enrich.js';
import { aiEnabled } from '../ai/client.js';

const router = Router();
router.use(requireRole('lawyer'));
router.use((req, res, next) => {
  if (!req.lawyer) return res.status(404).render('error', { title: 'No listing', message: 'Your account is not linked to a listing. Please contact support.' });
  next();
});

router.get('/', (req, res) => {
  const l = req.lawyer;
  const stats = {
    unread: db.prepare('SELECT COUNT(*) n FROM inquiries WHERE lawyer_id = ? AND is_read = 0').get(l.id).n,
    total: db.prepare('SELECT COUNT(*) n FROM inquiries WHERE lawyer_id = ?').get(l.id).n,
    fromAssistant: db.prepare("SELECT COUNT(*) n FROM inquiries WHERE lawyer_id = ? AND source = 'assistant'").get(l.id).n,
  };
  const fields = ['bio', 'phone', 'website', 'address', 'education', 'bar_admissions', 'years_experience', 'languages', 'fee_structure', 'photo'];
  const completeness = Math.round(((fields.filter((f) => l[f] != null && l[f] !== '').length + (l.areas.length ? 1 : 0)) / (fields.length + 1)) * 100);
  const recent = db.prepare('SELECT * FROM inquiries WHERE lawyer_id = ? ORDER BY created_at DESC LIMIT 5').all(l.id);
  const lastJob = db.prepare('SELECT * FROM enrichments WHERE lawyer_id = ? ORDER BY id DESC LIMIT 1').get(l.id);
  res.render('dashboard/index', { title: 'Dashboard', l, stats, completeness, recent, lastJob });
});

router.get('/profile', (req, res) => {
  res.render('dashboard/profile', { title: 'Edit profile', l: req.lawyer, areas: listAreas(), selected: new Set(req.lawyer.areas.map((a) => a.slug)) });
});

router.post('/profile', upload.single('photo'), verifyCsrf, (req, res) => {
  const data = cleanLawyerInput(req.body);
  if (!data.name) {
    flash(req, 'error', 'Name is required.');
    return res.redirect('/dashboard/profile');
  }
  if (data.state) data.state = data.state.toUpperCase().slice(0, 2);
  if (req.file) data.photo = uploadedPath(req.file);
  if (req.body.remove_photo) data.photo = null;
  updateLawyer(req.lawyer.id, data);
  setAreas(req.lawyer.id, [].concat(req.body.areas || []));
  flash(req, 'success', 'Profile saved.');
  res.redirect('/dashboard/profile');
});

router.get('/inquiries', (req, res) => {
  const rows = db.prepare('SELECT * FROM inquiries WHERE lawyer_id = ? ORDER BY created_at DESC').all(req.lawyer.id);
  res.render('dashboard/inquiries', { title: 'Inquiries', rows });
});

router.post('/inquiries/:id/read', (req, res) => {
  db.prepare('UPDATE inquiries SET is_read = 1 WHERE id = ? AND lawyer_id = ?').run(req.params.id, req.lawyer.id);
  res.redirect('/dashboard/inquiries');
});

// --- AI research -----------------------------------------------------------

router.get('/research', (req, res) => {
  const jobs = db.prepare('SELECT * FROM enrichments WHERE lawyer_id = ? ORDER BY id DESC LIMIT 10').all(req.lawyer.id);
  res.render('research/start', { title: 'AI profile update', l: req.lawyer, jobs, aiOn: aiEnabled(), base: '/dashboard/research' });
});

router.post('/research', (req, res) => {
  const recent = db.prepare("SELECT COUNT(*) n FROM enrichments WHERE lawyer_id = ? AND created_at > datetime('now','-1 hour')").get(req.lawyer.id).n;
  if (recent >= 3) {
    flash(req, 'error', 'You can run AI research up to 3 times per hour. Please try again later.');
    return res.redirect('/dashboard/research');
  }
  try {
    const id = startEnrichment(req.lawyer.id, req.user.id);
    res.redirect(`/dashboard/research/${id}`);
  } catch (e) {
    flash(req, 'error', e.message);
    res.redirect('/dashboard/research');
  }
});

function ownJob(req, res, next) {
  const job = getEnrichment(req.params.id);
  if (!job || job.lawyer_id !== req.lawyer.id) return next('route');
  req.job = job;
  next();
}

router.get('/research/:id', ownJob, (req, res) => {
  const l = getLawyer('id', req.lawyer.id);
  res.render('research/review', { title: 'Review AI suggestions', l, job: req.job, rows: diffRows(l, req.job.proposed), base: '/dashboard/research' });
});

router.get('/research/:id/status', ownJob, (req, res) => res.json({ status: req.job.status }));

router.post('/research/:id/apply', ownJob, (req, res) => {
  if (req.job.status !== 'ready') return res.redirect(`/dashboard/research/${req.job.id}`);
  applyEnrichment(req.job, [].concat(req.body.fields || []));
  flash(req, 'success', 'Selected updates were applied to your profile.');
  res.redirect('/dashboard/profile');
});

router.post('/research/:id/reject', ownJob, (req, res) => {
  db.prepare("UPDATE enrichments SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(req.job.id);
  flash(req, 'info', 'Suggestions dismissed.');
  res.redirect('/dashboard/research');
});

export default router;
