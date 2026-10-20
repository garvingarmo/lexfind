// Creates the admin account, practice areas and (unless --no-demo) sample data.
// All sample lawyers are fictional.
import crypto from 'node:crypto';
import { db, slugify } from './db.js';
import { createLawyer, setAreas } from './models.js';
import { ensureAreas, ensureUser } from './bootstrap.js';

const demo = !process.argv.includes('--no-demo');

ensureAreas();
const areaId = Object.fromEntries(db.prepare('SELECT id, name FROM practice_areas').all().map((a) => [a.name, a.id]));

const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
const admin = ensureUser(adminEmail, 'admin', adminPassword);
console.log(admin.created ? `Admin account: ${adminEmail} / ${adminPassword}` : `Admin ${adminEmail} already exists.`);

if (demo && !db.prepare('SELECT 1 FROM lawyers LIMIT 1').get()) {
  const L = [
    ['Maria Delgado', 'Delgado Family Law', 'Los Angeles', 'CA', ['Family Law'], 14, 'English, Spanish', 1, 1, 'Maria Delgado represents parents and spouses in divorce, custody and support matters across Los Angeles County. She focuses on negotiated settlements and mediation, and litigates when an agreement is not possible.'],
    ['James Whitaker', 'Whitaker Defense Group', 'Los Angeles', 'CA', ['Criminal Defense'], 21, 'English', 1, 1, 'A former deputy public defender, James Whitaker defends clients charged with DUI, drug offenses and serious felonies in state and federal court.'],
    ['Priya Raman', 'Raman Immigration Law', 'San Francisco', 'CA', ['Immigration'], 11, 'English, Hindi, Tamil', 1, 0, 'Priya Raman helps individuals, families and employers with employment visas, family-based green cards, naturalization and asylum applications.'],
    ['Kevin O\'Brien', 'O\'Brien Injury Attorneys', 'San Diego', 'CA', ['Personal Injury'], 18, 'English', 1, 1, 'Kevin O\'Brien represents people injured in car, motorcycle and pedestrian accidents. Contingency fee — no fee unless he recovers compensation.'],
    ['Sarah Chen', 'Chen & Park LLP', 'San Francisco', 'CA', ['Business Law', 'Intellectual Property'], 9, 'English, Mandarin', 0, 0, 'Sarah Chen advises startups and small businesses on formation, financing, commercial contracts, and trademark protection.'],
    ['Robert Hayes', 'Hayes Employment Law', 'Houston', 'TX', ['Employment Law'], 16, 'English', 1, 0, 'Robert Hayes represents employees in wrongful termination, discrimination, retaliation and unpaid overtime claims.'],
    ['Ana Gutierrez', 'Gutierrez Law Office', 'Houston', 'TX', ['Immigration', 'Family Law'], 12, 'English, Spanish', 1, 1, 'Ana Gutierrez handles family-based immigration, DACA renewals, removal defense and related family law matters for Houston-area families.'],
    ['Michael Turner', 'Turner Criminal Defense', 'Dallas', 'TX', ['Criminal Defense'], 25, 'English', 0, 0, 'Michael Turner is a board-certified criminal law specialist who defends clients against misdemeanor and felony charges throughout North Texas.'],
    ['Linda Brooks', 'Brooks Estate & Elder Law', 'Austin', 'TX', ['Estate Planning'], 20, 'English', 1, 0, 'Linda Brooks prepares wills, living trusts and powers of attorney, and guides families through probate and estate administration.'],
    ['David Goldstein', 'Goldstein Real Estate Law', 'New York', 'NY', ['Real Estate'], 15, 'English, Hebrew', 0, 1, 'David Goldstein represents buyers, sellers and landlords in residential and commercial real estate transactions and disputes in New York City.'],
    ['Aisha Johnson', 'Johnson Legal PLLC', 'New York', 'NY', ['Employment Law', 'Business Law'], 10, 'English, French', 1, 0, 'Aisha Johnson counsels employees and small employers on workplace rights, severance agreements, and employment contracts.'],
    ['Thomas Russo', 'Russo Bankruptcy Law', 'Brooklyn', 'NY', ['Bankruptcy'], 13, 'English, Italian', 1, 0, 'Thomas Russo helps individuals and small businesses get a fresh start through Chapter 7 and Chapter 13 bankruptcy and stops foreclosures and garnishments.'],
    ['Carmen Vega', 'Vega Family & Divorce', 'Miami', 'FL', ['Family Law'], 17, 'English, Spanish, Portuguese', 1, 1, 'Carmen Vega handles divorce, alimony, timesharing and relocation cases, including those involving international families.'],
    ['Daniel Morris', 'Morris Injury Law', 'Orlando', 'FL', ['Personal Injury'], 8, 'English', 1, 0, 'Daniel Morris represents victims of auto accidents, premises liability and dog bites throughout Central Florida.'],
    ['Rachel Kim', 'Kim Tax & Business Counsel', 'Chicago', 'IL', ['Tax Law', 'Business Law'], 12, 'English, Korean', 0, 0, 'Rachel Kim is a tax attorney and CPA who resolves IRS audits and tax debt and advises businesses on tax-efficient structures.'],
    ['Marcus Bell', 'Bell Landlord-Tenant Law', 'Chicago', 'IL', ['Real Estate'], 7, 'English', 1, 0, 'Marcus Bell represents tenants and small landlords in lease disputes, security deposit claims and eviction proceedings in Cook County.'],
  ];
  for (const [name, firm, city, state, areas, years, languages, free, featured, bio] of L) {
    const id = createLawyer({
      name, firm, city, state, bio, years_experience: years, languages, free_consultation: free,
      title: 'Attorney at Law', email: `${slugify(name).replace(/-/g, '.')}@example.com`, phone: '(555) 010-' + String(1000 + Math.floor(Math.random() * 8999)).slice(0, 4),
      bar_admissions: `${state} (${new Date().getFullYear() - years})`,
      fee_structure: areas.includes('Personal Injury') ? 'Contingency fee' : 'Hourly; flat fees available for some matters',
      website: `https://www.example.com/${slugify(firm)}`,
    });
    db.prepare("UPDATE lawyers SET status = 'active', verified = 1, featured = ?, is_sample = 1 WHERE id = ?").run(featured, id);
    setAreas(id, areas.map((a) => areaId[a]));
  }

  // Demo lawyer login linked to the first listing.
  const demoLawyer = ensureUser('lawyer@example.com', 'lawyer', 'lawyer-demo-123');
  db.prepare('UPDATE lawyers SET user_id = ? WHERE id = (SELECT MIN(id) FROM lawyers)').run(demoLawyer.id);
  console.log('Demo lawyer login: lawyer@example.com / lawyer-demo-123');

  const firstFeatured = db.prepare('SELECT id, slug, name FROM lawyers WHERE featured = 1 ORDER BY id LIMIT 3').all();
  const adIns = db.prepare('INSERT INTO ads (title, body, link_url, cta, placement, lawyer_id, is_sample) VALUES (?, ?, ?, ?, ?, ?, 1)');
  adIns.run('Going through a divorce?', `${firstFeatured[0].name} offers free 30-minute consultations for Los Angeles families.`, `/lawyers/${firstFeatured[0].slug}`, 'Book a consultation', 'search_sidebar', firstFeatured[0].id);
  adIns.run('Charged with a crime?', 'Former public defender. Available 24/7 for urgent matters.', `/lawyers/${firstFeatured[1].slug}`, 'Get help now', 'profile_sidebar', firstFeatured[1].id);
  adIns.run('Advertise your practice here', 'Reach people actively looking for a lawyer in your practice area and city.', '/register', 'List your practice', 'home_banner', null);
  adIns.run('Hurt in an accident?', 'No fee unless we win. Free case review.', `/lawyers/${firstFeatured[2].slug}`, 'Free case review', 'blog_sidebar', firstFeatured[2].id);

  const posts = [
    ['How to choose the right lawyer for your case', 'Five questions to ask before you hire an attorney.',
      'Hiring a lawyer is a big decision. Here are some questions worth asking in a first consultation.\n\n## 1. How much of your practice is cases like mine?\n\nAn attorney who regularly handles your type of matter will know the local courts, procedures and typical outcomes.\n\n## 2. Who will actually work on my case?\n\nAt larger firms, associates or paralegals may do much of the day-to-day work. That is fine — just know who to contact.\n\n## 3. How do you charge?\n\nCommon arrangements are hourly billing, flat fees and contingency fees (common in personal injury). Ask for the fee agreement in writing.\n\n## 4. What are the likely next steps and timeline?\n\nA good lawyer will explain the process without promising a particular result.\n\n## 5. How will we communicate?\n\nAgree on how often you will get updates and how quickly calls and emails are returned.'],
    ['What to bring to your first consultation', 'A short checklist that will make your first meeting with a lawyer more productive.',
      'Preparing for a consultation helps your lawyer give useful guidance quickly.\n\n- A short written timeline of what happened, with dates\n- Any letters, emails, contracts, court papers or notices you have received\n- Names and contact details of the other people involved\n- Any deadlines or court dates\n- A list of questions you want answered\n\nIf you are not sure whether a document matters, bring it.'],
    ['Contingency, hourly or flat fee: how lawyers charge', 'Understanding the most common fee arrangements.',
      '## Contingency fees\n\nThe lawyer is paid a percentage of any recovery, typically in personal injury cases. If there is no recovery, there is usually no fee, although you may still owe costs.\n\n## Hourly fees\n\nYou pay for the time spent on your matter, often with an upfront retainer.\n\n## Flat fees\n\nA single fee for a defined task, such as drafting a will or handling an uncontested divorce.\n\nAlways get the arrangement in writing.'],
  ];
  const pIns = db.prepare("INSERT INTO posts (title, slug, excerpt, body, author, status, published_at, is_sample) VALUES (?, ?, ?, ?, 'Chaldean Law Editorial Team', 'published', datetime('now', ?), 1)");
  posts.forEach(([t, ex, body], i) => pIns.run(t, slugify(t), ex, body, `-${i * 3} days`));
  console.log(`Seeded ${L.length} sample lawyers, 4 ads and ${posts.length} blog posts.`);
}
