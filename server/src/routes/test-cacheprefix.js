/**
 * Cache-prefix stability test (PC-01, docs/design/PROMPT_CACHING_DESIGN.md §4)
 *
 * Prompt caching is a prefix match: the provider serves the leading bytes of a
 * request from cache only when they are IDENTICAL to the bytes it cached last
 * time. Everything after the first changed byte is re-processed at full price.
 *
 * Which makes this the rare feature whose failure is completely silent. Nothing
 * throws, no response changes, no log line appears — the bill is just higher.
 * And the shape it fails in is a regression months later, not a bad first
 * implementation: someone adds a field to the system prompt, or a helper starts
 * rewriting history, and the cache quietly stops being read.
 *
 * So this asserts on BYTES, through the real assembly, not on shape through a
 * reimplementation. Two lessons from the 2026-07-31 handoff are behind that:
 * a fixture modelling the wrong wire shape cannot detect a wire-shape error
 * (#170, #171), and a test that re-derives its expectation from the code under
 * test agrees with itself while the feature is broken.
 *
 * The two guarantees:
 *
 *   1. `system` does not move a byte when session state changes. It carries the
 *      scratchpad's length and the file counts, which the model changes by
 *      doing its job — and a system change invalidates the message cache behind
 *      it, so this one failing costs the WHOLE conversation, every turn.
 *
 *   2. The message prefix ahead of the newest turn is reproduced exactly on the
 *      next turn. That prefix is what a breakpoint can actually read back
 *      (§2.2): each user message is augmented on its own turn only, and is bare
 *      forever after.
 *
 * Runs against the app DB and cleans up after itself.
 *
 * Run with: node src/routes/test-cacheprefix.js
 */

const assert = require('node:assert');
const { closeDb } = require('../db/connection');
const dal = require('../db/dal');
const { assembleChatRequest, resolveRequestContainers } = require('./chat');

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

const reqFor = (userId, body) => ({ user: { userId }, body });

/** Render the assembled messages the way a provider would see them, as bytes. */
function renderMessages(messages) {
  return messages.map((m) => {
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content);
    return `${m.role} ${content}`;
  });
}

