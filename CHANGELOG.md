# Changelog

All notable changes to Colima Desktop are documented in this file.

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

### Notes

- Colima Desktop is an independent, open-source project and is not affiliated with the Colima maintainers;
  it uses Colima as its engine.
- `kubectl` calls always pass an explicit context tied to the selected Colima profile and never read or
  change your kubeconfig's current context.
