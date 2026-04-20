import { describe, expect, test } from "bun:test"
import { desktopShellMainSelector, titlebarShellSelector } from "../src/renderer/ci-smoke-selectors"
import { buildSmokeEnv, requiredSelectors, resolveCiSmokeReadyFile, resolveMainEntry } from "./ci-smoke"

describe("ci smoke helpers", () => {
  test("resolveMainEntry points at the built Electron main process bundle", () => {
    expect(resolveMainEntry()).toMatch(/packages\/desktop-electron\/out\/main\/index\.js$/)
  })

  test("buildSmokeEnv isolates the app state in a temporary home", () => {
    const env = buildSmokeEnv("/tmp/pawwork-ci-smoke")

    expect(env.OPENCODE_CHANNEL).toBe("dev")
    expect(env.PAWWORK_CI_SMOKE).toBe("true")
    expect(env.PAWWORK_CI_SMOKE_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.XDG_DATA_HOME).toBe("/tmp/pawwork-ci-smoke")
    expect(env.CI).toBe("true")
  })

  test("required selectors lock one real renderer affordance", () => {
    expect(requiredSelectors).toEqual([titlebarShellSelector, desktopShellMainSelector])
  })

  test("resolveCiSmokeReadyFile points at the CI-ready marker inside the isolated user data dir", () => {
    expect(resolveCiSmokeReadyFile("/tmp/pawwork-ci-smoke")).toBe(
      "/tmp/pawwork-ci-smoke/ai.pawwork.desktop.dev/ci-smoke-ready.json",
    )
  })
})
