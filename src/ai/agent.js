// The "find me a lawyer" assistant: Claude reads the visitor's description of
// their legal matter, searches the directory through tools, and recommends
// specific listings with a reason for each.
import { aiEnabled, createMessage, textOf } from './client.js';
import { listAreas, searchLawyers, getLawyer } from '../models.js';
import { getSettings } from '../db.js';

const MAX_TURNS = 8;

const tools = [
  {
    name: 'search_lawyers',
    description: 'Search active lawyer listings in the directory. All filters are optional; combine them to narrow results. ' +
      'Use the practice_area slug from the system prompt list when you can. If a search returns nothing, broaden it (drop city, then state).',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        practice_area: { type: 'string', description: 'Practice area slug, e.g. "family-law". Empty string for any.' },
        state: { type: 'string', description: 'Two-letter US state code, e.g. "CA". Empty string for any.' },
        city: { type: 'string', description: 'City name. Empty string for any.' },
        language: { type: 'string', description: 'Language the lawyer must speak, e.g. "Spanish". Empty string for any.' },
        keywords: { type: 'string', description: 'Free-text keywords matched against name, firm and bio. Empty string for none.' },
      },
      required: ['practice_area', 'state', 'city', 'language', 'keywords'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_lawyer_profile',
    description: 'Get the full profile of one lawyer, including bio, experience and bar admissions.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { lawyer_id: { type: 'integer' } },
      required: ['lawyer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'recommend_lawyers',
    description: 'Show the visitor your recommended lawyers as cards on the page. Call this once you have picked 1-5 listings ' +
      'from search results. Only use lawyer_id values returned by search_lawyers or get_lawyer_profile.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lawyer_id: { type: 'integer' },
              reason: { type: 'string', description: 'One or two sentences on why this lawyer fits the visitor\'s matter.' },
            },
            required: ['lawyer_id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['recommendations'],
      additionalProperties: false,
    },
  },
];

function systemPrompt() {
  const s = getSettings();
  const areas = listAreas({ withLawyersOnly: true }).map((a) => `${a.depth ? '  ' : ''}- ${a.slug}: ${a.name}${a.description ? ` — ${a.description}` : ''}`).join('\n');
  return `You are the matching assistant for ${s.site_name}, an online directory of lawyers. Visitors describe their legal matter in their own words; your job is to understand it and recommend lawyers from this directory who fit.

How to work:
- Always search right away. Never ask for the visitor's location (or anything else) before searching and recommending.
- Work out which practice area(s) the matter falls under. If the visitor mentions a city or state, use it; otherwise search without a location filter, and mention where each recommended lawyer is based so the visitor can say if they need someone closer.
- If the matter is vague, still search, using the most likely practice areas or keywords from what they wrote, and recommend the best fits; you can invite them to add detail afterwards.
- Practice areas are grouped: sub-categories are indented under their main category. Searching a main category also returns lawyers in its sub-categories; search a sub-category when the matter is clearly that specific.
- Use search_lawyers to find candidates (try related practice areas if the first search is thin), get_lawyer_profile when you need detail to choose, then call recommend_lawyers with your best 1-5 matches.
- After recommending, write a brief reply: a plain-language summary of what kind of lawyer they need and why, and any useful next steps (e.g. documents to gather before a consultation). Keep it under about 150 words; the cards show the lawyer details.
- Respect stated preferences such as language and location.
- Only recommend lawyers returned by the tools. Never invent lawyers, credentials, or outcomes. If there are no suitable lawyers in the directory, say so and suggest the visitor contact their state or local bar association's lawyer referral service.

Boundaries:
- You are not a lawyer and do not give legal advice. You may explain general concepts and what type of lawyer handles a matter, but do not tell visitors what they should do legally or predict outcomes.
- If someone describes an emergency or immediate danger, tell them to contact emergency services (911 in the US) first. For deadlines such as court dates, encourage them to contact a lawyer promptly.
- Visitors may share sensitive details. Do not ask for more personal information than needed to match them.

Practice areas in the directory (slug: name — description):
${areas}`;
}

function summarize(l) {
  return {
    lawyer_id: l.id,
    name: l.name,
    firm: l.firm,
    location: [l.city, l.state].filter(Boolean).join(', '),
    practice_areas: (l.areas || []).map((a) => a.name),
    years_experience: l.years_experience,
    languages: l.languages,
    verified: Boolean(l.verified),
  };
}

