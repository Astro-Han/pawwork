import type { Argv } from "yargs"
import { Effect } from "effect"
import { Provider } from "../../provider/provider"
import { ProviderID } from "../../provider/schema"
import { ModelsDev } from "../../provider/models"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { EOL } from "os"

export const ModelsCommand = effectCmd({
  command: "models [provider]",
  describe: "list all available models",
  builder: (yargs: Argv) => {
    return yargs
      .positional("provider", {
        describe: "provider ID to filter models by",
        type: "string",
        array: false,
      })
      .option("verbose", {
        describe: "use more verbose model output (includes metadata like costs)",
        type: "boolean",
      })
      .option("refresh", {
        describe: "refresh the models cache from models.dev",
        type: "boolean",
      })
  },
  handler: Effect.fn("Cli.models")(function* (args) {
    if (args.refresh) {
      const modelsDev = yield* ModelsDev.Service
      yield* modelsDev.refresh(true)
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Models cache refreshed" + UI.Style.TEXT_NORMAL)
    }

    const provider = yield* Provider.Service
    const providers = yield* provider.list()

    function printModels(providerID: ProviderID, verbose?: boolean) {
      const provider = providers[providerID]
      const sortedModels = Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))
      for (const [modelID, model] of sortedModels) {
        process.stdout.write(`${providerID}/${modelID}`)
        process.stdout.write(EOL)
        if (verbose) {
          process.stdout.write(JSON.stringify(model, null, 2))
          process.stdout.write(EOL)
        }
      }
    }

    if (args.provider) {
      const provider = providers[ProviderID.make(args.provider)]
      if (!provider) return yield* fail(`Provider not found: ${args.provider}`)

      printModels(ProviderID.make(args.provider), args.verbose)
      return
    }

    const providerIDs = Object.keys(providers).sort((a, b) => {
      const aIsOpencode = a.startsWith("opencode")
      const bIsOpencode = b.startsWith("opencode")
      if (aIsOpencode && !bIsOpencode) return -1
      if (!aIsOpencode && bIsOpencode) return 1
      return a.localeCompare(b)
    })

    for (const providerID of providerIDs) {
      printModels(ProviderID.make(providerID), args.verbose)
    }
  }),
})
