/**
 * Expression tag parsing, streaming filtering, and stripping tests.
 *
 * Run with: node tests/expression-tags.test.js
 */

import assert from 'node:assert';
import {
    isPartialExpressionTag,
    findDeclaredExpression,
    stripExpressionTag,
    filterStreamingExpressionTags,
    splitLeadingExpressionTag,
} from '../js/util/expression-tags.js';

let failures = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`   ✓ ${label}`);
    } catch (err) {
        failures++;
        console.log(`   ✗ ${label}\n     ${err.message}`);
    }
}

const EXPRESSIONS = {
    neutral: { emoji: '😊' },
    happy: { emoji: '😄' },
    thinking: { emoji: '🤔' },
    excited: { emoji: '🎉' },
    'side-eye': { emoji: '😒' },
    generating: { emoji: '💭' },
};

console.log('Expression tags');

check('1. strips leading tag and leading whitespace/newlines', () => {
    assert.strictEqual(stripExpressionTag('[expression: happy]\nHi'), 'Hi');
    assert.strictEqual(stripExpressionTag('\n  [expression: happy]\n\nHi'), 'Hi');
    assert.deepStrictEqual(filterStreamingExpressionTags('\n  [expression: happy]\nHi'), {
        display: 'Hi',
        expression: 'happy',
        pending: false,
    });
});

check('2. supports hyphenated expression names on both detection and stripping', () => {
    assert.strictEqual(findDeclaredExpression('[expression: side-eye]\nReally?', EXPRESSIONS), 'side-eye');
    assert.strictEqual(stripExpressionTag('[expression: side-eye]\nReally?'), 'Really?');
    const streamed = filterStreamingExpressionTags('[expression: side-eye]\nReally?');
    assert.strictEqual(streamed.display, 'Really?');
    assert.strictEqual(streamed.expression, 'side-eye');
    assert.strictEqual(streamed.pending, false);
});

check('3. multi-round tool turns strip all tags and resolve to the last valid mood', () => {
    const raw = '[expression: thinking]\n\n[expression: excited]\nDone!';
    assert.strictEqual(findDeclaredExpression(raw, EXPRESSIONS), 'excited');
    assert.strictEqual(stripExpressionTag(raw), 'Done!');
    const streamed = filterStreamingExpressionTags(raw);
    assert.strictEqual(streamed.display, 'Done!');
    assert.strictEqual(streamed.expression, 'excited');
    assert.strictEqual(streamed.pending, false);
});

check('4. strips tags even when preceded by unexpected text or tool-round breaks', () => {
    const glitch = 'write_scratchpad[expression: excited]\nHi';
    assert.strictEqual(filterStreamingExpressionTags(glitch).display, 'write_scratchpadHi');
    assert.strictEqual(stripExpressionTag(glitch), 'write_scratchpadHi');

    const narration = 'Checking the notes.\n\n[expression: excited]\nHere is the update.';
    assert.strictEqual(
        filterStreamingExpressionTags(narration).display,
        'Checking the notes.\n\nHere is the update.'
    );
    assert.strictEqual(findDeclaredExpression(narration, EXPRESSIONS), 'excited');
});

check('5. buffers partial openers both at the start and after visible text without wiping prior text', () => {
    for (const partial of ['[', '[expr', '[expression:', '[expression: exc']) {
        const res = filterStreamingExpressionTags(partial);
        assert.strictEqual(res.display, '', `expected empty display for ${JSON.stringify(partial)}`);
        assert.strictEqual(res.pending, true, `expected pending for ${JSON.stringify(partial)}`);
    }

    const mid = filterStreamingExpressionTags('Working.\n\n[expression: exc');
    assert.strictEqual(mid.display, 'Working.\n\n');
    assert.strictEqual(mid.pending, true);
});

check('6. non-expression brackets flush immediately once they diverge', () => {
    assert.strictEqual(isPartialExpressionTag('[docs'), false);
    assert.strictEqual(isPartialExpressionTag('[1]'), false);
    assert.strictEqual(isPartialExpressionTag('[expression]'), false);

    const link = filterStreamingExpressionTags('See [docs](url) and [1]');
    assert.strictEqual(link.display, 'See [docs](url) and [1]');
    assert.strictEqual(link.pending, false);

    const closed = filterStreamingExpressionTags('[1]');
    assert.strictEqual(closed.display, '[1]');
    assert.strictEqual(closed.pending, false);
});

check('7. ignores reserved generating expression and falls back to earlier valid tag or null', () => {
    assert.strictEqual(findDeclaredExpression('[expression: generating]\nWait', EXPRESSIONS), null);
    assert.strictEqual(
        findDeclaredExpression('[expression: happy]\nFirst\n\n[expression: generating]\nSecond', EXPRESSIONS),
        'happy'
    );
    assert.strictEqual(findDeclaredExpression('[expression: unknown]\nHello', EXPRESSIONS), null);
});

check('8. preserves display offsets across tool boundaries', () => {
    const raw = 'Before.\n\n[expression: excited]\nAfter.';
    const rawOffset = 7; // right after 'Before.'
    const prefixDisplay = splitLeadingExpressionTag(raw.slice(0, rawOffset)).display;
    const fullDisplay = splitLeadingExpressionTag(raw).display;
    assert.strictEqual(prefixDisplay.length, 7);
    assert.strictEqual(fullDisplay.slice(prefixDisplay.length).trimStart(), 'After.');
});

check('9. strips copied <tool_trail> alongside expression tags in either order', () => {
    assert.strictEqual(
        stripExpressionTag('<tool_trail>write_scratchpad</tool_trail>\n[expression: happy]\nHello'),
        'Hello'
    );
    assert.strictEqual(
        stripExpressionTag('[expression: happy]\n<tool_trail>write_scratchpad</tool_trail>\nHello'),
        'Hello'
    );
    assert.strictEqual(
        filterStreamingExpressionTags('<tool_trail>write_scratchpad</tool_trail>\n[expression: happy]\nHello').display,
        'Hello'
    );
    assert.strictEqual(
        filterStreamingExpressionTags('[expression: happy]\n<tool_trail>write_scratchpad</tool_trail>\nHello').display,
        'Hello'
    );
});

if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
}
console.log('\nAll expression tag tests passed!');
