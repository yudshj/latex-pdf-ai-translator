import * as path from 'node:path'
import * as vscode from 'vscode'
import { formatTokenCount } from './modelCatalog.js'
import { DocumentContext, ModelProfile, SourceKind, ThinkingLevel, TranslationResult } from './types.js'

const LATEX_PREFERENCE_KEY = 'pdfTranslator.preferLatexSource'

export interface SidebarSelection {
    plainText: string
    latexText?: string
    location: string
    pdfUri?: vscode.Uri
    sourceUri?: vscode.Uri
    sourceType?: 'pdf' | 'editor'
    documentContext: DocumentContext
}

export interface TranslationInput {
    text: string
    kind: SourceKind
    documentContext: DocumentContext
}

interface SidebarActions {
    translate: (input: TranslationInput) => void
    stop: () => void
    setThinkingLevel: (level: ThinkingLevel) => void
}

export class TranslationSidebar implements vscode.WebviewViewProvider {
    static readonly viewId = 'pdfTranslator.sidebar'

    private view: vscode.WebviewView | undefined
    private currentSelection: SidebarSelection | undefined
    private latestSelection: SidebarSelection | undefined
    private translation = ''
    private status = '请在 PDF 或编辑器中选择文字'
    private modelLabel = '未选择模型'
    private modelDetail = ''
    private streaming = false
    private autoFollow = true
    private latexPreferred: boolean
    private thinkingLevel: ThinkingLevel

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly actions: SidebarActions,
    ) {
        this.latexPreferred = context.globalState.get<boolean>(LATEX_PREFERENCE_KEY, false)
        this.thinkingLevel = vscode.workspace.getConfiguration('pdfTranslator').get<ThinkingLevel>('thinkingLevel', 'off')
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view
        view.webview.options = { enableScripts: true }
        view.webview.html = this.html(view.webview)
        view.webview.onDidReceiveMessage(async message => {
            switch (message?.type) {
                case 'ready':
                    this.pushState()
                    break
                case 'translate': {
                    const input = this.getTranslationInput()
                    if (input) {
                        this.actions.translate(input)
                    } else {
                        this.setStatus('请先在 PDF 或编辑器中选择一段文字')
                    }
                    break
                }
                case 'stop':
                    this.actions.stop()
                    break
                case 'copy':
                    await vscode.env.clipboard.writeText(this.translation)
                    this.setStatus('译文已复制')
                    break
                case 'clear':
                    this.translation = ''
                    this.streaming = false
                    this.setStatus('已清空译文')
                    this.post({ type: 'translationReset', text: '' })
                    break
                case 'setLatexPreference':
                    if (typeof message.value === 'boolean') {
                        this.latexPreferred = message.value
                        await this.context.globalState.update(LATEX_PREFERENCE_KEY, message.value)
                        this.pushState()
                    }
                    break
                case 'setAutoFollow':
                    if (typeof message.value === 'boolean') {
                        this.autoFollow = message.value
                        if (message.value && this.latestSelection) {
                            this.currentSelection = this.latestSelection
                        }
                        this.pushState()
                    }
                    break
                case 'setThinkingLevel':
                    if (['off', 'medium', 'high', 'max'].includes(message.value)) {
                        this.thinkingLevel = message.value as ThinkingLevel
                        this.actions.setThinkingLevel(this.thinkingLevel)
                        this.pushState()
                    }
                    break
            }
        }, undefined, this.context.subscriptions)
        view.onDidDispose(() => {
            if (this.view === view) {
                this.view = undefined
            }
        })
        this.pushState()
    }

    async reveal(preserveFocus = true): Promise<void> {
        if (this.view) {
            this.view.show(preserveFocus)
            return
        }
        await vscode.commands.executeCommand('workbench.view.extension.pdfTranslator')
        if (preserveFocus) {
            await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
        }
    }

    setSelection(selection: SidebarSelection, force = false): void {
        this.latestSelection = selection
        if (force || this.autoFollow || !this.currentSelection) {
            this.currentSelection = selection
            this.status = selection.sourceType === 'editor'
                ? (selection.latexText ? '已同步 LaTeX 编辑器选区' : '已同步文本编辑器选区')
                : (selection.latexText ? '选区已映射到 LaTeX 源码' : '当前选区仅有 PDF 文本')
            this.pushState()
        } else {
            this.setStatus('选区已变化；自动跟随已关闭')
        }
    }

    setModel(model: string, profile?: ModelProfile): void {
        this.modelLabel = model || '未选择模型'
        this.modelDetail = profile
            ? `上下文 ${formatTokenCount(profile.contextLength)} · 最大输出 ${formatTokenCount(profile.maxOutputTokens)} · ${profile.inputModalities.join(' + ')}`
            : ''
        this.pushState()
    }

    setThinkingLevel(level: ThinkingLevel): void {
        this.thinkingLevel = level
        this.pushState()
    }

    beginTranslation(): void {
        this.translation = ''
        this.streaming = true
        this.status = this.getTranslationInput()?.kind === 'latex'
            ? '读取 TeX，流式输出 Markdown…'
            : '翻译选中文字…'
        this.post({ type: 'translationReset', text: '' })
        this.pushState()
    }

    appendTranslation(delta: string): void {
        this.translation += delta
        this.post({ type: 'translationDelta', delta })
    }

    finishTranslation(result: TranslationResult): void {
        this.translation = result.text
        this.streaming = false
        this.modelLabel = result.model
        this.status = '流式输出完成'
        this.post({ type: 'translationDone', text: result.text })
        this.pushState()
    }

    failTranslation(message: string): void {
        this.streaming = false
        this.status = message
        this.post({ type: 'translationError', message })
        this.pushState()
    }

    stopTranslation(): void {
        this.streaming = false
        this.status = this.translation ? '已停止，保留当前译文' : '已停止'
        this.pushState()
    }

    private setStatus(status: string): void {
        this.status = status
        this.pushState()
    }

    getTranslationInput(): TranslationInput | undefined {
        if (!this.currentSelection?.plainText.trim()) {
            return undefined
        }
        if (this.latexPreferred && this.currentSelection.latexText) {
            return { text: this.currentSelection.latexText, kind: 'latex', documentContext: this.currentSelection.documentContext }
        }
        return { text: this.currentSelection.plainText, kind: 'plain', documentContext: this.currentSelection.documentContext }
    }

    private state(): Record<string, unknown> {
        const latexAvailable = Boolean(this.currentSelection?.latexText)
        const input = this.getTranslationInput()
        return {
            sourceText: input?.text ?? '',
            sourceKind: input?.kind ?? 'plain',
            latexAvailable,
            latexPreferred: this.latexPreferred,
            autoFollow: this.autoFollow,
            location: this.currentSelection?.location ?? '尚未取得选区',
            sourceName: this.currentSelection?.sourceUri
                ? path.basename(this.currentSelection.sourceUri.fsPath)
                : (this.currentSelection?.pdfUri ? path.basename(this.currentSelection.pdfUri.fsPath) : '选区'),
            sourceType: this.currentSelection?.sourceType ?? 'none',
            translation: this.translation,
            streaming: this.streaming,
            status: this.status,
            modelLabel: this.modelLabel,
            modelDetail: this.modelDetail,
            thinkingLevel: this.thinkingLevel,
            abstractDetected: Boolean(this.currentSelection?.documentContext.abstract),
            ccsConceptsDetected: (this.currentSelection?.documentContext.ccsConcepts.length ?? 0) > 0,
        }
    }

    private pushState(): void {
        this.post({ type: 'state', state: this.state() })
    }

    private post(message: unknown): void {
        void this.view?.webview.postMessage(message)
    }

    private html(webview: vscode.Webview): string {
        const nonce = Math.random().toString(36).slice(2)
        return String.raw`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:var(--vscode-font-size)/1.45 var(--vscode-font-family);height:100vh;overflow:hidden}
.shell{height:100%;display:flex;flex-direction:column;min-width:0;min-height:0}.toolbar{display:flex;gap:5px;align-items:center;min-width:0;padding:9px 10px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border))}
button{font:inherit;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:0;border-radius:2px;min-height:28px;padding:4px 9px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.45}.icon{min-width:30px;padding:4px 7px}.spacer{flex:1}
.context{display:flex;align-items:center;gap:7px;min-width:0;padding:7px 10px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));color:var(--vscode-descriptionForeground)}#source-name{flex:0 1 auto;max-width:28%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.location{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sync{flex:none;margin-left:auto;white-space:nowrap;color:var(--vscode-testing-iconPassed)}
.options{display:flex;flex-wrap:wrap;gap:10px 12px;align-items:center;padding:7px 10px;border-bottom:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border))}.check,.thinking{display:flex;gap:5px;align-items:center}.check.unavailable{color:var(--vscode-disabledForeground);opacity:.72}input{accent-color:var(--vscode-focusBorder)}select{height:24px;color:var(--vscode-dropdown-foreground);background:var(--vscode-dropdown-background);border:1px solid var(--vscode-dropdown-border);font:inherit}
.stack{display:grid;grid-template-rows:minmax(170px,62%) minmax(120px,38%);flex:1;min-height:0}.pane{display:flex;flex-direction:column;min-width:0;min-height:0}.pane+.pane{border-top:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border))}.heading{display:flex;align-items:center;gap:7px;min-width:0;min-height:34px;padding:6px 10px;background:var(--vscode-sideBarSectionHeader-background);font-weight:600;white-space:nowrap}.minor{min-width:0;margin-left:auto;overflow:hidden;color:var(--vscode-descriptionForeground);font-weight:400;text-overflow:ellipsis;white-space:nowrap}.dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-testing-iconPassed);display:none}.streaming .dot{display:block;animation:pulse 1s alternate infinite}@keyframes pulse{to{opacity:.25}}
#translation,#source{flex:1;min-height:0;overflow:auto;padding:11px 12px;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}#source{width:100%;resize:none;border:0;outline:0;font:var(--vscode-font-size)/1.5 var(--vscode-editor-font-family)}#source.latex{font-family:var(--vscode-editor-font-family)}
#translation>:first-child{margin-top:0}#translation>:last-child{margin-bottom:0}#translation p{margin:0 0 1em}#translation h1,#translation h2,#translation h3{font-size:1.08em;margin:1em 0 .55em}#translation blockquote{margin:.7em 0;padding-left:10px;border-left:3px solid var(--vscode-textBlockQuote-border);color:var(--vscode-descriptionForeground)}#translation pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:8px;overflow:auto}#translation code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 3px}#translation ul,#translation ol{padding-left:22px}
.status{display:flex;gap:8px;align-items:center;min-width:0;min-height:25px;padding:4px 10px;border-top:1px solid var(--vscode-sideBar-border,var(--vscode-panel-border));color:var(--vscode-descriptionForeground);font-size:11px;white-space:nowrap}.status-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.recognized{flex:none;color:var(--vscode-testing-iconPassed)}.model{flex:0 1 35%;min-width:0;margin-left:auto;overflow:hidden;text-overflow:ellipsis}
@media(max-width:480px){.toolbar{flex-wrap:wrap}.spacer{display:none}.context{flex-wrap:wrap}.context .location{order:3;flex-basis:100%}#source-name{max-width:calc(100% - 72px)}.options{gap:7px 10px}.status{flex-wrap:wrap;gap:2px 8px;white-space:normal}.status-text{flex-basis:calc(100% - 110px);white-space:nowrap}.recognized,.model{white-space:nowrap}.model{flex-basis:auto;max-width:45%}}
@media(max-width:300px){.toolbar button{flex:1 1 calc(50% - 3px)}.context{align-items:flex-start}.sync{max-width:45%;overflow:hidden;text-overflow:ellipsis}.heading{font-size:12px}.minor{max-width:55%}}
</style></head><body>
<div class="shell" id="shell">
  <div class="toolbar">
    <button class="primary" id="translate">翻译选区</button>
    <button id="stop" disabled>停止</button>
    <button class="icon" id="copy" aria-label="复制译文" title="复制译文">复制</button>
    <button class="icon" id="clear" aria-label="清空译文" title="清空译文">清空</button>
    <span class="spacer"></span>
  </div>
  <div class="context"><span id="source-name">选区</span><span class="location" id="location">尚未取得选区</span><span class="sync" id="sync">纯文本</span></div>
  <div class="options">
    <label class="check"><input id="auto-follow" type="checkbox" checked>自动跟随</label>
    <label class="check" id="latex-label"><input id="latex" type="checkbox">使用 LaTeX 源码</label>
    <label class="thinking">思考<select id="thinking"><option value="off">Off</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>
  </div>
  <div class="stack">
    <section class="pane"><div class="heading">译文预览<span class="dot"></span><span class="minor">已渲染 Markdown</span></div><div id="translation" aria-live="polite">等待翻译</div></section>
    <section class="pane"><div class="heading">发送给模型的原文<span class="minor" id="source-mode">纯文本</span></div><textarea id="source" readonly></textarea></section>
  </div>
  <div class="status"><span class="status-text" id="status">请在 PDF 或编辑器中选择文字</span><span class="recognized" id="abstract-status" hidden>✓ 已识别摘要</span><span class="recognized" id="ccs-status" hidden>✓ 已识别 CCS concept</span><span class="model" id="model"></span></div>
</div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
const shell=document.getElementById('shell');const translation=document.getElementById('translation');const source=document.getElementById('source');const latex=document.getElementById('latex');const latexLabel=document.getElementById('latex-label');const autoFollow=document.getElementById('auto-follow');const thinking=document.getElementById('thinking');const translate=document.getElementById('translate');const stop=document.getElementById('stop');let markdown='';
function escapeHtml(value){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function inline(value){const codes=[];let safe=escapeHtml(value).replace(/\x60([^\x60]+)\x60/g,(_,code)=>{codes.push('<code>'+code+'</code>');return '\u0000'+(codes.length-1)+'\u0000'});safe=safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/(^|[^*])\*([^*]+)\*/g,'$1<em>$2</em>');return safe.replace(/\u0000(\d+)\u0000/g,(_,index)=>codes[Number(index)])}
function renderMarkdown(value){const lines=value.replace(/\r\n?/g,'\n').split('\n');const blocks=[];let paragraph=[];let list=null;let fence=null;const flush=()=>{if(paragraph.length){blocks.push('<p>'+inline(paragraph.join(' '))+'</p>');paragraph=[]}if(list){blocks.push('<'+list.type+'>'+list.items.map(item=>'<li>'+inline(item)+'</li>').join('')+'</'+list.type+'>');list=null}};for(const line of lines){if(fence!==null){if(/^\x60\x60\x60/.test(line)){blocks.push('<pre><code>'+escapeHtml(fence.join('\n'))+'</code></pre>');fence=null}else fence.push(line);continue}if(/^\x60\x60\x60/.test(line)){flush();fence=[];continue}const heading=/^(#{1,3})\s+(.+)$/.exec(line);if(heading){flush();const level=heading[1].length;blocks.push('<h'+level+'>'+inline(heading[2])+'</h'+level+'>');continue}const quote=/^>\s?(.*)$/.exec(line);if(quote){flush();blocks.push('<blockquote>'+inline(quote[1])+'</blockquote>');continue}const bullet=/^\s*[-*+]\s+(.+)$/.exec(line);const ordered=/^\s*\d+[.)]\s+(.+)$/.exec(line);if(bullet||ordered){const type=ordered?'ol':'ul';if(list&&list.type!==type)flush();if(!list)list={type,items:[]};list.items.push((bullet||ordered)[1]);continue}if(!line.trim()){flush();continue}if(list)flush();paragraph.push(line.trim())}flush();if(fence!==null)blocks.push('<pre><code>'+escapeHtml(fence.join('\n'))+'</code></pre>');return blocks.join('')||'<p></p>'}
function render(){translation.innerHTML=renderMarkdown(markdown);translation.scrollTop=translation.scrollHeight}
window.addEventListener('message',event=>{const message=event.data;if(message.type==='state'){const state=message.state;markdown=state.translation??markdown;render();source.value=state.sourceText??'';source.classList.toggle('latex',state.sourceKind==='latex');latex.checked=Boolean(state.latexPreferred);latex.disabled=!state.latexAvailable;latexLabel.classList.toggle('unavailable',!state.latexAvailable);autoFollow.checked=Boolean(state.autoFollow);thinking.value=state.thinkingLevel||'off';document.getElementById('source-mode').textContent=state.sourceKind==='latex'?'LaTeX 源码':(!state.latexAvailable&&state.latexPreferred?'无可用 LaTeX 源码':'纯文本');document.getElementById('location').textContent=state.location;document.getElementById('source-name').textContent=state.sourceName;const directLatex=state.sourceType==='editor'&&state.latexAvailable;document.getElementById('sync').textContent=directLatex?'LaTeX 选区':(state.latexAvailable?'SyncTeX':(state.sourceType==='editor'?'文本选区':'仅 PDF 文本'));document.getElementById('sync').style.color=state.latexAvailable?'var(--vscode-testing-iconPassed)':'var(--vscode-disabledForeground)';document.getElementById('status').textContent=state.status;document.getElementById('abstract-status').hidden=!state.abstractDetected;document.getElementById('ccs-status').hidden=!state.ccsConceptsDetected;const model=document.getElementById('model');model.textContent=state.modelLabel;model.title=state.modelDetail||state.modelLabel;shell.classList.toggle('streaming',state.streaming);translate.disabled=state.streaming||!state.sourceText;stop.disabled=!state.streaming}else if(message.type==='translationReset'){markdown=message.text||'';render()}else if(message.type==='translationDelta'){markdown+=message.delta;render()}else if(message.type==='translationDone'){markdown=message.text;render()}else if(message.type==='translationError'){document.getElementById('status').textContent=message.message}});
translate.addEventListener('click',()=>vscode.postMessage({type:'translate'}));stop.addEventListener('click',()=>vscode.postMessage({type:'stop'}));document.getElementById('copy').addEventListener('click',()=>vscode.postMessage({type:'copy'}));document.getElementById('clear').addEventListener('click',()=>vscode.postMessage({type:'clear'}));latex.addEventListener('change',()=>vscode.postMessage({type:'setLatexPreference',value:latex.checked}));autoFollow.addEventListener('change',()=>vscode.postMessage({type:'setAutoFollow',value:autoFollow.checked}));thinking.addEventListener('change',()=>vscode.postMessage({type:'setThinkingLevel',value:thinking.value}));vscode.postMessage({type:'ready'});
</script></body></html>`
    }
}
