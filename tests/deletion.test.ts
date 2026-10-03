import assert from "node:assert/strict"
import { test, mock } from "node:test"
import {
  S3Client,
  DeleteObjectsCommand,
  DeleteBucketCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { createApp } from "../apps/server/src/app.ts"
import { testAuth, login } from "./auth-helper.ts"

const config = {
  endpoint: "http://localhost",
  region: "garage",
  port: 3000,
  credentials: { accessKeyId: "test", secretAccessKey: "test" }
}

test("batch deletion sends exact keys and preserves partial failures", async () => {
  const keys = ["a/../b%2F.txt", "a/+ # é.txt", "folder/"]
  const send = mock.method(S3Client.prototype, "send", async (command: DeleteObjectsCommand) => {
    assert.ok(command instanceof DeleteObjectsCommand)
    assert.deepEqual(command.input, {
      Bucket: "bucket",
      Delete: { Objects: keys.map(Key => ({ Key })), Quiet: false }
    })
    return {
      Deleted: [{ Key: keys[0] }],
      Errors: [{ Key: keys[1], Code: "AccessDenied", Message: "private upstream detail" }]
    }
  })
  try {
    assert.deepEqual(await createS3Service(config).deleteObjects("bucket", keys), {
      deleted: [keys[0]],
      errors: [{ key: keys[1], code: "AccessDenied" }]
    })
  } finally {
    send.mock.restore()
  }
})

for (const empty of [true, false]) {
  test(`bucket deletion only deletes when empty=${empty}`, async () => {
    const commands: unknown[] = []
    const send = mock.method(
      S3Client.prototype,
      "send",
      async (command: ListObjectsV2Command | DeleteBucketCommand) => {
        commands.push(command)
        if (command instanceof ListObjectsV2Command) {
          assert.deepEqual(command.input, { Bucket: "bucket", MaxKeys: 1, EncodingType: "url" })
          return { Contents: empty ? [] : [{ Key: "keep" }] }
        }
        assert.ok(command instanceof DeleteBucketCommand)
        return {}
      }
    )
    try {
      if (empty) {
        await createS3Service(config).deleteBucket("bucket")
        assert.equal(commands.length, 2)
      } else {
        await assert.rejects(createS3Service(config).deleteBucket("bucket"), {
          name: "BucketNotEmpty"
        })
        assert.equal(commands.length, 1)
      }
    } finally {
      send.mock.restore()
    }
  })
}

test("HTTP validates destructive inputs before S3 and sanitizes errors", async () => {
  const service = createS3Service(config)
  const calls: string[][] = []
  service.deleteObjects = async (_bucket, keys) => {
    calls.push(keys)
    return { deleted: keys, errors: [] }
  }
  service.deleteBucket = async () => {
    throw Object.assign(new Error("private detail"), { name: "BucketNotEmpty" })
  }
  const server = createApp(service, testAuth).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/buckets/bucket`
  const cookie = await login(new URL(base).origin)
  const remove = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + url, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Origin: testAuth.publicOrigin,
        Cookie: cookie,
        ...headers
      },
      body: JSON.stringify(body)
    })
  try {
    for (const keys of [
      [],
      [""],
      ["same", "same"],
      [1],
      Array.from({ length: 101 }, (_, i) => String(i))
    ])
      assert.equal((await remove("/objects", { keys })).status, 400)
    assert.equal(calls.length, 0)
    assert.equal(
      (await remove("/objects", { keys: ["a"] }, { "sec-fetch-site": "cross-site" })).status,
      403
    )
    assert.equal((await remove("", { confirmation: "Bucket" })).status, 400)
    const nonempty = await remove("", { confirmation: "bucket" })
    assert.equal(nonempty.status, 409)
    assert.doesNotMatch(await nonempty.text(), /private detail/)
    assert.equal((await remove("/objects", { keys: ["a/../x", "b"] })).status, 200)
    assert.deepEqual(calls, [["a/../x", "b"]])
    service.deleteObjects = async () => {
      throw Object.assign(new Error("secret"), { name: "AccessDenied" })
    }
    const denied = await remove("/objects", { keys: ["a"] })
    assert.equal(denied.status, 403)
    assert.doesNotMatch(await denied.text(), /secret/)
    const short = await fetch(base + "/search?query=ab", { headers: { Cookie: cookie } })
    assert.equal(short.status, 400)
  } finally {
    server.close()
  }
})
