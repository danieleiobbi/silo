import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { PassThrough, Readable } from "node:stream"
import { EventEmitter } from "node:events"
import { createServer } from "node:http"
import type { Request, Response } from "express"
import { writesController } from "../apps/server/src/controllers/writes.controller.ts"
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command
} from "@aws-sdk/client-s3"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import {
  keyError,
  nameError,
  newObjectKey,
  DEFAULT_MAX_UPLOAD_BYTES,
  UPLOAD_DEADLINE_MS
} from "../apps/server/src/lib/write-validation.ts"
import { testAuth, login } from "./auth-helper.ts"

const config = {
  endpoint: "http://localhost",
  region: "garage",
  credentials: { accessKeyId: "test", secretAccessKey: "test" }
}
test("early upstream rejection never replays a consumed upload stream", async () => {
  let puts = 0
  const upstream = createServer((_request, response) => {
    puts++
    response.writeHead(503, { "Content-Type": "application/xml", Connection: "close" })
    response.end(
      "<Error><Code>ServiceUnavailable</Code><Message>Disposable failure</Message></Error>"
    )
  }).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => upstream.once("listening", resolve))
  const s3 = createS3Service({
    ...config,
    endpoint: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  })
  let produced = 0
  const chunk = Buffer.alloc(64 * 1024)
  const body = Readable.from(
    (function* () {
      while (produced < DEFAULT_MAX_UPLOAD_BYTES) {
        produced += chunk.length
        yield chunk
      }
    })(),
    { objectMode: false, highWaterMark: chunk.length }
  )
  const abort = new AbortController()
  try {
    await assert.rejects(
      s3.upload("fixture", "large", DEFAULT_MAX_UPLOAD_BYTES, body, false, abort.signal)
    )
    assert.equal(puts, 1)
    assert.ok(produced < DEFAULT_MAX_UPLOAD_BYTES)
  } finally {
    abort.abort()
    body.destroy()
    upstream.closeAllConnections()
    upstream.close()
  }
})
test("upload forwards an early chunk and pauses a large producer for slow storage", async () => {
  const s3 = createS3Service(config)
  s3.checkUpload = async () => {}
  const chunk = Buffer.alloc(64 * 1024)
  let produced = 0
  let received = 0
  let resume!: () => void
  let first!: () => void
  const held = new Promise<void>(resolve => {
    resume = resolve
  })
  const started = new Promise<void>(resolve => {
    first = resolve
  })
  s3.upload = async (_bucket, key, size, body) => {
    for await (const bytes of body) {
      received += bytes.length
      if (received === bytes.length) {
        first()
        await held
      }
    }
    return { key, size }
  }
  const request = Object.assign(
    Readable.from(
      (function* () {
        for (let index = 0; index < DEFAULT_MAX_UPLOAD_BYTES / chunk.length; index++) {
          produced += chunk.length
          yield chunk
        }
      })(),
      { objectMode: false, highWaterMark: chunk.length }
    ),
    {
      query: { key: "large", size: String(DEFAULT_MAX_UPLOAD_BYTES) },
      params: { bucket: "fixture" },
      get: () => undefined
    }
  )
  let status = 0
  let result: unknown
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: (value: number) => {
      status = value
      return response
    },
    json: (value: unknown) => {
      result = value
      response.writableEnded = true
      return response
    }
  })
  const done = writesController(s3).upload(
    request as unknown as Request<{ bucket: string }>,
    response as unknown as Response
  )
  try {
    await started
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.ok(received > 0)
    assert.ok(
      produced <= 8 * chunk.length,
      "Backpressure must bound unread bytes independently of file size"
    )
    resume()
    await done
    assert.equal(status, 201)
    assert.equal(received, DEFAULT_MAX_UPLOAD_BYTES)
    assert.deepEqual(result, { key: "large", size: DEFAULT_MAX_UPLOAD_BYTES })
  } finally {
    resume()
    request.destroy()
  }
})
test("deadline and client disconnect abort upstream and release admission", async t => {
  const s3 = createS3Service(config)
  s3.checkUpload = async () => {}
  let aborted = 0
  s3.upload = async (_bucket, _key, _size, _body, _overwrite, signal) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted++
          reject(Object.assign(new Error("Aborted"), { name: "AbortError" }))
        },
        { once: true }
      )
    })
    return { key: _key, size: _size }
  }
  const controller = writesController(s3)
  function attempt() {
    const request = Object.assign(new PassThrough(), {
      query: { key: "held", size: "1" },
      params: { bucket: "fixture" },
      get: () => undefined
    })
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      setHeader: () => {},
      status: () => {
        throw new Error("Unexpected admission rejection")
      }
    })
    const result = controller.upload(
      request as unknown as Request<{ bucket: string }>,
      response as unknown as Response
    )
    return { request, response, result }
  }
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const timed = attempt()
  await Promise.resolve()
  const timedResult = assert.rejects(timed.result, { name: "UploadTimeout" })
  t.mock.timers.tick(UPLOAD_DEADLINE_MS)
  await timedResult
  timed.request.destroy()
  const disconnected = attempt()
  await Promise.resolve()
  const disconnectedResult = assert.rejects(disconnected.result, { name: "AbortError" })
  disconnected.request.emit("aborted")
  await disconnectedResult
  disconnected.request.destroy()
  assert.equal(aborted, 2)
  const next = attempt()
  await Promise.resolve()
  const nextResult = assert.rejects(next.result, { name: "AbortError" })
  next.response.emit("close")
  await nextResult
  next.request.destroy()
  assert.equal(aborted, 3)
})
test("two active uploads reject admission without blocking health and release slots", async () => {
  const s3 = createS3Service(config)
  let started = 0
  let unlock!: () => void
  let admitted!: () => void
  const held = new Promise<void>(resolve => {
    unlock = resolve
  })
  const ready = new Promise<void>(resolve => {
    admitted = resolve
  })
  s3.checkUpload = async () => {}
  s3.upload = async (_bucket, key, size, body) => {
    for await (const _chunk of body) {
      /* I drain the bounded incoming stream before holding completion. */
      void _chunk
    }
    started++
    if (started === 2) admitted()
    await held
    return { key, size }
  }
  const server = createApp(s3, testAuth).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const cookie = await login(base)
    const upload = (key: string) =>
      fetch(`${base}/api/buckets/fixture/object?${new URLSearchParams({ key, size: "1" })}`, {
        method: "PUT",
        headers: {
          Cookie: cookie,
          Origin: testAuth.publicOrigin,
          "Content-Type": "application/octet-stream"
        },
        body: "x"
      })
    const first = upload("one")
    const second = upload("two")
    await ready
    const rejected = await upload("three")
    assert.equal(rejected.status, 429)
    assert.equal(rejected.headers.get("retry-after"), "1")
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    unlock()
    assert.deepEqual(
      (await Promise.all([first, second])).map(response => response.status),
      [201, 201]
    )
    assert.equal((await upload("four")).status, 201)
  } finally {
    unlock()
    server.closeAllConnections()
    server.close()
  }
})
test("new destinations preserve exact prefix and UTF-8 boundaries", () => {
  assert.equal(newObjectKey("odd/../%+# é//\r", " file "), "odd/../%+# é//\r/ file ")
  assert.equal(keyError("é".repeat(512)), undefined)
  assert.ok(keyError("é".repeat(513)))
  assert.ok(keyError("bad\ud800"))
  assert.equal(keyError("a/../\u0001/file"), undefined)
  assert.equal(nameError(" name ", true), undefined)
  for (const name of ["", ".", "..", "a/b", "a\\b", "\r", "   "]) assert.ok(nameError(name, true))
})
test("storage checks collisions before PUT and only explicit overwrite omits the condition", async () => {
  const commands: unknown[] = []
  let existing = true
  const send = mock.method(S3Client.prototype, "send", async (command: unknown) => {
    commands.push(command)
    if (command instanceof HeadObjectCommand && !existing)
      throw Object.assign(new Error("missing"), { name: "NotFound" })
    if (command instanceof ListObjectsV2Command)
      return { Contents: existing ? [{ Key: "prefix/folder/child" }] : [] }
    return {}
  })
  try {
    const s3 = createS3Service(config)
    const signal = new AbortController().signal
    await assert.rejects(s3.checkUpload("bucket", "key", false, signal), {
      name: "ObjectAlreadyExists"
    })
    assert.equal(commands.length, 1)
    await s3.checkUpload("bucket", "key", true, signal)
    await s3.upload("bucket", "key", 0, Readable.from([]), true, signal)
    assert.equal((commands.at(-1) as PutObjectCommand).input.IfNoneMatch, undefined)
    await assert.rejects(s3.createFolder("bucket", "prefix/folder/"), {
      name: "FolderAlreadyExists"
    })
    existing = false
    await s3.checkUpload("bucket", "key", false, signal)
    await s3.upload("bucket", "key", 0, Readable.from([]), false, signal)
    assert.equal((commands.at(-1) as PutObjectCommand).input.IfNoneMatch, "*")
    await s3.createFolder("bucket", "prefix/folder/")
    assert.equal((commands.at(-1) as PutObjectCommand).input.Key, "prefix/folder/")
  } finally {
    send.mock.restore()
  }
})
test("HTTP streams exact bytes, rejects collisions, enforces confirmation, media and size", async () => {
  const s3 = createS3Service(config)
  const stored = new Map<string, Buffer>([["exists", Buffer.from("original")]])
  let checks = 0
  let puts = 0
  s3.checkUpload = async (_bucket, key, overwrite) => {
    checks++
    if (stored.has(key) && !overwrite)
      throw Object.assign(new Error("exists"), { name: "ObjectAlreadyExists" })
  }
  s3.upload = async (_bucket, key, size, body) => {
    puts++
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(chunk)
    stored.set(key, Buffer.concat(chunks))
    return { key, size }
  }
  s3.createFolder = async (_bucket, key) => ({ key, prefix: key })
  const server = createApp(s3, testAuth).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const cookie = await login(base)
    const upload = (
      key: string,
      size: number,
      body: Buffer | Readable,
      overwrite = "false",
      extra: Record<string, string> = {}
    ) =>
      fetch(
        `${base}/api/buckets/fixture/object?${new URLSearchParams({ key, size: String(size), overwrite })}`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            Origin: testAuth.publicOrigin,
            "Content-Type": "application/octet-stream",
            ...extra
          },
          body,
          duplex: "half"
        } as RequestInit
      )
    const response = await upload("exists", 3, Buffer.from("new"))
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, "ObjectAlreadyExists")
    assert.equal(puts, 0)
    assert.equal(stored.get("exists")!.toString(), "original")
    assert.equal((await upload("exists", 3, Buffer.from("new"), "true")).status, 201)
    assert.equal(stored.get("exists")!.toString(), "new")
    assert.equal((await upload("empty", 0, Buffer.alloc(0))).status, 201)
    const key = "odd/../%+# é//\r/file"
    assert.equal((await upload(key, 3, Readable.from([Buffer.from("abc")]))).status, 201)
    assert.equal(stored.get(key)!.toString(), "abc")
    for (const [size, bytes] of [
      [2, "abc"],
      [4, "abc"]
    ] as const)
      assert.equal(
        (await upload(`bad-${size}`, size, Readable.from([Buffer.from(bytes)]))).status,
        400
      )
    const before = checks
    assert.equal((await upload("limit", DEFAULT_MAX_UPLOAD_BYTES + 1, Buffer.alloc(0))).status, 413)
    assert.equal((await upload("key", 2, Buffer.from("abc"))).status, 400)
    assert.equal((await upload("key", 0, Buffer.alloc(0), "yes")).status, 400)
    assert.equal((await upload("key", 0, Buffer.alloc(0), "false", { Cookie: "" })).status, 401)
    assert.equal((await upload("key", 0, Buffer.alloc(0), "false", { Origin: "null" })).status, 403)
    assert.equal(
      (await upload("key", 0, Buffer.alloc(0), "false", { "Content-Type": "text/plain" })).status,
      415
    )
    assert.equal(
      (await upload("key", 0, Buffer.alloc(0), "false", { "Content-Encoding": "gzip" })).status,
      415
    )
    assert.equal(checks, before)
    const folder = await fetch(`${base}/api/buckets/fixture/folders`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: testAuth.publicOrigin,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prefix: "odd/../%//deep", name: " é " })
    })
    assert.equal(folder.status, 201)
    assert.deepEqual(await folder.json(), {
      key: "odd/../%//deep/ é /",
      prefix: "odd/../%//deep/ é /"
    })
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
