import { expect, test } from "bun:test"

async function read(name: string) {
  return Bun.file(new URL(name, import.meta.url)).text()
}

test("session page keeps support owners outside the route component", async () => {
  const page = await read("../session.tsx")
  const diagnostics = await read("./use-session-page-diagnostics.ts")
  const deferredRender = await read("./use-session-deferred-render.ts")
  const promptBootstrap = await read("./use-session-route-prompt-bootstrap.ts")
  const revertSupport = await read("./use-session-revert-support.ts")

  expect(page).toContain("createSessionPageDiagnostics")
  expect(page).toContain("createSessionDeferredRender")
  expect(page).toContain("useSessionRoutePromptBootstrap")
  expect(page).toContain("createSessionRevertSupport")
  expect(diagnostics).toContain("session.view.state")
  expect(diagnostics).toContain("session.identity.transition")
  expect(deferredRender).toContain("requestAnimationFrame")
  expect(promptBootstrap).toContain("clearPrompt")
  expect(revertSupport).toContain("promptScopeForSession")
  expect(revertSupport).toContain("formatServerError")
})
