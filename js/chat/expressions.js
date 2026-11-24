/**
 * The expression protocol (R-05, moved verbatim from main.js).
 *
 * A reply may declare its expression with a leading `[expression: name]` tag.
 * This module owns that contract end to end: detecting the tag, stripping it
 * before display, the partial-tag handling the streaming path needs so a tag
 * split across chunks is never shown to the user, and settling the reserved
 * `generating` state back to a real pose when the turn ends.
 *
 * Expressions are declared by the model, never inferred from the text — the
 * keyword-matching fallback was removed deliberately.
 */

import { state } from '../state.js';
import { CONFIG } from '../config.js';
import { getActivePersona } from '../state.js';
import { updateFloatingAvatar } from '../avatar.js';
import { updateStatusBar } from '../status-bar.js';
import {
    TAG_OPEN,
    LEADING_EXPRESSION_TAG,
    MAX_TAG_NAME_LENGTH,
    isPartialExpressionTag,
    splitLeadingExpressionTag,
    filterStreamingExpressionTags,
    stripExpressionTag,
    findDeclaredExpression,
} from '../util/expression-tags.js';

export {
    TAG_OPEN,
    LEADING_EXPRESSION_TAG,
    MAX_TAG_NAME_LENGTH,
    isPartialExpressionTag,
    splitLeadingExpressionTag,
    filterStreamingExpressionTags,
    stripExpressionTag,
    findDeclaredExpression,
};

// ===== Expression Detection =====
/**
 * Return the expression explicitly declared in `text` (using the last valid
 * tag if multiple rounds declared one), or `null` if none matched.
 * @param {string} text
 * @returns {string|null}
 */
export function detectDeclaredExpression(text) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;
    return findDeclaredExpression(text, expressions, CONFIG.generatingExpression);
}

/**
 * Resolve the expression a response declares.
 *
 * Declaration is the ONLY signal. The old keyword fallback was removed: it
 * matched substrings anywhere in the reply, so 'sorry', 'unfortunately' and
 * 'difficult' pushed the avatar to `sad` constantly during ordinary work talk,
 * and which expression won depended on insertion order in the expression map.
 * A missed tag now just holds the current expression — stale beats wrong.
 *
 * @param {string} text - The full response text
 * @returns {string} The expression name to display
 */
export function detectExpression(text) {
    const declared = detectDeclaredExpression(text);
    if (declared) return declared;

    // Nothing declared: hold the current expression, except settle the
    // transient generating state back to neutral.
    return state.currentExpression === CONFIG.generatingExpression ? 'neutral' : state.currentExpression;
}

/**
 * Drop the avatar out of the `generating` state after a failed or abandoned
 * request. Without this the pulse runs forever: nothing else clears it, since
 * the settled expression is normally applied when a response finalizes.
 * No-op if the avatar has already moved on.
 */
export function settleGeneratingExpression() {
    if (state.currentExpression === CONFIG.generatingExpression) {
        setExpression('neutral');
    }
}

/**
 * Strip prefill text from the start of a response
 * @param {string} text - The full response text
 * @param {string} prefill - The prefill text to strip
 * @returns {string} Text with prefill removed
 */
export function stripPrefillText(text, prefill) {
    if (!prefill || !text) return text;
    const trimmedPrefill = prefill.trim();
    const trimmedText = text.trimStart();
    if (trimmedText.startsWith(trimmedPrefill)) {
        return trimmedText.slice(trimmedPrefill.length).trimStart();
    }
    return text;
}

export async function setExpression(exprName) {
    const persona = getActivePersona();
    const expressions = persona ? persona.expressions : CONFIG.defaultExpressions;

    if (expressions[exprName]) {
        state.currentExpression = exprName;
        await updateFloatingAvatar();
        updateStatusBar();
    }
}
