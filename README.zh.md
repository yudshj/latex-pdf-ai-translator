# LaTeX PDF AI Translator

[English](README.md) | 中文

这是一个独立的 VS Code 扩展，内置精简的 PDF.js viewer、支持 SyncTeX 的源码匹配和流式翻译侧栏，不依赖也不 fork LaTeX Workshop。在 PDF viewer 或配置允许的文本文件中选中文字时，会立即更新侧栏；在 macOS 连按两次 `Control+C`，或在 Windows/Linux 连按两次 `Alt+C`，即可开始翻译。也可以在设置中把快捷键次数改为三次。

请继续安装官方 `James-Yu.latex-workshop` 扩展，由它负责 LaTeX 工程识别、编译、诊断和编辑。本扩展只替换 PDF 查看路径，不替代 LaTeX Workshop 的写作功能。

## 已实现功能

- macOS 上的普通 `Command+C` 复制行为保持不变。翻译快捷键只读取 viewer 主动发送的选区事件，从不读取剪贴板。
- 新增活动栏翻译视图：操作按钮位于顶部，流式 Markdown 译文位于上方，当前原文位于下方。
- 在内置的 **PDF Translator Viewer** 中打开 PDF，并直接跟随选区事件。有 SyncTeX 数据时，扩展会在 SyncTeX 记录的 `.tex` 文件中保守匹配 PDF 选中文字，并把对应源码交给模型。
- 跟随配置允许的文本文件中的非空选区。`pdfTranslator.textSelectionPatterns` 是 JSON 列表，默认值为 `["*.tex"]`；需要时可加入 `"*.md"` 或 `"chapters/**/*.tex"` 等条目。
- 记住 **使用 LaTeX 源码** 的选择。当前选区无法映射时，该选项保持选中但暂时置灰；下一个可映射选区会自动恢复 LaTeX 模式。
- 支持 OpenAI Responses、OpenAI-compatible Chat Completions、Anthropic Messages 和旧式 Completions 请求格式。
- 获取 endpoint 的云端模型列表，并提供可搜索的选择器。
- 当 models endpoint 返回相应信息时，读取上下文长度、最大输出 token 数以及 text/image 输入模态。内置的 DeepSeek Harness 默认值也会把 `deepseek-flash` 识别为 1M 上下文的 text/image 模型，把 `deepseek-v4-pro` 识别为 1M 上下文的 text 模型。其他缺失字段显示为 `unknown`；无法自动取得最大输出 token 数时，使用 provider 默认值。
- 可通过 `PDF Translator: Set API Key Securely` 将密钥存入 VS Code SecretStorage；设置中也可使用明文密钥或 `${env:VARIABLE_NAME}`。
- 发送前修正常见的 PDF 换行，并自动把以中文为主的文本翻译成英文。
- 在 LaTeX 模式中要求模型理解 TeX、把每个源段落分别输出为 Markdown 段落；侧栏会在 token 到达时安全地渲染 Markdown。
- 识别文档摘要和 ACM CCS concepts，在状态栏显示识别结果，并把它们作为术语上下文交给模型，但不要求模型复述。
- DeepSeek-compatible thinking 默认设为 `Off`；侧栏可选择 `Off`、`Medium`、`High` 或 `Max`。

## 开发与运行

```sh
npm install
npm test
code .
```

在 VS Code 中按 `F5` 启动 Extension Development Host。使用 **PDF Translator Viewer** 打开 PDF，选中文字，然后在 macOS 连按两次 `Control+C`，或在 Windows/Linux 连按两次 `Alt+C`。

本地安装：

```sh
npm run package
code --install-extension latex-pdf-ai-translator-0.4.1.vsix --force
```

## 配置

运行 `PDF Translator: Open Settings`，然后设置：

- `pdfTranslator.endpointUrl`：例如 `https://api.deepseek.com` 的 base URL，或完整请求 URL。
- `pdfTranslator.apiStyle`：`responses`、`chat-completions`、`anthropic` 或 `completions`。
- `pdfTranslator.model`：直接填写 ID，或运行 `PDF Translator: Select Cloud Model`。
- `pdfTranslator.shortcutPressCount`：`2` 或 `3`。
- `pdfTranslator.textSelectionPatterns`：允许跟随的文件名或工作区相对路径 glob，例如 `["*.tex", "notes/*.md"]`。
- `pdfTranslator.thinkingLevel`：`off`、`medium`、`high` 或 `max`；默认 `off`，以缩短首 token 延迟。
- `pdfTranslator.maxOutputTokens`：设为 `0` 时采用 provider/model metadata 的自动行为。

公开的 OpenAI-compatible `GET /v1/models` 响应通常只包含模型 ID。OpenRouter 等信息更丰富的 provider 还可能返回上下文、输出和模态 metadata；本扩展会在这些字段存在时显示它们，而不会凭模型名称猜测。
如果 endpoint 没有实现模型列表路由，模型命令会回退到手动输入可搜索 ID。

## 架构说明

扩展拥有自己的精简 PDF.js custom editor，因此可以直接监听 `selectionchange`，无需访问其他扩展的 webview，也不读取剪贴板。扩展会使用选区文本，在相邻 `.synctex` 或 `.synctex.gz` 文件所记录的 `.tex` 文件中保守查找源码范围；确实无法映射时才回退到 PDF 纯文本。
