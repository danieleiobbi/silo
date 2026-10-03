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

There is no upload, bucket creation, rename, move, folder creation, content preview or storage
administration. Silo does not use Garage's Admin API. The application that owns the data remains
responsible for creating objects and managing their lifecycle.

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
docker compose up -d --build
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
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_buffering off;
    }
}
```

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
