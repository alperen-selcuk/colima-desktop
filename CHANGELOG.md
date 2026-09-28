# Changelog

All notable changes to Colima Desktop are documented in this file.

## [Unreleased]

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
