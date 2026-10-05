# Silo

Silo is a small web console for inspecting objects stored in Garage. It uses standard S3 APIs, with
one configured endpoint and server-side credentials. React runs in the browser; Express serves both
the API and the compiled interface from one Node process.

## What you can do

- List accessible buckets and their creation dates, when storage returns them.
- Open a bucket, follow prefixes as folders, and navigate with breadcrumbs.
- Browse 25, 50 or 100 entries at a time using Previous and Next.
- Search object keys recursively beneath the current prefix.
- Inspect full keys, sizes, modification dates, ETags, Content-Type and custom metadata.
- Copy a key or download an object through Silo.
- Delete one object or the objects selected on the current page.
- Delete an empty bucket after typing its exact name.
- Create an empty bucket or a zero-byte folder marker.
- Upload files through the picker or drop them into the current browsing workspace.

The Create bucket dialog uses `POST /api/buckets` and JSON `{ "name": "example-bucket" }`. Creation
requires operator-granted bucket-creation permission on the configured S3 key; Silo never grants
itself rights or configures the storage server. New names use 3–63 lowercase ASCII letters, digits
or hyphens, with an alphanumeric first and last character, excluding AWS-reserved prefixes/suffixes.
Silo rejects invalid names without rewriting them and checks exact visible names before creation.
This check is advisory; the provider decides final conflicts. Existing bucket navigation remains
unrestricted by the creation subset.

Creation sends only the bucket name and configured region (omitting LocationConstraint for
`us-east-1`), with no settings or ACL changes requested. The API returns `201` and
`{ "name": "..." }` after storage confirms success. It requires a valid session, matching Origin and
a JSON body; invalid names return `400`, unsupported bodies `415`, conflicts `409` and storage
permission denial `403`. CreateBucket is never automatically retried. On `502`/`504` with
`code: "OutcomeUnknown"`, refresh and inspect the bucket list before another explicit attempt. Some
providers may accept an existing owned name idempotently, so a successful response alone does not
prove the bucket was new.

Uploads preserve the original filename and exact destination prefix. The queue retains at most 100
entries and sends one file at a time. The default per-file limit is 100 MiB, configured with
`SILO_UPLOAD_MAX_MIB`; empty files are accepted. The server admits at most two uploads across all
clients. Files stream through Express to S3 without whole-file buffering or automatic retries.
Progress measures bytes sent; Uploaded appears only after storage confirms completion. The queue
survives navigation but clears on logout/session expiry. Directories cannot be uploaded; mixed drops
reject unsupported entries individually. Uploads are available while browsing, not in recursive
search results.

Before forwarding an upload body, Silo checks the exact key with HeadObject. If it exists, the API
returns 409 and the queue warns that the file will be overwritten. Review overwrite opens a native
confirmation dialog showing the exact destination. Only confirmation sends `overwrite=true` for that
attempt; a later retry repeats the check without reusing authorization. Unconfirmed creates also
send `If-None-Match: *`. Disposable Garage 2.1.0 and 2.4.1 ignored this condition, so the check is
advisory: another client can create or change an object between the check and write. Silo does not
promise atomic protection against concurrent external writers.

Create folder sends `POST /api/buckets/:bucket/folders` with `{ "prefix": "...", "name": "..." }`
and creates an exact trailing-slash, zero-byte marker. Existing markers or descendants cause a
conflict; folder creation has no overwrite action. Prefixes are never normalized. The folder name
must be one segment; destination keys must fit within 1,024 UTF-8 bytes.

Uploads use `PUT /api/buckets/:bucket/object?key=...&size=...` with an octet-stream body, a valid
session and matching Origin. Compressed bodies are rejected. Silo counts incoming bytes and checks
Content-Length when supplied. A five-minute deadline and client disconnect abort the upstream
request. Cancellation, lost connections and ambiguous upstream failures may occur after storage
commits: inspect the destination before retrying. Cancel does not undo an object already stored.
Proxy access logs must not record upload query strings containing keys.

