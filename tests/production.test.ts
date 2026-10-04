import { assertIntegrationTarget } from "./integration-target"
import assert from "node:assert/strict"
import test from "node:test"
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3"
import { readEnv } from "../apps/server/src/config/env.ts"

// I run this destructive check only against a dedicated instance with disposable fixtures.
test(
  "production container complete S3 workflow",
  { skip: !process.env.SILO_TEST_URL },
  async () => {
    assertIntegrationTarget()
    const base = process.env.SILO_TEST_URL!
    const config = readEnv()
    assert.equal((await fetch(base + "/api/buckets")).status, 401)
    assert.equal((await fetch(base + "/api/config")).status, 401)
    const authenticated = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: config.auth.publicOrigin },
      body: JSON.stringify({
        username: config.auth.username,
        password: process.env.SILO_TEST_PASSWORD
      })
    })
    assert.equal(authenticated.status, 200)
    const cookie = authenticated.headers.get("set-cookie")!.split(";")[0]
    const client = new S3Client({ ...config, forcePathStyle: true })
    const key = "production/../é #+%/file.txt"
    await client.send(
      new PutObjectCommand({
        Bucket: "silo-fixture",
        Key: key,
        Body: "production fixture",
        ContentType: "text/plain",
        Metadata: { source: "production-check" }
      })
    )
    const get = (path: string) => fetch(base + path, { headers: { Cookie: cookie } })
    const runtime = await get("/api/config")
    assert.equal(runtime.headers.get("cache-control"), "no-store")
    assert.deepEqual(await runtime.json(), { maxUploadBytes: config.maxUploadBytes })
    const remove = (path: string, body: unknown) =>
      fetch(base + path, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: config.auth.publicOrigin
        },
        body: JSON.stringify(body)
      })
    assert.deepEqual(await (await get("/api/health")).json(), { status: "ok" })
    const buckets = await (await get("/api/buckets")).json()
    assert.ok(buckets.some((item: { name: string }) => item.name === "silo-fixture"))
    const root = "/api/buckets/silo-fixture"
    for (const limit of [25, 50, 100]) {
      const first = await (await get(`${root}/objects?prefix=pages%2F&limit=${limit}`)).json()
      assert.equal(first.objects.length, Math.min(limit, 61))
      if (first.nextToken) {
        const next = await (
          await get(
            `${root}/objects?${new URLSearchParams({ prefix: "pages/", limit: String(limit), token: first.nextToken })}`
          )
        ).json()
        assert.notEqual(next.objects[0].key, first.objects[0].key)
      }
    }
    const search = await (await get(root + "/search?prefix=nested%2F&query=PORT")).json()
    assert.equal(search.objects[0].key, "nested/level/report.txt")
    assert.equal(search.incomplete, false)
    const params = new URLSearchParams({ key })
    const detail = await (await get(root + "/object?" + params)).json()
    assert.equal(detail.key, key)
    assert.equal(detail.metadata.source, "production-check")
    const download = await get(root + "/download?" + params)
    assert.match(download.headers.get("content-disposition")!, /attachment/)
    assert.equal(await download.text(), "production fixture")
    assert.equal((await remove(root, { confirmation: "silo-fixture" })).status, 409)
    const removed = await (await remove(root + "/objects", { keys: [key] })).json()
    assert.deepEqual(removed.errors, [])
    assert.deepEqual(removed.deleted, [key])
    assert.equal((await get(root + "/object?" + params)).status, 404)
    assert.equal(
      (await remove("/api/buckets/silo-empty-check", { confirmation: "wrong" })).status,
      400
    )
    assert.equal(
      (await remove("/api/buckets/silo-empty-check", { confirmation: "silo-empty-check" })).status,
      200
    )
    const html = await (await get("/buckets/silo-fixture?prefix=nested%2F")).text()
    assert.match(html, /<div id="root">/)
    const script = html.match(/src="([^"]+\.js)"/)![1]
    const javascript = await (await get(script)).text()
    for (const secret of [
      config.credentials.accessKeyId,
      config.credentials.secretAccessKey,
      process.env.SILO_ADMIN_PASSWORD_HASH!,
      process.env.SILO_TEST_PASSWORD!
    ])
      assert.ok(!javascript.includes(secret))
  }
)
