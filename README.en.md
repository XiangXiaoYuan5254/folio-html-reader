# Folio · 页间

[中文](README.md) · English

A local workspace for reading HTML and PDF. Open a folder like an IDE, highlight, annotate, draw and take notes like a PDF reader, edit the HTML source, and bring your own AI to explain, translate and teach what you read.

Free and open source under the [MIT License](LICENSE). No account, and your files stay on your computer.

> The interface is currently in Chinese. Issues and pull requests in English are welcome.

![Folio reading an HTML document with highlights and the AI assistant](website/assets/hero.webp)

## Download

| Your computer | File |
| --- | --- |
| Mac with Apple silicon (M series), macOS 12+ | `Folio-<version>-mac-arm64.dmg` |
| Windows 10 / 11, 64-bit | `Folio-<version>-win-x64-setup.exe` |

Get the latest version from [Releases](https://github.com/XiangXiaoYuan5254/folio-html-reader/releases/latest) or the [website](https://helloxxy.com/works/folio/). The Mac app is signed with a Developer ID and notarized by Apple. The Windows installer is not code-signed yet: if SmartScreen says "Windows protected your PC", choose **More info → Run anyway**, and only for installers from this repository. Folio updates itself in the background.

## What it does

**Read and annotate**
- Open any folder of HTML and PDF files as a project, with tabs, search, drag-and-drop and a file tree.
- Highlight, underline, draw, erase, add sticky notes and text boxes, and keep notes beside the document. The original files are never changed: annotations live in a hidden `.html-reader` folder next to them.
- Read two documents side by side with optional synchronized scrolling, or switch to a distraction-free focus mode.
- PDF support through PDF.js: text selection, highlights, ink, sticky notes, page jumps, rotation and password-protected files.

**Edit HTML**
- A CodeMirror source editor with live preview, point-to-locate in the preview, autosave and version history you can preview and restore.

**AI, with your own provider**
- An assistant that answers questions about the document or the whole project, with citations that jump back to the source.
- Explain or translate a selection, translate a whole document, let AI highlight the key sentences, write close-reading notes, find papers (arXiv, OpenAlex, PubMed, Europe PMC) and edit the HTML source.
- **Whiteboard lessons**: select a passage, formula or figure and a teacher explains it on a whiteboard, with optional voice and a spoken conversation.
- Works with OpenAI-compatible APIs and Claude (DeepSeek, Kimi, Qwen, Doubao, GLM, MiniMax, Gemini, OpenRouter, SiliconFlow and more), a ChatGPT plan through Codex, a Kimi membership through Kimi Code, or local models with Ollama and LM Studio. You pay your provider directly; Folio is not in between.

**Make it yours**
- Ten interface themes, light and dark, optionally following the system.
- Optional plugins that let AI do a job on a schedule or at a click, such as a daily AI news digest. The Plugins page shows recommendations; downloads begin only when you click Download. No plugins are bundled with the app. Standalone ZIPs are also available on the [website](https://helloxxy.com/works/folio/plugins/). See [folio-plugins](https://github.com/XiangXiaoYuan5254/folio-plugins) for the manifest, script API, template and CLI (MIT).

![A whiteboard lesson explaining a passage](website/assets/board.webp)

## Community

Join the Chinese-language WeChat group to discuss Folio, share plugins and report issues.

<a href="https://helloxxy.com/works/folio/community/"><img src="https://helloxxy.com/works/folio/community/qr.jpg" width="300" alt="Folio WeChat community QR code" /></a>

QR codes expire. [Open the community page for the latest code](https://helloxxy.com/works/folio/community/), also available from **Settings → About → Join community** in the app.

## Privacy

Folio does not upload your documents and needs no account. Text is sent only to the AI provider you configure, when you use an AI feature, and you are asked before a provider is used for the first time. API keys stay in the app's data folder on your computer. Folio contacts helloxxy.com only to check for updates and read AI service announcements.

## Build from source

You need Node.js 22.13 or later (see `.nvmrc`). On macOS, the whiteboard's speech helper is built with the Xcode Command Line Tools.

```sh
npm ci
npm run dev        # Vite + Electron
npm run build      # type check and build
npm test           # unit tests
npm run test:pdf   # an end-to-end suite in real Electron (see package.json for the others)
```

`npm run pack` and `npm run dist:mac` sign and notarize with the maintainer's certificate. To build an unsigned app for yourself:

```sh
npm run build && node scripts/build-speech.mjs
npx electron-builder --mac dir -c.mac.identity=null -c.mac.notarize=false
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to report issues and send pull requests, and the [Chinese README](README.md#实现结构) for how the code is organized.

## License

[MIT](LICENSE). Third-party components keep their own licenses. The Windows speech recognition uses [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (Apache-2.0), [Silero VAD](https://github.com/snakers4/silero-vad) (MIT) and the [SenseVoice Small](https://github.com/FunAudioLLM/SenseVoice) model ([FunASR model license](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE), downloaded on first use).