There is no rename, move, content preview or storage administration. Silo does not use Garage's
Admin API; storage permissions remain controlled by the operator.

## Develop locally

With Docker running and dependencies installed using `npm ci`:

```sh
npm run dev:up
```

Open **<http://127.0.0.1:3301>**. Repeat the command after code changes to rebuild the app.
Development storage and credentials are retained across updates. Login with `admin` and the
`SILO_DEV_PASSWORD` in the ignored, owner-readable `.env.development`. `npm run dev:stop` stops the
development app and Garage without deleting either or their data.

The first run migrates the former shared test/development environment: it renames the verified
Garage container and moves `.env.silo-test` to `.env.development`, preserving storage credentials,
the administrator password and objects. It replaces only the verified stateless app after building
its new image. The browser address remains unchanged. Subsequent integration runs create their own
`.env.silo-test` with independent credentials.

For faster source updates, use `npm run dev:web` and `npm run dev:server` in separate terminals. The
server command loads `.env.development`; set `SILO_PUBLIC_ORIGIN=http://127.0.0.1:5173` when
starting it for the Vite browser on that origin. Development Garage remains on loopback port 3909.

## Run tests

```sh
npm test
npm run test:integration
```

`npm test` runs the fast suite without Garage. `test:integration` builds a separate production
container on loopback port 3302, prepares/reuses isolated Garage on port 3911, runs the full suite,
and stops only the integration app and storage afterward. Integration settings are in
`.env.silo-test`; tests never use `.env.development`. Development remains available on port 3301.
The integration storage contains disposable fixtures and can be mutated by tests. See
[the integration workflow](tests/README.md) for its boundaries and low-level checks.

## Before running Silo

Silo requires one configured administrator account for every storage operation. Shared credentials
grant the same privileges to everyone using them; S3 permissions remain the final authorization
boundary. Production browser access requires HTTPS, including on a private network or VPN.

You need an existing Garage deployment and an S3 key with the permissions you intend to expose. Silo
does not discover permissions in advance: it attempts each operation and reports the storage
server's response. It never creates or configures Garage for you.

Credentials belong only in the server environment. Do not put them in `VITE_*` variables or commit
them. The example environment file contains no working credentials; `.env` files are ignored by Git
and excluded from the Docker build context.

## Git versions and releases

Annotated stable Git tags (`vX.Y.Z`) are the release version source. Package manifests stay at
`0.0.0`. The footer shows the version and UTC build date; Vite embeds both when building, so
changing runtime environment variables cannot change an existing bundle.

Local Vite builds read Git automatically. Between releases the version includes the commit distance
and hash, with `-dirty` for tracked modifications. Before the first tag it is a short commit hash.
Untracked files do not affect Git describe. Builds without Git metadata use `unknown`, unless
`VITE_APP_VERSION` is supplied. `VITE_BUILD_DATE` defaults to the current UTC timestamp. These two
variables contain public build information only, never credentials.

Use `npm run docker:up` to build and start the current checkout with host-generated metadata.
`npm run docker:build` only builds. `npm run dev:up` also injects these values into the local
development image. Plain Compose and direct Docker builds remain supported, but require explicit
build arguments for a known version because `.git` is excluded from the image:

```sh
VITE_APP_VERSION="$(git describe --always --dirty)" \
VITE_BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" docker compose build
```

To prepare a release, commit the reviewed changes on `main`, then run:

```sh
node --import tsx scripts/release.ts --dry-run
node --import tsx scripts/release.ts
```

The release script fetches `origin/main` and tags (including during dry-run), requires a clean
worktree and a main branch equal to or ahead of origin, and calculates the next version from commits
since the highest reachable annotated stable tag. Breaking subjects or breaking-change footers bump
the major, `feat` bumps the minor, and other commits bump the patch. Without a previous tag it
starts from `v0.0.0`. An explicit increasing stable version can be supplied, for example
`node --import tsx scripts/release.ts --dry-run v1.0.0`. Prerelease tags are not supported.

