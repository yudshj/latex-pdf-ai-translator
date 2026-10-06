import assert from 'node:assert/strict'
import test from 'node:test'
import { extractDocumentContext } from '../documentContextParser.js'

test('extracts and normalizes an abstract and unique CCS concepts', () => {
    const source = String.raw`
        \begin{abstract}
        Runtime translation % an author note
        preserves equations and terminology.
        \end{abstract}
        \ccsdesc[500]{Software and its engineering~Compilers}
        \ccsdesc{Software and its engineering~Compilers}
        \ccsdesc{Computing methodologies~Rendering}
    `
    assert.deepEqual(extractDocumentContext(source), {
        abstract: 'Runtime translation \n preserves equations and terminology.',
        ccsConcepts: [
            'Software and its engineering › Compilers',
            'Computing methodologies › Rendering',
        ],
    })
})

test('returns an empty context when neither field is present', () => {
    assert.deepEqual(extractDocumentContext('\\section{Introduction}'), {
        abstract: undefined,
        ccsConcepts: [],
    })
})
