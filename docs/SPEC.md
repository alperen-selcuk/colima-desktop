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
1a. **App-managed kubeconfig (v0.1.2+).** kubectl never reads the user's `~/.kube/config` for colima clusters. colima only
   rewrites `~/.kube/config` when the VM IP changes, so after k3s rotates its client certificate (yearly, on restart) or the
   cluster is recreated, the stored `colima` credentials go stale ("the server has asked for the client to provide
   credentials"). Instead the backend fetches `/etc/rancher/k3s/k3s.yaml` via `colima ssh -p <p> -- sudo cat /etc/rancher/k3s/k3s.yaml`,
   renames `default` → the kube context id (like colima does), replaces `https://127.0.0.1:` with `https://<ip>:` when
   `colima status` reports a non-empty, non-127.0.0.1 `ip_address`, and writes it atomically with mode 0600 to
   `<app_data_dir>/kube/<profile>.yaml`. Every kubectl call (lists, describe, yaml, scale, logs streams, PTY exec) runs with
   `--kubeconfig <that file> --context <ctx>` and `KUBECONFIG` removed from the child env. The file is (re)fetched on first use
   per profile per app session, after any `kubernetes_action`/lifecycle op, and once more (then retry the command once) when
   kubectl fails with an auth/cert error (`provide credentials`, `Unauthorized`, `x509`, `certificate`). Missing file / VM not
   running → friendly error "Kubernetes is not reachable: <reason>". kubectl stderr noise lines (`E0927 … memcache.go …`) are
   stripped from error messages; keep the final meaningful line(s).
   **Terminal kubectl health:** command `host_kubeconfig_health(profile) -> { contextExists, credentialsMatch, detail }`
   compares SHA-256 of `users.<ctx>.client-certificate-data` and `clusters.<ctx>.certificate-authority-data` in the user's
   kubeconfig (first path of `KUBECONFIG` env from the login shell, else `~/.kube/config`; read via `kubectl config view --raw
   --kubeconfig <path> -o jsonpath=...` filtered to the colima entries only) with the app-managed file.
   `repair_host_kubeconfig(profile)` (only on explicit user click, after a confirm dialog): back up the file to
   `<path>.colima-desktop-bak-<unix-ts>`, then update ONLY `users.<ctx>` client-certificate-data/client-key-data and
   `clusters.<ctx>` certificate-authority-data/server via `kubectl config set ... --kubeconfig <path>` (`--set-raw-bytes=false`
   with base64 data). Never touch any other user/cluster/context or current-context.
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

export interface Volume {          // `docker volume ls` enriched with `system df -v` + batched `volume inspect`
  name: string; driver: string; mountpoint: string;
  size: string | null;             // e.g. "136.5MB"; null if the size lookup failed
  sizeBytes: number | null;        // `size` parsed to bytes (decimal/SI: kB/MB/GB = 1000-based); null if unknown
  containers: number | null;       // containers referencing this volume; null if the lookup failed
  inUse: boolean;                  // containers > 0 (fails open to false on lookup failure)
  anonymous: boolean;              // label com.docker.volume.anonymous present
  composeProject: string | null;   // label com.docker.compose.project
  createdAt: string | null;        // docker volume inspect's CreatedAt (RFC3339)
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
| `deps_check` | – | `Dep[]` | §6.9: detect colima/docker/docker-compose/kubectl/qemu (PATH + Homebrew), with allowlisted fix commands |
| `deps_fix` | `name` | `Dep[]` | Runs the fix produced by `deps_check` for `name` (`brew install/link <formula>`), streamed as op `"deps"` (profile `""`), then re-checks |
| `list_profiles` | – | `Profile[]` | `colima list --json`; empty stdout → `[]` |
| `profile_status` | `profile` | `ProfileStatus \| null` | `colima status --json -p p`; non-zero exit → `null` |
| `profile_config` | `profile` | `ProfileConfig \| null` | read yaml; `COLIMA_HOME` env or `~/.colima`; file `<home>/<profile>/colima.yaml`; missing → `null` |
| `start_profile` | `profile, options: StartOptions` | `void` | `colima start -p p [flags]`; streams each stdout/stderr line as event `colima-op-log` (`OpLog`, op=`"start"`). Resolves when process exits; rejects with last 20 lines on failure. Never pass `--edit`/`--foreground`. |
| `stop_profile` | `profile, force: boolean` | `void` | `colima stop -p p [--force]`, streamed as op `"stop"` |
| `restart_profile` | `profile` | `void` | `colima restart -p p`, op `"restart"` |
| `delete_profile` | `profile` | `void` | `colima delete -f -p p` (colima ≥0.8 uses `--force`/`-f`), op `"delete"` |
| `kubernetes_action` | `profile, action: "start"\|"stop"\|"reset"\|"delete"` | `void` | `colima kubernetes <action> -p p` (reset/delete: add `-f` if the CLI accepts it; detect by running and retrying without on "unknown shorthand flag"), op `"k8s-<action>"` |
| `busy_profiles` | – | `string[]` | profiles with an op in flight |
| `profile_disk_info` | `profile` | `{ exists: boolean, sizeGiB: number \| null, usedOnHostBytes: number \| null }` | stat `<colimaHome>/_lima/<instanceId>/diffdisk` (instanceId = `colima` for `default`, else `colima-<profile>`): apparent length = real disk size, `blocks*512` = bytes used on the host. Missing file → `exists:false`. |
| `recreate_profile` | `profile, configContent` | `void` | Validate YAML with the typed validator, then (busy lock, op `"recreate"`): `colima stop -p p` (failures ignored), `colima delete -f -p p` (also removes `<colimaHome>/<p>/colima.yaml`), atomic config save of `configContent`, `colima start -p p` (no flags). Invalidates kubeconfig/docker-socket/compose caches; emits `profiles-changed`. |
| `reclaim_space` | `profile` | `void` | Running machines only. `docker -H s system prune -af` (never volumes), then best-effort `colima ssh -p p -- sudo fstrim -av`; busy lock, op `"reclaim"`. |
| `list_containers` | `profile` | `Container[]` | see §3 |
| `container_action` | `profile, id, action: "start"\|"stop"\|"restart"\|"pause"\|"unpause"\|"kill"\|"remove"` | `void` | `docker -H s <action> id`; remove = `rm -f` |
| `container_inspect` | `profile, id` | `any` (JSON) | `docker inspect id` → first element |
| `container_stats` | `profile` | `ContainerStats[]` | running containers only |
| `run_container` | `profile, options: RunOptions` | `string` (container id) | `docker run -d ...` |
| `list_images` | `profile` | `Image[]` | |
| `remove_image` | `profile, id, force: boolean` | `void` | `docker rmi [-f] id` |
| `pull_image` | `profile, reference` | `void` | `docker pull ref`, streamed as `colima-op-log` op `"pull"` |
| `list_volumes` | `profile` | `Volume[]` | `volume ls` + best-effort `system df -v --format '{{json .Volumes}}'` (size/containers; **must** target the `.Volumes` array, not `{{json .}}'s single report object — see docker.rs doc comment) + best-effort batched `volume inspect <names...>` (createdAt/labels, real JSON map) |
| `remove_volume` | `profile, name` | `void` | `docker volume rm name` |
| `prune` | `profile, what: "containers"\|"images"\|"volumes"\|"volumes-all"\|"system"` | `string` (output) | `docker <what> prune -f` (`images` adds `-a`; `volumes` = anonymous-only, docker's own default since 23.0; `volumes-all` adds `-a` to also remove named unused volumes; `system` = `docker system prune -f`) |
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

| `k8s_kubeconfig` | `profile` | `KubeconfigInfo = { path, context, server, content }` | v0.2.3. Refreshes (via `ensure_fresh`) and returns the app-managed kubeconfig (`<app data>/kube/<profile>.yaml`) with its context name and API server URL. Contains credentials: never logged. |
| `k8s_export_kubeconfig` | `profile, path` | `string` (path written) | v0.2.3. Writes the app-managed kubeconfig to `path` with mode 0600 (atomic). Rejects relative paths, directories and the user's own kubeconfig (`$KUBECONFIG` first entry or `~/.kube/config`). |
| `k8s_merge_kubeconfig` | `profile` | `RepairResult { backupPath }` | v0.2.3. Same logic as `repair_host_kubeconfig` (backup first, only the `colima*` user/cluster entries, never `current-context`) and additionally adds the `contexts.<ctx>` entry when it does not exist yet. `backupPath` is `""` when no kubeconfig existed. Explicit user click + confirm dialog only. |

Events: `colima-op-log` (OpLog), `colima-op-end` (`OpEnd = { profile, op, ok, error }`, v0.2.3: emitted once when a streamed op finishes), `log-line` (LogEvent), `log-end` (LogEnd), `profiles-changed` (payload `null`, emitted after any lifecycle op finishes, success or failure),
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
4. **Volumes**: Docker Engine-styled header with stat tiles (volume count, total size, unused count, reclaimable
   size); table columns Name / Source (compose project badge, "named", or "anonymous") / Size / In use (container
   count or "Unused") / Created (relative age), sortable by name/size/created; row delete (confirm; disabled with
   an explanation while in use). "Prune…" opens a dialog with two scopes — "Unused anonymous volumes" (`volumes`)
   and "All unused volumes, including named" (`volumes-all`) — previewing exactly which volumes (name, source,
   size) the chosen scope would remove, computed client-side as `!inUse && (all || anonymous)`; a data-loss
   warning and typing `delete` are required before confirming the `all` scope when it includes named volumes; an
   empty preview disables the button ("Nothing to prune"). After pruning, a toast shows docker's own output
   ("Total reclaimed space: …") and the list refetches.
5. **Kubernetes**: if `status.kubernetes` false → empty state with "Enable Kubernetes" (calls `kubernetes_action start`, shows op console; note text: "To keep Kubernetes enabled across restarts, enable it in the machine's Start settings") . If enabled: header with context name `colima[-p]`, namespace selector (All + list), Reset / Disable menu (confirm). Tabs: **Pods** (name, ns, status colored, ready, restarts, age, node; actions logs, shell, describe, yaml, delete), **Deployments** (ready, up-to-date, available, age, images; actions scale (number input dialog), restart, describe, yaml), **Services** (type, cluster IP, external IP, ports, age), **Nodes** (status, roles, version, IP, OS, cpu/mem capacity). Detail drawer shows logs (streaming, container selector) / describe / yaml as monospaced text.
Relative ages computed client-side from ISO timestamps (e.g. `5m`, `3h`, `2d`).

### 6.1 Bottom dock (IDE-style panel) — v0.1.0 addition
A resizable bottom panel (drag handle, height persisted in localStorage, min 140px, max 70% of window), toggled with
`Ctrl+\`` (both platforms) and a Terminal button in the status bar. It has tabs:
- **Output** (always first, not closable): the former OpConsole — streamed `colima-op-log` lines. The dock auto-opens on this tab when a lifecycle op starts.
- **Activity indicator (v0.2.3):** the status bar and top bar show every running lifecycle op as `<profile> · <phase>`; the phase is parsed from colima's log lines by the pure helper `src/lib/opPhase.ts` (`starting colima` → Starting VM, `context=docker` → Starting Docker, `context=kubernetes` → Starting Kubernetes, `updating config` → Updating kubeconfig, `done` → Done). Machine cards show the phase while busy. On `colima-op-end` success a toast appears ("default is running · Kubernetes ready" with an **Open Kubernetes** action when k3s was part of the start); failures are toasted by the caller with the friendly error. Ops whose end event is missed are dropped once the profile is no longer busy.
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
Versions are kept in sync in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json (the release tag `vX.Y.Z` must match).

### 6.4 Machine configuration editor ("Start with configuration…") — v0.1.0 addition
Replaces the need for `colima start --edit` (which opens `$EDITOR` in a terminal). A full-screen dialog that edits the
profile's `colima.yaml` with buttons/toggles/inputs for **every** option, preserving the file's comments and unknown keys.

Backend (new module `src-tauri/src/config_file.rs`):
| Command | Args | Returns | Implementation |
|---|---|---|---|
| `profile_config_raw` | `profile` | `{ content: string, source: "profile" \| "template" \| "builtin", path: string, exists: boolean }` | First existing of: `<colimaHome>/<profile>/colima.yaml` (source `profile`), `<colimaHome>/_templates/default.yaml` (source `template`, = `colima template`), else the upstream default template embedded in the binary via `include_str!` (copy of colima's `embedded/defaults/colima.yaml`, MIT, attribution comment) (source `builtin`). `path` is always the profile file path; `exists` whether it exists. |
| `save_profile_config_raw` | `profile, content` | `void` | Validate profile name; `serde_yaml` must parse it into a mapping (else `Err("invalid YAML: ...")`). Create the profile dir if missing; if the file exists, copy it to `colima.yaml.bak`; write atomically (temp file in same dir + rename). |
Starting with the saved config = `start_profile(profile, {})` (no flags → colima reads the file; never pass flags from this screen).
Colima parses non-strictly, so keys unknown to the installed colima version are ignored, not errors.

Frontend: `src/lib/colimaConfig.ts` wraps `yaml` (eemeli/yaml) `parseDocument` → typed getters and `doc.setIn(path, value)` setters,
serializing with `String(doc)` so comments/ordering/unknown keys survive. Unit-tested (round-trip keeps comments; set nested keys;
create missing maps; lists of objects).

Dialog layout: left section nav, right form, sticky footer. Sections & keys:
- **Resources**: `cpu` (stepper), `memory` GiB (float), `disk` GiB (warn: cannot shrink an existing disk), `rootDisk`, `cpuType`, `arch` (host|aarch64|x86_64), `hostname`.
- **Runtime**: `runtime` (docker|containerd|incus — segmented), `autoActivate`, `modelRunner` (docker|ramalama), `docker` (daemon.json — JSON editor with validation, e.g. insecure-registries, registry-mirrors quick-add chips).
- **Kubernetes**: `kubernetes.enabled`, `kubernetes.version`, `kubernetes.k3sArgs` (list editor with quick toggles for `--disable=traefik`, `--disable=servicelb`, `--disable=metrics-server`, `--disable=coredns`, `--disable=local-storage`), `kubernetes.port`.
- **Virtual machine**: `vmType` (vz|qemu|krunkit; vz hidden on Linux), `rosetta` (macOS+vz), `binfmt`, `nestedVirtualization`, `portForwarder` (ssh|grpc), `diskImage`, `diskImageMirror`, `forceDiskImage`.
- **Network**: `network.address`, `network.mode` (shared|bridged), `network.interface`, `network.subnet`, `network.preferredRoute`, `network.hostAddresses`, `network.gatewayAddress`, `network.nat66Prefix`, `network.dns` (IP list), `network.dnsHosts` (key→value map).
- **Mounts**: `mountType` (sshfs|9p|virtiofs), `mountInotify`, `mounts` (rows: location [folder picker via `@tauri-apps/plugin-dialog`], mountPoint, writable).
- **SSH**: `sshConfig`, `sshPort`, `forwardAgent`.
- **Environment**: `env` (key→value map).
- **Provision**: `provision` (rows: mode system|user, script — monospace textarea).
- **YAML**: raw editor (monospace textarea with line numbers), two-way synced with the form; parse errors shown inline and block saving.
Each field shows its YAML key and a one-line help. Changed fields get a subtle "modified" marker; footer shows "N changes".
**Disk can't shrink (v0.2.1):** Lima/colima cannot shrink a VM disk (a smaller `disk` makes `colima start` fail with
"error starting vm: error at 'starting'"). For an existing machine, a `disk` below `profile_disk_info.sizeGiB` is an
**error** that blocks Save / Save & Start / Save & Restart: "A VM disk can't be shrunk (current size N GiB). Recreate the
machine to use a smaller disk." with a **Recreate with smaller disk…** button. Equal or larger is fine. The button opens a
confirm dialog (consequences: all images, containers, volumes and the Kubernetes cluster are deleted; configuration incl.
Kubernetes settings is kept; shows current and new size; requires typing the profile name) and calls `recreate_profile`.
No validation rule blocks Kubernetes settings (enabled/version/k3sArgs/port); covered by a test.
**Reclaim space (v0.2.1):** Machines card button and a button in the Resources section (running machines only) open a dialog showing
the disk's used-on-Mac size, then run `reclaim_space` (`docker system prune -af`, not volumes — links to the Volumes page —
plus `fstrim`); afterwards `profile_disk_info` is re-read and a toast says "Freed X on your Mac" (or that space inside the VM
was freed but the Mac file didn't shrink). `colima start` failures with "error at 'starting'" are mapped to a shrink explanation
(when configured disk < current disk) or a generic "VM failed to start; if you reduced the disk…" message.
Warnings banner when changing `arch`, `runtime` or `vmType` of an existing machine ("requires deleting the machine").
Footer buttons: `Reset to template`, `Save`, primary `Save & Start` (stopped) / `Save & Restart` (running; stop then start).
Entry points: Machines card Start becomes a split button (`Start` | ▾ `Start with configuration…`), running cards get `Configure…`,
"New machine" opens this dialog with a name field (source template). Top bar gets the same split button.
**v0.2.3 never-trapped rule:** the editor has a `← Machines` home button at the bottom-left of the section nav and the header `×`
and `Cancel`/`Close` are always enabled. While Save & Start / Save & Restart runs, the footer shows the live phase; closing keeps the
operation running in the backend (output keeps streaming to the Output dock) and toasts "Still starting <profile> in the background — see Output".
The busy flag resets when the start/stop promise settles AND on `colima-op-end`. Root cause of the v0.2.2 "stuck Working…": `run_streaming`
waited for EOF on the child's stdout/stderr, which a daemonised grandchild (lima hostagent / k3s helpers) keeps open after `colima start`
exits; it now stops draining shortly (1.5s) after the process exits.

### 6.5 Kubernetes enablement flow & k3s version picker

Kubernetes page states (selected profile):
- **Machine not running** (status null / not Running): no error toast. Empty state: "Kubernetes needs the machine to be running.
  Start `<profile>` with Kubernetes enabled?" Primary button **Start with Kubernetes…** → opens the configuration editor (§6.4)
  on the *Kubernetes* section with `kubernetes.enabled: true` pre-applied as an unsaved change (and `kubernetes.version` set to
  the colima default if empty); the user reviews and clicks Save & Start. Secondary: plain **Start** (existing lifecycle).
  If a lifecycle op is in flight for the profile, show "Starting…" instead.
- **Running, Kubernetes off**: **Enable Kubernetes** (quick: `kubernetes_action start`, this session only — say so) and
  **Enable permanently…** → configuration editor on the Kubernetes section with `enabled: true` pre-applied → Save & Restart.
- Never call `kubernetes_action` when the machine isn't running (also guard in the backend: return a friendly error
  "`<profile>` is not running — start it first" instead of colima's raw output).
- **Connect panel (v0.2.3):** when Kubernetes is running, a collapsible **Connect** card under the Kubernetes tabs shows the context
  (`colima` / `colima-<profile>`), the API server URL and the app-managed kubeconfig path, with actions **Copy kubeconfig**
  (`k8s_kubeconfig`), **Save kubeconfig as…** (tauri dialog save → `k8s_export_kubeconfig`, mode 0600, never `~/.kube/config`) and
  **Merge into ~/.kube/config** (`k8s_merge_kubeconfig`, confirm dialog, backup first, only `colima*` entries, never current-context).
  Copyable snippets: `kubectl --context <ctx> get pods -A`, `export KUBECONFIG=<saved path>` (after a save), and a note that colima's
  `autoActivate` may switch kubectl's current-context to colima on start (`kubectl config use-context <name>` switches back).
The configuration editor accepts `initialSection` and `initialPatch` (list of `{path, value}` applied via `setIn` on open, counted as changes).

k3s version picker — new backend command:
| Command | Args | Returns | Implementation |
|---|---|---|---|
| `k3s_versions` | `forceRefresh: boolean` | `{ versions: K3sVersion[], colimaDefault: string \| null, source: "github" \| "cache" \| "builtin", fetchedAt: string \| null, error: string \| null }` | Fetch `https://api.github.com/repos/k3s-io/k3s/releases?per_page=100` (2 pages) with `reqwest` (rustls, 10s timeout, `User-Agent: colima-desktop`); keep non-draft, non-prerelease tags matching `^v\d+\.\d+\.\d+\+k3s\d+$`; sort semver-desc. Cache to `<app_cache_dir>/k3s-versions.json` for 24h (serve cache when fresh unless forceRefresh; serve stale cache on network error with `error` set). Fallback: a builtin list embedded in the binary (latest patch of each minor ≥ 1.28 at build time). `colimaDefault` parsed from `colima start --help` (`--kubernetes-version ... (default "vX")`), cached per process. |
`K3sVersion = { version: string, minor: string /* "1.31" */, publishedAt: string \| null, latestInMinor: boolean }`.

Frontend `K3sVersionPicker` (used in the config editor's Kubernetes section AND the quick StartDialog): combobox input
(free text allowed) + dropdown: **Recommended** = colimaDefault (badge "colima default"); **Latest per minor** (newest first,
e.g. v1.34.1+k3s1 … one row per minor, with release date); **All versions** behind a search filter. Shows source/"updated x ago"
and a refresh button; offline → small note "showing built-in list". Validation: format `^v\d+\.\d+\.\d+\+k3s\d+$` is an
error (block save); a well-formed version not in the known list is a warning. When the user toggles `kubernetes.enabled` on and
the version is empty, prefill colimaDefault. For an existing running cluster, if the chosen version differs from the running
node version (from `k8s_nodes`), warn: "Changing the version of an existing cluster may require Kubernetes → Reset".

### 6.6 Kubernetes v0.1.2: more kinds, delete/edit, resource usage, redesign

All kubectl calls go through the app-managed kubeconfig helper (§2.1a). Allowed kinds (whitelist, validated in backend):
namespaced `pod | deployment | service | configmap | secret | ingress`, cluster-scoped `node` (read-only: no delete/edit).

New/changed types (camelCase JSON):
```ts
// K8sPod gains (sum over regular containers; null when no container sets it):
//   cpuRequestMilli, cpuLimitMilli: number | null; memRequestBytes, memLimitBytes: number | null
// K8sNode gains: cpuAllocatableMilli: number | null; memAllocatableBytes: number | null
export interface K8sConfigMap { name: string; namespace: string; keys: string[]; createdAt: string; }
export interface K8sSecret   { name: string; namespace: string; type: string; keys: string[]; createdAt: string; } // never values
export interface K8sIngress  { name: string; namespace: string; className: string | null; hosts: string[];
  address: string | null; ports: string /* "80" or "80, 443" */; tls: boolean;
  rules: { host: string | null; path: string; pathType: string | null; backend: string /* "svc:port" */ }[]; createdAt: string; }
export interface PodMetrics  { available: boolean; reason: string | null; pods: { namespace: string; name: string; cpuMilli: number; memBytes: number }[]; }
export interface NodeMetrics { available: boolean; reason: string | null; nodes: { name: string; cpuMilli: number; memBytes: number }[]; }
export interface SecretValue { value: string; binary: boolean } // binary → value is base64
```
New commands:
| Command | Args | Returns | Implementation |
|---|---|---|---|
| `k8s_configmaps` | `profile, namespace: string\|null` | `K8sConfigMap[]` | `get configmaps -o json` (keys = data ∪ binaryData keys, sorted) |
| `k8s_secrets` | `profile, namespace: string\|null` | `K8sSecret[]` | `get secrets -o json`; drop values before they leave the backend |
| `k8s_secret_value` | `profile, namespace, name, key` | `SecretValue` | explicit reveal of ONE key; base64-decode; `binary` if not valid UTF-8 |
| `k8s_ingresses` | `profile, namespace: string\|null` | `K8sIngress[]` | `get ingresses -o json` (networking.k8s.io/v1) |
| `k8s_delete` | `profile, kind, namespace: string\|null, name` | `void` | `delete <kind> <name> -n ns --wait=false`; node rejected |
| `k8s_edit_yaml` | `profile, kind, namespace, name` | `string` | `get -o yaml`, remove `metadata.managedFields` and `status`; keep `resourceVersion` |
| `k8s_apply_yaml` | `profile, kind, namespace, name, content, dryRun: boolean` | `string` (kubectl output) | parse YAML; its `kind`/`metadata.name`/`metadata.namespace` must match the target (else error); `kubectl replace -f - [--dry-run=server]` with content on **stdin** (never a temp file with secrets); friendly message on conflict ("modified since you opened it — reload") |
| `k8s_pod_metrics` | `profile, namespace: string\|null` | `PodMetrics` | `get --raw /apis/metrics.k8s.io/v1beta1/[namespaces/<ns>/]pods`; sum containers; 404/ServiceUnavailable → `available:false`, reason "metrics-server is not installed or not ready" |
| `k8s_node_metrics` | `profile` | `NodeMetrics` | `get --raw /apis/metrics.k8s.io/v1beta1/nodes` |
`k8s_describe` / `k8s_yaml` accept the new kinds; `k8s_yaml` for secrets masks every `data`/`stringData` value as `"••••••"`.
Quantity parsing (pure, unit-tested): CPU `"250m"`, `"1"`, `"0.5"`, `"123456789n"`, `"1500u"` → millicores; memory
`"128Mi"`, `"1Gi"`, `"123456Ki"`, `"1G"`, `"500M"`, `"1e3"`, plain bytes → bytes.

UI (Kubernetes page redesign):
- Kubernetes-flavoured header (official K8s wheel mark, cluster context, k3s version from node, namespace selector with counts).
- Tabs with official Kubernetes icons (kubernetes/community `icons/svg/resources/unlabeled`, CC-BY-4.0, attributed in
  README + `public/k8s-icons/NOTICE`): Pods, Deployments, Services, Ingresses, ConfigMaps, Secrets, Nodes — each with a count
  badge and its own accent colour (defined as CSS variables for both themes).
- Row actions for every namespaced kind: **Edit** (YAML editor dialog: monospace editor with line numbers, "Validate"
  = dryRun, "Save" = replace; errors inline), **Delete** (confirm dialog; type the name for deployments/namespaced objects in
  `kube-system`), plus existing kind-specific actions (logs/shell for pods, scale/restart for deployments).
- Pods: CPU and Memory columns with coloured usage bars — percentage of limit, else request, else node allocatable;
  green < 60%, amber < 85%, red ≥ 85%; tooltip with exact values (e.g. `120m / 500m limit`, `180 MiB / 256 MiB`).
  Nodes tab: CPU/Memory usage bars vs allocatable. Metrics unavailable → subtle note, columns show "—".
- Secrets: keys shown as chips; values hidden; per-key "Reveal" (calls `k8s_secret_value`) and Copy; auto-hide on close.
- Ingresses: hosts as clickable links (http/https by `tls`), rules table in the detail drawer.
- ConfigMaps: keys as chips; detail drawer shows data (values are not secret).

### 6.7 v0.1.3: Containers redesign, hide Kubernetes containers, Docker Compose

**Kubernetes containers.** With the docker runtime, k3s runs every pod container (and `k8s_POD_…` sandboxes) as a
Docker container labelled `io.kubernetes.pod.namespace` (verified: 41 of 41 containers on a test machine, most of
them exited leftovers that remain even when Kubernetes is disabled). `Container` gains
`kubernetes: { namespace: string, pod: string, container: string | null } | null` (from labels
`io.kubernetes.pod.namespace`, `io.kubernetes.pod.name`, `io.kubernetes.container.name`). The Containers page hides
these by default; a filter menu toggle "Show Kubernetes containers (N)" (persisted, default off) reveals them.
Counts, stat tiles and prune hints exclude them unless shown.

**Docker Compose.** Resolve the compose binary once per profile: `docker -H <socket> compose version` (plugin), else
standalone `docker-compose version` run with `DOCKER_HOST=<socket>` in its env. If neither exists → `available:false`
with an install hint (`brew install docker-compose` + the `cliPluginsExtraDirs` note, or distro package on Linux).
All compose calls use the same socket rules as §2.2. `Container` gains `composeWorkingDir: string | null` and
`composeConfigFiles: string[]` (labels `com.docker.compose.project.working_dir`, `…config_files`).
| Command | Args | Returns | Implementation |
|---|---|---|---|
| `compose_info` | `profile` | `{ available: boolean, version: string \| null, mode: "plugin" \| "standalone" \| null, hint: string \| null }` | as above |
| `compose_projects` | `profile` | `ComposeProject[]` = `{ name, status /* "running(2), exited(1)" */, configFiles: string[] }` | `compose ls -a --format json` |
| `compose_preview` | `profile, files: string[], projectName: string \| null` | `{ projectName: string, services: { name, image: string \| null, build: boolean, ports: string[] }[], warnings: string[] }` | `compose -f … [-p] config --format json` (validates the file; errors returned verbatim, noise stripped) |
| `compose_up` | `profile, files: string[], projectName: string \| null, build: boolean, pull: "missing" \| "always", forceRecreate: boolean` | `void` | `compose -f … [-p name] up -d [--build] --pull <p> [--force-recreate]`, working dir = first file's directory; streamed as `colima-op-log` op `"compose-up"`; lifecycle-style busy lock key `compose:<project>` |
| `compose_action` | `profile, project, action: "stop" \| "start" \| "restart" \| "down" \| "pull", configFiles: string[], removeVolumes: boolean` | `void` | `compose -p <project> [-f files] <action>` (`down` adds `--remove-orphans` and `-v` when removeVolumes); streamed as op `"compose-<action>"` |
Files must exist, be absolute, and end in `.yml`/`.yaml`; project names are validated like Compose (`^[a-z0-9][a-z0-9_-]*$`).
Log streaming gains target `{ kind: "compose", project, tail }` → `compose -p <project> logs -f --tail N --no-color`.
Homebrew cask adds `depends_on formula: "docker-compose"`.

**UI.** Containers page header: Docker whale mark + "Docker Engine" + profile/socket + compose status; stat tiles
(Running, Stopped, Compose projects, total CPU %, total memory); filter chips (All / Running / Stopped / Compose);
search; buttons **Run container** and **Compose up…** (dialog: file picker filtered to yml/yaml via
`@tauri-apps/plugin-dialog`, recent files (last 8, persisted), project name (default = directory name, lowercased),
options Build / Pull always / Force recreate, service preview from `compose_preview`, then Up → Output dock tab).
Compose project groups show a compose badge, aggregate state, and actions Up (re-up with stored files) / Restart /
Stop / Start / Down (confirm, "also remove volumes" checkbox) / Pull / Logs (aggregate stream in the detail panel).
Every container row shows an image avatar: the brand icon of well-known images via `simple-icons` (CC0; e.g. nginx,
redis, postgresql, mysql, mariadb, mongodb, node.js, python, go, alpine linux, ubuntu, debian, rabbitmq,
elasticsearch, grafana, prometheus, traefik, apache kafka, minio, docker) matched from the image repository name;
otherwise a generic container glyph tinted by a stable hash of the image name. Status pills, port chips (clickable),
CPU/memory mini bars from stats. Both themes; keep density.

### 6.8 v0.1.5: Marketplace (one-click apps & stacks)

Users pick a curated app or stack (e.g. Elasticsearch + Kibana, Postgres + pgAdmin), the app installs it with Docker
Compose on the selected profile and then shows local URLs, usernames, passwords and connection strings.

**Catalog (source of truth: `catalog/` in this repo).**
```
catalog/
  README.md               authoring guide + attribution rules
  schema.json             JSON Schema for app.json
  NOTICE                  third-party attributions (Apache-2.0 / MIT / CC0 sources)
  apps/<id>/app.json      metadata (below)
  apps/<id>/compose.yml   docker compose file using ${VAR} interpolation only for declared variables
  dist/catalog.json       GENERATED by `npm run catalog:build` (scripts/build-catalog.mjs); committed
```
`dist/catalog.json` = `{ schemaVersion: 1, generatedAt, items: CatalogItem[] }` where each item is app.json plus
`compose` (the compose.yml text). The backend embeds it (`include_str!`) as the built-in catalog and refreshes from
`https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/catalog/dist/catalog.json` (reqwest, 10 s
timeout, cache in app cache dir for 6 h, stale cache on error, built-in fallback; ignore remote with a different
`schemaVersion`). CI: `catalog:build` must be up to date (`git diff --exit-code catalog/dist`) and every item must pass
`docker compose config` after rendering with dummy values; lightweight items are also `up`-tested on Ubuntu.

`app.json` (camelCase):
```jsonc
{
  "id": "elasticsearch-kibana",               // ^[a-z0-9][a-z0-9-]*$, = folder name
  "name": "Elasticsearch + Kibana",
  "description": "One or two sentences.",
  "category": "search",                       // search|database|messaging|monitoring|storage|auth|devtools|ai
  "tags": ["elk", "logs"],
  "icon": "elasticsearch",                    // simple-icons slug; unknown → generic glyph
  "website": "https://www.elastic.co",
  "source": { "name": "docker/awesome-compose", "url": "https://…", "license": "CC0-1.0" }, // provenance/attribution
  "architectures": ["amd64", "arm64"],        // verified against the pinned image manifests
  "minMemoryMB": 3072,                        // VM memory recommended
  "variables": [
    { "name": "ELASTIC_PASSWORD", "type": "password", "label": "elastic password", "length": 24 },
    { "name": "ES_PORT", "type": "port", "label": "Elasticsearch port", "default": 9200 },
    { "name": "KIBANA_PORT", "type": "port", "label": "Kibana port", "default": 5601 },
    { "name": "PG_USER", "type": "string", "label": "User", "default": "app" },
    { "name": "KIBANA_SYSTEM_PASSWORD", "type": "password", "hidden": true }   // internal, not shown by default
  ],
  "endpoints": [
    { "name": "Kibana", "url": "http://localhost:${KIBANA_PORT}", "username": "elastic", "password": "${ELASTIC_PASSWORD}", "primary": true },
    { "name": "Elasticsearch API", "url": "http://localhost:${ES_PORT}", "username": "elastic", "password": "${ELASTIC_PASSWORD}" },
    { "name": "Connection string", "value": "postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/app" }
  ],
  "preflight": [ { "type": "sysctl", "key": "vm.max_map_count", "min": 262144 } ],
  "ready": { "type": "http", "url": "http://localhost:${KIBANA_PORT}/api/status", "expectStatus": [200, 401], "timeoutSec": 240 },
             // or { "type": "healthy", "timeoutSec": 120 }  (all services with healthchecks report healthy)
             // or { "type": "running", "timeoutSec": 60 }
  "notes": "Optional short text shown after install."
}
```
Rules: images pinned to explicit stable tags (no `latest`, no Bitnami), official upstream images, multi-arch
(amd64+arm64). Every published port uses a `port` variable; bind to `127.0.0.1` (`"127.0.0.1:${X_PORT}:80"`).
Named volumes only (no host bind mounts). Passwords alphanumeric (URL/YAML-safe). No `container_name` (lets
multiple instances coexist).

**Backend (new module `src-tauri/src/marketplace.rs`; all compose calls reuse `compose.rs`).**
Instances live in `<app_data_dir>/marketplace/<profile>/<projectName>/` with `compose.yml`, `.env` (mode 0600, all
variable values + `COMPOSE_PROJECT_NAME`) and `instance.json` (`{ itemId, name, icon, projectName, createdAt,
catalogGeneratedAt, values }`). Project name default `cd-<id>` (suffix `-2`, `-3` … if taken), validated like §6.7.
| Command | Args | Returns | Implementation |
|---|---|---|---|
| `marketplace_catalog` | `forceRefresh` | `{ items: CatalogItem[], source: "remote"\|"cache"\|"builtin", fetchedAt: string\|null, error: string\|null }` | as above |
| `marketplace_prepare` | `profile, itemId` | `{ projectName, variables: { name, label, type, value, hidden }[], preflight: PreflightResult[] }` | generate passwords (CSPRNG, alphanumeric), allocate ports: default if free else next free ≥ default (free = not bound on host 127.0.0.1/0.0.0.0, not published by any docker container, not reserved by another instance); run preflight |
| `marketplace_preflight` | `profile, itemId` | `PreflightResult[]` = `{ id, ok, severity: "error"\|"warning", message, fixable }` | checks: VM arch ∈ architectures (error), VM memory ≥ minMemoryMB (warning), each `sysctl` via `colima ssh -p <p> -- sysctl -n <key>` (error, fixable), compose available (error) |
| `marketplace_fix_preflight` | `profile, checkId` | `void` | sysctl: `colima ssh -p <p> -- sudo sysctl -w key=value` and persist via `/etc/sysctl.d/99-colima-desktop.conf` in the VM |
| `marketplace_install` | `profile, itemId, projectName, values: Record<string,string>` | `InstalledApp` | re-validate values (ports free, types), write files atomically, `compose up -d` (streamed as op `marketplace-install`, busy lock `compose:<project>`), then wait for `ready` (progress lines on the same op log); on ready-timeout return the app with `status: "starting"` plus a warning instead of failing |
| `marketplace_installed` | `profile` | `InstalledApp[]` | read instance dirs + `compose_projects` status |
| `marketplace_uninstall` | `profile, projectName, removeVolumes` | `void` | `compose down [-v] --remove-orphans`, then delete the instance dir |
`InstalledApp = { projectName, itemId, name, icon, createdAt, status: string /* compose status or "missing" */, endpoints:
{ name, url: string|null, value: string|null, username: string|null, password: string|null, primary: boolean }[], notes: string|null }`
(endpoint templates rendered with the instance values). Passwords are local dev secrets: stored in the 0600 `.env`, returned
only by `marketplace_installed`/`marketplace_install`, never logged.

**UI.** New sidebar item **Marketplace** (between Volumes and Kubernetes), tabs **Browse** / **Installed (N)**.
Browse: search, category chips, responsive card grid (icon, name, description, category, arch/memory badges,
"Installed" badge). Card → detail drawer (description, services & images, ports, source + license attribution, compose
preview read-only) with **Install**. Install dialog: project name, variables (passwords shown masked with reveal +
regenerate; ports editable with conflict hint), preflight list (✓ / ⚠ / ✗ with **Fix** buttons), Install → progress (reuse
Output dock) → **Ready card**: every endpoint as a row with Open (URL), Copy username, Copy/Reveal password, Copy value
(connection strings), plus notes. Installed: cards with live status, Open primary endpoint, Credentials (same Ready view),
Stop / Start / Restart (compose_action), Uninstall (confirm, "also delete data volumes"). Both themes, consistent with the
Containers/Kubernetes pages.

Logo: `public/logo.svg` (transparent background, brand green, works on dark & light) is used in the sidebar header and README.

Toasts for errors/success (simple self-made toast stack). Confirm dialogs for destructive ops. Keyboard: `Cmd/Ctrl+K` focuses search on list pages.
Do not use `window.confirm`/`alert` (not reliable in webviews) — use in-app dialogs.

### 6.9 v0.2.2: Dependencies

`Dep { name, required, installed, linked: boolean | null, version, purpose, fix: { label, command[] } | null }` for colima, docker,
docker-compose, kubectl (required) and qemu (optional: only for `vmType: qemu` / x86_64 emulation without Rosetta). Detection: binary on the
resolved PATH (`docker-compose` also counts as the `docker compose` plugin; qemu is detected by `qemu-img`). On macOS with Homebrew, a formula
that `brew list --formula` reports but whose binary is not on PATH is `installed: true, linked: false` with fix `brew link <formula>`; a missing one
gets `brew install <formula>` (kubectl uses `kubernetes-cli`). No Homebrew or Linux: `fix: null` and `purpose` carries the hint. `deps_fix` only runs
commands built by `deps_check` (the `name` is a lookup key, never a command). UI: Setup page lists all deps with Fix buttons; the Machines page shows a
banner for required deps that are missing/unlinked ("Fix all" runs fixes sequentially); the config editor warns when `vmType` is `qemu` and QEMU is absent
(Install QEMU / Use vz). New machines seeded from the builtin or user template get `vmType: vz` (macOS only) and `arch: host` in `profile_config_raw`
(line edits, comments preserved). `colima start` failing with "qemu-img not found" is mapped to a friendly message.

## 7. Build & run

- `npm install`, `npm run tauri dev`, `npm run tauri build`.
- Linux build deps documented in README (webkit2gtk-4.1, libayatana-appindicator3, librsvg2, etc.).
- README (Turkish + English short) with features, requirements, dev/build instructions.
