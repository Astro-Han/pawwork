import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Tour of every dark-mode surface the 2-surface collapse touches: canvas /
// raised / fg / fg-weak / border / brand. Injects static HTML against the real
// CSS pipeline (same trick worktree-tooltip uses) so we can compare light and
// dark side-by-side without spinning up backend state or LLM mocks.

test.use({ viewport: { width: 1280, height: 1600 }, deviceScaleFactor: 2 })

const TOUR_HTML = `
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 32px;
    background: var(--bg-base);
    color: var(--fg-strong);
    font-family: var(--font-family-sans);
    font-size: 13px;
    line-height: 1.6;
    min-height: 100vh;
  }
  .tour {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 24px;
    max-width: 1216px;
    margin: 0 auto;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 18px;
    background: var(--bg-base);
    border: 1px solid var(--border-weak);
    border-radius: 14px;
  }
  .panel.canvas { background: var(--bg-base); }
  .panel.raised { background: var(--surface-raised); }
  .panel.sidebar { background: var(--sidebar); }
  .panel-title {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    color: var(--fg-weak);
    margin-bottom: 4px;
  }
  .panel-sub { font-size: 12px; color: var(--fg-weak); }

  /* — message timeline mock — */
  .timeline { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
  .msg-user {
    align-self: flex-end;
    max-width: 78%;
    background: var(--surface-raised);
    padding: 8px 12px;
    border-radius: 12px;
    border-bottom-right-radius: 4px;
    color: var(--fg-strong);
    font-size: 13px;
  }
  .msg-assist { align-self: flex-start; max-width: 92%; color: var(--fg-strong); font-size: 13px; }
  .msg-assist code {
    font-family: var(--font-family-mono);
    background: var(--code-surface);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
  }

  /* — fence code block — */
  .fence {
    background: var(--code-surface);
    border-radius: 10px;
    padding: 10px 14px;
    font-family: var(--font-family-mono);
    font-size: 12px;
    color: var(--fg-strong);
    line-height: 1.5;
  }
  .fence .ln { color: var(--fg-weak); margin-right: 12px; user-select: none; }
  .fence .kw { color: var(--syntax-keyword, var(--fg-weak)); }
  .fence .str { color: var(--syntax-string, #00ceb9); }
  .fence .ty { color: var(--syntax-type, #ecf58c); }
  .fence .com { color: var(--syntax-comment, var(--fg-weak)); }

  /* — tool card — */
  .tool { display: flex; flex-direction: column; gap: 4px; }
  .tool .head {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 0;
    color: var(--fg-strong);
    font-size: 13px;
  }
  .tool .head .meta { margin-left: auto; color: var(--fg-weak); font-family: var(--font-family-mono); font-size: 11px; }
  .tool .body {
    border: 1px solid var(--border-weak);
    border-radius: 6px;
    padding: 8px 10px;
    font-family: var(--font-family-mono);
    font-size: 12px;
    color: var(--fg-weak);
    line-height: 1.5;
  }

  /* — sidebar rows — */
  .rows { display: flex; flex-direction: column; }
  .row {
    display: flex; align-items: center; gap: 8px;
    height: 30px; padding: 0 10px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--fg-strong);
  }
  .row .right { margin-left: auto; color: var(--fg-weak); font-size: 12px; }
  .row.hover { background: var(--row-hover-overlay); }
  .row.active { background: var(--row-active-overlay); color: var(--fg-strong); font-weight: 500; }
  .row.unread .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--brand-primary); }
  .row .icon { width: 16px; height: 16px; border-radius: 3px; background: var(--fg-weak); opacity: 0.5; }

  /* — diff — */
  .diff { font-family: var(--font-family-mono); font-size: 12px; line-height: 1.55; }
  .diff .ln { color: var(--fg-weak); margin-right: 12px; width: 24px; text-align: right; display: inline-block; }
  .diff .add { background: var(--diff-add); display: block; padding: 0 4px; }
  .diff .del { background: var(--diff-del); display: block; padding: 0 4px; }
  .diff .ctx { display: block; padding: 0 4px; color: var(--fg-strong); }

  /* — buttons — */
  .btn-row { display: flex; gap: 8px; align-items: center; }
  .btn {
    height: 30px;
    padding: 0 14px;
    border-radius: 10px;
    border: 1px solid var(--border-base);
    background: var(--surface-base);
    color: var(--fg-strong);
    font-size: 13px;
    font-weight: 500;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .btn.primary {
    background: var(--brand-primary);
    color: #fff;
    border-color: var(--brand-primary);
  }
  .btn.ghost { background: transparent; border-color: transparent; color: var(--fg-strong); }
  .kbd {
    font-family: var(--font-family-mono);
    font-size: 11px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 6px;
    background: var(--bg-base);
    border: 1px solid var(--border-weak);
    box-shadow: 0 1px 0 rgba(0,0,0,0.18);
    color: var(--fg-strong);
  }
  .dark-kbd-fix .kbd { background: var(--surface-raised); box-shadow: 0 1px 0 rgba(0,0,0,0.38); }

  /* — picker item / command palette row — */
  .picker { background: var(--surface-base); border: 1px solid var(--border-base); border-radius: 10px; padding: 4px; box-shadow: var(--ring-base); }
  .picker .item { height: 30px; padding: 0 8px; border-radius: 6px; display: flex; align-items: center; gap: 8px; color: var(--fg-strong); }
  .picker .item.hover { background: var(--row-hover-overlay); }
  .picker .item.selected { background: var(--surface-interactive-base); font-weight: 500; }
  .picker .item.selected .glyph { color: var(--brand-primary); }
  .picker .item .glyph { font-family: var(--font-family-mono); font-size: 11px; color: var(--fg-weak); margin-left: auto; }

  /* — dialog — */
  .dialog {
    background: var(--surface-raised);
    border-radius: 14px;
    padding: 20px 24px;
    width: 360px;
    box-shadow: 0 16px 48px rgba(0,0,0,0.4);
  }
  .dialog .title { font-size: 16px; font-weight: 500; margin-bottom: 6px; }
  .dialog .body { color: var(--fg-strong); font-size: 13px; line-height: 1.6; }
  .dialog .footer { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

  /* — switch — */
  .switch { width: 32px; height: 18px; border-radius: 999px; background: rgba(0,0,0,0.16); display: inline-flex; align-items: center; padding: 2px; }
  .switch.on { background: var(--brand-primary); justify-content: flex-end; }
  .switch .thumb { width: 14px; height: 14px; border-radius: 999px; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.18); }

  /* — text hierarchy — */
  .text-strong { color: var(--fg-strong); }
  .text-weak { color: var(--fg-weak); }

  /* — todo dots — */
  .todos { display: flex; flex-direction: column; gap: 6px; }
  .todo { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--fg-strong); }
  .todo .mark { width: 13px; height: 13px; border-radius: 999px; border: 1px solid var(--fg-weak); display: inline-block; }
  .todo.done .mark { background: var(--fg-weak); border-color: var(--fg-weak); }
  .todo.doing .mark { border: 2px solid rgba(255,255,255,0.0); box-shadow: inset 0 0 0 1px var(--brand-primary); border-top-color: var(--brand-primary); }
  .todo.skip { color: var(--fg-weak); text-decoration: line-through; }

  /* — chip / pill — */
  .chip { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 6px; border: 0.5px solid var(--border-weak); color: var(--fg-strong); font-size: 13px; }
  .pill.success { background: var(--success-bg); color: var(--success-text); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
  .pill.error { background: var(--error-bg); color: var(--error-text); padding: 1px 6px; border-radius: 6px; font-size: 12px; }
  .pill.warning { background: var(--warning-bg); color: var(--warning-text); padding: 1px 6px; border-radius: 6px; font-size: 12px; }

  /* — composer / dock — */
  .dock {
    background: var(--surface-raised);
    border-radius: 14px;
    padding: 14px 16px 12px;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.18), 0 4px 12px rgba(0,0,0,0.3);
  }
  .light-mode .dock { box-shadow: var(--ring-base), 0 6px 24px rgba(0,0,0,0.06); background: var(--bg-base); }
  .dock .input { color: var(--fg-strong); font-size: 13px; min-height: 56px; }
  .dock .input .ph { color: var(--fg-weak); }
  .dock .bar { display: flex; align-items: center; gap: 8px; }
  .dock .bar .meta { margin-left: auto; color: var(--fg-weak); font-size: 12px; }
</style>
<div class="tour">

  <div class="panel canvas">
    <div class="panel-title">Timeline · canvas</div>
    <div class="timeline">
      <div class="msg-user">能帮我把暗色模式重新设计一下吗？</div>
      <div class="msg-assist">已经把生产版六层 warm-coffee 塌缩到两层 surface（<code>canvas</code> + <code>raised</code>），暖度落在 R-B=3。新色号已经写进 theme.css 双块。</div>
      <div class="msg-user">看上去更克制了，符合"克制的暖中性"。</div>
      <div class="msg-assist">下一步跑 snap 看视觉，再回写 DESIGN.md。</div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Tool card · transparent on canvas</div>
    <div class="tool">
      <div class="head">📂 read <span class="text-weak">packages/ui/src/styles/theme.css</span><span class="meta">2.4kb · 12ms</span></div>
      <div class="body">
        :root[data-color-scheme="dark"] {<br />
        &nbsp;&nbsp;--bg-base: #1a1917;<br />
        &nbsp;&nbsp;--surface-raised: #262523;<br />
        &nbsp;&nbsp;...<br />
        }
      </div>
    </div>
    <div class="tool">
      <div class="head">🔧 edit <span class="text-weak">+12 −18</span><span class="meta">26ms</span></div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Fence code · alpha overlay</div>
    <div class="fence">
<span class="ln">1</span><span class="com">// 砍到 5 个核心 token</span><br />
<span class="ln">2</span><span class="kw">const</span> <span class="ty">dark</span> = {<br />
<span class="ln">3</span>&nbsp;&nbsp;canvas: <span class="str">"#1a1917"</span>,<br />
<span class="ln">4</span>&nbsp;&nbsp;raised: <span class="str">"#262523"</span>,<br />
<span class="ln">5</span>&nbsp;&nbsp;fg: <span class="str">"#ebe7e0"</span>,<br />
<span class="ln">6</span>&nbsp;&nbsp;fgWeak: <span class="str">"#7e7872"</span>,<br />
<span class="ln">7</span>&nbsp;&nbsp;border: <span class="str">"rgba(255,255,255,0.06)"</span>,<br />
<span class="ln">8</span>}<br />
      </div>
  </div>

  <div class="panel sidebar">
    <div class="panel-title">Sidebar rows · canvas</div>
    <div class="rows">
      <div class="row"><span class="icon"></span><span>dark mode redesign</span><span class="right">2 分</span></div>
      <div class="row active"><span class="icon"></span><span>theme.css 重构</span><span class="right">now</span></div>
      <div class="row hover"><span class="icon"></span><span>preview HTML 更新</span><span class="right">14:32</span></div>
      <div class="row unread"><span class="icon"></span><span>STATUS.md 同步</span><span class="dot"></span></div>
      <div class="row"><span class="icon"></span><span>release notes 拟稿</span><span class="right">昨天</span></div>
      <div class="row"><span class="icon"></span><span>视觉走查</span><span class="right">3 天</span></div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Diff · semantic alpha</div>
    <div class="diff">
      <span class="ctx"><span class="ln">12</span>&nbsp;&nbsp;--bg-cream: #211d19;</span>
      <span class="del"><span class="ln">−</span>&nbsp;&nbsp;--surface-raised: #3a3431;</span>
      <span class="add"><span class="ln">+</span>&nbsp;&nbsp;--surface-raised: #262523;</span>
      <span class="ctx"><span class="ln">13</span>&nbsp;&nbsp;--surface-sunken: #16130f;</span>
      <span class="del"><span class="ln">−</span>&nbsp;&nbsp;--border-weak: #36322e;</span>
      <span class="add"><span class="ln">+</span>&nbsp;&nbsp;--border-weak: rgba(255, 255, 255, 0.06);</span>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Controls · buttons + kbd + switch</div>
    <div class="btn-row dark-kbd-fix">
      <button class="btn primary">运行 <span class="kbd">⌘↵</span></button>
      <button class="btn">取消</button>
      <button class="btn ghost">编辑</button>
      <span class="switch on"><span class="thumb"></span></span>
      <span class="switch"><span class="thumb"></span></span>
    </div>
    <div class="btn-row" style="margin-top:8px;">
      <span class="chip">npm</span>
      <span class="pill success">passed</span>
      <span class="pill error">failed</span>
      <span class="pill warning">flaky</span>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Picker · popover + selected</div>
    <div class="picker">
      <div class="item">claude-opus-4-7 <span class="glyph">opus</span></div>
      <div class="item hover">claude-sonnet-4-6 <span class="glyph">sonnet</span></div>
      <div class="item selected">claude-haiku-4-5 <span class="glyph">haiku</span></div>
      <div class="item">gpt-5</div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Dialog · raised on canvas</div>
    <div class="dialog">
      <div class="title">删除会话？</div>
      <div class="body">"dark mode redesign" 将被永久删除，包括 47 条消息和 12 个 tool call。<br /><span class="text-weak">这个操作不可恢复。</span></div>
      <div class="footer">
        <button class="btn ghost">取消</button>
        <button class="btn" style="background: var(--error); color: #fff; border-color: var(--error);">删除</button>
      </div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Todo · status family</div>
    <div class="todos">
      <div class="todo done"><span class="mark"></span>读 DESIGN.md 深色章节</div>
      <div class="todo done"><span class="mark"></span>测量参考产品色阶</div>
      <div class="todo doing"><span class="mark"></span>跑 snap 多角度</div>
      <div class="todo"><span class="mark"></span>回写 DESIGN.md</div>
      <div class="todo skip"><span class="mark"></span>浅色模式（不在本 PR）</div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Composer dock · raised on canvas</div>
    <div class="dock">
      <div class="input"><span class="ph">问点什么 · / for commands</span></div>
      <div class="bar">
        <span class="text-weak">claude-haiku-4-5 · think</span>
        <span class="meta">⌘↵ 发送</span>
      </div>
    </div>
  </div>

  <div class="panel canvas">
    <div class="panel-title">Type hierarchy</div>
    <div style="font-size: 20px; font-weight: 500;" class="text-strong">爪印 · 克制的暖中性</div>
    <div class="text-strong">主字 fg-strong：放置标题和高对比正文，是阅读的主轴。</div>
    <div class="text-strong">正文 fg-base：dark 下与 fg-strong 塌缩为同一色 #ebe7e0，避免文字落入背景。</div>
    <div class="text-weak">弱字 fg-weak：时间、元信息、说明性 caption；dark 下与 fg-weaker 合并为 #7e7872。</div>
    <div class="text-weak">这一段是弱字示例，可以看到与主字的关系是"主导 + 退让"，而不是"四档渐变"。</div>
  </div>

</div>
`

async function mountTour(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((html) => {
    document.body.innerHTML = html
  }, TOUR_HTML)
  await page.locator(".tour").waitFor({ state: "visible", timeout: 10_000 })
  // Give layout one paint frame so panel heights settle.
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

test("dark-mode-tour", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await mountTour(page)
  await page.evaluate(() => document.body.classList.add("light-mode"))
  const lightShot: Shot = {
    name: "light",
    buf: await page.locator(".tour").screenshot(),
  }

  await applyDarkModeForTests(page)
  await waitForThemeBoot(page)
  await mountTour(page)
  const darkShot: Shot = {
    name: "dark",
    buf: await page.locator(".tour").screenshot(),
  }

  const out = snapOutputPath("dark-mode-tour")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] dark-mode-tour grid -> ${out}\n\n`)
})
