import assert from "node:assert/strict"
import test from "node:test"
import { readEnv } from "../apps/server/src/config/env.ts"
import { hashPassword } from "../apps/server/src/auth/password.ts"
import { createApp } from "../apps/server/src/app.ts"
import { createS3Service } from "../apps/server/src/services/s3.service.ts"
import { DEFAULT_MAX_UPLOAD_BYTES } from "../apps/server/src/lib/write-validation.ts"
import { login, testAuth, testPassword } from "./auth-helper.ts"

const env = {
  S3_ENDPOINT: "http://127.0.0.1:3909",
  S3_REGION: "garage",
  S3_ACCESS_KEY_ID: "fixture",
  S3_SECRET_ACCESS_KEY: "fixture",
  PORT: "3000",
  SILO_ADMIN_USERNAME: testAuth.username,
  SILO_ADMIN_PASSWORD_HASH: await hashPassword(testPassword),
  SILO_PUBLIC_ORIGIN: testAuth.publicOrigin
}
test("upload configuration defaults to 100 MiB and validates integer single-PUT bounds", () => {
  assert.equal(readEnv(env).maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES)
  for (const size of ["1", "200", "4096"])
    assert.equal(
      readEnv({ ...env, SILO_UPLOAD_MAX_MIB: size }).maxUploadBytes,
      Number(size) * 1024 * 1024
    )
  for (const size of ["", "0", "-1", "1.5", "1e3", " 100 ", "4097", "Infinity", "100 MiB"])
    assert.throws(() => readEnv({ ...env, SILO_UPLOAD_MAX_MIB: size }), /SILO_UPLOAD_MAX_MIB/)
})
test("runtime configuration is authenticated and its exact upload limit is enforced before S3", async () => {
  const config = readEnv({ ...env, SILO_UPLOAD_MAX_MIB: "1" })
  const s3 = createS3Service(config)
  let checked = 0
  s3.checkUpload = async () => {
    checked++
  }
  s3.upload = async (_bucket, key, size, body) => {
    let received = 0
    for await (const bytes of body) received += bytes.length
    assert.equal(received, size)
    return { key, size }
  }
  const server = createApp(s3, { ...testAuth, maxUploadBytes: config.maxUploadBytes }).listen(
    0,
    "127.0.0.1"
  )
  await new Promise<void>(resolve => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.equal((await fetch(base + "/api/config")).status, 401)
    const cookie = await login(base)
    const response = await fetch(base + "/api/config", { headers: { Cookie: cookie } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.deepEqual(await response.json(), { maxUploadBytes: 1024 * 1024 })
    const upload = (size: number, body: Buffer) =>
      fetch(
        `${base}/api/buckets/fixture/object?${new URLSearchParams({ key: "file", size: String(size) })}`,
        {
          method: "PUT",
          headers: {
            Cookie: cookie,
            Origin: testAuth.publicOrigin,
            "Content-Type": "application/octet-stream"
          },
          body
        }
      )
    assert.equal(
      (await upload(config.maxUploadBytes, Buffer.alloc(config.maxUploadBytes))).status,
      201
    )
    assert.equal(checked, 1)
    const rejected = await upload(config.maxUploadBytes + 1, Buffer.alloc(0))
    assert.equal(rejected.status, 413)
    assert.deepEqual(await rejected.json(), {
      code: "UploadTooLarge",
      error: "Files must be at most 1 MiB"
    })
    assert.equal(checked, 1)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})
