import { expect, test } from "bun:test"
import { formDataBodySerializer, urlSearchParamsBodySerializer } from "../src/v2/gen/core/bodySerializer.gen.js"
import { createSseClient } from "../src/v2/gen/core/serverSentEvents.gen.js"

test("form data body serializer treats null as an empty object", () => {
  const data = formDataBodySerializer.bodySerializer(null)

  expect(Array.from(data.entries())).toEqual([])
})

test("url search params body serializer treats null as an empty object", () => {
  const data = urlSearchParamsBodySerializer.bodySerializer(null)

  expect(data).toBe("")
})

test("SSE parser preserves CRLF line endings split across chunks", async () => {
  const chunks = ["data: hello\r", "\ndata: world\r\n\r\n"]
  const fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      }),
    )

  const { stream } = createSseClient<string>({
    fetch,
    url: "https://example.test/events",
  })

  const events: string[] = []
  for await (const event of stream) {
    events.push(event)
  }

  expect(events).toEqual(["hello\nworld"])
})
