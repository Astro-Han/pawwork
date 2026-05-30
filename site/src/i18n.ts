// EN/CN copy dictionary: single source of truth.
// The server renders EN on first paint (basic SEO); the client swaps to the
// chosen language. Values carry a few inline tags (<b> <span> <u> <br>) and are
// injected as HTML.

export type Lang = "en" | "cn";

export type Dict = Record<string, string>;

export const I18N: Record<Lang, Dict> = {
  en: {
    brand: "PawWork",
    "nav.feat": "What it does",
    tag: "Open-source · Free to use",
    h1: 'Real work, done on your <span class="o">desktop</span>',
    sub: "<b>No terminal. No API key. No paid plan.</b> Open PawWork, choose a folder, and ask in plain language.",
    "dl.mac.t": "Download for macOS",
    "dl.mac.s": "Apple Silicon",
    "dl.intel.t": "macOS",
    "dl.intel.s": "Intel",
    "dl.win.t": "Windows",
    "dl.win.s": "x64",
    gh2: "On GitHub? <u>Grab the latest release →</u>",
    wnote:
      '<b>Windows:</b> If SmartScreen shows a warning on first launch, click "More info" → "Run anyway". The macOS build is signed and notarized — just open and go.',
    shotnote: "Illustration, not a screenshot",
    "mock.title": "PawWork — new task",
    "mock.you": "Turn these 12 invoices into a spreadsheet I can review.",
    "mock.ch": "Working on it…",
    "mock.s1": "Read 12 PDFs",
    "mock.s2": "Extracted vendor, date, total",
    "mock.s3": "Building spreadsheet…",
    "mock.rd": "ready to review",
    "cap1.h": "Documents & data",
    "cap1.p": "Extract invoice fields into a spreadsheet, generate a CSV summary, merge multiple PDFs.",
    "cap2.h": "Research & writing",
    "cap2.p": "Search the web, compare multiple pages and compile a memo, turn rough notes into a clean draft.",
    "cap3.h": "Code & technical",
    "cap3.p": "Understand a codebase, review a pull request, debug issues using logs and source code.",
    foot: "Apache-2.0 · Built on OpenCode",
  },
  cn: {
    brand: "爪印",
    "nav.feat": "功能",
    tag: "开源 · 下载即用",
    h1: '<span class="o">真能干活</span>，<br>跑在你电脑上',
    sub: "<b>不用终端，不用 API key，不用付费。</b>打开爪印，选个文件夹，直接告诉它你要什么。",
    "dl.mac.t": "下载 macOS 版",
    "dl.mac.s": "Apple 芯片",
    "dl.intel.t": "macOS",
    "dl.intel.s": "Intel",
    "dl.win.t": "Windows",
    "dl.win.s": "x64",
    gh2: "有 GitHub？<u>去 Releases 下最新版 →</u>",
    wnote:
      "<b>Windows 用户</b>首次打开时如果弹出 SmartScreen 提示，点「更多信息」→「仍要运行」。macOS 版已签名公证，不会出现此提示。",
    shotnote: "示意，非实拍",
    "mock.title": "爪印 — 新任务",
    "mock.you": "帮我把这 12 张发票整理成一张表格，方便逐笔核对。",
    "mock.ch": "正在处理…",
    "mock.s1": "读完 12 个 PDF",
    "mock.s2": "抽出供应商、日期、金额",
    "mock.s3": "正在生成表格…",
    "mock.rd": "待核对",
    "cap1.h": "文档与数据",
    "cap1.p": "从发票提取信息填入表格、为 CSV 生成摘要、合并多个 PDF。",
    "cap2.h": "研究与写作",
    "cap2.p": "上网查资料、对比多篇网页整理成备忘、把零散笔记写成一篇稿子。",
    "cap3.h": "代码与技术",
    "cap3.p": "理解一个项目、review 他人的 PR、根据日志和源码定位错误。",
    foot: "Apache-2.0 · 基于 OpenCode",
  },
};
