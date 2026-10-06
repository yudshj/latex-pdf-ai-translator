import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRequestBody, parseStreamPiece, parseTranslationResponse } from '../apiClient.js'
import { RuntimeConfig } from '../types.js'

const base: RuntimeConfig = {
    apiStyle: 'responses', endpointUrl: 'https://example.com', modelsEndpointUrl: '', apiKey: 'secret', model: 'm',
    maxOutputTokens: 0, targetLanguage: 'Simplified Chinese', reverseLanguage: 'English', normalizePdfText: true,
    timeoutMs: 1000, anthropicVersion: '2023-06-01', systemPrompt: 'Translate precisely.', thinkingLevel: 'off',
}

test('uses discovered max output tokens for Responses API', () => {
    const body = buildRequestBody(base, 'hello', { id: 'm', maxOutputTokens: 2048, inputModalities: ['text'] })
    assert.equal(body.model, 'm')
    assert.equal(body.max_output_tokens, 2048)
    assert.match(String(body.instructions), /Translate precisely\./)
    assert.match(String(body.instructions), /blank-line-separated source paragraph/)
    assert.match(String(body.instructions), /separate Markdown paragraph/)
    assert.match(String(body.instructions), /must never be merged/)
    assert.match(String(body.instructions), /Document abstracts and CCS concepts.*reference metadata/u)
    assert.match(String(body.input), /<translation_source kind="plain">\nhello\n<\/translation_source>/u)
})

test('parses all supported response shapes', () => {
    assert.equal(parseTranslationResponse({ output_text: '响应', model: 'm' }, base).text, '响应')
    assert.equal(parseTranslationResponse({ choices: [{ message: { content: '聊天' } }] }, { ...base, apiStyle: 'chat-completions' }).text, '聊天')
    assert.equal(parseTranslationResponse({ content: [{ type: 'text', text: '消息' }] }, { ...base, apiStyle: 'anthropic' }).text, '消息')
    assert.equal(parseTranslationResponse({ choices: [{ text: '完成' }] }, { ...base, apiStyle: 'completions' }).text, '完成')
})

test('builds LaTeX streaming requests and parses provider deltas', () => {
    const body = buildRequestBody(base, String.raw`An \emph{important} result.`, undefined, 'latex', true, {
        abstract: 'This paper presents a runtime translator.',
        ccsConcepts: ['Software and its engineering › Software testing and debugging'],
    })
    assert.equal(body.stream, true)
    assert.match(String(body.input), /visible prose inside <translation_source>/)
    assert.match(String(body.input), /Return only rendered Markdown/)
    assert.match(String(body.input), /Document abstract \(reference only\):/)
    assert.match(String(body.input), /CCS concepts \(reference only\):/)
    assert.match(String(body.input), /Never translate, summarize, paraphrase, quote, enumerate, or mention/u)
    assert.match(String(body.instructions), /silent reference metadata/u)
    assert.equal(parseStreamPiece({ type: 'response.output_text.delta', delta: '一段' }, 'responses').delta, '一段')
    assert.equal(parseStreamPiece({ choices: [{ delta: { content: '文字' } }] }, 'chat-completions').delta, '文字')
    assert.equal(parseStreamPiece({ type: 'content_block_delta', delta: { type: 'text_delta', text: '消息' } }, 'anthropic').delta, '消息')
    assert.equal(parseStreamPiece({ choices: [{ text: '完成' }] }, 'completions').delta, '完成')
})

test('disables DeepSeek thinking by default and sends selected effort', () => {
    const deepseek = { ...base, model: 'deepseek-flash', endpointUrl: 'https://api.deepseek.com' }
    assert.deepEqual(buildRequestBody(deepseek, 'hello').thinking, { type: 'disabled' })
    const medium = buildRequestBody({ ...deepseek, thinkingLevel: 'medium' }, 'hello')
    assert.deepEqual(medium.thinking, { type: 'enabled' })
    assert.deepEqual(medium.output_config, { effort: 'medium' })
})
