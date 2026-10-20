import Anthropic from '@anthropic-ai/sdk';
import { getSecret } from '../db.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

let client = null;
let clientKey = null;

/** The API key: ANTHROPIC_API_KEY if set, otherwise the one saved in Admin → Integrations. */
export function apiKey() {
  return process.env.ANTHROPIC_API_KEY || getSecret('anthropic_api_key');
}

/** True when an API credential is configured; otherwise the app uses its offline fallbacks. */
export function aiEnabled() {
  return Boolean(apiKey() || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getClient() {
  const key = apiKey();
  if (!client || clientKey !== key) {
    client = key ? new Anthropic({ apiKey: key }) : new Anthropic();
    clientKey = key;
  }
  return client;
}

/**
 * Messages request with server-side refusal fallbacks enabled: if the model's
 * safety classifiers decline, the API re-runs the request on a fallback model.
 */
export function createMessage(params) {
  return getClient().beta.messages.create({
    model: MODEL,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    ...params,
  });
}

export function textOf(message) {
  return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
