/**
 * Tessera base system layer
 *
 * A platform-level preamble prepended to every persona's system prompt. It
 * tells the model what Tessera is, that the text after it is a persona to
 * embody, and how the avatar expression protocol works.
 *
 * Why this lives server-side rather than in each persona's prompt text:
 *
 * - **It stays true.** The expression instruction is generated from the
 *   persona's *actual* expression set on every request. The old approach
 *   baked a hardcoded list ("neutral, happy, sad, ...") into each persona's
 *   saved prompt at creation, so adding or removing an expression never
 *   reached the model.
 * - **It can't be lost.** Editing a persona prompt can't delete it.
 * - **It caches well.** ORIENTATION is byte-identical for every user,
 *   persona, and conversation, so it sits at the front where it makes the
 *   longest shared prefix for provider prompt caching. The per-persona
 *   expression block comes after it, and the persona's own prompt last —
 *   most-shared to least-shared.
 */

/**
 * Reserved: the "working on it" state the UI drives while a response streams.
 * Never offered to the model. Note `thinking` is NOT reserved — it used to be
 * this slot, and is now an ordinary character expression (a hand-on-chin pose
 * is a perfectly good thing to declare).
 */
const RESERVED_EXPRESSIONS = new Set(['generating']);

// The preset layer (AP-01) supplies the override/normalisation rules and the
// macro expander. This module owns the TEXT; presets.js owns the SHAPE.
const { normalizeBlocks, expandMacros, buildMacroValues } = require('./presets');
// The product name is interpolated from config rather than written here (BR-01)
// so a rename never has to touch prompt text. It is a per-deployment constant,
// so ORIENTATION stays byte-identical across requests and remains the shared
// cache prefix it was designed to be.
const config = require('../config');

/**
 * Expression names are interpolated into the system prompt, so they're
 * constrained. Deliberately matches `validateExpressionName` in
 * routes/avatars.js — names are also filenames and URL segments there, and a
 * name accepted here but rejected there would be an expression that can never
 * have art (spaces were exactly that bug).
 */
const VALID_EXPRESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
const MAX_EXPRESSIONS = 24;

/**
 * The constant half of the base layer. Contains nothing user- or
 * persona-specific — keep it that way so it stays a cacheable shared prefix.
 */
const ORIENTATION = `# ${config.brand}

You are running inside ${config.brand}, a personal AI workspace where one user does
ongoing work with you. Conversations persist, files accumulate, and the user
returns to them over time.

## Persona

Your persona instructions define your name, voice, and character. Embody them
consistently without lapsing into a generic assistant register or narrating
being in character.

Voice never overrides accuracy: say when you're unsure, disagree when you think
the user is wrong, and report problems plainly. Never invent facts, fabricate
file contents, or claim actions you did not perform.

## Workspace and tools

Workspace and project context (instructions and loaded reference files) arrives
in earlier conversation turns as background the user has shared. Current state
for this turn — active containers, scratchpad status, and file counts — arrives
in \`<session_state>\`.

When tools are available, use them directly rather than guessing or acting as if
you ran them:
- Only say you created, edited, moved, or updated something if the tool call
  actually succeeded in this turn.
- If \`<session_state>\` reports files that aren't shown in context, call
  \`list_files\` or \`read_file\` to inspect them rather than assuming they're
  absent.
- Earlier replies of yours may begin with a \`<tool_trail>\` line added by
  ${config.brand} to record tools you actually ran in that reply. Their results
  aren't repeated, but they were real — don't write a \`<tool_trail>\` yourself.`;

/**
 * Filter a raw expression-name list down to what's safe and meaningful to
 * name in the system prompt.
 * @param {unknown} names - Expression names as supplied by the client
 * @returns {string[]} Valid, non-reserved, de-duplicated names
 */
function sanitizeExpressionNames(names) {
  if (!Array.isArray(names)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    const key = name.toLowerCase();
    if (!VALID_EXPRESSION_NAME.test(name)) continue;
    if (RESERVED_EXPRESSIONS.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_EXPRESSIONS) break;
  }
  return out;
}

/**
 * The expression protocol, naming this persona's real expressions.
 *
 * `{{expressions}}` is a macro rather than an interpolation so a user-authored
 * override can place the list wherever they want it (AP-01). The names still
 * come from the persona's ACTUAL expression set on every request — that is the
 * whole reason this layer exists, and no preset can change it.
 */
