# LaTeX PDF AI Translator

English | [中文](README.zh.md)

A standalone VS Code extension with its own focused PDF.js viewer, SyncTeX-aware source matching, and streaming translation sidebar. It does not depend on or fork LaTeX Workshop. Selecting text in the PDF viewer or a configured text file updates the sidebar immediately; press `Control+C` twice on macOS or `Alt+C` twice on Windows/Linux to start translation. The shortcut count can be changed to three in settings.

Keep the official `James-Yu.latex-workshop` extension installed for LaTeX project detection, building, diagnostics, and editing. This extension only replaces its PDF viewing path; it does not replace LaTeX Workshop's authoring features.

## What works

- Leaves the normal `Command+C` copy behavior untouched on macOS. Translation shortcuts use only the selection events sent by the viewer and never read the clipboard.
- Adds an Activity Bar translation view with actions at the top, streaming Markdown translation above, and the current source below.
- Opens PDFs in the built-in **PDF Translator Viewer** and follows its selection events directly. When SyncTeX data is available, the extension conservatively matches the selected PDF text against the `.tex` files named by SyncTeX and offers that source to the model.
- Uses the same loopback HTTP loading architecture as LaTeX Workshop: PDF.js, its worker, fonts, and the PDF share one local origin, avoiding cold `vscode-webview-resource` proxy delays.
- Remembers each PDF's last page, within-page scroll position, and zoom mode, and restores that reading position when the viewer is reopened.
- Keeps normal double-click word selection. Triple-click a PDF position to jump to its TeX source through reverse SyncTeX; when the SyncTeX command cannot resolve the point, the selected-text mapper is used as a conservative fallback.
- Follows non-empty selections in configured text files. `pdfTranslator.textSelectionPatterns` is a JSON list whose default is `["*.tex"]`; add entries such as `"*.md"` or `"chapters/**/*.tex"` as needed.
- Remembers the **Use LaTeX source** choice. The checked option is disabled rather than cleared when the current selection cannot be mapped, and becomes active again on the next mappable selection.
- Supports OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, and legacy Completions request shapes.
- Fetches the endpoint's cloud model list and presents a searchable picker.
- Reads context length, maximum output tokens, and text/image input modalities when the models endpoint reports them. The bundled DeepSeek Harness defaults also identify `deepseek-flash` as a 1M-context text/image model and `deepseek-v4-pro` as a 1M-context text model. Other missing fields are shown as `unknown`; the provider default is used when automatic maximum output tokens are unavailable.
- Stores an API key in VS Code SecretStorage through `PDF Translator: Set API Key Securely`. A literal key or `${env:VARIABLE_NAME}` can also be configured in settings.
- Repairs common PDF line wrapping before sending text and automatically translates predominantly Chinese text to English.
- In LaTeX mode, asks the model to interpret TeX, preserve every source paragraph as a separate Markdown paragraph, and return Markdown; the sidebar safely renders it while tokens arrive.
- Detects the document abstract and ACM CCS concepts, shows both detections in the status bar, and supplies them as terminology context without asking the model to reproduce them.
- Defaults DeepSeek-compatible thinking to `Off`; the sidebar offers `Off`, `Medium`, `High`, and `Max`.

## Develop and run

```sh
npm install
npm test
code .
```

Press `F5` in VS Code to launch an Extension Development Host. Open a PDF using **PDF Translator Viewer**, select text, then press `Control+C` twice on macOS or `Alt+C` twice on Windows/Linux.

For a local install:

```sh
npm run package
code --install-extension latex-pdf-ai-translator-0.4.2.vsix --force
```

## Configure

Run `PDF Translator: Open Settings`, then set:

- `pdfTranslator.endpointUrl`: a base URL such as `https://api.deepseek.com`, or a full request URL.
- `pdfTranslator.apiStyle`: `responses`, `chat-completions`, `anthropic`, or `completions`.
- `pdfTranslator.model`: enter an ID or run `PDF Translator: Select Cloud Model`.
- `pdfTranslator.shortcutPressCount`: `2` or `3`.
- `pdfTranslator.textSelectionPatterns`: filename or workspace-relative path globs to follow, for example `["*.tex", "notes/*.md"]`.
- `pdfTranslator.thinkingLevel`: `off`, `medium`, `high`, or `max`; defaults to `off` for lower time to first token.
- `pdfTranslator.maxOutputTokens`: `0` for provider/model-metadata automatic behavior.

The public OpenAI-compatible `GET /v1/models` response often contains only model IDs. Rich providers such as OpenRouter may also return context, output, and modality metadata; this extension displays those fields when present instead of guessing them.
If an endpoint does not implement a models-list route, the model command falls back to a manual searchable-ID entry.

## Architecture note

The extension owns its small PDF.js custom editor, so it can listen to `selectionchange` and triple-click coordinates directly without accessing another extension's webview or reading the clipboard. The extension uses reverse SyncTeX for point-to-source navigation and uses the selection text to find a conservative source range among the `.tex` files named by the adjacent `.synctex` or `.synctex.gz` file. Truly unmapped selections fall back to PDF text.
