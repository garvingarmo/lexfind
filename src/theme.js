// Appearance settings (Admin → Appearance): brand colours, font pairing, logo and homepage image.
// Served as /theme.css so the page needs no inline styles (the site's CSP forbids them).
import crypto from 'node:crypto';
import { getSettings, setSetting } from './db.js';

export const FONTS = {
  classic: { label: 'Classic: serif headings, clean text', heading: 'Source Serif 4', body: 'Inter', headingFallback: 'Georgia, serif' },
  elegant: { label: 'Elegant: Playfair Display + Lato', heading: 'Playfair Display', body: 'Lato', headingFallback: 'Georgia, serif' },
  traditional: { label: 'Traditional: Merriweather + Open Sans', heading: 'Merriweather', body: 'Open Sans', headingFallback: 'Georgia, serif' },
  modern: { label: 'Modern: Poppins + Inter', heading: 'Poppins', body: 'Inter', headingFallback: 'system-ui, sans-serif' },
  clean: { label: 'Clean: Inter throughout', heading: 'Inter', body: 'Inter', headingFallback: 'system-ui, sans-serif' },
  friendly: { label: 'Friendly: Nunito throughout', heading: 'Nunito', body: 'Nunito', headingFallback: 'system-ui, sans-serif' },
};

export const THEME_DEFAULTS = {
  theme_primary: '#1f3a5f',
  theme_accent: '#b8862b',
  theme_font: 'classic',
  theme_logo: '',
  theme_hero_image: '',
  theme_logo_text: '1', // show the site name next to the logo
};

export function getTheme() {
  const s = getSettings();
  const out = {};
  for (const [k, v] of Object.entries(THEME_DEFAULTS)) out[k] = s[k] ?? v;
  if (!FONTS[out.theme_font]) out.theme_font = 'classic';
  return out;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function saveTheme(values) {
  for (const k of ['theme_primary', 'theme_accent']) if (HEX.test(values[k] || '')) setSetting(k, values[k].toLowerCase());
  if (FONTS[values.theme_font]) setSetting('theme_font', values.theme_font);
  for (const k of ['theme_logo', 'theme_hero_image', 'theme_logo_text']) if (k in values) setSetting(k, values[k] || '');
}

/** Google Fonts stylesheet URL for a font pairing. */
export function fontUrl(key) {
  const f = FONTS[key] || FONTS.classic;
  const fam = (name, w) => `family=${name.replace(/ /g, '+')}:wght@${w}`;
  const parts = f.heading === f.body ? [fam(f.body, '400;500;600;700')] : [fam(f.body, '400;500;600;700'), fam(f.heading, '600;700')];
  return `https://fonts.googleapis.com/css2?${parts.join('&')}&display=swap`;
}

/** Every font pairing, for the live preview on the Appearance page. */
export function allFontsUrl() {
  const names = [...new Set(Object.values(FONTS).flatMap((f) => [f.heading, f.body]))];
  return `https://fonts.googleapis.com/css2?${names.map((n) => `family=${n.replace(/ /g, '+')}:wght@400;600;700`).join('&')}&display=swap`;
}

// Colour helpers: mix a hex colour with white (t>0) or black (t<0).
function mix(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t)));
  return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The stylesheet that applies the current appearance on top of style.css. */
export function themeCss(theme = getTheme()) {
  const f = FONTS[theme.theme_font] || FONTS.classic;
  const p = theme.theme_primary;
  const a = theme.theme_accent;
  const hero = theme.theme_hero_image
    ? `.hero { background-image: linear-gradient(160deg, ${p}b8 0%, ${mix(p, -0.35)}d9 100%), url("${theme.theme_hero_image.replace(/["\\]/g, '')}"); background-size: cover; background-position: center; }`
    : '';
  return `:root {
  --primary: ${p};
  --primary-dark: ${mix(p, -0.3)};
  --primary-soft: ${mix(p, 0.88)};
  --accent: ${a};
  --sans: '${f.body}', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  --serif: '${f.heading}', ${f.headingFallback};
  --footer: ${mix(p, -0.62)};
}
${hero}
`;
}

export const themeVersion = (theme = getTheme()) => crypto.createHash('sha256').update(JSON.stringify(theme)).digest('hex').slice(0, 10);
