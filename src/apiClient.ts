import { DocumentContext, ModelProfile, RuntimeConfig, SourceKind, TranslationResult, TranslationStreamHandlers } from './types.js'
import { makeTranslationInstruction, normalizePdfSelection } from './text.js'
import { parseModelList, resolveModelsUrl, resolveRequestUrl } from './modelCatalog.js'

type UnknownRecord = Record<string, unknown>

const OUTPUT_SCOPE_RULE = [
    'Translate only the content explicitly enclosed in <translation_source>.',
    'Preserve its paragraph structure exactly: each blank-line-separated source paragraph must be a separate Markdown paragraph separated by one blank line, and adjacent source paragraphs must never be merged.',
    'Document abstracts and CCS concepts in <document_context> are silent reference metadata, not translation source.',
    'Never translate, summarize, paraphrase, quote, enumerate, or mention that metadata unless the same material is explicitly present in <translation_source>.',
].join(' ')

function record(value: unknown): UnknownRecord | undefined {
    return typeof value === 'object' && value !== null ? value as UnknownRecord : undefined
}

function authHeaders(config: RuntimeConfig): Record<string, string> {
    if (config.apiStyle === 'anthropic') {
        return {
            'x-api-key': config.apiKey,
            'anthropic-version': config.anthropicVersion,
        }
    }
    return { Authorization: `Bearer ${config.apiKey}` }
}

async function requestJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const response = await fetch(url, { ...init, signal: controller.signal })
        const body = await response.text()
        let payload: unknown
        try {
            payload = body ? JSON.parse(body) : {}
        } catch {
            payload = { raw: body.slice(0, 500) }
        }
        if (!response.ok) {
            const root = record(payload)
            const error = record(root?.error)
            const message = typeof error?.message === 'string'
                ? error.message
                : typeof root?.message === 'string'
                    ? root.message
                    : `HTTP ${response.status}`
            throw new Error(`${response.status} ${response.statusText}: ${message}`)
        }
        return payload
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            throw new Error(`API request timed out after ${timeoutMs} ms.`)
        }
        throw error
    } finally {
        clearTimeout(timer)
    }
}

export async function listModels(config: RuntimeConfig): Promise<ModelProfile[]> {
    const url = resolveModelsUrl(config.endpointUrl, config.modelsEndpointUrl)
    const headers: Record<string, string> = {
        Accept: 'application/json',
        ...authHeaders(config),
    }
    const payload = await requestJson(url, { method: 'GET', headers }, config.timeoutMs)
    return parseModelList(payload)
}

function outputLimit(config: RuntimeConfig, profile?: ModelProfile): number | undefined {
    return config.maxOutputTokens > 0 ? config.maxOutputTokens : profile?.maxOutputTokens
}

function thinkingFields(config: RuntimeConfig): UnknownRecord {
    let isDeepSeek = /deepseek/i.test(config.model) || /deepseek/i.test(config.endpointUrl)
    try {
        isDeepSeek ||= /deepseek/i.test(new URL(config.endpointUrl).hostname)
    } catch {
        // The request URL validator reports malformed URLs later.
    }
    if (!isDeepSeek) {
        return {}
    }
    return config.thinkingLevel === 'off'
        ? { thinking: { type: 'disabled' } }
        : { thinking: { type: 'enabled' }, output_config: { effort: config.thinkingLevel } }
}

