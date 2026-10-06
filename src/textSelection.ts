import * as path from 'node:path'

function globPatternToRegExp(pattern: string): RegExp | undefined {
    const normalized = pattern.trim().replace(/\\/g, '/')
    if (!normalized) {
        return undefined
    }
    let source = '^'
    for (let index = 0; index < normalized.length; index += 1) {
        const character = normalized[index]
        if (character === '*') {
            if (normalized[index + 1] === '*') {
                if (normalized[index + 2] === '/') {
                    source += '(?:.*/)?'
                    index += 2
                } else {
                    source += '.*'
                    index += 1
                }
            } else {
                source += '[^/]*'
            }
        } else if (character === '?') {
            source += '[^/]'
        } else {
            source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
        }
    }
    return new RegExp(`${source}$`, 'i')
}

export function hasUsableTextSelection(text: string): boolean {
    return text.trim().length > 0
}

export function matchesTextSelectionPattern(
    filePath: string,
    patterns: readonly string[],
    workspaceRelativePath?: string,
): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/')
    const relativePath = workspaceRelativePath?.replace(/\\/g, '/')
    return patterns.some(pattern => {
        const normalizedPattern = pattern.trim().replace(/\\/g, '/')
        const expression = globPatternToRegExp(normalizedPattern)
        if (!expression) {
            return false
        }
        if (!normalizedPattern.includes('/')) {
            return expression.test(path.basename(normalizedPath))
        }
        return Boolean(relativePath && expression.test(relativePath)) || expression.test(normalizedPath)
    })
}

export function isLatexFile(filePath: string, languageId: string): boolean {
    return languageId === 'latex'
        || languageId === 'tex'
        || ['.tex', '.ltx', '.sty', '.cls'].includes(path.extname(filePath).toLowerCase())
}
