export interface PdfViewerState {
    page: number
    pageOffset: number
    scaleMode: string
}

export interface SyncTeXEditResult {
    input: string
    line: number
    column: number
}

const namedScaleModes = new Set(['auto', 'page-width', 'page-fit'])

function validScaleMode(value: unknown): value is string {
    if (typeof value !== 'string') {
        return false
    }
    if (namedScaleModes.has(value)) {
        return true
    }
    const numeric = Number(value)
    return Number.isFinite(numeric) && numeric >= 0.35 && numeric <= 3
}

export function parsePdfViewerState(value: unknown): PdfViewerState | undefined {
    if (!value || typeof value !== 'object') {
        return undefined
    }
    const candidate = value as Record<string, unknown>
    if (!Number.isInteger(candidate.page) || Number(candidate.page) < 1
        || typeof candidate.pageOffset !== 'number' || !Number.isFinite(candidate.pageOffset)
        || candidate.pageOffset < 0 || candidate.pageOffset > 1
        || !validScaleMode(candidate.scaleMode)) {
        return undefined
    }
    return {
        page: Number(candidate.page),
        pageOffset: candidate.pageOffset,
        scaleMode: candidate.scaleMode,
    }
}

export function parseSyncTeXEditResult(output: string): SyncTeXEditResult | undefined {
    const input = /^Input:(.*)$/mu.exec(output)?.[1]?.trim()
    const line = Number(/^Line:([-+]?\d+)$/mu.exec(output)?.[1])
    const columnValue = Number(/^Column:([-+]?\d+)$/mu.exec(output)?.[1])
    if (!input || !Number.isInteger(line) || line < 1) {
        return undefined
    }
    return {
        input,
        line,
        column: Number.isInteger(columnValue) ? Math.max(0, columnValue) : 0,
    }
}
