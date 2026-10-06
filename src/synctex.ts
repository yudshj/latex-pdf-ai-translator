import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import * as vscode from 'vscode'
import { parseSyncTeXEditResult } from './pdfViewerProtocol.js'
import { normalizePdfSelection } from './text.js'
import { matchLatexSourceEdges } from './sourceEdgeMatcher.js'

const gunzipAsync = promisify(gunzip)
const execFileAsync = promisify(execFile)
const MAX_SOURCE_BYTES = 8 * 1024 * 1024

export interface LatexSourceSelection {
    text: string
    uri: vscode.Uri
    start: vscode.Position
    end: vscode.Position
    label: string
}

export interface SyncTeXSourcePosition {
    uri: vscode.Uri
    position: vscode.Position
    label: string
}

interface ProjectedText {
    text: string
    sourceOffsets: number[]
}

interface SourceMatch {
    startOffset: number
    endOffset: number
    score: number
}

const hiddenArguments: Record<string, number> = {
    addbibresource: 1,
    autoref: 1,
    begin: 1,
    bibliography: 1,
    cite: 1,
    citep: 1,
    citet: 1,
    end: 1,
    eqref: 1,
    href: 1,
    include: 1,
    includegraphics: 1,
    input: 1,
    label: 1,
    pageref: 1,
    path: 1,
    ref: 1,
    url: 1,
}

const visibleCommands: Record<string, string> = {
    LaTeX: 'LaTeX',
    TeX: 'TeX',
    ldots: '…',
    textemdash: '—',
    textendash: '–',
}

function isEscaped(source: string, offset: number): boolean {
    let slashes = 0
    for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) {
        slashes += 1
    }
    return slashes % 2 === 1
}

function skipBalanced(source: string, offset: number, open: string, close: string): number {
    if (source[offset] !== open) {
        return offset
    }
    let depth = 0
    for (let index = offset; index < source.length; index += 1) {
        if (source[index] === open && !isEscaped(source, index)) {
            depth += 1
        } else if (source[index] === close && !isEscaped(source, index)) {
            depth -= 1
            if (depth === 0) {
                return index + 1
            }
        }
    }
    return source.length
}

function emit(target: string[], offsets: number[], value: string, sourceOffset: number): void {
    for (const character of value) {
        target.push(character)
        offsets.push(sourceOffset)
    }
}

export function projectLatexSource(source: string): ProjectedText {
    const target: string[] = []
    const offsets: number[] = []
    let index = 0
    while (index < source.length) {
        const character = source[index]
        if (character === '%' && !isEscaped(source, index)) {
            while (index < source.length && source[index] !== '\n') {
                index += 1
            }
            emit(target, offsets, ' ', index)
            continue
        }
        if (character === '\\') {
            const escaped = source[index + 1]
            if (escaped && !/[A-Za-z@]/.test(escaped)) {
                if ('%_&#${}'.includes(escaped)) {
                    emit(target, offsets, escaped, index)
                } else {
                    emit(target, offsets, ' ', index)
                }
                index += 2
                continue
            }
            const match = /^\\([A-Za-z@]+)\*?/.exec(source.slice(index))
            if (!match) {
                index += 1
                continue
            }
            const command = match[1]
            const commandOffset = index
            index += match[0].length
            const visible = visibleCommands[command]
            if (visible) {
                emit(target, offsets, visible, commandOffset)
            }
            const hiddenCount = hiddenArguments[command] ?? 0
            for (let argument = 0; argument < hiddenCount; argument += 1) {
                while (/\s/.test(source[index] ?? '')) {
                    index += 1
                }
                while (source[index] === '[') {
                    index = skipBalanced(source, index, '[', ']')
                    while (/\s/.test(source[index] ?? '')) {
                        index += 1
                    }
                }
                if (source[index] === '{') {
                    index = skipBalanced(source, index, '{', '}')
                }
            }
            continue
        }
        if (character === '{' || character === '}' || character === '$') {
            index += 1
            continue
        }
        if (character === '~' || character === '&' || /\s/.test(character)) {
            emit(target, offsets, ' ', index)
            index += 1
            continue
        }
        emit(target, offsets, character, index)
        index += 1
    }
    return normalizeProjected(target.join(''), offsets)
}