export function buildRequestBody(
    config: RuntimeConfig,
    sourceText: string,
    profile?: ModelProfile,
    sourceKind: SourceKind = 'plain',
    stream = false,
    documentContext?: DocumentContext,
): UnknownRecord {
    const text = sourceKind === 'plain' && config.normalizePdfText
        ? normalizePdfSelection(sourceText)
        : sourceText.trim()
    const instruction = makeTranslationInstruction(text, config.targetLanguage, config.reverseLanguage, sourceKind, documentContext)
    const systemInstruction = [config.systemPrompt.trim(), OUTPUT_SCOPE_RULE].filter(Boolean).join('\n\n')
    const maxTokens = outputLimit(config, profile)
    const thinking = thinkingFields(config)

    switch (config.apiStyle) {
        case 'responses':
            return {
                model: config.model,
                ...thinking,
                instructions: systemInstruction,
                input: instruction,
                ...(stream ? { stream: true } : {}),
                ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
            }
        case 'anthropic':
            return {
                model: config.model,
                ...thinking,
                system: systemInstruction,
                messages: [{ role: 'user', content: instruction }],
                max_tokens: maxTokens ?? 4096,
                ...(stream ? { stream: true } : {}),
            }
        case 'completions':
            return {
                model: config.model,
                ...thinking,
                prompt: `${systemInstruction}\n\n${instruction}\n\nTranslation:`,
                ...(stream ? { stream: true } : {}),
                ...(maxTokens ? { max_tokens: maxTokens } : {}),
            }
        case 'chat-completions':
            return {
                model: config.model,
                ...thinking,
                messages: [
                    { role: 'system', content: systemInstruction },
                    { role: 'user', content: instruction },
                ],
                ...(stream ? { stream: true } : {}),
                ...(maxTokens ? { max_tokens: maxTokens } : {}),
            }
    }
}

function textFromContent(content: unknown): string | undefined {
    if (typeof content === 'string') {
        return content
    }
    if (!Array.isArray(content)) {
        return undefined
    }
    const parts = content.flatMap(item => {
        const part = record(item)
        return typeof part?.text === 'string' ? [part.text] : []
    })
    return parts.length > 0 ? parts.join('') : undefined
}

export function parseTranslationResponse(payload: unknown, config: RuntimeConfig): TranslationResult {
    const root = record(payload)
    if (!root) {
        throw new Error('API returned an invalid JSON response.')
    }
    let text: string | undefined
    if (config.apiStyle === 'responses') {
        text = typeof root.output_text === 'string' ? root.output_text : undefined
        if (!text && Array.isArray(root.output)) {
            text = root.output.flatMap(item => {
                const message = record(item)
                return textFromContent(message?.content) ?? ''
            }).join('')
        }
    } else if (config.apiStyle === 'anthropic') {
        text = textFromContent(root.content)
    } else {
        const choice = Array.isArray(root.choices) ? record(root.choices[0]) : undefined
        if (config.apiStyle === 'completions') {
            text = typeof choice?.text === 'string' ? choice.text : undefined
        } else {
            text = textFromContent(record(choice?.message)?.content)
        }
    }
    if (!text?.trim()) {
        throw new Error('API response contained no translation text.')
    }
    return {
        text: text.trim(),
        model: typeof root.model === 'string' ? root.model : config.model,
        apiStyle: config.apiStyle,
        usage: record(root.usage),
    }
}

export async function translate(config: RuntimeConfig, sourceText: string, profile?: ModelProfile): Promise<TranslationResult> {
    const url = resolveRequestUrl(config.endpointUrl, config.apiStyle)
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...authHeaders(config),
    }
    const payload = await requestJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequestBody(config, sourceText, profile)),
    }, config.timeoutMs)
    return parseTranslationResponse(payload, config)
}

function apiError(payload: unknown, status: number, statusText: string): Error {
    const root = record(payload)
    const error = record(root?.error)
    const message = typeof error?.message === 'string'
        ? error.message
        : typeof root?.message === 'string'
            ? root.message
            : `HTTP ${status}`
    return new Error(`${status} ${statusText}: ${message}`)
}

interface StreamPiece {
    delta?: string
    model?: string
    usage?: UnknownRecord
}

