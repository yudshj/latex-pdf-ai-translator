import { DocumentContext, SourceKind } from './types.js'

export function normalizePdfSelection(input: string): string {
    const normalized = input.replace(/\r\n?/g, '\n').trim()
    return normalized
        .replace(/([\p{L}])-\n\s*([\p{Ll}])/gu, '$1$2')
        .split(/\n{2,}/)
        .map(paragraph => paragraph.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
        .join('\n\n')
}

export function isPredominantlyChinese(text: string): boolean {
    const letters = text.match(/[\p{L}]/gu) ?? []
    if (letters.length === 0) {
        return false
    }
    const chinese = text.match(/[\p{Script=Han}]/gu) ?? []
    return chinese.length / letters.length >= 0.35
}

export function makeTranslationInstruction(
    text: string,
    targetLanguage: string,
    reverseLanguage: string,
    sourceKind: SourceKind = 'plain',
    documentContext?: DocumentContext,
): string {
    const target = reverseLanguage && isPredominantlyChinese(text) ? reverseLanguage : targetLanguage
    const context = formatDocumentContext(documentContext)
    const instructions = sourceKind === 'latex'
        ? [
            `Translate only the visible prose inside <translation_source> into ${target}.`,
            'Read and interpret the LaTeX rather than translating command names. Preserve equations, citations, references, symbols, and technical terminology.',
            'Preserve the source paragraph structure exactly. Each blank-line-separated source paragraph must become a separate Markdown paragraph, separated by one blank line. Never merge adjacent source paragraphs.',
            'Treat section headings, theorem or proposition headings, lists, and displayed algorithms as separate Markdown blocks.',
            'Return only rendered Markdown. Do not wrap the answer in a Markdown code fence and do not repeat the LaTeX source.',
        ]
        : [
            `Translate only the content inside <translation_source> into ${target}.`,
            'Preserve the source paragraph structure exactly. Each blank-line-separated source paragraph must become a separate Markdown paragraph, separated by one blank line. Never merge adjacent source paragraphs.',
        ]
    if (context) {
        instructions.push(
            'The <document_context> block is reference-only metadata, not translation source. Use it silently to choose accurate terminology.',
            'Never translate, summarize, paraphrase, quote, enumerate, or mention the abstract or CCS concepts merely because they appear in <document_context>. They may appear in the output only if the same material was explicitly selected inside <translation_source>.',
            context,
        )
    }
    instructions.push(
        `<translation_source kind="${sourceKind}">\n${text}\n</translation_source>`,
        'Output only the translation of <translation_source>. Do not add any material derived solely from <document_context>.',
    )
    return instructions.join('\n\n')
}

function formatDocumentContext(context?: DocumentContext): string {
    if (!context || (!context.abstract && context.ccsConcepts.length === 0)) {
        return ''
    }
    const parts = ['<document_context purpose="reference-only" output="forbidden">']
    if (context?.abstract) {
        parts.push(`Document abstract (reference only):\n${context.abstract}`)
    }
    if (context && context.ccsConcepts.length > 0) {
        parts.push(`CCS concepts (reference only):\n${context.ccsConcepts.map(value => `- ${value}`).join('\n')}`)
    }
    parts.push('</document_context>')
    return parts.join('\n\n')
}

export class RepeatedShortcutTracker {
    private lastText = ''
    private lastAt = 0
    private count = 0

    observe(text: string, now: number, requiredCount: number, windowMs: number): { count: number; triggered: boolean } {
        if (text === this.lastText && now - this.lastAt <= windowMs) {
            this.count += 1
        } else {
            this.lastText = text
            this.count = 1
        }
        this.lastAt = now
        const triggered = this.count >= requiredCount
        if (triggered) {
            this.reset()
        }
        return { count: triggered ? requiredCount : this.count, triggered }
    }

    reset(): void {
        this.lastText = ''
        this.lastAt = 0
        this.count = 0
    }
}