function normalizeProjected(text: string, offsets: number[]): ProjectedText {
    const target: string[] = []
    const mapped: number[] = []
    let previousWasSpace = true
    for (let index = 0; index < text.length; index += 1) {
        let character = text[index]
        if (/\s/u.test(character)) {
            if (!previousWasSpace) {
                target.push(' ')
                mapped.push(offsets[index])
            }
            previousWasSpace = true
            continue
        }
        character = character
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .toLocaleLowerCase()
        target.push(character)
        mapped.push(offsets[index])
        previousWasSpace = false
    }
    if (target.at(-1) === ' ') {
        target.pop()
        mapped.pop()
    }
    return { text: target.join(''), sourceOffsets: mapped }
}

function normalizeSelection(text: string): string {
    return normalizePdfSelection(text)
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLocaleLowerCase()
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
        tokens.push({ value, start, end: start + value.length })
    }
    return tokens
}

export function matchLatexSource(source: string, pdfText: string): SourceMatch | undefined {
    const projected = projectLatexSource(source)
    const needle = normalizeSelection(pdfText)
    if (!needle) {
        return undefined
    }
    const exactStart = projected.text.indexOf(needle)
    if (exactStart >= 0) {
        const exactEnd = exactStart + needle.length
        return {
            startOffset: projected.sourceOffsets[exactStart],
            endOffset: projected.sourceOffsets[exactEnd - 1] + 1,
            score: 1_000_000 + needle.length,
        }
    }

    const wanted = wordTokens(needle)
    const available = wordTokens(projected.text)
    if (wanted.length < 3) {
        return undefined
    }
    outer: for (let start = 0; start <= available.length - wanted.length; start += 1) {
        for (let offset = 0; offset < wanted.length; offset += 1) {
            if (available[start + offset].value !== wanted[offset].value) {
                continue outer
            }
        }
        const first = available[start]
        const last = available[start + wanted.length - 1]
        return {
            startOffset: projected.sourceOffsets[first.start],
            endOffset: projected.sourceOffsets[last.end - 1] + 1,
            score: wanted.length,
        }
    }
    return undefined
}

function positionAt(source: string, offset: number): vscode.Position {
    const prefix = source.slice(0, offset)
    const lines = prefix.split('\n')
    return new vscode.Position(lines.length - 1, lines.at(-1)?.length ?? 0)
}

function sourceUrisFromSyncTeX(contents: string, syncPath: string): vscode.Uri[] {
    const seen = new Set<string>()
    const result: vscode.Uri[] = []
    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []
    for (const match of contents.matchAll(/^Input:\d+:(.+)$/gm)) {
        const recorded = match[1].trim().replace(/^"|"$/g, '')
        if (!recorded.toLowerCase().endsWith('.tex')) {
            continue
        }
        const candidates = path.isAbsolute(recorded)
            ? [recorded]
            : [path.resolve(path.dirname(syncPath), recorded), ...workspaceRoots.map(root => path.resolve(root, recorded))]
        for (const candidate of candidates) {
            const normalized = path.normalize(candidate)
            if (!seen.has(normalized)) {
                seen.add(normalized)
                result.push(vscode.Uri.file(normalized))
            }
        }
    }
    return result
}

async function readSyncTeX(pdfUri: vscode.Uri): Promise<{ path: string, contents: string } | undefined> {
    if (pdfUri.scheme !== 'file' || !pdfUri.fsPath.toLowerCase().endsWith('.pdf')) {
        return undefined
    }
    const stem = pdfUri.fsPath.slice(0, -4)
    for (const candidate of [`${stem}.synctex.gz`, `${stem}.synctex`]) {
        try {
            const bytes = await fs.readFile(candidate)
            const decoded = candidate.endsWith('.gz') ? await gunzipAsync(bytes) : bytes
            return { path: candidate, contents: decoded.toString('utf8') }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            if (code !== 'ENOENT') {
                throw error
            }
        }
    }
    return undefined
}