function runTool(name, input, state) {
  if (name === 'search_lawyers') {
    const { rows, total } = searchLawyers({
      area: input.practice_area || undefined,
      state: input.state || undefined,
      city: input.city || undefined,
      language: input.language || undefined,
      q: input.keywords || undefined,
      perPage: 15,
    });
    return JSON.stringify({ total_matches: total, results: rows.map(summarize) });
  }
  if (name === 'get_lawyer_profile') {
    const l = getLawyer('id', input.lawyer_id);
    if (!l || l.status !== 'active') return JSON.stringify({ error: 'No active lawyer with that id.' });
    return JSON.stringify({
      ...summarize(l), title: l.title, bio: l.bio, education: l.education, bar_admissions: l.bar_admissions,
    });
  }
  if (name === 'recommend_lawyers') {
    const accepted = [];
    for (const r of input.recommendations || []) {
      const l = getLawyer('id', r.lawyer_id);
      if (l && l.status === 'active' && !state.recommendations.some((x) => x.lawyer.id === l.id)) {
        state.recommendations.push({ lawyer: l, reason: String(r.reason || '').slice(0, 600) });
        accepted.push(l.id);
      }
    }
    return JSON.stringify({ shown_to_visitor: accepted });
  }
  return JSON.stringify({ error: `Unknown tool ${name}` });
}

/**
 * Continue a conversation. `history` is the stored list of API messages
 * (append-only, so assistant turns are passed back exactly as returned).
 * Returns { reply, recommendations, history }.
 */
export async function chat(history, userText) {
  if (!aiEnabled()) return offlineChat(history, userText);

  const messages = [...history, { role: 'user', content: userText }];
  const state = { recommendations: [] };
  let reply = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await createMessage({
      max_tokens: 16000,
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: systemPrompt(),
      tools,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      reply = "Sorry, I can't help with that request. If you have a legal matter you'd like help finding a lawyer for, please describe it.";
      messages.pop(); // drop the declined user turn so the conversation can continue cleanly
      return { reply, recommendations: [], history: messages };
    }

    messages.push({ role: 'assistant', content: response.content });
    const text = textOf(response);
    if (text) reply = text;

    if (response.stop_reason === 'pause_turn') continue;
    if (response.stop_reason !== 'tool_use') break;

    const results = response.content
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        let content;
        try { content = runTool(b.name, b.input, state); } catch (e) { return { type: 'tool_result', tool_use_id: b.id, content: String(e.message), is_error: true }; }
        return { type: 'tool_result', tool_use_id: b.id, content };
      });
    messages.push({ role: 'user', content: results });
  }

  // If the loop ended on tool results, the conversation must still end on an
  // assistant turn so the next user message is valid.
  if (messages.at(-1).role === 'user') messages.push({ role: 'assistant', content: [{ type: 'text', text: reply || 'Here are some lawyers who may fit.' }] });

  return { reply: reply || 'Here are some lawyers who may be a good fit.', recommendations: state.recommendations, history: messages };
}

// ---------------------------------------------------------------------------
// Offline fallback: keyword matching so the assistant still works without an API key.

const KEYWORDS = {
  'family-law': ['divorce', 'custody', 'child support', 'alimony', 'separation', 'adoption', 'spouse', 'husband', 'wife', 'visitation', 'prenup'],
  'criminal-defense': ['arrest', 'arrested', 'charged', 'criminal', 'police', 'dui', 'dwi', 'assault', 'theft', 'drug', 'jail', 'felony', 'misdemeanor', 'probation'],
  'personal-injury': ['injury', 'injured', 'accident', 'crash', 'slip', 'fall', 'hurt', 'malpractice', 'dog bite', 'wrongful death'],
  'immigration': ['visa', 'green card', 'immigration', 'deport', 'citizenship', 'asylum', 'work permit', 'h-1b', 'uscis'],
  'employment-law': ['fired', 'terminated', 'employer', 'workplace', 'harassment', 'discrimination', 'wages', 'overtime', 'wrongful termination', 'boss'],
  'estate-planning': ['will', 'trust', 'estate', 'probate', 'inheritance', 'power of attorney', 'died', 'passed away', 'executor'],
  'real-estate': ['house', 'property', 'landlord', 'tenant', 'lease', 'eviction', 'closing', 'mortgage', 'deed', 'hoa', 'rent'],
  'business-law': ['business', 'company', 'llc', 'contract', 'partner', 'startup', 'corporation', 'shareholder', 'incorporate'],
  'bankruptcy': ['bankruptcy', 'debt', 'creditors', 'foreclosure', 'chapter 7', 'chapter 13', 'collections', 'garnish'],
  'intellectual-property': ['patent', 'trademark', 'copyright', 'infringement', 'brand', 'invention', 'ip '],
  'tax-law': ['tax', 'irs', 'audit', 'back taxes', 'lien'],
};

