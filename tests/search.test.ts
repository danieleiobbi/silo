import assert from "node:assert/strict"
import { test, mock } from "node:test"
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"

const config = {
  endpoint: "http://localhost",
  region: "garage",
  port: 3000,
  credentials: { accessKeyId: "test", secretAccessKey: "test" }
}

test("search recursively matches keys, preserving prefix and opaque token", async () => {
  let calls = 0
  const send = mock.method(S3Client.prototype, "send", async (command: ListObjectsV2Command) => {
    assert.equal(command.input.Prefix, "scope/")
    assert.equal(command.input.Delimiter, undefined)
    calls++
    if (calls === 1)
      return {
        Contents: [{ Key: "scope/REPORT.txt" }],
        IsTruncated: true,
        NextContinuationToken: "opaque+/="
      }
    assert.equal(command.input.ContinuationToken, "opaque+/=")
    return { Contents: [{ Key: "scope/nested/a-report.pdf" }, { Key: "scope/unrelated" }] }
  })
  try {
    const result = await createS3Service(config).search("bucket", "scope/", "ePo")
    assert.deepEqual(
      result.objects.map(item => item.key),
      ["scope/REPORT.txt", "scope/nested/a-report.pdf"]
    )
    assert.equal(result.examined, 3)
    assert.equal(result.incomplete, false)
  } finally {
    send.mock.restore()
  }
})

for (const [count, query, matches, examined, incomplete] of [
  [101, "hit", 100, 100, true],
  [100, "hit", 100, 100, false],
  [1001, "absent", 0, 1000, true],
  [1000, "absent", 0, 1000, false]
] as const) {
  test(`search limits: ${count} objects, ${query}`, async () => {
    const send = mock.method(S3Client.prototype, "send", async (command: ListObjectsV2Command) => ({
      Contents: Array.from({ length: Math.min(count, command.input.MaxKeys!) }, (_, index) => ({
        Key: `hit-${index}`
      })),
      IsTruncated: count > command.input.MaxKeys!
    }))
    try {
      const result = await createS3Service(config).search("bucket", "", query)
      assert.equal(result.objects.length, matches)
      assert.equal(result.examined, examined)
      assert.equal(result.incomplete, incomplete)
    } finally {
      send.mock.restore()
    }
  })
}
