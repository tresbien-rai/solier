/**
 * Profile prompt block test (UP-03, docs/design/PROFILE_DESIGN.md tier 1)
 *
 * Covers the three things that can go wrong once the profile reaches the model:
 *   1. Rendering — disabled sections must not leak, order must be the user's.
 *   2. Gating — the block has TWO distinct silences (no profile / persona
 *      opted out) and they must stay distinguishable, because they are the two
 *      answers to "why is my profile not in the prompt".
 *   3. Caching — the block sits in the system prompt, so it must be
 *      byte-identical between requests that differ only in volatile state.
 *
 * Run with: node src/prompts/test-profileblock.js
 */

const assert = require('node:assert');
const { renderProfile, resolveUserName, hasProfileData } = require('./profile');
const {
  composeSystemPrompt, buildSystemPrompt,
  buildProfileMessageBlock, describeProfileMessageBlock,
  PROFILE_SECTION,
} = require('./tessera');
const { normalizeProfile } = require('../utils/userProfile');

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

/** The block entry for `profile` in its default Message layer. */
function msgProfileBlock(options) {
  return describeProfileMessageBlock(options);
}

/** The block entry for `profile` when a preset moves it into the System layer. */
function sysProfileBlock(options) {
  return composeSystemPrompt('PERSONA', [], options).blocks.find((b) => b.id === 'profile');
}

const FULL = normalizeProfile({
  preferredName: 'Jack',
  sections: [
    { id: 'a', title: 'About me', body: 'I build things badly.', enabled: true },
    { id: 'b', title: 'Secret', body: 'Never send this.', enabled: false },
    { id: 'c', title: 'Work', body: 'Tessera.', enabled: true },
  ],
});

console.log('='.repeat(60));
console.log('Profile Prompt Block Test (UP-03)');
console.log('='.repeat(60));

console.log('\n1. renderProfile...');

check('an empty profile renders nothing at all', () => {
  assert.strictEqual(renderProfile(null), '');
  assert.strictEqual(renderProfile(normalizeProfile(null)), '');
  assert.strictEqual(renderProfile(normalizeProfile({ sections: [] })), '');
});

check('a disabled section never reaches the text', () => {
  const out = renderProfile(FULL);
  assert.ok(!out.includes('Secret'), 'title leaked');
  assert.ok(!out.includes('Never send this'), 'body leaked');
});

check('enabled sections render with their titles, in the user order', () => {
  const out = renderProfile(FULL);
  assert.ok(out.includes('### About me'));
  assert.ok(out.includes('### Work'));
  assert.ok(out.indexOf('About me') < out.indexOf('Work'), 'order is the user\'s');
});

check('renderProfile does not duplicate preferredName (it lives in # User: {{user}})', () => {
  const out = renderProfile(FULL);
  assert.ok(!out.includes('They go by'), 'redundant intro line removed in DF-02');
});

check('a titled section with no body still renders — naming a topic is information', () => {
  const p = normalizeProfile({ sections: [{ id: 'x', title: 'Health', body: '' }] });
  assert.ok(renderProfile(p).includes('Health'));
});

check('a section with neither title nor body is dropped', () => {
  const p = normalizeProfile({ sections: [{ id: 'x', title: '', body: '' }] });
  assert.strictEqual(renderProfile(p), '');
});

check('a name-only profile hasProfileData=true and renders cleanly in <user_profile>', () => {
  const p = normalizeProfile({ preferredName: 'Jack', sections: [] });
  assert.strictEqual(hasProfileData(p), true);
  assert.strictEqual(hasProfileData(normalizeProfile(null)), false);
  const block = msgProfileBlock({
    profileEnabled: true,
    hasProfile: hasProfileData(p),
    macros: { userName: resolveUserName(p, ''), profileText: renderProfile(p) },
  });
  assert.strictEqual(block.included, true);
  assert.ok(block.text.includes('# User: Jack'), 'preferred name shown in header');
  assert.ok(!block.text.includes('\n\n</user_profile>'), 'no trailing blank lines before closer');
});

console.log('\n2. resolveUserName...');

check('the preferred name wins over the account name', () => {
  assert.strictEqual(resolveUserName(FULL, 'Jonathan Smith'), 'Jack');
});

check('the account name is the fallback', () => {
  assert.strictEqual(resolveUserName(normalizeProfile(null), 'Jonathan Smith'), 'Jonathan Smith');
});

check('no profile and no account name is empty, never undefined', () => {
  assert.strictEqual(resolveUserName(null, undefined), '');
});

console.log('\n3. gating (Message layer by default, movable to System by preset)...');

check('included in Message layer by default when enabled and non-empty', () => {
  const opts = {
    profileEnabled: true,
    hasProfile: hasProfileData(FULL),
    macros: { userName: resolveUserName(FULL, ''), profileText: renderProfile(FULL) },
  };
  const block = msgProfileBlock(opts);
  assert.strictEqual(block.included, true);
  assert.strictEqual(block.layer, 'message');
  assert.ok(block.text.startsWith('<user_profile>\n# User: Jack'), 'XML + user header');
  assert.ok(block.text.includes('About me'));
  assert.ok(block.text.includes('background context you already know'), 'framing present');
  assert.strictEqual(sysProfileBlock(opts), undefined, 'not in system prompt by default');
});

