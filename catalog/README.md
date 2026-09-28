# Marketplace catalog

Source of truth for Colima Desktop's Marketplace (`docs/SPEC.md` §6.8). Each app under `apps/<id>/`
becomes one card in the Marketplace UI. `catalog/dist/catalog.json` is **generated** from this
directory by `npm run catalog:build` and is committed — the backend embeds it as the built-in
catalog and also fetches it from `main` at runtime (6h cache, stale-on-error, built-in fallback).

## Layout

```
catalog/
  schema.json          JSON Schema for app.json (draft-07)
  README.md            this file
  NOTICE                third-party attributions
  VERSION               single YYYY-MM-DD date; drives dist/catalog.json's generatedAt
  apps/<id>/
    app.json            metadata — see schema.json and the "Authoring an app" section below
    compose.yml         Docker Compose file, ${VAR}-interpolated
  dist/catalog.json      generated — do not hand-edit
```

## Authoring rules (enforced by `catalog:build`)

These come directly from `docs/SPEC.md` §6.8. `scripts/build-catalog.mjs` validates all of them;
a violation fails the build (and CI).

1. **`id` = folder name**, matching `^[a-z0-9][a-z0-9-]*$`, unique across the catalog.
2. **Every `${VAR}` used anywhere** — in `compose.yml`, in `endpoints[].url/value/username/password`,
   in `ready.url`, in `notes` — **must be declared** in `variables`. The only implicit variable is
   `COMPOSE_PROJECT_NAME`, which the app installs with automatically.
3. **Images are pinned to an explicit stable tag.** No `:latest`, no untagged `image:` reference.
   Use official upstream images only — **no `bitnami/*` images** (the build rejects them).
4. **Multi-arch.** Every image must publish `linux/amd64` and `linux/arm64` manifests. Verify with
   `docker buildx imagetools inspect <image:tag>`, or, if a daemon isn't running, the registry API
   directly (Docker Hub: `https://hub.docker.com/v2/repositories/<ns>/<repo>/tags/<tag>` →
   `images[].architecture`; GHCR/quay.io: registry v2 `manifests/<tag>` with an anonymous pull
   token, look for the `manifests[].platform` list in the returned image index). Record the result
   in `architectures`.
5. **Every published port uses a `port`-typed variable and binds to `127.0.0.1`**:
   `"127.0.0.1:${X_PORT}:<container-port>"`. Never publish on `0.0.0.0` or a bare port number —
   the build rejects both.
6. **Named volumes only.** No bind mounts (`./data:/data`, `/host/path:/data`, `~/...`). If a
   service needs a config file that would normally be bind-mounted, write it into a named volume
   from a one-shot init container instead (see `apps/grafana-prometheus/compose.yml` for the
   pattern) or bake it into the image via env vars/CLI flags.
7. **No `container_name`.** It collides across multiple installed instances of the same app.
8. **Passwords are alphanumeric** (`[A-Za-z0-9]+`) so they're safe unescaped in URLs, connection
   strings and YAML. Declare them as `{"type": "password", "length": N}` — the backend generates
   the value with a CSPRNG; never hardcode a password in `compose.yml` or `app.json` beyond a
   `${VAR}` reference.
9. **`source` and license are recorded** for every app (see "Provenance" below).

## Authoring an app

1. Pick an `id` (kebab-case) and `category` (`search | database | messaging | monitoring | storage
   | auth | devtools | ai`).
2. `mkdir catalog/apps/<id>`.
3. Write `compose.yml` first, adapted from a permissively licensed source (see "Provenance"). Use
   `${VAR}` for every port, password and anything else that must vary per instance. Add
   healthchecks wherever the image supports them — the marketplace's `ready` probe and the
   Marketplace UI's status both lean on them.
