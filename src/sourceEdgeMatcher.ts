import { normalizePdfSelection } from './text.js'

export interface SourceEdgeMatch {
    startOffset: number
    endOffset: number
    score: number
}

interface WordToken {
    value: string
    start: number
    end: number
}

function wordTokens(text: string): WordToken[] {
    const tokens: WordToken[] = []
    for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)) {
        const value = match[0]
        if (/^\d+$/u.test(value) || value.length < 2) {
            continue
        }
        const start = match.index ?? 0
        tokens.push({ value: value.toLocaleLowerCase(), start, end: start + value.length })
    }
    return tokens
}

function sequenceStarts(
    available: WordToken[],
    wanted: WordToken[],
    partial: { firstSuffix?: boolean, lastPrefix?: boolean } = {},
): number[] {
    const starts: number[] = []
    outer: for (let start = 0; start <= available.length - wanted.length; start += 1) {
        for (let offset = 0; offset < wanted.length; offset += 1) {
            const actual = available[start + offset].value
            const expected = wanted[offset].value
            const matchesPartialFirst = partial.firstSuffix && offset === 0 && expected.length >= 3 && actual.endsWith(expected)
            const matchesPartialLast = partial.lastPrefix && offset === wanted.length - 1 && expected.length >= 3 && actual.startsWith(expected)
            if (actual !== expected && !matchesPartialFirst && !matchesPartialLast) {
                continue outer
            }
        }
        starts.push(start)
    }
    return starts
}

function includeTrailingPunctuation(source: string, endOffset: number): number {
    let offset = endOffset
    while (offset < source.length && /[^\p{L}\p{N}\s\\{}]/u.test(source[offset])) {
        offset += 1
    }
    return offset
}

/**
 * Finds a long PDF selection in TeX by anchoring its visible first and last
 * words. This tolerates generated theorem headings, resolved references, and
 * math commands between the two edges while still requiring both edges to
 * occur in order in one reasonably sized source span.
 */
export function matchLatexSourceEdges(source: string, pdfText: string): SourceEdgeMatch | undefined {
    const wanted = wordTokens(normalizePdfSelection(pdfText))
    const available = wordTokens(source)
    if (wanted.length < 8) {
        return undefined
    }

    const maximumEdge = Math.min(12, Math.floor(wanted.length / 2))
    let best: SourceEdgeMatch | undefined
    for (let prefixLength = maximumEdge; prefixLength >= 3; prefixLength -= 1) {
        const prefixStarts = sequenceStarts(available, wanted.slice(0, prefixLength), { firstSuffix: true })
        if (prefixStarts.length === 0) {
            continue
        }
        for (let suffixLength = maximumEdge; suffixLength >= 3; suffixLength -= 1) {
            const suffixStarts = sequenceStarts(available, wanted.slice(-suffixLength), { lastPrefix: true })
            for (const prefixStart of prefixStarts) {
                for (const suffixStart of suffixStarts) {
                    const tokenSpan = suffixStart + suffixLength - prefixStart
                    if (suffixStart < prefixStart + prefixLength || tokenSpan > wanted.length * 2 + 40) {
                        continue
                    }
                    const startOffset = available[prefixStart].start
                    const last = available[suffixStart + suffixLength - 1]
                    const endOffset = includeTrailingPunctuation(source, last.end)
                    const score = 1_000 + (prefixLength + suffixLength) * 10 - Math.abs(tokenSpan - wanted.length)
                    if (!best || score > best.score || score === best.score && endOffset - startOffset < best.endOffset - best.startOffset) {
                        best = { startOffset, endOffset, score }
                    }
                }
            }
        }
    }
    return best
}
