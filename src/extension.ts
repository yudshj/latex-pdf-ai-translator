import * as path from 'node:path'
import * as vscode from 'vscode'
import { listModels, translateStreaming } from './apiClient.js'
import { parsePdfSelectionPayload } from './bridge.js'
import { clearDocumentContextCache, detectDocumentContext, extractDocumentContext } from './documentContext.js'
import { formatTokenCount, knownModelProfile } from './modelCatalog.js'
import { PdfViewerProvider } from './pdfViewer.js'
import { SidebarSelection, TranslationInput, TranslationSidebar } from './sidebar.js'
import { resolveLatexSource } from './synctex.js'
import { normalizePdfSelection, RepeatedShortcutTracker } from './text.js'
import { hasUsableTextSelection, isLatexFile, matchesTextSelectionPattern } from './textSelection.js'
import { ApiStyle, ModelProfile, RuntimeConfig, ThinkingLevel } from './types.js'

const SECRET_KEY = 'pdfTranslator.apiKey'
const MODEL_CACHE_KEY = 'pdfTranslator.models'
const CONFIG_SECTION = 'pdfTranslator'

function resolveConfiguredKey(value: string): string {
    const match = /^\$\{env:([^}]+)\}$/.exec(value.trim())
    return match ? process.env[match[1]] ?? '' : value.trim()
}

async function getRuntimeConfig(context: vscode.ExtensionContext): Promise<RuntimeConfig> {
    const settings = vscode.workspace.getConfiguration(CONFIG_SECTION)
    const storedKey = await context.secrets.get(SECRET_KEY)
    const configuredKey = resolveConfiguredKey(settings.get<string>('apiKey', ''))
    return {
        apiStyle: settings.get<ApiStyle>('apiStyle', 'chat-completions'),
        endpointUrl: settings.get<string>('endpointUrl', 'https://api.deepseek.com'),
        modelsEndpointUrl: settings.get<string>('modelsEndpointUrl', ''),
        apiKey: storedKey || configuredKey,
        model: settings.get<string>('model', 'deepseek-flash'),
        maxOutputTokens: settings.get<number>('maxOutputTokens', 0),
        targetLanguage: settings.get<string>('targetLanguage', 'Simplified Chinese'),
        reverseLanguage: settings.get<string>('chineseTargetReverseLanguage', 'English'),
        normalizePdfText: settings.get<boolean>('normalizePdfText', true),
        timeoutMs: settings.get<number>('requestTimeoutMs', 60000),
        anthropicVersion: settings.get<string>('anthropicVersion', '2023-06-01'),
        systemPrompt: settings.get<string>('systemPrompt', ''),
        thinkingLevel: settings.get<ThinkingLevel>('thinkingLevel', 'off'),
    }
}

