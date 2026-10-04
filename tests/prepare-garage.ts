import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout } from "node:timers/promises"
import { S3Client, PutObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3"
import { hashPassword } from "../apps/server/src/auth/password.ts"

// I create a dedicated disposable Garage, not a connection to an existing deployment.
// I refuse an existing container name instead of resetting someone else's test data.
const writeCompatibility = process.argv.includes("--write-compatibility")
const container = writeCompatibility ? "silo-garage-write-test" : "silo-garage-test"
const image = writeCompatibility ? "dxflrs/garage:v2.4.1" : "dxflrs/garage:v2.1.0"
const port = writeCompatibility ? 3910 : 3909
const envFile = writeCompatibility ? ".env.silo-write-test" : ".env.silo-test"
function docker(...args: string[]) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch {
    // I omit command arguments and output because key-import arguments contain fixture secrets.
    throw new Error(`Docker ${args[0]} failed; inspect the isolated fixture container`)
  }
}
const existing = docker("ps", "-a", "--filter", `name=^/${container}$`, "--format", "{{.Names}}")
if (existing.trim())
  throw new Error(
    `${container} already exists; remove it explicitly before preparing fresh fixtures`
  )
const accessKeyId = `GK${randomBytes(12).toString("hex")}`
const secretAccessKey = randomBytes(32).toString("hex")
const directory = mkdtempSync(join(tmpdir(), "silo-garage-"))
try {
  const config = join(directory, "garage.toml")
  writeFileSync(
    config,
    `metadata_dir = "/tmp/garage/meta"
data_dir = "/tmp/garage/data"
db_engine = "lmdb"
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${randomBytes(32).toString("hex")}"
[s3_api]
s3_region = "garage"
api_bind_addr = "[::]:3900"
`,
    { mode: 0o600 }
  )
  docker("create", "--name", container, "-p", `127.0.0.1:${port}:3900`, image)
  docker("cp", config, `${container}:/etc/garage.toml`)
  docker("start", container)
  let nodeId: string | undefined
  for (let attempt = 0; attempt < 30 && !nodeId; attempt++) {
    try {
      nodeId = docker("exec", container, "/garage", "status").match(/^([a-f0-9]{16})\s/m)?.[1]
    } catch {
      /* I wait for this new instance's RPC listener to become ready. */
    }
    if (!nodeId) await setTimeout(500)
  }
  if (!nodeId) throw new Error(`Garage did not start; inspect docker logs ${container}`)
  const garage = (...args: string[]) => docker("exec", container, "/garage", ...args)
  garage("layout", "assign", nodeId, "-z", "test", "-c", "1G")
  garage("layout", "apply", "--version", "1")
  garage("key", "import", accessKeyId, secretAccessKey, "--yes", "-n", "silo-test")
  for (const bucket of ["silo-fixture", "silo-empty-check"]) {
    garage("bucket", "create", bucket)
    garage("bucket", "allow", "--read", "--write", "--owner", bucket, "--key", accessKeyId)
  }
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    region: "garage",
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true
  })
  // I wait for the published S3 port too: a ready RPC listener does not guarantee
  // that a VM-based Docker runtime has finished forwarding the HTTP port.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.send(new ListBucketsCommand({}))
      break
    } catch {
      if (attempt === 29) throw new Error(`Garage S3 did not become reachable on port ${port}`)
      await setTimeout(500)
    }
  }
  for (let index = 0; index < 61; index++) {
    await client.send(
      new PutObjectCommand({
        Bucket: "silo-fixture",
        Key: `pages/file-${String(index).padStart(3, "0")}.txt`,
        Body: `fixture ${index}`,
        ContentType: "text/plain",
        Metadata: { source: "silo-test" }
      })
    )
  }
  for (const key of ["nested/level/report.txt", "odd/../% # + é//report.txt", "empty-marker/"]) {
    await client.send(
      new PutObjectCommand({
        Bucket: "silo-fixture",
        Key: key,
        Body: Buffer.from(key.endsWith("/") ? "" : "fixture")
      })
    )
  }
  // I keep fixture credentials in an ignored, owner-readable file, never in console output.
  const password = randomBytes(32).toString("base64url")
  const passwordHash = await hashPassword(password)
  writeFileSync(
    envFile,
    `S3_ENDPOINT=http://127.0.0.1:${port}\nS3_REGION=garage\nS3_ACCESS_KEY_ID=${accessKeyId}\nS3_SECRET_ACCESS_KEY=${secretAccessKey}\nPORT=3000\nSILO_ADMIN_USERNAME=admin\nSILO_ADMIN_PASSWORD_HASH=${passwordHash}\nSILO_PUBLIC_ORIGIN=http://127.0.0.1:3301\nSILO_TEST_PASSWORD=${password}\n`,
    { mode: 0o600 }
  )
  console.info(`Garage fixtures ready on 127.0.0.1:${port}; credentials saved to ${envFile}`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}
