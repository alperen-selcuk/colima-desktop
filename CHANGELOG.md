# Changelog

All notable changes to Colima Desktop are documented in this file.

## [0.2.5] - 2026-10-06

### Added

- **Create from the UI**: each of Pods, Deployments, StatefulSets, DaemonSets, Services and Ingresses has a "Create" button that
  opens a simple form (no terminal needed) with a live YAML preview, an "Edit YAML" mode, "Validate" (server dry-run) and "Create".
  Services offer a selector dropdown built from existing workload labels and a NodePort field (30000-32767); Ingresses pick the
  backend service/port and ingress class from the cluster, and warn when no ingress controller exists (colima disables Traefik by
  default). StatefulSets can create their headless Service and a `local-path` volumeClaimTemplate. New commands `k8s_create`
  (single-document YAML via stdin, kind whitelist, name/namespace validation, friendly AlreadyExists errors) and `k8s_ingress_classes`.
- **StatefulSets and DaemonSets tabs** (list, describe, YAML, edit, delete, create; scale/restart for StatefulSets, restart for
  DaemonSets) with the official Kubernetes icons. New commands `k8s_statefulsets`, `k8s_daemonsets`.
- **Port-forward** for pods and services: "Port forward..." row action, automatic free local port, toast with Open, and an "Active
  port-forwards" strip with a count badge (Open, Copy URL, Stop). New commands `k8s_port_forward_start`, `k8s_port_forward_list`,
  `k8s_port_forward_stop` and event `port-forward-ended`. Forwards are stopped when the app quits or the machine stops/restarts/is deleted.

### Changed

- `k8s_scale` now takes a `kind` (`deployment | statefulset`) and `k8s_restart_deployment` is replaced by `k8s_restart`
  (`deployment | statefulset | daemonset`). Deleting statefulsets and daemonsets requires typing the name, like deployments.

### Changed

- **Button system and UI polish**: one shared `Button` / `IconButton` (primary, secondary, ghost, danger, danger-outline; 28/32px
  heights, loading state, focus ring, both themes). Icon-only buttons are bordered tiles with a tooltip and `aria-label`. Close,
  remove, reveal/copy and log buttons now use it; dropdowns share one menu style.
- **Machines cards**: no more clipped actions. Stop/Start and Configure are labelled, restart and the Terminal split sit in a
  wrapping row, and Reclaim space and Delete moved into a "..." menu. Status pill, labelled CPU/Memory/Disk and aligned badges.
- **Top bar**: consistent sizes, aligned status pills, Configure always available. Row actions in tables use visible bordered
  icon buttons (red outline for delete).

## [0.2.4] - 2026-10-06

### Changed

- **Terminal now opens your own shell.** The top-bar Terminal button (and the Machines card terminal button, and the
  status-bar Terminal toggle on an empty dock) opens a local host shell tab instead of `colima ssh`. It is a split
  button: main click = "Local shell (zsh)" (the actual `$SHELL`), caret menu = "Colima VM shell (<profile>)"; VM tabs
  are titled `vm: <profile>`.
- Host shells run as interactive login shells (`-il` for zsh/bash, `-l` otherwise) in `$HOME` with the full login-shell
  environment captured once at startup (`$SHELL -ilc 'env -0'`, 3s timeout), so PATH, plugins (krew `kubectl ns`, ...)
  and your own `KUBECONFIG`/`DOCKER_HOST` behave exactly like in macOS Terminal. VM/container/pod terminals still
  strip `KUBECONFIG`/`DOCKER_HOST`/`DOCKER_CONTEXT`. `env_info` gains `shell`.

## [0.2.3] - 2026-10-06

### Added

- **Kubernetes "Connect" panel**: context name, API server, Copy kubeconfig, Save kubeconfig as…, Merge into
  `~/.kube/config` (backup first, only `colima*` entries, never changes current-context) and copyable `kubectl`
  snippets. New commands `k8s_kubeconfig`, `k8s_export_kubeconfig`, `k8s_merge_kubeconfig`.
- **Operation progress everywhere**: status bar and top bar show the running op with a human phase parsed from colima's
  output ("Starting VM", "Starting Docker", "Starting Kubernetes", "Updating kubeconfig"); Machines cards show it too.
  On completion a toast ("default is running · Kubernetes ready") offers **Open Kubernetes**. New `colima-op-end` event.
- Configuration editor: **← Machines** home button; the editor can always be closed while an operation keeps running.

