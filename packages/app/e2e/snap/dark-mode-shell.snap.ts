import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Three-column shell in dark mode: sidebar / center thread / right panel all
// share `--bg-base` (canvas) post-collapse and rely on 1px hairline borders to
// separate. This target stresses that exact claim — if the borders dissolve at
// 6% white alpha, you'll see no division between columns.

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const SHELL_HTML = `
<style>
  body {
    margin: 0;
    background: var(--bg-base);
    color: var(--fg-strong);
    font-family: var(--font-family-sans);
    font-size: 13px;
    height: 100vh;
    overflow: hidden;
  }
  .frame {
    height: 100vh;
    display: grid;
    grid-template-rows: 32px 1fr;
    grid-template-columns: 248px 1fr 320px;
    grid-template-areas:
      "tb-l tb-c tb-r"
      "side center rpane";
    background: var(--bg-base);
  }
  .tb { display: flex; align-items: center; gap: 12px; padding: 0 8px; color: var(--fg-weak); font-size: 12px; border-bottom: 1px solid var(--border-weaker); }
  .tb-l { grid-area: tb-l; background: var(--sidebar); border-right: 1px solid var(--border-weaker); }
  .tb-c { grid-area: tb-c; padding: 0 16px; color: var(--fg-strong); }
  .tb-r { grid-area: tb-r; border-left: 1px solid var(--border-weaker); }
  .tb-c .seg { color: var(--fg-strong); }
  .tb-c .sep { color: var(--fg-weak); }

  .side { grid-area: side; background: var(--sidebar); border-right: 1px solid var(--border-weaker); padding: 8px; overflow-y: hidden; }
  .side .top { display: flex; gap: 6px; padding: 4px; }
  .side .top .btn { flex: 1; height: 30px; border-radius: 10px; background: var(--surface-raised); border: 1px solid var(--border-weak); display: flex; align-items: center; padding: 0 10px; color: var(--fg-strong); font-size: 13px; gap: 6px; }
  .side .label { color: var(--fg-weak); font-size: 11px; padding: 12px 10px 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .side .row { height: 30px; padding: 0 10px; border-radius: 6px; display: flex; align-items: center; gap: 8px; color: var(--fg-strong); font-size: 13px; }
  .side .row .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .side .row .meta { color: var(--fg-weak); font-size: 11px; }
  .side .row.active { background: var(--row-active-overlay); font-weight: 500; }
  .side .row.hover { background: var(--row-hover-overlay); }
  .side .row .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--brand-primary); }
  .side .row .icon { width: 16px; height: 16px; border-radius: 3px; background: var(--fg-weak); opacity: 0.45; }

  .center { grid-area: center; background: var(--bg-base); display: flex; flex-direction: column; overflow: hidden; }
  .center .stream { flex: 1; padding: 24px 32px; overflow-y: hidden; display: flex; flex-direction: column; gap: 12px; }
  .msg-user { align-self: flex-end; max-width: 70%; background: var(--surface-raised); padding: 8px 12px; border-radius: 12px; border-bottom-right-radius: 4px; font-size: 13px; }
  .msg-a { align-self: flex-start; max-width: 88%; font-size: 13px; line-height: 1.7; }
  .msg-a code { font-family: var(--font-family-mono); background: var(--code-surface); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
  .tool-head { display: flex; align-items: center; gap: 8px; color: var(--fg-strong); padding: 4px 0; }
  .tool-head .meta { margin-left: auto; color: var(--fg-weak); font-family: var(--font-family-mono); font-size: 11px; }
  .tool-body { border: 1px solid var(--border-weak); border-radius: 6px; padding: 8px 10px; font-family: var(--font-family-mono); font-size: 12px; color: var(--fg-weak); }
  .fence { background: var(--code-surface); border-radius: 10px; padding: 10px 14px; font-family: var(--font-family-mono); font-size: 12px; line-height: 1.6; }
  .fence .ln { color: var(--fg-weak); margin-right: 12px; user-select: none; }
  .fence .kw { color: var(--syntax-keyword, var(--fg-weak)); }
  .fence .str { color: var(--syntax-string, #00ceb9); }

  .center .dock-wrap { padding: 0 32px 20px; }
  .dock { background: var(--surface-raised); border-radius: 14px; padding: 14px 16px 12px; box-shadow: 0 0 0 1px rgba(255,255,255,0.18), 0 4px 12px rgba(0,0,0,0.3); }
  .dock .input { color: var(--fg-strong); font-size: 13px; min-height: 56px; }
  .dock .input .ph { color: var(--fg-weak); }
  .dock .bar { display: flex; align-items: center; gap: 10px; }
  .dock .bar .meta { margin-left: auto; color: var(--fg-weak); font-size: 12px; }
  .dock .bar .pill { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-strong); font-size: 12px; padding: 0 8px; height: 26px; border-radius: 6px; }
  .dock .bar .pill:hover { background: var(--row-hover-overlay); }

  .rpane { grid-area: rpane; background: var(--bg-base); border-left: 1px solid var(--border-weaker); display: flex; flex-direction: column; overflow: hidden; }
  .rpane .tabs { display: flex; gap: 6px; padding: 0 4px; height: 48px; align-items: center; border-bottom: 1px solid var(--border-weaker); }
  .rpane .tab { padding: 0 8px; height: 30px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-weak); border-radius: 6px; }
  .rpane .tab.active { color: var(--fg-strong); font-weight: 500; position: relative; }
  .rpane .tab.active::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 1px; background: var(--brand-primary); }
  .rpane .section { padding: 16px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--border-weaker); }
  .rpane .sec-title { font-size: 11px; color: var(--fg-weak); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .rpane .meta-row { display: flex; align-items: center; gap: 8px; height: 26px; font-size: 13px; color: var(--fg-strong); }
  .rpane .meta-row .glyph { width: 14px; height: 14px; border-radius: 3px; background: var(--fg-weak); opacity: 0.4; }
  .rpane .meta-row .right { margin-left: auto; color: var(--fg-weak); font-family: var(--font-family-mono); font-size: 11px; }
  .rpane .todos { display: flex; flex-direction: column; gap: 6px; }
  .rpane .todo { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-strong); }
  .rpane .todo .mark { width: 13px; height: 13px; border-radius: 999px; border: 1px solid var(--fg-weak); display: inline-block; flex-shrink: 0; }
  .rpane .todo.done .mark { background: var(--fg-weak); border-color: var(--fg-weak); }
  .rpane .todo.doing .mark { border: 2px solid var(--brand-primary); border-right-color: transparent; }
  .rpane .todo.skip { color: var(--fg-weak); text-decoration: line-through; }
</style>

<div class="frame">
  <div class="tb tb-l"><span>○ ○ ○</span></div>
  <div class="tb tb-c">
    <span class="seg">dark mode redesign</span>
    <span class="sep">/</span>
    <span class="seg">pawwork</span>
    <span class="sep">/</span>
    <span class="seg">claude/dark-mode-2-surface</span>
  </div>
  <div class="tb tb-r"><span style="margin-left:auto;color:var(--fg-weak);font-size:12px;">overview · context · review</span></div>

  <div class="side">
    <div class="top">
      <div class="btn"><span style="opacity:0.6;">＋</span> 新会话</div>
      <div class="btn" style="flex:0 0 32px; padding:0; justify-content:center;">⌕</div>
    </div>
    <div class="label">PINNED</div>
    <div class="row hover"><span class="icon"></span><span class="name">深色模式重塑</span><span class="meta">12:04</span></div>
    <div class="label">SESSIONS</div>
    <div class="row active"><span class="icon"></span><span class="name">theme.css 两段同步</span><span class="meta">now</span></div>
    <div class="row"><span class="icon"></span><span class="name">preview HTML 7 档对比</span><span class="meta">14:32</span></div>
    <div class="row"><span class="icon"></span><span class="name">STATUS.md 同步</span><span class="dot"></span></div>
    <div class="row"><span class="icon"></span><span class="name">release notes 拟稿</span><span class="meta">昨</span></div>
    <div class="row"><span class="icon"></span><span class="name">设计真值回写</span><span class="meta">2 天</span></div>
    <div class="row"><span class="icon"></span><span class="name">视觉验证 snap</span><span class="meta">2 天</span></div>
    <div class="row"><span class="icon"></span><span class="name">浅色模式 follow-up</span><span class="meta">3 天</span></div>
  </div>

  <div class="center">
    <div class="stream">
      <div class="msg-user">把深色模式重新设计成更克制的版本，token 数量能砍多少砍多少。</div>
      <div class="msg-a">已经把 dark 下 15 个色 token 塌缩到 5 个核心色：<code>canvas #1a1917</code>、<code>raised #262523</code>、<code>fg #ebe7e0</code>、<code>fg-weak #7e7872</code>、<code>border rgba(255,255,255,0.06)</code>。Token 名都保留了，浅色模式不受影响。</div>
      <div class="tool-head"><span style="opacity:0.6;">📂</span> read <span style="color:var(--fg-weak);">packages/ui/src/styles/theme.css</span><span class="meta">2.4kb · 12ms</span></div>
      <div class="tool-body">L284-422 explicit dark block + L432-560 @media mirror, both sync. Parity test passes.</div>
      <div class="msg-a">关键的色塌缩规则：<br />sidebar / bg-base / surface-base / surface-sunken / bg-cream → <code>canvas</code><br />surface-raised → 新的 <code>raised</code>（从 #3a3431 收敛 50%）<br />fg-strong / fg-base → <code>fg</code>，fg-weak / fg-weaker → <code>fg-weak</code><br />border-base / weak / weaker → 同一档 6% 白 alpha</div>
      <div class="fence">
<span class="ln">1</span><span class="kw">const</span> palette = {<br />
<span class="ln">2</span>&nbsp;&nbsp;canvas: <span class="str">"#1a1917"</span>,&nbsp;&nbsp;<span style="color:var(--fg-weak);">/* R-B=3 */</span><br />
<span class="ln">3</span>&nbsp;&nbsp;raised: <span class="str">"#262523"</span>,<br />
<span class="ln">4</span>}</div>
    </div>
    <div class="dock-wrap">
      <div class="dock">
        <div class="input"><span class="ph">问点什么 · / for commands</span></div>
        <div class="bar">
          <span class="pill">claude-haiku-4-5 · think</span>
          <span class="pill">build</span>
          <span class="meta">⌘↵ 发送</span>
        </div>
      </div>
    </div>
  </div>

  <div class="rpane">
    <div class="tabs">
      <span class="tab active">overview</span>
      <span class="tab">context</span>
      <span class="tab">review</span>
    </div>
    <div class="section">
      <div class="sec-title">progress</div>
      <div class="todos">
        <div class="todo done"><span class="mark"></span>读 DESIGN.md 深色章节</div>
        <div class="todo done"><span class="mark"></span>theme.css 两段塌缩</div>
        <div class="todo done"><span class="mark"></span>pawwork.json + parity</div>
        <div class="todo doing"><span class="mark"></span>snap 多角度截图</div>
        <div class="todo"><span class="mark"></span>回写 DESIGN.md</div>
        <div class="todo skip"><span class="mark"></span>浅色（不在本 PR）</div>
      </div>
    </div>
    <div class="section">
      <div class="sec-title">branch</div>
      <div class="meta-row"><span class="glyph"></span>claude/dark-mode-2-surface<span class="right"></span></div>
      <div class="meta-row"><span class="glyph"></span>dark-mode-2-surface<span class="right">worktree</span></div>
      <div class="meta-row"><span class="glyph"></span>pawwork<span class="right"></span></div>
    </div>
    <div class="section">
      <div class="sec-title">sources</div>
      <div class="meta-row"><span class="glyph"></span>docs/design/scratch/dark-redesign-handoff.md</div>
      <div class="meta-row"><span class="glyph"></span>packages/ui/src/styles/theme.css</div>
    </div>
  </div>
</div>
`

async function mountShell(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((html) => {
    document.body.innerHTML = html
  }, SHELL_HTML)
  await page.locator(".frame").waitFor({ state: "visible", timeout: 10_000 })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))))
}

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim()
      return value.length > 0
    },
    null,
    { timeout: 30_000 },
  )
}

test("dark-mode-shell", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await mountShell(page)
  const lightShot: Shot = {
    name: "light",
    buf: await page.locator(".frame").screenshot(),
  }

  await applyDarkModeForTests(page)
  await waitForThemeBoot(page)
  await mountShell(page)
  const darkShot: Shot = {
    name: "dark",
    buf: await page.locator(".frame").screenshot(),
  }

  const out = snapOutputPath("dark-mode-shell")
  await composeGrid([lightShot, darkShot], out, { cols: 1 })
  process.stdout.write(`\n[snap] dark-mode-shell grid -> ${out}\n\n`)
})
