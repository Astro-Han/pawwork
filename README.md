# PawWork v2（基于 DeepSeek Harness）

爪印 v2：从 opencode fork 整体迁移到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）底座的重写线。DSH 是 MIT 开源的 Cordis 插件运行时——一切皆插件（模型、工具、skills、会话、沙箱、存储、loop、UI 均可从配置替换），所以 v2 的正确形态是「上游 DSH + 私有/公开 bundle/profile」，而不是 fork 整个 DSH。

## 仓库布局

- `dev` 分支：爪印 **v1**（opencode fork）维护线，继续服务现有内外部用户
- `v2/dsh` 分支（本线）：爪印 **v2**，基于 DSH 重写，从零 bootstrap
- 两条线在同一仓库内分支隔离，任何时刻工作树只有一套引擎

## 里程碑

- **M0（已完成并验证）**：Electron 壳 + 官方 dsh profile 跑通——拉起本地 `dsh web`，探测就绪后加载 Web UI，退出清理进程。已验证：spawn → 3080 HTTP 200 → Electron 渲染真实 UI（title=DeepSeek Harness）→ 精确停止
- **M1（进行中）**：私有 bundle 注入（内部模型端点、内部配置）
- **M2**：内部工具、权限/审计、UI 皮肤
- **M3**：内部分发/签名 → v1 退役归档

## 运行

```sh
npm i -g @deepseek-ai/dsh     # 首次：安装 DSH CLI（M0 不做自动安装）
pnpm install                  # 安装 Electron
pnpm start                    # 启动：spawn dsh web → 加载 http://127.0.0.1:3080
pnpm smoke                    # 验证：spawn dsh → 加载 UI → 截图到 logs/smoke.png
```

- 日志与 pid 落在 `logs/`（可用 `DSH_DATA_DIR` 重定向）
- 退出时按 pid 文件结束本应用拉起的 `dsh web`，不误杀外部实例
- `DSH_BIN` 可显式指定 dsh 可执行文件路径

## 实现要点（踩坑记录）

- spawn `dsh` 必须用 `process.execPath`（Electron 内置 Node）+ 环境变量 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 以 GUI 模式启动而不会真正执行 dsh
- dsh 的 HMR 插件（cordis-plugin-hmr）要求 `--expose-internals`，spawn 参数需带上
- 用 pid 文件精确停止本应用拉起的实例，避免误杀外部 `dsh web`

## 目录结构

```
electron/
  main.js         # 主进程：spawn dsh → probe → 窗口 → 退出清理
  preload.js      # contextIsolation 安全壳（M0 占位）
scripts/
  dsh-server.js   # dsh web 服务生命周期（spawn/probe/stop）
  smoke.js        # M0 验证：spawn dsh → 加载 UI → 截图 + title/body 断言
```

## 许可注意

DSH 是 MIT。v2 对外开源时需保留 DSH 的 MIT 版权声明（THIRD_PARTY_NOTICES 义务），v2 本身 license 倾向与底座一致（MIT）。最终许可形态在对外发布前定稿。