### Fixed

- Running machines showed as stopped (Kubernetes page "needs the machine to be running", sidebar "off") with newer colima versions, which omit empty fields such as `ip_address` from `colima status --json`; status parsing now tolerates missing fields.

- Save & Start left the configuration editor on "Working…" forever: the streamed `colima start` never resolved because a
  background process kept its output pipes open after colima exited. Streaming now stops shortly after the process exits.

## [0.2.2] - 2026-10-06

### Added

- **Dependency doctor**: `deps_check` / `deps_fix` detect colima, docker, docker-compose, kubectl and (optional)
  qemu, including Homebrew formulae that are installed but unlinked, and fix them with `brew install` / `brew link`.
  Shown on the Setup page, as a Machines-page banner (Fix all), and as an Install QEMU button in the config editor.

### Changed

- New machines seeded from the template/builtin default now use `vmType: vz` on macOS and `arch: host`
  (upstream's template says `qemu`, which needs a separate QEMU install).
- "qemu-img not found" on start now explains how to fix it. The Homebrew cask also depends on `kubectl`.

## [0.2.1] - 2026-10-06

### Fixed

- **Disk shrink no longer breaks the VM**: lowering `disk` below the existing size (which Lima/colima cannot
  apply and which made `colima start` fail) is now a blocking error in the configuration editor, with a
  **Recreate with smaller disk…** option. A failed start with "error at 'starting'" now explains the cause.

### Added

- **Recreate with smaller disk**: stops, deletes and recreates the machine from the edited configuration
  (confirm dialog, type the profile name).
- **Reclaim space**: from the Machines card and the Resources section, prunes unused Docker data (not volumes)
  and trims the VM disk, then reports how much space was freed on your Mac.
- `profile_disk_info`, `recreate_profile`, `reclaim_space` commands.

## [0.2.0] - 2026-10-06

### Fixed

- **Friendly lifecycle errors**: when `colima start/restart` fails, the UI now shows the `msg` of the fatal/error
  log line instead of raw log output, with actionable hints for known cases (e.g. missing Docker CLI). The full
  lines remain in the operation log.
- **Config validation false warnings**: an empty or null value for `runtime`, `vmType`, `arch`, `mountType`,
  `network.mode`, `portForwarder` and `modelRunner` means "use colima's default" and no longer warns.

## [0.1.5] - 2026-09-28

### Added

- **Marketplace**: new sidebar page to browse and one-click install curated apps and stacks. The install
  dialog generates passwords, picks free ports, runs preflight checks (architecture, VM memory,
  `vm.max_map_count` with a one-click fix) and, once the stack is ready, shows every local URL, username,
  password and connection string. An **Installed** tab lists your apps with status, credentials,
  Stop/Start/Restart and Uninstall (optionally deleting data volumes). The catalog ships inside the app and
  refreshes from GitHub, so new apps don't need a release.
- **Marketplace catalog** (`catalog/`, `docs/SPEC.md` §6.8): the source-of-truth data for the
  upcoming one-click Marketplace. 17 curated apps under `catalog/apps/<id>/{app.json,compose.yml}`
  across search (Elasticsearch, Elasticsearch+Kibana, OpenSearch+Dashboards), database
  (Postgres+pgAdmin, MySQL+Adminer, MongoDB+Mongo Express, Redis+RedisInsight), messaging
  (Kafka+Kafka UI, RabbitMQ), monitoring (Grafana+Prometheus, Loki+Grafana, Jaeger), auth
  (Keycloak+PostgreSQL, Vault dev mode), devtools (Mailpit, n8n) and ai (Ollama+Open WebUI).
  `npm run catalog:build` (`scripts/build-catalog.mjs`) validates every app against the authoring
  rules (pinned multi-arch images, no Bitnami, `127.0.0.1`-bound ports via port variables, named
  volumes only, no `container_name`, alphanumeric passwords, every `${VAR}` declared) and writes
  the deterministic `catalog/dist/catalog.json`; `--check` fails CI if it's stale.
  `scripts/validate-catalog.mjs` renders every app's `compose.yml` with dummy values and runs
  `docker compose config -q` (no daemon required); `scripts/smoke-catalog.mjs` does a real
  `docker compose up -d --wait` + endpoint check + `down -v` for light apps. New CI job `catalog`
  runs both plus `catalog:build --check`. See `catalog/README.md` for the authoring guide and
  `catalog/NOTICE` for third-party attributions.
- **Known gap:** `storage`/MinIO is intentionally not in the catalog — as of this writing
  `minio/minio` has been removed from Docker Hub (no publicly pullable image; confirmed via
  `docker buildx imagetools inspect` and the Docker Hub/registry APIs), so no image could be
  verified for it. See `catalog/README.md` "Known gaps".

## [0.1.4] - 2026-09-28

### Fixed

- Volume sizes always showed "—": `list_volumes` asked docker for `system df -v --format '{{json .}}'`, which
  prints one JSON object for the whole report (`Images`/`Containers`/`Volumes` sub-arrays), not JSON-lines —
  fixed to request `{{json .Volumes}}` (the array) directly.
- "Prune unused" never removed named volumes (e.g. leftovers from `compose down` without `-v`): plain
  `docker volume prune -f` has only removed anonymous unused volumes since Docker 23. The Volumes page's prune
  dialog now offers both scopes explicitly.

### Added

- Redesigned Volumes page matching the Containers page's look: stat tiles (count, total size, unused count,
  reclaimable size), a Source column (compose project / named / anonymous), an In use column, and a Created
  column, sortable by name/size/created.
