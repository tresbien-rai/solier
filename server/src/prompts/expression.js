/**
 * Aux-model expression picking (Option B).
 *
 * Pure prompt builder and reply parser — mirrors prompts/title.js. The
 * conversations route handles loading settings/messages and dispatching to the
 * configured aux model; this owns what we ask for and how we parse the answer.
 */

const { sanitizeExpressionNames } = require('./tessera');

const MAX_PERSONA_CHARS = 1800;
const MAX_CONTEXT_MESSAGES = 4;
const MAX_PRIOR_MSG_CHARS = 350;
const MAX_LAST_USER_CHARS = 700;
const MAX_LAST_REPLY_CHARS = 1200;

const EXPRESSION_SYSTEM_PROMPT = [
  "You choose the avatar expression for a persona's latest chat reply.",
  '',
  'Rules:',
  '- Reply with ONE expression name from the provided list and nothing else. No brackets, quotes, punctuation, or explanation.',
  "- Base your choice on the persona's character and the tone and emotion of their latest reply in context.",
  '- If nothing fits exactly, pick the closest match from the list.',
].join('\n');

/** Clip text cleanly at `max` characters without splitting mid-word when spaces exist. */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastBreak = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
  const cut = lastBreak > max / 2 ? slice.slice(0, lastBreak) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Build the system + user prompt for an aux-model expression selection call.
 * @param {Object} opts
 * @param {string} [opts.personaName]
 * @param {string} [opts.personaPrompt]
 * @param {string[]} [opts.expressionNames]
 * @param {Array<{role: string, content: string}>} [opts.recentMessages]
 * @returns {{ system: string, messages: Array<{role: string, content: string}> }}
 */
function buildExpressionRequest({
  personaName = '',
  personaPrompt = '',
  expressionNames = [],
  recentMessages = [],
} = {}) {
  const names = sanitizeExpressionNames(expressionNames);
  const assistantLabel = (personaName || '').trim() || 'Assistant';
  const trimmedPersona = clip(personaPrompt, MAX_PERSONA_CHARS);

  const window = (Array.isArray(recentMessages) ? recentMessages : [])
    .filter((m) => m && typeof m.content === 'string' && m.content.trim() !== '')
    .slice(-MAX_CONTEXT_MESSAGES);

  let lastAssistantIdx = -1;
  let lastUserIdx = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (lastAssistantIdx === -1 && window[i].role === 'assistant') lastAssistantIdx = i;
    if (lastUserIdx === -1 && window[i].role === 'user') lastUserIdx = i;
  }

  const turns = window.map((m, i) => {
    const limit = i === lastAssistantIdx
      ? MAX_LAST_REPLY_CHARS
      : (i === lastUserIdx ? MAX_LAST_USER_CHARS : MAX_PRIOR_MSG_CHARS);
    const speaker = m.role === 'user' ? 'User' : assistantLabel;
    return `${speaker}: ${clip(m.content, limit)}`;
  });

  const parts = [];
  if (personaName && personaName.trim()) {
    parts.push(`Persona: ${personaName.trim()}`);
  }
  if (trimmedPersona) {
    parts.push(`<persona>\n${trimmedPersona}\n</persona>`);
  }
  if (turns.length > 0) {
    parts.push(`<recent_conversation>\n${turns.join('\n\n')}\n</recent_conversation>`);
  }
  parts.push(`Available expressions: ${names.join(', ')}`);
  parts.push('Expression:');

  return {
    system: EXPRESSION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  };
}

/**
 * Parse an aux-model reply into one of the persona's valid expression names,
 * or null if unusable / ambiguous.
 * @param {string} raw
 * @param {unknown} validNames
 * @returns {string|null}
 */
function parseExpressionReply(raw, validNames) {
  const names = sanitizeExpressionNames(validNames);
  if (names.length === 0) return null;

  const byLower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;

  // Explicit bracketed tag (`[expression: excited]` or `[excited]`) if unique.
  const bracketMatches = [...text.matchAll(/\[\s*(?:expression\s*:\s*)?([a-z0-9][a-z0-9_-]{0,30})\s*\]/gi)];
  const bracketHits = new Set();
  for (const m of bracketMatches) {
    const hit = byLower.get(m[1].trim().toLowerCase());
    if (hit) bracketHits.add(hit);
  }
  if (bracketHits.size === 1) return [...bracketHits][0];

  // Step past announcement lines like "Sure:" / "Expression:".
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let idx = 0;
  while (idx < lines.length - 1 && /:$/.test(lines[idx])) idx++;
  let candidate = lines[idx] || '';

  candidate = candidate.replace(/^(?:expression|mood)\s*[:\-–—]\s*/i, '').trim();
  candidate = candidate.replace(/[*_`]+/g, '').trim();

  let prev;
  do {
    prev = candidate;
    candidate = candidate.replace(/^["'“”‘’«»[\]]+\s*(.*?)\s*["'“”‘’«»[\]]+$/u, '$1').trim();
  } while (candidate !== prev);

  candidate = candidate.replace(/[.,;:!?]+$/u, '').trim();

  if (candidate && byLower.has(candidate.toLowerCase())) {
    return byLower.get(candidate.toLowerCase());
  }

  // Fallback for chatty sentences ("I would pick side-eye."): accept only a
  // single unambiguous valid expression name anywhere as a standalone token.
  const hits = [];
  for (const [lower, canonical] of byLower.entries()) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'i');
    if (re.test(text)) hits.push(canonical);
  }
  if (hits.length === 1) return hits[0];

  return null;
}

module.exports = {
  EXPRESSION_SYSTEM_PROMPT,
  MAX_PERSONA_CHARS,
  MAX_CONTEXT_MESSAGES,
  MAX_PRIOR_MSG_CHARS,
  MAX_LAST_USER_CHARS,
  MAX_LAST_REPLY_CHARS,
  buildExpressionRequest,
  parseExpressionReply,
};
