import assert from 'node:assert/strict'
import test from 'node:test'
import { hasUsableTextSelection, isLatexFile, matchesTextSelectionPattern } from '../textSelection.js'

test('matches configured filename patterns and rejects unrelated suffixes', () => {
    assert.equal(matchesTextSelectionPattern('/paper/main.tex', ['*.tex']), true)
    assert.equal(matchesTextSelectionPattern('/paper/main.md', ['*.tex']), false)
    assert.equal(matchesTextSelectionPattern('/paper/README.MD', ['*.md']), true)
})

test('matches slash-containing patterns against workspace-relative paths', () => {
    assert.equal(matchesTextSelectionPattern('/paper/chapters/intro.tex', ['chapters/**/*.tex'], 'chapters/intro.tex'), true)
    assert.equal(matchesTextSelectionPattern('/paper/chapters/results/data.tex', ['chapters/**/*.tex'], 'chapters/results/data.tex'), true)
    assert.equal(matchesTextSelectionPattern('/paper/main.tex', ['chapters/**/*.tex'], 'main.tex'), false)
})

test('ignores empty selections and recognizes TeX-family sources', () => {
    assert.equal(hasUsableTextSelection('   \n'), false)
    assert.equal(hasUsableTextSelection('selected'), true)
    assert.equal(isLatexFile('/paper/main.tex', 'plaintext'), true)
    assert.equal(isLatexFile('/paper/notes.md', 'markdown'), false)
})
