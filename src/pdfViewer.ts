import * as path from 'node:path'
import * as vscode from 'vscode'

interface PdfDocument extends vscode.CustomDocument {
    readonly uri: vscode.Uri
}

export class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    static readonly viewType = 'pdfTranslator.pdfViewer'

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly output: vscode.OutputChannel,
    ) {}

    openCustomDocument(uri: vscode.Uri): PdfDocument {
        return { uri, dispose: () => undefined }
    }

    async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
        const assetRoot = vscode.Uri.joinPath(this.extensionUri, 'media', 'pdfjs')
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [assetRoot, vscode.Uri.file(path.dirname(document.uri.fsPath))],
        }
        panel.webview.html = this.html(panel.webview, document.uri, assetRoot)
        panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message, document.uri)
        })
    }

    private async handleMessage(message: unknown, pdfUri: vscode.Uri): Promise<void> {
        if (!message || typeof message !== 'object') {
            return
        }
        const value = message as { type?: unknown, text?: unknown, detail?: unknown }
        if (value.type === 'selection' && typeof value.text === 'string' && value.text.trim()) {
            await vscode.commands.executeCommand('pdfTranslator.updatePdfSelection', {
                pdfFileUri: pdfUri.toString(true),
                text: value.text,
            })
        } else if (value.type === 'shortcut') {
            await vscode.commands.executeCommand('pdfTranslator.handleShortcut')
        } else if (value.type === 'error') {
            this.output.appendLine(`[viewer] ${String(value.detail ?? 'Unknown PDF viewer error')}`)
        }
    }

    private html(webview: vscode.Webview, pdfUri: vscode.Uri, assetRoot: vscode.Uri): string {
        const nonce = Math.random().toString(36).slice(2)
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'pdf.min.mjs'))
        const workerUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'pdf.worker.min.mjs'))
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'pdf_viewer.css'))
        const cMapUri = `${webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'cmaps'))}/`
        const fontUri = `${webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'standard_fonts'))}/`
        const wasmUri = `${webview.asWebviewUri(vscode.Uri.joinPath(assetRoot, 'wasm'))}/`
        const documentUri = webview.asWebviewUri(pdfUri)
        const isMac = process.platform === 'darwin'
        const js = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c')
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
#toolbar{position:sticky;top:0;z-index:20;height:40px;display:flex;align-items:center;gap:7px;padding:5px 10px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
button{height:28px;min-width:30px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}
#status{margin-left:auto;color:var(--vscode-descriptionForeground);font-size:12px}.pages{padding:14px 20px 40px;display:flex;flex-direction:column;align-items:center;gap:14px}.page{position:relative;background:white;box-shadow:0 2px 9px #0006}.page canvas{display:block}.textLayer{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0}.textLayer span{cursor:text}.loading{padding:40px;color:var(--vscode-descriptionForeground)}
</style>
<title>PDF Translator Viewer</title>
</head>
<body>
<div id="toolbar"><button id="zoomOut" title="Zoom out">−</button><button id="zoomIn" title="Zoom in">+</button><button id="fit" title="Fit width">Fit</button><span id="status">Loading…</span></div>
<main id="pages" class="pages"><div class="loading">Loading PDF…</div></main>
<script type="module" nonce="${nonce}">
import * as pdfjsLib from ${js(scriptUri.toString())};
const vscode = acquireVsCodeApi();
pdfjsLib.GlobalWorkerOptions.workerSrc = ${js(workerUri.toString())};
const pages = document.getElementById('pages');
const status = document.getElementById('status');
const url = ${js(documentUri.toString())};
let pdf;
let scale = 1.35;
let generation = 0;
const render = async () => {
  const current = ++generation;
  pages.replaceChildren();
  status.textContent = pdf ? pdf.numPages + ' pages · ' + Math.round(scale * 100) + '%' : 'Loading…';
  for (let number = 1; number <= pdf.numPages; number++) {
    if (current !== generation) return;
    const page = await pdf.getPage(number);
    const viewport = page.getViewport({ scale });
    const holder = document.createElement('section');
    holder.className = 'page';
    holder.dataset.pageNumber = String(number);
    holder.style.width = viewport.width + 'px';
    holder.style.height = viewport.height + 'px';
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    holder.append(canvas, textLayer);
    pages.append(holder);
    const context = canvas.getContext('2d');
    await Promise.all([
      page.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise,
      new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport }).render(),
    ]);
  }
};
try {
  pdf = await pdfjsLib.getDocument({ url, cMapUrl: ${js(cMapUri)}, cMapPacked: true, standardFontDataUrl: ${js(fontUri)}, wasmUrl: ${js(wasmUri)} }).promise;
  await render();
} catch (error) {
  status.textContent = 'Failed to load PDF';
  pages.innerHTML = '<div class="loading">Unable to open this PDF.</div>';
  vscode.postMessage({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
}
document.getElementById('zoomIn').addEventListener('click', () => { scale = Math.min(3, scale + .15); void render(); });
document.getElementById('zoomOut').addEventListener('click', () => { scale = Math.max(.45, scale - .15); void render(); });
document.getElementById('fit').addEventListener('click', () => {
  const page = pages.querySelector('.page');
  if (!page) return;
  scale = Math.max(.45, Math.min(3, scale * (pages.clientWidth - 40) / page.getBoundingClientRect().width));
  void render();
});
let selectionTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString() : '';
    if (text.trim()) vscode.postMessage({ type: 'selection', text });
  }, 80);
});
document.addEventListener('keydown', event => {
  const trigger = ${isMac} ? event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c' : event.altKey && event.key.toLowerCase() === 'c';
  if (trigger) {
    event.preventDefault();
    vscode.postMessage({ type: 'shortcut' });
  }
});
</script>
</body>
</html>`
    }
}
