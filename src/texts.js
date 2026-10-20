// Editable site wording. Pages call t(key) / e(key); admins change the wording on the page
// ("Edit page" mode) or in Admin → Texts. Saved values live in settings as `text.<key>`.
import { db, setSetting, DEFAULT_SETTINGS } from './db.js';

/** Every editable phrase, grouped by where it appears, with its default wording. */
export const TEXT_GROUPS = {
  'Header & footer': {
    'nav.find': 'Find a lawyer',
    'nav.ai': 'AI match',
    'nav.guides': 'Guides',
    'nav.signin': 'Lawyer sign in',
    'nav.list': 'List your practice',
    'footer.directory': 'Directory',
    'footer.find': 'Find a lawyer',
    'footer.ai': 'AI lawyer match',
    'footer.guides': 'Legal guides',
    'footer.forLawyers': 'For lawyers',
    'footer.list': 'List your practice',
    'footer.signin': 'Sign in',
    'footer.about': 'About',
    'footer.follow': 'Follow us',
    disclaimer: DEFAULT_SETTINGS.disclaimer,
    footer_text: DEFAULT_SETTINGS.footer_text,
  },
  'Home page': {
    hero_title: DEFAULT_SETTINGS.hero_title,
    hero_subtitle: DEFAULT_SETTINGS.hero_subtitle,
    'home.searchPlaceholder': 'Name, firm or keyword',
    'home.anyArea': 'Any practice area',
    'home.anyState': 'Any state',
    'home.searchButton': 'Search',
    'home.aiPill': 'AI lawyer match',
    'home.aiTitle': 'Not sure what kind of lawyer you need?',
    'home.aiText': 'Describe your situation in your own words. Our assistant will suggest lawyers who handle matters like yours.',
    'home.aiPlaceholder': "e.g. My landlord won't return my security deposit after I moved out…",
    'home.aiButton': 'Get matched',
    'home.aiNote': "Not legal advice. Don't include information you wouldn't share with a stranger.",
    'home.areasTitle': 'Browse by practice area',
    'home.featuredTitle': 'Featured lawyers',
    'home.seeAll': 'See all →',
    'home.howTitle': 'How it works',
    'home.step1Title': 'Describe or search.',
    'home.step1': 'Tell our AI assistant about your matter, or search by practice area and location.',
    'home.step2Title': 'Compare lawyers.',
    'home.step2': 'Review experience, languages, practice areas and fees.',
    'home.step3Title': 'Get in touch.',
    'home.step3': 'Send a message straight from the profile — the lawyer contacts you directly.',
    'home.guidesTitle': 'Legal guides',
    'home.allGuides': 'All guides →',
    'home.ctaTitle': 'Are you a lawyer?',
    'home.ctaText': 'Create your free listing, manage your profile, and receive inquiries from people who need your help.',
    'home.ctaButton': 'List your practice',
  },
  'Install app prompt': {
    'install.title': 'Get the Chaldean Law app',
    'install.text': 'Add it to your phone or computer for one-tap access.',
    'install.ios': 'Tap the Share button, then "Add to Home Screen".',
    'install.mac': 'In Safari, choose File → "Add to Dock".',
    'install.button': 'Install',
    'install.later': 'Not now',
  },
  'Client referrals': {
    'refer.title': 'Refer a client',
    'refer.intro': 'Send a client you are referring to',
    'refer.clientName': "Client's name",
    'refer.clientEmail': "Client's email",
    'refer.clientPhone': "Client's phone",
    'refer.matter': 'Brief description of the matter',
    'refer.optional': 'optional',
    'refer.matterPlaceholder': 'e.g. Needs help with a contested divorce in Oakland County',
    'refer.consent': 'The client has agreed to me sharing their details with this lawyer.',
    'refer.send': 'Send referral',
    'refer.note': 'The lawyer is emailed the client details, shown as referred by you, and can reply to you directly. You get a copy.',
    'card.refer': 'Refer a client',
  },
  'Members only': {
    'members.pill': 'Members only',
    'members.title': 'For registered lawyers',
    'members.text': 'Search the directory, view full lawyer profiles and use the AI lawyer match. Membership is for licensed lawyers and approved by our team.',
    'members.signin': 'Member sign in',
    'members.register': 'Apply for membership',
    'members.pendingTitle': 'Your membership is awaiting approval',
    'members.pendingText': 'Thanks for registering. Our team verifies every lawyer before giving access to the directory and AI tools. You will get an email once you are approved. In the meantime, complete your profile so we can approve it quickly.',
  },
  'Find a lawyer': {
    'search.title': 'Find a lawyer',
    'search.keywords': 'Keywords',
    'search.keywordsPlaceholder': 'Name, firm, keyword',
    'search.area': 'Practice area',
    'search.city': 'City',
    'search.state': 'State',
    'search.language': 'Language',
    'search.any': 'Any',
    'search.sortBy': 'Sort by',
    'search.sortBest': 'Best match',
    'search.sortExperience': 'Most experience',
    'search.sortLast': 'Last name (A–Z)',
    'search.sortName': 'First name (A–Z)',
    'search.sortNewest': 'Newest',
    'search.apply': 'Apply filters',
    'search.clear': 'Clear all',
    'search.found': 'lawyers found',
    'search.foundOne': 'lawyer found',
    'search.askAi': '✦ Ask the AI to match me',
    'results.selectOne': 'Select',
    'results.selectPage': 'Select all on this page',
    'results.selectAllPrefix': 'Select all',
    'results.selectAllSuffix': 'results',
    'results.selected': 'selected',
    'results.clear': 'Clear',
    'results.email': 'Email results',
    'results.pdf': 'Export PDF',
    'results.emailTitle': 'Email these lawyers',
    'results.emailIntro': "lawyers will be sent with their contact details and a PDF copy.",
    'results.emailTo': 'Send to (email address)',
    'results.emailFrom': 'Your name (optional)',
    'results.emailNote': 'Add a note (optional)',
    'results.cancel': 'Cancel',
    'results.send': 'Send email',
    'search.empty': 'No lawyers match these filters yet.',
    'search.emptyHint': 'Try removing a filter, or describe your matter to our AI assistant.',
  },
  'Lawyer cards & profiles': {
    'card.sponsored': 'Sponsored',
    'card.experience': 'yrs experience',
    'card.view': 'View profile',
    'profile.about': 'About',
    'profile.noBio': 'No bio yet.',
    'profile.details': 'Details',
    'profile.experience': 'Experience',
    'profile.years': 'years',
    'profile.languages': 'Languages',
    'profile.bar': 'Bar admissions',
    'profile.education': 'Education',
    'profile.yes': 'Yes',
    'profile.no': 'No',
    'profile.office': 'Office',
    'profile.contact': 'Contact',
    'profile.website': 'Visit website',
    'profile.emailButton': 'Email',
    'profile.follow': 'Follow',
    'profile.yourName': 'Your name',
    'profile.email': 'Email',
    'profile.phone': 'Phone (optional)',
    'profile.message': 'Briefly describe your matter',
    'profile.send': 'Send message',
    'profile.note': "Sending a message does not create an attorney-client relationship. Avoid confidential details until you've spoken with the lawyer.",
  },
  'AI assistant': {
    'assistant.title': 'AI lawyer match',
    'assistant.intro': "Tell us what's going on in your own words, plus anything that matters to you (language, budget, a city if you have one in mind). The assistant will suggest lawyers from our directory who handle matters like yours.",
    'assistant.greeting': 'Hi! What legal matter can I help you find a lawyer for?',
    'assistant.placeholder': 'e.g. I was injured in a car accident last month and the other driver’s insurer is ignoring me.',
    'assistant.startOver': 'Start over',
    'assistant.send': 'Send',
  },
  'Guides (blog)': {
    'blog.title': 'Legal guides & news',
    'blog.none': 'No posts yet.',
    'blog.back': '← All guides',
    'blog.ctaTitle': 'Need a lawyer?',
    'blog.ctaText': "Describe your situation and we'll suggest lawyers who can help.",
    'blog.ctaButton': 'Get matched',
    'blog.more': 'More guides',
  },
  'Sign in': {
    'login.title': 'Sign in',
    'login.subtitle': 'For lawyers and site administrators.',
    'login.email': 'Email',
    'login.password': 'Password',
    'login.button': 'Sign in',
    'login.forgot': 'Forgot your password?',
    'login.new': 'New here?',
    'login.create': 'Create your listing',
  },
};

