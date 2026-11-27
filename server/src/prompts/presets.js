/**
 * Prompt presets — the override layer over the built-in prompt blocks (AP-01).
 *
 * A preset is a named set of OVERRIDES, not a copy: every block whose `text` is
 * null renders from the built-in in ./tessera.js. That is what lets the built-in
 * wording keep improving for blocks a user never touched, and makes "reset to
 * built-in" the same operation as "never edited" (Decision D2 in
 * docs/design/ADVANCED_PROMPTS_PLAN.md).
 *
 * WHAT A PRESET CANNOT DO (D3): turn a capability on. Whether tools are
 * advertised, whether the scratchpad is injected, whether KB files are loaded is
 * resolved server-side from the conversation and persona, exactly as before. A
 * preset only changes how those things are WORDED and in what ORDER they appear.
 * Gating and phrasing stay separate on purpose — one source of truth for what
 * the model can actually do.
 *
 * This module is deliberately pure: block definitions, validation, macros, and
 * composition. It reads no database and knows nothing about requests; the DAL
 * lookup and precedence live with the other resolvers in routes/chat.js.
 */

const BLOCKS_VERSION = 1;

/**
 * Sentinel preset id meaning "the built-in layer, explicitly" (AP-04).
 *
 * NULL already means "inherit the next level down", so without this there is no
 * way for a chat to opt OUT of a preset its persona (or the account default)
 * supplies — the same reason `tools_enabled` is a tri-state rather than a
 * boolean. Real ids are UUIDs, so this can never collide with one.
 */
const PRESET_NONE = 'none';

/**
 * The system-layer blocks, in their default order (DF-02).
 *
 *   'orientation'   `<operating_environment>` framing (editable)
 *   'persona'       `<main_persona>` position marker (text comes from persona)
 *   'capabilities'  protected `<capabilities>` sub-layer (position movable,
 *                   server-managed content wrapping active Workspace/Project,
 *                   File Tools, Scratchpad, and Avatar Expressions)
 */
const SYSTEM_BLOCK_IDS = ['orientation', 'persona', 'capabilities'];

/**
 * Blocks that sit in the MESSAGE layer by default (DF-02).
 *
 *   'profile'      `<user_profile>` — defaults to the start of the Message
 *                  layer (cached prefix, paired with Workspace/Project KB),
 *                  and may optionally be placed in `order` (System layer) by
 *                  a preset.
 *   'context_ack'  synthetic assistant reply after leading context (`profile`
 *                  and/or Workspace/Project KB).
 *   'state'        `<current_context>` / `<session_state>` — generated per
 *                  turn and prepended before the latest user message (omitted
 *                  on bare chats). Server-generated; never text-overridable.
 */
const MESSAGE_BLOCK_IDS = ['profile', 'context_ack', 'state'];

/** Blocks allowed to live in EITHER `order` (System) or the Message layer. */
const CROSS_LAYER_BLOCK_IDS = ['persona', 'profile'];

/** Custom user-added block id pattern (`custom_<slug>`). */
const CUSTOM_BLOCK_ID_RE = /^custom_[a-z0-9][a-z0-9_-]{0,31}$/;
function isCustomBlockId(id) {
  return typeof id === 'string' && CUSTOM_BLOCK_ID_RE.test(id);
}

/**
 * Legacy block ids from pre-DF-02 presets (expressions/scratchpad moved inside
 * the protected `<capabilities>` sub-layer; `state` left `order` in PC-01).
 * Tolerated in stored presets so older presets remain loadable and saveable.
 */
const LEGACY_ORDER_IDS = ['state', 'expressions', 'scratchpad'];
const LEGACY_BLOCK_IDS = ['expressions', 'scratchpad'];

const ALL_BLOCK_IDS = [...SYSTEM_BLOCK_IDS, ...MESSAGE_BLOCK_IDS];

// Guard rails against accidents (a runaway paste, a loop building a preset),
// not policy — a genuinely long prompt fits comfortably inside these.
const MAX_BLOCK_CHARS = 8000;
const MAX_PRESET_CHARS = 32000;
const MAX_NAME_CHARS = 80;
const MAX_CUSTOM_BLOCKS = 16;

/** Default layer for each cross-layer built-in block. */
function defaultLayerFor(id) {
  return id === 'profile' ? 'message' : 'system';
}

/** The preset every user starts from: built-in text, built-in order. */
function defaultBlocks() {
  const blocks = {};
  for (const id of ALL_BLOCK_IDS) {
    blocks[id] = {
      enabled: true,
      text: null,
      ...(CROSS_LAYER_BLOCK_IDS.includes(id) ? { layer: defaultLayerFor(id) } : {}),
      ...(id === 'state' ? { position: 'before' } : {}),
    };
  }
  return {
    version: BLOCKS_VERSION,
    order: [...SYSTEM_BLOCK_IDS],
    messageOrder: ['profile'],
    blocks,
  };
}

