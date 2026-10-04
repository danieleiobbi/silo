import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { parseEnv } from "node:util"
import { fileURLToPath } from "node:url"
import { setTimeout } from "node:timers/promises"
import { S3Client, ListBucketsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3"

const root = fileURLToPath(new URL("../", import.meta.url))
const envPath = fileURLToPath(new URL("../.env.silo-test", import.meta.url))
const garageName = "silo-garage-test"
const appName = "silo-production-check"
const network = "silo-verification"
const origin = "http://127.0.0.1:3301"
const command = process.argv[2]
if (!["up", "stop", "verify"].includes(command)) throw new Error("Use up, stop or verify")

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
      "A test container name belongs to an unexpected configuration; I leave it intact"
    )
}
function settings() {
  if (!existsSync(envPath))
    throw new Error("The existing Garage requires its original .env.silo-test")
  const fixture = parseEnv(readFileSync(envPath, "utf8"))
  if (
    fixture.S3_ENDPOINT !== "http://127.0.0.1:3909" ||
    fixture.S3_REGION !== "garage" ||
    !fixture.S3_ACCESS_KEY_ID ||
    !fixture.S3_SECRET_ACCESS_KEY ||
    !fixture.SILO_TEST_PASSWORD
  )
    throw new Error("The test settings do not describe the documented disposable Garage")
  return {
    ...process.env,
    ...fixture,
    S3_ENDPOINT: fixture.S3_ENDPOINT,
    S3_ACCESS_KEY_ID: fixture.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: fixture.S3_SECRET_ACCESS_KEY,
    SILO_PORT: "3301",
    SILO_PUBLIC_ORIGIN: origin
  }
}
const compose = [
  "compose",
  "--project-name",
  "silo-verification",
  "--env-file",
  ".env.silo-test",
  "-f",
  "compose.yaml",
  "-f",
  "compose.test.yaml"
]

async function up() {
  let garage = inspect(garageName)
  if (!garage) {
    execFileSync(process.execPath, ["--import", "tsx", "tests/prepare-garage.ts"], {
      cwd: root,
      stdio: "inherit"
    })
    garage = inspect(garageName)
  }
  if (!garage) throw new Error("Garage fixture preparation did not create its container")
  validate(garage, "dxflrs/garage:v2.1.0", "3909", "3900")
  const env = settings()
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
          throw new Error("The fixture S3 endpoint did not become ready with the saved credentials")
      }
      await setTimeout(500)
    }
  } finally {
    client.destroy()
  }
  // I grant bucket creation only to the already verified disposable fixture key.
  docker(["exec", garageName, "/garage", "key", "allow", "--create-bucket", env.S3_ACCESS_KEY_ID])
  if (!docker(["network", "ls", "--filter", `name=^${network}$`, "--format", "{{.Name}}"]).trim())
    docker(["network", "create", network])
  if (!(network in garage.NetworkSettings.Networks))
    docker(["network", "connect", network, garageName])
  // I finish the build before replacing the previous app so build failures leave it available.
  docker([...compose, "build", "--quiet"], env, true)
  const app = inspect(appName)
  if (app) {
    validate(app, "silo:verification", "3301", "3000")
    const project = app.Config.Labels?.["com.docker.compose.project"]
    if (project && project !== "silo-verification")
      throw new Error("The app belongs to another Compose project")
    if (!project) {
      if (
        Object.keys(app.NetworkSettings.Networks).length !== 1 ||
        !(network in app.NetworkSettings.Networks)
      )
        throw new Error("The legacy app is not attached exclusively to the test network")
      // I migrate only the verified stateless legacy app; I preserve the Garage container and data.
      docker(["rm", "-f", app.Id])
    }
  }
  docker([...compose, "up", "-d", "--no-build", "--wait", "--wait-timeout", "60"], env, true)
  console.info(
    `Test app ready: ${origin}\nGarage data and credentials are retained. Sign in using .env.silo-test.`
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
  const tests = readdirSync(new URL("./", import.meta.url))
    .filter(file => file.endsWith(".test.ts"))
    .map(file => `tests/${file}`)
  execFileSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, SILO_TEST_GARAGE: "1", SILO_TEST_WRITES: "1", SILO_TEST_URL: origin }
  })
}
try {
  if (command === "stop") {
    const app = inspect(appName)
    const garage = inspect(garageName)
    if (app) validate(app, "silo:verification", "3301", "3000")
    if (garage) validate(garage, "dxflrs/garage:v2.1.0", "3909", "3900")
    const names = [app && appName, garage && garageName].filter((name): name is string =>
      Boolean(name)
    )
    if (names.length) docker(["stop", ...names], process.env, true)
    console.info("Test environment stopped. Containers, data and credentials are retained.")
  } else {
    const env = await up()
    if (command === "verify") await verify(env)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Test environment failed")
  process.exitCode = 1
}
