import { createInterface } from "node:readline/promises"
import { git, latestRelease, nextRelease, releasePattern } from "./version"

async function main() {
  const root = git(process.cwd(), "rev-parse", "--show-toplevel")
  const args = process.argv.slice(2)
  const forced = args.filter(arg => arg !== "--dry-run")
  if (forced.length > 1 || (forced[0] && !releasePattern.test(forced[0])))
    throw new Error("Usage: ./release.sh [--dry-run] [vX.Y.Z]; stable releases only")
  if (git(root, "branch", "--show-current") !== "main") throw new Error("Release requires main")
  if (git(root, "status", "--porcelain"))
    throw new Error("Commit or stash changes before releasing")
  // I refresh remote references even in dry-run, without changing commits or tags.
  git(root, "fetch", "origin", "main", "--tags")
  const [, behind] = git(root, "rev-list", "--left-right", "--count", "HEAD...origin/main")
    .split(/\s+/)
    .map(Number)
  if (behind)
    throw new Error(
      "Local main is behind or divergent from origin/main; reconcile it before releasing"
    )
  const head = git(root, "rev-parse", "HEAD")
  const previous = latestRelease(root)
  const range = previous ? `${previous}..HEAD` : "HEAD"
  const subjects = git(root, "log", range, "--format=%s")
  if (!subjects) {
    console.info("No new commits to release")
    return
  }
  const tag = forced[0] ?? nextRelease(previous, subjects, git(root, "log", range, "--format=%b"))
  if (git(root, "tag", "--list", tag)) throw new Error("The requested tag already exists")
  if (previous) {
    const a = tag.slice(1).split(".").map(BigInt)
    const b = previous.slice(1).split(".").map(BigInt)
    const first = a.findIndex((value, i) => value !== b[i])
    if (first < 0 || a[first] < b[first]) throw new Error("The version must increase")
  }
  console.info(`Previous: ${previous ?? "none"}\nNext: ${tag}\n\n${subjects}`)
  if (args.includes("--dry-run")) return
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    if ((await prompt.question(`Create annotated tag ${tag}? [y/N] `)).toLowerCase() !== "y") return
    if (git(root, "rev-parse", "HEAD") !== head || git(root, "status", "--porcelain"))
      throw new Error("The checkout changed during confirmation")
    git(root, "tag", "-a", tag, head, "-m", `Release ${tag}`)
    if ((await prompt.question(`Push main and ${tag} to origin? [y/N] `)).toLowerCase() === "y")
      git(root, "push", "--atomic", "origin", `${head}:refs/heads/main`, `refs/tags/${tag}`)
    else console.info(`Push later: git push --atomic origin main refs/tags/${tag}`)
  } finally {
    prompt.close()
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "Release failed")
  process.exitCode = 1
})
