window.__ModuleLoader__.load({
  id: "@pawwork/dsh-product",
  factory: (require) => {
    const { createElement, useEffect, useRef } = require("react")
    const h = createElement

    const productCss = `
/* 无边框窗口里没有原生标题栏可抓，这条顶带是窗口唯一的拖拽区；它同时替原生窗口
   控件（macOS 交通灯、Windows overlay 按钮）占住它们画进内容坐标系的那一行。
   Windows 由 Chromium 自己把 overlay 的真实几何写进 env(titlebar-area-*)，全屏和
   DPI 缩放都跟着走；macOS 没有这个原语（titleBarOverlay 在那边不生效），由主进程
   发布 --pawwork-titlebar-host-height。两个变量角色不同：host 的是宿主给的值，
   下面这一行把它解析成最终值 —— 用 var() 的回退链而不是靠样式表顺序或选择器权重
   压过彼此，注入时机和插入位置都不再影响结果。Linux 保留系统标题栏，两边都不给，
   回退到 0px 自动失效。所有需要让位的规则都读解析后的那一个变量。 */
:root { --pawwork-titlebar-height: var(--pawwork-titlebar-host-height, env(titlebar-area-height, 0px)); }
#root { box-sizing: border-box; padding-top: var(--pawwork-titlebar-height, 0px); }
.pawwork-titlebar {
  -webkit-app-region: drag;
  height: var(--pawwork-titlebar-height, 0px);
  left: 0; position: fixed; right: 0; top: 0;
}
/* DSH 的断线重连横幅是 position: fixed; top: 0，不在 #root 的盒子里，padding 推不动
   它，会整条落进原生控件带下面。同一个变量再用一次即可。选择器锚在 CSS-modules 的
   前缀上（hash 会随版本变，前缀不会）；代码块横幅同名但不是定位元素，top 对它无效。 */
[class*="_banner_"] { top: var(--pawwork-titlebar-height, 0px); }
.pawwork-file-action {
  align-items: center; background: transparent; border: 0; border-radius: 6px;
  color: var(--dsw-alias-label-secondary); cursor: pointer; display: inline-flex;
  height: 28px; justify-content: center; padding: 0; width: 28px;
}
.pawwork-file-action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.pawwork-file-action:focus-visible { outline: 2px solid #fc5c14; outline-offset: 1px; }
.pawwork-file-action:disabled { cursor: default; opacity: 0.45; }
/* Hero 的标题与「预览版」角标是 DSH 自带文案。rc.8 的 locale registry 对重复
   命名空间直接抛错，没有公开覆盖点，所以锚在 SlotOutlet 的 data-slot 上做视觉
   替换 —— data-slot 是稳定的可寻址属性，不像构建产物的哈希类名会随版本变。
   line-height 必须一起归零：只清 font-size 会留下 32px 的行高撑大行盒，把
   整行文字相对 mark 上移 4.5px。 */
span:has(> [data-slot="conversation.hero.brand.mark"]) + span { font-size: 0; line-height: 0; }
span:has(> [data-slot="conversation.hero.brand.mark"]) + span::before { content: "What's first today?"; font-size: 26px; line-height: 32px; }
html[lang^="zh"] span:has(> [data-slot="conversation.hero.brand.mark"]) + span::before { content: "今天从哪件事开始？"; }
span:has(> [data-slot="conversation.hero.brand.mark"]) + span + span { display: none; }
/* Hero mark 的悬停摆动。DSH 的 hero-fish-swim 是按鱼调的小幅度（±1px / -5°~3°），
   爪印是只手套，挥手的左右幅度要大得多才读得出来。同样锚 data-slot，选择器权重
   0,3,2 高于 DSH 的 0,3,0，直接覆盖 animation 简写。transform-origin 沿用 DSH 的
   50% 60%，只改幅度不改性格。 */
@keyframes pawwork-hero-mark-swim {
  0%, 100% { transform: translate(0) rotate(0deg); }
  35% { transform: translate(-3px, -1.5px) rotate(-13deg); }
  70% { transform: translate(3px, 0) rotate(8deg); }
}
@media (hover: hover) and (prefers-reduced-motion: no-preference) {
  span:has(> [data-slot="conversation.hero.brand.mark"]):hover > [data-slot="conversation.hero.brand.mark"] > svg {
    animation: pawwork-hero-mark-swim var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
}
`

    const styleId = "@pawwork/dsh-product/identity"
    if (document.querySelector(`style[data-plugin-css="${styleId}"]`) === null) {
      const style = document.createElement("style")
      style.dataset.plugin = "@pawwork/dsh-product"
      style.dataset.pluginCss = styleId
      style.textContent = productCss
      document.head.appendChild(style)
    }
    function mountTitlebar() {
      if (!document.body || document.querySelector(".pawwork-titlebar") !== null) return
      const bar = document.createElement("div")
      bar.className = "pawwork-titlebar"
      document.body.appendChild(bar)
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountTitlebar, { once: true })
    else mountTitlebar()

    function isChinese() { return document.documentElement.lang.startsWith("zh") }
    function text(chinese, english) { return isChinese() ? chinese : english }
    function icon(paths, size = 16) {
      return h("svg", { "aria-hidden": "true", fill: "none", height: size, viewBox: "0 0 24 24", width: size },
        ...paths.map((path, index) => h("path", { d: path, key: index, stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: 1.8 })))
    }

    function CompleteWelcomeNotice({ complete }) {
      const completed = useRef(false)
      useEffect(() => {
        if (completed.current) return
        completed.current = true
        complete()
      }, [complete])
      return null
    }

    function CompleteV1MigrationRefresh({ connection, sessions }) {
      useEffect(() => {
        let checking = false
        let stopped = false
        async function check() {
          if (checking || stopped) return
          checking = true
          try {
            const result = await connection.rpc.call("/pawwork-import-v1", "status", {})
            if (!result.ok || !result.value.sessionsComplete || stopped) return
            await sessions.refresh()
            if (!stopped) clearInterval(timer)
          } catch {
            // The importer may not be mounted yet; the next interval retries.
          } finally {
            checking = false
          }
        }
        const timer = setInterval(check, 500)
        void check()
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [connection, sessions])
      return null
    }

    function FileAction({ input, inputActions }) {
      if (window.pawworkFiles?.pick === undefined) return null
      async function chooseFiles() {
        const result = await window.pawworkFiles.pick()
        if (result.status === "canceled") return
        const heading = text("文件：", "Files:")
        const fileBlock = `${heading}\n${result.paths.map((path) => `- ${JSON.stringify(path)}`).join("\n")}`
        inputActions.setDraft(input.draft === "" ? fileBlock : `${input.draft}\n\n${fileBlock}`)
      }
      const label = text("添加文件", "Add files")
      return h("button", { "aria-label": label, className: "pawwork-file-action", disabled: input.phase !== "plain", onClick: chooseFiles, title: label, type: "button" },
        icon(["M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"]))
    }

    // --- 爪印手套 mark -------------------------------------------------------
    // 描自品牌应用图标：橙色手套体、米白肉垫与袖口、藏蓝外圈。袖口另画一份上移
    // 副本，把它从原图的 19% 高度撑到约 29%，否则 24px 侧边栏里手套语义会塌成纯爪。
    // 路径坐标空间是 0..6270，由 GLOVE_TRANSFORM 映射进 64x64 viewBox。
    const BRAND_ORANGE = "#fc5c14"
    const BRAND_NAVY = "#1a2d5a"
    const BRAND_CREAM = "#faf6f1"
    const GLOVE_TRANSFORM = "translate(0,64) scale(0.010207,-0.010207)"
    const GLOVE_CUFF_RISE = "translate(0,300)"

    const GLOVE_SILHOUETTE =
      "M2635 5813 c-372 -59 -711 -344 -840 -705 -33 -92 -33 -92 -126 -89 -548 14 -979 -520 -910 -1129 25 -218 101 " +
      "-436 216 -616 31 -49 32 -53 23 -105 -16 -88 -3 -398 21 -504 60 -259 169 -486 333 -689 56 -69 56 -69 27 -114 " +
      "-39 -61 -56 -119 -73 -240 -14 -101 -16 -106 -75 -193 -127 -188 -117 -341 30 -495 299 -311 1228 -566 1969 " +
      "-541 612 21 852 191 764 541 -15 61 -15 65 10 151 18 61 26 113 26 165 0 75 0 75 98 124 380 187 650 483 782 " +
      "854 32 89 35 94 94 136 339 242 584 680 625 1119 47 499 -218 872 -661 932 -48 6 -48 6 -41 124 23 428 -198 816 " +
      "-546 959 -226 93 -522 57 -754 -92 -32 -20 -59 -36 -61 -36 -2 0 -19 24 -39 53 -107 163 -326 318 -522 372 -60 " +
      "16 -307 29 -370 18z"
    const GLOVE_BODY =
      "M2610 5615 c-344 -76 -618 -371 -681 -732 -15 -85 -34 -99 -104 -77 -78 24 -217 29 -305 10 -192 -40 -377 -185 " +
      "-472 -372 -178 -344 -133 -747 125 -1127 87 -127 83 -119 51 -115 -36 4 -42 -28 -43 -222 -2 -393 153 -738 471 " +
      "-1051 85 -83 104 -97 150 -108 74 -18 165 -63 235 -115 60 -44 60 -44 199 -48 164 -6 226 -23 354 -96 86 -49 86 " +
      "-49 150 -40 135 20 293 -8 425 -75 60 -30 60 -30 146 -13 110 21 245 20 332 -3 67 -17 67 -17 182 20 387 127 " +
      "686 371 844 687 36 71 91 229 91 260 0 14 25 38 83 78 239 166 445 444 537 724 133 407 61 768 -187 933 -112 74 " +
      "-276 116 -403 102 -48 -6 -58 -4 -74 14 -18 19 -18 23 0 113 26 137 24 357 -5 463 -145 535 -638 695 -1091 354 " +
      "-104 -79 -119 -77 -175 23 -110 196 -263 330 -450 394 -99 34 -279 43 -385 19z m236 -405 c319 -156 388 -729 " +
      "120 -995 -89 -89 -138 -110 -256 -110 -85 0 -101 3 -149 29 -270 141 -374 548 -219 857 110 221 317 311 504 " +
      "219z m1307 -214 c274 -134 299 -596 49 -901 -172 -211 -437 -247 -601 -84 -271 272 -93 871 297 1000 81 27 182 " +
      "21 255 -15z m-2388 -514 c286 -134 404 -593 225 -872 -191 -297 -586 -179 -722 216 -146 423 153 817 497 656z " +
      "m3102 -552 c251 -111 274 -479 49 -767 -187 -239 -461 -288 -620 -112 -166 183 -121 514 99 734 153 154 330 208 " +
      "472 145z m-1591 -90 c202 -52 335 -171 445 -400 28 -58 70 -146 94 -195 26 -53 82 -140 135 -210 154 -201 207 " +
      "-342 197 -515 -22 -348 -296 -612 -585 -562 -114 19 -199 69 -333 198 -207 197 -355 239 -629 178 -422 -94 -773 " +
      "193 -706 575 35 198 158 346 394 476 132 72 180 107 288 208 255 238 456 309 700 247z"
    const GLOVE_CUFF =
      "M1607 1833 c-56 -9 -98 -100 -117 -258 -13 -103 -34 -157 -91 -233 -72 -95 -83 -144 -49 -213 140 -273 1037 " +
      "-549 1783 -549 407 0 670 74 693 196 3 19 -3 71 -16 127 -22 95 -22 95 0 178 58 218 55 244 -40 302 -36 22 -65 " +
      "39 -65 37 0 -1 -32 5 -72 14 -92 21 -213 20 -322 0 -86 -17 -86 -17 -146 13 -132 67 -290 95 -425 75 -64 -9 -64 " +
      "-9 -150 40 -128 73 -190 90 -354 96 -139 4 -139 4 -198 48 -140 102 -293 148 -431 127z"
    const GLOVE_PADS = [
      "M2627 5240 c-378 -95 -486 -732 -174 -1027 90 -85 144 -108 257 -108 118 0 167 21 256 110 222 220 223 664 3 900 -99 105 -229 153 -342 125z",
      "M3898 5011 c-447 -147 -585 -873 -203 -1069 71 -36 196 -43 277 -14 213 75 384 334 404 610 24 322 -216 560 -478 473z",
      "M1513 4506 c-327 -107 -381 -642 -94 -932 184 -185 439 -169 571 36 179 279 61 738 -225 872 -79 37 -183 47 -252 24z",
      "M4663 3945 c-189 -42 -388 -243 -443 -445 -74 -269 35 -506 252 -550 275 -55 597 284 598 631 0 254 -180 416 -407 364z",
      "M3020 3853 c-141 -23 -274 -102 -444 -260 -108 -101 -156 -136 -288 -208 -236 -130 -359 -278 -394 -476 -56 -319 189 -592 531 -592 56 0 133 8 175 17 274 61 422 19 629 -178 134 -129 219 -179 333 -198 289 -50 563 214 585 562 10 173 -43 314 -197 515 -53 70 -109 157 -135 210 -24 49 -66 137 -94 195 -110 229 -243 348 -445 400 -74 19 -188 25 -256 13z",
    ]

    function gloveLayer(fill, shapes, stroke, strokeWidth) {
      const props = { fill, fillRule: "evenodd" }
      if (stroke !== undefined) Object.assign(props, { stroke, strokeWidth, strokeLinecap: "round", strokeLinejoin: "round" })
      return h("g", props, ...shapes.map((d, index) => h("path", { d, key: index })))
    }

    function PawGloveMark({ size = 24, className }) {
      return h("svg", { "aria-hidden": "true", className, height: size, viewBox: "0 0 64 64", width: size },
        h("g", { transform: GLOVE_TRANSFORM },
          gloveLayer(BRAND_NAVY, [GLOVE_SILHOUETTE], BRAND_NAVY, 25),
          gloveLayer(BRAND_ORANGE, [GLOVE_BODY]),
          h("g", { transform: GLOVE_CUFF_RISE }, gloveLayer(BRAND_CREAM, [GLOVE_CUFF], BRAND_NAVY, 26)),
          gloveLayer(BRAND_CREAM, [GLOVE_CUFF]),
          gloveLayer(BRAND_CREAM, GLOVE_PADS)))
    }

    const inject = ["slots", "connection", "sessions"]

    function BrandName() { return text("爪印", "PawWork") }

    function apply(ctx) {
      ctx.slots.inject("sidebar.brand.mark", () => ctx.slots.register({ name: "sidebar.brand.mark", priority: -100 }, PawGloveMark))
      ctx.slots.inject("sidebar.brand.name", () => ctx.slots.register({ name: "sidebar.brand.name", priority: -100 }, BrandName))
      ctx.slots.inject("conversation.hero.brand.mark", () => ctx.slots.register({ name: "conversation.hero.brand.mark", priority: -100 }, PawGloveMark))
      ctx.slots.inject("settings.onboarding", () => ctx.slots.register({ name: "settings.onboarding", id: "welcome-notice", order: -100, priority: -1 }, CompleteWelcomeNotice))
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "pawwork-files", order: -100 }, FileAction))
      ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "pawwork-v1-migration-refresh", order: -99 }, () => h(CompleteV1MigrationRefresh, { connection: ctx.connection, sessions: ctx.sessions })))
    }

    return { inject, apply }
  },
})
