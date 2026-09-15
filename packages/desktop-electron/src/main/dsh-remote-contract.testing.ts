import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { installedHarnessPackages } from "./dsh-product-patch.testing"

// The descriptor table DSH generates for a namespace is the only description of
// what a client-side Remote call must look like: nothing type-checks a browser
// bundle. A double built by hand agrees with its caller instead, and so cannot
// refuse a call the real runtime would.

/** One parameter or result codec, with the generated schema the runtime parses. */
type Codec = { schema?: { parse: (value: unknown) => unknown } }
type Parameter = { name: string; codec?: Codec }
type Descriptor = { namespace: string; method: string; parameters: Parameter[]; result?: Codec }

/** What one Remote call answers: DSH's own envelope, failures included. */
export type RemoteAnswer =
  | { ok: true; value?: unknown }
  | { ok: false; error: { code: string; message?: string } }

/** One namespace as the installed DSH describes it, keyed by method name. */
export type RemoteContract = {
  namespace: string
  methods: Map<string, Descriptor>
}

/**
 * Read one namespace's descriptors out of the DSH packages installed for this
 * checkout: the same generated table the client runtime mounts.
 * @param packageName - the DSH package owning the namespace.
 * @param namespace - the namespace to read.
 * @returns the contract the double is built from.
 */
export async function dshRemoteContract(packageName: string, namespace: string): Promise<RemoteContract> {
  const directory = installedHarnessPackages().get(packageName)
  if (directory === undefined) {
    throw new Error(`${packageName} is not installed, so the ${namespace} contract cannot be read`)
  }
  const module = (await import(pathToFileURL(join(directory, "lib/typert.remote-client.js")).href)) as {
    default: { descriptors: Descriptor[] }
  }
  const methods = new Map(
    module.default.descriptors.filter((descriptor) => descriptor.namespace === namespace).map((descriptor) => [descriptor.method, descriptor]),
  )
  if (methods.size === 0) {
    throw new Error(`${packageName} serves no ${namespace} namespace`)
  }
  return { namespace, methods }
}

/**
 * A double for one Remote namespace that refuses what the installed DSH would.
 *
 * The methods come from the contract rather than from the handlers, so a name
 * DSH no longer serves is a name the double does not answer, and every argument
 * is parsed through the generated codec before a handler sees it.
 * @param contract - the namespace, as read from the installed DSH.
 * @param handlers - one implementation per method the test drives.
 * @returns the namespace double, whose methods resolve DSH's answer envelope.
 */
export function fakeDshRemote(
  contract: RemoteContract,
  handlers: Record<string, (...args: never[]) => RemoteAnswer | Promise<RemoteAnswer>>,
): Record<string, (...args: unknown[]) => Promise<RemoteAnswer>> {
  const fake: Record<string, (...args: unknown[]) => Promise<RemoteAnswer>> = {}
  for (const [method, descriptor] of contract.methods) {
    fake[method] = async (...args: unknown[]) => {
      descriptor.parameters.forEach((parameter, index) => {
        parse(parameter.codec?.schema, args[index], `${contract.namespace}/${method} ${parameter.name}`)
      })
      const handler = handlers[method]
      const answer = handler === undefined ? { ok: true as const, value: undefined } : await handler(...(args as never[]))
      if (answer.ok) parse(descriptor.result?.schema, answer.value, `${contract.namespace}/${method} result`)
      return answer
    }
  }
  return fake
}

function parse(schema: Codec["schema"], value: unknown, what: string) {
  if (schema === undefined) return
  try {
    schema.parse(value)
  } catch (cause) {
    throw new Error(`client api: ${what} rejected ${JSON.stringify(value) ?? String(value)}`, { cause })
  }
}
