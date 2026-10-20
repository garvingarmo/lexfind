// Outgoing email over SMTP (invitations, password resets). Configured by SMTP_* and MAIL_FROM.
import nodemailer from 'nodemailer';

let transport = null;

/** True when SMTP settings are configured, so the site can send email. */
export function mailEnabled() {
  return Boolean(process.env.SMTP_HOST && process.env.MAIL_FROM);
}

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 465;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

export function sendMail({ to, subject, text, html }) {
  return getTransport().sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
}