const EXPRESSION_SECTION = `## Expression

The user sees an avatar whose face reflects your mood. Begin your visible reply
with one expression tag on the first line:

[expression: name]

Available expressions: {{expressions}}

Rules:
- Use exactly one tag per reply, from the list above (pick the closest match if
  none is exact), and let it carry into your tone.
- On tool-using turns, put the tag once at the start of your final reply text —
  don't repeat it before and after tool calls.
- The tag is stripped before display, so never mention, explain, or apologize
  for it.`;

/**
 * The user-profile block (UP-03).
 *
 * Included only when there IS a profile and the persona has not switched it
 * off, so it costs nothing for a user who never wrote one.
 *
 * The framing matters more than it looks. Without the last paragraph, models
 * given a block of facts about someone tend to perform having read it —
 * greeting the user with their own biography, or steering every answer toward a
 * stated interest. The profile is meant to be background the way knowing a
 * colleague is background: it shapes how you talk to them, and you do not
 * recite it at them.
 *
 * `{{profile}}` is a macro rather than an interpolation for the same reason
 * `{{expressions}}` is — a preset may reword this framing and place the content
 * wherever it wants, but it can never change what the content IS.
 */
const PROFILE_SECTION = `## The person you are talking to

{{profile}}

Use this as quiet background — what to call them, what they already know, what
they care about. Do not recite it back, bring it up unprompted, or steer the
conversation toward it. If anything they say in chat contradicts it, trust the
conversation.`;

/**
 * The scratchpad collaboration nudge (SP-05). Included only when the scratchpad
 * is active for the request, so it costs nothing on ordinary chats. This is the
 * adoption lever — models default to putting substance in the chat reply, so it
 * has to be told to develop content IN the pad and to CHURN it rather than let
 * it grow. Lives here (the base-prompt layer) so the wording is iterated in one
 * place; the per-turn `<scratchpad>` block reinforces it with the live content.
 */
const SCRATCHPAD_SECTION = `## Scratchpad

This conversation has a shared scratchpad beside the chat that both you and the
user edit directly via \`write_scratchpad\` (replace whole pad) and
\`edit_scratchpad\` (targeted edit).

When to use it:
- **Use the scratchpad** whenever you and the user are developing evolving work
  — plans, outlines, drafts, specs, checklists, comparisons, or structured
  notes. Start it proactively even if \`<session_state>\` shows it is empty.
- **Stay in chat** for brief answers, quick questions, and discussion about the
  work. Explain what you changed and why in chat instead of duplicating the
  scratchpad's contents.

How to maintain it:
- **Always call the tool to make changes.** Writing a draft in chat or saying
  you updated the scratchpad does not modify it — call \`write_scratchpad\` or
  \`edit_scratchpad\` first.
- **Keep it current, not a log.** Replace, reorganize, and trim superseded
  ideas in place rather than appending. Treat the user's edits as part of your
  shared state.
- Use \`write_scratchpad\` to start the pad, reorganize it, or rewrite a short
  pad; use \`edit_scratchpad\` for targeted changes to a longer pad (matching
  \`<current_content>\` verbatim).`;

/**
 * The synthetic assistant turn that acknowledges injected workspace/project
 * context (FC-03a). A block like any other, so it is editable — it sits in the
 * MESSAGE layer rather than the system layer, which is why the assembly
 * positions it instead of the preset's `order`.
 */
const CONTEXT_ACK = "Understood — I'll use the reference material above as background for our conversation.";

/** Built-in text for every block, by id. `persona` has none — see below. */
const BUILTIN_BLOCK_TEXT = {
  orientation: ORIENTATION,
  profile: PROFILE_SECTION,
  expressions: EXPRESSION_SECTION,
  scratchpad: SCRATCHPAD_SECTION,
  context_ack: CONTEXT_ACK,
};

/** The text a block renders with: the preset's override, or the built-in. */
function blockText(preset, id) {
  const override = preset.blocks[id] && preset.blocks[id].text;
  return typeof override === 'string' ? override : (BUILTIN_BLOCK_TEXT[id] || '');
}

