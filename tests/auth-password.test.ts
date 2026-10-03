import assert from "node:assert/strict"
import { test } from "node:test"
import { spawnSync } from "node:child_process"
import {
  hashPassword,
  parsePasswordHash,
  validPassword,
  verifyPassword
} from "../apps/server/src/auth/password.ts"
import { readEnv } from "../apps/server/src/config/env.ts"

test("password hashing preserves Unicode and spaces and rejects noncanonical hashes", async () => {
  const password = "  é𐐀 password with spaces  "
  const encoded = await hashPassword(password)
  const hash = parsePasswordHash(encoded)
  assert.equal(await verifyPassword(password, hash), true)
  assert.equal(await verifyPassword(password.trim(), hash), false)
  for (const invalid of [
    encoded + "=",
    encoded.replace("131072", "1024"),
    encoded + ":extra",
    "plaintext"
  ])
    assert.throws(() => parsePasswordHash(invalid), {
      message: "SILO_ADMIN_PASSWORD_HASH is invalid"
    })
  assert.equal(validPassword("𐐀".repeat(128)), true)
  assert.equal(validPassword("𐐀".repeat(129)), false)
  assert.equal(validPassword("a".repeat(14)), false)
  const env = {
    S3_ENDPOINT: "http://localhost:3900",
    S3_REGION: "garage",
    S3_ACCESS_KEY_ID: "fixture",
    S3_SECRET_ACCESS_KEY: "fixture",
    PORT: "3000",
    SILO_ADMIN_USERNAME: "admin",
    SILO_ADMIN_PASSWORD_HASH: encoded,
    SILO_PUBLIC_ORIGIN: "https://192.168.1.20"
  }
  assert.equal(readEnv(env).auth.publicOrigin, env.SILO_PUBLIC_ORIGIN)
  for (const name of ["SILO_ADMIN_USERNAME", "SILO_ADMIN_PASSWORD_HASH", "SILO_PUBLIC_ORIGIN"])
    assert.throws(() => readEnv({ ...env, [name]: "" }), { message: `${name} is required` })
  for (const origin of [
    "http://192.168.1.20",
    "https://example.com/path",
    "https://user:secret@example.com",
    "null",
    "http://2130706433",
    "http://127.0.0.1/path/..",
    " http://localhost"
  ])
    assert.throws(() => readEnv({ ...env, SILO_PUBLIC_ORIGIN: origin }), {
      message: "SILO_PUBLIC_ORIGIN is invalid"
    })
  for (const username of [" admin", "admin\n", "a".repeat(129)])
    assert.throws(() => readEnv({ ...env, SILO_ADMIN_USERNAME: username }), {
      message: "SILO_ADMIN_USERNAME is invalid"
    })
})

test("password generator rejects noninteractive secrets without echoing them", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "apps/server/src/auth/hash-password.ts"],
    {
      input: "secret-value-never-echoed\n"
    }
  )
  assert.equal(result.status, 1)
  assert.equal(result.stdout.toString(), "")
  assert.doesNotMatch(result.stderr.toString(), /secret-value-never-echoed/)
})
