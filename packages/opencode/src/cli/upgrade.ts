import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { Effect } from "effect"

export async function upgrade() {
  const { config, method, latest } = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      const installation = yield* Installation.Service
      const config = yield* cfg.getGlobal()
      const method = yield* installation.method()
      const latest = yield* installation.latest(method).pipe(Effect.catch(() => Effect.succeed(undefined)))
      return { config, method, latest }
    }),
  )
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (Installation.VERSION === latest) return
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return

  const kind = Installation.getReleaseType(Installation.VERSION, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await AppRuntime.runPromise(Installation.Service.use((svc) => svc.upgrade(method, latest)))
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch(() => {})
}
