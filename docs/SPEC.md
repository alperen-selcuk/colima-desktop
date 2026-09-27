# Colima Desktop — Specification

A native desktop GUI for [Colima](https://github.com/abiosoft/colima) (a Docker Desktop alternative), running on **macOS and Linux**.
Lets the user start/stop Colima machines (profiles), enable Kubernetes, manage containers/images/volumes,
and browse Kubernetes workloads (pods, deployments, services, nodes).

## 1. Stack (decided)

| Layer     | Choice |
|-----------|--------|
| Shell     | **Tauri v2** (Rust). Bundles: macOS `.app`/`.dmg`, Linux `.deb`/`.AppImage`/`.rpm` |
| Backend   | Rust, `tokio`, `serde`, `serde_json`, `serde_yaml`; shells out to `colima`, `docker`, `kubectl` |
| Frontend  | React 19 + TypeScript + Vite + Tailwind CSS v4 (`@tailwindcss/vite`) + `lucide-react` + `@tanstack/react-query` |
| Plugins   | `tauri-plugin-opener` (open port URLs in browser) |

App identifier: `dev.colima.desktop`. Product name: `Colima Desktop`. Window 1280x820, min 1000x640.
Dev server port 1420 (`devUrl: http://localhost:1420`, `frontendDist: ../dist`,
`beforeDevCommand: npm run dev`, `beforeBuildCommand: npm run build`).

Directory layout (all under `colima-ide/`):

```
package.json, vite.config.ts, tsconfig*.json, index.html      (frontend owner)
src/                                                           (frontend owner)
  lib/api.ts        typed wrappers over invoke()/listen()  — MUST match §4 exactly
  lib/types.ts      TS types — MUST match §3 exactly
src-tauri/                                                     (backend owner)
  Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/
  src/main.rs, src/lib.rs
  src/env.rs        PATH resolution
  src/exec.rs       process helpers (run, run_json_lines, run_streaming)
  src/colima.rs     profile commands
  src/docker.rs     container/image/volume commands
  src/k8s.rs        kubernetes commands
  src/logs.rs       log streaming (follow)
  src/tray.rs       system tray
  src/terminal.rs   open external terminal
```

## 2. Hard rules (safety & correctness)

1. **Kubernetes context is ALWAYS explicit.** Every `kubectl` call passes `--context <ctx>` where
   `ctx = "colima"` for profile `default`, else `"colima-" + profile`. Never call `kubectl config use-context`,
   never read or rely on `current-context`. The user's kubeconfig contains production AKS clusters.
2. **Docker endpoint is ALWAYS explicit.** Every `docker` call passes `-H <docker_socket>` where the socket
   comes from `colima status --json -p <profile>` field `docker_socket` (e.g. `unix:///Users/x/.colima/default/docker.sock`).
   Fallback if status fails: `unix://$COLIMA_HOME_or_~/.colima/<profile>/docker.sock`. Cache per profile for 30s.
   Never depend on the current docker context. Unset `DOCKER_HOST`/`DOCKER_CONTEXT` in child env.
3. **PATH fix.** GUI apps on macOS don't inherit the shell PATH. At startup, run `$SHELL -ilc 'printf "__PATH__%s__PATH__" "$PATH"'`
   (3s timeout, parse between markers), then prepend/merge known dirs: `/opt/homebrew/bin`, `/opt/homebrew/sbin`,
   `/usr/local/bin`, `~/.local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `~/.nix-profile/bin`, `/nix/var/nix/profiles/default/bin`,
   `/run/current-system/sw/bin`, `/snap/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`. Set the result as the process `PATH`
   (`std::env::set_var`) before anything else, so colima's own subprocesses (limactl, qemu, docker) resolve.
4. No command runs through a shell with interpolated user input — always `Command::new(bin).args([...])`.
   (Exception: `open_terminal`, which builds a command string; quote each arg with single-quote escaping.)
5. Per-profile lifecycle lock: a start/stop/restart/delete/kubernetes op on a profile that already has an op in flight
   returns error `"another operation is in progress for profile <p>"`.
6. All commands return `Result<T, String>`; the error string is the trimmed stderr (or stdout if stderr empty),
   prefixed with nothing. Missing binary → `"<bin> not found in PATH"`.
7. Profile names: validate `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$` in backend before use.

## 3. Types (JSON shape crossing the IPC boundary — camelCase)

```ts
export interface EnvInfo {
  platform: "macos" | "linux" | string;
  arch: string;
  colimaVersion: string | null;   // first line of `colima version`, e.g. "colima version 0.8.1"
  dockerAvailable: boolean;
  kubectlAvailable: boolean;
  limactlAvailable: boolean;
  path: string;
}

export interface Profile {        // from `colima list --json` (one JSON object per line)
  name: string;
  status: string;                 // "Running" | "Stopped" | "Broken" | ...
  arch: string;
  cpus: number;
  memory: number;                 // bytes
  disk: number;                   // bytes
  runtime: string | null;         // absent when stopped
  address: string | null;
}

export interface ProfileStatus {  // from `colima status --json -p <p>`; null when not running
  displayName: string;
  driver: string;
  arch: string;
  runtime: string;
  mountType: string;
  ipAddress: string;
  dockerSocket: string;
  containerdSocket: string | null;
  kubernetes: boolean;
  cpu: number;
  memory: number;                 // bytes
  disk: number;                   // bytes
}

export interface ProfileConfig {  // parsed from <colimaHome>/<profile>/colima.yaml (missing fields → defaults)
  cpu: number; memory: number /*GiB*/; disk: number /*GiB*/;
  arch: string; runtime: string; vmType: string; mountType: string;
  rosetta: boolean; networkAddress: boolean;
  kubernetesEnabled: boolean; kubernetesVersion: string;
  mounts: string[];               // "location[:w]" strings
}

export interface StartOptions {   // all optional; only provided fields become CLI flags
  cpu?: number; memory?: number; disk?: number;
  arch?: string; runtime?: string; vmType?: string; mountType?: string;
  kubernetes?: boolean; kubernetesVersion?: string;
  vzRosetta?: boolean; networkAddress?: boolean; activate?: boolean;
  mounts?: string[];
}

export interface Container {       // from `docker ps -a --no-trunc --format '{{json .}}'`
  id: string; names: string; image: string; command: string;
  state: string;                   // running | exited | paused | created | restarting | dead
  status: string;                  // "Up 3 minutes"
  ports: string;                   // raw docker ports string
  portLinks: { hostPort: number; containerPort: number; protocol: string; url: string }[]; // parsed, tcp host-bound only, url = http://localhost:<hostPort>
  createdAt: string; runningFor: string;
  composeProject: string | null;   // label com.docker.compose.project
  composeService: string | null;   // label com.docker.compose.service
}

export interface ContainerStats {  // `docker stats --no-stream --format '{{json .}}'`
  id: string; name: string; cpuPerc: string; memUsage: string; memPerc: string; netIO: string; blockIO: string; pids: string;
}

export interface Image {           // `docker images --format '{{json .}}'`
  id: string; repository: string; tag: string; size: string; createdSince: string; createdAt: string;
  inUse: boolean;                  // true if any container (any state) uses this image id or repo:tag
}

export interface Volume {          // `docker volume ls --format '{{json .}}'`
  name: string; driver: string; mountpoint: string; size: string | null;
}

export interface RunOptions {
  image: string; name?: string;
  ports?: string[];                // "8080:80", "127.0.0.1:5432:5432/tcp"
  env?: string[];                  // "KEY=VALUE"
  volumes?: string[];              // "/host:/ctr[:ro]" or "vol:/ctr"
  command?: string;                // split on whitespace honoring simple quotes (shell-words style)
  restart?: string;                // no | always | unless-stopped | on-failure
  network?: string;
  autoRemove?: boolean;            // --rm
}

export interface K8sPod {
  name: string; namespace: string;
  phase: string;                   // status.phase
  status: string;                  // display status à la `kubectl get pods`: waiting/terminated reason (CrashLoopBackOff, ImagePullBackOff, Completed...), "Terminating" if deletionTimestamp, else phase
  ready: string;                   // "1/2"
  restarts: number;
  createdAt: string;               // ISO timestamp
  node: string | null; podIp: string | null;
  containers: string[];
}
export interface K8sDeployment { name: string; namespace: string; ready: string; upToDate: number; available: number; replicas: number; createdAt: string; images: string[]; }
export interface K8sService { name: string; namespace: string; type: string; clusterIp: string; externalIp: string | null; ports: string; createdAt: string; }
export interface K8sNode { name: string; status: string; roles: string; version: string; internalIp: string | null; osImage: string; cpu: string; memory: string; createdAt: string; }

export interface LogEvent { streamId: string; line: string; stream: "stdout" | "stderr"; }
export interface LogEnd { streamId: string; code: number | null; }
export interface OpLog { profile: string; op: string; line: string; }
```

## 4. IPC contract (Tauri commands; JS arg names camelCase, Rust snake_case)

| Command | Args | Returns | Implementation |
|---|---|---|---|
| `env_info` | – | `EnvInfo` | `colima version`, `which`-style lookup in resolved PATH |
| `list_profiles` | – | `Profile[]` | `colima list --json`; empty stdout → `[]` |
| `profile_status` | `profile` | `ProfileStatus \| null` | `colima status --json -p p`; non-zero exit → `null` |
| `profile_config` | `profile` | `ProfileConfig \| null` | read yaml; `COLIMA_HOME` env or `~/.colima`; file `<home>/<profile>/colima.yaml`; missing → `null` |
| `start_profile` | `profile, options: StartOptions` | `void` | `colima start -p p [flags]`; streams each stdout/stderr line as event `colima-op-log` (`OpLog`, op=`"start"`). Resolves when process exits; rejects with last 20 lines on failure. Never pass `--edit`/`--foreground`. |
| `stop_profile` | `profile, force: boolean` | `void` | `colima stop -p p [--force]`, streamed as op `"stop"` |
| `restart_profile` | `profile` | `void` | `colima restart -p p`, op `"restart"` |
| `delete_profile` | `profile` | `void` | `colima delete -f -p p` (colima ≥0.8 uses `--force`/`-f`), op `"delete"` |
| `kubernetes_action` | `profile, action: "start"\|"stop"\|"reset"\|"delete"` | `void` | `colima kubernetes <action> -p p` (reset/delete: add `-f` if the CLI accepts it; detect by running and retrying without on "unknown shorthand flag"), op `"k8s-<action>"` |
| `busy_profiles` | – | `string[]` | profiles with an op in flight |
| `list_containers` | `profile` | `Container[]` | see §3 |
| `container_action` | `profile, id, action: "start"\|"stop"\|"restart"\|"pause"\|"unpause"\|"kill"\|"remove"` | `void` | `docker -H s <action> id`; remove = `rm -f` |
| `container_inspect` | `profile, id` | `any` (JSON) | `docker inspect id` → first element |
| `container_stats` | `profile` | `ContainerStats[]` | running containers only |
| `run_container` | `profile, options: RunOptions` | `string` (container id) | `docker run -d ...` |
| `list_images` | `profile` | `Image[]` | |
| `remove_image` | `profile, id, force: boolean` | `void` | `docker rmi [-f] id` |
| `pull_image` | `profile, reference` | `void` | `docker pull ref`, streamed as `colima-op-log` op `"pull"` |
| `list_volumes` | `profile` | `Volume[]` | size via `docker system df -v --format '{{json .}}'` best-effort, else null |
| `remove_volume` | `profile, name` | `void` | `docker volume rm name` |
| `prune` | `profile, what: "containers"\|"images"\|"volumes"\|"system"` | `string` (output) | `docker <what> prune -f` (`images` adds `-a`; `system` = `docker system prune -f`) |
| `k8s_namespaces` | `profile` | `string[]` | `kubectl --context c get ns -o json` |
| `k8s_pods` | `profile, namespace: string \| null` | `K8sPod[]` | null → `-A` |
| `k8s_deployments` | `profile, namespace: string \| null` | `K8sDeployment[]` | |
| `k8s_services` | `profile, namespace: string \| null` | `K8sService[]` | |
| `k8s_nodes` | `profile` | `K8sNode[]` | |
| `k8s_describe` | `profile, kind, namespace: string \| null, name` | `string` | `kubectl describe` (kind ∈ pod, deployment, service, node) |
| `k8s_delete_pod` | `profile, namespace, name` | `void` | `--wait=false` |
| `k8s_scale` | `profile, namespace, name, replicas: number` | `void` | `kubectl scale deployment/name --replicas=n` |
| `k8s_restart_deployment` | `profile, namespace, name` | `void` | `kubectl rollout restart deployment/name` |
| `k8s_yaml` | `profile, kind, namespace: string \| null, name` | `string` | `kubectl get kind name -o yaml` |
| `start_log_stream` | `profile, target: {kind:"container", id, tail} \| {kind:"pod", namespace, pod, container: string \| null, tail}` | `string` (streamId, uuid) | `docker logs -f --tail N id` / `kubectl logs -f --tail=N [-c c] pod -n ns`. Emits `log-line` (`LogEvent`) per line and `log-end` (`LogEnd`) on exit. |
| `stop_log_stream` | `streamId` | `void` | kill child; no-op if gone |
| `terminal_open` | `profile: string \| null, target: TerminalTarget, cols: number, rows: number` | `string` (sessionId, uuid) | Spawns the command in a **PTY inside the app** (crate `portable-pty`). Targets: `{kind:"host"}` → user's `$SHELL -l` (fallback `/bin/zsh`, `/bin/bash`, `/bin/sh`), cwd = `$HOME`, profile ignored; `{kind:"vm"}` → `colima ssh -p p`; `{kind:"container", id}` → `docker -H s exec -it id sh -c 'command -v bash >/dev/null && exec bash \|\| exec sh'`; `{kind:"pod", namespace, pod, container}` → `kubectl --context c exec -it -n ns pod [-c c] -- sh -c 'command -v bash >/dev/null && exec bash \|\| exec sh'`. Env: `TERM=xterm-256color`, `COLORTERM=truecolor`, `LANG` defaults to `en_US.UTF-8` if unset, `DOCKER_HOST`/`DOCKER_CONTEXT` removed. Reader runs on a blocking thread; each read chunk (≤16 KiB) emitted as `terminal-output`. On child exit emit `terminal-exit`. |
| `terminal_write` | `sessionId, data: string` | `void` | write UTF-8 input to the PTY master |
| `terminal_resize` | `sessionId, cols: number, rows: number` | `void` | resize PTY |
| `terminal_close` | `sessionId` | `void` | kill child + drop PTY; no-op if gone |

`TerminalTarget = {kind:"host"} | {kind:"vm"} | {kind:"container", id} | {kind:"pod", namespace, pod, container: string \| null}`.
The old `open_terminal` (external Terminal.app / x-terminal-emulator) is **removed** — nothing opens an OS terminal window anymore.

Events: `colima-op-log` (OpLog), `log-line` (LogEvent), `log-end` (LogEnd), `profiles-changed` (payload `null`, emitted after any lifecycle op finishes, success or failure),
`terminal-output` (`{ sessionId: string, data: string /* base64 of raw PTY bytes */ }`), `terminal-exit` (`{ sessionId: string, code: number | null }`).
Terminal sessions live in managed state `Mutex<HashMap<String, Session>>`; all are killed on app quit.

Log streaming: keep children in `Mutex<HashMap<String, Child>>` in managed state; kill all on app exit.
Batch `log-line` emission is fine but must preserve order.

## 5. System tray

Tray icon (use the app icon, template image on macOS) with menu:
- `Colima Desktop` (disabled header) / status line per profile: `● default — Running` (disabled items)
- `Start default` / `Stop default` (enabled based on status of profile `default`; runs the same code path as the commands, emits events)
- separator, `Open Dashboard` (show + focus main window), `Quit`
Rebuild the menu every 5s in a background task and after `profiles-changed`.
Closing the main window **hides** it (app keeps running in tray); `Quit` exits. On macOS clicking the dock icon re-shows the window (`RunEvent::Reopen`).

## 6. Frontend (UX modeled on Docker Desktop)

Global layout:
- **Left sidebar**: logo + "Colima Desktop"; nav: Machines, Containers, Images, Volumes, Kubernetes (badge "off" when disabled for selected profile). Bottom: env info (colima version) link.
- **Top bar**: profile selector (dropdown of profiles, with status dot), status pill (Running/Stopped/Starting…), primary button Start/Stop, restart, "Terminal" (VM ssh).
- **Bottom status bar**: engine status for selected profile ("Engine running · docker · 2 CPU · 3 GiB · k8s on"), plus spinner when an op is in flight.
- Selected profile persisted in `localStorage` (try/catch), default: first running profile, else `default`.
- Theme: follows system (`prefers-color-scheme`), dark default aesthetic polished like a native dev tool. Use Tailwind; define CSS variables for surface/border/accent colors. Accent: Colima teal/green.
- Polling via react-query: profiles every 3s, containers every 2s (only when on Containers page & running), stats every 3s, k8s every 3s. Invalidate on `profiles-changed`.
- Missing dependencies screen: if `colimaVersion` is null, show a full-page setup guide (brew install colima docker kubectl / linux instructions).

Pages:
1. **Machines**: card per profile — name, status dot, runtime, arch, CPU/Mem/Disk, k8s badge, address. Actions: Start (opens Start dialog), Stop, Restart, Delete (confirm by typing profile name), Terminal (ssh). "New machine" button → same Start dialog with editable name. Start dialog fields prefilled from `profile_config` (or defaults cpu 2, memory 2, disk 100, runtime docker, vmType vz on macOS / qemu on linux, arch host): CPU, Memory (GiB), Disk (GiB, warn it can't shrink), Runtime (docker|containerd|incus), VM type (vz|qemu; hide vz on linux), Arch, Mount type (sshfs|9p|virtiofs), Rosetta (macOS+vz only), Network address, Kubernetes toggle + version, Activate context toggle, mounts list editor. While an op runs, an **Operation console** drawer at bottom shows streamed `colima-op-log` lines with auto-scroll, can be collapsed.
2. **Containers**: search box, "Only running" toggle, "Run container" button, Prune menu. Table grouped by compose project (collapsible group rows, aggregate state). Columns: state dot, Name, Image, Status, Ports (clickable links opening browser via opener), CPU%, Mem (from stats), actions (start/stop, restart, pause, terminal, delete). Row click → right-side detail panel with tabs: **Logs** (live stream, auto-scroll toggle, search filter, clear, ANSI stripped), **Inspect** (pretty JSON, collapsible or preformatted), **Stats**. When runtime ≠ docker: empty state explaining container view needs docker runtime.
3. **Images**: search, Pull button (dialog; streams output into op console), table: Repository, Tag, ID (short), Created, Size, In-use badge; actions: Run (opens Run dialog prefilled), Delete (force when in use with confirm). Prune unused.
4. **Volumes**: table name, driver, size, mountpoint; delete; prune.
5. **Kubernetes**: if `status.kubernetes` false → empty state with "Enable Kubernetes" (calls `kubernetes_action start`, shows op console; note text: "To keep Kubernetes enabled across restarts, enable it in the machine's Start settings") . If enabled: header with context name `colima[-p]`, namespace selector (All + list), Reset / Disable menu (confirm). Tabs: **Pods** (name, ns, status colored, ready, restarts, age, node; actions logs, shell, describe, yaml, delete), **Deployments** (ready, up-to-date, available, age, images; actions scale (number input dialog), restart, describe, yaml), **Services** (type, cluster IP, external IP, ports, age), **Nodes** (status, roles, version, IP, OS, cpu/mem capacity). Detail drawer shows logs (streaming, container selector) / describe / yaml as monospaced text.
Relative ages computed client-side from ISO timestamps (e.g. `5m`, `3h`, `2d`).

### 6.1 Bottom dock (IDE-style panel) — v0.1.0 addition
A resizable bottom panel (drag handle, height persisted in localStorage, min 140px, max 70% of window), toggled with
`Ctrl+\`` (both platforms) and a Terminal button in the status bar. It has tabs:
- **Output** (always first, not closable): the former OpConsole — streamed `colima-op-log` lines. The dock auto-opens on this tab when a lifecycle op starts.
- **Terminal tabs** (closable, `×`): each is an xterm.js instance (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)
  bound to one `terminal_open` session. Title: `zsh` / `vm: default` / `ctr: <name>` / `pod: <ns>/<pod>`. Exited sessions show
  `[process exited with code N]` and stay open until closed. Input → `terminal_write`; FitAddon + ResizeObserver → `terminal_resize`;
  decode base64 → `Uint8Array` → `term.write`. Terminal font: JetBrains Mono 13px; xterm theme derived from the app's CSS tokens and
  updated live when the theme changes. Tabs stay mounted (hidden, not unmounted) when switching so scrollback survives.
- A `+` button with a menu: "Local shell", "Colima VM shell (<profile>)" (disabled if not running).
Every "Terminal"/"Shell" action in the app (top bar VM terminal, container row, container detail, pod row) opens a **new tab in this dock** and focuses it.

### 6.2 Theme
Theme switcher (System / Light / Dark) — a segmented control in the sidebar footer. Persist in localStorage (try/catch), apply
as `data-theme="light|dark"` on `<html>`; "System" removes the attribute and follows `prefers-color-scheme`. The green accent is
the brand in **both** modes (dark: `#3ecf8e`-family, light: a deeper green with AA contrast on white, e.g. `#15803d`/`#16a34a`);
the light theme must be fully designed (surfaces, borders, text, status colors, tables, dialogs, code/log views, terminal), not an inversion.

### 6.3 Branding / version
Colima Desktop is an **independent open-source project** (not affiliated with the Colima maintainers); it uses Colima as its engine.
The sidebar footer shows `Colima Desktop v0.1.0` (version injected at build time from package.json via Vite `define: { __APP_VERSION__ }`)
— it must NOT show the detected colima version. The detected colima/docker/kubectl versions appear only on the Setup/About view.
Versions are kept in sync at `0.1.0` in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json.

Toasts for errors/success (simple self-made toast stack). Confirm dialogs for destructive ops. Keyboard: `Cmd/Ctrl+K` focuses search on list pages.
Do not use `window.confirm`/`alert` (not reliable in webviews) — use in-app dialogs.

## 7. Build & run

- `npm install`, `npm run tauri dev`, `npm run tauri build`.
- Linux build deps documented in README (webkit2gtk-4.1, libayatana-appindicator3, librsvg2, etc.).
- README (Turkish + English short) with features, requirements, dev/build instructions.
