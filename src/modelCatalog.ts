import { ApiStyle, ModelProfile } from './types.js'

type UnknownRecord = Record<string, unknown>

const knownModels: Record<string, Omit<ModelProfile, 'id' | 'raw'>> = {
    'deepseek-flash': {
        name: 'DeepSeek-V41-Flash',
        contextLength: 1_000_000,
        maxOutputTokens: 256_000,
        inputModalities: ['text', 'image'],
    },
    'deepseek-v4-pro': {
        name: 'DeepSeek-V4-Pro',
        contextLength: 1_000_000,
        maxOutputTokens: 256_000,
        inputModalities: ['text'],
    },
}

export function enrichKnownModel(profile: ModelProfile): ModelProfile {
    const known = knownModels[profile.id]
    if (!known) {
        return profile
    }
    return {
        ...profile,
        name: profile.name ?? known.name,
        contextLength: profile.contextLength ?? known.contextLength,
        maxOutputTokens: profile.maxOutputTokens ?? known.maxOutputTokens,
        inputModalities: profile.inputModalities.length > 0 && profile.inputModalities.some(value => value !== 'text')
            ? profile.inputModalities
            : known.inputModalities,
    }
}

export function knownModelProfile(id: string): ModelProfile | undefined {
    const known = knownModels[id]
    return known ? { id, ...known } : undefined
}

function record(value: unknown): UnknownRecord | undefined {
    return typeof value === 'object' && value !== null ? value as UnknownRecord : undefined
}

function positiveInteger(...values: unknown[]): number | undefined {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            return Math.floor(value)
        }
        if (typeof value === 'string' && /^\d+$/.test(value)) {
            return Number(value)
        }
    }
    return undefined
}

function stringArray(...values: unknown[]): string[] {
    for (const value of values) {
        if (Array.isArray(value)) {
            const strings = value.filter((item): item is string => typeof item === 'string')
            if (strings.length > 0) {
                return [...new Set(strings.map(item => item.toLowerCase()))]
            }
        }
    }
    return []
}

export function parseModelList(payload: unknown): ModelProfile[] {
    const root = record(payload)
    const candidate = Array.isArray(payload) ? payload : root?.data ?? root?.models
    if (!Array.isArray(candidate)) {
        throw new Error('The models endpoint did not return an array in data or models.')
    }

    return candidate.flatMap((value): ModelProfile[] => {
        const item = record(value)
        if (!item) {
            return []
        }
        const id = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : undefined
        if (!id) {
            return []
        }
        const architecture = record(item.architecture)
        const topProvider = record(item.top_provider)
        const limits = record(item.limits)
        const capabilities = record(item.capabilities)
        const modalities = stringArray(
            item.input_modalities,
            architecture?.input_modalities,
            item.modalities,
        )
        if (modalities.length === 0) {
            if (capabilities?.vision === true || item.vision === true) {
                modalities.push('text', 'image')
            } else {
                modalities.push('text')
            }
        }
        return [enrichKnownModel({
            id,
            name: typeof item.display_name === 'string' ? item.display_name : undefined,
            contextLength: positiveInteger(
                item.context_length,
                item.context_window,
                item.max_context_length,
                limits?.context_length,
                limits?.context_window,
            ),
            maxOutputTokens: positiveInteger(
                item.max_output_tokens,
                item.max_completion_tokens,
                item.output_token_limit,
                topProvider?.max_completion_tokens,
                limits?.max_output_tokens,
            ),
            inputModalities: modalities,
            raw: item,
        })]
    }).sort((a, b) => a.id.localeCompare(b.id))
}

function stripTrailingSlash(url: string): string {
    return url.trim().replace(/\/+$/, '')
}

function hasEndpointPath(url: string): boolean {
    return /\/(responses|chat\/completions|completions|messages|models)$/.test(url)
}

function baseFromEndpoint(url: string): string {
    return url.replace(/\/(responses|chat\/completions|completions|messages|models)$/, '')
}

export function resolveRequestUrl(endpointUrl: string, style: ApiStyle): string {
    const endpoint = stripTrailingSlash(endpointUrl)
    if (!endpoint) {
        throw new Error('pdfTranslator.endpointUrl is empty.')
    }
    if (hasEndpointPath(endpoint)) {
        return endpoint
    }
    const suffix: Record<ApiStyle, string> = {
        responses: 'responses',
        'chat-completions': 'chat/completions',
        anthropic: 'messages',
        completions: 'completions',
    }
    return `${endpoint}${endpoint.endsWith('/v1') ? '' : '/v1'}/${suffix[style]}`
}

export function resolveModelsUrl(endpointUrl: string, explicitUrl: string): string {
    if (explicitUrl.trim()) {
        return stripTrailingSlash(explicitUrl)
    }
    const endpoint = baseFromEndpoint(stripTrailingSlash(endpointUrl))
    return `${endpoint}${endpoint.endsWith('/v1') ? '' : '/v1'}/models`
}

export function formatTokenCount(value?: number): string {
    if (!value) {
        return 'unknown'
    }
    if (value >= 1_000_000) {
        return `${Number((value / 1_000_000).toFixed(1))}M`
    }
    if (value >= 1_000) {
        return `${Number((value / 1_000).toFixed(1))}K`
    }
    return String(value)
}
