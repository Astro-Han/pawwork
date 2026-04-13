# 爪印 PawWork

AI work agent for everyone (每个人的 AI 工作 agent)

---

**Status: Early development. Currently dogfooding with internal team.**

---

PawWork is a desktop AI agent built for non-technical knowledge workers. Download and use, no API key or configuration required. It ships with free models via OpenCode Zen out of the box.

Planned features include Show Case (guided task templates for common work scenarios), Channel (connections to Feishu and DingTalk), local file operations, and web search.

PawWork is a fork of [OpenCode](https://github.com/anomalyco/opencode) (Electron + SolidJS).

## Development

```bash
bun install
bun run dev:electron   # or: cd packages/desktop-electron && bun run dev
```

## License

MIT. Based on [OpenCode](https://github.com/anomalyco/opencode) by anomalyco.
