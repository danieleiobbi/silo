import { assertIntegrationTarget } from "./integration-target"
import assert from "node:assert/strict"
import test from "node:test"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { readEnv } from "../apps/server/src/config/env.ts"
import { testAuth, login } from "./auth-helper.ts"

// I use only the explicitly prepared fixture bucket, never an arbitrary user bucket.
test(
  "Garage preserves prefixes and opaque pagination",
  { skip: !process.env.SILO_TEST_GARAGE },
  async () => {
    assertIntegrationTarget()
    const service = createS3Service(readEnv())
    const root = await service.listObjects("silo-fixture", "", 25)
    assert.ok(root.prefixes.includes("nested/"))
    for (const size of [25, 50, 100]) {
      const first = await service.listObjects("silo-fixture", "pages/", size)
      assert.equal(first.objects.length, Math.min(size, 61))
      if (first.nextToken) {
        const next = await service.listObjects("silo-fixture", "pages/", size, first.nextToken)
        assert.ok(next.objects.every(item => !first.objects.some(prior => prior.key === item.key)))
        assert.deepEqual(await service.listObjects("silo-fixture", "pages/", size), first)
      }
    }
    const unusual = await service.listObjects("silo-fixture", "odd/../% # + é//", 50)
    assert.equal(unusual.objects[0]?.key, "odd/../% # + é//report.txt")
    assert.equal((await service.listObjects("silo-fixture", "absent/", 50)).objects.length, 0)
  }
)

test(
  "Garage metadata and streamed HTTP download",
  { skip: !process.env.SILO_TEST_GARAGE },
  async () => {
    assertIntegrationTarget()
    const { createApp } = await import("../apps/server/src/app.ts")
    const service = createS3Service(readEnv())
    const details = await service.details("silo-fixture", "pages/file-000.txt")
    assert.equal(details.contentType, "text/plain")
    assert.equal(details.metadata.source, "silo-test")
    const server = createApp(service, testAuth).listen(0, "127.0.0.1")
    await new Promise<void>(resolve => server.once("listening", resolve))
    try {
      const address = server.address() as { port: number }
      const cookie = await login(`http://127.0.0.1:${address.port}`)
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/buckets/silo-fixture/download?key=pages%2Ffile-000.txt`,
        { headers: { Cookie: cookie } }
      )
      assert.equal(response.status, 200)
      assert.match(response.headers.get("content-disposition")!, /attachment;.*file-000.txt/)
      assert.equal(await response.text(), "fixture 0")
      const missing = await fetch(
        `http://127.0.0.1:${address.port}/api/buckets/silo-fixture/download?key=absent`,
        { headers: { Cookie: cookie } }
      )
      assert.equal(missing.status, 404)
    } finally {
      server.close()
    }
  }
)

test(
  "Garage search and exact object deletion",
  { skip: !process.env.SILO_TEST_GARAGE },
  async () => {
    assertIntegrationTarget()
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3")
    const config = readEnv()
    const client = new S3Client({ ...config, forcePathStyle: true })
    const service = createS3Service(config)
    assert.deepEqual(
      (await service.search("silo-fixture", "nested/", "PORT")).objects.map(item => item.key),
      ["nested/level/report.txt"]
    )
    await assert.rejects(service.deleteBucket("silo-fixture"), { name: "BucketNotEmpty" })
    const keys = ["delete-test/../one #%.txt", "delete-test/two.txt"]
    for (const Key of [...keys, "delete-test/keep.txt"])
      await client.send(new PutObjectCommand({ Bucket: "silo-fixture", Key, Body: "test" }))
    const result = await service.deleteObjects("silo-fixture", keys)
    assert.equal(result.errors.length, 0)
    assert.deepEqual(result.deleted.sort(), [...keys].sort())
    assert.equal((await service.details("silo-fixture", "delete-test/keep.txt")).size, 4)
    for (const key of keys) await assert.rejects(service.details("silo-fixture", key))
  }
)

test(
  "Garage retains control characters without deleting a normalized key",
  { skip: !process.env.SILO_TEST_GARAGE },
  async () => {
    assertIntegrationTarget()
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3")
    const config = readEnv()
    const client = new S3Client({ ...config, forcePathStyle: true })
    const service = createS3Service(config)
    const keys = [
      "encoding-test/control\u0001.txt",
      "encoding-test/line\r\n\t.txt",
      "encoding-test/%2F+é.txt"
    ]
    const neighbor = "encoding-test/line\n\t.txt"
    for (const Key of [...keys, neighbor])
      await client.send(new PutObjectCommand({ Bucket: "silo-fixture", Key, Body: "fixture" }))
    try {
      const listed = await service.listObjects("silo-fixture", "encoding-test/", 50)
      assert.deepEqual(listed.objects.map(item => item.key).sort(), [...keys, neighbor].sort())
      const search = await service.search("silo-fixture", "encoding-test/", "line")
      assert.deepEqual(search.objects.map(item => item.key).sort(), [keys[1], neighbor].sort())
      const removed = await service.deleteObjects("silo-fixture", keys)
      assert.deepEqual(removed.errors, [])
      assert.deepEqual(removed.deleted.sort(), [...keys].sort())
      assert.equal((await service.details("silo-fixture", neighbor)).size, 7)
      assert.deepEqual(
        (await service.listObjects("silo-fixture", "encoding-test/", 50)).objects.map(
          item => item.key
        ),
        [neighbor]
      )
    } finally {
      await service.deleteObjects("silo-fixture", [...keys, neighbor])
    }
  }
)
