/**
 * Prompt preset test (AP-01, docs/design/ADVANCED_PROMPTS_PLAN.md)
 *
 * Three things, in descending order of how much they'd hurt to get wrong:
 *
 * 1. **Byte-identity.** With no preset, buildSystemPrompt must produce exactly
 *    what it produced before AP-01, for every combination of the three
 *    conditions that shape it. The expected strings below are pinned from the
 *    pre-AP-01 implementation — if a change to the built-in wording is
 *    deliberate, update GOLDEN; if this fails unexpectedly, the composer broke.
 * 2. **Overrides + order.** A preset changes wording and sequence, and a block
 *    it never touched still renders from the built-in.
 * 3. **Gating survives.** A preset cannot make a conditional block appear when
 *    its condition is false (Decision D3) — the security-shaped property here.
 *
 * Plus macros, normalisation of junk input, and validation limits.
 * Pure functions only: no DB, no requests.
 *
 * Run with: node src/prompts/test-presets.js
 */

const assert = require('node:assert');
const config = require('../config');
const {
  buildSystemPrompt, buildContextAck, composeSystemPrompt, describeContextAck,
  sessionStateBlock, resolveStatePosition, describeSessionState,
  buildCapabilitiesBlock, buildProfileMessageBlock, describeProfileMessageBlock,
  composeMessageLeadingBlocks, composeMessageTailBlocks,
  ORIENTATION, CONTEXT_ACK,
  CAPABILITY_WORKSPACE, CAPABILITY_FILE_TOOLS, CAPABILITY_SECTIONS, SCRATCHPAD_SECTION, EXPRESSION_SECTION,
} = require('./tessera');
const {
  PRESET_NONE,
  defaultBlocks,
  normalizeBlocks,
  validateBlocks,
  validateName,
  expandMacros,
  buildMacroValues,
  MAX_BLOCK_CHARS,
  SYSTEM_BLOCK_IDS,
  MESSAGE_BLOCK_IDS,
} = require('./presets');

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`   ✓ ${label}`);
  } catch (err) {
    console.log(`   ✗ ${label}`);
    console.log(`      ${err.message}`);
    failures++;
  }
}

const PERSONA = 'You are Vela, a terse navigator.';
const EXPRESSIONS = ['neutral', 'happy', 'wry'];

/** The built-in DF-02 composition, rebuilt from its parts. */
function golden({
  expressions = false,
  scratchpad = false,
  hasContainer = false,
  toolsEnabled = false,
  persona = false,
  personaName = '',
} = {}) {
  const parts = [ORIENTATION];
  if (persona) {
    const heading = personaName ? `# Persona: ${personaName}` : '# Persona';
    parts.push(`<main_persona>\n${heading}\nThis is who you are.\n\n${PERSONA}\n</main_persona>`);
  }
  const caps = [];
  if (hasContainer) caps.push(CAPABILITY_WORKSPACE);
  if (toolsEnabled) caps.push(CAPABILITY_FILE_TOOLS);
  if (scratchpad) caps.push(SCRATCHPAD_SECTION);
  if (expressions) caps.push(EXPRESSION_SECTION.replace('{{expressions}}', EXPRESSIONS.join(', ')));
  if (caps.length > 0) {
    parts.push(
      `<capabilities>\n# Capabilities\nThis section lists what context, tools, and abilities you have access to in this session.\n\n${caps.join('\n\n')}\n</capabilities>`
    );
  }
  return parts.join('\n\n');
}

console.log('='.repeat(60));
console.log('Prompt presets (AP-01 / DF-02)');
console.log('='.repeat(60));

console.log('\n1. Built-in DF-02 assembly (no preset)...');

for (const expressions of [false, true]) {
  for (const scratchpad of [false, true]) {
    for (const hasContainer of [false, true]) {
      for (const toolsEnabled of [false, true]) {
        for (const persona of [false, true]) {
          const label = `expr=${expressions} pad=${scratchpad} container=${hasContainer} tools=${toolsEnabled} persona=${persona}`;
          check(label, () => {
            const actual = buildSystemPrompt(
              persona ? PERSONA : '',
              expressions ? EXPRESSIONS : [],
              { scratchpad, hasContainer, toolsEnabled }
            );
            assert.strictEqual(
              actual,
              golden({ expressions, scratchpad, hasContainer, toolsEnabled, persona })
            );
          });
        }
      }
    }
  }
}

check('persona heading includes {{char}} when personaName is given', () => {
  const out = buildSystemPrompt(PERSONA, [], { macros: { personaName: 'Vela' } });
  assert.strictEqual(out, golden({ persona: true, personaName: 'Vela' }));
  assert.ok(out.includes('<main_persona>\n# Persona: Vela\nThis is who you are.'));
});