- Volumes now report `containers` (how many reference them), `inUse`, `anonymous`, `composeProject` and
  `createdAt`, from a batched `docker volume inspect` alongside `system df -v`.
- Prune dialog previews exactly which volumes a prune would remove (with sizes and a total) before confirming,
  and requires typing "delete" when the broader scope would remove named volumes.

## [0.1.3] - 2026-09-28

### Added

- **Docker Compose:** "Compose up…" picks a `.yml`/`.yaml` file, validates it with `docker compose config` and
  previews services, images and ports, then runs `up -d` (options: build, pull always, force recreate) with
  output streamed to the Output tab. Recent files are remembered. Compose projects get Up / Restart / Stop /
  Start / Down (optionally removing volumes) / Pull and a project panel with services and aggregated live logs.
  Uses the `docker compose` plugin, falling back to a standalone `docker-compose`.
- Redesigned Containers page: Docker Engine header, stat tiles (running, stopped, compose projects, CPU,
  memory), filter chips, brand logos for well-known images via Simple Icons (CC0) with a tinted fallback glyph,
  clickable port chips and CPU/memory mini bars.

### Changed

- Kubernetes-managed containers (k3s pods and sandboxes, labelled `io.kubernetes.pod.namespace`) are hidden
  from the Containers page by default, including the exited leftovers that remain when Kubernetes is disabled.
  A filter toggle can show them.
- The Homebrew cask now depends on `docker-compose`.

### Fixed

- Container labels whose values contain commas (multi-file compose projects, k3s annotations) were split
  incorrectly; labels are now read from `docker inspect` as JSON.
- Images could lose their "in use" badges when a container disappeared between listing and inspection.

## [0.1.2] - 2026-09-27

### Added

- Redesigned Kubernetes page: official Kubernetes icons, a per-kind accent colour and count badge on every tab,
  and a cluster header with context, k3s version and namespace selector.
- New Kubernetes tabs: **Ingresses** (hosts as clickable links, rules), **ConfigMaps** (keys and data) and
  **Secrets** (values hidden by default, per-key Reveal and Copy).
- Edit (YAML editor with server-side dry-run Validate, conflict detection) and Delete (with confirmation; typed
  name required for deployments and anything in `kube-system`) for pods, deployments, services, ingresses,
  configmaps and secrets.
- Pod and node CPU / memory usage from metrics-server as coloured bars (green / amber / red) against limits,
  requests or node capacity, with exact values on hover.
- Polished light theme: layered surfaces, subtle elevation, deeper brand green and status colours that meet
  WCAG AA; the dark theme is unchanged.
- Typed validation of `colima.yaml` in the configuration editor, mirroring colima's own config types. Values
  colima can't load (e.g. `memory: "abc"`, `cpu: 2.5`, an invalid DNS IP) are shown live with jump-to-field
  links and block saving — colima would otherwise ignore the whole file and silently start with defaults.
  Unrecognised enum values are shown as non-blocking warnings.
- Kubernetes enablement flow: when the machine is stopped, the Kubernetes page offers "Start with Kubernetes…",
  which opens the configuration editor on the Kubernetes section with Kubernetes pre-enabled (no more raw
  "not running" error). On a running machine: quick "Enable Kubernetes" (this session) or "Enable permanently…".
