import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { DocumentContext } from './types.js'
export { extractDocumentContext } from './documentContextParser.js'
import { extractDocumentContext } from './documentContextParser.js'

const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const buildDirectoryNames = new Set(['build', 'dist', 'out', 'output', 'tex-build'])
const cache = new Map<string, Promise<DocumentContext>>()

function mergeContext(target: DocumentContext, candidate: DocumentContext): void {
    target.abstract ??= candidate.abstract
    for (const concept of candidate.ccsConcepts) {
        if (!target.ccsConcepts.includes(concept)) {
            target.ccsConcepts.push(concept)
        }
    }
}

async function sourceCandidates(pdfUri: vscode.Uri): Promise<vscode.Uri[]> {
    if (pdfUri.scheme !== 'file') {
        return []
    }
    const pdfDirectory = path.dirname(pdfUri.fsPath)
    const projectRoot = buildDirectoryNames.has(path.basename(pdfDirectory).toLowerCase())
        ? path.dirname(pdfDirectory)
        : pdfDirectory
    const baseName = path.basename(pdfUri.fsPath, path.extname(pdfUri.fsPath))
    const preferred = [
        vscode.Uri.file(path.join(projectRoot, `${baseName}.tex`)),
        vscode.Uri.file(path.join(projectRoot, 'main.tex')),
    ]
    const discovered = await vscode.workspace.findFiles(
        new vscode.RelativePattern(projectRoot, '**/*.tex'),
        '**/{node_modules,.git,deprecated}/**',
        200,
    )
    const seen = new Set<string>()
    return [...preferred, ...discovered].filter(uri => {
        const key = uri.fsPath
        if (seen.has(key)) {
            return false
        }
        seen.add(key)
        return true
    })
}

async function detect(pdfUri: vscode.Uri): Promise<DocumentContext> {
    const result: DocumentContext = { ccsConcepts: [] }
    for (const uri of await sourceCandidates(pdfUri)) {
        try {
            const stat = await fs.stat(uri.fsPath)
            if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
                continue
            }
            const source = await fs.readFile(uri.fsPath, 'utf8')
            mergeContext(result, extractDocumentContext(source))
            if (result.abstract && result.ccsConcepts.length > 0) {
                break
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error
            }
        }
    }
    return result
}

export function detectDocumentContext(pdfUri: vscode.Uri | undefined): Promise<DocumentContext> {
    if (!pdfUri) {
        return Promise.resolve({ ccsConcepts: [] })
    }
    const key = pdfUri.toString()
    const existing = cache.get(key)
    if (existing) {
        return existing
    }
    const pending = detect(pdfUri).catch(error => {
        cache.delete(key)
        throw error
    })
    cache.set(key, pending)
    return pending
}

export function clearDocumentContextCache(): void {
    cache.clear()
}