/**
 * Coerce stored/incoming preset JSON into the shape the composer expects.
 *
 * Tolerant by design — this runs on data that may have been written by an older
 * version of the app, hand-edited, or imported from a file. Anything unrecognised
 * falls back to the built-in rather than throwing, so a malformed preset degrades
 * to "the default prompt" instead of breaking every chat the user owns.
 * `validateBlocks` is the strict counterpart, used on the WRITE path.
 *
 * @param {unknown} raw - parsed `prompt_presets.blocks` JSON, or null
 * @returns {{version: number, order: string[], messageOrder: string[], blocks: Object}}
 */
function normalizeBlocks(raw) {
  const base = defaultBlocks();
  if (!raw || typeof raw !== 'object') return base;

  const rawBlocks = raw.blocks && typeof raw.blocks === 'object' ? raw.blocks : {};
  const out = { version: BLOCKS_VERSION, order: [], messageOrder: [], blocks: {} };

  // 1. Built-in blocks
  for (const id of ALL_BLOCK_IDS) {
    const b = rawBlocks[id] && typeof rawBlocks[id] === 'object' ? rawBlocks[id] : {};
    const isLocked = id === 'state' || id === 'capabilities';
    const entry = {
      enabled: isLocked ? true : b.enabled !== false, // default on; locked blocks stay on
      text: (isLocked || id === 'persona') ? null : (typeof b.text === 'string' ? b.text : null),
    };
    if (CROSS_LAYER_BLOCK_IDS.includes(id)) {
      // Explicit layer wins; missing layer uses the block's default (`persona`
      // → 'system', `profile` → 'message') so legacy v1 presets keep persona in
      // System while migrating profile cleanly to Message.
      if (b.layer === 'system' || b.layer === 'message') {
        entry.layer = b.layer;
      } else {
        entry.layer = defaultLayerFor(id);
      }
    }
    if (id === 'state') {
      entry.position = b.position === 'after' ? 'after' : 'before';
    }
    out.blocks[id] = entry;
  }

  // 2. Custom user-added blocks (DF-04)
  const customIds = [];
  for (const [id, rawB] of Object.entries(rawBlocks)) {
    if (!isCustomBlockId(id)) continue;
    if (customIds.length >= MAX_CUSTOM_BLOCKS) break;
    if (!rawB || typeof rawB !== 'object') continue;
    const rawName = typeof rawB.name === 'string' ? rawB.name.trim() : '';
    const layer = rawB.layer === 'message' ? 'message' : 'system';
    out.blocks[id] = {
      custom: true,
      name: (rawName || 'Custom block').slice(0, MAX_NAME_CHARS),
      layer,
      ...(layer === 'message' ? { placement: rawB.placement === 'tail' ? 'tail' : 'cached' } : {}),
      enabled: rawB.enabled !== false,
      text: typeof rawB.text === 'string' ? rawB.text : '',
    };
    customIds.push(id);
  }

  // 3. System layer order: every block currently assigned to System
  const systemMembers = new Set([
    ...SYSTEM_BLOCK_IDS.filter((id) => !CROSS_LAYER_BLOCK_IDS.includes(id) || out.blocks[id].layer === 'system'),
    ...CROSS_LAYER_BLOCK_IDS.filter((id) => out.blocks[id].layer === 'system'),
    ...customIds.filter((id) => out.blocks[id].layer === 'system'),
  ]);
  const wantedSys = Array.isArray(raw.order) ? raw.order : base.order;
  const seenSys = new Set();
  for (const id of wantedSys) {
    if (systemMembers.has(id) && !seenSys.has(id)) {
      seenSys.add(id);
      out.order.push(id);
    }
  }
  for (const id of systemMembers) {
    if (!seenSys.has(id)) out.order.push(id);
  }

  // 4. Message layer movable order: cross-layer blocks in Message + Message custom blocks
  const msgMembers = new Set([
    ...CROSS_LAYER_BLOCK_IDS.filter((id) => out.blocks[id].layer === 'message'),
    ...customIds.filter((id) => out.blocks[id].layer === 'message'),
  ]);
  const wantedMsg = Array.isArray(raw.messageOrder) ? raw.messageOrder : base.messageOrder;
  const seenMsg = new Set();
  for (const id of wantedMsg) {
    if (msgMembers.has(id) && !seenMsg.has(id)) {
      seenMsg.add(id);
      out.messageOrder.push(id);
    }
  }
  for (const id of msgMembers) {
    if (!seenMsg.has(id)) out.messageOrder.push(id);
  }

  return out;
}

