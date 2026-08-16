# PawWork v2

PawWork on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Official `web` profile plus a product patch: OpenCode Zen Free, no user key.

`dev` stays v1. This branch is `v2/dsh`. Do not merge it into `dev`.

## Run

```sh
pnpm install
pnpm start
```

Opens the PawWork window. `dsh web` is an internal implementation detail.

```sh
pnpm test         # product home + composed defaults
pnpm smoke        # window loads, screenshot
pnpm chat-smoke   # one real Zen Free turn, no user key
```

## Defaults

- Product home: Electron `userData/dsh` (`pawwork-v2`), never `~/.dsh`
- Product patch: `config/product.cordis.patch.yml` via `--patch`
- Credential: `OPENCODE_API_KEY: "public"` written once into that home
- Default model: `opencode/big-pickle`
- DeepSeek official stays in the catalog

## Layout

```
config/product.cordis.patch.yml   # product defaults
electron/main.js                  # window + spawn
scripts/product-home.js           # home, env, argv
scripts/dsh-server.js             # dsh web lifecycle
scripts/smoke.js
scripts/chat-smoke.js
```
