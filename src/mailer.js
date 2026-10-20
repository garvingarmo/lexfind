// Outgoing email over SMTP (invitations, password resets). Configured by SMTP_* / MAIL_FROM
// environment variables, or in Admin → Integrations.
import nodemailer from 'nodemailer';
import { getSecret } from './db.js';

// When the app runs in a container (cPanel Web Apps), the server's own public address is often
// closed to it, but the same mail server answers on the container host's internal address.
const HOST_ALIASES = ['host.containers.internal', 'host.docker.internal', '10.0.2.2', '172.17.0.1'];
const UNREACHABLE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ESOCKET', 'ECONNECTION', 'EDNS']);

const transports = new Map();
let workingHost = null; // the address that last worked for the configured host
let workingKey = '';

/** Current SMTP settings; environment variables take precedence over the admin page. */
export function mailConfig() {
  const env = process.env;
  const pick = (envName, secret) => env[envName] || getSecret(secret);
  return {
    host: pick('SMTP_HOST', 'smtp_host'),
    port: Number(pick('SMTP_PORT', 'smtp_port')) || 465,
    user: pick('SMTP_USER', 'smtp_user'),
    pass: pick('SMTP_PASS', 'smtp_pass'),
    from: pick('MAIL_FROM', 'mail_from'),
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : undefined,
  };
}

/** True when SMTP settings are configured, so the site can send email. */
export function mailEnabled() {
  const c = mailConfig();
  return Boolean(c.host && c.from);
}

function getTransport(c, connectHost) {
  const key = JSON.stringify([c, connectHost]);
  if (!transports.has(key)) {
    transports.clear();
    transports.set(key, nodemailer.createTransport({
      host: connectHost,
      port: c.port,
      secure: c.secure ?? c.port === 465,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      // Check the certificate against the real mail server name, whichever address we connect to.
      tls: { servername: c.host },
      connectionTimeout: 10000,
    }));
  }
  return transports.get(key);
}

const isUnreachable = (err) => UNREACHABLE.has(err?.code) && !err.responseCode && !/certificate|self.signed/i.test(err.message || '');

export async function sendMail({ to, subject, text, html, replyTo, attachments }) {
  const c = mailConfig();
  const message = { from: c.from, to, subject, text, html, replyTo, attachments };
  const key = JSON.stringify(c);
  if (workingKey !== key) { workingHost = null; workingKey = key; }
  const extra = (process.env.SMTP_FALLBACK_HOSTS || '').split(',').map((h) => h.trim());
  const candidates = [...new Set([workingHost, c.host, ...extra, ...HOST_ALIASES].filter(Boolean))];
  let firstError;
  for (const host of candidates) {
    try {
      const info = await getTransport(c, host).sendMail(message);
      if (host !== workingHost) {
        workingHost = host;
        if (host !== c.host) console.log(`[mail] ${c.host} unreachable from here; sending via ${host}:${c.port}`);
      }
      return info;
    } catch (err) {
      firstError ??= err;
      // Only try another address when this one couldn't be reached; a login or recipient error is final.
      if (!isUnreachable(err)) throw err;
    }
  }
  throw firstError;
}