/**
 * Strict validation for the write path (the AP-02 API + import).
 * @param {unknown} raw
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function validateBlocks(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Preset blocks must be an object.' };
  }
  const rawBlocks = raw.blocks !== undefined ? raw.blocks : {};
  if (raw.blocks !== undefined && (!rawBlocks || typeof rawBlocks !== 'object' || Array.isArray(rawBlocks))) {
    return { ok: false, error: '"blocks" must be an object.' };
  }

  const definedCustomIds = new Set(Object.keys(rawBlocks).filter(isCustomBlockId));
  if (definedCustomIds.size > MAX_CUSTOM_BLOCKS) {
    return { ok: false, error: `A preset can have at most ${MAX_CUSTOM_BLOCKS} custom blocks.` };
  }

  const allowedInOrder = new Set([...SYSTEM_BLOCK_IDS, ...CROSS_LAYER_BLOCK_IDS, ...definedCustomIds]);
  if (raw.order !== undefined) {
    if (!Array.isArray(raw.order)) return { ok: false, error: '"order" must be an array.' };
    for (const id of raw.order) {
      if (LEGACY_ORDER_IDS.includes(id)) continue;
      if (!allowedInOrder.has(id)) {
        return { ok: false, error: `Unknown block in "order": ${String(id)}` };
      }
    }
    if (new Set(raw.order).size !== raw.order.length) {
      return { ok: false, error: '"order" contains a duplicate block.' };
    }
  }

  const allowedInMsgOrder = new Set([...CROSS_LAYER_BLOCK_IDS, ...definedCustomIds]);
  if (raw.messageOrder !== undefined) {
    if (!Array.isArray(raw.messageOrder)) return { ok: false, error: '"messageOrder" must be an array.' };
    for (const id of raw.messageOrder) {
      if (!allowedInMsgOrder.has(id)) {
        return { ok: false, error: `Unknown block in "messageOrder": ${String(id)}` };
      }
    }
    if (new Set(raw.messageOrder).size !== raw.messageOrder.length) {
      return { ok: false, error: '"messageOrder" contains a duplicate block.' };
    }
  }

  if (raw.blocks !== undefined) {
    let total = 0;
    for (const [id, b] of Object.entries(rawBlocks)) {
      if (LEGACY_BLOCK_IDS.includes(id)) continue;
      const isCustom = isCustomBlockId(id);
      if (!ALL_BLOCK_IDS.includes(id) && !isCustom) {
        return { ok: false, error: `Unknown block: ${id}` };
      }
      if (!b || typeof b !== 'object' || Array.isArray(b)) {
        return { ok: false, error: `Block "${id}" must be an object.` };
      }
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
        return { ok: false, error: `Block "${id}": "enabled" must be true or false.` };
      }
      if (isCustom) {
        if (typeof b.name !== 'string' || b.name.trim() === '') {
          return { ok: false, error: `Custom block "${id}" requires a name.` };
        }
        if (b.name.length > MAX_NAME_CHARS) {
          return { ok: false, error: `Custom block "${id}" name is over the ${MAX_NAME_CHARS}-character limit.` };
        }
        if (b.layer !== undefined && b.layer !== 'system' && b.layer !== 'message') {
          return { ok: false, error: `Block "${id}": invalid layer "${String(b.layer)}".` };
        }
        if (b.placement !== undefined && b.placement !== 'cached' && b.placement !== 'tail') {
          return { ok: false, error: `Block "${id}": invalid placement "${String(b.placement)}".` };
        }
      } else {
        if (b.layer !== undefined) {
          if (!CROSS_LAYER_BLOCK_IDS.includes(id) || (b.layer !== 'system' && b.layer !== 'message')) {
            return { ok: false, error: `Block "${id}": invalid layer "${String(b.layer)}".` };
          }
        }
        if (b.position !== undefined) {
          if (id !== 'state' || (b.position !== 'before' && b.position !== 'after')) {
            return { ok: false, error: `Block "${id}": invalid position "${String(b.position)}".` };
          }
        }
      }
      if (id === 'state') {
        if (b.enabled === false) {
          return { ok: false, error: 'The current-context block cannot be turned off — it is managed from live session state.' };
        }
        if (typeof b.text === 'string') {
          return { ok: false, error: 'The current-context block cannot be edited — its text is generated from live workspace state.' };
        }
      }
      if (id === 'capabilities') {
        if (b.enabled === false) {
          return { ok: false, error: 'The capabilities sub-layer cannot be turned off — individual features are toggled per chat or in Settings.' };
        }
        if (typeof b.text === 'string') {
          return { ok: false, error: 'The capabilities sub-layer is server-managed to protect tool reliability and cannot be edited directly.' };
        }
      }
      if (b.text !== undefined && b.text !== null) {
        if (typeof b.text !== 'string') {
          return { ok: false, error: `Block "${id}": "text" must be a string or null.` };
        }
        if (b.text.length > MAX_BLOCK_CHARS) {
          return { ok: false, error: `Block "${id}" is over the ${MAX_BLOCK_CHARS}-character limit.` };
        }
        total += b.text.length;
      }
      // The persona block is a position marker — its text lives on the persona.
      if (id === 'persona' && typeof b.text === 'string' && b.text.length > 0) {
        return { ok: false, error: 'The persona block holds no text of its own — edit the persona instead.' };
      }
    }
    if (total > MAX_PRESET_CHARS) {
      return { ok: false, error: `Preset is over the ${MAX_PRESET_CHARS}-character limit.` };
    }
  }
  return { ok: true };
}

/** Validate a preset name. @returns {{ok: true}|{ok: false, error: string}} */
function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, error: 'Preset name is required.' };
  }
  if (name.length > MAX_NAME_CHARS) {
    return { ok: false, error: `Preset name is over the ${MAX_NAME_CHARS}-character limit.` };
  }
  return { ok: true };
}

