import assert from "node:assert/strict"
import test from "node:test"
import { Readable } from "node:stream"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"

test(
  "download delivers a chunk before S3 finishes and preserves UTF-8 filename",
  { timeout: 5000 },
  async () => {
    const service = createS3Service({
      endpoint: "http://localhost",
      region: "garage",
      port: 3000,
      credentials: { accessKeyId: "test", secretAccessKey: "test" }
    })
    const source = new Readable({ read() {} })
    service.download = async () =>
      ({ Body: source, $metadata: {} }) as Awaited<ReturnType<typeof service.download>>
    const server = createApp(service).listen(0, "127.0.0.1")
    await new Promise<void>(resolve => server.once("listening", resolve))
    try {
      const pending = fetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/api/buckets/bucket/download?${new URLSearchParams({ key: "folder/é #%.txt" })}`
      )
      source.push("first")
      const response = await pending
      assert.equal(response.status, 200)
      assert.match(
        response.headers.get("content-disposition")!,
        /filename\*=UTF-8''%C3%A9%20%23%25.txt/
      )
      const reader = response.body!.getReader()
      assert.equal(new TextDecoder().decode((await reader.read()).value), "first")
      // I finish S3 only after receiving its first chunk, so whole-file buffering would time out.
      source.push("last")
      source.push(null)
      assert.equal(new TextDecoder().decode((await reader.read()).value), "last")
      assert.equal((await reader.read()).done, true)
    } finally {
      source.destroy()
      server.closeAllConnections()
      server.close()
    }
  }
)
