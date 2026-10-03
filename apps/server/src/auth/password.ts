import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"

const HASH_PREFIX = "scrypt-v1:131072:8:1:"
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }

export function validPassword(password: string) {
  const length = Array.from(password).length
  return length >= 15 && length <= 128 && Buffer.byteLength(password, "utf8") <= 512
}

export function parsePasswordHash(hash: string) {
  const invalid = () => new Error("SILO_ADMIN_PASSWORD_HASH is invalid")
  if (!hash.startsWith(HASH_PREFIX)) throw invalid()
  const parts = hash.slice(HASH_PREFIX.length).split(":")
  if (parts.length !== 2) throw invalid()
  const [salt, key] = parts.map(part => Buffer.from(part, "base64url"))
  if (
    salt.length !== 16 ||
    key.length !== 64 ||
    salt.toString("base64url") !== parts[0] ||
    key.toString("base64url") !== parts[1]
  )
    throw invalid()
  return { salt, key }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string) {
  if (!validPassword(password))
    throw new Error("Password must contain 15–128 Unicode characters and at most 512 UTF-8 bytes")
  const salt = randomBytes(16)
  const key = await derive(password, salt)
  return `${HASH_PREFIX}${salt.toString("base64url")}:${key.toString("base64url")}`
}

export async function verifyPassword(password: string, hash: ReturnType<typeof parsePasswordHash>) {
  const key = await derive(password, hash.salt)
  return timingSafeEqual(key, hash.key)
}