export function parseStreamPiece(payload: unknown, style: RuntimeConfig['apiStyle']): StreamPiece {
    const root = record(payload)
    if (!root) {
        return {}
    }
    if (style === 'responses') {
        const response = record(root.response)
        const delta = root.type === 'response.output_text.delta' && typeof root.delta === 'string'
            ? root.delta
            : typeof root.output_text === 'string' ? root.output_text : undefined
        return {
            delta,
            model: typeof response?.model === 'string' ? response.model : typeof root.model === 'string' ? root.model : undefined,
            usage: record(response?.usage) ?? record(root.usage),
        }
    }
    if (style === 'anthropic') {
        const delta = record(root.delta)
        const message = record(root.message)
        return {
            delta: delta?.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined,
            model: typeof message?.model === 'string' ? message.model : typeof root.model === 'string' ? root.model : undefined,
            usage: record(root.usage) ?? record(message?.usage),
        }
    }
    const choice = Array.isArray(root.choices) ? record(root.choices[0]) : undefined
    const delta = style === 'completions'
        ? (typeof choice?.text === 'string' ? choice.text : undefined)
        : textFromContent(record(choice?.delta)?.content)
    return {
        delta,
        model: typeof root.model === 'string' ? root.model : undefined,
        usage: record(root.usage),
    }
}

function parseEventData(block: string): string | undefined {
    const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
    return data || undefined
}

export async function translateStreaming(
    config: RuntimeConfig,
    sourceText: string,
    profile: ModelProfile | undefined,
    sourceKind: SourceKind,
    handlers: TranslationStreamHandlers,
    documentContext?: DocumentContext,
): Promise<TranslationResult> {
    const url = resolveRequestUrl(config.endpointUrl, config.apiStyle)
    const controller = new AbortController()
    const relayAbort = () => controller.abort()
    handlers.signal?.addEventListener('abort', relayAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), config.timeoutMs)
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream, application/json',
                ...authHeaders(config),
            },
            body: JSON.stringify(buildRequestBody(config, sourceText, profile, sourceKind, true, documentContext)),
            signal: controller.signal,
        })
        if (!response.ok) {
            const body = await response.text()
            let payload: unknown
            try {
                payload = body ? JSON.parse(body) : {}
            } catch {
                payload = { raw: body.slice(0, 500) }
            }
            throw apiError(payload, response.status, response.statusText)
        }

        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('text/event-stream')) {
            const result = parseTranslationResponse(await response.json(), config)
            handlers.onDelta(result.text)
            return result
        }
        if (!response.body) {
            throw new Error('Streaming response did not contain a body.')
        }

        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let text = ''
        let model = config.model
        let usage: UnknownRecord | undefined

        const consume = (block: string): boolean => {
            const data = parseEventData(block)
            if (!data) {
                return false
            }
            if (data === '[DONE]') {
                return true
            }
            let payload: unknown
            try {
                payload = JSON.parse(data)
            } catch {
                return false
            }
            const piece = parseStreamPiece(payload, config.apiStyle)
            if (piece.delta) {
                text += piece.delta
                handlers.onDelta(piece.delta)
            }
            model = piece.model ?? model
            usage = piece.usage ?? usage
            return false
        }

        let done = false
        while (!done) {
            const part = await reader.read()
            buffer += decoder.decode(part.value, { stream: !part.done }).replace(/\r\n/g, '\n')
            let boundary = buffer.indexOf('\n\n')
            while (boundary >= 0) {
                const block = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                done = consume(block) || done
                boundary = buffer.indexOf('\n\n')
            }
            if (part.done) {
                break
            }
        }
        if (buffer.trim()) {
            consume(buffer)
        }
        if (!text.trim()) {
            throw new Error('API stream contained no translation text.')
        }
        return { text: text.trim(), model, apiStyle: config.apiStyle, usage }
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            if (handlers.signal?.aborted) {
                throw new Error('Translation stopped.')
            }
            throw new Error(`API request timed out after ${config.timeoutMs} ms.`)
        }
        throw error
    } finally {
        clearTimeout(timer)
        handlers.signal?.removeEventListener('abort', relayAbort)
    }
}
