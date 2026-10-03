# Isolated Garage and container verification

The default `npm test` suite needs no storage server. Garage/container tests are skipped unless
explicitly enabled. They must run against disposable fixtures, never an application bucket.

## Prepare fresh fixtures

Install dependencies with `npm ci`. Start Docker, then run from the repository root:

```sh
node --import tsx tests/prepare-garage.ts
```

This script creates only `silo-garage-test` using Garage 2.1.0, bound to loopback port 3909. It
creates a single-node test layout, a fresh random S3 key, `silo-fixture` and `silo-empty-check`. It
seeds 61 paginated objects, nested prefixes, special-character keys and a folder marker. Credentials
are saved to the ignored `.env.silo-test` file, not printed. Test data lives in the disposable
container; there are no host-mounted data volumes.

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

## Verify a production container

Create a network for the two test containers, then build and run Silo:

```sh
docker network create silo-verification
docker network connect silo-verification silo-garage-test
docker build -t silo:verification .
docker run -d --name silo-production-check \
  --network silo-verification \
  --env-file .env.silo-test \
  -e S3_ENDPOINT=http://silo-garage-test:3900 \
  -e PORT=3000 \
  -p 127.0.0.1:3301:3000 \
  silo:verification
```

If the network already exists, reuse it; do not create a second one. Open <http://localhost:3301>
for manual UI checks. Then run the complete suite:

```sh
SILO_TEST_GARAGE=1 SILO_TEST_URL=http://127.0.0.1:3301 \
  node --env-file=.env.silo-test --import tsx --test tests/*.test.ts
```

The production check exercises the published HTTP endpoints, confirms the SPA deep-link response,
checks that actual fixture credentials do not appear in the JS bundle, and **deletes
`silo-empty-check`** after validating the typed confirmation. Prepare fresh fixtures before
rerunning this check, or explicitly recreate that empty test bucket and grant the test key
ownership.

Unit tests cover search caps without generating thousands of remote objects. Streaming tests wait
for the first HTTP chunk before allowing the source to end, so complete buffering would time out.
HTTP tests also need permission to bind an ephemeral loopback port.

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

## Clean up

Remove only the containers and network created for this test workflow:

```sh
docker rm -f silo-production-check silo-garage-test
docker network rm silo-verification
rm .env.silo-test
```

These commands destroy the disposable fixtures. They do not target an existing Garage deployment.
