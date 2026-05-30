#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"
import { readFile, writeFile } from "fs/promises"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpencodeClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
// @hey-api/client-fetch passes raw options to error interceptors on request failures.
// Keep the generated v2 client aligned with the SDK contract until upstream supports this.
await patchV2ClientErrorInterceptorOptions()
await patchV2BodySerializerNullHandling()
await patchV2SseSplitCrLfHandling()
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`

async function patchV2ClientErrorInterceptorOptions() {
  const clientPath = path.join(dir, "src/v2/gen/client/client.gen.ts")
  let source = await readFile(clientPath, "utf8")

  if (source.includes("let resolvedOptions = resolveRequestOptions(options)")) {
    return
  }

  const resolvedRequestHelpers = `  const resolveRequestOptions = <
    TData = unknown,
    TResponseStyle extends 'data' | 'fields' = 'fields',
    ThrowOnError extends boolean = boolean,
    Url extends string = string,
  >(
    options: RequestOptions<TData, TResponseStyle, ThrowOnError, Url>,
  ) => {
    return {
      ..._config,
      ...options,
      fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
      headers: mergeHeaders(_config.headers, options.headers),
      serializedBody: undefined as string | undefined,
    } as RequestOptions<TData, TResponseStyle, ThrowOnError, Url> &
      ResolvedRequestOptions<TResponseStyle, ThrowOnError, Url>;
  };

  const prepareRequest = async <
    TData = unknown,
    TResponseStyle extends 'data' | 'fields' = 'fields',
    ThrowOnError extends boolean = boolean,
    Url extends string = string,
  >(
    opts: RequestOptions<TData, TResponseStyle, ThrowOnError, Url> &
      ResolvedRequestOptions<TResponseStyle, ThrowOnError, Url>,
  ) => {
    if (opts.security) {`

  source = replacePatternOnce(
    source,
    /  const beforeRequest = async <[\s\S]*?    if \(opts\.security\) \{/,
    resolvedRequestHelpers,
  )

  const resolvedRequestCall = `  const beforeRequest = async <
    TData = unknown,
    TResponseStyle extends 'data' | 'fields' = 'fields',
    ThrowOnError extends boolean = boolean,
    Url extends string = string,
  >(
    options: RequestOptions<TData, TResponseStyle, ThrowOnError, Url>,
  ) => prepareRequest(resolveRequestOptions(options));

  const request: Client['request'] = async (options) => {
    const throwOnError = options.throwOnError ?? _config.throwOnError;
    const responseStyle = options.responseStyle ?? _config.responseStyle;

    let request: Request | undefined;
    let response: Response | undefined;
    let resolvedOptions = resolveRequestOptions(options);

    try {
      const { opts, url } = await prepareRequest(resolvedOptions);
      resolvedOptions = opts;`

  source = replacePatternOnce(
    source,
    /  const request: Client\[['"]request['"]\] = async \(options\) => \{\n    const throwOnError = options\.throwOnError \?\? _config\.throwOnError;?\n    const responseStyle = options\.responseStyle \?\? _config\.responseStyle;?\n\n    let request: Request \| undefined;?\n    let response: Response \| undefined;?\n\n    try \{\n      const \{ opts, url \} = await beforeRequest\(options\);?/,
    resolvedRequestCall,
  )
  source = replacePatternOnce(
    source,
    /finalError = await fn\(finalError, response, request, options as ResolvedRequestOptions\);?/,
    "finalError = await fn(finalError, response, request, resolvedOptions)",
  )

  await writeFile(clientPath, source)
}

async function patchV2BodySerializerNullHandling() {
  const serializerPath = path.join(dir, "src/v2/gen/core/bodySerializer.gen.ts")
  let source = await readFile(serializerPath, "utf8")

  source = replacePattern(
    source,
    /Object\.entries\(body as Record<string, unknown>\)\.forEach\(\(\[key, value\]\) => \{/g,
    "Object.entries((body ?? {}) as Record<string, unknown>).forEach(([key, value]) => {",
    2,
  )

  await writeFile(serializerPath, source)
}

async function patchV2SseSplitCrLfHandling() {
  const ssePath = path.join(dir, "src/v2/gen/core/serverSentEvents.gen.ts")
  let source = await readFile(ssePath, "utf8")

  source = replacePatternOnce(
    source,
    /buffer = buffer\.replace\(\/\\r\\n\?\/g, ['"]\\n['"]\)(?: \/\/ normalize line endings)?/,
    `const hasTrailingCR = buffer.endsWith("\\r")
            const toNormalize = hasTrailingCR ? buffer.slice(0, -1) : buffer
            buffer = toNormalize.replace(/\\r\\n?/g, "\\n") + (hasTrailingCR ? "\\r" : "")`,
  )

  await writeFile(ssePath, source)
}

function replacePatternOnce(source: string, search: RegExp, replacement: string) {
  return replacePattern(source, search, replacement, 1)
}

function replacePattern(source: string, search: RegExp, replacement: string, expectedMatches: number) {
  const matches = source.match(search)
  if (matches?.length !== expectedMatches) {
    throw new Error("Generated SDK shape changed; update the SDK post-generation patches")
  }

  return source.replace(search, replacement)
}
