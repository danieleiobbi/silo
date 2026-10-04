import { parsePasswordHash } from "../auth/password.js"

export function readEnv(env = process.env) {
  for (const name of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "PORT",
    "SILO_ADMIN_USERNAME",
    "SILO_ADMIN_PASSWORD_HASH",
    "SILO_PUBLIC_ORIGIN"
  ]) {
    if (!env[name]?.trim()) throw new Error(`${name} is required`)
  }
  const username = env.SILO_ADMIN_USERNAME!
  if (
    Array.from(username).length > 128 ||
    username !== username.trim() ||
    Array.from(username).some(character => {
      const code = character.codePointAt(0)!
      return code < 32 || (code >= 127 && code <= 159)
    })
  )
    throw new Error("SILO_ADMIN_USERNAME is invalid")
  const passwordHash = parsePasswordHash(env.SILO_ADMIN_PASSWORD_HASH!)
  let publicOrigin: URL
  try {
    publicOrigin = new URL(env.SILO_PUBLIC_ORIGIN!)
  } catch {
    throw new Error("SILO_PUBLIC_ORIGIN is invalid")
  }
  if (
    !["http:", "https:"].includes(publicOrigin.protocol) ||
    publicOrigin.username ||
    publicOrigin.password ||
    publicOrigin.search ||
    publicOrigin.hash ||
    publicOrigin.pathname !== "/" ||
    ![publicOrigin.origin, `${publicOrigin.origin}/`].includes(env.SILO_PUBLIC_ORIGIN!) ||
    (publicOrigin.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname))
  )
    throw new Error("SILO_PUBLIC_ORIGIN is invalid")
  let endpoint: URL
  try {
    endpoint = new URL(env.S3_ENDPOINT!)
  } catch {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL")
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("S3_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment")
  }
  const port = Number(env.PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535")
  const uploadMiB = env.SILO_UPLOAD_MAX_MIB ?? "100"
  if (!/^\d+$/.test(uploadMiB) || Number(uploadMiB) < 1 || Number(uploadMiB) > 4096)
    throw new Error("SILO_UPLOAD_MAX_MIB must be an integer between 1 and 4096")
  // I keep credentials in the server process and pass them explicitly to the SDK.
  // I do not fall back to local AWS profiles or expose this configuration to the browser.
  return {
    port,
    maxUploadBytes: Number(uploadMiB) * 1024 * 1024,
    auth: { username, passwordHash, publicOrigin: publicOrigin.origin },
    endpoint: endpoint.href,
    region: env.S3_REGION!,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! }
  }
}