- k3s version picker in the configuration editor and the quick Start dialog: colima's default version, the
  latest patch of each minor and a searchable list of all k3s releases (fetched from GitHub, cached for 24h,
  with a built-in fallback list when offline). Malformed versions block saving.

### Fixed

- Kubernetes views were empty when `~/.kube/config` held stale credentials for the `colima` context (k3s
  rotates its client certificate; colima only rewrites the kubeconfig when the VM IP changes). The app now uses
  its own kubeconfig fetched from the VM (mode 0600, refreshed automatically on auth errors) and never reads
  `~/.kube/config` for colima clusters. Kubernetes query errors are now shown with a Retry button instead of
  empty tables.
- New notice when terminal `kubectl --context colima` would fail, with an opt-in **Fix** that backs up
  `~/.kube/config` and updates only the `colima` user/cluster entries.
- The quick Start dialog defaulted Kubernetes to `v1.30.0`, which is not a valid k3s version.

- Homebrew cask passes `brew audit --strict` and `brew style`; install docs include the `brew trust` step
  that Homebrew 7 requires for third-party taps.

## [0.1.1] - 2026-09-27

### Added

- Machine configuration editor ("Start with configuration…"): every `colima.yaml` option (resources, runtime,
  Docker daemon config, Kubernetes/k3s args, VM, network, mounts with folder picker, SSH, env, provision
  scripts) as form controls plus a two-way-synced raw YAML tab. Comments and unknown keys in the file are
  preserved; the previous file is backed up to `colima.yaml.bak`. Save & Start / Save & Restart, and a split
  Start button (`Start` | `Start with configuration…`) on machine cards and in the top bar.
- New logo: a container inside a laptop; regenerated app, tray and favicon icons.
- One-command install: Homebrew cask via the `alperen-selcuk/tap` tap (installs `colima` and `docker` as
  dependencies) and `scripts/install.sh` (`curl … | bash`) for Linux (.deb / .rpm / AppImage) and macOS.
- Release builds: one universal macOS `.dmg` (Apple Silicon + Intel), Linux x86_64 and aarch64 `.deb` /
  `.rpm` / `.AppImage`; the Homebrew tap is updated automatically when a release is published.
- Install and release documentation (`docs/INSTALL.md`, `docs/RELEASING.md`); CI lints the install script.

### Changed

- Upgraded dev tooling to Vite 7.3 and Vitest 4.1 (resolves Dependabot alerts in vite, vitest and esbuild;
  none of these ship inside the app).

### Fixed

- Flaky Rust tests caused by parallel tests mutating `SHELL`, `COLIMA_HOME` and `HOME`.

## [0.1.0] - 2026-09-27

Initial release.

### Added

- Machine (profile) lifecycle management: start, stop, restart, delete, with a detailed Start dialog
  (CPU, memory, disk, runtime, VM type, architecture, mount type, Rosetta, network address, Kubernetes
  toggle + version, mounts editor).
- Container management for the `docker` runtime: start/stop/restart/pause/unpause/kill/remove, live log
  streaming, `docker inspect` view, live stats, grouping by Docker Compose project, clickable port links.
- Image management: pull (streamed output), delete (with force-when-in-use confirmation), prune unused,
  run a container from an image.
- Volume management: list, delete, prune unused.
- Kubernetes tab: Pods, Deployments, Services, Nodes, with a namespace selector, logs/describe/yaml detail
  drawer, deployment scaling and restart, pod deletion, and cluster reset/disable.
- Integrated terminal dock: a resizable, IDE-style bottom panel with an Output tab (streamed operation logs)
  and one or more xterm.js-powered terminal tabs (local shell, Colima VM shell, container shell, pod shell),
  toggled with `Ctrl+\``.
- Theme switcher (System / Light / Dark) with a fully designed light theme; the Colima green accent carries
  the brand in both modes.
- System tray with per-profile status and quick start/stop.
- Missing-dependencies setup guide shown automatically when `colima` isn't detected on `PATH`.
- CI (`ci.yml`) and release (`release.yml`) GitHub Actions workflows, and an MIT `LICENSE`.

### Fixed

- Linux build: the macOS-only `RunEvent::Reopen` handler is now compiled on macOS only.

### Notes

- Colima Desktop is an independent, open-source project and is not affiliated with the Colima maintainers;
  it uses Colima as its engine.
- `kubectl` calls always pass an explicit context tied to the selected Colima profile and never read or
  change your kubeconfig's current context.
