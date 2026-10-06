export interface PdfSelectionPosition {
    line: number
    character: number
}

export interface PdfSelectionPayload {
    pdfFileUri: string
    text: string
    sourceUri?: string
    sourceText?: string
    start?: PdfSelectionPosition
    end?: PdfSelectionPosition
}

function isPosition(value: unknown): value is PdfSelectionPosition {
    if (typeof value !== 'object' || value === null) {
        return false
    }
    const candidate = value as Record<string, unknown>
    return Number.isInteger(candidate.line) && Number(candidate.line) >= 0
        && Number.isInteger(candidate.character) && Number(candidate.character) >= 0
}

export function parsePdfSelectionPayload(value: unknown): PdfSelectionPayload | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined
    }
    const candidate = value as Record<string, unknown>
    if (typeof candidate.pdfFileUri !== 'string' || typeof candidate.text !== 'string') {
        return undefined
    }
    if (candidate.sourceUri !== undefined && typeof candidate.sourceUri !== 'string') {
        return undefined
    }
    if (candidate.sourceText !== undefined && typeof candidate.sourceText !== 'string') {
        return undefined
    }
    if (candidate.start !== undefined && !isPosition(candidate.start)) {
        return undefined
    }
    if (candidate.end !== undefined && !isPosition(candidate.end)) {
        return undefined
    }
    return {
        pdfFileUri: candidate.pdfFileUri,
        text: candidate.text,
        sourceUri: candidate.sourceUri,
        sourceText: candidate.sourceText,
        start: candidate.start as PdfSelectionPosition | undefined,
        end: candidate.end as PdfSelectionPosition | undefined,
    }
}
