import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { buildMetadata, git, latestRelease, nextRelease } from "../scripts/version"

test("release bump follows conventional subjects and breaking footers", () => {
  assert.equal(nextRelease(undefined, "fix: corrects listing", ""), "v0.0.1")
  assert.equal(nextRelease("v1.2.3", "feat(ui): adds filters", ""), "v1.3.0")
  assert.equal(nextRelease("v1.2.3", "fix(api)!: changes contract", ""), "v2.0.0")
  assert.equal(nextRelease("v1.2.3", "fix: changes contract", "BREAKING-CHANGE: changed"), "v2.0.0")
  assert.equal(
    nextRelease("v1.2.3", "docs: explains BREAKING CHANGE:", "Example BREAKING CHANGE:"),
    "v1.2.4"
  )
})

test("Git metadata and release dry-run use annotated stable tags without mutating history", () => {
  const directory = mkdtempSync(join(tmpdir(), "silo-version-test-"))
  const repo = join(directory, "repo")
  const remote = join(directory, "remote.git")
  const run = (...args: string[]) => git(repo, ...args)
  try {
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" })
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" })
    run("config", "user.email", "fixture@example.invalid")
    run("config", "user.name", "Version fixture")
    run("config", "commit.gpgsign", "false")
    run("config", "tag.gpgsign", "false")
    writeFileSync(join(repo, "source"), "first\n")
    run("add", ".")
    run("commit", "-m", "feat: adds fixture")
    run("remote", "add", "origin", remote)
    run("push", "-u", "origin", "main")
    assert.match(buildMetadata(repo, {}).VITE_APP_VERSION, /^[a-f0-9]+$/)
    run("tag", "-a", "v1.2.3", "-m", "Release v1.2.3")
    run("tag", "v9.0.0")
    run("tag", "-a", "v8.0.0-rc.1", "-m", "Preview")
    assert.equal(latestRelease(repo), "v1.2.3")
    assert.equal(buildMetadata(repo, {}).VITE_APP_VERSION, "v1.2.3")
    writeFileSync(join(repo, "source"), "second\n")
    assert.equal(buildMetadata(repo, {}).VITE_APP_VERSION, "v1.2.3-dirty")
    run("add", ".")
    run("commit", "-m", "feat(ui): adds fixture detail")
    assert.match(buildMetadata(repo, {}).VITE_APP_VERSION, /^v1\.2\.3-1-g[a-f0-9]+$/)
    const head = run("rev-parse", "HEAD")
    const tags = run("tag")
    const release = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("scripts/release.ts"),
          ...args
        ],
        { cwd: repo, encoding: "utf8" }
      )
    const dry = release("--dry-run")
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /Next: v1\.3\.0/)
    assert.equal(run("rev-parse", "HEAD"), head)
    assert.equal(run("tag"), tags)
    assert.notEqual(release("--dry-run", "v1.0.0").status, 0)
    assert.notEqual(release("--dry-run", "v2.0.0-rc.1").status, 0)
    run("push", "origin", "main", "refs/tags/v1.2.3")
    const bin = join(directory, "bin")
    mkdirSync(bin)
    const log = join(directory, "docker-log")
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" "$VITE_APP_VERSION" "$VITE_BUILD_DATE" "$SILO_BUILD_CONTEXT" >> "$SILO_TEST_LOG"
cat "$SILO_BUILD_CONTEXT/source" >> "$SILO_TEST_LOG"
`
    )
    chmodSync(join(bin, "docker"), 0o755)
    writeFileSync(join(repo, "source"), "uncommitted work\n")
    const deploy = spawnSync(
      process.execPath,
      [
        "--import",
        resolve("node_modules/tsx/dist/loader.mjs"),
        resolve("scripts/docker.ts"),
        "deploy",
        "v1.2.3"
      ],
      {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SILO_TEST_LOG: log }
      }
    )
    assert.equal(deploy.status, 0, deploy.stderr)
    const calls = readFileSync(log, "utf8")
    assert.match(calls, /v1\.2\.3/)
    assert.match(calls, /first/)
    assert.match(calls, /up -d --no-build --wait/)
    assert.doesNotMatch(calls, /uncommitted work|second/)
    assert.equal(readFileSync(join(repo, "source"), "utf8"), "uncommitted work\n")
    assert.equal(run("rev-parse", "HEAD"), head)
    writeFileSync(join(repo, "source"), "second\n")
    writeFileSync(join(repo, "untracked"), "dirty")
    assert.notEqual(release("--dry-run").status, 0)
    rmSync(join(repo, "untracked"))
    run("switch", "-c", "feature")
    assert.notEqual(release("--dry-run").status, 0)
    writeFileSync(join(repo, "remote-change"), "remote update")
    run("add", ".")
    run("commit", "-m", "fix: updates remote fixture")
    run("push", "origin", "HEAD:main")
    run("switch", "main")
    const behind = release("--dry-run")
    assert.notEqual(behind.status, 0)
    assert.match(behind.stderr, /behind or divergent/)
    writeFileSync(join(repo, "local-change"), "local update")
    run("add", ".")
    run("commit", "-m", "fix: updates local fixture")
    assert.match(release("--dry-run").stderr, /behind or divergent/)
    assert.deepEqual(
      buildMetadata(directory, {
        VITE_APP_VERSION: "v4.5.6",
        VITE_BUILD_DATE: "2026-10-04T12:00:00Z"
      }),
      { VITE_APP_VERSION: "v4.5.6", VITE_BUILD_DATE: "2026-10-04T12:00:00.000Z" }
    )
    assert.equal(buildMetadata(directory, {}).VITE_APP_VERSION, "unknown")
    assert.throws(() => buildMetadata(repo, { VITE_BUILD_DATE: "invalid" }))
    assert.equal(readFileSync(join(repo, "source"), "utf8"), "second\n")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
