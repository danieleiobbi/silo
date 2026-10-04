import assert from "node:assert/strict"
import { test } from "node:test"
import {
  createSessions,
  IDLE_TIMEOUT,
  ABSOLUTE_LIFETIME,
  MAX_SESSIONS
} from "../apps/server/src/auth/sessions.ts"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { login, testAuth, testPassword } from "./auth-helper.ts"

test("sessions enforce idle, absolute, replacement, capacity and process-local lifetime", () => {
  let time = 0
  const sessions = createSessions(() => time)
  const original = sessions.create()
  time = IDLE_TIMEOUT - 1
  assert.equal(sessions.authenticate(original), true)
  time += IDLE_TIMEOUT
  assert.equal(sessions.authenticate(original), false)
  const absolute = sessions.create()
  for (let i = 0; i < 16; i++) {
    time += IDLE_TIMEOUT - 1
    assert.equal(sessions.authenticate(absolute), true)
  }
  time += 16
  assert.equal(sessions.authenticate(absolute), false)
  const first = sessions.create()
  const replacement = sessions.create(first)
  assert.equal(sessions.authenticate(first), false)
  assert.equal(sessions.authenticate(replacement), true)
  const oldest = sessions.create()
  for (let i = 0; i < MAX_SESSIONS; i++) {
    time++
    sessions.create()
  }
  assert.equal(sessions.authenticate(oldest), false)
  const current = sessions.create()
  assert.equal(createSessions(() => time).authenticate(current), false)
  sessions.remove(current)
  assert.equal(sessions.authenticate(current), false)
  assert.equal(ABSOLUTE_LIFETIME, 8 * 60 * 60 * 1000)
})

test("HTTPS cookies, replacement, parser bounds and rolling admission remain independent of sessions", async () => {
  let time = 0
  const auth = { ...testAuth, publicOrigin: "https://127.0.0.1" }
  const service = createS3Service({
    endpoint: "http://localhost",
    region: "garage",
    credentials: { accessKeyId: "test", secretAccessKey: "test" }
  })
  const server = createApp(service, auth, () => time).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const post = (body: string, cookie = "", extra: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: {
        Origin: auth.publicOrigin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra
      },
      body
    })
  const credentials = JSON.stringify({ username: auth.username, password: testPassword })
  const session = (cookie: string) =>
    fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })
  try {
    assert.equal((await post("{", "", { Origin: "null" })).status, 403)
    assert.equal((await post("{")).status, 400)
    assert.equal((await post(JSON.stringify({ password: "x".repeat(5000) }))).status, 413)
    assert.equal(
      (await post(JSON.stringify({ username: auth.username, password: "a".repeat(14) }))).status,
      400
    )
    const first = await post(credentials)
    assert.equal(first.status, 200)
    const attributes = first.headers.get("set-cookie")!
    assert.match(
      attributes,
      /^__Host-silo_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/
    )
    assert.doesNotMatch(attributes, /Domain|Expires|Max-Age/)
    const cookie = attributes.split(";")[0]
    assert.equal((await session(cookie.replace("__Host-silo_session", "silo_session"))).status, 401)
    const second = await post(credentials, cookie)
    assert.equal(second.status, 200)
    const current = second.headers.get("set-cookie")!.split(";")[0]
    assert.notEqual(current, cookie)
    assert.equal((await session(cookie)).status, 401)
    for (let i = 0; i < 8; i++) {
      const failed = await post(
        JSON.stringify({
          username: i % 2 ? auth.username : "wrong",
          password: i % 2 ? "wrong password value" : testPassword
        })
      )
      assert.equal(failed.status, 401)
      assert.deepEqual(await failed.json(), { error: "Invalid username or password" })
    }
    const limited = await post(credentials)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get("retry-after"), "300")
    assert.equal((await session(current)).status, 200)
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    time = 300000
    const concurrent = await Promise.all([post(credentials), post(credentials)])
    assert.deepEqual(concurrent.map(response => response.status).sort(), [200, 429])
    time += IDLE_TIMEOUT
    assert.equal((await session(current)).status, 401)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test("every storage route rejects anonymous requests before S3; logout invalidates cookies", async () => {
  const service = createS3Service({
    endpoint: "http://localhost",
    region: "garage",
    credentials: { accessKeyId: "test", secretAccessKey: "test" }
  })
  let calls = 0
  for (const name of [
    "listBuckets",
    "listObjects",
    "details",
    "search",
    "download",
    "deleteObjects",
    "deleteBucket",
    "createBucket",
    "createFolder",
    "checkUpload",
    "upload"
  ] as const) {
    service[name] = async () => {
      calls++
      throw new Error("S3 must not run")
    }
  }
  const server = createApp(service, testAuth).listen(0, "127.0.0.1")
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    for (const path of [
      "/buckets",
      "/buckets/b/objects",
      "/buckets/b/object?key=a",
      "/buckets/b/search?query=abc",
      "/buckets/b/download?key=a"
    ]) {
      const response = await fetch(`${base}/api${path}`)
      assert.equal(response.status, 401)
      assert.equal(response.headers.get("cache-control"), "no-store")
    }
    for (const path of ["/buckets/b", "/buckets/b/objects"]) {
      assert.equal(
        (
          await fetch(`${base}/api${path}`, {
            method: "DELETE",
            headers: { Origin: testAuth.publicOrigin, "Content-Type": "application/json" },
            body: "{}"
          })
        ).status,
        401
      )
    }
    assert.equal(calls, 0)
    assert.equal(
      (
        await fetch(`${base}/api/buckets`, {
          method: "POST",
          headers: { Origin: testAuth.publicOrigin, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "new-bucket" })
        })
      ).status,
      401
    )
    assert.equal(calls, 0)
    for (const [path, method, contentType, body] of [
      ["/buckets/b/folders", "POST", "application/json", '{"prefix":"","name":"folder"}'],
      ["/buckets/b/object?key=file&size=1", "PUT", "application/octet-stream", "x"]
    ]) {
      assert.equal(
        (
          await fetch(`${base}/api${path}`, {
            method,
            headers: { Origin: testAuth.publicOrigin, "Content-Type": contentType },
            body
          })
        ).status,
        401
      )
    }
    assert.equal(calls, 0)
    assert.equal((await fetch(`${base}/api/health`)).status, 200)
    for (const origin of ["null", "https://evil.example", "http://127.0.0.1/path", ""]) {
      const response = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username: testAuth.username, password: testPassword })
      })
      assert.equal(response.status, 403)
    }
    const cookie = await login(base)
    assert.equal(
      (await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).status,
      200
    )
    const logout = await fetch(`${base}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        Origin: testAuth.publicOrigin,
        "Content-Type": "application/json"
      },
      body: "{}"
    })
    assert.equal(logout.status, 204)
    assert.match(logout.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/)
    assert.equal(
      (await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).status,
      401
    )
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