The script asks before creating the annotated tag and separately before an atomic push of main and
that specific tag. It never changes package versions, creates a commit or rewrites existing tags. No
new commits means no release. A server that rejects atomic push leaves the local tag intact; resolve
the server limitation before publishing it manually.

On the deployment host, install dependencies with `npm ci`, configure `.env`, then use:

```sh
npm run deploy
# Or select a published release explicitly:
npm run deploy -- v1.0.0
```

Deployment fetches without forcing tags and selects the highest annotated stable tag reachable from
`origin/main`, or the explicit tag. It verifies that the tag matches origin and belongs to main's
history, extracts its source into a temporary directory, builds with the exact version, and only
then replaces the Compose service. The selected tag supplies both Dockerfile and Compose
configuration; the deployment checkout supplies the operator's `.env` and Compose project identity.
The checkout and uncommitted edits are preserved. Temporary source is removed after success or
failure. A build failure leaves the running service intact; a startup failure is reported, without
automatic rollback. Deploy a previous published tag explicitly to roll back.

Only tags containing this versioning workflow can be deployed this way. Publishing ordinary main
commits does not deploy anything. There is no staging environment or automatic CI deployment in this
repository.

## Use a published image with an existing Garage

The `Publish release image` GitHub Actions workflow runs automatically when an annotated stable
`vX.Y.Z` tag is pushed. Ordinary commits and branch pushes do not publish images. The tagged commit
must belong to `main`. Type checks, lint, default tests, build, formatting and disposable Garage
integration tests must pass before publication. No production credentials are needed by Actions.

If GitHub did not start a run for a release tag, open **Actions → Publish release image → Run
workflow** on `main` and enter the existing tag in `release_tag`, or run
`gh workflow run release-image.yaml --ref main -f release_tag=v0.1.0`. The manual run checks out
that exact annotated release, validates its format and membership in `main`, and runs the same
checks before publishing. It cannot publish an arbitrary branch or untagged commit. Do not rerun a
release that has already published successfully; use a new version for changes.

Each release publishes `ghcr.io/danieleiobbi/silo:vX.Y.Z` for Linux AMD64 and ARM64. There is no
floating `latest` tag: select an explicit release, or pin its digest for an immutable deployment.
Source image builds require BuildKit (Docker Buildx or current Docker Compose). The compilation
stage uses the builder's native platform because its JavaScript and frontend output is portable;
runtime dependencies are installed separately for each target architecture. This avoids running the
frontend build and development dependency installation under ARM64 emulation on AMD64 runners. The
workflow publishes an image, not a deployment, and does not contact your production Garage. The
first image will become available only after this workflow is committed and a release tag is pushed
successfully. GHCR packages are initially private; the package owner must set package visibility to
public to allow unauthenticated pulls, or consumers must authenticate to GHCR with a token that has
`read:packages`. Repository visibility does not automatically make a package public.

Download `compose.image.yaml` and `.env.example` from the selected release's Git tag into your
deployment directory. No source checkout, Node.js or npm is required on the deployment host:

```sh
cp .env.example .env
chmod 600 .env
```

Set `SILO_VERSION` in `.env` to the published tag, such as `v1.0.0` (an example, not a promise that
this version exists). Generate the administrator password hash using that same image:

```sh
docker run --rm -it ghcr.io/danieleiobbi/silo:v1.0.0 node apps/server/dist/auth/hash-password.js
```

Configure the S3 endpoint, region and credentials, administrator username/hash and HTTPS public
origin in `.env`. Keep credentials in `.env`, outside version control. Then start:

```sh
docker compose -f compose.image.yaml pull
docker compose -f compose.image.yaml up -d
```

To add Silo to an existing project, add this service under the existing `services` mapping in its
Compose file. Preserve the project's other services. This example assumes Garage's service name is
`garage` and its S3 API listens on port `3900`:

```yaml
services:
  silo:
    image: ghcr.io/danieleiobbi/silo:${SILO_VERSION:?Set SILO_VERSION}
    restart: unless-stopped
    environment:
      PORT: 3000
      S3_ENDPOINT: http://garage:3900
      S3_REGION: garage
      S3_ACCESS_KEY_ID: ${SILO_S3_ACCESS_KEY_ID:?Set SILO_S3_ACCESS_KEY_ID}
      S3_SECRET_ACCESS_KEY: ${SILO_S3_SECRET_ACCESS_KEY:?Set SILO_S3_SECRET_ACCESS_KEY}
      SILO_ADMIN_USERNAME: ${SILO_ADMIN_USERNAME:?Set SILO_ADMIN_USERNAME}
      SILO_ADMIN_PASSWORD_HASH: ${SILO_ADMIN_PASSWORD_HASH:?Set SILO_ADMIN_PASSWORD_HASH}
      SILO_PUBLIC_ORIGIN: ${SILO_PUBLIC_ORIGIN:?Set SILO_PUBLIC_ORIGIN}
      SILO_UPLOAD_MAX_MIB: 100
    ports:
      - "127.0.0.1:3301:3000"
```

Add these variables to the existing project's `.env`, replacing all example values. Select a
published version and generate the password hash with the image command above:

```dotenv
SILO_VERSION=v1.0.0
SILO_S3_ACCESS_KEY_ID=replace-with-silo-access-key
SILO_S3_SECRET_ACCESS_KEY=replace-with-silo-secret-key
SILO_ADMIN_USERNAME=admin
SILO_ADMIN_PASSWORD_HASH=replace-with-generated-hash
SILO_PUBLIC_ORIGIN=https://silo.example.com
```

The `SILO_S3_*` variables keep Silo's credentials separate from other services' variables; Compose
passes them into Silo as the required `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Use a dedicated
Garage S3 key, not an Admin API token. Keep `.env` outside version control. Start only Silo from the
existing project's directory:

```sh
docker compose pull silo
docker compose up -d silo
docker compose logs -f silo
```

For updates or application rollbacks in this existing project, change `SILO_VERSION` and repeat
`docker compose pull silo` and `docker compose up -d silo`.

Attach Silo to the same network as Garage and replace `garage` in the endpoint with the actual
service name. If Garage uses the project's default network, no explicit network configuration is
needed. If it uses an explicit network, attach Silo to that network too. For a separate Compose
project using an existing network, add this configuration and set `SILO_STORAGE_NETWORK` to the
existing network's exact name:

```yaml
services:
  silo:
    networks:
      - storage
networks:
  storage:
    external: true
    name: ${SILO_STORAGE_NETWORK:?Set the existing Garage network name}
```

Keep the loopback port binding when a host HTTPS proxy forwards to Silo. For a containerized proxy,
also attach Silo to its private network and forward to `silo:3000`; see the authentication/proxy
requirements below. Silo requires no volume or database and starts no Garage service. Use a
dedicated S3 key with only the permissions you intend to expose through Silo, including its write
operations.

For an update, change `SILO_VERSION`, then repeat `pull` and `up -d`. To roll back the application,
select the previous release and repeat those commands; this does not restore deleted storage data.
Do not move published Git tags or overwrite an existing release image. Correct a release with a new
version. `npm run deploy` remains the optional source-build workflow and does not pull from GHCR.

## Run with Docker Compose

```sh
cp .env.example .env
chmod 600 .env
npm ci
npm run --silent auth:hash-password
```

The generator requests the password twice without displaying it. Copy the hash into
`SILO_ADMIN_PASSWORD_HASH`, set `SILO_ADMIN_USERNAME` and `SILO_PUBLIC_ORIGIN`, and configure your
endpoint, region, access key and secret key in `.env`, then run:

```sh
npm run docker:up
```

For local verification, set `SILO_PUBLIC_ORIGIN=http://localhost:3000` and open that exact address.
Keep the supplied loopback binding for a production host HTTPS proxy. Do not publish the backend
HTTP port to the LAN. No Silo volume or database is required.

