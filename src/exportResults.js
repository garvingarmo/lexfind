// Selected search results as a PDF download or an email (Find a lawyer → Export PDF / Email results).
// Contact details follow Admin → Lawyer profiles, so anything hidden on profiles stays out of exports.
import PDFDocument from 'pdfkit';
import { db, getSettings } from './db.js';
import { getLawyer } from './models.js';
import { getProfileSettings } from './profileSettings.js';
import { lawyerSocial } from './social.js';
import { renderEmail, quoteBlock, lawyerListBlock } from './emails.js';

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
      mobile: pf.show_mobile ? l.mobile || '' : '',
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

/**
 * Render the lawyers as a PDF; resolves to a Buffer. `referredBy` (name, firm, email, phone) is the
 * member who exported or emailed the list, shown in the header.
 */
export function buildPdf(rows, { note, referredBy } = {}) {
  const s = getSettings();
  const primary = /^#[0-9a-f]{6}$/i.test(s.theme_primary || '') ? s.theme_primary : '#1f3a5f';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Lawyers from ${s.site_name}`, Author: s.site_name } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const rule = (weight, color) => {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(color).lineWidth(weight).stroke();
    };

    // Header: site name, then who referred these lawyers.
    doc.fillColor(primary).font('Helvetica-Bold').fontSize(24).text(s.site_name);
    if (referredBy) {
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.muted).text('REFERRED BY', { characterSpacing: 1 });
      doc.moveDown(0.15);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(COLORS.ink).text(referredBy.name);
      if (referredBy.firm) doc.font('Helvetica').fontSize(12.5).fillColor(COLORS.ink).text(referredBy.firm);
      const contact = [referredBy.phone, referredBy.email].filter(Boolean).join('   ·   ');
      if (contact) doc.font('Helvetica').fontSize(12.5).fillColor(COLORS.muted).text(contact);
    }
    if (note) doc.moveDown(0.6).font('Helvetica-Oblique').fillColor(COLORS.ink).fontSize(12.5).text(note, { width });
    doc.moveDown(0.8);
    rule(3, primary);
    doc.moveDown(1);

    const line = (label, value, link) => {
      if (!value) return;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.muted).text(`${label}  `, { continued: true });
      doc.font('Helvetica').fillColor(link ? primary : COLORS.ink).text(value, link ? { link, underline: false } : {});
      doc.moveDown(0.15);
    };

    rows.forEach((r, i) => {
      // Keep each lawyer on one page: name, firm, areas, then one line per detail.
      const details = [r.address, r.phone, r.mobile, r.email, r.website, ...r.social, r.profileUrl].filter(Boolean).length;
      const needed = 95 + details * 17;
      if (doc.y + needed > doc.page.height - doc.page.margins.bottom) doc.addPage();
      else if (i > 0) {
        rule(2.5, COLORS.ink);
        doc.moveDown(0.9);
      }
      doc.font('Helvetica-Bold').fontSize(17).fillColor(COLORS.ink).text(r.name, { link: r.profileUrl });
      if (r.firm) doc.moveDown(0.1).font('Helvetica').fontSize(13.5).fillColor(COLORS.muted).text(r.firm);
      if (r.areas.length) doc.moveDown(0.1).fontSize(12).fillColor(COLORS.muted).text(r.areas.join(' · '));
      doc.moveDown(0.5);
      line('Address', r.address);
      line('Phone', r.phone, r.phone ? `tel:${r.phone.replace(/[^\d+]/g, '')}` : null);
      line('Mobile', r.mobile, r.mobile ? `tel:${r.mobile.replace(/[^\d+]/g, '')}` : null);
      line('Email', r.email, r.email ? `mailto:${r.email}` : null);
      line('Website', r.website, r.website || null);
      for (const so of r.social) line(so.label, so.url, so.url);
      line('Profile', r.profileUrl, r.profileUrl);
      doc.moveDown(0.9);
    });

    rule(2.5, COLORS.ink);
    doc.moveDown(0.8).font('Helvetica').fontSize(9.5).fillColor(COLORS.muted).text(s.disclaimer || '', { width });
    doc.end();
  });
}

/** Email body listing the lawyers (template "results" in Admin → Emails). */
export function resultsEmail(rows, { fromName, note, siteUrl }) {
  return renderEmail('results', {
    sender: fromName || 'Someone',
    count: `${rows.length} lawyer${rows.length === 1 ? '' : 's'}`,
    note: quoteBlock(note, 'Note'),
    lawyer_list: lawyerListBlock(rows),
  }, { siteUrl });
}

/** Count of results emails sent from an address in the last hour (simple abuse limit). */
export function recentShares(ip) {
  return db.prepare("SELECT COUNT(*) n FROM result_shares WHERE ip = ? AND created_at > datetime('now', '-1 hour')").get(ip).n;
}

export function logShare(ip, to, count) {
  db.prepare('INSERT INTO result_shares (ip, recipient, lawyer_count) VALUES (?, ?, ?)').run(ip, to, count);
}