check('the context ack is voice-neutral', () => {
  assert.strictEqual(buildContextAck(), CONTEXT_ACK);
  assert.strictEqual(CONTEXT_ACK, 'Reference context noted.');
});

check('a persona prompt is trimmed, as before', () => {
  const out = buildSystemPrompt(`  \n${PERSONA}\n  `, [], {});
  assert.strictEqual(out, golden({ persona: true }));
});

console.log('\n2. Overrides and ordering...');

check('an override replaces only its own block', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM ORIENTATION';
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  assert.ok(out.startsWith('CUSTOM ORIENTATION'), 'override applied');
  assert.ok(!out.includes(`# ${config.brand}`), 'built-in orientation gone');
  assert.ok(out.includes('<main_persona>'), 'persona wrapped');
  assert.ok(out.includes('<capabilities>'), 'capabilities present');
  assert.ok(out.includes('## Avatar Expressions'), 'expression sub-section present');
});

check('reordering moves blocks, persona and capabilities included', () => {
  const preset = defaultBlocks();
  preset.order = ['persona', 'capabilities', 'orientation'];
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  const pIdx = out.indexOf('<main_persona>');
  const cIdx = out.indexOf('<capabilities>');
  const oIdx = out.indexOf('<operating_environment>');
  assert.ok(pIdx === 0 && pIdx < cIdx && cIdx < oIdx, 'order respected');
});

check('a disabled block is omitted', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.enabled = false;
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  assert.ok(!out.includes(`# ${config.brand}`), 'orientation gone');
  assert.ok(out.includes('## Avatar Expressions'), 'the rest survives');
});

check('a disabled context_ack renders as empty', () => {
  const preset = defaultBlocks();
  preset.blocks.context_ack.enabled = false;
  assert.strictEqual(buildContextAck({ preset }), '');
});

check('disabling all mutable system blocks with no active capabilities yields empty prompt', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.enabled = false;
  preset.blocks.persona.enabled = false;
  assert.strictEqual(buildSystemPrompt('', [], { preset }), '');
});

console.log('\n3. Protected <capabilities> sub-layer & gating (D3 / DF-02)...');

check('capabilities omits completely when nothing is active', () => {
  const out = buildSystemPrompt(PERSONA, [], {
    hasContainer: false, toolsEnabled: false, scratchpad: false,
  });
  assert.ok(!out.includes('<capabilities>'), 'no empty wrapper');
});

check('file tool names NEVER appear when toolsEnabled is false, even inside a workspace', () => {
  const out = buildSystemPrompt(PERSONA, [], { hasContainer: true, toolsEnabled: false });
  assert.ok(out.includes('## Workspace & Project'), 'workspace guidance included');
  assert.ok(!out.includes('## File Tools'), 'file tools section omitted');
  for (const name of ['list_files', 'read_file', 'create_file', 'edit_file', 'move_file']) {
    assert.ok(!out.includes(name), `${name} must not be advertised when tools are off`);
  }
});

check('file tool guidance appears only when toolsEnabled is true', () => {
  const out = buildSystemPrompt(PERSONA, [], { hasContainer: true, toolsEnabled: true });
  assert.ok(out.includes('## Workspace & Project'));
  assert.ok(out.includes('## File Tools'));
  for (const name of ['list_files', 'read_file', 'create_file', 'edit_file', 'move_file']) {
    assert.ok(out.includes(name), `${name} listed when tools are on`);
  }
});

check('scratchpad sub-section stays out when the pad is inactive', () => {
  const off = buildSystemPrompt(PERSONA, [], { scratchpad: false });
  assert.ok(!off.includes('## Scratchpad'));
  const on = buildSystemPrompt(PERSONA, [], { scratchpad: true });
  assert.ok(on.includes('## Scratchpad'));
  assert.ok(on.includes('<capabilities>') && on.includes('</capabilities>'));
});

check('the expression list comes from the persona, not the caller', () => {
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, {
    macros: { expressionNames: ['smug', 'injected'] },
  });
  assert.ok(out.includes('neutral, happy, wry'), out.slice(0, 400));
  assert.ok(!out.includes('injected'));
});

check('reserved + malformed expression names never reach the prompt (including direct buildCapabilitiesBlock calls)', () => {
  const out = buildSystemPrompt(PERSONA, ['generating', 'bad name', 'ok'], {});
  assert.ok(out.includes('List of available avatar expressions: ok'), 'only the valid name survives');
  const direct = buildCapabilitiesBlock(['generating', 'bad name', 'ok'], {});
  assert.ok(direct.includes('List of available avatar expressions: ok'));
  assert.ok(!direct.includes('generating') && !direct.includes('bad name'));
});

