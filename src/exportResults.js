// Selected search results as a PDF download or an email (Find a lawyer → Export PDF / Email results).
// Contact details follow Admin → Lawyer profiles, so anything hidden on profiles stays out of exports.
import PDFDocument from 'pdfkit';
import { db, getSettings } from './db.js';
import { getLawyer } from './models.js';
import { getProfileSettings } from './profileSettings.js';
import { lawyerSocial } from './social.js';

export const MAX_EXPORT = 200;

/** Active lawyers for the given ids, in the order given, with only the details visitors may see. */
export function exportRows(ids, baseUrl) {
  const pf = getProfileSettings();
  const seen = new Set();
  const rows = [];
  for (const id of ids.map(Number).filter(Boolean)) {
    if (seen.has(id) || rows.length >= MAX_EXPORT) continue;
    seen.add(id);
    const l = getLawyer('id', id);
    if (!l || l.status !== 'active') continue;
    rows.push({
      name: l.name,
      firm: l.firm || '',
      address: pf.show_office ? [l.address, [l.city, [l.state, l.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ') : [l.city, l.state].filter(Boolean).join(', '),
      phone: pf.show_phone ? l.phone || '' : '',
      email: pf.show_email ? l.email || '' : '',
      website: pf.show_website ? l.website || '' : '',
      social: pf.show_social ? lawyerSocial(l).map((s) => ({ label: s.label, url: s.url })) : [],
      areas: (l.areas || []).map((a) => a.name),
      profileUrl: `${baseUrl}/lawyers/${l.slug}`,
    });
  }
  return rows;
}

/** Ids of all active lawyers matching the current search (for "Select all N results"). */
export function allMatchingIds(search, f) {
  const { rows } = search({ ...f, page: 1, perPage: 50 });
  // searchLawyers caps a page at 50, so walk the pages up to the export limit.
  const ids = rows.map((r) => r.id);
  for (let page = 2; ids.length < MAX_EXPORT; page++) {
    const more = search({ ...f, page, perPage: 50 }).rows;
    if (!more.length) break;
    ids.push(...more.map((r) => r.id));
  }
  return ids.slice(0, MAX_EXPORT);
}

const COLORS = { ink: '#1b2333', muted: '#5d6677', line: '#e3e1da' };

/** Render the lawyers as a PDF; resolves to a Buffer. */
export function buildPdf(rows, { note } = {}) {
  const s = getSettings();
  const primary = /^#[0-9a-f]{6}$/i.test(s.theme_primary || '') ? s.theme_primary : '#1f3a5f';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Lawyers from ${s.site_name}`, Author: s.site_name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(20).text(s.site_name);
    doc.moveDown(0.2).fillColor(COLORS.muted).font('Helvetica').fontSize(10)
      .text(`${rows.length} lawyer${rows.length === 1 ? '' : 's'} · ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    if (note) doc.moveDown(0.6).fillColor(COLORS.ink).fontSize(10.5).text(note, { width });
    doc.moveDown(0.8);

    const line = (label, value, link) => {
      if (!value) return;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.muted).text(`${label}  `, { continued: true });
      doc.font('Helvetica').fillColor(link ? primary : COLORS.ink).text(value, link ? { link, underline: false } : {});
    };

    rows.forEach((r, i) => {
      if (doc.y > doc.page.height - 170) doc.addPage();
      if (i > 0) {
        doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.margins.left + width, doc.y).strokeColor(COLORS.line).lineWidth(1).stroke();
        doc.moveDown(0.7);
      }
      doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.ink).text(r.name, { link: r.profileUrl });
      if (r.firm) doc.font('Helvetica').fontSize(10.5).fillColor(COLORS.muted).text(r.firm);
      if (r.areas.length) doc.fontSize(9.5).fillColor(COLORS.muted).text(r.areas.join(' · '));
      doc.moveDown(0.3);
      line('Address', r.address);
      line('Phone', r.phone, r.phone ? `tel:${r.phone.replace(/[^\d+]/g, '')}` : null);
      line('Email', r.email, r.email ? `mailto:${r.email}` : null);
      line('Website', r.website, r.website || null);
      for (const so of r.social) line(so.label, so.url, so.url);
      line('Profile', r.profileUrl, r.profileUrl);
      doc.moveDown(0.8);
    });

    doc.moveDown(0.5).font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(s.disclaimer || '', { width });
    doc.end();
  });
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Email body listing the lawyers (plain text and HTML). */
export function resultsEmail(rows, { fromName, note }) {
  const s = getSettings();
  const who = fromName ? `${fromName} shared` : 'Someone shared';
  const subject = `${who} ${rows.length} lawyer${rows.length === 1 ? '' : 's'} from ${s.site_name}`;
  const textRows = rows.map((r) => [
    r.name, r.firm, r.address, r.phone && `Phone: ${r.phone}`, r.email && `Email: ${r.email}`, r.website && `Website: ${r.website}`,
    ...r.social.map((so) => `${so.label}: ${so.url}`), `Profile: ${r.profileUrl}`,
  ].filter(Boolean).join('\n')).join('\n\n');
  const text = `${who} this list of lawyers with you from ${s.site_name}.${note ? `\n\nTheir note: ${note}` : ''}\n\n${textRows}\n\nA PDF copy is attached.\n\n${s.disclaimer || ''}`;
  const htmlRows = rows.map((r) => `<tr><td style="padding:14px 0;border-bottom:1px solid #e3e1da">
<a href="${esc(r.profileUrl)}" style="font-size:16px;font-weight:bold;color:#1b2333;text-decoration:none">${esc(r.name)}</a>
${r.firm ? `<div style="color:#5d6677">${esc(r.firm)}</div>` : ''}
${r.address ? `<div>${esc(r.address)}</div>` : ''}
${r.phone ? `<div>Phone: <a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a></div>` : ''}
${r.email ? `<div>Email: <a href="mailto:${esc(r.email)}">${esc(r.email)}</a></div>` : ''}
${r.website ? `<div>Website: <a href="${esc(r.website)}">${esc(r.website)}</a></div>` : ''}
${r.social.length ? `<div>${r.social.map((so) => `<a href="${esc(so.url)}">${esc(so.label)}</a>`).join(' · ')}</div>` : ''}
<div><a href="${esc(r.profileUrl)}">View profile</a></div></td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b2333;max-width:620px">
<p>${esc(who)} this list of lawyers with you from <strong>${esc(s.site_name)}</strong>.</p>
${note ? `<p style="background:#f7f6f2;border-left:3px solid #b8862b;padding:8px 12px">${esc(note)}</p>` : ''}
<table style="width:100%;border-collapse:collapse">${htmlRows}</table>
<p style="color:#5d6677;font-size:12px">A PDF copy is attached.<br>${esc(s.disclaimer || '')}</p></div>`;
  return { subject, text, html };
}

/** Count of results emails sent from an address in the last hour (simple abuse limit). */
export function recentShares(ip) {
  return db.prepare("SELECT COUNT(*) n FROM result_shares WHERE ip = ? AND created_at > datetime('now', '-1 hour')").get(ip).n;
}

export function logShare(ip, to, count) {
  db.prepare('INSERT INTO result_shares (ip, recipient, lawyer_count) VALUES (?, ?, ?)').run(ip, to, count);
}
