#!/usr/bin/env python3
"""
Verify PawWork dark mode renders the expected layer hex values.
Asserts:
  - Sidebar bg renders as #171717 ± 2 per channel
  - Main bg renders as #212121 ± 2 per channel
  - Composer interior renders as #2F2F2F ± 2 per channel
    (one step lighter than main; lift is the boundary cue, no 1px ring)

These targets follow ChatGPT Dark hierarchy: flat sidebar (~#181818), main one
step above (~#212121), composer two steps above (~#2F2F2F). The combined
sidebar→main→composer ladder reads as immersion rather than 'lit room'.

Token-level R-B neutrality for dark mode is covered by `token_audit.py --mode dark`.
This script focuses on layer-level pixel checks specific to dark mode targets.
"""
import argparse
import os
import sys

from PIL import Image
from playwright.sync_api import sync_playwright

from img_sample import median_region, to_hex

TARGETS = {
    "sidebar bg": ((0x17, 0x17, 0x17), 2),
    "main bg": ((0x21, 0x21, 0x21), 2),
    "composer interior": ((0x2F, 0x2F, 0x2F), 2),
}


def assert_close(label, actual, target, tol):
    ok = all(abs(actual[i] - target[i]) <= tol for i in range(3))
    print(f"  {'PASS' if ok else 'FAIL'}  {label:22s} {to_hex(actual)} (target {to_hex(target)} ± {tol})")
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dev-server-url", default="http://localhost:3000")
    parser.add_argument("--screenshot-dir", default="/tmp/grayscale-audit")
    args = parser.parse_args()
    os.makedirs(args.screenshot_dir, exist_ok=True)

    failed = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(device_scale_factor=2, viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        try:
            page.goto(args.dev_server_url, wait_until="networkidle", timeout=60_000)
        except Exception as e:
            print(f"FAIL: cannot reach {args.dev_server_url}: {e}", file=sys.stderr)
            sys.exit(1)
        # PawWork's theme preload reads localStorage['pawwork-color-scheme'] and writes a
        # single-mode :root block; seed storage and reload so the preload picks it up.
        # After reload, verify `data-color-scheme` lands before sampling.
        page.evaluate("localStorage.setItem('pawwork-color-scheme', 'dark')")
        page.goto(args.dev_server_url, wait_until="networkidle", timeout=60_000)
        page.wait_for_function(
            "document.documentElement.dataset.colorScheme === 'dark'",
            timeout=2000,
        )
        # Sidebar may be collapsed (default opened: false) or restored from persisted
        # layout state. Cmd+B is a toggle, so probe first and only press when closed.
        sidebar_w = page.evaluate(
            "() => { const e = document.querySelector('[data-component=\"pawwork-sidebar\"]');"
            " return e ? e.getBoundingClientRect().width : 0; }"
        )
        if sidebar_w < 50:
            page.keyboard.press("ControlOrMeta+b")
            page.wait_for_function(
                "() => { const e = document.querySelector('[data-component=\"pawwork-sidebar\"]');"
                " return e && e.getBoundingClientRect().width >= 50; }",
                timeout=2000,
            )
            page.wait_for_timeout(150)
        shot = os.path.join(args.screenshot_dir, "dark-layers.png")
        page.screenshot(path=shot)
        img = Image.open(shot).convert("RGB")

        # Use bbox to locate sidebar / main / composer like chatgpt_gap_audit.py
        def bb(sel):
            return page.evaluate(
                "sel => { const e = document.querySelector(sel); "
                "if (!e) return null; const r = e.getBoundingClientRect(); "
                "return { x: r.x, y: r.y, w: r.width, h: r.height }; }",
                sel,
            )

        sb = bb('[data-component="pawwork-sidebar"]') or bb('[data-testid="sidebar"]') or bb("aside")
        mn = bb('[data-component="desktop-shell-main"]') or bb('[data-testid="main-content"]') or bb("main")
        # Composer only renders inside a session view. From the bare `/` route used by
        # this audit, no composer is present — skip the composer assertion in that case
        # rather than failing.
        comp = bb('[data-component="prompt-input"]') or bb('[data-testid="composer"]') or bb(".prompt-input")

        samples = {}
        if sb:
            samples["sidebar bg"] = median_region(
                img,
                int((sb["x"] + 20) * 2),
                int((sb["y"] + 80) * 2),
                int((sb["x"] + 80) * 2),
                int((sb["y"] + 140) * 2),
            )
        if mn:
            samples["main bg"] = median_region(
                img,
                int((mn["x"] + 100) * 2),
                int((mn["y"] + 100) * 2),
                int((mn["x"] + 300) * 2),
                int((mn["y"] + 300) * 2),
            )
        if comp:
            samples["composer interior"] = median_region(
                img,
                int((comp["x"] + 20) * 2),
                int((comp["y"] + 10) * 2),
                int((comp["x"] + comp["w"] - 60) * 2),
                int((comp["y"] + 30) * 2),
            )

        for label, (target, tol) in TARGETS.items():
            if label not in samples:
                if label == "composer interior":
                    print(
                        f"  FAIL  {label}: not present on the audited route. "
                        "Pass --dev-server-url pointing at a session route so the composer "
                        "dark hex target is actually enforced."
                    )
                    failed += 1
                    continue
                print(f"  FAIL  {label}: element not found")
                failed += 1
                continue
            if not assert_close(label, samples[label], target, tol):
                failed += 1
        browser.close()

    print(f"\n{failed} assertion(s) failed." if failed else "\nDark layer pixel audit: ✓")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
