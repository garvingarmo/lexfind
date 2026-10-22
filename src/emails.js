// Branded email templates (Admin → Emails). Each email the site sends has a subject and a body written in
// simple formatting with {{placeholders}}; admins can edit them, and every email is wrapped in the same
// layout using the site's colours and logo. Bodies use Markdown plus one extra: a line like
// [[Button text|{{link}}]] becomes a button.
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { getSettings, setSetting, db } from './db.js';
import { getTheme } from './theme.js';

const INK = '#1b2333';
const MUTED = '#5d6677';
const PAPER = '#f4f2ec';
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const SANS = "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Every email the site sends. `vars` lists the placeholders an admin can use (with sample values for the
 * preview); `blocks` are placeholders that expand to a formatted panel and belong on a line of their own.
 */
export const EMAILS = {
  invite: {
    label: 'Invitation to claim a listing',
    when: 'Sent from Admin → Invitations or a lawyer\'s page, so a lawyer can set up their login.',
    subject: 'Claim your listing on {{site_name}}',
    body: `# Your listing is ready to claim

Hello {{lawyer_name}},

Your profile is listed in the **{{site_name}}** attorney directory. Claim it to keep your details up to date, add your photo and bio, and connect with other members.

[[Claim my listing|{{claim_link}}]]

This personal link works once and expires on **{{expires}}**. If you weren't expecting this email, you can ignore it.`,
    vars: { lawyer_name: ['Lawyer\'s name', 'Maria Delgado'], claim_link: ['Personal claim link', 'https://chaldeanlaw.com/invite/sample'], expires: ['Link expiry date', 'November 5, 2026'] },
  },
  registration_admin: {
    label: 'New registration (to admins)',
    when: 'Sent to every admin when a lawyer registers through "List your practice", so they can review and approve them.',
    subject: 'New lawyer awaiting approval: {{lawyer_name}}',
    body: `# New membership application

**{{lawyer_name}}** has registered on {{site_name}} and is waiting for approval.

{{applicant_details}}

Check their bar number, then set their listing to **Active** to approve them. They'll be emailed when you do.

[[Review and approve|{{review_link}}]]`,
    vars: { lawyer_name: ['Applicant\'s name', 'Nadia Yousif'], review_link: ['Link to their listing in the admin', 'https://chaldeanlaw.com/admin/lawyers/42'] },
    blocks: { applicant_details: 'Name, firm, email, phones, location, bar number and practice areas' },
  },
  registration_received: {
    label: 'Registration received (to the lawyer)',
    when: 'Sent to a lawyer right after they register, confirming their application is being reviewed.',
    subject: 'We received your {{site_name}} application',
    body: `# Thanks for registering, {{lawyer_name}}

We've received your application to join **{{site_name}}**. Our team checks every lawyer's details before approving them, which usually takes a day or two.

You'll get an email as soon as you're approved. In the meantime, you can sign in and complete your profile — a full profile helps us approve it quickly.

[[Complete my profile|{{profile_link}}]]`,
    vars: { lawyer_name: ['Lawyer\'s name', 'Nadia Yousif'], profile_link: ['Link to edit their profile', 'https://chaldeanlaw.com/dashboard/profile'] },
  },
  password_reset: {
    label: 'Password reset',
    when: 'Sent when someone uses "Forgot password".',
    subject: 'Reset your {{site_name}} password',
    body: `# Reset your password

Someone asked to reset the password for your **{{site_name}}** account.

[[Choose a new password|{{reset_link}}]]

This link works once and expires in 1 hour. If you didn't ask for this, you can ignore this email — your password stays the same.`,
    vars: { reset_link: ['Reset link', 'https://chaldeanlaw.com/reset-password/sample'] },
  },
  inquiry: {
    label: 'New inquiry (to the lawyer)',
    when: 'Sent when someone uses the contact form on a lawyer\'s profile.',
    subject: 'New inquiry from {{sender_name}} via {{site_name}}',
    body: `# New inquiry

Hello {{lawyer_name}}, you have a new message through your {{site_name}} listing{{via}}.

{{sender_details}}

{{message}}

Reply to this email to answer {{sender_name}} directly.`,
    vars: {
      lawyer_name: ['Lawyer\'s name', 'Maria Delgado'], sender_name: ['Sender\'s name', 'John Smith'],
      via: ['" (from the AI lawyer match)" when it came from the AI match', ''],
    },
    blocks: { sender_details: 'Sender\'s name, email and phone', message: 'The message' },
  },
  referral_lawyer: {
    label: 'Client referral (to the lawyer)',
    when: 'Sent to a lawyer when a member refers a client to them.',
    subject: 'Client referral from {{member_name}} via {{site_name}}',
    body: `# You have a new client referral

Hello {{lawyer_name}},

**{{member}}** has referred a client to you through {{site_name}}.

{{client_details}}

{{matter}}

{{member_details}}

Please contact the client directly. Reply to this email to reach {{member_name}}.

[[View your referrals|{{referrals_link}}]]`,
    vars: {
      lawyer_name: ['Lawyer\'s name', 'Maria Delgado'], member_name: ['Referring member\'s name', 'James Whitaker'],
      member: ['Referring member\'s name and firm', 'James Whitaker, Whitaker Defense Group'], client_name: ['Client\'s name', 'Sarah Johnson'],
      referrals_link: ['Link to the lawyer\'s referrals page', 'https://chaldeanlaw.com/dashboard/referrals'],
    },
    blocks: { client_details: 'Client\'s name, email and phone', matter: 'The note about the matter (if any)', member_details: 'Referring member\'s contact details' },
  },
  referral_copy: {
    label: 'Client referral (copy to the referring member)',
    when: 'Sent to the member who made the referral, as their record.',
    subject: 'Your referral of {{client_name}} to {{lawyer_name}}',
    body: `# Referral sent

You referred a client to **{{lawyer}}** through {{site_name}}.

{{client_details}}

{{matter}}

{{delivery_note}}

[[View {{lawyer_name}}'s profile|{{lawyer_link}}]]`,
    vars: {
      lawyer_name: ['Lawyer\'s name', 'Maria Delgado'], lawyer: ['Lawyer\'s name and firm', 'Maria Delgado, Delgado Family Law'],
      client_name: ['Client\'s name', 'Sarah Johnson'], lawyer_link: ['Link to the lawyer\'s profile', 'https://chaldeanlaw.com/lawyers/maria-delgado'],
      delivery_note: ['Whether the lawyer was emailed', 'Maria Delgado has been emailed these details.'],
    },
    blocks: { client_details: 'Client\'s name, email and phone', matter: 'The note about the matter (if any)' },
  },
  referral_admin: {
    label: 'Client referral (copy to admins)',
    when: 'Sent to admins for every referral when "Email a copy of every inquiry to the site admins" is on, and always when the lawyer has no email.',
    subject: 'Referral: {{member_name}} → {{lawyer_name}}',
    body: `# New referral

**{{member}}** referred a client to **{{lawyer_name}}**.

{{delivery_note}}

{{client_details}}

{{matter}}

{{member_details}}

[[Open the lawyer's profile|{{lawyer_link}}]]`,
    vars: {
      lawyer_name: ['Lawyer\'s name', 'Maria Delgado'], member_name: ['Referring member\'s name', 'James Whitaker'],
      member: ['Referring member\'s name and firm', 'James Whitaker, Whitaker Defense Group'],
      lawyer_link: ['Link to the lawyer\'s profile', 'https://chaldeanlaw.com/lawyers/maria-delgado'],
      delivery_note: ['Asks admins to forward it when the lawyer has no email', ''],
    },
    blocks: { client_details: 'Client\'s name, email and phone', matter: 'The note about the matter (if any)', member_details: 'Referring member\'s contact details' },
  },
  results: {
    label: 'Shared search results',
    when: 'Sent when a member uses "Email results" on the search page (a PDF is attached).',
    subject: '{{sender}} shared {{count}} from {{site_name}}',
    body: `# Lawyers shared with you

{{sender}} shared this list of lawyers with you from **{{site_name}}**.

{{note}}

{{lawyer_list}}

A PDF copy is attached.`,
    vars: { sender: ['Name the sender gave (or "Someone")', 'James Whitaker'], count: ['Number of lawyers, e.g. "3 lawyers"', '2 lawyers'] },
    blocks: { note: 'The sender\'s note (if any)', lawyer_list: 'The lawyers, with their contact details' },
  },
  approved: {
    label: 'Membership approved',
    when: 'Sent to a lawyer when their listing is set to Active and they have a login.',
    subject: 'Your {{site_name}} membership is approved',
    body: `# Welcome to {{site_name}}

Hello {{name}},

Your membership has been approved. You can now search the directory, view lawyer profiles, refer clients and use the AI lawyer match.

[[Sign in|{{login_link}}]]

Your listing is also now live in the directory.`,
    vars: { name: ['Lawyer\'s name', 'Maria Delgado'], login_link: ['Sign-in link', 'https://chaldeanlaw.com/login'] },
  },
  test: {
    label: 'Test email',
    when: 'Sent from Admin → Integrations → "Send test email".',
    subject: '{{site_name}}: test email',
    body: `# Email is working

This test email confirms **{{site_name}}** can send email: invitations, password resets, referrals and notifications.`,
    vars: {},
  },
};

