export type ApiStyle = 'responses' | 'chat-completions' | 'anthropic' | 'completions'
export type SourceKind = 'plain' | 'latex'
export type ThinkingLevel = 'off' | 'medium' | 'high' | 'max'

export interface DocumentContext {
    abstract?: string
    ccsConcepts: string[]
}

export interface ModelProfile {
    id: string
    name?: string
    contextLength?: number
    maxOutputTokens?: number
    inputModalities: string[]
    raw?: unknown
}

export interface RuntimeConfig {
    apiStyle: ApiStyle
    endpointUrl: string
    modelsEndpointUrl: string
    apiKey: string
    model: string
    maxOutputTokens: number
    targetLanguage: string
    reverseLanguage: string
    normalizePdfText: boolean
    timeoutMs: number
    anthropicVersion: string
    systemPrompt: string
    thinkingLevel: ThinkingLevel
}

export interface TranslationResult {
    text: string
    model: string
    apiStyle: ApiStyle
    usage?: Record<string, unknown>
}

export interface TranslationStreamHandlers {
    onDelta: (delta: string) => void
    signal?: AbortSignal
}