check('capabilities cannot be disabled or text-overridden on write or read', () => {
  const dis = validateBlocks({ blocks: { capabilities: { enabled: false } } });
  assert.strictEqual(dis.ok, false);
  assert.match(dis.error, /cannot be turned off/);
  const txt = validateBlocks({ blocks: { capabilities: { text: 'hijack' } } });
  assert.strictEqual(txt.ok, false);
  assert.match(txt.error, /cannot be edited/);
  const emptyTxt = validateBlocks({ blocks: { capabilities: { text: '' } } });
  assert.strictEqual(emptyTxt.ok, false, 'empty string rejected too');

  // Defense in depth on read: corrupted DB JSON is healed by normalizeBlocks
  // and still emits built-in capabilities.
  const corrupted = { blocks: { capabilities: { enabled: false, text: 'hijack' } } };
  const norm = normalizeBlocks(corrupted);
  assert.strictEqual(norm.blocks.capabilities.enabled, true);
  assert.strictEqual(norm.blocks.capabilities.text, null);
  const prompt = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset: corrupted });
  assert.ok(prompt.includes('<capabilities>') && !prompt.includes('hijack'));
});

check('legacy v1 presets migrate profile to Message layer and strip expressions/scratchpad', () => {
  const v1 = {
    order: ['orientation', 'profile', 'expressions', 'scratchpad', 'persona'],
    blocks: {
      orientation: { enabled: true, text: 'CUSTOM' },
      expressions: { enabled: true, text: 'old expr' },
      scratchpad: { enabled: true, text: 'old pad' },
    },
  };
  assert.strictEqual(validateBlocks(v1).ok, true, 'v1 presets stay saveable');
  const norm = normalizeBlocks(v1);
  assert.ok(!norm.order.includes('expressions') && !norm.order.includes('scratchpad'));
  assert.ok(norm.order.includes('capabilities'), 'capabilities added to order');
  assert.strictEqual(norm.blocks.profile.layer, 'message', 'legacy v1 preset migrates profile to Message layer');
  assert.ok(!norm.order.includes('profile'), 'profile removed from System order unless layer: "system" is explicit');
});

console.log('\n4. Macros...');

check('known macros expand, unknown ones are left verbatim', () => {
  const values = buildMacroValues({ personaName: 'Vela', userName: 'Rai' });
  assert.strictEqual(
    expandMacros('{{char}} greets {{user}} at {{nowhere}}', values),
    'Vela greets Rai at {{nowhere}}'
  );
});

check('macro expansion is a single pass (no recursion)', () => {
  const out = expandMacros('{{char}}', buildMacroValues({ personaName: '{{user}}', userName: 'Rai' }));
  assert.strictEqual(out, '{{user}}', 'the inserted value is not re-scanned');
});

check('whitespace and case inside the braces are tolerated', () => {
  const values = buildMacroValues({ personaName: 'Vela' });
  assert.strictEqual(expandMacros('{{ CHAR }}', values), 'Vela');
});

check('a macro with no source resolves to empty, not to the literal', () => {
  assert.strictEqual(expandMacros('[{{project}}]', buildMacroValues({})), '[]');
});

check('date and time are ISO-shaped', () => {
  const v = buildMacroValues({ now: new Date(Date.UTC(2026, 6, 30, 14, 5)) });
  assert.strictEqual(v.date, '2026-07-30');
  assert.strictEqual(v.time, '14:05');
});

console.log('\n5. Normalisation of stored/imported JSON...');

check('null / garbage falls back to the built-in shape', () => {
  for (const raw of [null, undefined, 'nope', 42, []]) {
    const n = normalizeBlocks(raw);
    assert.deepStrictEqual(n.order, SYSTEM_BLOCK_IDS, `order for ${JSON.stringify(raw)}`);
    assert.strictEqual(n.blocks.orientation.text, null);
    assert.strictEqual(n.blocks.orientation.enabled, true);
  }
});

check('unknown ids are dropped and missing ones appended', () => {
  const n = normalizeBlocks({ order: ['persona', 'not_a_block', 'persona'] });
  assert.strictEqual(n.order[0], 'persona', 'the known id keeps its place');
  assert.strictEqual(new Set(n.order).size, n.order.length, 'no duplicates');
  assert.deepStrictEqual(
    [...n.order].sort(),
    [...SYSTEM_BLOCK_IDS].sort(),
    'every system block is present exactly once'
  );
});

