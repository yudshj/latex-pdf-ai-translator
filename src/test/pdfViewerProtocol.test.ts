import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePdfViewerState, parseSyncTeXEditResult } from '../pdfViewerProtocol.js'

test('accepts a persisted page anchor and zoom mode', () => {
    assert.deepEqual(parsePdfViewerState({ page: 18, pageOffset: 0.42, scaleMode: 'page-width' }), {
        page: 18,
        pageOffset: 0.42,
        scaleMode: 'page-width',
    })
    assert.deepEqual(parsePdfViewerState({ page: 2, pageOffset: 1, scaleMode: '1.35' }), {
        page: 2,
        pageOffset: 1,
        scaleMode: '1.35',
    })
})

test('rejects malformed viewer state', () => {
    assert.equal(parsePdfViewerState({ page: 0, pageOffset: 0, scaleMode: 'auto' }), undefined)
    assert.equal(parsePdfViewerState({ page: 1, pageOffset: 1.1, scaleMode: 'auto' }), undefined)
    assert.equal(parsePdfViewerState({ page: 1, pageOffset: 0, scaleMode: '500' }), undefined)
})

test('parses reverse SyncTeX output including paths with colons', () => {
    const output = `SyncTeX result begin
Output:/tmp/main.pdf
Input:C:\\papers\\article.tex
Line:243
Column:-1
Offset:0
Context:
SyncTeX result end`
    assert.deepEqual(parseSyncTeXEditResult(output), {
        input: 'C:\\papers\\article.tex',
        line: 243,
        column: 0,
    })
})
