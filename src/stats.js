// Usage statistics (Admin → Statistics). Member activity is recorded as small events; admins' own
// activity is not, so the numbers reflect how members use the directory. Events older than 400 days
// are deleted.
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  lawyer_id INTEGER REFERENCES lawyers(id) ON DELETE SET NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_type_time ON events (type, created_at);
CREATE INDEX IF NOT EXISTS events_time ON events (created_at);`);

export const EVENT_LABELS = {
  login: 'Sign-ins',
  search: 'Searches',
  profile_view: 'Profile views',
  ai_message: 'AI questions',
  referral: 'Referrals',
  pdf_export: 'PDF exports',
  email_results: 'Results emailed',
  inquiry: 'Messages sent',
  register: 'New registrations',
};

/** Record one event. `user` is the signed-in user (admins aren't counted). Never throws. */
export function track(type, { user, lawyerId = null, detail = null } = {}) {
  if (!EVENT_LABELS[type] || user?.role === 'admin') return;
  try {
    db.prepare('INSERT INTO events (type, user_id, lawyer_id, detail) VALUES (?, ?, ?, ?)')
      .run(type, user?.id ?? null, lawyerId, detail == null ? null : JSON.stringify(detail));
  } catch (e) {
    console.error('[stats] could not record event:', e.message);
  }
}

export function pruneEvents() {
  db.prepare("DELETE FROM events WHERE created_at < datetime('now', '-400 days')").run();
}

export const PERIODS = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };

/** Everything the statistics page shows, for the last `days` days. */
export function usageStats(days) {
  const since = `-${days} days`;
  const all = (sql, ...p) => db.prepare(sql).all(since, ...p);
  const one = (sql, ...p) => db.prepare(sql).get(since, ...p);

  const counts = Object.fromEntries(Object.keys(EVENT_LABELS).map((t) => [t, 0]));
  for (const r of all("SELECT type, COUNT(*) n FROM events WHERE created_at >= datetime('now', ?) GROUP BY type")) counts[r.type] = r.n;
  const activeMembers = one("SELECT COUNT(DISTINCT user_id) n FROM events WHERE user_id IS NOT NULL AND created_at >= datetime('now', ?)").n;

  // Activity per day: every member action except sign-ins and registrations.
  const perDay = new Map(all(`SELECT date(created_at) d, COUNT(*) n, COUNT(DISTINCT user_id) members FROM events
    WHERE type NOT IN ('login', 'register') AND created_at >= datetime('now', ?) GROUP BY d`).map((r) => [r.d, r]));
  const daily = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    daily.push({ date: d, actions: perDay.get(d)?.n || 0, members: perDay.get(d)?.members || 0 });
  }

  const areaNames = new Map(db.prepare('SELECT slug, name FROM practice_areas').all().map((a) => [a.slug, a.name]));
  const topAreas = all(`SELECT json_extract(detail, '$.area') area, COUNT(*) n FROM events
    WHERE type = 'search' AND json_extract(detail, '$.area') <> '' AND created_at >= datetime('now', ?)
    GROUP BY area ORDER BY n DESC LIMIT 10`).map((r) => ({ label: areaNames.get(r.area) || r.area, n: r.n }));
  const topKeywords = all(`SELECT lower(trim(json_extract(detail, '$.q'))) q, COUNT(*) n FROM events
    WHERE type = 'search' AND trim(json_extract(detail, '$.q')) <> '' AND created_at >= datetime('now', ?)
    GROUP BY q ORDER BY n DESC LIMIT 10`).map((r) => ({ label: r.q, n: r.n }));
  const topLawyers = (type) => all(`SELECT l.name label, l.slug, COUNT(*) n FROM events e JOIN lawyers l ON l.id = e.lawyer_id
    WHERE e.created_at >= datetime('now', ?) AND e.type = ? GROUP BY e.lawyer_id ORDER BY n DESC LIMIT 10`, type);
  const activeList = all(`SELECT COALESCE(l.name, u.email) label, l.slug, COUNT(*) n, MAX(e.created_at) last_seen
    FROM events e JOIN users u ON u.id = e.user_id LEFT JOIN lawyers l ON l.user_id = u.id
    WHERE e.type <> 'login' AND e.created_at >= datetime('now', ?) GROUP BY e.user_id ORDER BY n DESC LIMIT 10`);

  const members = db.prepare(`SELECT
      (SELECT COUNT(*) FROM users u JOIN lawyers l ON l.user_id = u.id WHERE u.role = 'lawyer' AND l.status = 'active') approved,
      (SELECT COUNT(*) FROM users u JOIN lawyers l ON l.user_id = u.id WHERE u.role = 'lawyer' AND l.status = 'pending') pending,
      (SELECT COUNT(*) FROM lawyers WHERE status = 'active' AND hidden = 0) listed`).get();

  return {
    days, counts, activeMembers, daily, members,
    topAreas, topKeywords,
    topViewed: topLawyers('profile_view'),
    topReferred: topLawyers('referral'),
    activeList,
  };
}