check('a non-string text is treated as "use the built-in"', () => {
  const n = normalizeBlocks({ blocks: { orientation: { text: 12 } } });
  assert.strictEqual(n.blocks.orientation.text, null);
});

check('a malformed preset still composes the built-in prompt', () => {
  const out = buildSystemPrompt(PERSONA, EXPRESSIONS, { preset: { blocks: 'broken' } });
  assert.strictEqual(out, golden({ expressions: true, persona: true }));
});

console.log('\n6. Validation (the write path)...');

check('the default blocks validate', () => {
  assert.strictEqual(validateBlocks(defaultBlocks()).ok, true);
});

check('an unknown block id is rejected', () => {
  const r = validateBlocks({ blocks: { jailbreak: { text: 'hi' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Unknown block/);
});

check('an unknown id in order is rejected', () => {
  assert.strictEqual(validateBlocks({ order: ['orientation', 'nope'] }).ok, false);
});

check('a duplicate in order is rejected', () => {
  assert.strictEqual(validateBlocks({ order: ['orientation', 'orientation'] }).ok, false);
});

check('an over-long block is rejected', () => {
  const r = validateBlocks({ blocks: { orientation: { text: 'x'.repeat(MAX_BLOCK_CHARS + 1) } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /limit/);
});

check('text on the persona block is rejected', () => {
  const r = validateBlocks({ blocks: { persona: { text: 'not yours' } } });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /persona/i);
});

check('names are required and bounded', () => {
  assert.strictEqual(validateName('').ok, false);
  assert.strictEqual(validateName('   ').ok, false);
  assert.strictEqual(validateName('x'.repeat(200)).ok, false);
  assert.strictEqual(validateName('Roleplay v2').ok, true);
});

console.log('\n7. Provenance (AP-05)...');

check('the reported spans reconstruct the prompt exactly', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM';
  const { text, blocks } = composeSystemPrompt(PERSONA, EXPRESSIONS, { preset, scratchpad: true });
  const included = blocks.filter(b => b.included);
  // Joining the reported spans must give back the real prompt, character for
  // character. This is the property the inspector's char counts rest on.
  assert.strictEqual(included.map(b => b.text).join('\n\n'), text);
  assert.strictEqual(
    included.reduce((n, b) => n + b.chars, 0) + (included.length - 1) * 2,
    text.length
  );
});

check('sources name where each block\'s text came from', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.text = 'CUSTOM';
  const { blocks } = composeSystemPrompt(PERSONA, EXPRESSIONS, { preset });
  const by = Object.fromEntries(blocks.map(b => [b.id, b]));
  assert.strictEqual(by.orientation.source, 'preset', 'overridden');
  assert.strictEqual(by.orientation.layer, 'system');
  assert.strictEqual(by.persona.source, 'persona', 'the persona’s own prompt');
  assert.strictEqual(by.capabilities.source, 'built-in', 'server-managed capabilities');
});

check('every exclusion carries a reason', () => {
  const preset = defaultBlocks();
  preset.blocks.orientation.enabled = false;
  // No capabilities, no persona prompt → distinct reasons.
  const { blocks } = composeSystemPrompt('', [], { preset, scratchpad: false });
  const by = Object.fromEntries(blocks.map(b => [b.id, b]));
  assert.strictEqual(by.orientation.reason, 'disabled');
  assert.strictEqual(by.persona.reason, 'no-persona-prompt');
  assert.strictEqual(by.capabilities.reason, 'no-capabilities');
  assert.ok(blocks.every(b => b.included || b.reason), 'no unexplained exclusion');
});

check('auxExpressions omits Avatar Expressions from capabilities', () => {
  const off = composeSystemPrompt(PERSONA, EXPRESSIONS, { auxExpressions: false });
  const offCap = off.blocks.find(b => b.id === 'capabilities');
  assert.strictEqual(offCap.included, true, 'included when auxExpressions is false');
  assert.ok(off.text.includes('## Avatar Expressions'));

  const on = composeSystemPrompt(PERSONA, EXPRESSIONS, { auxExpressions: true });
  const onCap = on.blocks.find(b => b.id === 'capabilities');
  assert.strictEqual(onCap.included, false, 'capabilities omitted when only expressions were active');
  assert.strictEqual(onCap.reason, 'no-capabilities');
  assert.ok(!on.text.includes('## Avatar Expressions'), 'expression instructions absent from prompt');

  const withPad = composeSystemPrompt(PERSONA, EXPRESSIONS, { auxExpressions: true, scratchpad: true });
  assert.ok(withPad.text.includes('## Scratchpad'), 'other capabilities still included');
  assert.ok(!withPad.text.includes('## Avatar Expressions'), 'expression sub-section omitted');
});

check('the context ack, profile, and state carry layer="message" separately from system', () => {
  assert.strictEqual(describeContextAck({}, false).reason, 'no-context');
  const ack = describeContextAck({}, true);
  assert.strictEqual(ack.included, true);
  assert.strictEqual(ack.layer, 'message');
  const off = defaultBlocks();
  off.blocks.context_ack.enabled = false;
  assert.strictEqual(describeContextAck({ preset: off }, true).reason, 'disabled');

  const bareState = describeSessionState({ bareChat: true });
  assert.strictEqual(bareState.included, false);
  assert.strictEqual(bareState.reason, 'bare-chat');
  assert.strictEqual(bareState.layer, 'message');

  const prof = describeProfileMessageBlock({
    profileEnabled: true,
    hasProfile: true,
    macros: { userName: 'Rai', profileText: '### Role\nNavigator.' },
  });
  assert.strictEqual(prof.included, true);
  assert.strictEqual(prof.layer, 'message');
  assert.strictEqual(buildProfileMessageBlock({
    profileEnabled: true,
    hasProfile: true,
    macros: { userName: 'Rai', profileText: '### Role\nNavigator.' },
  }), prof.text);
});

check('buildSystemPrompt and composeSystemPrompt cannot drift', () => {
  // buildSystemPrompt is a wrapper, not a parallel implementation — this is
  // what lets the inspector claim to show the real assembly.
  for (const scratchpad of [false, true]) {
    for (const persona of ['', PERSONA]) {
      const opts = { scratchpad };
      assert.strictEqual(
        buildSystemPrompt(persona, EXPRESSIONS, opts),
        composeSystemPrompt(persona, EXPRESSIONS, opts).text
      );
    }
  }
});

console.log('\n8. Resolution precedence (DB-backed)...');

// Everything above is pure; this section is the one place AP-01 touches the
// database, and it is the part that decides WHOSE prompt a request gets.
const { closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { resolvePromptPreset } = require('../routes/chat');

try {
  const user = dal.createUser({ googleId: `preset-test-${Date.now()}`, email: 'preset@test.local' });
  const other = dal.createUser({ googleId: `preset-other-${Date.now()}`, email: 'other@test.local' });
  const userId = user.id;

  const mk = (name, text) =>
    dal.createPromptPreset(userId, {
      name,
      blocks: { ...defaultBlocks(), blocks: { ...defaultBlocks().blocks, orientation: { enabled: true, text } } },
    });

  const chatPreset = mk('chat', 'CHAT');
  const personaPreset = mk('persona', 'PERSONA');
  const defaultPreset = mk('default', 'DEFAULT');

  const persona = dal.createPersona(userId, {
    name: 'Vela',
    modelConfig: { presetId: personaPreset.id },
  });
  // Deliberately starts bare — the persona (which carries a preset of its own)
  // is attached partway through, so each level can be observed taking over.
  const conv = dal.createConversation(userId, { title: 'presets' });
  const row = () => dal.getConversationMeta(conv.id, userId);
  const orientationOf = (blocks) => (blocks ? normalizeBlocks(blocks).blocks.orientation.text : null);

  check('no pointers anywhere → built-in (null)', () => {
    assert.strictEqual(resolvePromptPreset(userId, row()), null);
  });

  check('the user default applies when nothing overrides it', () => {
    dal.upsertSettings(userId, { defaultPresetId: defaultPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'DEFAULT');
  });

  check("the persona's preset beats the user default", () => {
    dal.updateConversation(conv.id, userId, { personaId: persona.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
  });

  check("the conversation's preset beats the persona's", () => {
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'CHAT');
  });

  check('clearing the conversation override falls back to the persona', () => {
    dal.updateConversation(conv.id, userId, { presetId: null });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
  });

  check("another user's preset id resolves to the built-in, not their prompt", () => {
    const theirs = dal.createPromptPreset(other.id, { name: 'theirs', blocks: defaultBlocks() });
    assert.ok(dal.getPromptPreset(theirs.id, other.id), 'exists for its owner');
    assert.strictEqual(dal.getPromptPreset(theirs.id, userId), undefined, 'not readable cross-user');
    dal.updateConversation(conv.id, userId, { presetId: theirs.id });
    // Falls through the whole chain rather than leaking the other user's blocks.
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA');
    dal.updateConversation(conv.id, userId, { presetId: null });
  });

  check('PRESET_NONE on the chat forces the built-in over a persona preset', () => {
    // The persona still points at PERSONA here (set two checks above).
    dal.updateConversation(conv.id, userId, { presetId: PRESET_NONE });
    assert.strictEqual(resolvePromptPreset(userId, row()), null, 'built-in, not the persona preset');
    dal.updateConversation(conv.id, userId, { presetId: null });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'PERSONA', 'and it is reversible');
  });

  check('PRESET_NONE on the persona forces the built-in over the account default', () => {
    dal.updatePersona(persona.id, userId, { modelConfig: { presetId: PRESET_NONE } });
    assert.strictEqual(resolvePromptPreset(userId, row()), null);
    // A chat can still override upward — "none" only stops the walk BELOW it.
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(orientationOf(resolvePromptPreset(userId, row())), 'CHAT');
    dal.updateConversation(conv.id, userId, { presetId: null });
    dal.updatePersona(persona.id, userId, { modelConfig: { presetId: personaPreset.id } });
  });

  check('deleting a preset clears every pointer at it', () => {
    dal.updateConversation(conv.id, userId, { presetId: chatPreset.id });
    assert.strictEqual(dal.deletePromptPreset(chatPreset.id, userId), true);
    assert.strictEqual(row().preset_id, null, 'conversation pointer cleared');
    dal.deletePromptPreset(defaultPreset.id, userId);
    assert.strictEqual(dal.getSettingsByUser(userId).defaultPresetId, null, 'user default cleared');
  });

  check('an unreadable blocks column degrades to the built-in prompt', () => {
    const broken = dal.createPromptPreset(userId, { name: 'broken', blocks: defaultBlocks() });
    require('../db/connection').getDb()
      .prepare('UPDATE prompt_presets SET blocks = ? WHERE id = ?')
      .run('{not json', broken.id);
    const blocks = dal.getPromptPreset(broken.id, userId).blocks;
    assert.deepStrictEqual(blocks, {}, 'parse failure reads as no overrides');
    assert.strictEqual(
      buildSystemPrompt(PERSONA, [], { preset: blocks }),
      golden({ persona: true }),
      'and still composes the built-in prompt'
    );
  });
} catch (err) {
  console.log(`   ✗ resolution setup failed: ${err.message}`);
  failures++;
} finally {
  closeDb();
}

// --- SS-02: the session-state block is plumbing -----------------------------
console.log('\nSession-state block (SS-02)...');

check('state is a MESSAGE block, and never lands in the system order', () => {
  // PC-01 moved it out of the system layer. A preset stored while it WAS a
  // system block still carries it in `order`; that entry must be dropped, not
  // honoured, or the block goes back to invalidating the whole cached prefix.
  const n = normalizeBlocks({ order: ['state', 'orientation', 'expressions', 'scratchpad', 'persona'] });
  assert.ok(!n.order.includes('state'), 'a pre-PC-01 preset stops positioning it');
  assert.ok(!SYSTEM_BLOCK_IDS.includes('state'), 'not a system block');
  assert.ok(MESSAGE_BLOCK_IDS.includes('state'), 'a message-layer block');
  assert.ok(n.blocks.state, 'still described, so the editor can show it');
});

check('it cannot be turned off', () => {
  const res = validateBlocks({ blocks: { state: { enabled: false } } });
  assert.strictEqual(res.ok, false, 'the write path refuses it');
  assert.match(res.error, /cannot be turned off/);
});

check('it cannot be given text', () => {
  const res = validateBlocks({ blocks: { state: { text: 'my own state line' } } });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /cannot be edited/);
});

check('a stored order mentioning it is still accepted, just not obeyed', () => {
  // Rejecting it would make every pre-PC-01 preset unsaveable. It is dropped
  // by normalizeBlocks instead (checked above).
  const res = validateBlocks({ order: ['state', 'orientation', 'expressions', 'scratchpad', 'persona'] });
  assert.strictEqual(res.ok, true);
});

check('an already-stored enabled:false is ignored rather than obeyed', () => {
  // Defence in depth: validateBlocks guards the write path, but a preset
  // written before that guard (or hand-edited) must not silently blind the
  // model. The block is emitted regardless of what the preset says.
  const state = '<session_state>\nWorkspace: none\n</session_state>';
  assert.strictEqual(
    sessionStateBlock({ preset: { blocks: { state: { enabled: false } } }, sessionState: state }),
    state,
    'still emitted'
  );
});

check('absent session state emits nothing rather than an empty block', () => {
  assert.strictEqual(sessionStateBlock({ preset: {} }), '', 'nothing to report, nothing emitted');
  assert.strictEqual(describeSessionState({}).included, false);
  assert.strictEqual(describeSessionState({}).reason, 'no-session-state');
});

check('no preset can put it back in the system prompt', () => {
  // The whole point of PC-01: wherever a preset claims it goes, the system
  // prompt must not contain the session-state payload. Checked against a
  // hand-written order, which is the only way the id can still reach composeSystemPrompt.
  const state = '<session_state>\nWorkspace: none\n</session_state>';
  for (const order of [
    ['state', 'orientation', 'expressions', 'scratchpad', 'persona'],
    ['orientation', 'state', 'expressions', 'scratchpad', 'persona'],
    ['orientation', 'expressions', 'scratchpad', 'persona', 'state'],
  ]) {
    const text = buildSystemPrompt(PERSONA, [], { preset: { order }, sessionState: state });
    assert.ok(!text.includes(state) && !text.includes('Workspace: none'), `order ${order.join(',')} kept it out of system`);
  }
});

check('the system prompt is byte-identical across differing session state', () => {
  // The standing guard (docs/design/PROMPT_CACHING_DESIGN.md §4). If this fails,
  // caching is silently off: nothing errors, the bill is just higher.
  const base = { preset: {}, scratchpad: true };
  const a = buildSystemPrompt(PERSONA, ['happy'], {
    ...base,
    sessionState: '<session_state>\nScratchpad: 12 characters\nFiles: none\n</session_state>',
  });
  const b = buildSystemPrompt(PERSONA, ['happy'], {
    ...base,
    sessionState: '<session_state>\nScratchpad: 4,918 characters\nFiles: 3 in this conversation\n</session_state>',
  });
  assert.strictEqual(a, b, 'session state must not move a single byte of the system prompt');
});

check('state.position defaults to before, accepts after, and rejects invalid values (DF-03)', () => {
  assert.strictEqual(defaultBlocks().blocks.state.position, 'before');
  assert.strictEqual(resolveStatePosition({}), 'before');
  assert.strictEqual(resolveStatePosition({ preset: { blocks: { state: { position: 'after' } } } }), 'after');
  assert.strictEqual(normalizeBlocks({ blocks: { state: { position: 'bogus' } } }).blocks.state.position, 'before');
  assert.strictEqual(validateBlocks({ blocks: { state: { position: 'before' } } }).ok, true);
  assert.strictEqual(validateBlocks({ blocks: { state: { position: 'after' } } }).ok, true);
  assert.strictEqual(validateBlocks({ blocks: { state: { position: 'bogus' } } }).ok, false);
  assert.strictEqual(validateBlocks({ blocks: { orientation: { position: 'after' } } }).ok, false);
  assert.strictEqual(describeSessionState({ preset: { blocks: { state: { position: 'after' } } } }).position, 'after');
  const includedAfter = describeSessionState({
    preset: { blocks: { state: { position: 'after' } } },
    sessionState: '<session_state>\nWorkspace: none\n</session_state>',
  });
  assert.strictEqual(includedAfter.included, true);
  assert.strictEqual(includedAfter.position, 'after');
});

check('CAPABILITY_SECTIONS exposes all 4 server-managed sub-sections for the workbench UI', () => {
  assert.deepStrictEqual(
    CAPABILITY_SECTIONS.map(s => s.id),
    ['workspace', 'file_tools', 'scratchpad', 'expressions']
  );
  assert.ok(CAPABILITY_SECTIONS.every(s => s.title && s.condition && s.text));
});

console.log('\nCustom blocks + cross-layer persona (DF-04)...');

check('persona defaults to System layer and can move to Message layer cleanly', () => {
  assert.strictEqual(defaultBlocks().blocks.persona.layer, 'system');
  const preset = {
    order: ['orientation', 'capabilities'],
    messageOrder: ['persona', 'profile'],
    blocks: {
      persona: { enabled: true, text: null, layer: 'message' },
    },
  };
  assert.strictEqual(validateBlocks(preset).ok, true);
  const norm = normalizeBlocks(preset);
  assert.ok(!norm.order.includes('persona'), 'persona removed from System order');
  assert.ok(norm.messageOrder.includes('persona'), 'persona placed in Message order');

  const sys = composeSystemPrompt(PERSONA, [], { preset, macros: { personaName: 'Vela' } });
  assert.ok(!sys.text.includes('Vela'), 'persona absent from system prompt');
  assert.ok(!sys.blocks.some(b => b.id === 'persona'), 'no system provenance entry');

  const msg = composeMessageLeadingBlocks(PERSONA, { preset, macros: { personaName: 'Vela' } });
  const pEntry = msg.blocks.find(b => b.id === 'persona');
  assert.strictEqual(pEntry.included, true);
  assert.strictEqual(pEntry.layer, 'message');
  assert.ok(msg.texts[0].includes('# Persona: Vela') && msg.texts[0].includes(PERSONA));
});

check('custom blocks validate, expand macros (including {{expressions}}), and preserve declared order in every layer', () => {
  const preset = {
    order: ['orientation', 'custom_style', 'persona', 'capabilities'],
    messageOrder: ['custom_lore_1', 'profile', 'custom_lore_2', 'custom_tail_1', 'custom_tail_2'],
    blocks: {
      custom_style: { custom: true, name: 'Style rules', layer: 'system', enabled: true, text: 'Speak as {{char}}.' },
      custom_lore_1: { custom: true, name: 'Lore 1', layer: 'message', placement: 'cached', enabled: true, text: 'World: Solis. Moods: {{expressions}}.' },
      custom_lore_2: { custom: true, name: 'Lore 2', layer: 'message', placement: 'cached', enabled: true, text: 'Era: 3rd Age.' },
      custom_tail_1: { custom: true, name: 'Tail 1', layer: 'message', placement: 'tail', enabled: true, text: 'Stay terse, {{char}}.' },
      custom_tail_2: { custom: true, name: 'Tail 2', layer: 'message', placement: 'tail', enabled: true, text: 'Moods: {{expressions}}.' },
    },
  };
  assert.strictEqual(validateBlocks(preset).ok, true);

  const sys = composeSystemPrompt(PERSONA, EXPRESSIONS, { preset, macros: { personaName: 'Vela' } });
  assert.ok(sys.text.includes('Speak as Vela.'), 'custom system block expanded');
  assert.ok(sys.text.indexOf('Speak as Vela.') < sys.text.indexOf('<main_persona>'), 'custom block respects order');
  const styleProv = sys.blocks.find(b => b.id === 'custom_style');
  assert.strictEqual(styleProv.name, 'Style rules');
  assert.strictEqual(styleProv.source, 'preset');

  const leading = composeMessageLeadingBlocks(PERSONA, {
    preset,
    expressionNames: ['generating', ...EXPRESSIONS],
    macros: { personaName: 'Vela' },
  });
  assert.deepStrictEqual(leading.texts, ['World: Solis. Moods: neutral, happy, wry.', 'Era: 3rd Age.'], 'cached custom blocks preserve order and expand sanitized {{expressions}}');
  assert.ok(!leading.texts.join('\n').includes('Stay terse'), 'tail custom blocks stay out of leading context');

  const tail = composeMessageTailBlocks({
    preset,
    expressionNames: ['generating', ...EXPRESSIONS],
    macros: { personaName: 'Vela' },
  });
  assert.deepStrictEqual(tail.texts, ['Stay terse, Vela.', 'Moods: neutral, happy, wry.'], 'tail custom blocks preserve order and expand {{expressions}}');
  assert.strictEqual(tail.blocks[0].name, 'Tail 1');
});

check('custom block validation rejects missing/whitespace name, orphan order/messageOrder id, invalid layer/placement, excess count, and over-budget total', () => {
  assert.strictEqual(validateBlocks({ blocks: { custom_x: { name: '', text: 'hi' } } }).ok, false);
  assert.strictEqual(validateBlocks({ blocks: { custom_x: { name: '   ', text: 'hi' } } }).ok, false);
  assert.strictEqual(validateBlocks({ order: ['orientation', 'custom_missing'], blocks: {} }).ok, false);
  assert.strictEqual(validateBlocks({ messageOrder: ['custom_missing'], blocks: {} }).ok, false);
  assert.strictEqual(validateBlocks({ blocks: { custom_x: { name: 'X', layer: 'bogus', text: 'hi' } } }).ok, false);
  assert.strictEqual(validateBlocks({ blocks: { custom_x: { name: 'X', layer: 'message', placement: 'bogus', text: 'hi' } } }).ok, false);
  const tooMany = {};
  for (let i = 0; i < 17; i++) tooMany[`custom_b${i}`] = { name: `B${i}`, layer: 'system', text: 'x' };
  assert.strictEqual(validateBlocks({ blocks: tooMany }).ok, false);
  const overBudget = {};
  for (let i = 0; i < 5; i++) overBudget[`custom_big${i}`] = { name: `Big ${i}`, layer: 'system', text: 'x'.repeat(7000) };
  assert.strictEqual(validateBlocks({ blocks: overBudget }).ok, false, 'total preset chars cap enforced across custom blocks');
});

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All prompt preset tests passed!');
