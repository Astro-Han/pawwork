#!/usr/bin/env python3
"""
Verify grayscale-family CSS tokens render with abs(R-B) <= 1 on a running dev server.
Usage: python token_audit.py [--dev-server-url http://localhost:3000] [--mode light|dark|both]
Exit 0 if all assertions pass, 1 otherwise.
"""
import argparse
import re
import sys

from playwright.sync_api import sync_playwright

GRAYSCALE_TOKENS = [
    "--text-base",
    "--text-weak",
    "--text-weaker",
    "--text-strong",
    "--text-stronger",
    "--icon-base",
    "--icon-strong-base",
    "--icon-hover",
    "--icon-active",
    "--icon-disabled",
    "--icon-weak-base",
    "--border-base",
    "--border-strong-base",
    "--border-weak-base",
    "--border-weaker-base",
    "--surface-base-hover",
    "--surface-base-active",
    "--surface-raised-base-hover",
    "--surface-raised-base-active",
    "--button-secondary-base",
    "--button-secondary-hover",
    "--button-ghost-hover",
]

# Modern Chromium serializes `getComputedStyle(...).color` as either:
#   rgb(13, 13, 13)         — comma-separated, opaque
#   rgb(13 13 13)           — space-separated, opaque (CSS Color 4)
#   rgba(13, 13, 13, 0.5)   — comma-separated, with alpha
#   rgb(13 13 13 / 0.5)     — space-separated, with alpha
# We accept all four. Plain `getPropertyValue('--token')` returns the raw token text
# (e.g. "var(--text-weak)"), which is NOT what we want — we resolve via a probe element
# whose `color` property consumes the variable, then read the computed `color`.

_RGB_RE = re.compile(r"rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)")


def parse_color(value: str):
    """Parse rgb(...) / rgba(...) (comma OR space sep) or #hex into (R, G, B)."""
    v = value.strip()
    m = _RGB_RE.match(v)
    if m:
        return tuple(int(float(g)) for g in m.groups())
    if v.startswith("#"):
        h = v.lstrip("#")
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
    raise ValueError(f"Cannot parse color: {value!r}")


# Two-step JS: first verify the token is DEFINED on :root (otherwise `var(--missing)`
# would fall back to inherited `color`, which defaults to rgb(0,0,0) and would silently
# pass an R-B==0 check). Only then resolve via a probe element whose `color` consumes
# the variable, forcing the engine to compute and serialize as rgb/rgba.
RESOLVE_TOKEN_JS = """
(token) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (raw === '') return { defined: false, value: null };
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.color = `var(${token})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return { defined: true, value };
}
"""


def audit_mode(page, mode: str, dev_server_url: str):
    """Switch PawWork's color scheme to mode, resolve each token via probe, return list of
    (token, value, R-B). PawWork's theme preload reads `localStorage['pawwork-color-scheme']`
    and writes a single-mode :root block; emulating the media feature alone does NOT switch.
    Seed storage, reload, then verify `data-color-scheme` lands before sampling — a stale
    paint with the previous mode's tokens would silently corrupt the audit."""
    page.evaluate(f"localStorage.setItem('pawwork-color-scheme', '{mode}')")
    page.goto(dev_server_url, wait_until="networkidle", timeout=60_000)
    page.wait_for_function(
        f"document.documentElement.dataset.colorScheme === '{mode}'",
        timeout=2000,
    )
    page.wait_for_timeout(50)  # one RAF tick for style recompute
    results = []
    for token in GRAYSCALE_TOKENS:
        try:
            res = page.evaluate(RESOLVE_TOKEN_JS, token)
        except Exception as e:
            results.append((token, f"ERR: {e}", None))
            continue
        if not res.get("defined"):
            # Token is not declared on :root for this theme. This is itself a failure
            # signal — the audit cannot verify a missing token.
            results.append((token, "UNDEFINED", None))
            continue
        resolved = res.get("value", "")
        try:
            r, g, b = parse_color(resolved)
        except ValueError:
            results.append((token, resolved or "UNPARSEABLE", None))
            continue
        spread = max(r, g, b) - min(r, g, b)
        results.append((token, resolved, spread))
    return results


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev-server-url", default="http://localhost:3000")
    parser.add_argument("--mode", choices=["light", "dark", "both"], default="both")
    args = parser.parse_args()

    failed = 0
    skipped = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        try:
            page.goto(args.dev_server_url, wait_until="networkidle", timeout=60_000)
        except Exception as e:
            print(f"FAIL: cannot reach {args.dev_server_url}: {e}", file=sys.stderr)
            print("Hint: run `bun --cwd packages/app dev` in another terminal first.", file=sys.stderr)
            sys.exit(1)

        modes = ["light", "dark"] if args.mode == "both" else [args.mode]
        for mode in modes:
            print(f"\n=== {mode.upper()} MODE ===")
            for token, value, spread in audit_mode(page, mode, args.dev_server_url):
                if spread is None:
                    skipped += 1
                    print(f"  SKIP   {token:42s} = {value}")
                    continue
                status = "PASS" if spread <= 1 else "FAIL"
                if status == "FAIL":
                    failed += 1
                print(f"  {status}   {token:42s} = {value}  (channel_spread={spread:d})")
        browser.close()

    # Closed token list: any UNDEFINED / UNPARSEABLE / ERR is a hard failure.
    # The spec requires every grayscale-family token in GRAYSCALE_TOKENS to be
    # asserted; a missing or unparseable token means the spec wasn't applied.
    if skipped:
        print(f"\nFAIL: {skipped} token(s) could not be resolved (UNDEFINED/UNPARSEABLE/ERR).")
        sys.exit(1)

    if failed:
        print(f"\n{failed} assertion(s) failed.")
        sys.exit(1)
    print("\nAll grayscale tokens neutral. ✓")


if __name__ == "__main__":
    main()
