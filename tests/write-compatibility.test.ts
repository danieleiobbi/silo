import assert from "node:assert/strict"
import { execFileSync, fork } from "node:child_process"
import { once } from "node:events"
import { MAX_UPLOAD_BYTES } from "../apps/server/src/lib/write-validation.ts"
import { createHash } from "node:crypto"
import { randomBytes } from "node:crypto"
import { Readable } from "node:stream"
import test from "node:test"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { readEnv } from "../apps/server/src/config/env.ts"
import { login, testAuth } from "./auth-helper.ts"
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type PutObjectCommandInput,
  type BucketLocationConstraint
} from "@aws-sdk/client-s3"

// I opt into operator-managed, disposable fixtures separately from the ordinary Garage suite.
test(
  "Garage write compatibility release gate",
  { skip: !process.env.SILO_TEST_WRITES },
  async t => {
    const endpoint = process.env.S3_ENDPOINT
    assert.ok(["http://127.0.0.1:3909", "http://127.0.0.1:3910"].includes(endpoint ?? ""))
    const container =
      endpoint === "http://127.0.0.1:3910" ? "silo-garage-write-test" : "silo-garage-test"
    assert.equal(process.env.S3_REGION, "garage")
    const suffix = randomBytes(8).toString("hex")
    const bucket = `silo-write-gate-${suffix}`
    const keyName = `silo-write-gate-${suffix}`
    const accessKeyId = `GK${randomBytes(12).toString("hex")}`
    const secretAccessKey = randomBytes(32).toString("hex")
    function garage(...args: string[]) {
      try {
        return execFileSync("docker", ["exec", container, "/garage", ...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        })
      } catch {
        // I suppress operator command output and arguments because key import contains secrets.
        throw new Error("Disposable Garage operator command failed")
      }
    }
    const client = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: "garage",
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED"
    })
    client.middlewareStack.add(
      next => async args => {
        if ("IfNoneMatch" in args.input) {
          const request = args.request as { headers: Record<string, string> }
          assert.equal(request.headers["if-none-match"], "*")
        }
        return next(args)
      },
      { step: "finalizeRequest", name: "verifyConditionalHeader" }
    )
    const keys = new Set<string>()
    let created = false
    let imported = false
    const create = () =>
      client.send(
        new CreateBucketCommand({
          Bucket: bucket,
          CreateBucketConfiguration: {
            LocationConstraint: "garage" as BucketLocationConstraint
          }
        })
      )
    const put = (Key: string, Body: PutObjectCommandInput["Body"], ContentLength: number) => {
      keys.add(Key)
      return client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key,
          Body,
          ContentLength,
          ContentType: "application/octet-stream",
          IfNoneMatch: "*"
        })
      )
    }
    const read = async (Key: string) => {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key }))
      return Buffer.from(await response.Body!.transformToByteArray())
    }
    try {
      garage("key", "import", accessKeyId, secretAccessKey, "--yes", "-n", keyName)
      imported = true
      await t.test("bucket creation is denied without operator permission", async () => {
        await assert.rejects(create(), (error: unknown) => {
          return (
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 403
          )
        })
      })
      await t.test(
        "authenticated bucket API enforces permission and exact-name conflicts",
        async creationTest => {
          const service = createS3Service({
            ...readEnv(),
            credentials: { accessKeyId, secretAccessKey }
          })
          const server = createApp(service, testAuth).listen(0, "127.0.0.1")
          await new Promise<void>(resolve => server.once("listening", resolve))
          const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
          try {
            const cookie = await login(base)
            const post = () =>
              fetch(`${base}/api/buckets`, {
                method: "POST",
                headers: {
                  Cookie: cookie,
                  Origin: testAuth.publicOrigin,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ name: bucket })
              })
            assert.equal((await post()).status, 403)
            garage("key", "allow", "--create-bucket", keyName)
            const response = await post()
            created = response.status === 201
            assert.equal(response.status, 201)
            assert.deepEqual(await response.json(), { name: bucket })
            assert.equal((await post()).status, 409)
            const Key = "uploads/../% # + é//file.txt"
            keys.add(Key)
            const upload = (overwrite = false) =>
              fetch(
                `${base}/api/buckets/${bucket}/object?${new URLSearchParams({ key: Key, size: "3", overwrite: String(overwrite) })}`,
                {
                  method: "PUT",
                  headers: {
                    Cookie: cookie,
                    Origin: testAuth.publicOrigin,
                    "Content-Type": "application/octet-stream"
                  },
                  body: overwrite ? "new" : "old"
                }
              )
            assert.equal((await upload()).status, 201)
            assert.deepEqual(await read(Key), Buffer.from("old"))
            const collision = await upload()
            assert.equal(collision.status, 409)
            assert.equal((await collision.json()).code, "ObjectAlreadyExists")
            assert.deepEqual(await read(Key), Buffer.from("old"))
            assert.equal((await upload(true)).status, 201)
            assert.deepEqual(await read(Key), Buffer.from("new"))
            const marker = "uploads/../% # + é// empty /"
            keys.add(marker)
            const folder = () =>
              fetch(`${base}/api/buckets/${bucket}/folders`, {
                method: "POST",
                headers: {
                  Cookie: cookie,
                  Origin: testAuth.publicOrigin,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ prefix: "uploads/../% # + é//", name: " empty " })
              })
            assert.equal((await folder()).status, 201)
            assert.deepEqual(await read(marker), Buffer.alloc(0))
            assert.equal((await folder()).status, 409)
            await creationTest.test(
              "two concurrent 100 MiB uploads stream with bounded RSS and exact readback",
              async () => {
                const chunk = Buffer.alloc(64 * 1024, 65)
                const count = MAX_UPLOAD_BYTES / chunk.length
                const expected = createHash("sha256")
                for (let index = 0; index < count; index++) expected.update(chunk)
                const expectedDigest = expected.digest("hex")
                const child = fork(new URL("./write-server-fixture.ts", import.meta.url), {
                  execArgv: ["--import", "tsx"],
                  env: {
                    ...process.env,
                    S3_ACCESS_KEY_ID: accessKeyId,
                    S3_SECRET_ACCESS_KEY: secretAccessKey
                  },
                  stdio: ["ignore", "ignore", "inherit", "ipc"]
                })
                const largeKeys = ["near-limit/one.bin", "near-limit/two.bin"]
                largeKeys.forEach(key => keys.add(key))
                try {
                  const [{ port }] = (await once(child, "message")) as [{ port: number }]
                  const uploadBase = `http://127.0.0.1:${port}`
                  const uploadCookie = await login(uploadBase)
                  child.send("measure")
                  await once(child, "message")
                  const responses = await Promise.all(
                    largeKeys.map(key =>
                      fetch(
                        `${uploadBase}/api/buckets/${bucket}/object?${new URLSearchParams({ key, size: String(MAX_UPLOAD_BYTES) })}`,
                        {
                          method: "PUT",
                          headers: {
                            Cookie: uploadCookie,
                            Origin: testAuth.publicOrigin,
                            "Content-Type": "application/octet-stream"
                          },
                          duplex: "half",
                          body: Readable.from(
                            (function* () {
                              for (let index = 0; index < count; index++) yield chunk
                            })()
                          )
                        } as RequestInit
                      )
                    )
                  )
                  assert.deepEqual(
                    responses.map(response => response.status),
                    [201, 201]
                  )
                  child.send("report")
                  const [{ baseline, peak }] = (await once(child, "message")) as [
                    { baseline: number; peak: number }
                  ]
                  for (const key of largeKeys) {
                    const result = await client.send(
                      new GetObjectCommand({ Bucket: bucket, Key: key })
                    )
                    const hash = createHash("sha256")
                    let length = 0
                    for await (const bytes of result.Body as Readable) {
                      length += bytes.length
                      hash.update(bytes)
                    }
                    assert.equal(length, MAX_UPLOAD_BYTES)
                    assert.equal(hash.digest("hex"), expectedDigest)
                  }
                  t.diagnostic(
                    `Concurrent 100 MiB files: RSS baseline ${baseline}, peak ${peak}, delta ${peak - baseline} bytes`
                  )
                  assert.ok(
                    peak - baseline < MAX_UPLOAD_BYTES,
                    "Node RSS growth must remain below one complete file for two concurrent files"
                  )
                } finally {
                  child.disconnect()
                  await once(child, "exit")
                }
              }
            )
          } finally {
            server.closeAllConnections()
            server.close()
          }
        }
      )
      assert.equal(created, true)
      await t.test("regional bucket creation grants list, read, write and delete", async () => {
        const buckets = await client.send(new ListBucketsCommand({}))
        assert.ok(buckets.Buckets?.some(item => item.Name === bucket))
        await put("rights", Buffer.from("rights"), 6)
        assert.deepEqual(await read("rights"), Buffer.from("rights"))
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: "rights" }))
      })
      await t.test("streamed PutObject preserves exact keys and bytes", async () => {
        const Key = "odd/../% # + é//control\r\n/file.txt"
        const bytes = Buffer.from("first\u0000élast")
        await put(Key, Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]), bytes.length)
        assert.deepEqual(await read(Key), bytes)
        const listed = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: "odd/",
            EncodingType: "url",
            MaxKeys: 1
          })
        )
        assert.equal(decodeURIComponent(listed.Contents![0].Key!), Key)
      })
      await t.test("installed SDK default streaming checksum round-trips bytes", async () => {
        const defaultClient = new S3Client({
          endpoint,
          region: "garage",
          credentials: { accessKeyId, secretAccessKey },
          forcePathStyle: true,
          maxAttempts: 1
        })
        const Key = "default-checksum.txt"
        const bytes = Buffer.from("streaming checksum fixture")
        keys.add(Key)
        try {
          await defaultClient.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key,
              Body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
              ContentLength: bytes.length,
              IfNoneMatch: "*"
            })
          )
          assert.deepEqual(await read(Key), bytes)
        } finally {
          defaultClient.destroy()
        }
      })
      await t.test("zero-byte PutObject creates an exact trailing-slash marker", async () => {
        await put("empty/", Buffer.alloc(0), 0)
        assert.deepEqual(await read("empty/"), Buffer.alloc(0))
      })
      for (const Key of ["existing.txt", "nonzero-marker/", "existing-empty-marker/"]) {
        await t.test(
          `records conditional-write support without claiming atomic protection: ${Key}`,
          async () => {
            const original = Buffer.from(Key === "existing-empty-marker/" ? "" : "original")
            await put(Key, original, original.length)
            const outcome = await Promise.allSettled([put(Key, Buffer.from("replacement"), 11)])
            if (outcome[0].status === "rejected") {
              assert.equal(outcome[0].reason.$metadata.httpStatusCode, 412)
              assert.deepEqual(await read(Key), original)
            } else {
              assert.deepEqual(await read(Key), Buffer.from("replacement"))
              t.diagnostic(
                "Garage ignores conditional PUT; the accepted advisory contract requires application collision checks"
              )
            }
          }
        )
      }
      for (const Key of ["race.txt", "race-marker/"]) {
        await t.test(`records competing conditional-create outcomes: ${Key}`, async () => {
          const outcomes = await Promise.allSettled([
            put(Key, Buffer.from("one"), 3),
            put(Key, Buffer.from("two"), 3)
          ])
          const successes = outcomes.filter(item => item.status === "fulfilled").length
          assert.ok(successes === 1 || successes === 2)
          for (const outcome of outcomes)
            if (outcome.status === "rejected")
              assert.ok([409, 412].includes(outcome.reason.$metadata.httpStatusCode))
          const bytes = await read(Key)
          assert.ok(bytes.equals(Buffer.from("one")) || bytes.equals(Buffer.from("two")))
          if (successes === 2)
            t.diagnostic(
              "Both creates succeeded; external-writer races remain an accepted limitation"
            )
        })
      }
    } finally {
      // I delete only exact objects and identities generated by this run, never unrelated fixtures.
      try {
        if (created) {
          for (const Key of keys)
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }))
          await client.send(new DeleteBucketCommand({ Bucket: bucket }))
        }
      } finally {
        client.destroy()
        if (imported) garage("key", "delete", "--yes", keyName)
      }
    }
  }
)
