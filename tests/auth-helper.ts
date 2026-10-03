import assert from "node:assert/strict"
import { hashPassword, parsePasswordHash } from "../apps/server/src/auth/password.ts"

export const testPassword = "disposable test password"
export const testAuth = {
  username: "fixture-admin",
  passwordHash: parsePasswordHash(await hashPassword(testPassword)),
  publicOrigin: "http://127.0.0.1"
}

export async function login(base: string) {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: testAuth.publicOrigin },
    body: JSON.stringify({ username: testAuth.username, password: testPassword })
  })
  assert.equal(response.status, 200)
  return response.headers.get("set-cookie")!.split(";")[0]
}
