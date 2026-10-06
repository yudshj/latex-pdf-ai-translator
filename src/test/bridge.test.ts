import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePdfSelectionPayload } from '../bridge.js'

test('accepts a viewer selection with a mapped TeX range', () => {
    assert.deepEqual(parsePdfSelectionPayload({
        pdfFileUri: 'file:///paper.pdf',
        text: 'selected text',
        sourceUri: 'file:///paper.tex',
        sourceText: 'selected \\emph{text}',
        start: { line: 4, character: 2 },
        end: { line: 4, character: 24 },
    }), {
        pdfFileUri: 'file:///paper.pdf',
        text: 'selected text',
        sourceUri: 'file:///paper.tex',
        sourceText: 'selected \\emph{text}',
        start: { line: 4, character: 2 },
        end: { line: 4, character: 24 },
    })
})

test('accepts plain PDF text and rejects malformed positions', () => {
    assert.deepEqual(parsePdfSelectionPayload({
        pdfFileUri: 'file:///paper.pdf',
        text: 'plain selection',
    }), {
        pdfFileUri: 'file:///paper.pdf',
        text: 'plain selection',
        sourceUri: undefined,
        sourceText: undefined,
        start: undefined,
        end: undefined,
    })
    assert.equal(parsePdfSelectionPayload({
        pdfFileUri: 'file:///paper.pdf',
        text: 'bad position',
        start: { line: -1, character: 0 },
    }), undefined)
})