The endpoint must be reachable **from inside the Silo container**:

- Garage in the same Compose project/network: use its service name, such as `http://garage:3900`.
- Garage on your host: `.env.example` uses `http://host.docker.internal:3900`. Your Docker runtime
  must support that hostname and Garage must listen on an interface reachable from containers.
- Garage on another server: use its private hostname/IP and S3 port.

`localhost` inside a container refers to that container, not to your host. If Garage already runs in
another Compose project, attach Silo to that deployment's existing network or use a reachable
private endpoint. The supplied Compose file starts only Silo and does not change an existing Garage
service.

Useful commands:

```sh
docker compose ps
docker compose logs -f silo
docker compose down
```

### Configuration

| Variable               | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `S3_ENDPOINT`          | Required HTTP(S) S3 endpoint. Compose defaults to `http://garage:3900`. |
| `S3_REGION`            | Required S3 signing region. Compose defaults to `garage`.               |
| `S3_ACCESS_KEY_ID`     | Required access key; no default.                                        |
| `S3_SECRET_ACCESS_KEY` | Required secret key; no default.                                        |
| `PORT`                 | Required application listening port. Compose sets it to `3000`.         |
| `SILO_PORT`            | Optional host port used by Compose; defaults to `3000`.                 |
| `SILO_UPLOAD_MAX_MIB`  | Optional per-file upload limit in MiB; integer 1–4096, default `100`.   |

For example, set `SILO_UPLOAD_MAX_MIB=200` in `.env` to allow files up to 200 MiB (209,715,200
bytes). Restart/recreate Silo after changing it; the frontend reads the active limit from an
authenticated, uncached API and needs no separate build-time configuration. Invalid values stop
server startup. The upper bound is a conservative 4 GiB for the single-PUT transport; this does not
enable multipart uploads. Storage limits and the absolute five-minute transfer deadline still apply.
[AWS documents the single-PUT limit](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html).

For local development, set the limit in `.env.development` and run `npm run dev:up`. An explicit
value there takes precedence over the optional upload limit in `.env`; no other operator settings or
credentials are copied from `.env`. Integration reads its own limit from `.env.silo-test` and
defaults independently to 100 MiB.

The server validates configuration before listening and exits non-zero for missing or invalid
values. It uses path-style S3 addressing internally. There is no `S3_BUCKET_NAME`, provider switch
or connection profile: the key determines the buckets the instance can access.

### Without Compose

After preparing `.env`, you can build and run the same image directly:

```sh
docker build -t silo .
docker run --rm --name silo --env-file .env -p 127.0.0.1:3000:3000 silo
```

The image contains compiled server code, frontend assets and production server dependencies. It runs
as the non-root `node` user, exposes one application port and starts Node directly as its main
process.

## Local development

Set `SILO_PUBLIC_ORIGIN` to the exact Vite origin, normally `http://localhost:5173`. Local HTTP is
allowed only for literal `localhost`, `127.0.0.1` or `[::1]` and still requires login. When serving
compiled assets directly, change the origin to the Express browser address.

Use Node.js 22.12 or later in the Node 22 line, and npm. After `npm ci`, prepare `.env` as above,
but use an endpoint reachable from your host, for example `http://127.0.0.1:3900`.

Start the server from the repository root:

```sh
node --env-file=.env --import tsx --watch apps/server/src/index.ts
```

In a second terminal:

```sh
npm run dev:web
```

Open the URL printed by Vite. Vite forwards `/api` to `http://127.0.0.1:3000`, so keep `PORT=3000`
for this development setup. `npm run dev:server` is equivalent when the required variables are
already exported in your shell. Development uses two processes for hot reload; production uses one.

To build and run the production assets locally:

```sh
npm run build
node --env-file=.env apps/server/dist/index.js
```

`npm start` also runs the compiled server when variables are already exported. Build first: Express
serves `apps/web/dist`, not the frontend source files.

