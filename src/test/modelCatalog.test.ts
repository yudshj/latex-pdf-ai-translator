import assert from 'node:assert/strict'
import test from 'node:test'
import { knownModelProfile, parseModelList, resolveModelsUrl, resolveRequestUrl } from '../modelCatalog.js'

test('resolves base and full API endpoints', () => {
    assert.equal(resolveRequestUrl('https://api.example.com', 'responses'), 'https://api.example.com/v1/responses')
    assert.equal(resolveRequestUrl('https://api.example.com/v1', 'chat-completions'), 'https://api.example.com/v1/chat/completions')
    assert.equal(resolveRequestUrl('https://api.example.com/v1/messages', 'anthropic'), 'https://api.example.com/v1/messages')
    assert.equal(resolveModelsUrl('https://api.example.com/v1/chat/completions', ''), 'https://api.example.com/v1/models')
})

test('parses OpenRouter-style model capabilities', () => {
    const models = parseModelList({ data: [{
        id: 'vendor/model',
        context_length: 131072,
        architecture: { input_modalities: ['text', 'image'] },
        top_provider: { max_completion_tokens: 8192 },
    }] })
    assert.deepEqual(models[0], {
        id: 'vendor/model',
        name: undefined,
        contextLength: 131072,
        maxOutputTokens: 8192,
        inputModalities: ['text', 'image'],
        raw: {
            id: 'vendor/model',
            context_length: 131072,
            architecture: { input_modalities: ['text', 'image'] },
            top_provider: { max_completion_tokens: 8192 },
        },
    })
})

test('falls back to text when a provider omits capability metadata', () => {
    assert.deepEqual(parseModelList({ data: [{ id: 'deepseek-chat' }] })[0].inputModalities, ['text'])
})

test('enriches DeepSeek Harness models from its published catalog defaults', () => {
    assert.deepEqual(knownModelProfile('deepseek-flash'), {
        id: 'deepseek-flash',
        name: 'DeepSeek-V41-Flash',
        contextLength: 1_000_000,
        maxOutputTokens: 256_000,
        inputModalities: ['text', 'image'],
    })
    assert.equal(parseModelList({ data: [{ id: 'deepseek-flash' }] })[0].contextLength, 1_000_000)
})
