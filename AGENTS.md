# AGENTS.md

Guide for AI coding agents (and humans) working on **Colima Desktop**. Read this file first, then
[`docs/SPEC.md`](docs/SPEC.md). Together they are enough to continue development without prior context.

## 1. What this project is

Colima Desktop is an independent, open-source desktop GUI for [Colima](https://github.com/abiosoft/colima)
(a Docker Desktop alternative) on **macOS and Linux**. It is not affiliated with the Colima maintainers.

It lets users:
- start / stop / restart / delete Colima machines (profiles), and edit every `colima.yaml` option in a form
  ("Start with configuration…");
- manage Docker containers, images and volumes (logs, inspect, stats, run, pull, prune);
- enable Kubernetes (k3s) and browse/edit/create pods, deployments, statefulsets, daemonsets, services, ingresses, configmaps, secrets and nodes,
  including CPU/memory usage from metrics-server;
- open terminals (host shell, VM, container, pod) in an integrated xterm.js dock.

- Repo: https://github.com/alperen-selcuk/colima-desktop (MIT). Current version: see `package.json`.
- Install: Homebrew tap `alperen-selcuk/tap` or `scripts/install.sh` (see [`docs/INSTALL.md`](docs/INSTALL.md)).

## 2. Architecture in one minute

```
React UI (src/)  ──invoke()/listen()──▶  Tauri v2 commands (src-tauri/src/)  ──spawn──▶  colima / docker / kubectl CLIs
```

- There is **no daemon and no SDK**: the Rust backend shells out to `colima`, `docker` and `kubectl` and parses
  their JSON output. Long operations (start/stop, pulls) stream lines to the UI as events.
- **Stack:** Tauri v2 + Rust (tokio, serde, serde_yaml, portable-pty, reqwest/rustls) · React 19 + TypeScript +
  Vite 7 + Tailwind v4 · TanStack Query (polling) · xterm.js · lucide-react · `yaml` (comment-preserving edits).
- **IPC contract:** every command, argument and JSON type is specified in `docs/SPEC.md` §3–§4 and §6.x.
  Rust structs use `#[serde(rename_all = "camelCase")]`; Tauri maps camelCase JS args to snake_case Rust params.
  `src/lib/types.ts` mirrors the Rust structs **exactly**; `src/lib/api.ts` wraps every command and event.
- **Browser dev mode:** outside Tauri, `api.ts` falls back to `src/lib/mock.ts`, so `npm run dev` renders every
  page with realistic fake data. Keep mocks in sync when adding commands.
- **Events:** `colima-op-log`, `profiles-changed`, `log-line`, `log-end`, `terminal-output` (base64), `terminal-exit`, `port-forward-ended`.

### Where things live

| Path | Purpose |
|---|---|
| `docs/SPEC.md` | **Source of truth**: stack, hard rules, IPC contract, per-screen behaviour. Update it with every contract change. |
| `src-tauri/src/lib.rs` | App setup, plugin registration, **every command is registered in `invoke_handler!` here** |
| `src-tauri/src/env.rs` | Login-shell PATH/KUBECONFIG capture (GUI apps don't inherit shell env) |
| `src-tauri/src/exec.rs` | Process helpers: run, JSON-lines, streaming with events |
| `src-tauri/src/state.rs` | `AppState`: per-profile busy locks, docker-socket cache, log streams, PTY sessions, kubeconfig freshness |
| `src-tauri/src/colima.rs` | Profile list/status/lifecycle, `kubernetes_action`, docker socket resolution |
| `src-tauri/src/config_file.rs` | Read/save `colima.yaml` (atomic, `.bak`), typed validation mirroring colima's `config.Config` |
| `src-tauri/src/docker.rs` | Containers, images, volumes, prune |
| `src-tauri/src/kubeconfig.rs` | **App-managed kubeconfig** + the single `kubectl()` / `kubectl_with_stdin()` helpers, host kubeconfig health/repair |
| `src-tauri/src/k8s.rs` | All Kubernetes list/describe/yaml/edit/apply/delete/scale/metrics commands |
| `src-tauri/src/quantity.rs` | Pure helpers: CPU/memory quantity parsing, ingress flattening, secret masking |
| `src-tauri/src/k3s.rs` | k3s version list (GitHub releases, 24h cache, built-in fallback), colima default version |
| `src-tauri/src/logs.rs`, `pty.rs`, `terminal.rs` | Log streaming, PTY sessions, terminal command building |
| `src-tauri/src/portforward.rs` | Long-running `kubectl port-forward` children (start/list/stop, `port-forward-ended` event) |
| `src-tauri/src/tray.rs`, `validate.rs` | System tray; profile-name / kube-context / k8s-arg validation |
| `src-tauri/resources/colima-default.yaml` | Upstream colima default template (MIT), fallback for new profiles |
| `src/App.tsx` | Shell: providers, routing between pages, dialogs, keyboard shortcuts |
| `src/pages/*.tsx` | Machines, Containers, Images, Volumes, Kubernetes, Setup |
| `src/dialogs/*.tsx` | MachineConfigDialog (+ `configFields.tsx`), StartDialog, RunContainer, Pull, Scale, K8sEdit |
| `src/components/**` | Shared UI (Dock, TerminalView, Table, Dialog, Toasts…); `components/k8s/**` Kubernetes-only pieces |
| `src/lib/` | `api.ts`, `types.ts`, `mock.ts`, pure helpers (`format`, `colimaConfig`, `k3s`, `k8sView`) + `*.test.ts`, hooks (`useProfile`, `useTheme`, `useDock`) |
| `src/index.css`, `src/styles/k8s.css` | Design tokens (CSS variables) for light + dark themes; Kubernetes kind colours |
| `public/logo.svg`, `public/k8s-icons/` | App mark; official Kubernetes icons (CC-BY-4.0, see `NOTICE`) |
| `.github/workflows/` | `ci.yml` (lint + build/test on macOS & Ubuntu), `release.yml` (tag → draft release), `homebrew.yml` (release published → tap cask) |
| `packaging/homebrew/` | Cask template + tap README; `scripts/install.sh` one-line installer |

## 3. Hard rules (do not break these)

1. **Never touch non-Colima Kubernetes clusters.** Maintainers' kubeconfigs contain production clusters. All
   kubectl calls go through `kubeconfig::kubectl()` / `kubectl_with_stdin()`, which use an **app-managed kubeconfig**
   (fetched from the VM's `/etc/rancher/k3s/k3s.yaml` into the app data dir, mode 0600) plus
   `--context colima` (profile `default`) or `--context colima-<profile>`. Never call `kubectl` directly, never
   rely on or change `current-context`, never read `~/.kube/config` for cluster access. The only code allowed to
   *write* the user's kubeconfig is `repair_host_kubeconfig` (explicit user click, backup first, only the
   `colima*` user/cluster entries). The same applies to you when testing by hand: always pass
   `--context colima…`.
2. **Docker endpoint is explicit:** `docker -H <socket from colima status --json>`; `DOCKER_HOST`/`DOCKER_CONTEXT`
   are removed from child envs.
3. **No shell interpolation of user input:** always `Command::new(bin).args([...])`. Validate profile names
   (`validate.rs`) and reject Kubernetes names/namespaces starting with `-` (flag injection).
4. **Secrets:** Kubernetes secret values never leave the backend except via `k8s_secret_value` (one key, explicit
   reveal). `k8s_yaml` masks secret data. YAML for `kubectl replace` is piped via stdin, never written to disk.
5. **Destructive actions need an in-app confirm dialog** (never `window.confirm/alert`). Deleting a machine or a
   deployment / anything in `kube-system` requires typing the name.
6. **Cross-platform:** CI builds macOS and Linux. Anything macOS-only needs `#[cfg(target_os = "macos")]`
   (e.g. `RunEvent::Reopen`). Hide vz/Rosetta options on Linux.
7. **Both themes:** style only through CSS variables in `src/index.css`; every UI change must look right in
   light and dark. The brand accent is green; the Kubernetes page adds Kubernetes blue.

## 4. Commands

```sh
npm install                 # deps (Node 22+, Rust stable)
npm run dev                 # UI only, in a browser with mock data (port 1420)
npm run tauri dev           # full desktop app
npm run build               # tsc -b (strict) + vite build — must have zero TS errors
npx vitest run              # frontend unit tests
cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo test
actionlint                  # after editing .github/workflows/*
shellcheck scripts/install.sh
npm run tauri build -- --bundles app   # local macOS .app (src-tauri/target/release/bundle/macos/)
```

Linux build deps: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev build-essential libssl-dev libxdo-dev patchelf file`.

**Definition of done for any change:** clippy clean, `cargo test`, `npm run build`, `npx vitest run` all pass;
SPEC.md and CHANGELOG.md (`## [Unreleased]`) updated; no new macOS-only code without `cfg`.

### Live tests (ignored by default)

Some Rust tests talk to a real, running Colima (profile `default`) and are `#[ignore]`d. They only read or use
`--dry-run=server`, and never write the real `~/.kube/config`:
`cargo test <name> -- --ignored --nocapture` with `live_colima_k8s_listing`, `live_colima_k8s_v012_reads`,
`live_host_kubeconfig_health`, `live_repair_on_scratch_copy`, `smoke_real_configs_pass_typed_validation`,
`smoke_reads_real_colima_home`. Never perform real deletes/applies or start/stop/delete machines from tests.

## 5. Conventions

- **Adding a feature:** 1) write/extend a SPEC.md section (types + command table + UX); 2) Rust command, registered
  in `lib.rs`; 3) `types.ts` + `api.ts` + `mock.ts`; 4) UI; 5) tests; 6) CHANGELOG.