## Administrator configuration and HTTPS

`SILO_ADMIN_USERNAME` is required, case-sensitive, 1–128 characters, without surrounding whitespace
or control characters. `SILO_ADMIN_PASSWORD_HASH` must be the canonical scrypt hash produced by the
generator. `SILO_PUBLIC_ORIGIN` is the required browser origin, including scheme and port, without
credentials, query, fragment or a path beyond `/`. Invalid settings prevent startup. Keep all three
server-only; never use `VITE_*` or browser storage for them.

Passwords contain 15–128 Unicode code points and at most 512 UTF-8 bytes. Spaces are preserved. The
generator rejects non-interactive input and command-line arguments. The production image provides an
equivalent command without development dependencies:

```sh
docker build -t silo .
docker run --rm -it --entrypoint node silo apps/server/dist/auth/hash-password.js
```

For rotation or recovery, generate a new hash, update the protected `.env` and run
`docker compose up -d --force-recreate silo`. A plain restart does not reload Compose environment
values. Process recreation invalidates sessions. There is no recovery endpoint or default account.

For a host nginx proxy at `https://192.168.1.20`, retain Express on `127.0.0.1:3000`, set
`SILO_PUBLIC_ORIGIN=https://192.168.1.20`, and use a configuration such as:

```nginx
server {
    listen 443 ssl;
    server_name 192.168.1.20;
    ssl_certificate /etc/nginx/tls/silo.crt;
    ssl_certificate_key /etc/nginx/tls/silo.key;
    client_max_body_size 100m;
    location / {
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        client_body_timeout 300s;
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_buffering off;
    }
}
```

The proxy example matches the default 100 MiB limit. If `SILO_UPLOAD_MAX_MIB` is changed, adjust
`client_max_body_size` to the same MiB value (for example `200m`) and reload nginx. The 300-second
inactivity timeouts match the upload deadline; Express additionally enforces an absolute five-minute
deadline. Request buffering must remain disabled. Configure access logs to use `$uri` without
arguments, or disable API access logging, so object keys in upload query strings are not recorded.

The operator supplies a certificate with the actual IP in its SAN, protects its private key and
installs the issuing CA in every client's trust store. Verify HTTPS without certificate warnings and
confirm from a LAN client that the backend IP/port is unreachable. A container proxy instead uses an
unpublished Express port on a private container network. Silo does not enable trust proxy or rely on
forwarded headers for origin validation and cookie security.

Sessions expire after 30 minutes idle or eight hours total. HTTPS uses a host-only Secure, HttpOnly,
SameSite=Lax cookie; local HTTP uses a separate development cookie. Up to 100 sessions remain in
memory. Logout/expiry clear data and dialogs; login preserves the bucket/prefix URL and never
replays deletion. Already authorized downloads may finish.

Login allows ten verifications in a rolling five-minute window and one scrypt operation at a time,
requiring approximately 128 MiB working memory. A client can temporarily exhaust this global budget;
existing sessions and health remain usable. Limits reset on restart. Multiple replicas are outside
this design.

## Using the object browser

**Navigation.** S3 folders are key prefixes, not real directories. Breadcrumbs and folder rows
change the URL. A location looks like `/buckets/my-bucket?prefix=reports%2F2026%2F`; it supports
refresh, bookmarks and browser Back/Forward. Keeping the prefix in a query parameter preserves
characters that URL paths would otherwise normalize, including `.` and `..`. Existing folder-marker
objects remain inspectable and can be deleted as individual objects.

**Pagination.** Browse with Previous/Next and a page size of 25, 50 or 100 (default 50). Previous
reuses S3 continuation tokens from visited pages. There are no numeric offsets, total counts, client
sorting or background scans. Search, page history, selection and open details reset when the
location changes. Refresh reloads the current location from its first page. There is no automatic
polling.