// ===== Macros =====

/**
 * Expand `{{macro}}` references in one pass.
 *
 * Two deliberate properties:
 * - **Unknown macros are left verbatim.** Blanking text a user typed because we
 *   didn't recognise a name is worse than showing it back to them.
 * - **Non-recursive.** A replacement is never re-scanned, so no macro can expand
 *   into another one (or into itself).
 *
 * @param {string} text
 * @param {Object} values - macro name → string
 * @returns {string}
 */
function expandMacros(text, values) {
  if (typeof text !== 'string' || text === '') return '';
  return text.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name) => {
    const key = String(name).toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match;
  });
}

/**
 * Build the macro table for one request. Everything is a string; a value with no
 * source resolves to '' rather than being left as a literal `{{char}}`, since an
 * empty name is a missing value, not an unrecognised macro.
 *
 * @param {Object} [ctx]
 * @param {string} [ctx.personaName]
 * @param {string} [ctx.userName]
 * @param {string[]} [ctx.expressionNames] - already sanitized
 * @param {string} [ctx.workspaceName]
 * @param {string} [ctx.projectName]
 * @param {string} [ctx.model]
 * @param {Date} [ctx.now]
 * @returns {Object}
 */
function buildMacroValues(ctx = {}) {
  const when = ctx.now instanceof Date ? ctx.now : new Date();
  return {
    char: ctx.personaName || '',
    // `userName` is already the RESOLVED name (preferred, else account) — see
    // prompts/profile.js resolveUserName. This macro does not know which it got,
    // and should not: every caller must resolve it the same way.
    user: ctx.userName || '',
    // The rendered user profile (UP-03). Empty when the user has written none,
    // when the persona has it switched off, or on a request that never loaded
    // one — the block skips itself in all three cases.
    profile: ctx.profileText || '',
    expressions: Array.isArray(ctx.expressionNames) ? ctx.expressionNames.join(', ') : '',
    workspace: ctx.workspaceName || '',
    project: ctx.projectName || '',
    model: ctx.model || '',
    date: when.toISOString().slice(0, 10),
    time: when.toISOString().slice(11, 16),
  };
}

/** Macro names + one-line descriptions, for the editor's reference list (AP-03). */
const MACRO_REFERENCE = [
  { name: 'char', description: "The active persona's name" },
  { name: 'user', description: 'What to call you — your Profile name, else your account name' },
  { name: 'profile', description: 'Your Profile: enabled sections (your name is in {{user}})' },
  { name: 'expressions', description: "The persona's expression names, comma-separated" },
  { name: 'workspace', description: "The chat's workspace name, if any" },
  { name: 'project', description: "The chat's project name, if any" },
  { name: 'model', description: 'The model id for this request' },
  { name: 'date', description: "Today's date (YYYY-MM-DD)" },
  { name: 'time', description: 'Current time (HH:MM, UTC)' },
];

module.exports = {
  BLOCKS_VERSION,
  PRESET_NONE,
  SYSTEM_BLOCK_IDS,
  MESSAGE_BLOCK_IDS,
  CROSS_LAYER_BLOCK_IDS,
  ALL_BLOCK_IDS,
  MAX_BLOCK_CHARS,
  MAX_PRESET_CHARS,
  MAX_NAME_CHARS,
  MAX_CUSTOM_BLOCKS,
  isCustomBlockId,
  defaultBlocks,
  normalizeBlocks,
  validateBlocks,
  validateName,
  expandMacros,
  buildMacroValues,
  MACRO_REFERENCE,
};
