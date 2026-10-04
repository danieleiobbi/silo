import { buildMetadata } from "./version"
import { localEnvironments, validateLocalSettings } from "./local-settings"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"

const root = fileURLToPath(new URL("../", import.meta.url))
const profile = process.argv[2]
const command = process.argv[3]
if (
  !(
    (profile === "development" && ["up", "stop"].includes(command)) ||
    (profile === "integration" && command === "verify")
  ) ||
  process.argv.length !== 4
)
  throw new Error("Use development up/stop or integration verify")
const settingsProfile = localEnvironments[profile as "development" | "integration"]
const { garage: garageName, app: appName, network, appPort, envFile, overlay } = settingsProfile
const envPath = new URL(`../${envFile}`, import.meta.url)
const origin = `http://127.0.0.1:${appPort}`

function docker(args: string[], env = process.env, visible = false) {
  try {
    return execFileSync("docker", args, {
      cwd: root,
      env,
      encoding: "utf8",
      stdio: visible ? "inherit" : ["ignore", "pipe", "pipe"]
    })
  } catch {
    // I suppress command arguments and captured output because fixture commands contain credentials.
    throw new Error(`Docker ${args[0]} failed; check Docker and the named test resources`)
  }
}
type Container = {
  Id: string
  Config: { Image: string; Labels: Record<string, string> | null }
  Mounts: unknown[]
  HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> }
  NetworkSettings: { Networks: Record<string, unknown> }
}
function inspect(name: string): Container | undefined {
  if (!docker(["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"]).trim()) return
  return JSON.parse(docker(["inspect", name]))[0] as Container
}
function validate(container: Container, image: string, port: string, internal: string) {
  const bindings = container.HostConfig.PortBindings[`${internal}/tcp`]
  if (
    container.Config.Image !== image ||
    container.Mounts.length ||
    Object.keys(container.HostConfig.PortBindings).length !== 1 ||
    bindings?.length !== 1 ||
    bindings[0].HostIp !== "127.0.0.1" ||
    bindings[0].HostPort !== port
  )
    throw new Error(
      "A local container name belongs to an unexpected configuration; I leave it intact"
    )
}
function settings() {
  if (!existsSync(envPath)) throw new Error(`The existing Garage requires its original ${envFile}`)
  const fixture = parseEnv(readFileSync(envPath, "utf8"))
  validateLocalSettings(profile as "development" | "integration", fixture)
  const localPath = new URL("../.env", import.meta.url)
  const localUploadLimit =
    profile === "development" && existsSync(localPath)
      ? parseEnv(readFileSync(localPath, "utf8")).SILO_UPLOAD_MAX_MIB
      : undefined
  return {
    ...process.env,
    ...fixture,
    S3_ENDPOINT: fixture.S3_ENDPOINT!,
    S3_ACCESS_KEY_ID: fixture.S3_ACCESS_KEY_ID!,
    S3_SECRET_ACCESS_KEY: fixture.S3_SECRET_ACCESS_KEY!,
    SILO_UPLOAD_MAX_MIB: fixture.SILO_UPLOAD_MAX_MIB ?? localUploadLimit ?? "100",
    SILO_PORT: appPort,
    SILO_PUBLIC_ORIGIN: origin,
    SILO_TEST_PASSWORD: profile === "integration" ? fixture.SILO_TEST_PASSWORD : undefined
  }
}
const compose = [
  "compose",
  "--project-name",
  network,
  "--env-file",
  envFile,
  "-f",
  "compose.yaml",
  "-f",
  overlay
]

function migrateDevelopment() {
  if (profile !== "development") return
  const legacy = inspect("silo-garage-test")
  if (!legacy) return
  if (inspect(garageName))
    throw new Error("Both legacy and development Garage exist; resolve ownership before migration")
  validate(legacy, "dxflrs/garage:v2.1.0", "3909", "3900")
  const oldPath = new URL("../.env.silo-test", import.meta.url)
  const source = existsSync(envPath) ? envPath : oldPath
  if (!existsSync(source)) throw new Error("Legacy Garage requires its saved credentials")
  const original = readFileSync(source, "utf8")
  const old = parseEnv(original)
  validateLocalSettings("development", {
    ...old,
    SILO_ENVIRONMENT: "development",
    SILO_DEV_PASSWORD: old.SILO_DEV_PASSWORD ?? old.SILO_TEST_PASSWORD
  })
  if (source === oldPath) {
    const migrated =
      original.replace(/^SILO_TEST_PASSWORD=/m, "SILO_DEV_PASSWORD=") +
      "\nSILO_ENVIRONMENT=development\n"
    renameSync(oldPath, envPath)
    writeFileSync(envPath, migrated, { mode: 0o600 })
  }
  // I rename the verified storage container without replacing it or changing its objects.
  docker(["rename", "silo-garage-test", garageName])
  console.info("Existing Garage and credentials migrated to development; data preserved")
}

