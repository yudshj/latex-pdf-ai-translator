import assert from 'node:assert/strict'
import test from 'node:test'
import { isPredominantlyChinese, makeTranslationInstruction, normalizePdfSelection, RepeatedShortcutTracker } from '../text.js'

test('normalizes PDF line wrapping and simple hyphenation', () => {
    assert.equal(normalizePdfSelection('A trans-\nlation line.\nStill here.\n\nNext.'), 'A translation line. Still here.\n\nNext.')
})

test('chooses the reverse language for Chinese source text', () => {
    assert.equal(isPredominantlyChinese('这是中文 text'), true)
    assert.match(makeTranslationInstruction('这是中文。', 'Simplified Chinese', 'English'), /into English/)
    assert.match(makeTranslationInstruction('This is English.', 'Simplified Chinese', 'English'), /into Simplified Chinese/)
})

test('asks the model to interpret LaTeX and return Markdown', () => {
    const instruction = makeTranslationInstruction(String.raw`A \emph{result}.`, 'Simplified Chinese', 'English', 'latex')
    assert.match(instruction, /visible prose/)
    assert.match(instruction, /Return only rendered Markdown/)
    assert.match(instruction, /blank-line-separated source paragraph/)
    assert.match(instruction, /separate Markdown paragraph/)
    assert.match(instruction, /Never merge adjacent source paragraphs/)
    assert.match(instruction, /displayed algorithms as separate Markdown blocks/)
    assert.match(instruction, /\\emph/)
})

test('preserves paragraph boundaries for plain-text translation', () => {
    const instruction = makeTranslationInstruction('First.\n\nSecond.', 'Simplified Chinese', 'English')
    assert.match(instruction, /blank-line-separated source paragraph/)
    assert.match(instruction, /separate Markdown paragraph/)
    assert.match(instruction, /Never merge adjacent source paragraphs/)
})

test('marks abstract and CCS concepts as reference-only metadata outside the translation source', () => {
    const instruction = makeTranslationInstruction('Translate this selection only.', 'Simplified Chinese', 'English', 'plain', {
        abstract: 'This abstract must not be translated.',
        ccsConcepts: ['Information systems › Web applications'],
    })
    const source = instruction.match(/<translation_source[^>]*>\n([\s\S]*?)\n<\/translation_source>/u)?.[1]

    assert.equal(source, 'Translate this selection only.')
    assert.match(instruction, /reference-only metadata, not translation source/i)
    assert.match(instruction, /Never translate, summarize, paraphrase, quote, enumerate, or mention the abstract or CCS concepts/i)
    assert.ok(instruction.indexOf('</document_context>') < instruction.indexOf('<translation_source kind='))
})

test('triggers only for repeated shortcuts on an unchanged selection inside the window', () => {
    const tracker = new RepeatedShortcutTracker()
    assert.deepEqual(tracker.observe('same', 100, 2, 900), { count: 1, triggered: false })
    assert.deepEqual(tracker.observe('same', 500, 2, 900), { count: 2, triggered: true })
    assert.deepEqual(tracker.observe('different', 600, 2, 900), { count: 1, triggered: false })
    assert.deepEqual(tracker.observe('different', 2000, 2, 900), { count: 1, triggered: false })
})
