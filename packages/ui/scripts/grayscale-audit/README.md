# Grayscale Audit

Local verification scripts for the grayscale execution refactor (spec: `docs/superpowers/specs/2026-04-29-pawwork-grayscale-execution-design.md`).

## Setup

```bash
uv pip install -r requirements.txt
uv run playwright install chromium
```

## Usage

In one terminal: `bun --cwd packages/app dev` (must reach http://localhost:3000).

In another:

```bash
uv run python token_audit.py            # token R-B neutrality (light + dark)
uv run python chatgpt_gap_audit.py      # layer ΔL*, composer shadow, no-1px-border
uv run python dark_audit.py             # dark mode pixel assertions
```

Each script exits 0 on full pass, 1 on any assertion failure.

All three audit scripts accept `--dev-server-url` (default `http://localhost:3000`) when the dev server runs on a different host or port:

```bash
uv run python token_audit.py --dev-server-url http://localhost:5173
```

`font_size_v2.py` is an ad-hoc measurement utility (no PASS/FAIL); invoke directly with a screenshot path when an exact rendered font size is needed.

## Assertion → script map

| Assertion | Script |
|---|---|
| Token `R-B` neutrality on grayscale-family tokens | `token_audit.py` |
| Sidebar bg vs main bg ΔL\* (light: 2.0–4.0, dark: 2.0–5.0) | `chatgpt_gap_audit.py` |
| Composer shadow monotonic decay below edge (light): samples at +1/+5/+10/+20 retina px must be non-increasing in distance-from-white, with detectable shadow at +5 (dist >= 4) | `chatgpt_gap_audit.py` |
| Composer top-1px and right+3px (past AA fringe) ≈ main bg (no hard border on edges where shadow is not expected; bottom edge is covered by the monotonic check above) | `chatgpt_gap_audit.py` |
| Sidebar / main / composer dark hex match | `dark_audit.py` |
| Sidebar item row pitch ≤ 30 logical px | `chatgpt_gap_audit.py` (light mode only) |
| Active vs inactive ink density ratio 0.95–1.05 | manual smoke (text rasterization analysis is out of scope for this round) |

## Helpers

- `img_sample.py` — pixel sampling primitives:
  - `to_hex(rgb)` — RGB tuple to hex string
  - `lab_l(rgb)` — sRGB to CIE L\* (lightness)
  - `median_region(img, x1, y1, x2, y2)` — median RGB across a rectangle
  - `darkest_region(img, x1, y1, x2, y2, pct)` — median RGB over the darkest N% of pixels (skips pure-black AA artifacts)
  - `text_row_height(img, x1, y1, x2, y2, threshold_lum)` — longest consecutive run of inked rows in a band
  - `lightest_below_white(img, x1, y1, x2, y2, threshold)` — brightest pixel below the near-white threshold in the region
- `font_size_v2.py` — ad-hoc font size measurement from screenshot (no PASS/FAIL)

## Out-of-audit families (do NOT assert)

`--*-brand-*`, `--*-interactive-*` (orange-derived), `--icon-agent-*`, `--icon-on-*`,
`--icon-success/warning/critical/info-*`, `--surface-success/warning/critical/info-*`,
`--surface-diff-*`, `--text-diff-*`, `--text-on-*`, `--syntax-*`, `--markdown-*`, `--avatar-*`.
These keep their colored tint by design (spec Section 6).
