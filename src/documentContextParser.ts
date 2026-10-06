import { DocumentContext } from './types.js'

function normalizeBlock(value: string): string {
    return value
        .replace(/(?<!\\)%[^\n]*/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

export function extractDocumentContext(source: string): DocumentContext {
    const abstractMatch = /\\begin\s*\{abstract\}([\s\S]*?)\\end\s*\{abstract\}/m.exec(source)
    const ccsConcepts = [...source.matchAll(/\\ccsdesc(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g)]
        .map(match => normalizeBlock(match[1]).replace(/~/g, ' › '))
        .filter(Boolean)
    return {
        abstract: abstractMatch ? normalizeBlock(abstractMatch[1]) : undefined,
        ccsConcepts: [...new Set(ccsConcepts)],
    }
}
