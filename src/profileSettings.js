// Admin → Lawyer profiles: which details public profiles show, and who is emailed about new inquiries.
import { getSettings, setSetting } from './db.js';

export const PROFILE_OPTIONS = {
  show_phone: ['Phone number', true],
  show_email: ['Email address', false],
  show_website: ['Website button', true],
  show_office: ['Office address', true],
  show_social: ['Social media icons', true],
  show_experience: ['Years of experience', true],
  show_languages: ['Languages', true],
  show_bar: ['Bar admissions', true],
  show_education: ['Education', true],
  show_fees: ['Fee structure', true],
  show_hourly: ['Hourly rate', true],
  show_contact_form: ['Contact form', true],
  show_verified: ['"Verified" tick on verified lawyers', true],
  notify_lawyer: ['Email new inquiries to the lawyer', true],
  notify_admin: ['Email a copy of every inquiry to the site admins', false],
};

export function getProfileSettings() {
  const s = getSettings();
  const out = {};
  for (const [k, [, def]] of Object.entries(PROFILE_OPTIONS)) out[k] = s[`profile_${k}`] === undefined ? def : s[`profile_${k}`] === '1';
  return out;
}

// Search results: default order and whether sponsored lawyers are listed first.
export const SORT_LABELS = {
  last_name: 'Last name (A–Z)',
  name: 'First name (A–Z)',
  relevance: 'Best match (verified, then most experience)',
  experience: 'Most experience',
  newest: 'Newest listings',
};

export function getSearchSettings() {
  const s = getSettings();
  return {
    defaultSort: SORT_LABELS[s.search_default_sort] ? s.search_default_sort : 'last_name',
    sponsoredFirst: s.search_sponsored_first !== '0',
    membersOnly: s.members_only !== '0',
  };
}

export function saveSearchSettings(body) {
  if (SORT_LABELS[body.default_sort]) setSetting('search_default_sort', body.default_sort);
  setSetting('search_sponsored_first', body.sponsored_first ? '1' : '0');
  setSetting('members_only', body.members_only ? '1' : '0');
}

export function saveProfileSettings(body) {
  for (const k of Object.keys(PROFILE_OPTIONS)) setSetting(`profile_${k}`, body[k] ? '1' : '0');
}
