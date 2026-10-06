import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { parsePdfViewerState, PdfViewerState } from './pdfViewerProtocol.js'
import { resolveLatexSource, resolveSyncTeXSource } from './synctex.js'

interface PdfDocument extends vscode.CustomDocument {
    readonly uri: vscode.Uri
}

interface ViewerRegistration {
    readonly url: vscode.Uri
    dispose(): void
}

interface RegisteredDocument {
    readonly uri: vscode.Uri
    readonly state: PdfViewerState | undefined
}

const contentTypes: Record<string, string> = {
    '.bcmap': 'application/octet-stream',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
}

/**
 * LaTeX Workshop's internal viewer is fast because it keeps PDF.js, its worker,
 * and the PDF on one loopback HTTP origin. Using the same transport also avoids
 * the cold vscode-webview-resource service-worker path for every large asset.
 */
class LoopbackViewerServer implements vscode.Disposable {
    private readonly documents = new Map<string, RegisteredDocument>()
    private readonly server: http.Server
    private listening: Promise<number> | undefined

    constructor(
        private readonly assetRoot: string,
        private readonly makeViewerHtml: (pdfUrl: string, assetBaseUrl: string, state: PdfViewerState | undefined) => string,
        private readonly output: vscode.OutputChannel,
    ) {
        this.server = http.createServer((request, response) => {
            void this.handle(request, response)
        })
        this.server.on('error', error => {
            this.output.appendLine(`[viewer] Loopback server error: ${error.message}`)
        })
    }

    async register(pdfUri: vscode.Uri, state: PdfViewerState | undefined): Promise<ViewerRegistration> {
        const port = await this.port()
        const token = crypto.randomBytes(24).toString('hex')
        this.documents.set(token, { uri: pdfUri, state })
        return {
            url: vscode.Uri.parse(`http://127.0.0.1:${port}/viewer/${token}`, true),
            dispose: () => this.documents.delete(token),
        }
    }

    dispose(): void {
        this.documents.clear()
        this.server.close()
    }

    private port(): Promise<number> {
        if (this.listening) {
            return this.listening
        }
        this.listening = new Promise((resolve, reject) => {
            const onError = (error: Error): void => reject(error)
            this.server.once('error', onError)
            this.server.listen(0, '127.0.0.1', () => {
                this.server.off('error', onError)
                const address = this.server.address()
                if (!address || typeof address === 'string') {
                    reject(new Error('Loopback PDF server did not receive a TCP port.'))
                    return
                }
                this.output.appendLine(`[viewer] Loopback PDF server listening on 127.0.0.1:${address.port}.`)
                resolve(address.port)
            })
        })
        return this.listening
    }

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
        try {
            const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
            const parts = requestUrl.pathname.split('/').filter(Boolean)
            if (parts[0] === 'viewer' && parts.length === 2 && this.documents.has(parts[1])) {
                const html = this.makeViewerHtml(`/pdf/${parts[1]}`, '/assets', this.documents.get(parts[1])?.state)
                this.send(response, Buffer.from(html), 'text/html; charset=utf-8')
                return
            }
            if (parts[0] === 'pdf' && parts.length === 2) {
                const document = this.documents.get(parts[1])
                if (!document) {
                    this.notFound(response)
                    return
                }
                const bytes = await vscode.workspace.fs.readFile(document.uri)
                this.send(response, Buffer.from(bytes), 'application/pdf', 'no-store')
                return
            }
            if (parts[0] === 'assets' && parts.length >= 2) {
                const relativePath = parts.slice(1).map(decodeURIComponent).join('/')
                const resolvedPath = path.resolve(this.assetRoot, relativePath)
                if (resolvedPath !== this.assetRoot && !resolvedPath.startsWith(`${this.assetRoot}${path.sep}`)) {
                    this.notFound(response)
                    return
                }
                const bytes = await fs.readFile(resolvedPath)
                this.send(response, bytes, contentTypes[path.extname(resolvedPath).toLowerCase()] ?? 'application/octet-stream', 'public, max-age=31536000, immutable')
                return
            }
            this.notFound(response)
        } catch (error) {
            this.output.appendLine(`[viewer] ${error instanceof Error ? error.message : String(error)}`)
            if (!response.headersSent) {
                response.writeHead(500)
            }
            response.end()
        }
    }

    private send(response: http.ServerResponse, content: Buffer, contentType: string, cacheControl = 'no-cache'): void {
        response.writeHead(200, {
            'Cache-Control': cacheControl,
            'Content-Length': content.length,
            'Content-Type': contentType,
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
        })
        response.end(content)
    }

    private notFound(response: http.ServerResponse): void {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('Not found')
    }
}