4. Write `app.json` against `schema.json`:
   - `variables`: one entry per `${VAR}`, typed `password | port | string`. `port` variables need
     a numeric `default`; that's the port the app tries first (and falls back to the next free one
     if taken). Mark internal/service-account variables `"hidden": true` so they don't clutter the
     install form.
   - `endpoints`: what the Ready card shows after install. Use `url` for anything browsable/callable
     over HTTP, `value` for a connection string or other copyable text. Exactly one `primary: true`
     endpoint (usually the web UI).
   - `preflight`: only `{"type": "sysctl", "key": "...", "min": N}` today (e.g. Elasticsearch/
     OpenSearch need `vm.max_map_count >= 262144`).
   - `ready`: how the app decides "installed" vs "still starting". `"healthy"` waits for every
     service with a healthcheck to report healthy (simplest, prefer this when every service has
     one); `"http"` polls a URL for one of `expectStatus`; `"running"` just waits for containers to
     be up (last resort, for images with no healthcheck and no HTTP endpoint to poll).
5. Validate:
   ```sh
   npm run catalog:build            # validates + writes catalog/dist/catalog.json
   node scripts/validate-catalog.mjs <id>   # renders compose.yml with dummy values, runs
                                             # `docker compose config -q` (no daemon required)
   ```
   Both must pass before committing. `npm run catalog:build -- --check` (what CI runs) fails if
   `dist/catalog.json` doesn't match what your `apps/` sources produce — always run the plain
   `catalog:build` after any change and commit the updated `dist/catalog.json` alongside it.
6. For light apps (fast-starting, no big downloads/JVMs), CI also does a real `docker compose up
   -d --wait` + endpoint curl + `down -v` smoke test on Ubuntu. If you're adding one of those, see
   the `catalog` job in `.github/workflows/ci.yml`.

## `generatedAt` / `catalog/VERSION`

`dist/catalog.json`'s `generatedAt` is **not** a build timestamp — it comes from the single date in
`catalog/VERSION`, so two builds from the same `apps/` sources always produce byte-identical output
and `git diff --exit-code` in CI is stable. Bump `catalog/VERSION` (to today, `YYYY-MM-DD`) when you
change any app, then re-run `npm run catalog:build`.

## Provenance (where apps may be adapted from)

Every `app.json` records `source: { name, url, license }` for the `compose.yml` pattern it's based
on. Allowed sources:

- [`docker/awesome-compose`](https://github.com/docker/awesome-compose) — CC0-1.0
- [`coollabsio/coolify`](https://github.com/coollabsio/coolify) templates/compose — Apache-2.0
- [`deviantony/docker-elk`](https://github.com/deviantony/docker-elk) — MIT
- Official upstream vendor documentation (e.g. `keycloak.org`, `hashicorp.com`,
  `hub.docker.com/r/hashicorp/vault`, `grafana.com`, `axllent/mailpit`, `docs.n8n.io`,
  `open-webui`'s own repo, the Apache Kafka / Jaeger / OpenSearch project docs)

**Do not copy from:**
- `portainer/templates` — no explicit license
- `runtipi` — GPL (copyleft; incompatible with adapting into this MIT-licensed catalog)
- Any Bitnami image or compose file

When the upstream doc's license isn't stated inline, `license` in `app.json` describes the
documentation/pattern's license, not necessarily the runtime image's own license (e.g. Vault is
BSL 1.1, Loki/Grafana are AGPL-3.0 — noted per-app; this only affects how you may adapt *our*
compose file, not whether you can run the published container image).

## Known gaps

- **`storage` category / MinIO** is intentionally not in the catalog. As of this writing,
  `minio/minio` (and `minio/mc`) have been removed from Docker Hub — the AGPLv3 community server
  no longer has a publicly pullable image (`docker buildx imagetools inspect minio/minio:<any tag>`
  returns "repository does not exist or may require authorization"; the same tags return 404 from
  both the Docker Hub API and an anonymous quay.io pull). If MinIO (or another S3-compatible
  object store with a genuinely public, pinned, multi-arch image) becomes available again, add it
  under `apps/minio/` following the rules above.