async function up() {
  let garage = inspect(garageName)
  if (!garage) {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/prepare-garage.ts", profile], {
      cwd: root,
      stdio: "inherit"
    })
    garage = inspect(garageName)
  }
  if (!garage) throw new Error("Local Garage preparation did not create its container")
  validate(garage, settingsProfile.image, settingsProfile.garagePort, "3900")
  const env = { ...settings(), ...buildMetadata(root) }
  docker(["start", garageName])
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: "garage",
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
  })
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.send(new ListBucketsCommand({}))
        break
      } catch {
        if (attempt === 29)
          throw new Error("The local S3 endpoint did not become ready with the saved credentials")
      }
      await setTimeout(500)
    }
  } finally {
    client.destroy()
  }
  // I grant bucket creation only to the already verified local environment key.
  docker(["exec", garageName, "/garage", "key", "allow", "--create-bucket", env.S3_ACCESS_KEY_ID])
  if (!docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.Name}}"]).trim())
    docker(["network", "create", network])
  if (!(network in garage.NetworkSettings.Networks))
    docker(["network", "connect", network, garageName])
  // I finish the build before replacing the previous app so build failures leave it available.
  docker([...compose, "build", "--quiet"], env, true)
  const app = inspect(appName)
  if (app) {
    validate(app, settingsProfile.appImage, appPort, "3000")
    if (app.Config.Labels?.["com.docker.compose.project"] !== network)
      throw new Error("The app belongs to another Compose project")
  }
  if (profile === "development") {
    const legacyApp = inspect("silo-production-check")
    if (legacyApp) {
      validate(legacyApp, "silo:verification", "3301", "3000")
      if (legacyApp.Config.Labels?.["com.docker.compose.project"] !== "silo-verification")
        throw new Error("Legacy app belongs to another Compose project")
      // I replace only the verified stateless legacy app after the new image has built.
      docker(["rm", "-f", legacyApp.Id])
    }
  }
  docker([...compose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "60"], env, true)
  console.info(
    `${profile} app ready: ${origin}\nGarage data and credentials are retained. Sign in using ${envFile}.`
  )
  return env
}

async function verify(env: ReturnType<typeof settings>) {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: "garage",
    forcePathStyle: true,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY }
  })
  try {
    const result = await client.send(new ListBucketsCommand({}))
    if (!result.Buckets?.some(bucket => bucket.Name === "silo-empty-check")) {
      docker(["exec", garageName, "/garage", "bucket", "create", "silo-empty-check"])
      docker([
        "exec",
        garageName,
        "/garage",
        "bucket",
        "allow",
        "--read",
        "--write",
        "--owner",
        "silo-empty-check",
        "--key",
        env.S3_ACCESS_KEY_ID
      ])
    }
    const empty = await client.send(
      new ListObjectsV2Command({ Bucket: "silo-empty-check", MaxKeys: 1, EncodingType: "url" })
    )
    if (empty.Contents?.length)
      throw new Error("silo-empty-check contains objects; I never empty it automatically")
  } finally {
    client.destroy()
  }
  const tests = readdirSync(new URL("../tests/", import.meta.url))
    .filter(file => file.endsWith(".test.ts"))
    .map(file => `tests/${file}`)
  execFileSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, SILO_TEST_GARAGE: "1", SILO_TEST_WRITES: "1", SILO_TEST_URL: origin }
  })
}
function stop() {
  const app = inspect(appName)
  const garage = inspect(garageName)
  if (app) validate(app, settingsProfile.appImage, appPort, "3000")
  if (garage) validate(garage, settingsProfile.image, settingsProfile.garagePort, "3900")
  const names = [app && appName, garage && garageName].filter(name => name !== undefined)
  if (names.length) docker(["stop", ...names], process.env, true)
  console.info(`${profile} environment stopped; containers, data and credentials retained`)
}
try {
  migrateDevelopment()
  if (command === "stop") stop()
  else {
    const env = await up()
    if (command === "verify") {
      try {
        await verify(env)
      } finally {
        stop()
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local environment failed")
  process.exitCode = 1
}
