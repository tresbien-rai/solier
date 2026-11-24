/**
 * Pure helpers for Solier's `[expression: name]` control tags.
 *
 * Kept dependency-free (only imports pure tool-trail stripping) so both
 * browser modules (`js/chat/expressions.js`) and Node unit tests
 * (`tests/expression-tags.test.js`) can import it directly.
 */

import { stripToolTrail } from './tool-trail.js';

export const TAG_OPEN = '[expression:';
export const MAX_TAG_NAME_LENGTH = 40;

export const EXPRESSION_TAG_RE = /\[expression:\s*([\w -]+)\]/gi;
export const EXPRESSION_TAG_STRIP_RE = /\[expression:\s*[\w -]+\][ \t]*(?:\r?\n)?/gi;
export const LEADING_EXPRESSION_TAG = /^\s*\[expression:\s*([\w -]+)\]\s*/i;

/**
 * Could `text` still grow into a complete `[expression: name]` tag?
 * Two phases: still typing out `[expression:` itself, or past the opener and
 * accumulating a plausible name that hasn't closed yet.
 * @param {string} text
 * @returns {boolean}
 */
export function isPartialExpressionTag(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    const lower = text.toLowerCase();
    if (lower.length < TAG_OPEN.length) return TAG_OPEN.startsWith(lower);
    if (!lower.startsWith(TAG_OPEN)) return false;
    const name = text.slice(TAG_OPEN.length);
    return !name.includes(']') && name.length <= MAX_TAG_NAME_LENGTH && /^[\w -]*$/.test(name);
}

/**
 * Find the declared expression in `text` (using the LAST valid match, so a
 * post-tool round overrides an earlier one). Returns `null` if no valid
 * non-reserved expression tag is found.
 * @param {string} text
 * @param {Object} expressionsMap
 * @param {string} [reservedName='generating']
 * @returns {string|null}
 */
export function findDeclaredExpression(text, expressionsMap, reservedName = 'generating') {
    if (typeof text !== 'string' || !text || !expressionsMap || typeof expressionsMap !== 'object') {
        return null;
    }
    const matches = [...text.matchAll(EXPRESSION_TAG_RE)];
    for (let i = matches.length - 1; i >= 0; i--) {
        const exprName = matches[i][1].trim().toLowerCase();
        if (!exprName || exprName === reservedName) continue;
        if (Object.prototype.hasOwnProperty.call(expressionsMap, exprName) && expressionsMap[exprName]) {
            return exprName;
        }
    }
    return null;
}

/**
 * Clean control tokens out of a finished reply: expression tags anywhere in
 * the message, plus any leading `<tool_trail>` copied from history.
 * @param {string} text
 * @returns {string}
 */
export function stripExpressionTag(text) {
    if (!text) return '';
    return stripToolTrail(String(text).replace(EXPRESSION_TAG_STRIP_RE, '')).trim();
}

/**
 * Strip complete expression tags anywhere in a streaming reply and withhold a
 * trailing partial `[expression:...` opener until it completes or diverges.
 * Preserves internal whitespace (such as tool-round `\n\n` breaks) so recorded
 * tool offsets remain aligned.
 * @param {string} text - Accumulated text (prefill already stripped)
 * @returns {{ display: string, expression: string|null, pending: boolean }}
 */
export function filterStreamingExpressionTags(text) {
    let expression = null;
    let clean = String(text || '').replace(EXPRESSION_TAG_STRIP_RE, (match) => {
        const inner = match.match(/\[expression:\s*([\w -]+)\]/i);
        if (inner) {
            const name = inner[1].trim().toLowerCase();
            if (name) expression = name;
        }
        return '';
    });
    clean = stripToolTrail(clean);

    let pending = false;
    const lastOpen = clean.lastIndexOf('[');
    if (lastOpen !== -1 && isPartialExpressionTag(clean.slice(lastOpen))) {
        clean = clean.slice(0, lastOpen);
        pending = true;
    }

    const display = clean.replace(/^\s+/, '');
    return { display, expression, pending };
}

/** Backwards-compatible alias for callers expecting the leading-tag splitter. */
export function splitLeadingExpressionTag(text) {
    return filterStreamingExpressionTags(text);
}
