// Outgoing email (invitations, password resets, notifications), sent over SMTP (your mail server or
// Gmail) or through a sending service's web API (Resend, Brevo, SendGrid). Configured by MAIL_* / SMTP_* environment
// variables, or in Admin → Integrations.
import nodemailer from 'nodemailer';
import { getSecret } from './db.js';

// When the app runs in a container (cPanel Web Apps), the server's own public address is often
// closed to it, but the same mail server answers on the container host's internal address.
const HOST_ALIASES = ['host.containers.internal', 'host.docker.internal', '10.0.2.2', '172.17.0.1'];
const UNREACHABLE = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ESOCKET', 'ECONNECTION', 'EDNS']);

export const PROVIDERS = {
  smtp: 'Your mail server (SMTP)',
  gmail: 'Gmail / Google Workspace',
  resend: 'Resend (resend.com)',
  brevo: 'Brevo (brevo.com)',
  sendgrid: 'Twilio SendGrid (sendgrid.com)',
};

const transports = new Map();
let workingHost = null; // the address that last worked for the configured host
let workingKey = '';

/** Current SMTP settings; environment variables take precedence over the admin page. */
export function mailConfig() {
  const env = process.env;
  const pick = (envName, secret) => env[envName] || getSecret(secret);
  const provider = pick('MAIL_PROVIDER', 'mail_provider');
  if (provider === 'gmail') {
    // Google's SMTP server with an app password; the login is kept apart from the cPanel mailbox settings.
    return {
      provider, host: 'smtp.gmail.com', port: 465, secure: true,
      user: pick('GMAIL_USER', 'gmail_user'), pass: pick('GMAIL_APP_PASSWORD', 'gmail_pass'), from: pick('MAIL_FROM', 'mail_from'),
    };
  }
  return {
    provider: PROVIDERS[provider] ? provider : 'smtp',
    apiKey: pick('MAIL_API_KEY', 'mail_api_key'),
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
  if (c.provider === 'gmail') return Boolean(c.from && c.user && c.pass);
  return Boolean(c.from && (c.provider === 'smtp' ? c.host : c.apiKey));
}

/** Split "Name <email>" into its parts. */
function parseAddress(v) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v || '');
  return m ? { name: m[1].replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: String(v || '').trim() };
}

const base64 = (content) => Buffer.from(content).toString('base64');

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = data.message || data.error?.message || data.error || data.errors?.[0]?.message || data.code || res.statusText;
    const err = new Error(res.status === 401 || res.status === 403 ? `The sending service rejected the API key (${why}).` : `The sending service refused the email: ${why}`);
    err.status = res.status;
    throw err;
  }
  data.headers = res.headers;
  return data;
}

const API_SENDERS = {
  async resend(c, m) {
    const data = await postJson('https://api.resend.com/emails', { authorization: `Bearer ${c.apiKey}` }, {
      from: c.from,
      to: [m.to],
      subject: m.subject,
      text: m.text,
      html: m.html,
      reply_to: m.replyTo || undefined,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: base64(a.content) })),
    });
    return { response: `accepted by Resend, id ${data.id}`, messageId: data.id };
  },
  async brevo(c, m) {
    const from = parseAddress(c.from);
    const data = await postJson('https://api.brevo.com/v3/smtp/email', { 'api-key': c.apiKey }, {
      sender: { email: from.email, name: from.name || undefined },
      to: [{ email: m.to }],
      subject: m.subject,
      textContent: m.text,
      htmlContent: m.html || undefined,
      replyTo: m.replyTo ? { email: parseAddress(m.replyTo).email } : undefined,
      attachment: m.attachments?.map((a) => ({ name: a.filename, content: base64(a.content) })),
    });
    return { response: `accepted by Brevo, id ${data.messageId}`, messageId: data.messageId };
  },
  async sendgrid(c, m) {
    const from = parseAddress(c.from);
    const content = [{ type: 'text/plain', value: m.text || '' }];
    if (m.html) content.push({ type: 'text/html', value: m.html });
    const data = await postJson('https://api.sendgrid.com/v3/mail/send', { authorization: `Bearer ${c.apiKey}` }, {
      personalizations: [{ to: [{ email: m.to }] }],
      from: { email: from.email, name: from.name || undefined },
      reply_to: m.replyTo ? { email: parseAddress(m.replyTo).email } : undefined,
      subject: m.subject,
      content,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: base64(a.content), type: a.contentType, disposition: 'attachment' })),
    });
    const id = data.headers.get('x-message-id');
    return { response: `accepted by SendGrid${id ? `, id ${id}` : ''}`, messageId: id };
  },
};

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
  if (c.provider === 'gmail') {
    try {
      return await getTransport(c, c.host).sendMail({ from: c.from, to, subject, text, html, replyTo, attachments });
    } catch (err) {
      if (err.code === 'EAUTH' || err.responseCode === 535) {
        throw new Error('Gmail did not accept the login. Use a 16-letter app password (not your normal Gmail password), and check the Gmail address is right.');
      }
      if (UNREACHABLE.has(err.code)) {
        throw new Error(`This server could not connect to smtp.gmail.com on port 465 (${err.code}). The server's firewall or provider may be blocking outgoing mail ports.`);
      }
      throw err;
    }
  }
  if (c.provider !== 'smtp') return API_SENDERS[c.provider](c, { to, subject, text, html, replyTo, attachments });
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