export async function resolveLatexSource(pdfText: string, pdfUri: vscode.Uri | undefined): Promise<LatexSourceSelection | undefined> {
    if (!pdfUri) {
        return undefined
    }
    const sync = await readSyncTeX(pdfUri)
    if (!sync) {
        return undefined
    }
    let best: { uri: vscode.Uri, source: string, match: SourceMatch } | undefined
    for (const uri of sourceUrisFromSyncTeX(sync.contents, sync.path)) {
        try {
            const stat = await fs.stat(uri.fsPath)
            if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) {
                continue
            }
            const source = await fs.readFile(uri.fsPath, 'utf8')
            const match = matchLatexSource(source, pdfText) ?? matchLatexSourceEdges(source, pdfText)
            if (match && (!best || match.score > best.match.score)) {
                best = { uri, source, match }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error
            }
        }
    }
    if (!best) {
        return undefined
    }
    const start = positionAt(best.source, best.match.startOffset)
    const end = positionAt(best.source, best.match.endOffset)
    const fileLabel = vscode.workspace.asRelativePath(best.uri, false)
    return {
        text: best.source.slice(best.match.startOffset, best.match.endOffset),
        uri: best.uri,
        start,
        end,
        label: `${fileLabel}:${start.line + 1}:${start.character + 1} → ${end.line + 1}:${end.character + 1}`,
    }
}

function syncTeXCommands(): string[] {
    const configured = vscode.workspace.getConfiguration('latex-workshop').get<string>('synctex.path', '').trim()
    return [...new Set([
        configured,
        'synctex',
        ...(process.platform === 'darwin' ? ['/Library/TeX/texbin/synctex'] : []),
    ].filter(Boolean))]
}

async function existingSourceUri(input: string, pdfUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const cleanInput = input.replace(/^"|"$/g, '')
    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []
    const candidates = path.isAbsolute(cleanInput)
        ? [cleanInput]
        : [path.resolve(path.dirname(pdfUri.fsPath), cleanInput), ...workspaceRoots.map(root => path.resolve(root, cleanInput))]
    for (const candidate of candidates) {
        try {
            if ((await fs.stat(candidate)).isFile()) {
                return vscode.Uri.file(candidate)
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error
            }
        }
    }
    return undefined
}

/** Resolve a PDF point to its source line with the system SyncTeX client. */
export async function resolveSyncTeXSource(
    page: number,
    x: number,
    y: number,
    pdfUri: vscode.Uri,
): Promise<SyncTeXSourcePosition | undefined> {
    if (pdfUri.scheme !== 'file' || !Number.isInteger(page) || page < 1
        || !Number.isFinite(x) || !Number.isFinite(y)) {
        return undefined
    }
    const query = `${page}:${x.toFixed(3)}:${y.toFixed(3)}:${pdfUri.fsPath}`
    for (const command of syncTeXCommands()) {
        try {
            const { stdout } = await execFileAsync(command, ['edit', '-o', query], {
                cwd: path.dirname(pdfUri.fsPath),
                encoding: 'utf8',
                maxBuffer: 1024 * 1024,
                timeout: 5000,
            })
            const result = parseSyncTeXEditResult(stdout)
            if (!result) {
                continue
            }
            const uri = await existingSourceUri(result.input, pdfUri)
            if (!uri) {
                continue
            }
            const document = await vscode.workspace.openTextDocument(uri)
            const line = Math.min(result.line - 1, Math.max(0, document.lineCount - 1))
            const character = Math.min(result.column, document.lineAt(line).text.length)
            return {
                uri,
                position: new vscode.Position(line, character),
                label: `${vscode.workspace.asRelativePath(uri, false)}:${line + 1}:${character + 1}`,
            }
        } catch {
            // Try the next executable, then let the caller use text matching.
        }
    }
    return undefined
}
