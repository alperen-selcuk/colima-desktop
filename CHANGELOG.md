# Changelog

All notable changes to Colima Desktop are documented in this file.

## [Unreleased]

### Added

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
