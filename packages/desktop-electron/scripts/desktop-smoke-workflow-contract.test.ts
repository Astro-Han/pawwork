import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const workflow = readFileSync(join(import.meta.dir, "..", "..", "..", ".github", "workflows", "desktop-smoke.yml"), "utf8")

describe("desktop smoke workflow packaged tools", () => {
  test("verifies the packaged remote bridge binary", () => {
    expect(workflow).toContain('REMOTE_BRIDGE_PATH="$APP_PATH/Contents/Resources/tools/pawwork-remote-bridge"')
    expect(workflow).toContain('if [ ! -x "$REMOTE_BRIDGE_PATH" ]; then')
    expect(workflow).toContain('file "$REMOTE_BRIDGE_PATH" | grep -q "arm64"')
    expect(workflow).toContain('"$REMOTE_BRIDGE_PATH" -list-platforms | grep -q')
  })
})
