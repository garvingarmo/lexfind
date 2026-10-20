// Outgoing email over SMTP (invitations, password resets). Configured by SMTP_* / MAIL_FROM
// environment variables, or in Admin → Integrations.
import nodemailer from 'nodemailer';
import { getSecret } from './db.js';

let transport = null;
let transportKey = '';

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

function getTransport() {
  const c = mailConfig();
  const key = JSON.stringify(c);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure ?? c.port === 465,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    });
    transportKey = key;
  }
  return transport;
}

/**
 * Log which SMTP host/port combinations this process can open a connection to. Helps when the app
 * runs in a container that can't reach the mail server the way the outside world does.
 */
export async function diagnoseSmtp() {
  const net = await import('node:net');
  const c = mailConfig();
  const hosts = [...new Set([c.host, 'host.containers.internal', 'host.docker.internal', '10.0.2.2', '10.88.0.1', '172.17.0.1'].filter(Boolean))];
  const ports = [465, 587, 25, 2525];
  const probe = (host, port) => new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 3000 });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.once('connect', () => done('open'));
    sock.once('timeout', () => done('timeout'));
    sock.once('error', (e) => done(e.code || 'error'));
  });
  const results = await Promise.all(hosts.flatMap((h) => ports.map(async (p) => `${h}:${p}=${await probe(h, p)}`)));
  console.log(`[smtp-diagnose] ${results.join(' ')}`);
}

export function sendMail({ to, subject, text, html, replyTo, attachments }) {
  return getTransport().sendMail({ from: mailConfig().from, to, subject, text, html, replyTo, attachments });
}
