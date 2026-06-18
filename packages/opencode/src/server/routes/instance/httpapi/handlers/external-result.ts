import { listPendingExternalResults } from "@/server/instance/external-result"
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { ExternalResultApi } from "../groups/external-result"

export const externalResultHandlers = HttpApiBuilder.group(ExternalResultApi, "externalResult", (handlers) =>
  handlers.handleRaw("list", () =>
    listPendingExternalResults().pipe(Effect.map((result) => HttpServerResponse.jsonUnsafe(result))),
  ),
)
