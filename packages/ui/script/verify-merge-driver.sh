#!/usr/bin/env bash
# verify-merge-driver.sh
#
# Confirms that the PawWork UI carve-out merge driver is registered in the
# current git repository.  Run this after a fresh clone or CI workspace setup
# before performing an upstream sync.
#
# Usage:
#   bash packages/ui/script/verify-merge-driver.sh
#
# Exit codes:
#   0 — driver is registered correctly
#   1 — driver is missing; instructions are printed

set -euo pipefail

DRIVER_NAME="pawwork-keep-ours"
EXPECTED_CMD="true"

actual=$(git config --get merge."${DRIVER_NAME}".driver 2>/dev/null || echo "")

if [ "$actual" = "$EXPECTED_CMD" ]; then
  echo "✓ merge driver '${DRIVER_NAME}' is registered (driver = '${actual}')"
  exit 0
fi

echo "✗ merge driver '${DRIVER_NAME}' is NOT registered in this repository."
echo ""
echo "  Register it with:"
echo "    git config merge.${DRIVER_NAME}.driver \"${EXPECTED_CMD}\""
echo ""
echo "  This is a one-time step per clone.  The .gitattributes carve-out"
echo "  entries exist in the repo, but git only activates a named driver"
echo "  if it is registered in .git/config (local) or ~/.gitconfig (global)."
echo ""
echo "  Without the driver, git may allow upstream changes into carve-out"
echo "  paths; always review the upstream-sync diff to confirm."
exit 1
