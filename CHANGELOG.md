# Changelog

All notable changes to Colima Desktop are documented in this file.

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
