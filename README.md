# 爪印 PawWork

开箱即用的 AI 工作站。下载，打开，开始干活。

---

PawWork 是一个桌面 AI 工作站，专为非技术知识工作者设计。不需要 API Key，不需要命令行，不需要任何配置。

- **下载即用** — 内置工具链，不需要 brew/pip/npm
- **免费模型** — 自带免费 AI 模型，零配置开聊
- **桌面应用** — macOS / Windows，原生体验

## 下载

macOS (Apple Silicon): [pawwork-mac-arm64.dmg](https://github.com/Astro-Han/pawwork/releases/latest)

### macOS 首次打开

PawWork 暂未完成 Apple 签名。首次打开时：
右键点击应用 → 打开 → 在弹窗中确认「打开」。

## 内置工具

- **Office 文档** — 创建和编辑 .docx / .xlsx / .pptx（via officecli）
- 更多工具持续添加中

## 从源码构建

需要 [Bun](https://bun.sh) v1.2+。

```bash
git clone https://github.com/Astro-Han/pawwork.git
cd pawwork
bun install
cd packages/desktop-electron && bun run dev
```

## 致谢

PawWork fork 自 [OpenCode](https://github.com/anomalyco/opencode)（MIT license）。

## License

MIT