/**
 * Compose the full system prompt for a provider call.
 *
 * Blocks render in the preset's order, joined by a blank line. Three of them are
 * CONDITIONAL on things the preset does not control (D3): the expression section
 * needs the persona to actually have expressions, the scratchpad section needs
 * the pad to be active for this request, and the persona block needs the persona
 * to have a prompt. A preset can reword or reorder them; it cannot make one
 * appear when its condition is false.
 *
 * With no preset this is byte-identical to the pre-AP-01 output — see
 * prompts/test-presets.js, which pins that against a golden string.
 *
 * @param {string} [personaPrompt] - The persona's own system prompt
 * @param {unknown} [expressionNames] - The persona's expression names, unsanitized
 * @param {Object} [options]
 * @param {boolean} [options.scratchpad] - the scratchpad is active for this request (SP-05)
 * @param {boolean} [options.profileEnabled] - the persona may see the user profile (UP-03)
 * @param {boolean} [options.auxExpressions] - aux model picks expressions, so omit tag instructions from main prompt
 * @param {Object} [options.preset] - resolved preset blocks; omit for the built-in layer
 * @param {Object} [options.macros] - buildMacroValues() input (persona name, model, …)
 * @returns {string} The assembled system prompt
 */
function buildSystemPrompt(personaPrompt, expressionNames, options = {}) {
  return composeSystemPrompt(personaPrompt, expressionNames, options).text;
}

/**
 * The composer behind buildSystemPrompt, with provenance (AP-05).
 *
 * Returns the same text plus a record of every block: whether it was included,
 * where its text came from, how big it was, and — the useful part when a prompt
 * isn't doing what you expect — WHY a block was left out. buildSystemPrompt is
 * a thin wrapper over this rather than a parallel implementation, so the
 * inspector can never describe an assembly that differs from the real one.
 *
 * `source`: 'preset' (an override), 'built-in', or 'persona' (the persona's own
 * prompt). `reason` on an excluded block is a stable code the client turns into
 * a sentence: disabled | no-expressions | aux-expressions | scratchpad-inactive | no-persona-prompt | empty.
 *
 * @returns {{text: string, blocks: Array<Object>}}
 */
function composeSystemPrompt(personaPrompt, expressionNames, options = {}) {
  const preset = normalizeBlocks(options.preset);
  const names = sanitizeExpressionNames(expressionNames);
  // expressionNames is forced from the sanitized list: the macro must describe
  // the persona's real expression set, never whatever a caller passed in.
  const macros = buildMacroValues({ ...(options.macros || {}), expressionNames: names });
  const persona = typeof personaPrompt === 'string' ? personaPrompt.trim() : '';

  const parts = [];
  const blocks = [];
  const skip = (id, reason) => blocks.push({ id, included: false, reason, chars: 0 });

  for (const id of preset.order) {
    const block = preset.blocks[id];

    // `state` is NOT handled here any more — it is a message-layer block since
    // PC-01 (see sessionStateBlock below). normalizeBlocks filters `order` to
    // SYSTEM_BLOCK_IDS, so a preset stored while it was a system block simply
    // stops mentioning it; this guard exists only so a hand-written order can
    // never smuggle it back into the system prompt, where its per-turn churn
    // would invalidate the cached prefix for the whole conversation.
    if (id === 'state') continue;

    if (!block || !block.enabled) {
      skip(id, 'disabled');
      continue;
    }

    if (id === 'persona') {
      if (!persona) {
        skip(id, 'no-persona-prompt');
        continue;
      }
      // The `---` rule separates the platform layer from the persona's own
      // words. Nothing to separate when the persona leads, so it is dropped.
      const span = parts.length === 0 ? persona : `---\n\n${persona}`;
      parts.push(span);
      // Reports the span actually emitted, separator included, so the char
      // counts add up to the prompt the model receives.
      blocks.push({ id, included: true, source: 'persona', chars: span.length, text: span });
      continue;
    }
    if (id === 'profile') {
      // Two distinct silences, reported separately: the persona was told not
      // to see the profile, versus there is no profile to see. The inspector
      // turns these into different sentences, and "why is my profile not in
      // the prompt" has exactly these two answers.
      if (!options.profileEnabled) {
        skip(id, 'profile-off');
        continue;
      }
      if (!macros.profile) {
        skip(id, 'no-profile');
        continue;
      }
    }
    if (id === 'expressions') {
      if (names.length === 0) {
        skip(id, 'no-expressions');
        continue;
      }
      if (options.auxExpressions) {
        skip(id, 'aux-expressions');
        continue;
      }
    }
    if (id === 'scratchpad' && !options.scratchpad) {
      skip(id, 'scratchpad-inactive');
      continue;
    }

    const overridden = typeof preset.blocks[id].text === 'string';
    const text = expandMacros(blockText(preset, id), macros).trim();
    if (!text) {
      skip(id, 'empty');
      continue;
    }
    parts.push(text);
    blocks.push({
      id,
      included: true,
      source: overridden ? 'preset' : 'built-in',
      chars: text.length,
      text,
    });
  }
  return { text: parts.join('\n\n'), blocks };
}

