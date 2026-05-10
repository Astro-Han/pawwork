// @ts-nocheck
import * as mod from "./markdown"
import { create } from "../storybook/scaffold"
import { markdown } from "../storybook/fixtures"

const docs = `### Overview
Render sanitized Markdown with code blocks, inline code, and safe links.

W3 lock 2026-05-10 (see docs/design/preview/markdown-body.html · STANDARDS.md#L43).

### Variants
- **Basic** — kitchen-sink fixture
- **W3.Headings** — H1-H4 G mapping (all 13px sans, hierarchy via fg color + margin)
- **W3.LinksInkOnly** — quiet underline, hover currentColor, focus brand ring
- **W3.TaskList** — 16px circle / circle-check svg, read-only
- **W3.Blockquote** — 2px border-weak left rule + fg-weak text (Markdown 行业惯例,非 BAN 1 彩条)
- **W3.Table** — \`th data-numeric="true"\` for tabular-nums + right align
- **W3.Details** — chev rotates 90deg on open
- **W3.Math** — inline + block KaTeX
- **W3.HtmlWhitelist** — sub/sup/kbd/abbr/del; script/iframe stripped
`

const story = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: markdown,
  },
})

const fixtures = {
  headings: [
    "# H1 章节标题",
    "正文段落示意。",
    "## H2 子章节",
    "fg-strong 同 H1, mt 减档区分。",
    "### H3 三级",
    "fg-base 弱一档。",
    "#### H4 四级",
    "fg-weak 最弱; agent 极少出现。",
  ].join("\n"),
  links: [
    "agent 输出常见三类链接",
    "",
    "外部: 见 [PawWork 仓库](https://github.com/Astro-Han/pawwork)",
    "",
    "本地: 配置在 [packages/ui/src/components/markdown.tsx](packages/ui/src/components/markdown.tsx)",
    "",
    "锚点: 跳到 [#section](#section)",
  ].join("\n"),
  tasks: [
    "## 任务清单",
    "",
    "- [x] 起 worktree",
    "- [x] 写施工计划",
    "- [ ] 跑 /crosscheck",
    "- [ ] 开 PR",
  ].join("\n"),
  blockquote: [
    "> 引用语段用 2px border-weak 左竖线 + fg-weak 字色, 无背景。",
    ">",
    "> 中性灰左线是 Markdown 行业惯例 (GitHub / Tailwind prose / Notion / shadcn), 不属 BAN 1 彩条。",
    "",
    "正文继续。",
  ].join("\n"),
  table: [
    "| 文件 | 行数 | 增删 |",
    "| --- | ---: | ---: |",
    "| markdown.css | 340 | +225 -151 |",
    "| markdown.tsx | 510 | +123 -2 |",
    "| theme.css | 1 | +1 -1 |",
  ].join("\n"),
  details: [
    "<details><summary><svg class='chev' viewBox='0 0 16 16' aria-hidden='true'><path d='M6 4l4 4-4 4' fill='none' stroke='currentColor' stroke-linecap='round' stroke-linejoin='round'/></svg>调试日志</summary>",
    "",
    "默认折叠, 点开看明细。chev 旋转 90deg。",
    "",
    "</details>",
  ].join("\n"),
  math: [
    "Inline 数学: $E = mc^2$ 出现在句中。",
    "",
    "Block 公式独立成段:",
    "",
    "$$",
    "G = \\frac{\\sum |x_i - x_j|}{2 n^2 \\mu}",
    "$$",
  ].join("\n"),
  htmlWhitelist: [
    "白名单: <sub>2</sub>O / <sup>2</sup> / <kbd>Cmd</kbd> / <abbr title='Application Programming Interface'>API</abbr> / <del>1.5</del>",
    "",
    "<script>alert(1)</script><iframe src='x'></iframe>",
    "",
    "上面 script/iframe 被 DOMPurify 砍掉, 不渲染。",
  ].join("\n"),
}

export default {
  title: "UI/Markdown",
  id: "components-markdown",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic
export const W3Headings = { ...story.Basic, args: { text: fixtures.headings } }
export const W3LinksInkOnly = { ...story.Basic, args: { text: fixtures.links } }
export const W3TaskList = { ...story.Basic, args: { text: fixtures.tasks } }
export const W3Blockquote = { ...story.Basic, args: { text: fixtures.blockquote } }
export const W3Table = { ...story.Basic, args: { text: fixtures.table } }
export const W3Details = { ...story.Basic, args: { text: fixtures.details } }
export const W3Math = { ...story.Basic, args: { text: fixtures.math } }
export const W3HtmlWhitelist = { ...story.Basic, args: { text: fixtures.htmlWhitelist } }