**Search.** Enter at least three characters and press Enter or Search. Matching is case-insensitive
substring matching on the full object key, recursively within the current prefix. It does not search
content or metadata. One search examines at most 1,000 objects and returns at most 100 matches. If
unexamined objects remain at either limit, the interface says the results are incomplete: narrow the
prefix or query. Paging those results does not trigger another scan. Clear returns to folder
browsing.

**Details and downloads.** Click an object name to open its read-only details; no content preview is
loaded. Copy key copies the full S3 key. Downloads pass through Express as a stream, with
backpressure and cancellation on disconnect, rather than buffering the entire object. The download
filename is the last slash-separated key segment; a marker key ending in `/` uses `download`. Silo
does not infer an application's original filename or generate public/presigned URLs.

**Deletion.** Checkboxes and Select all apply only to objects on the visible page. Folder rows
cannot be selected for recursive deletion. One confirmation shows the exact selected keys before
submission; Cancel or Escape makes no request. Changing pages, page size, prefix or search clears
selection. S3 can partially reject a batch; Silo reports successes and failures and refreshes the
listing. Ordinary keys use S3 batch deletion. Keys containing XML-sensitive control characters use
individual S3 deletions within the same confirmed action, preserving the exact key instead of
risking XML normalization.

Bucket deletion requires its exact, case-sensitive name in both the dialog and the server request.
Silo checks for an object, never empties the bucket, and lets S3 make the final decision if another
client writes concurrently. Deletion has no undo in Silo.

**Appearance and keyboard.** The initial theme follows the system; a manual light/dark choice is
saved locally. Inter is bundled, with no font CDN. On narrow screens, lower-priority table columns
disappear; full values remain in details. Native modal dialogs trap focus, support Escape and
restore focus on close. The details panel also closes with Escape while it has focus.

## Checks and tests

```sh
npm ci
npm run check
npm test
npm run build
npm run format:check
```

`check` runs strict TypeScript checks and minimal ESLint rules. Tests focus on deletion targets,
validation, search limits, URL encoding and streaming. They use Node's test runner, not browser E2E
frameworks. Some HTTP tests bind an ephemeral loopback port, so a restricted sandbox must permit
that.

Real Garage and production-container tests are opt-in and destructive only to prepared fixture data.
See [tests/README.md](tests/README.md) for a reproducible isolated setup and the required
environment variables. A skipped integration test does not prove Garage compatibility.

## Health, errors and troubleshooting

`GET /api/health` returns `200` with `{"status":"ok"}` while the HTTP application is alive. It does
not contact S3 or prove the credentials are valid. Compose uses it for container health checks.

Logs go to stdout/stderr. Operational responses use fixed messages and never include credentials or
stack traces. Failed listings provide Retry; action feedback is shown in dialogs or transient
notifications. A download that fails before streaming returns an HTTP error; one that fails after
streaming starts is interrupted rather than completed with misleading content.

- **Startup exits:** check the required environment variables and port.
- **Access denied:** check the key, secret, signing region and Garage permissions for that
  operation.
- **Storage unavailable:** check the endpoint from inside the container, DNS, network and TLS trust.
- **Bucket is not empty:** remove its objects explicitly, including any marker objects, or keep it.
- **Incomplete search:** choose a narrower prefix or a more specific substring.
- **Copy blocked by browser policy:** select and copy the displayed full key manually.

## Repository boundaries

- `apps/server/src/index.ts`: configuration validation and HTTP startup.
- `apps/server/src/app.ts`: middleware, routes, static assets and error responses.
- `apps/server/src/routes/` and `controllers/`: HTTP paths, input validation and response handling.
- `apps/server/src/services/s3.service.ts`: all S3 SDK calls; no Express dependency.
- `apps/web/src/pages/`: bucket and object screens with local React state.
- `apps/web/src/components/`: details, confirmation, theme, notifications and rendering recovery.
- `tests/`: focused logic/HTTP tests and explicit Garage/container integration checks.

No database, persistent sessions, user management, analytics or telemetry is included. Broad
S3-provider compatibility is not a V1 goal. The project license remains to be decided before public
release.
