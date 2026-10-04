import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildMetadata, git, latestRelease, releasePattern } from "./version"

const root = git(process.cwd(), "rev-parse", "--show-toplevel")
const [command, requested, ...extra] = process.argv.slice(2)
let temporary: string | undefined
try {
  if (
    !["build", "up", "deploy"].includes(command) ||
    extra.length ||
    (requested && command !== "deploy")
  )
    throw new Error("Usage: npm run docker:build | docker:up | deploy -- [vX.Y.Z]")
  let metadata = buildMetadata(root)
  if (command === "deploy") {
    git(root, "fetch", "origin", "main", "--tags")
    const tag = requested ?? latestRelease(root, "origin/main")
    if (
      !tag ||
      !releasePattern.test(tag) ||
      git(root, "cat-file", "-t", `refs/tags/${tag}`) !== "tag"
    )
      throw new Error("Deployment requires an annotated vX.Y.Z tag")
    git(root, "merge-base", "--is-ancestor", `refs/tags/${tag}^{commit}`, "origin/main")
    const remote = git(root, "ls-remote", "origin", `refs/tags/${tag}`)
    if (remote.split(/\s/)[0] !== git(root, "rev-parse", `refs/tags/${tag}`))
      throw new Error("The tag must match the published origin tag")
    temporary = mkdtempSync(join(tmpdir(), "silo-release-"))
    const archive = join(temporary, "source.tar")
    git(root, "archive", "--format=tar", `--output=${archive}`, `refs/tags/${tag}`)
    execFileSync("tar", ["-xf", archive, "-C", temporary])
    rmSync(archive)
    metadata = { VITE_APP_VERSION: tag, VITE_BUILD_DATE: new Date().toISOString() }
    console.info(`Deploying ${tag}`)
  }
  const env = { ...process.env, ...metadata, SILO_BUILD_CONTEXT: temporary ?? root }
  // I retain the operator's environment while reading application configuration from the selected source.
  const compose = [
    "compose",
    "--project-directory",
    root,
    "-f",
    join(temporary ?? root, "compose.yaml")
  ]
  execFileSync("docker", [...compose, "build"], { cwd: root, env, stdio: "inherit" })
  if (command !== "build")
    execFileSync("docker", [...compose, "up", "-d", "--no-build", "--wait"], {
      cwd: root,
      env,
      stdio: "inherit"
    })
} catch (error) {
  console.error(error instanceof Error ? error.message : "Docker workflow failed")
  process.exitCode = 1
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
