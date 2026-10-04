import { execFileSync } from "node:child_process"

export const releasePattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()
}

export function latestRelease(cwd: string, ref = "HEAD") {
  return git(cwd, "tag", "--merged", ref, "--sort=-version:refname")
    .split("\n")
    .find(
      tag => releasePattern.test(tag) && git(cwd, "cat-file", "-t", `refs/tags/${tag}`) === "tag"
    )
}

export function buildMetadata(cwd: string, env = process.env) {
  let version = env.VITE_APP_VERSION
  if (!version) {
    try {
      const tag = latestRelease(cwd)
      version = git(
        cwd,
        "describe",
        "--always",
        "--dirty",
        ...(tag ? ["--match", tag] : ["--match", "__no_release_tag__"])
      )
    } catch {
      version = "unknown"
    }
  }
  const date = env.VITE_BUILD_DATE || new Date().toISOString()
  if (!Number.isFinite(Date.parse(date))) throw new Error("VITE_BUILD_DATE must be a valid date")
  return { VITE_APP_VERSION: version, VITE_BUILD_DATE: new Date(date).toISOString() }
}

export function nextRelease(previous: string | undefined, subjects: string, bodies: string) {
  const parts = (previous ?? "v0.0.0").slice(1).split(".").map(BigInt)
  if (/^[a-z]+(?:\([^)]+\))?!:/m.test(subjects) || /^BREAKING[ -]CHANGE:/m.test(bodies))
    return `v${parts[0] + 1n}.0.0`
  if (/^feat(?:\([^)]+\))?:/m.test(subjects)) return `v${parts[0]}.${parts[1] + 1n}.0`
  return `v${parts[0]}.${parts[1]}.${parts[2] + 1n}`
}