/**
 * The context acknowledgement text for this request (see CONTEXT_ACK).
 * @param {Object} [options] - { preset, macros }, as buildSystemPrompt takes
 * @returns {string} the ack, or '' when the block is disabled
 */
function buildContextAck(options = {}) {
  const preset = normalizeBlocks(options.preset);
  if (!preset.blocks.context_ack.enabled) return '';
  return expandMacros(blockText(preset, 'context_ack'), buildMacroValues(options.macros || {})).trim();
}

/**
 * The context-ack block's provenance entry (AP-05), in the same shape
 * composeSystemPrompt produces. It lives in the MESSAGE layer, so it is
 * described separately rather than appearing in the system-prompt list.
 *
 * @param {Object} [options] - { preset, macros }, as buildContextAck takes
 * @param {boolean} [hasContext] - whether this request injects KB context at all
 */
function describeContextAck(options = {}, hasContext = false) {
  const preset = normalizeBlocks(options.preset);
  const id = 'context_ack';
  if (!preset.blocks[id].enabled) return { id, included: false, reason: 'disabled', chars: 0 };
  if (!hasContext) return { id, included: false, reason: 'no-context', chars: 0 };
  const text = buildContextAck(options);
  if (!text) return { id, included: false, reason: 'empty', chars: 0 };
  return {
    id,
    included: true,
    source: typeof preset.blocks[id].text === 'string' ? 'preset' : 'built-in',
    chars: text.length,
    text,
  };
}

/**
 * The `<session_state>` block as it goes into the MESSAGE layer (PC-01).
 *
 * A pass-through of what buildSessionState produced, trimmed — the text is
 * generated from live state and a preset may neither reword nor suppress it
 * (docs/design/SESSION_STATE_DESIGN.md, D3), so unlike every other block there is
 * nothing here to override. It exists as a named function so the send path and
 * the inspector reach the block the same way, and so the "which layer does this
 * live in" answer is in one place.
 *
 * @param {Object} [options] - the promptOptions the assembly built
 * @returns {string} the block, or '' when there is no state to report
 */
function sessionStateBlock(options = {}) {
  return typeof options.sessionState === 'string' ? options.sessionState.trim() : '';
}

/**
 * The session-state block's provenance entry (AP-05), in the same shape
 * composeSystemPrompt produces. Mirrors describeContextAck: a message-layer
 * block is described separately rather than appearing in the system-prompt
 * list.
 *
 * `source: 'generated'` is carried over from when this was a system block, so
 * the inspector keeps labelling it the same way.
 *
 * @param {Object} [options] - the promptOptions the assembly built
 */
function describeSessionState(options = {}) {
  const id = 'state';
  const text = sessionStateBlock(options);
  if (!text) return { id, included: false, reason: 'no-session-state', chars: 0 };
  return { id, included: true, source: 'generated', chars: text.length, text };
}

module.exports = {
  buildSystemPrompt,
  composeSystemPrompt,
  buildContextAck,
  describeContextAck,
  sessionStateBlock,
  describeSessionState,
  sanitizeExpressionNames,
  ORIENTATION,
  EXPRESSION_SECTION,
  PROFILE_SECTION,
  SCRATCHPAD_SECTION,
  CONTEXT_ACK,
  BUILTIN_BLOCK_TEXT,
  RESERVED_EXPRESSIONS,
};