export class PdfViewerProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument>, vscode.Disposable {
    static readonly viewType = 'pdfTranslator.pdfViewer'

    private readonly server: LoopbackViewerServer

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly output: vscode.OutputChannel,
    ) {
        const assetRoot = vscode.Uri.joinPath(context.extensionUri, 'media', 'pdfjs').fsPath
        this.server = new LoopbackViewerServer(assetRoot, (pdfUrl, assetBaseUrl, state) => this.viewerHtml(pdfUrl, assetBaseUrl, state), output)
    }

    dispose(): void {
        this.server.dispose()
    }

    openCustomDocument(uri: vscode.Uri): PdfDocument {
        return { uri, dispose: () => undefined }
    }

    async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
        const savedState = parsePdfViewerState(this.context.workspaceState.get(this.stateKey(document.uri)))
        const registration = await this.server.register(document.uri, savedState)
        const viewerUri = await vscode.env.asExternalUri(registration.url)
        panel.webview.options = { enableScripts: true }
        panel.webview.html = this.bridgeHtml(panel.webview, viewerUri)
        panel.onDidDispose(() => registration.dispose())
        panel.webview.onDidReceiveMessage((message: unknown) => {
            void this.handleMessage(message, document.uri)
        })
    }

    private async handleMessage(message: unknown, pdfUri: vscode.Uri): Promise<void> {
        if (!message || typeof message !== 'object') {
            return
        }
        const value = message as {
            type?: unknown
            text?: unknown
            detail?: unknown
            page?: unknown
            x?: unknown
            y?: unknown
            state?: unknown
        }
        if (value.type === 'selection' && typeof value.text === 'string' && value.text.trim()) {
            await vscode.commands.executeCommand('pdfTranslator.updatePdfSelection', {
                pdfFileUri: pdfUri.toString(true),
                text: value.text,
            })
        } else if (value.type === 'shortcut') {
            await vscode.commands.executeCommand('pdfTranslator.handleShortcut')
        } else if (value.type === 'state') {
            const state = parsePdfViewerState(value.state)
            if (state) {
                await this.context.workspaceState.update(this.stateKey(pdfUri), state)
            }
        } else if (value.type === 'jumpToSource'
            && Number.isInteger(value.page) && Number(value.page) >= 1
            && typeof value.x === 'number' && Number.isFinite(value.x)
            && typeof value.y === 'number' && Number.isFinite(value.y)) {
            await this.jumpToSource(pdfUri, Number(value.page), value.x, value.y, typeof value.text === 'string' ? value.text : '')
        } else if (value.type === 'error') {
            this.output.appendLine(`[viewer] ${String(value.detail ?? 'Unknown PDF viewer error')}`)
        } else if (value.type === 'performance') {
            this.output.appendLine(`[viewer] ${String(value.detail ?? 'PDF viewer ready')}`)
        }
    }

    private stateKey(pdfUri: vscode.Uri): string {
        const digest = crypto.createHash('sha256').update(pdfUri.toString(true)).digest('hex')
        return `pdfTranslator.viewerState.${digest}`
    }

    private async jumpToSource(pdfUri: vscode.Uri, page: number, x: number, y: number, selectedText: string): Promise<void> {
        const syncPosition = await resolveSyncTeXSource(page, x, y, pdfUri)
        if (syncPosition) {
            const document = await vscode.workspace.openTextDocument(syncPosition.uri)
            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside)
            editor.selection = new vscode.Selection(syncPosition.position, syncPosition.position)
            editor.revealRange(new vscode.Range(syncPosition.position, syncPosition.position), vscode.TextEditorRevealType.InCenter)
            void vscode.window.setStatusBarMessage(`$(go-to-file) ${syncPosition.label}`, 2000)
            return
        }
        const mapped = selectedText.trim() ? await resolveLatexSource(selectedText, pdfUri) : undefined
        if (mapped) {
            const document = await vscode.workspace.openTextDocument(mapped.uri)
            const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside)
            const range = new vscode.Range(mapped.start, mapped.end)
            editor.selection = new vscode.Selection(mapped.start, mapped.end)
            editor.revealRange(range, vscode.TextEditorRevealType.InCenter)
            void vscode.window.setStatusBarMessage(`$(go-to-file) ${mapped.label}`, 2000)
            return
        }
        void vscode.window.showWarningMessage('PDF Translator: no SyncTeX source is available for this PDF position.')
    }

    private bridgeHtml(webview: vscode.Webview, viewerUri: vscode.Uri): string {
        const nonce = crypto.randomBytes(16).toString('hex')
        const viewerUrl = viewerUri.toString(true)
        const viewerOrigin = `${viewerUri.scheme}://${viewerUri.authority}`
        const js = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c')
        return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${viewerOrigin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden;background:var(--vscode-editor-background)}</style></head>
<body><iframe src="${viewerUrl}" title="PDF Translator Viewer"></iframe>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();window.addEventListener('message',event=>{if(event.origin===${js(viewerOrigin)}&&event.data&&['selection','shortcut','state','jumpToSource','error','performance'].includes(event.data.type))vscode.postMessage(event.data)});</script>
</body></html>`
    }

    private viewerHtml(pdfUrl: string, assetBaseUrl: string, savedState: PdfViewerState | undefined): string {
        const nonce = Math.random().toString(36).slice(2)
        const scriptUri = `${assetBaseUrl}/pdf.min.mjs`
        const workerUri = `${assetBaseUrl}/pdf.worker.min.mjs`
        const styleUri = `${assetBaseUrl}/pdf_viewer.css`
        const cMapUri = `${assetBaseUrl}/cmaps/`
        const fontUri = `${assetBaseUrl}/standard_fonts/`
        const wasmUri = `${assetBaseUrl}/wasm/`
        const isMac = process.platform === 'darwin'
        const js = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c')
        return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'nonce-${nonce}' 'self'; worker-src 'self' blob:; connect-src 'self'; font-src 'self';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${styleUri}">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}html,body{height:100%}body{margin:0;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
#toolbar{height:34px;display:flex;align-items:center;justify-content:center;gap:2px;min-width:0;padding:2px 8px;overflow-x:auto;overflow-y:hidden;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);user-select:none}
.tool{height:28px;min-width:28px;padding:0 7px;color:var(--vscode-icon-foreground);background:transparent;border:1px solid transparent;border-radius:3px;font:15px/1 var(--vscode-font-family);cursor:pointer}.tool:hover{background:var(--vscode-toolbar-hoverBackground);border-color:var(--vscode-contrastBorder,transparent)}.tool:disabled{opacity:.4;cursor:default}
.separator{width:1px;height:18px;margin:0 6px;background:var(--vscode-panel-border)}#pageNumber{width:42px;height:24px;padding:1px 5px;text-align:right;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);border-radius:2px}#pageCount{min-width:32px;color:var(--vscode-descriptionForeground);font-size:12px}#scaleSelect{height:26px;padding:0 20px 0 6px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);border-radius:2px}
#status{position:absolute;right:12px;max-width:30%;overflow:hidden;color:var(--vscode-descriptionForeground);font-size:12px;text-overflow:ellipsis;white-space:nowrap;pointer-events:none}#status:empty{display:none}.viewport{height:calc(100% - 34px);overflow:auto}.pages{min-height:100%;padding:12px 18px 36px;display:flex;flex-direction:column;align-items:center;gap:12px}.page{position:relative;flex:none;background:white;box-shadow:0 1px 5px #0007}.page canvas{display:block}.textLayer{position:absolute;inset:0;overflow:hidden;opacity:1;line-height:1;text-size-adjust:none;transform-origin:0 0}.textLayer span{cursor:text}.loading{display:flex;align-items:center;gap:8px;padding:40px;color:var(--vscode-descriptionForeground)}.spinner{width:14px;height:14px;border:2px solid var(--vscode-progressBar-background);border-right-color:transparent;border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.page-error{padding:24px;color:#a00}
@media(max-width:420px){#toolbar{justify-content:flex-start;padding-inline:4px}.tool{min-width:24px;padding-inline:4px}.separator{margin-inline:2px}#pageNumber{width:36px}#pageCount{min-width:28px}#scaleSelect{max-width:92px;padding-left:4px}}
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
import * as pdfjsLib from ${js(scriptUri)};
const vscode = { postMessage: message => window.parent.postMessage(message, '*') };
pdfjsLib.GlobalWorkerOptions.workerSrc = ${js(workerUri)};
const pages = document.getElementById('pages');
const viewportElement = document.getElementById('viewport');
const status = document.getElementById('status');
const pageNumber = document.getElementById('pageNumber');
const pageCount = document.getElementById('pageCount');
const scaleSelect = document.getElementById('scaleSelect');
const url = ${js(pdfUrl)};
const initialState = ${JSON.stringify(savedState ?? { page: 1, pageOffset: 0, scaleMode: 'auto' }).replace(/</g, '\\u003c')};
const loadStartedAt = performance.now();
let pdf;
let firstPage;
let scaleMode = initialState.scaleMode;
let scale = 1;
let generation = 0;
let currentPage = initialState.page;
let renderObserver;
let pageObserver;
let stateTimer;
let pageUpdatePending = false;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const viewerState = () => {
  const holders = [...pages.querySelectorAll('.page')];
  const scrollTop = viewportElement.scrollTop;
  let holder = holders[0];
  for (const candidate of holders) {
    if (candidate.offsetTop <= scrollTop + 1) holder = candidate;
    else break;
  }
  const page = Number(holder?.dataset.pageNumber || currentPage || 1);
  const pageOffset = holder ? clamp((scrollTop - holder.offsetTop) / Math.max(1, holder.offsetHeight), 0, 1) : 0;
  return { page, pageOffset, scaleMode };
};
const publishState = () => { if (pdf) vscode.postMessage({ type: 'state', state: viewerState() }); };
const scheduleState = () => {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(publishState, 160);
};
const updateCurrentPage = () => {
  const viewportRect = viewportElement.getBoundingClientRect();
  let bestPage = currentPage;
  let bestVisibleHeight = -1;
  for (const holder of pages.querySelectorAll('.page')) {
    const rect = holder.getBoundingClientRect();
    const visibleHeight = Math.max(0, Math.min(rect.bottom, viewportRect.bottom) - Math.max(rect.top, viewportRect.top));
    if (visibleHeight > bestVisibleHeight) {
      bestVisibleHeight = visibleHeight;
      bestPage = Number(holder.dataset.pageNumber);
    }
  }
  currentPage = bestPage;
  pageNumber.value = String(currentPage);
};
const schedulePageUpdate = () => {
  if (pageUpdatePending) return;
  pageUpdatePending = true;
  requestAnimationFrame(() => {
    pageUpdatePending = false;
    updateCurrentPage();
  });
};
const syncScaleSelect = () => {
  scaleSelect.querySelector('option[data-custom]')?.remove();
  if (![...scaleSelect.options].some(option => option.value === scaleMode)) {
    const option = document.createElement('option');
    option.dataset.custom = 'true';
    option.value = scaleMode;
    option.textContent = Math.round(scale * 100) + '%';
    scaleSelect.append(option);
  }
  scaleSelect.value = scaleMode;
};
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
const rebuild = async (keepState = viewerState()) => {
  const current = ++generation;
  renderObserver?.disconnect();
  pageObserver?.disconnect();
  pages.replaceChildren();
  const baseViewport = firstPage.getViewport({ scale: 1 });
  scale = computedScale(baseViewport);
  status.textContent = '';
  syncScaleSelect();
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
  pageObserver = new IntersectionObserver(schedulePageUpdate, { root: viewportElement, threshold: [.25, .5, .75] });
  holders.forEach(holder => { renderObserver.observe(holder); pageObserver.observe(holder); });
  const targetPage = clamp(keepState.page, 1, holders.length);
  const target = holders[targetPage - 1];
  await renderPage(target, targetPage, current);
  await new Promise(resolve => requestAnimationFrame(resolve));
  currentPage = targetPage;
  pageNumber.value = String(targetPage);
  viewportElement.scrollTop = target.offsetTop + clamp(keepState.pageOffset, 0, 1) * target.offsetHeight;
  updateCurrentPage();
  scheduleState();
};
try {
  const task = pdfjsLib.getDocument({ url, cMapUrl: ${js(cMapUri)}, cMapPacked: true, standardFontDataUrl: ${js(fontUri)}, wasmUrl: ${js(wasmUri)} });
  task.onProgress = ({ loaded, total }) => { if (total) status.textContent = 'Loading ' + Math.round(loaded / total * 100) + '%'; };
  pdf = await task.promise;
  firstPage = await pdf.getPage(1);
  pageNumber.max = String(pdf.numPages);
  pageCount.textContent = '/ ' + pdf.numPages;
  await rebuild(initialState);
  vscode.postMessage({ type: 'performance', detail: 'First visible page ready in ' + Math.round(performance.now() - loadStartedAt) + ' ms (' + pdf.numPages + ' pages).' });
} catch (error) {
  status.textContent = 'Failed to load PDF';
  pages.innerHTML = '<div class="loading">Unable to open this PDF.</div>';
  vscode.postMessage({ type: 'error', detail: error instanceof Error ? error.message : String(error) });
}
const goToPage = number => pages.querySelector('[data-page-number="' + Math.max(1, Math.min(pdf.numPages, number)) + '"]')?.scrollIntoView({ block: 'start' });
document.getElementById('previous').addEventListener('click', () => goToPage(currentPage - 1));
document.getElementById('next').addEventListener('click', () => goToPage(currentPage + 1));
pageNumber.addEventListener('change', () => goToPage(Number(pageNumber.value)));
document.getElementById('zoomIn').addEventListener('click', () => { const keep = viewerState(); scaleMode = String(Math.min(3, scale + .15)); void rebuild(keep); });
document.getElementById('zoomOut').addEventListener('click', () => { const keep = viewerState(); scaleMode = String(Math.max(.35, scale - .15)); void rebuild(keep); });
scaleSelect.addEventListener('change', () => { const keep = viewerState(); scaleMode = scaleSelect.value; void rebuild(keep); });
let resizeTimer;
window.addEventListener('resize', () => {
  if (!pdf || !['auto', 'page-width', 'page-fit'].includes(scaleMode)) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => void rebuild(viewerState()), 120);
});
viewportElement.addEventListener('scroll', () => { schedulePageUpdate(); scheduleState(); }, { passive: true });
window.addEventListener('pagehide', publishState);
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
document.addEventListener('click', event => {
  if (event.detail !== 3 || event.button !== 0 || !pdf) return;
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  const holder = target?.closest('.page');
  if (!holder) return;
  const number = Number(holder.dataset.pageNumber);
  const rect = holder.getBoundingClientRect();
  const relativeX = event.clientX - rect.left;
  const relativeY = event.clientY - rect.top;
  void pdf.getPage(number).then(page => {
    const pageViewport = page.getViewport({ scale });
    const [x, y] = pageViewport.convertToPdfPoint(relativeX, pageViewport.height - relativeY);
    const selection = window.getSelection();
    const text = selection && !selection.isCollapsed ? selection.toString() : '';
    vscode.postMessage({ type: 'jumpToSource', page: number, x, y, text });
  }).catch(error => vscode.postMessage({ type: 'error', detail: error instanceof Error ? error.message : String(error) }));
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