- Put logic in **pure functions with unit tests** (parsers, validators, formatters); keep Tauri commands thin.
  Inject environment values (e.g. `pick_shell(shell_env, is_file)`), **never mutate process env in tests**
  (parallel tests raced on `SHELL`/`HOME`/`COLIMA_HOME` before).
- Errors cross IPC as `Result<T, String>` with a human-readable message (strip kubectl noise lines).
- UI data via TanStack Query with polling; only poll what's visible. Surface query errors (banner + Retry),
  never silently render empty tables.
- Commit messages: Conventional Commits (`feat(scope): …`, `fix(ci): …`), subject ≤ 72 chars.
- Don't commit the local `graft/` index or the `.ignore` file (developer tooling, regenerable).

## 6. Releasing

1. Bump the version in `package.json` (+ `npm install` to sync the lock), `src-tauri/Cargo.toml` (+ `Cargo.lock`)
   and `src-tauri/tauri.conf.json`; move CHANGELOG `Unreleased` to `## [X.Y.Z] - date`.
2. Commit, push, wait for CI to be green, then `git tag -a vX.Y.Z -m "Colima Desktop vX.Y.Z" && git push origin vX.Y.Z`.
3. `release.yml` builds a **draft** release: universal macOS `.dmg`, Linux x86_64/aarch64 `.deb` `.rpm` `.AppImage`.
   Check the assets, then publish.
