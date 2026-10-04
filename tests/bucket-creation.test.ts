import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mock, test } from "node:test"
import { S3Client, CreateBucketCommand, ListBucketsCommand } from "@aws-sdk/client-s3"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { bucketNameError } from "../apps/server/src/lib/write-validation.ts"
import { login, testAuth } from "./auth-helper.ts"

const config = {
  endpoint: "http://localhost",
  region: "garage",
  credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" }
}
const invalidNames = [
  "",
  "ab",
  "a".repeat(64),
  "-abc",
  "abc-",
  "Abc",
  "a.b",
  "a_b",
  "abc ",
  " abc",
  "abc\n",
  "éabc",
  "a/abc",
  "xn--abc",
  "sthree-abc",
  "amzn-s3-demo-abc",
  "abc-s3alias",
  "abc--ol-s3",
  "abc--x-s3",
  "abc--table-s3",
  "abc-an"
]

test("new bucket names reject reserved and malformed input without rewriting", () => {
  for (const name of ["abc", "0-1", "a".repeat(63), "abc--def", "sthree", "abc-another"])
    assert.equal(bucketNameError(name), undefined, name)
  for (const name of [...invalidNames, undefined, null, 123, {}, ["abc"]])
    assert.equal(typeof bucketNameError(name), "string", String(name))
})

test("bucket creation checks exact visible names and sends only the regional request", async () => {
  let visible = "Existing.Name"
  let failure = ""
  const commands: unknown[] = []
  const send = mock.method(S3Client.prototype, "send", async (command: unknown) => {
    commands.push(command)
    if (command instanceof ListBucketsCommand) return { Buckets: [{ Name: visible }] }
    assert.ok(command instanceof CreateBucketCommand)
    if (failure) throw Object.assign(new Error("private upstream detail"), { name: failure })
    return {}
  })
  try {
    for (const region of ["garage", "eu-west-1", "us-east-1"]) {
      commands.length = 0
      assert.deepEqual(await createS3Service({ ...config, region }).createBucket("new-bucket"), {
        name: "new-bucket"
      })
      assert.equal(commands.length, 2)
      assert.deepEqual((commands[1] as CreateBucketCommand).input, {
        Bucket: "new-bucket",
        ...(region === "us-east-1"
          ? {}
          : { CreateBucketConfiguration: { LocationConstraint: region } })
      })
    }
    visible = "new-bucket"
    commands.length = 0
    await assert.rejects(createS3Service(config).createBucket("new-bucket"), {
      name: "BucketNameConflict"
    })
    assert.equal(commands.length, 1)
    visible = "other"
    for (const code of [
      "BucketAlreadyExists",
      "BucketAlreadyOwnedByYou",
      "NotImplemented",
      "TimeoutError",
      "ServiceUnavailable"
    ]) {
      failure = code
      await assert.rejects(createS3Service(config).createBucket("new-bucket"), {
        name:
          code === "NotImplemented"
            ? "StorageOperationNotSupported"
            : code === "TimeoutError"
              ? "BucketCreationTimedOut"
              : code === "ServiceUnavailable"
                ? "BucketCreationOutcomeUnknown"
                : "BucketNameConflict"
      })
    }
  } finally {
    send.mock.restore()
  }
})

test("bucket HTTP creation protects origin/session/media type and validates before storage", async () => {
  const service = createS3Service(config)
  const calls: string[] = []
  let failure = ""
  service.createBucket = async name => {
    calls.push(name)
    if (failure) throw Object.assign(new Error("private upstream secret"), { name: failure })
    return { name }
  }
  const server = createApp(service, testAuth).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const cookie = await login(base)
    const post = (body: unknown, headers: Record<string, string> = {}, path = "/api/buckets") =>
      fetch(base + path, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: testAuth.publicOrigin,
          "Content-Type": "application/json",
          ...headers
        },
        body: JSON.stringify(body)
      })
    assert.equal((await post({ name: "new-bucket" }, { Cookie: "" })).status, 401)
    for (const Origin of [
      "",
      "null",
      "not a URL",
      "https://evil.example",
      `${testAuth.publicOrigin}/path`
    ])
      assert.equal((await post({ name: "new-bucket" }, { Origin })).status, 403)
    assert.equal(
      (await post({ name: "new-bucket" }, { "Sec-Fetch-Site": "cross-site" })).status,
      403
    )
    assert.equal((await post({ name: "new-bucket" }, { "Content-Type": "text/plain" })).status, 415)
    assert.equal(
      (
        await post(
          { name: "new-bucket" },
          { "Content-Type": "application/json; charset=iso-8859-1" }
        )
      ).status,
      415
    )
    for (const body of [
      {},
      [],
      null,
      "new-bucket",
      { name: "new-bucket", acl: "public-read" },
      ...invalidNames.map(name => ({ name }))
    ])
      assert.equal((await post(body)).status, 400)
    const malformed = await fetch(base + "/api/buckets", {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: testAuth.publicOrigin,
        "Content-Type": "application/json"
      },
      body: "{"
    })
    assert.equal(malformed.status, 400)
    assert.equal((await post({ name: "a".repeat(300000) })).status, 413)
    assert.equal(calls.length, 0)
    const success = await post({ name: "new-bucket" })
    assert.equal(success.status, 201)
    assert.equal(success.headers.get("cache-control"), "no-store")
    assert.equal(success.headers.get("access-control-allow-origin"), null)
    assert.deepEqual(await success.json(), { name: "new-bucket" })
    assert.deepEqual(calls, ["new-bucket"])
    assert.equal(
      (await post({ name: "new-bucket" }, { Origin: "null" }, "/API/BUCKETS/")).status,
      403
    )
    for (const [name, status] of [
      ["BucketNameConflict", 409],
      ["AccessDenied", 403],
      ["StorageOperationNotSupported", 501],
      ["BucketCreationOutcomeUnknown", 502],
      ["BucketCreationTimedOut", 504]
    ] as const) {
      failure = name
      const response = await post({ name: "new-bucket" })
      assert.equal(response.status, status)
      assert.doesNotMatch(await response.text(), /private upstream secret/)
    }
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("ambiguous upstream failure never replays CreateBucket", async () => {
  let writes = 0
  const storage = createServer((request, response) => {
    response.setHeader("Content-Type", "application/xml")
    if (request.method === "GET") {
      response.end(
        '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets /></ListAllMyBucketsResult>'
      )
    } else {
      writes++
      response.writeHead(503)
      response.end(
        "<Error><Code>ServiceUnavailable</Code><Message>private upstream</Message></Error>"
      )
    }
  }).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => storage.once("listening", resolve))
  try {
    const service = createS3Service({
      ...config,
      endpoint: `http://127.0.0.1:${(storage.address() as { port: number }).port}`
    })
    await assert.rejects(service.createBucket("new-bucket"))
    assert.equal(writes, 1)
  } finally {
    storage.closeAllConnections()
    storage.close()
  }
})