(async () => {
  console.log('='.repeat(60));
  console.log('Cache-prefix stability (PC-01)');
  console.log('='.repeat(60));

  let userId;
  try {
    const user = dal.createUser({ googleId: `pc1-${Date.now()}`, email: 'pc1@test.local' });
    userId = user.id;
    const persona = dal.createPersona(userId, {
      name: 'Vela',
      systemPrompt: 'You are Vela, a terse navigator.',
    });
    const conversation = dal.createConversation(userId, {
      personaId: persona.id,
      title: 'cache prefix',
    });
    // Scratchpad on, so session state has something that actually churns.
    dal.updateConversation(conversation.id, userId, { scratchpadEnabled: true });
    dal.ensureScratchpad(conversation.id);

    const assemble = async (messages) => {
      const body = { conversationId: conversation.id, messages };
      const req = reqFor(userId, body);
      return assembleChatRequest(req, resolveRequestContainers(req), {
        systemPrompt: 'You are Vela, a terse navigator.',
        messages,
        expressionNames: ['neutral', 'happy'],
        model: 'claude-opus-5',
      });
    };

    // --- Guarantee 1: session state must not touch the system prompt --------
    console.log('\nThe system prompt is frozen against session state...');

    const turn1 = [{ role: 'user', content: 'Plot a course.' }];

    dal.updateScratchpadContent(conversation.id, '');
    const empty = await assemble(turn1);

    dal.updateScratchpadContent(conversation.id, 'x'.repeat(4918));
    const full = await assemble(turn1);

    check('a 4,918-character scratchpad moves no byte of `system`', () => {
      assert.strictEqual(empty.system, full.system);
    });

    check('and session state is genuinely different between the two', () => {
      // Guards the guard: if state stopped varying, guarantee 1 would pass
      // vacuously and this test would be worthless.
      assert.notStrictEqual(
        empty.promptOptions.sessionState,
        full.promptOptions.sessionState,
        'the two assemblies must actually differ in state'
      );
    });

    check('`<session_state>` is in the messages, exactly once, not in `system`', () => {
      assert.ok(
        !String(full.system).includes(full.promptOptions.sessionState)
          && !String(full.system).includes('<session_state>\n'),
        'state block absent from system'
      );
      const rendered = renderMessages(full.messages).join('\n');
      const hits = rendered.split('<session_state>').length - 1;
      assert.strictEqual(hits, 1, `expected one state block in messages, found ${hits}`);
    });

    check('it rides on the LAST user message, not a turn of its own', () => {
      const last = full.messages[full.messages.length - 1];
      assert.strictEqual(last.role, 'user');
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      assert.ok(content.includes('<session_state>'));
    });

    check('`<current_context>` wraps `<session_state>` before `<scratchpad>` AND precedes the user text', () => {
      const last = full.messages[full.messages.length - 1];
      const content = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
      const openIdx = content.indexOf('<current_context>');
      const stateIdx = content.indexOf('<session_state>');
      const padIdx = content.indexOf('<scratchpad>');
      const closeIdx = content.indexOf('</current_context>');
      const msgIdx = content.indexOf('Plot a course.');
      assert.ok(openIdx !== -1 && closeIdx !== -1, '<current_context> wrapper present');
      assert.ok(stateIdx !== -1 && padIdx !== -1, 'both inner blocks present');
      assert.ok(openIdx < stateIdx && stateIdx < padIdx && padIdx < closeIdx && closeIdx < msgIdx,
        `expected <current_context> < <session_state> < <scratchpad> < </current_context> < user message`);
    });

    const mmTurn = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', data: 'abc' } },
        { type: 'text', text: 'What is in this chart?' },
      ],
    }];
    const mm = await assemble(mmTurn);
    check('`<current_context>` prepends cleanly ahead of multimodal array content', () => {
      const last = mm.messages[mm.messages.length - 1];
      assert.ok(Array.isArray(last.content), 'array shape preserved');
      assert.strictEqual(last.content[0].type, 'text');
      assert.ok(last.content[0].text.startsWith('<current_context>'), 'prepended as first block');
      assert.strictEqual(last.content[1].type, 'image', 'image preserved after context');
      assert.strictEqual(last.content[2].text, 'What is in this chart?', 'user caption preserved last');
    });

    // --- Guarantee 2: the history ahead of the newest turn is reproduced ----
    console.log('\nThe message prefix survives into the next turn...');

    const turn2 = [
      { role: 'user', content: 'Plot a course.' },
      { role: 'assistant', content: 'Heading 041, mark.' },
      { role: 'user', content: 'Now hold it.' },
    ];

    // The model wrote to the pad during turn 1 — the realistic case, and the
    // one that used to invalidate everything.
    dal.updateScratchpadContent(conversation.id, 'course: 041\nspeed: 12kn');
    const second = await assemble(turn2);

    check('every message before the newest turn is byte-identical', () => {
      const before = renderMessages(full.messages);
      const after = renderMessages(second.messages);
      // Turn 1's own trailing user message is the volatile tail; the cacheable
      // prefix is everything ahead of it. On turn 2 that same region must
      // reappear unchanged.
      const shared = before.length - 1;
      assert.deepStrictEqual(
        after.slice(0, shared),
        before.slice(0, shared),
        'the reusable prefix was rewritten'
      );
    });

    check('the newest turn is where the divergence starts, and nowhere earlier', () => {
      const before = renderMessages(full.messages);
      const after = renderMessages(second.messages);
      let i = 0;
      while (i < before.length && i < after.length && before[i] === after[i]) i++;
      assert.strictEqual(
        i,
        before.length - 1,
        `divergence at index ${i}, expected ${before.length - 1} (the augmented last user turn)`
      );
    });

    check('`system` is unchanged across the two turns as well', () => {
      assert.strictEqual(second.system, full.system);
    });

    // --- Guarantee 3: auxExpressions omits expressions cleanly & keeps cache -
    dal.upsertApiKey(userId, 'anthropic', 'test-encrypted-key');
    dal.upsertSettings(userId, {
      auxModel: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      auxExpressions: true,
    });
    const auxTurn1 = await assemble(turn1);
    const auxTurn2 = await assemble(turn2);

    check('auxExpressions omits ## Avatar Expressions from `system` and stays byte-identical across turns', () => {
      assert.ok(!String(auxTurn1.system).includes('## Avatar Expressions'), 'expression instructions removed');
      assert.strictEqual(auxTurn1.system, auxTurn2.system, 'system unchanged across turns');
    });

    // --- Guarantee 4: User profile in Message layer stays cached across turns -
    console.log('\nMessage-layer profile + bare-chat omission (DF-02)...');
    dal.upsertUserProfile(userId, {
      preferredName: 'Rai',
      sections: [{ id: 's1', title: 'Role', body: 'Navigator.', enabled: true }],
    });
    const profTurn1 = await assemble(turn1);
    const profTurn2 = await assemble(turn2);

    check('Message-layer `<user_profile>` + `Reference context noted.` sits in cached prefix and is byte-identical across turns', () => {
      assert.ok(!String(profTurn1.system).includes('<user_profile>'), 'profile is not in system by default');
      assert.strictEqual(profTurn1.messages[0].role, 'user');
      assert.ok(profTurn1.messages[0].content.includes('<user_profile>'), 'profile leads message layer');
      assert.ok(profTurn1.messages[0].content.includes('# User: Rai'), 'user name in header');
      assert.strictEqual(profTurn1.messages[1].role, 'assistant');
      assert.strictEqual(profTurn1.messages[1].content, 'Reference context noted.');
      assert.deepStrictEqual(
        renderMessages(profTurn1.messages).slice(0, 2),
        renderMessages(profTurn2.messages).slice(0, 2),
        'leading profile + ack pair is byte-identical across turns'
      );
    });

    // Bare chat (unfiled, tools off, scratchpad off, 0 chat files): no <current_context>
    const bareConvo = dal.createConversation(userId, { personaId: persona.id, title: 'bare' });
    dal.updateConversation(bareConvo.id, userId, { scratchpadEnabled: false, toolsEnabled: false });
    const bareReq = reqFor(userId, { conversationId: bareConvo.id, messages: turn1 });
    const bareRes = await assembleChatRequest(bareReq, resolveRequestContainers(bareReq), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn1,
      expressionNames: [],
      model: 'claude-opus-5',
    });

    check('bare chat omits `<current_context>` and `<session_state>` completely', () => {
      const last = bareRes.messages[bareRes.messages.length - 1];
      assert.strictEqual(last.content, 'Plot a course.', 'user message left completely bare');
      assert.ok(!renderMessages(bareRes.messages).join('\n').includes('<current_context>'));
      assert.ok(!renderMessages(bareRes.messages).join('\n').includes('<session_state>'));
      assert.strictEqual(bareRes.promptOptions.bareChat, true);
    });

    // Unfiled + tools off + scratchpad off + >=1 chat file => <current_context> emitted, zero file tools in system
    dal.addConversationFile(bareConvo.id, { filename: 'notes.txt', driveFileId: 'mock-drive-id', sizeBytes: 42 });
    const withFileReq = reqFor(userId, { conversationId: bareConvo.id, messages: turn1 });
    const withFileRes = await assembleChatRequest(withFileReq, resolveRequestContainers(withFileReq), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn1,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    check('chat with uploaded file (tools off, scratchpad off, unfiled) emits `<current_context>` without advertising file tools', () => {
      const last = withFileRes.messages[withFileRes.messages.length - 1];
      assert.ok(String(last.content).includes('<current_context>'), 'context emitted because conversation has files');
      assert.ok(String(last.content).includes('<session_state>'));
      assert.ok(!String(withFileRes.system).includes('## File Tools'), 'no File Tools section when tools off');
      assert.ok(!String(withFileRes.system).includes('read_file'), 'no file tool names advertised');
    });

    // Preset moving `profile` into System layer: appears in `system`, not duplicated in messages[0], no stray ack
    const sysProfPreset = dal.createPromptPreset(userId, {
      name: 'profile-in-system',
      blocks: {
        order: ['orientation', 'profile', 'persona', 'capabilities'],
        blocks: { profile: { enabled: true, text: null, layer: 'system' } },
      },
    });
    dal.updateConversation(bareConvo.id, userId, { presetId: sysProfPreset.id });
    const sysProfReq = reqFor(userId, { conversationId: bareConvo.id, messages: turn1 });
    const sysProfRes = await assembleChatRequest(sysProfReq, resolveRequestContainers(sysProfReq), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn1,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    check('preset moving `profile` to System emits it in `system`, avoids duplicating in messages, and omits stray ack', () => {
      assert.ok(String(sysProfRes.system).includes('<user_profile>'), 'profile present in system');
      assert.ok(String(sysProfRes.system).includes('# User: Rai'));
      assert.strictEqual(sysProfRes.messages.length, 1, 'no synthetic leading context turn or stray ack');
      assert.ok(!String(sysProfRes.messages[0].content).includes('<user_profile>'), 'not duplicated in messages');
    });

    // Preset placing <current_context> AFTER latest user message (DF-03)
    const afterPreset = dal.createPromptPreset(userId, {
      name: 'context-after-user',
      blocks: {
        blocks: { state: { position: 'after' } },
      },
    });
    dal.updateConversation(bareConvo.id, userId, { presetId: afterPreset.id });
    const afterReq = reqFor(userId, { conversationId: bareConvo.id, messages: turn1 });
    const afterRes = await assembleChatRequest(afterReq, resolveRequestContainers(afterReq), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn1,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    const afterReq2 = reqFor(userId, { conversationId: bareConvo.id, messages: turn2 });
    const afterRes2 = await assembleChatRequest(afterReq2, resolveRequestContainers(afterReq2), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn2,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    check('preset with state.position="after" appends `<current_context>` after user text while keeping prefix stable', () => {
      const last = afterRes.messages[afterRes.messages.length - 1];
      const text = String(last.content);
      const msgIdx = text.indexOf('Plot a course.');
      const ctxIdx = text.indexOf('<current_context>');
      assert.ok(msgIdx !== -1 && ctxIdx !== -1 && msgIdx < ctxIdx, 'user text precedes <current_context>');
      assert.strictEqual(afterRes.system, withFileRes.system, 'system prompt unchanged by state.position');
      assert.strictEqual(afterRes2.system, afterRes.system, 'system prompt unchanged across turns');
      const before = renderMessages(afterRes.messages);
      const after = renderMessages(afterRes2.messages);
      assert.deepStrictEqual(
        after.slice(0, before.length - 1),
        before.slice(0, before.length - 1),
        'cached message prefix ahead of volatile turn stays byte-identical'
      );
    });

    // Cross-layer persona + custom cached & tail blocks keep prefix byte-identical (DF-04)
    const customPreset = dal.createPromptPreset(userId, {
      name: 'custom-and-msg-persona',
      blocks: {
        order: ['orientation', 'custom_sys', 'capabilities'],
        messageOrder: ['persona', 'profile', 'custom_cached', 'custom_tail'],
        blocks: {
          persona: { enabled: true, text: null, layer: 'message' },
          custom_sys: { custom: true, name: 'Sys rule', layer: 'system', enabled: true, text: 'SYS_CUSTOM_RULE' },
          custom_cached: { custom: true, name: 'World lore', layer: 'message', placement: 'cached', enabled: true, text: 'CACHED_LORE_ENTRY' },
          custom_tail: { custom: true, name: 'Turn nudge', layer: 'message', placement: 'tail', enabled: true, text: 'TAIL_TURN_NUDGE' },
        },
      },
    });
    dal.updateConversation(bareConvo.id, userId, { presetId: customPreset.id });
    const cReq1 = reqFor(userId, { conversationId: bareConvo.id, messages: turn1 });
    const cRes1 = await assembleChatRequest(cReq1, resolveRequestContainers(cReq1), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn1,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    const cReq2 = reqFor(userId, { conversationId: bareConvo.id, messages: turn2 });
    const cRes2 = await assembleChatRequest(cReq2, resolveRequestContainers(cReq2), {
      systemPrompt: 'You are Vela, a terse navigator.',
      messages: turn2,
      expressionNames: [],
      model: 'claude-opus-5',
    });
    check('Message-layer persona + custom cached/tail blocks assemble cleanly and keep cached prefix byte-identical', () => {
      assert.ok(String(cRes1.system).includes('SYS_CUSTOM_RULE'), 'custom system block in system');
      assert.ok(!String(cRes1.system).includes('<main_persona>'), 'persona moved out of system');
      assert.ok(!String(cRes1.system).includes('TAIL_TURN_NUDGE'), 'tail block never leaks into system');
      assert.ok(String(cRes1.messages[0].content).includes('<main_persona>'), 'persona in leading cached turn');
      assert.ok(String(cRes1.messages[0].content).includes('CACHED_LORE_ENTRY'), 'custom cached block in leading turn');
      assert.ok(!String(cRes1.messages[0].content).includes('TAIL_TURN_NUDGE'), 'tail block never leaks into cached prefix');
      assert.strictEqual(cRes1.messages[1].content, 'Reference context noted.');
      assert.ok(String(cRes1.messages[cRes1.messages.length - 1].content).includes('TAIL_TURN_NUDGE'), 'tail block on latest user turn');
      assert.strictEqual(cRes1.system, cRes2.system, 'system unchanged across turns');
      assert.deepStrictEqual(
        renderMessages(cRes2.messages).slice(0, renderMessages(cRes1.messages).length - 1),
        renderMessages(cRes1.messages).slice(0, -1),
        'leading prefix with Message-layer persona & custom cached block stays byte-identical'
      );
    });

  } catch (err) {
    console.log(`   ✗ setup failed: ${err.message}`);
    console.log(err.stack);
    failures++;
  } finally {
    if (userId) {
      try { dal.deleteUser(userId); } catch { /* best effort */ }
    }
    closeDb();
  }

  console.log('\n' + '='.repeat(60));
  if (failures > 0) {
    console.log(`${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log('All cache-prefix tests passed!');
  console.log('='.repeat(60));
})();