export const COMMON_VARS = { site_name: 'Site name', site_link: 'Link to the website' };
export const DEFAULT_FOOTER = 'You received this email from {{site_name}} · {{site_link}}';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const telHref = (n) => `tel:${String(n).replace(/[^\d+]/g, '')}`;

// --- Blocks: formatted panels for details that come from the site (always escaped) ---------------------

/** A label/value panel. rows: [[label, value, href?]]; empty values are skipped. */
export function detailsBlock(rows, accent = getTheme().theme_accent) {
  const list = rows.filter(([, v]) => v);
  if (!list.length) return { html: '', text: '' };
  const tr = list.map(([label, value, href]) => `<tr>
<td style="padding:7px 14px 7px 0;font:600 13px ${SANS};color:${MUTED};white-space:nowrap;vertical-align:top">${esc(label)}</td>
<td style="padding:7px 0;font:15px ${SANS};color:${INK}">${href ? `<a href="${esc(href)}" style="color:${INK};text-decoration:underline">${esc(value)}</a>` : esc(value)}</td></tr>`).join('');
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px;background:#f8f7f3;border-left:4px solid ${accent};border-radius:8px"><tr><td style="padding:12px 18px"><table role="presentation" cellpadding="0" cellspacing="0">${tr}</table></td></tr></table>`,
    text: list.map(([l, v]) => `${l}: ${v}`).join('\n'),
  };
}