4. Publishing triggers `homebrew.yml`, which writes `Casks/colima-desktop.rb` to `alperen-selcuk/homebrew-tap`
   (secret `HOMEBREW_TAP_TOKEN`). Users: `brew tap alperen-selcuk/tap && brew trust --cask
   alperen-selcuk/tap/colima-desktop && brew install colima-desktop` (Homebrew 7 requires `brew trust`).
5. Builds are unsigned; the cask removes the quarantine flag in `postflight_steps`. Optional Apple signing secrets
   are documented in `docs/RELEASING.md`.

## 7. Lessons learned (non-obvious facts)

- **Stale Colima kubeconfig:** k3s rotates its client certificate, but colima only rewrites `~/.kube/config` when
  the VM IP changes → "the server has asked for the client to provide credentials". That is why the app keeps its
  own kubeconfig fetched from the VM and refreshes it on auth errors.
- **colima silently ignores a bad `colima.yaml`:** if the file fails to unmarshal it logs a warning and starts with
  defaults. Hence the typed validation before saving. colima parses non-strictly: unknown keys are ignored.
- `colima status --json` exits non-zero when the machine is stopped (treat as "not running", not an error).
  `colima kubernetes start` only works on a running machine and does not persist `kubernetes.enabled`.
- colima's `autoActivate` switches the docker context (and kube context when k8s starts) — another reason to
  never rely on current contexts.
- The installed colima may be older than upstream: read the default k3s version from `colima start --help`.
- `docker ps` has no `{{.ImageID}}` template field; resolve image ids with one batched `docker inspect`.
- PTY (portable-pty): read to EOF **before** `wait()`ing the child, or trailing output is lost.
- GitHub Actions: `secrets.*` is not allowed in step-level `if:` (expose presence via job `env`); plain YAML lint
  won't catch it — run `actionlint`. `git diff --quiet` ignores untracked files (stage first, then
  `git diff --cached --quiet`).
- GitHub push protection rejects realistic-looking fake API keys in mock data; use obviously fake placeholders.
- Homebrew 7 casks: third-party taps need `brew trust`; use `postflight_steps` + `run` with `{{appdir}}`;
  `brew audit --strict` wants the URL to interpolate `#{version}`.
- macOS GUI apps don't inherit the shell `PATH`/`KUBECONFIG`; `env.rs` captures them from `$SHELL -ilc`.
