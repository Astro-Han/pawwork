# Embedded browser fingerprint parity

The embedded browser (`WebContentsView` on `persist:pawwork-browser`) is real
Chromium (Electron). For users operating their **own** accounts, it should
present as the faithful Chromium it is, so normal automated browsing is not
mistaken for a bot. This records the measured parity vs a real external Chrome
and the one known gap, so future changes have a baseline and a way to re-check.

This is fingerprint **fidelity**, not behavioral evasion: it removes "this isn't
a normal browser" tells. It does **not** make automation safe on a platform with
mature behavioral risk control (speed, rhythm, and interaction patterns still
apply).

## How to measure

`scripts/fingerprint-probe.html` dumps the fingerprint surface and flags obvious
tells red. The embedded browser only navigates `http(s):` (it rejects `file://`),
so serve the probe over a local HTTP server and open the **same** URL in both
browsers — same origin, apples to apples:

```sh
# from the repo root; any static server works
npx serve packages/desktop-electron/scripts   # or: python3 -m http.server -d packages/desktop-electron/scripts
```

Then open `http://127.0.0.1:<port>/fingerprint-probe.html` in **both**:

1. PawWork's embedded browser (run `dev:desktop`, then `browser_navigate` to the
   local URL), and
2. a real external Chrome,

then compare (the **Copy JSON** button makes diffing easy). It covers UA + UA
Client Hints, `navigator.webdriver`, plugins, `permissions.query` states,
window/screen shape, timezone/locale, WebGL renderer, codecs, EME/Widevine,
`enumerateDevices`, and WebRTC.

These results assume **#1343 (UA) and #1344 (permissions) are applied**: they
were measured with Electron 40.8.0 (Chromium 144) using the exact
`browserViewWebPreferences()` config plus the partition UA from #1343, and the
permission rows reflect the policy from #1344. Neither change is on `dev` yet, so
**land this PR after both of them** — on its own it is a forward-looking baseline,
not a record of current `dev` behavior.

## Parity (matches real Chrome on the same machine)

| Surface | Embedded browser | Notes |
| --- | --- | --- |
| UA string | `…Chrome/144.0.0.0 Safari/537.36` | Electron/app tokens stripped (#1343) |
| UA Client Hints | `Chromium`;v=144 + GREASE | consistent real-Chromium identity; no Electron/app leak |
| `navigator.webdriver` | `false` | (opencli's stealth keeps it false under automation too) |
| `permissions.query` | Chrome-like (#1344) | sensitive = denied, default-granted = granted; no impossible "all granted" |
| WebGL vendor/renderer | real GPU via ANGLE/Metal | same as external Chrome on this machine |
| Codecs | H.264 + AAC supported, MSE H.264 `true` | Electron's official build ships proprietary codecs |
| `enumerateDevices` | real device list | not empty |
| Timezone / locale | system values | same as external Chrome |
| `navigator.plugins` | 5 (standard PDF set) | not empty |
| `window.chrome` | present | |

## Known gap: EME / Widevine (deferred)

`navigator.requestMediaKeySystemAccess("com.widevine.alpha", …)` rejects with
`NotSupportedError` in the embedded browser, while a real Chrome supports it.
**Electron does not bundle the Widevine CDM** — this is by design, not a config
mistake.

- **Functional impact:** DRM video (Netflix, etc.) won't play in the embedded
  browser.
- **Fingerprint impact:** a difference from stock Chrome, but a relatively weak
  bot signal — many real browser configurations lack Widevine, and the loud
  tells (UA, permission states) are already fixed.
- **Why deferred:** adding Widevine means switching to a Widevine-enabled
  Electron distribution (e.g. `castlabs/electron-releases` ECx builds), which
  touches packaging, signing, and the updater across the whole app. That is a
  separate product decision (DRM playback support), not a casual stealth change,
  and is out of scope here.

If DRM playback or full Chrome parity is later required, evaluate a
castlabs-based Electron build as a dedicated change.
