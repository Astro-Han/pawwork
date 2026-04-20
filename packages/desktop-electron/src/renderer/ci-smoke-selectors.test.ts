import { expect, test } from "bun:test"
import {
  desktopShellMainSelector as appDesktopShellMainSelector,
  titlebarShellSelector as appTitlebarShellSelector,
} from "../../../app/e2e/selectors"
import { desktopShellMainSelector, titlebarShellSelector } from "./ci-smoke-selectors"

test("desktop CI smoke selectors stay aligned with the app e2e contract", () => {
  expect({ titlebarShellSelector, desktopShellMainSelector }).toEqual({
    titlebarShellSelector: appTitlebarShellSelector,
    desktopShellMainSelector: appDesktopShellMainSelector,
  })
})