/** A quoted message (keeps the writer's line breaks). */
export function quoteBlock(text, title) {
  const t = String(text || '').trim();
  if (!t) return { html: '', text: '' };
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px"><tr><td style="padding:14px 18px;background:#ffffff;border:1px solid #e3e1da;border-radius:8px;font:15px/1.6 ${SANS};color:${INK}">${title ? `<div style="font:600 12px ${SANS};letter-spacing:.06em;text-transform:uppercase;color:${MUTED};margin-bottom:6px">${esc(title)}</div>` : ''}${esc(t).replace(/\n/g, '<br>')}</td></tr></table>`,
    text: `${title ? `${title}:\n` : ''}${t}`,
  };
}

/** Lawyer cards for shared search results. rows come from exportRows(). */
export function lawyerListBlock(rows) {
  const { theme_primary: primary, theme_accent: accent } = getTheme();
  const html = rows.map((r) => {
    const lines = [
      r.address && esc(r.address),
      r.phone && `Phone: <a href="${esc(telHref(r.phone))}" style="color:${INK}">${esc(r.phone)}</a>`,
      r.mobile && `Mobile: <a href="${esc(telHref(r.mobile))}" style="color:${INK}">${esc(r.mobile)}</a>`,
      r.email && `<a href="mailto:${esc(r.email)}" style="color:${primary}">${esc(r.email)}</a>`,
      r.website && `<a href="${esc(r.website)}" style="color:${primary}">${esc(r.website.replace(/^https?:\/\//, ''))}</a>`,
      r.social.length && r.social.map((s) => `<a href="${esc(s.url)}" style="color:${primary}">${esc(s.label)}</a>`).join(' · '),
    ].filter(Boolean);
    return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 14px;border:1px solid #e3e1da;border-top:3px solid ${accent};border-radius:8px"><tr><td style="padding:14px 18px;font:14px/1.6 ${SANS};color:${INK}">
<div style="font:700 18px ${SERIF};color:${INK}"><a href="${esc(r.profileUrl)}" style="color:${INK};text-decoration:none">${esc(r.name)}</a></div>
${r.firm ? `<div style="color:${MUTED}">${esc(r.firm)}</div>` : ''}
${r.areas.length ? `<div style="font-size:12px;color:${MUTED};margin:2px 0 6px">${esc(r.areas.join(' · '))}</div>` : ''}
${lines.map((l) => `<div>${l}</div>`).join('')}
<div style="margin-top:8px"><a href="${esc(r.profileUrl)}" style="color:${primary};font-weight:600;text-decoration:none">View profile →</a></div>
</td></tr></table>`;
  }).join('');
  const text = rows.map((r) => [r.name, r.firm, r.address, r.phone && `Phone: ${r.phone}`, r.mobile && `Mobile: ${r.mobile}`,
    r.email && `Email: ${r.email}`, r.website && `Website: ${r.website}`, ...r.social.map((s) => `${s.label}: ${s.url}`), `Profile: ${r.profileUrl}`].filter(Boolean).join('\n')).join('\n\n');
  return { html, text };
}

// --- Saved templates -------------------------------------------------------------------------------------

/** The template in use: the admin's saved version, or the default. */
export function getTemplate(key) {
  const def = EMAILS[key];
  let saved = {};
  try { saved = JSON.parse(getSettings()[`email_tpl.${key}`] || '{}'); } catch { saved = {}; }
  return { subject: saved.subject || def.subject, body: saved.body || def.body, customized: Boolean(saved.subject || saved.body) };
}

export function saveTemplate(key, subject, body) {
  const def = EMAILS[key];
  const s = String(subject || '').trim().slice(0, 300);
  const b = String(body || '').replace(/\r\n/g, '\n').trim().slice(0, 20000);
  setSetting(`email_tpl.${key}`, JSON.stringify({ subject: s && s !== def.subject ? s : '', body: b && b !== def.body ? b : '' }));
}

export function resetTemplate(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`email_tpl.${key}`);
}

export const getFooter = () => getSettings().email_footer || DEFAULT_FOOTER;

// --- Rendering ---------------------------------------------------------------------------------------------

const SANITIZE = {
  allowedTags: ['h1', 'h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'a', 'ul', 'ol', 'li', 'blockquote', 'hr'],
  allowedAttributes: { a: ['href'] },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
};

const fill = (str, values, mapper) => str.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (k in values ? mapper(values[k]) : m));

/**
 * Render an email. `values` are the placeholders' values: plain strings (escaped for HTML), or
 * { html, text } blocks. Returns { subject, html, text }.
 */
export function renderEmail(key, values = {}, { siteUrl, template } = {}) {
  const s = getSettings();
  const theme = getTheme();
  const base = String(siteUrl || process.env.PUBLIC_URL || s.site_url || '').replace(/\/+$/, '');
  const all = { site_name: s.site_name, site_link: base, ...values };
  const tpl = template || getTemplate(key);
  const textOf = (v) => (v && typeof v === 'object' ? v.text : String(v ?? ''));
  const htmlOf = (v) => (v && typeof v === 'object' ? v.html : esc(v));

  const subject = fill(tpl.subject, all, textOf).replace(/\s+/g, ' ').trim();

  // Buttons: [[Label|link]] on a line of its own.
  const buttons = [];
  let md = tpl.body.replace(/^[ \t]*\[\[([^|\]]+)\|([^\]]+)\]\][ \t]*$/gm, (m, label, href) => {
    buttons.push({ label: label.trim(), href: href.trim() });
    return `\n\nBUTTON${buttons.length - 1}TOKEN\n\n`;
  });
  // Shield placeholders from Markdown (underscores in names would otherwise turn into italics).
  const names = [];
  md = md.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => `PH${names.push(k) - 1}VAR`);
  let html = sanitizeHtml(marked.parse(md), SANITIZE).replace(/PH(\d+)VAR/g, (m, i) => `{{${names[Number(i)]}}}`);
  // Inline styles for the editable text (email clients ignore stylesheets). Done before panels and
  // buttons go in, so those keep their own styling.
  html = html
    .replace(/<h1>/g, `<h1 style="margin:0 0 18px;font:700 26px/1.25 ${SERIF};color:${INK}">`)
    .replace(/<h2>/g, `<h2 style="margin:8px 0 12px;font:700 20px/1.3 ${SERIF};color:${INK}">`)
    .replace(/<h3>/g, `<h3 style="margin:8px 0 10px;font:700 17px/1.3 ${SERIF};color:${INK}">`)
    .replace(/<p>/g, `<p style="margin:0 0 16px;font:16px/1.65 ${SANS};color:${INK}">`)
    .replace(/<a href=/g, `<a style="color:${theme.theme_primary};text-decoration:underline" href=`)
    .replace(/<(ul|ol)>/g, `<$1 style="margin:0 0 16px;padding-left:22px;font:16px/1.65 ${SANS};color:${INK}">`)
    .replace(/<blockquote>/g, `<blockquote style="margin:0 0 16px;padding:10px 16px;border-left:4px solid ${theme.theme_accent};background:#f8f7f3;border-radius:6px">`)
    .replace(/<hr \/>|<hr>/g, '<hr style="border:0;border-top:1px solid #e3e1da;margin:24px 0">');

  // Blocks sit on their own line: swap the whole paragraph for the panel (or drop it when empty).
  html = html.replace(/<p[^>]*>\s*\{\{\s*([a-z_]+)\s*\}\}\s*<\/p>/g, (m, k) => (all[k] && typeof all[k] === 'object' ? all[k].html : m));
  html = html.replace(/<p[^>]*>BUTTON(\d+)TOKEN<\/p>/g, (m, i) => {
    const b = buttons[Number(i)];
    const href = fill(b.href, all, textOf);
    return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:${theme.theme_accent}">
<a href="${esc(href)}" style="display:inline-block;padding:13px 26px;font:700 15px ${SANS};color:#ffffff;text-decoration:none;border-radius:8px">${fill(esc(b.label), all, htmlOf)}</a></td></tr></table>`;
  });
  html = fill(html, all, htmlOf);
  const footer = fill(esc(getFooter()), all, htmlOf).replace(esc(base), `<a href="${esc(base)}" style="color:${MUTED}">${esc(base.replace(/^https?:\/\//, ''))}</a>`);
  const logo = theme.theme_logo
    ? `<img src="${esc(/^https?:/.test(theme.theme_logo) ? theme.theme_logo : base + theme.theme_logo)}" alt="${esc(s.site_name)}" height="40" style="display:block;height:40px;max-width:240px;border:0;background:#fff;border-radius:6px;padding:4px 8px">`
    // The Chaldean Law logo (PNG: many email apps, Gmail included, don't show SVG).
    : `<img src="${esc(base)}/brand/email-logo.png?v=2" alt="${esc(s.site_name)}" width="213" height="48" style="display:block;width:213px;height:48px;border:0">`;

  // Plain-text version for clients that don't show HTML.
  let text = tpl.body.replace(/^[ \t]*\[\[([^|\]]+)\|([^\]]+)\]\][ \t]*$/gm, (m, label, href) => `${label.trim()}: ${href.trim()}`);
  text = fill(text, all, textOf)
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text += `\n\n—\n${fill(getFooter(), all, textOf)}`;

  const preheader = esc(text.split('\n').find((l) => l.trim() && !l.startsWith(s.site_name))?.slice(0, 120) || '');
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><title>${esc(subject)}</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Source+Serif+4:wght@600;700&display=swap" rel="stylesheet"></head>
<body style="margin:0;padding:0;background:${PAPER}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="background:${theme.theme_primary};border-radius:14px 14px 0 0;padding:22px 32px"><a href="${esc(base)}" style="text-decoration:none">${logo}</a></td></tr>
<tr><td style="height:4px;line-height:4px;font-size:0;background:${theme.theme_accent}">&nbsp;</td></tr>
<tr><td style="background:#ffffff;padding:34px 32px 18px">${html}</td></tr>
<tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:0 32px 26px"><div style="border-top:1px solid #e3e1da;padding-top:16px;font:13px/1.6 ${SANS};color:${MUTED}">${footer}</div></td></tr>
</table>
<p style="max-width:560px;margin:16px auto 0;font:11px/1.5 ${SANS};color:#8a8f99">${esc(s.disclaimer || '')}</p>
</td></tr></table></body></html>`;
  return { subject, html: page, text };
}

/** The sample values used for previews and test sends. */
export function sampleValues(key) {
  const def = EMAILS[key];
  const vals = Object.fromEntries(Object.entries(def.vars || {}).map(([k, [, sample]]) => [k, sample]));
  const blocks = {
    sender_details: detailsBlock([['Name', 'John Smith'], ['Email', 'john.smith@example.com', 'mailto:john.smith@example.com'], ['Phone', '(313) 555-0142', 'tel:3135550142']]),
    message: quoteBlock('Hello, I was referred to you about a custody matter. Could we set up a consultation this week?', 'Message'),
    applicant_details: detailsBlock([['Name', 'Nadia Yousif'], ['Firm', 'Yousif Law PLLC'], ['Email', 'nadia@example.com', 'mailto:nadia@example.com'], ['Phone', '(248) 555-0123'], ['Location', 'Troy, MI'], ['Bar number', 'P81234'], ['Practice areas', 'Immigration, Family Law']]),
    client_details: detailsBlock([['Client', 'Sarah Johnson'], ['Email', 'sarah.j@example.com', 'mailto:sarah.j@example.com'], ['Phone', '(248) 555-0187', 'tel:2485550187']]),
    matter: quoteBlock('Needs help with a contested divorce in Oakland County.', 'About the matter'),
    member_details: detailsBlock([['Referred by', 'James Whitaker, Whitaker Defense Group'], ['Email', 'james@example.com', 'mailto:james@example.com'], ['Phone', '(555) 010-6962']]),
    note: quoteBlock('Here are the two lawyers I mentioned.', 'Note'),
    lawyer_list: lawyerListBlock([
      { name: 'Maria Delgado', firm: 'Delgado Family Law', areas: ['Family Law'], address: 'Los Angeles, CA', phone: '(555) 010-5762', mobile: '', email: 'maria@example.com', website: 'https://example.com', social: [], profileUrl: 'https://chaldeanlaw.com/lawyers/maria-delgado' },
      { name: 'Priya Raman', firm: 'Raman Immigration Law', areas: ['Immigration'], address: 'San Francisco, CA', phone: '(555) 010-5253', mobile: '(415) 555-0110', email: '', website: '', social: [], profileUrl: 'https://chaldeanlaw.com/lawyers/priya-raman' },
    ]),
  };
  for (const k of Object.keys(def.blocks || {})) vals[k] = blocks[k];
  return vals;
}
