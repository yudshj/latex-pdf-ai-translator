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
:root{color-scheme:light dark}*{box-sizing:border-box}html,body{height:100%}body{margin:0;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
#toolbar{height:34px;display:flex;align-items:center;justify-content:center;gap:2px;padding:2px 8px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);user-select:none}
.tool{height:28px;min-width:28px;padding:0 7px;color:var(--vscode-icon-foreground);background:transparent;border:1px solid transparent;border-radius:3px;font:15px/1 var(--vscode-font-family);cursor:pointer}.tool:hover{background:var(--vscode-toolbar-hoverBackground);border-color:var(--vscode-contrastBorder,transparent)}.tool:disabled{opacity:.4;cursor:default}
.separator{width:1px;height:18px;margin:0 6px;background:var(--vscode-panel-border)}#pageNumber{width:42px;height:24px;padding:1px 5px;text-align:right;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}#pageCount{min-width:32px;color:var(--vscode-descriptionForeground);font-size:12px}#scaleSelect{height:26px;padding:0 20px 0 6px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);border-radius:2px}
#status{position:absolute;right:12px;color:var(--vscode-descriptionForeground);font-size:12px}.viewport{height:calc(100% - 34px);overflow:auto}.pages{min-height:100%;padding:12px 18px 36px;display:flex;flex-direction:column;align-items:center;gap:12px}.page{position:relative;flex:none;background:white;box-shadow:0 1px 5px #0007}.page canvas{display:block}.textLayer{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0}.textLayer span{cursor:text}.loading{display:flex;align-items:center;gap:8px;padding:40px;color:var(--vscode-descriptionForeground)}.spinner{width:14px;height:14px;border:2px solid var(--vscode-progressBar-background);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.page-error{padding:24px;color:#a00}
</style>
<title>PDF Translator Viewer</title>
</head>
<body>
<div id="toolbar">
  <button class="tool" id="previous" title="Previous page" aria-label="Previous page">‹</button>
  <button class="tool" id="next" title="Next page" aria-label="Next page">›</button>
  <input id="pageNumber" type="number" min="1" value="1" aria-label="Page number"><span id="pageCount">/ —</span>
  <span class="separator"></span>
  <button class="tool" id="zoomOut" title="Zoom out" aria-label="Zoom out">−</button>
  <button class="tool" id="zoomIn" title="Zoom in" aria-label="Zoom in">＋</button>
  <select id="scaleSelect" title="Zoom"><option value="auto">Automatic zoom</option><option value="page-width">Page width</option><option value="page-fit">Page fit</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select>
  <span id="status">Loading…</span>
</div>
<main id="viewport" class="viewport"><div id="pages" class="pages"><div class="loading"><span class="spinner"></span>Loading PDF…</div></div></main>
<script type="module" nonce="${nonce}">
import * as pdfjsLib from ${js(scriptUri.toString())};
const vscode = acquireVsCodeApi();
pdfjsLib.GlobalWorkerOptions.workerSrc = ${js(workerUri.toString())};
const pages = document.getElementById('pages');
const viewportElement = document.getElementById('viewport');
const status = document.getElementById('status');
const pageNumber = document.getElementById('pageNumber');
const pageCount = document.getElementById('pageCount');
const scaleSelect = document.getElementById('scaleSelect');
const url = ${js(documentUri.toString())};
let pdf;
let firstPage;
let scaleMode = 'auto';
let scale = 1;
let generation = 0;
let currentPage = 1;
let renderObserver;
let pageObserver;
const computedScale = baseViewport => {
  if (!Number.isNaN(Number(scaleMode))) return Number(scaleMode);
  const widthScale = Math.max(.35, (viewportElement.clientWidth - 36) / baseViewport.width);
  if (scaleMode === 'page-fit') return Math.min(widthScale, Math.max(.35, (viewportElement.clientHeight - 24) / baseViewport.height));
  return Math.min(2.5, widthScale);
};
const renderPage = async (holder, number, current) => {
  if (holder.dataset.rendered === 'true' || holder.dataset.rendering === 'true') return;
  holder.dataset.rendering = 'true';
  try {
    const page = number === 1 ? firstPage : await pdf.getPage(number);
    if (current !== generation || !holder.isConnected) return;
    const pageViewport = page.getViewport({ scale });
    holder.style.width = pageViewport.width + 'px';
    holder.style.height = pageViewport.height + 'px';
    const canvas = document.createElement('canvas');
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(pageViewport.width * ratio);
    canvas.height = Math.floor(pageViewport.height * ratio);
    canvas.style.width = pageViewport.width + 'px';
    canvas.style.height = pageViewport.height + 'px';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    holder.replaceChildren(canvas, textLayer);
    const context = canvas.getContext('2d');
    await Promise.all([
      page.render({ canvasContext: context, viewport: pageViewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }).promise,
      new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: textLayer, viewport: pageViewport }).render(),
    ]);
    holder.dataset.rendered = 'true';
  } catch (error) {
    holder.innerHTML = '<div class="page-error">Page ' + number + ' could not be rendered.</div>';
    vscode.postMessage({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
  } finally {
    delete holder.dataset.rendering;
  }
};
const rebuild = async (keepPage = currentPage) => {
  const current = ++generation;
  renderObserver?.disconnect();
  pageObserver?.disconnect();
  pages.replaceChildren();
  const baseViewport = firstPage.getViewport({ scale: 1 });
  scale = computedScale(baseViewport);
  status.textContent = Math.round(scale * 100) + '%';
  scaleSelect.value = scaleMode;
  const holders = [];
  for (let number = 1; number <= pdf.numPages; number++) {
    const holder = document.createElement('section');
    holder.className = 'page';
    holder.dataset.pageNumber = String(number);
    holder.style.width = baseViewport.width * scale + 'px';
    holder.style.height = baseViewport.height * scale + 'px';
    pages.append(holder);
    holders.push(holder);
  }
  renderObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) void renderPage(entry.target, Number(entry.target.dataset.pageNumber), current);
  }, { root: viewportElement, rootMargin: '100% 0px' });
  pageObserver = new IntersectionObserver(entries => {
    const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (visible) {
      currentPage = Number(visible.target.dataset.pageNumber);
      pageNumber.value = String(currentPage);
    }
  }, { root: viewportElement, threshold: [.25, .5, .75] });
  holders.forEach(holder => { renderObserver.observe(holder); pageObserver.observe(holder); });
  await renderPage(holders[0], 1, current);
  holders[Math.max(0, Math.min(keepPage - 1, holders.length - 1))]?.scrollIntoView({ block: 'start' });
};
try {
  const task = pdfjsLib.getDocument({ url, cMapUrl: ${js(cMapUri)}, cMapPacked: true, standardFontDataUrl: ${js(fontUri)}, wasmUrl: ${js(wasmUri)} });
  task.onProgress = ({ loaded, total }) => { if (total) status.textContent = 'Loading ' + Math.round(loaded / total * 100) + '%'; };
  pdf = await task.promise;
  firstPage = await pdf.getPage(1);
  pageNumber.max = String(pdf.numPages);
  pageCount.textContent = '/ ' + pdf.numPages;
  await rebuild(1);
} catch (error) {
  status.textContent = 'Failed to load PDF';
  pages.innerHTML = '<div class="loading">Unable to open this PDF.</div>';
  vscode.postMessage({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
}
const goToPage = number => pages.querySelector('[data-page-number="' + Math.max(1, Math.min(pdf.numPages, number)) + '"]')?.scrollIntoView({ block: 'start' });
document.getElementById('previous').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('next').addEventListener('click', () => goToPage(currentPage + 1));
pageNumber.addEventListener('change', () => goToPage(Number(pageNumber.value)));
document.getElementById('zoomIn').addEventListener('click', () => { scaleMode = String(Math.min(3, scale + .15)); void rebuild(); });
document.getElementById('zoomOut').addEventListener('click', () => { scaleMode = String(Math.max(.35, scale - .15)); void rebuild(); });
scaleSelect.addEventListener('change', () => { scaleMode = scaleSelect.value; void rebuild(); });
let resizeTimer;
window.addEventListener('resize', () => {
  if (!pdf || !['auto', 'page-width', 'page-fit'].includes(scaleMode)) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void rebuild(), 120);
});
let selectionTimer;
const publishSelection = () => {
  const selection = window.getSelection();
  const text = selection && !selection.isCollapsed ? selection.toString() : '';
  if (text.trim()) vscode.postMessage({ type: 'selection', text });
};
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(publishSelection, 80);
});
document.addEventListener('keydown', event => {
  const trigger = ${isMac} ? event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'c' : event.altKey && event.key.toLowerCase() === 'c';
  if (trigger) {
    event.preventDefault();
    publishSelection();
    setTimeout(() => vscode.postMessage({ type: 'shortcut' }), 0);
  }
});
</script>
</body>
</html>`
    }
}
