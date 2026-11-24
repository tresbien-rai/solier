/**
 * Aux-model expression picking tests (Option B).
 *
 * Pure unit tests covering request building (persona + clipped context +
 * sanitized expression list) and tolerant parsing of real aux-model responses.
 *
 * Run with: node src/prompts/test-expression.js
 */

const assert = require('node:assert');
const {
  EXPRESSION_SYSTEM_PROMPT,
  MAX_PERSONA_CHARS,
  MAX_CONTEXT_MESSAGES,
  buildExpressionRequest,
  parseExpressionReply,
} = require('./expression');

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

const VALID = ['neutral', 'happy', 'sad', 'excited', 'side-eye', 'generating'];

console.log('='.repeat(60));
console.log('Aux-model expression picking (Option B)');
console.log('='.repeat(60));

console.log('\n1. Parsing aux replies...');

check('accepts a clean single-word reply (case-insensitive)', () => {
  assert.strictEqual(parseExpressionReply('excited', VALID), 'excited');
  assert.strictEqual(parseExpressionReply('EXCITED', VALID), 'excited');
  assert.strictEqual(parseExpressionReply('  Happy  ', VALID), 'happy');
});

check('accepts hyphenated expression names', () => {
  assert.strictEqual(parseExpressionReply('side-eye', VALID), 'side-eye');
  assert.strictEqual(parseExpressionReply('**side-eye**', VALID), 'side-eye');
});

check('strips quotes, markdown, labels, brackets, and trailing punctuation', () => {
  assert.strictEqual(parseExpressionReply('"excited"', VALID), 'excited');
  assert.strictEqual(parseExpressionReply('`happy`.', VALID), 'happy');
  assert.strictEqual(parseExpressionReply('Expression: sad!', VALID), 'sad');
  assert.strictEqual(parseExpressionReply('[expression: excited]', VALID), 'excited');
  assert.strictEqual(parseExpressionReply('[neutral]', VALID), 'neutral');
  assert.strictEqual(parseExpressionReply('Sure:\nexcited', VALID), 'excited');
});

check('handles chatty sentences when exactly one valid expression appears', () => {
  assert.strictEqual(parseExpressionReply('I would pick side-eye for this reply.', VALID), 'side-eye');
  assert.strictEqual(parseExpressionReply('The tone feels excited!', VALID), 'excited');
});

check('rejects ambiguous multi-expression sentences and substring traps', () => {
  assert.strictEqual(parseExpressionReply('Either happy or excited works.', VALID), null);
  assert.strictEqual(parseExpressionReply('Not sadly, just thoughtful.', VALID), null);
});

check('rejects unknown, empty, or reserved (generating) expressions', () => {
  for (const bad of ['', '   ', null, undefined, 'furious', 'generating', '[expression: generating]']) {
    assert.strictEqual(parseExpressionReply(bad, VALID), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

console.log('\n2. Building the request...');

check('sends a single user turn with persona, clipped conversation, and sanitized list', () => {
  const longPersona = 'p'.repeat(MAX_PERSONA_CHARS + 500);
  const messages = [
    { role: 'user', content: 'Turn 1 user' },
    { role: 'assistant', content: 'Turn 1 reply' },
    { role: 'user', content: 'Turn 2 user' },
    { role: 'assistant', content: 'Turn 2 reply' },
    { role: 'user', content: 'Turn 3 user' },
    { role: 'assistant', content: 'Turn 3 reply' },
  ];
  const req = buildExpressionRequest({
    personaName: 'Vela',
    personaPrompt: longPersona,
    expressionNames: VALID,
    recentMessages: messages,
  });

  assert.strictEqual(req.system, EXPRESSION_SYSTEM_PROMPT);
  assert.strictEqual(req.messages.length, 1);
  assert.strictEqual(req.messages[0].role, 'user');

  const body = req.messages[0].content;
  assert.ok(body.includes('Persona: Vela'));
  assert.ok(body.includes('<persona>'));
  assert.ok(!body.includes('p'.repeat(MAX_PERSONA_CHARS + 50)), 'persona prompt clipped');
  assert.ok(!body.includes('Turn 1 user'), `only last ${MAX_CONTEXT_MESSAGES} messages kept`);
  assert.ok(body.includes('Turn 2 user') && body.includes('Vela: Turn 3 reply'));
  assert.ok(body.includes('Available expressions: neutral, happy, sad, excited, side-eye'));
  assert.ok(!body.includes('generating'), 'reserved expression excluded from list');
});

check('omits <persona> block when persona prompt is empty', () => {
  const req = buildExpressionRequest({
    personaName: 'Assistant',
    personaPrompt: '',
    expressionNames: ['neutral', 'happy'],
    recentMessages: [{ role: 'assistant', content: 'Hello!' }],
  });
  assert.ok(!req.messages[0].content.includes('<persona>'));
  assert.ok(req.messages[0].content.includes('Available expressions: neutral, happy'));
});

console.log('\n' + '='.repeat(60));
if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All aux-expression tests passed!');
console.log('='.repeat(60));