function requireConfigured(config: RuntimeConfig): void {
    if (!config.apiKey) {
        throw new Error('No API key configured. Run “PDF Translator: Set API Key Securely”.')
    }
    if (!config.model) {
        throw new Error('No model selected. Run “PDF Translator: Select Cloud Model”.')
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const tracker = new RepeatedShortcutTracker()
    const output = vscode.window.createOutputChannel('PDF Translator')
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 20)
    status.name = 'PDF Translator'
    status.command = 'pdfTranslator.openSidebar'
    context.subscriptions.push(status, output)
    const pdfViewerProvider = new PdfViewerProvider(context, output)
    context.subscriptions.push(pdfViewerProvider, vscode.window.registerCustomEditorProvider(
        PdfViewerProvider.viewType,
        pdfViewerProvider,
        { supportsMultipleEditorsPerDocument: true },
    ))

    let activeProfile: ModelProfile | undefined
    let activeAbort: AbortController | undefined
    let translating = false
    let runTranslation: (input: TranslationInput) => Promise<void>

    const sidebar = new TranslationSidebar(context, {
        translate: input => { void runTranslation(input) },
        stop: () => activeAbort?.abort(),
        setThinkingLevel: level => {
            void vscode.workspace.getConfiguration(CONFIG_SECTION).update('thinkingLevel', level, vscode.ConfigurationTarget.Global)
        },
    })
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(
        TranslationSidebar.viewId,
        sidebar,
        { webviewOptions: { retainContextWhenHidden: true } },
    ))

    const updateDisplayedModel = (): void => {
        const model = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('model', 'deepseek-flash')
        const profile = activeProfile?.id === model ? activeProfile : knownModelProfile(model)
        sidebar.setModel(model, profile)
    }
    updateDisplayedModel()

    runTranslation = async (input: TranslationInput): Promise<void> => {
        if (!input.text.trim()) {
            void vscode.window.showWarningMessage('PDF Translator: no text is selected.')
            return
        }
        if (translating) {
            void vscode.window.setStatusBarMessage('$(sync~spin) A translation is already in progress.', 1600)
            return
        }
        translating = true
        activeAbort = new AbortController()
        status.text = '$(sync~spin) Translating…'
        status.show()
        await sidebar.reveal(true)
        sidebar.beginTranslation()
        try {
            const config = await getRuntimeConfig(context)
            requireConfigured(config)
            const profile = activeProfile?.id === config.model ? activeProfile : knownModelProfile(config.model)
            sidebar.setModel(config.model, profile)
            const result = await translateStreaming(config, input.text, profile, input.kind, {
                signal: activeAbort.signal,
                onDelta: delta => sidebar.appendTranslation(delta),
            }, input.documentContext)
            sidebar.finishTranslation(result)
            status.text = `$(check) ${result.model}`
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (activeAbort.signal.aborted) {
                sidebar.stopTranslation()
                status.text = '$(debug-stop) Translation stopped'
            } else {
                output.appendLine(`[translation] ${message}`)
                sidebar.failTranslation(message)
                status.text = '$(error) Translation failed'
                void vscode.window.showErrorMessage(`PDF Translator: ${message}`, 'Open Settings').then(choice => {
                    if (choice) {
                        void vscode.commands.executeCommand('pdfTranslator.openSettings')
                    }
                })
            }
        } finally {
            translating = false
            activeAbort = undefined
        }
    }

    let selectionCache: { key: string, selection: SidebarSelection } | undefined
    let selectionGeneration = 0

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.updatePdfSelection', async (rawPayload: unknown) => {
        const payload = parsePdfSelectionPayload(rawPayload)
        if (!payload || !payload.text.trim()) {
            return
        }
        const generation = ++selectionGeneration
        let pdfUri: vscode.Uri
        try {
            pdfUri = vscode.Uri.parse(payload.pdfFileUri, true)
        } catch {
            output.appendLine('[selection] Ignored a viewer selection with an invalid PDF URI.')
            return
        }
        const settings = vscode.workspace.getConfiguration(CONFIG_SECTION)
        const plainText = settings.get<boolean>('normalizePdfText', true)
            ? normalizePdfSelection(payload.text)
            : payload.text.trim()
        const hasSourceRange = Boolean(payload.sourceUri && payload.sourceText?.trim())
        let location = '无可用源码范围'
        if (hasSourceRange && payload.sourceUri) {
            const sourceUri = vscode.Uri.parse(payload.sourceUri, true)
            const start = payload.start
            const end = payload.end
            const range = start && end
                ? `${start.line + 1}:${start.character + 1}–${end.line + 1}:${end.character + 1}`
                : 'SyncTeX'
            location = `${path.basename(sourceUri.fsPath)} · ${range}`
        }
        const selection: SidebarSelection = {
            plainText,
            latexText: hasSourceRange ? payload.sourceText : undefined,
            location,
            pdfUri,
            sourceType: 'pdf',
            documentContext: { ccsConcepts: [] },
        }
        selectionCache = { key: `${pdfUri.toString()}\u0000${plainText}`, selection }
        sidebar.setSelection(selection)
        const [mapped, documentContext] = await Promise.all([
            hasSourceRange
                ? Promise.resolve(undefined)
                : resolveLatexSource(plainText, pdfUri).catch(error => {
                    output.appendLine(`[selection] ${error instanceof Error ? error.message : String(error)}`)
                    return undefined
                }),
            detectDocumentContext(pdfUri).catch(error => {
                output.appendLine(`[context] ${error instanceof Error ? error.message : String(error)}`)
                return { ccsConcepts: [] }
            }),
        ])
        if (generation === selectionGeneration) {
            const contextualSelection = mapped
                ? { ...selection, latexText: mapped.text, location: mapped.label, documentContext }
                : { ...selection, documentContext }
            selectionCache = { key: `${pdfUri.toString()}\u0000${plainText}`, selection: contextualSelection }
            sidebar.setSelection(contextualSelection)
        }
    }))

    const publishEditorSelection = async (editor: vscode.TextEditor | undefined): Promise<void> => {
        if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') {
            return
        }
        const patterns = vscode.workspace.getConfiguration(CONFIG_SECTION)
            .get<string[]>('textSelectionPatterns', ['*.tex'])
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
        const relativePath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath)
            : undefined
        if (!matchesTextSelectionPattern(editor.document.uri.fsPath, patterns, relativePath)) {
            return
        }
        const selectedText = editor.document.getText(editor.selection)
        if (!hasUsableTextSelection(selectedText)) {
            return
        }
        const generation = ++selectionGeneration
        const start = editor.selection.start
        const end = editor.selection.end
        const locationPath = relativePath && !relativePath.startsWith('..')
            ? relativePath
            : path.basename(editor.document.uri.fsPath)
        const latex = isLatexFile(editor.document.uri.fsPath, editor.document.languageId)
        const selection: SidebarSelection = {
            plainText: selectedText,
            latexText: latex ? selectedText : undefined,
            location: `${locationPath} · ${start.line + 1}:${start.character + 1}–${end.line + 1}:${end.character + 1}`,
            sourceUri: editor.document.uri,
            sourceType: 'editor',
            documentContext: { ccsConcepts: [] },
        }
        selectionCache = { key: `${editor.document.uri.toString()}\u0000${selectedText}`, selection }
        sidebar.setSelection(selection)
        if (latex) {
            const documentContext = await Promise.resolve(editor.document.getText())
                .then(source => extractDocumentContext(source))
                .catch(error => {
                    output.appendLine(`[context] ${error instanceof Error ? error.message : String(error)}`)
                    return { ccsConcepts: [] }
                })
            if (generation === selectionGeneration) {
                const contextualSelection = { ...selection, documentContext }
                selectionCache = { key: `${editor.document.uri.toString()}\u0000${selectedText}`, selection: contextualSelection }
                sidebar.setSelection(contextualSelection)
            }
        }
    }

    context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(event => {
        void publishEditorSelection(event.textEditor)
    }))
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
        void publishEditorSelection(editor)
    }))
    void publishEditorSelection(vscode.window.activeTextEditor)

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.handleShortcut', async () => {
        const settings = vscode.workspace.getConfiguration(CONFIG_SECTION)
        if (!settings.get<boolean>('enabled', true)) {
            return
        }
        const selection = selectionCache?.selection
        if (!selection?.plainText.trim()) {
            tracker.reset()
            void vscode.window.setStatusBarMessage('$(warning) Select text in the PDF viewer or a supported text editor first.', 1800)
            return
        }
        const required = settings.get<2 | 3>('shortcutPressCount', 2)
        const windowMs = settings.get<number>('shortcutWindowMs', 900)
        const state = tracker.observe(selection.plainText, Date.now(), required, windowMs)
        sidebar.setSelection(selection, state.triggered)
        if (state.triggered) {
            status.hide()
            const input = sidebar.getTranslationInput()
            if (input) {
                await runTranslation(input)
            }
        } else {
            status.text = `$(zap) Translate ${state.count}/${required}`
            status.tooltip = process.platform === 'darwin'
                ? 'Press Control+C again to translate the current selection'
                : 'Press Alt+C again to translate the current selection'
            status.show()
            setTimeout(() => {
                if (!translating) {
                    status.hide()
                }
            }, windowMs + 150)
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.openSidebar', async () => {
        await sidebar.reveal(false)
    }))

    const refreshModels = async (): Promise<ModelProfile[]> => {
        const config = await getRuntimeConfig(context)
        requireConfigured({ ...config, model: config.model || 'model-selection-placeholder' })
        const models = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Window,
            title: 'Loading cloud models…',
        }, () => listModels(config))
        await context.globalState.update(MODEL_CACHE_KEY, models.map(({ raw: _raw, ...model }) => model))
        return models
    }

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.refreshModels', async () => {
        try {
            const models = await refreshModels()
            void vscode.window.showInformationMessage(`PDF Translator: loaded ${models.length} models.`)
        } catch (error) {
            void vscode.window.showErrorMessage(`PDF Translator: ${error instanceof Error ? error.message : String(error)}`)
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.selectModel', async () => {
        try {
            let models: ModelProfile[]
            try {
                models = await refreshModels()
            } catch (error) {
                models = context.globalState.get<ModelProfile[]>(MODEL_CACHE_KEY, [])
                if (models.length === 0) {
                    const current = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('model', '')
                    const typed = await vscode.window.showInputBox({
                        title: 'Enter a model ID',
                        prompt: `The endpoint did not provide a model list: ${error instanceof Error ? error.message : String(error)}`,
                        value: current,
                        ignoreFocusOut: true,
                    })
                    if (typed?.trim()) {
                        await vscode.workspace.getConfiguration(CONFIG_SECTION).update('model', typed.trim(), vscode.ConfigurationTarget.Global)
                        activeProfile = knownModelProfile(typed.trim())
                        updateDisplayedModel()
                    }
                    return
                }
                void vscode.window.showWarningMessage('Cloud model refresh failed; showing the cached list.')
            }
            const picked = await vscode.window.showQuickPick(models.map(model => ({
                label: model.name || model.id,
                description: model.name ? model.id : undefined,
                detail: `context ${formatTokenCount(model.contextLength)} · max output ${formatTokenCount(model.maxOutputTokens)} · input ${model.inputModalities.join(' + ')}`,
                model,
            })), {
                title: 'Select a cloud model',
                placeHolder: 'Type to search by model ID or name',
                matchOnDescription: true,
                matchOnDetail: true,
            })
            if (picked) {
                activeProfile = picked.model
                await vscode.workspace.getConfiguration(CONFIG_SECTION).update('model', picked.model.id, vscode.ConfigurationTarget.Global)
                sidebar.setModel(picked.model.id, picked.model)
                status.text = `$(sparkle) ${picked.model.id}`
                status.tooltip = picked.detail
                status.show()
            }
        } catch (error) {
            void vscode.window.showErrorMessage(`PDF Translator: ${error instanceof Error ? error.message : String(error)}`)
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.setApiKey', async () => {
        const key = await vscode.window.showInputBox({
            title: 'Set PDF Translator API key',
            prompt: 'Stored in VS Code SecretStorage. It is not written to settings.json.',
            password: true,
            ignoreFocusOut: true,
        })
        if (key?.trim()) {
            await context.secrets.store(SECRET_KEY, key.trim())
            void vscode.window.showInformationMessage('PDF Translator API key stored securely.')
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.clearApiKey', async () => {
        await context.secrets.delete(SECRET_KEY)
        void vscode.window.showInformationMessage('PDF Translator stored API key cleared.')
    }))

    context.subscriptions.push(vscode.commands.registerCommand('pdfTranslator.openSettings', async () => {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local.latex-pdf-ai-translator')
    }))

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(`${CONFIG_SECTION}.model`)) {
            activeProfile = undefined
            updateDisplayedModel()
        }
        if (event.affectsConfiguration(`${CONFIG_SECTION}.thinkingLevel`)) {
            const level = vscode.workspace.getConfiguration(CONFIG_SECTION).get<ThinkingLevel>('thinkingLevel', 'off')
            sidebar.setThinkingLevel(level)
        }
    }))

    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        if (document.languageId === 'latex' || document.languageId === 'tex') {
            selectionCache = undefined
            clearDocumentContextCache()
        }
    }))
}

export function deactivate(): void {}