check('persona opted out => profile-off, and NOTHING of the profile is emitted', () => {
  const opts = {
    profileEnabled: false,
    hasProfile: hasProfileData(FULL),
    macros: { userName: 'Jack', profileText: renderProfile(FULL) },
  };
  const msgText = buildProfileMessageBlock(opts);
  const sysText = buildSystemPrompt('PERSONA', [], opts);
  assert.strictEqual(msgText, '', 'message block empty');
  assert.ok(!sysText.includes('Jack') && !sysText.includes('About me'), 'nothing leaked to system');
  const block = msgProfileBlock(opts);
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'profile-off');
});

check('enabled but empty => no-profile, a DIFFERENT reason', () => {
  const block = msgProfileBlock({ profileEnabled: true, hasProfile: false, macros: { profileText: '' } });
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'no-profile');
});

check('the two silences stay distinguishable', () => {
  // They are the two answers to "why is my profile not in the prompt". Collapse
  // them into one code and the inspector can only shrug.
  const off = msgProfileBlock({ profileEnabled: false, macros: { profileText: renderProfile(FULL) } });
  const none = msgProfileBlock({ profileEnabled: true, hasProfile: false, macros: { profileText: '' } });
  assert.notStrictEqual(off.reason, none.reason);
});

check('a preset may disable the block outright', () => {
  const preset = { blocks: { profile: { enabled: false, text: null } } };
  const block = msgProfileBlock({ profileEnabled: true, preset, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.included, false);
  assert.strictEqual(block.reason, 'disabled');
});

check('a preset may reword the framing but not the content', () => {
  const preset = {
    blocks: { profile: { enabled: true, text: 'WHO:\n{{profile}}' } },
  };
  const block = msgProfileBlock({ profileEnabled: true, preset, macros: { profileText: renderProfile(FULL) } });
  assert.strictEqual(block.source, 'preset');
  assert.ok(block.text.startsWith('WHO:'), 'framing reworded');
  assert.ok(block.text.includes('### About me'), 'content unchanged');
  assert.ok(!block.text.includes('Secret'), 'a preset cannot resurrect a disabled section');
});

check('a preset may move profile into the System layer', () => {
  const preset = {
    order: ['orientation', 'profile', 'persona', 'capabilities'],
    blocks: { profile: { enabled: true, text: null, layer: 'system' } },
  };
  const opts = {
    profileEnabled: true,
    hasProfile: true,
    preset,
    macros: { userName: 'Jack', profileText: renderProfile(FULL) },
  };
  const sys = sysProfileBlock(opts);
  assert.strictEqual(sys.included, true);
  assert.strictEqual(sys.layer, 'system');
  assert.ok(sys.text.includes('# User: Jack'));
  assert.strictEqual(msgProfileBlock(opts), null, 'not duplicated in Message layer');
  assert.strictEqual(buildProfileMessageBlock(opts), '');
});

console.log('\n4. position + caching...');

check('built-in System order puts orientation then persona (profile lives in Message)', () => {
  const ids = composeSystemPrompt('PERSONA', ['happy'], {
    profileEnabled: true,
    macros: { userName: 'Jack', profileText: renderProfile(FULL) },
  }).blocks.filter((b) => b.included).map((b) => b.id);
  assert.deepStrictEqual(ids, ['orientation', 'persona', 'capabilities']);
});

check('the profile block is byte-identical across differing session state', () => {
  // Whether in Message or System, it lives in the cached prefix, so any per-turn
  // variation in it would rewrite the cached prefix (PROMPT_CACHING_DESIGN.md).
  const opts = (sessionState) => ({
    profileEnabled: true,
    hasProfile: true,
    sessionState,
    macros: { userName: 'Jack', profileText: renderProfile(FULL) },
  });
  const a = buildProfileMessageBlock(opts('<session_state>files: 0</session_state>'));
  const b = buildProfileMessageBlock(opts('<session_state>files: 12</session_state>'));
  assert.strictEqual(a, b);
});

check('the built-in framing tells the model not to recite it (and omits "trust the conversation")', () => {
  // The behaviour this guards is real: given a block of facts about someone,
  // models tend to perform having read it. If this wording is ever dropped,
  // this test should fail loudly rather than the app quietly getting weird.
  assert.ok(/not recited back/i.test(PROFILE_SECTION));
  assert.ok(!/trust the conversation/i.test(PROFILE_SECTION), 'intentionally omitted for persona memory (DF-02)');
});

console.log('\n' + '='.repeat(60));
console.log(failures === 0 ? 'All profile block tests passed!' : `${failures} assertion(s) FAILED`);
console.log('='.repeat(60) + '\n');
process.exit(failures === 0 ? 0 : 1);
