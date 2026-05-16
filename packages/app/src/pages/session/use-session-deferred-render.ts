import { createEffect, createSignal, onCleanup } from "solid-js"

export function createSessionDeferredRender(sessionKey: () => string | undefined) {
  const [deferRender, setDeferRender] = createSignal(false)
  let deferRenderFrame: number | undefined
  let deferRenderTimer: number | undefined
  let deferRenderEpoch = 0

  const clearDeferRenderSchedule = () => {
    if (deferRenderFrame !== undefined) cancelAnimationFrame(deferRenderFrame)
    if (deferRenderTimer !== undefined) window.clearTimeout(deferRenderTimer)
    deferRenderFrame = undefined
    deferRenderTimer = undefined
  }

  onCleanup(clearDeferRenderSchedule)

  createEffect((prev) => {
    const key = sessionKey()
    if (key !== prev) {
      const epoch = ++deferRenderEpoch
      setDeferRender(true)
      clearDeferRenderSchedule()
      deferRenderFrame = requestAnimationFrame(() => {
        deferRenderFrame = undefined
        deferRenderTimer = window.setTimeout(() => {
          deferRenderTimer = undefined
          if (epoch === deferRenderEpoch) setDeferRender(false)
        }, 0)
      })
    }
    return key
  }, sessionKey())

  return deferRender
}
