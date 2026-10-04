# Isolated Garage and container verification

The default `npm test` suite needs no storage server. Garage/container tests are skipped unless
explicitly enabled. They must run against disposable fixtures, never an application bucket.

## Daily test workflow

Start Docker, install dependencies once with `npm ci`, then use:

```sh
npm run test:up
```

Open **<http://127.0.0.1:3301>**. This is the single browser test address. The command creates the
Garage fixture only when absent, otherwise starts and reuses it. It rebuilds Silo from the current
working tree before updating the stateless app container. Uploaded objects and the existing
administrator credentials remain intact. Sign in with the username and `SILO_TEST_PASSWORD` saved in
the ignored `.env.silo-test`; never paste that file into logs or documentation.

To change the per-file limit, set `SILO_UPLOAD_MAX_MIB=200` in `.env` and run `test:up` again. The
default is 100 MiB; an explicit setting in `.env.silo-test` overrides `.env`. The browser shows the
active server limit. Integration transport benchmarks still use fixed 100 MiB files.

After changing the application, run `npm run test:up` again and refresh the browser. Restarting the
app can require signing in again because sessions are process-local. There is no separate preview
server or alternate browser port in this workflow. Garage port 3909 is only the SDK fixture
endpoint. The fixture key has bucket-creation rights so the demo can exercise all three write
capabilities. Production permissions are not changed.

```sh
npm run test:integration
npm run test:stop
```

`test:integration` first updates the same app, restores only the named empty test bucket when
missing, then runs all default, Garage, production and write-compatibility tests. It refuses to
empty that bucket if it contains objects. Tests mutate documented fixture keys and their own
randomly named resources; do not put personal objects at those reserved fixture keys. `test:stop`
stops the app and Garage without removing containers, data, network or credentials. The next
`test:up` reuses them. `npm test` remains the fast suite that requires no Docker.

The app is managed by `compose.yaml` plus `compose.test.yaml`, under project `silo-verification`.
The wrapper verifies container image, loopback port and absence of mounts before reuse. On the first
run it adopts only the documented legacy stateless app; the existing Garage container is preserved.
The test overlay is separate from production Compose. Do not run it against user storage.

## Advanced fixture preparation

The following lower-level commands are for fixture diagnosis and compatibility experiments. They are
unnecessary for the daily workflow above.

Install dependencies with `npm ci`. Start Docker, then run from the repository root:

```sh
node --import tsx tests/prepare-garage.ts
```

This script creates only `silo-garage-test` using Garage 2.1.0, bound to loopback port 3909. It
creates a single-node test layout, a fresh random S3 key, `silo-fixture` and `silo-empty-check`. It
seeds 61 paginated objects, nested prefixes, special-character keys and a folder marker. Credentials
are saved to the ignored `.env.silo-test` file, not printed. Test data lives in the disposable
container; there are no host-mounted data volumes.

Fresh fixtures generate a random administrator password and hash in the protected ignored
`.env.silo-test`. Never print this file or copy its secrets into verification records. Existing
fixtures created before authentication need generated authentication settings before reuse.

The script refuses an existing container with that name. This prevents an implicit reset. For
another clean run, explicitly remove your previous fixture container first:

```sh
docker rm -f silo-garage-test
node --import tsx tests/prepare-garage.ts
```

Run the Garage tests:

```sh
SILO_TEST_GARAGE=1 node --env-file=.env.silo-test --import tsx --test tests/garage.test.ts
```

These tests verify real listing, token pagination, metadata, streaming, recursive search and exact
object deletion. They include a carriage-return key beside its normalized neighbor to ensure the
wrong object cannot be deleted. They create/delete only named fixture keys and refuse to delete the
non-empty fixture bucket.

## Write compatibility gate

`tests/bucket-creation.test.ts` runs in the default suite with disposable loopback upstreams and SDK
command mocks. It covers creation naming/HTTP boundaries, regional request shapes and the
single-attempt mutation policy. The opt-in gate below additionally verifies the authenticated
creation API against real Garage, including denied permission, success and an exact-name duplicate.

`tests/write-compatibility.test.ts` is a separately enabled release gate. It creates a random
temporary key through the fixture's Garage CLI, proves bucket creation is denied before the operator
grants permission, then creates one random temporary bucket through the standard S3 API. It verifies
regional CreateBucket, list/read/write/delete rights, streamed bytes and exact keys, both installed
SDK checksum modes, empty markers, existing-content preservation and concurrent conditional creates.
Middleware asserts that `If-None-Match: *` reaches the outgoing HTTP request. Readback compares
actual bytes rather than ETags. Cleanup deletes only exact keys, the bucket and the identity
generated by that run, including after failed assertions.

Run against the existing disposable Garage 2.1.0:

```sh
SILO_TEST_WRITES=1 node --env-file=.env.silo-test --import tsx \
  --test tests/write-compatibility.test.ts
```

To check Garage 2.4.1 independently without upgrading or removing the existing fixture:

```sh
node --import tsx tests/prepare-garage.ts --write-compatibility
SILO_TEST_WRITES=1 node --env-file=.env.silo-write-test --import tsx \
  --test tests/write-compatibility.test.ts
```

This alternative preparation creates only `silo-garage-write-test`, binds it to loopback port 3910
and saves new owner-readable, ignored settings in `.env.silo-write-test`. It refuses an existing
container. The test accepts only the two documented fixture endpoints and maps each to its known
container; never repoint either port at user storage. Docker access and loopback network access are
required. Production Silo does not use the operator CLI.

On 2026-10-04 the original atomic no-overwrite gate failed on both versions with SDK 3.1145.0:
existing bytes were replaced despite the header, and both competing writes succeeded. The product
requirement was explicitly revised that day to mandatory application collision checking and explicit
per-file overwrite confirmation, accepting the external-writer race. The suite now characterizes
conditional support honestly instead of asserting a protection the product no longer promises. It
still asserts actual readback bytes and mandatory HTTP 409 before explicit overwrite.

The revised Garage 2.1.0 run passed all 13 tests, including two concurrent 100 MiB uploads with
SHA-256 readback. `write-server-fixture.ts` isolates server RSS from the parent upload producer and
readback client; the recorded server RSS increase was 49,414,144 bytes for 200 MiB transferred. This
is a disposable loopback measurement, not a production-proxy or arbitrary-load guarantee. The
revised suite has not been rerun on 2.4.1. Default tests skip this opt-in suite.

`tests/upload-config.test.ts` checks default/custom/invalid environment values, authenticated
runtime configuration and the exact configured HTTP boundary before storage work.

`tests/writes.test.ts` checks exact destinations, UTF-8 bounds, collision confirmation, streamed
byte counts, media/origin/session rejection and two-upload admission with slot release and live
health requests. It also checks deadline/disconnect abort, slow-consumer backpressure and early
upstream rejection without retry. A 100 MiB upload with SHA-256 readback and overwrite confirmation
passed through a production container behind nginx with request buffering disabled. Full queue
manual verification and the actual HTTPS deployment checks remain necessary.

After verifying ownership and completing the alternate experiment, remove only its resources:

```sh
docker rm -f silo-garage-write-test
rm .env.silo-write-test
```

## Verify the production image

Use `npm run test:integration`. The wrapper builds the production image and starts it on 3301, then
exercises published HTTP endpoints, SPA deep links, actual SDK credentials being absent from the
frontend bundle and the complete storage workflow. The production check deletes the dedicated
`silo-empty-check` bucket; the next run recreates it with the fixture key's ownership. No manual
network setup, environment flags or container recreation is needed.

Streaming tests wait for the first HTTP chunk before allowing the source to end, so complete
buffering would time out. HTTP tests also need permission to bind ephemeral loopback ports.

## Manual UI checks

Use the production container and only these disposable fixtures:

- Open nested prefixes; use breadcrumbs, Back, Forward and browser refresh.
- Open the unusual-character prefix and confirm the full key in details and Copy key.
- Browse `pages/` with 25/50/100 rows; check that Previous/Next and page changes reset selection.
- Search `REPORT` from the bucket root and confirm both relative nested paths; clear the search.
- Open object and bucket delete dialogs, cancel with Escape, and check focus returns.
- Confirm a differently cased bucket name leaves Delete disabled and the exact name enables it.
- Inspect metadata and download a fixture file; no preview should appear.
- Check light/dark mode, keyboard operation and 320/800/1280-pixel layouts.

No browser E2E automation or browser-testing dependency is installed.

Also verify authentication deep links, exact prefix preservation, expiry, logout, password-manager
fields, network failures and late responses. Production needs separate evidence through an HTTPS
proxy, a trusted IP certificate, Secure cookies and an unreachable direct backend LAN port. Loopback
HTTP tests do not establish this deployment boundary.

## Stop or deliberately remove the fixtures

Use `npm run test:stop` to finish a test session while retaining everything for next time. Removing
Garage destroys uploaded test objects. Only for a deliberate fresh-fixture reset, after checking
that its contents are disposable, remove these known resources:

```sh
docker rm -f silo-production-check silo-garage-test
docker network rm silo-verification
rm .env.silo-test
```

Then `npm run test:up` prepares fresh data and credentials. Ordinary updates never run this reset.

## Git versioning checks

`tests/version.test.ts` uses isolated temporary Git repositories and a local bare origin. It
verifies conventional bumps, annotated stable tag selection, exact/dirty/ahead metadata, environment
overrides, invalid dates, release dry-run invariants, decreasing/prerelease rejection,
branch/dirty-worktree checks, and deployment source isolation with a recording Docker substitute.
Fixture commits and tags never touch the application repository. The substitute checks command
sequencing and archived source; it does not prove Docker image startup. `npm run test:up` covers the
real image build and health check.

For manual checks, inspect the footer in the test app: version and UTC build date should remain
legible in both themes and at narrow widths. For a tagged build, supply a stable version as a build
argument and verify the served bundle contains that exact value. Runtime environment changes alone
must not alter it.