export const TEXT_DEFAULTS = Object.assign({}, ...Object.values(TEXT_GROUPS));

// Keys that already exist as site settings keep their original storage key.
const storageKey = (key) => (key in DEFAULT_SETTINGS ? key : `text.${key}`);

/** Load all saved wording once per request. */
export function loadTexts() {
  const saved = {};
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'text.%'").all()) saved[r.key.slice(5)] = r.value;
  return saved;
}

export function saveTexts(changes) {
  for (const [key, value] of Object.entries(changes)) {
    if (!(key in TEXT_DEFAULTS)) continue;
    const v = String(value ?? '').replace(/\r/g, '').trim().slice(0, 4000);
    if (!v || v === TEXT_DEFAULTS[key]) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(storageKey(key));
    } else {
      setSetting(storageKey(key), v);
    }
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Template helpers. t(key) returns plain text (use with <%= %>, e.g. in attributes);
 * e(key) returns escaped HTML (use with <%- %>), wrapped for clicking-to-edit in edit mode.
 */
export function textHelpers(settings, editMode) {
  const saved = loadTexts();
  const t = (key) => {
    if (key in DEFAULT_SETTINGS) return settings[key] ?? DEFAULT_SETTINGS[key];
    return saved[key] ?? TEXT_DEFAULTS[key] ?? key;
  };
  const e = (key) => (editMode
    ? `<span class="editable" data-edit-key="${esc(key)}">${esc(t(key))}</span>`
    : esc(t(key)));
  return { t, e };
}