const STOP = new Set(['about', 'after', 'again', 'because', 'before', 'being', 'could', 'doesn', 'their', 'there', 'these', 'thing', 'think', 'which', 'while', 'would', 'should', 'lawyer', 'attorney', 'legal', 'help', 'please', 'need', 'someone', 'where', 'what', 'years', 'since', 'still', 'other', 'really', 'going', 'getting']);

export const STATES = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };

function offlineChat(history, userText) {
  const all = [...history.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content), userText].join(' ').toLowerCase();
  const areaScores = Object.entries(KEYWORDS)
    .map(([slug, words]) => [slug, words.filter((w) => all.includes(w)).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const area = areaScores[0]?.[0];
  const original = [...history.filter((m) => m.role === 'user' && typeof m.content === 'string').map((m) => m.content), userText].join(' ');
  let state = Object.entries(STATES).find(([n]) => new RegExp(`\\b${n}\\b`).test(all))?.[1];
  // Only accept upper-case codes ("TX"), so ordinary words like "in" or "or" aren't read as states.
  if (!state) state = original.match(/\b(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/)?.[1];
  const cityRow = searchLawyers({ perPage: 50 }).rows.map((l) => l.city).filter(Boolean)
    .find((c) => all.includes(c.toLowerCase()));

  const language = ['spanish', 'mandarin', 'korean', 'hindi', 'tamil', 'french', 'portuguese', 'italian', 'hebrew', 'vietnamese', 'arabic', 'russian']
    .find((w) => all.includes(w));

  // Directory practice areas may be named differently from the keyword list (e.g. "Real Estate Law"),
  // so search on the area's words, then relax location and language until something matches.
  const term = area ? area.replace(/-law$/, '').replace(/-/g, ' ') : null;
  const words = all.split(/[^a-z]+/).filter((w) => w.length > 4 && !STOP.has(w));
  const attempts = term
    ? [{ q: term, state, city: cityRow, language }, { q: term, state, city: cityRow }, { q: term, state }, { q: term }]
    : [...words.slice(0, 6).map((w) => ({ q: w, state })), ...words.slice(0, 6).map((w) => ({ q: w })), {}];
  let rows = [];
  for (const a of attempts) {
    for (const l of searchLawyers({ ...a, perPage: 3 }).rows) if (rows.length < 3 && !rows.some((r) => r.id === l.id)) rows.push(l);
    if (rows.length >= 3) break;
  }

  const areaName = area ? area.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
  let reply;
  if (!rows.length) {
    reply = "We don't have a matching lawyer listed yet. Your state or local bar association's lawyer referral service can also help.";
  } else if (areaName) {
    reply = `It sounds like your matter involves ${areaName}. Here are lawyers in our directory who may fit${state ? ` (in or near ${state} where possible)` : ''}. ` +
      'Before a consultation, gather any documents, dates and correspondence related to your matter. If you need someone in a particular city, just say so.';
  } else {
    reply = 'Here are some lawyers in our directory who may be able to help. Tell me a little more about your situation, or where you are, and I can narrow it down.';
  }
  const recommendations = rows.map((l) => ({
    lawyer: l,
    reason: `${l.areas.slice(0, 3).map((a) => a.name).join(', ') || 'Attorney'}${l.city ? ` in ${l.city}, ${l.state}` : ''}${l.years_experience ? `, ${l.years_experience} years of experience` : ''}.`,
  }));
  const newHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, recommendations, history: newHistory, offline: true };
}
