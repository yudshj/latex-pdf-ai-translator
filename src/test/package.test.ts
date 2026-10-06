import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

interface ExtensionManifest {
    extensionDependencies?: string[]
    activationEvents?: string[]
    contributes?: {
        customEditors?: Array<{ viewType: string, displayName: string, selector: Array<{ filenamePattern: string }> }>
        commands?: Array<{ command: string }>
        keybindings?: Array<{ command: string, key?: string, mac?: string }>
        configuration?: { properties?: Record<string, unknown> }
    }
}

interface ArraySetting {
    type?: string
    items?: { type?: string }
    default?: unknown
}

const projectRoot = path.resolve(__dirname, '..', '..')
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as ExtensionManifest

test('provides its own focused PDF viewer without an extension dependency', () => {
    assert.equal(manifest.extensionDependencies, undefined)
    assert.deepEqual(manifest.contributes?.customEditors, [{
        viewType: 'pdfTranslator.pdfViewer',
        displayName: 'PDF Translator Viewer',
        selector: [{ filenamePattern: '*.pdf' }],
        priority: 'default',
    }])
})

test('uses Control+C on macOS and Alt+C elsewhere for selection-based translation', () => {
    const binding = manifest.contributes?.keybindings?.find(item => item.command === 'pdfTranslator.handleShortcut')
    assert.deepEqual(binding && { key: binding.key, mac: binding.mac }, { key: 'alt+c', mac: 'ctrl+c' })
})

test('exposes text selection filename patterns as a settings array', () => {
    const setting = manifest.contributes?.configuration?.properties?.['pdfTranslator.textSelectionPatterns'] as ArraySetting
    assert.equal(setting.type, 'array')
    assert.equal(setting.items?.type, 'string')
    assert.deepEqual(setting.default, ['*.tex'])
})

test('does not expose the retired clipboard-input commands or settings', () => {
    const commands = manifest.contributes?.commands?.map(item => item.command) ?? []
    const activationEvents = manifest.activationEvents ?? []
    const settings = Object.keys(manifest.contributes?.configuration?.properties ?? {})

    assert.ok(!commands.includes('pdfTranslator.handleCopy'))
    assert.ok(!commands.includes('pdfTranslator.translateClipboard'))
    assert.ok(!activationEvents.includes('onCommand:pdfTranslator.handleCopy'))
    assert.ok(!activationEvents.includes('onCommand:pdfTranslator.translateClipboard'))
    assert.ok(!settings.includes('pdfTranslator.copyPressCount'))
    assert.ok(!settings.includes('pdfTranslator.copyWindowMs'))
    assert.ok(!settings.includes('pdfTranslator.clipboardSettleMs'))
})

test('never reads the clipboard for model input', () => {
    const extensionSource = fs.readFileSync(path.join(projectRoot, 'src', 'extension.ts'), 'utf8')
    assert.doesNotMatch(extensionSource, /clipboard\.readText|translateClipboard|handleCopy/u)
})

test('loads PDF.js and PDFs from one loopback HTTP origin', () => {
    const viewerSource = fs.readFileSync(path.join(projectRoot, 'src', 'pdfViewer.ts'), 'utf8')
    assert.match(viewerSource, /server\.listen\(0, '127\.0\.0\.1'/u)
    assert.match(viewerSource, /\/viewer\/\$\{token\}/u)
    assert.match(viewerSource, /\/pdf\/\$\{parts\[1\]\}/u)
    assert.doesNotMatch(viewerSource, /asWebviewUri\(pdfUri\)/u)
})

test('persists viewer state and reserves source navigation for the third click', () => {
    const viewerSource = fs.readFileSync(path.join(projectRoot, 'src', 'pdfViewer.ts'), 'utf8')
    assert.match(viewerSource, /workspaceState\.update/u)
    assert.match(viewerSource, /event\.detail !== 3/u)
    assert.match(viewerSource, /type: 'jumpToSource'/u)
    assert.doesNotMatch(viewerSource, /addEventListener\('dblclick'/u)
})

test('keeps zoom in the selector and hides an empty viewer status', () => {
    const viewerSource = fs.readFileSync(path.join(projectRoot, 'src', 'pdfViewer.ts'), 'utf8')
    assert.match(viewerSource, /#status:empty\{display:none\}/u)
    assert.doesNotMatch(viewerSource, /status\.textContent\s*=\s*Math\.round\(scale \* 100\)/u)
})
