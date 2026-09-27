// Types crossing the Tauri IPC boundary. MUST match docs/SPEC.md §3 exactly.

export interface EnvInfo {
  platform: "macos" | "linux" | string;
  arch: string;
  colimaVersion: string | null; // first line of `colima version`, e.g. "colima version 0.8.1"
  dockerAvailable: boolean;
  kubectlAvailable: boolean;
  limactlAvailable: boolean;
  path: string;
}

export interface Profile {
  // from `colima list --json` (one JSON object per line)
  name: string;
  status: string; // "Running" | "Stopped" | "Broken" | ...
  arch: string;
  cpus: number;
  memory: number; // bytes
  disk: number; // bytes
  runtime: string | null; // absent when stopped
  address: string | null;
}

export interface ProfileStatus {
  // from `colima status --json -p <p>`; null when not running
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
  memory: number; // bytes
  disk: number; // bytes
}

export interface ProfileConfig {
  // parsed from <colimaHome>/<profile>/colima.yaml (missing fields -> defaults)
  cpu: number;
  memory: number /* GiB */;
  disk: number /* GiB */;
  arch: string;
  runtime: string;
  vmType: string;
  mountType: string;
  rosetta: boolean;
  networkAddress: boolean;
  kubernetesEnabled: boolean;
  kubernetesVersion: string;
  mounts: string[]; // "location[:w]" strings
}

export interface StartOptions {
  // all optional; only provided fields become CLI flags
  cpu?: number;
  memory?: number;
  disk?: number;
  arch?: string;
  runtime?: string;
  vmType?: string;
  mountType?: string;
  kubernetes?: boolean;
  kubernetesVersion?: string;
  vzRosetta?: boolean;
  networkAddress?: boolean;
  activate?: boolean;
  mounts?: string[];
}

export interface Container {
  // from `docker ps -a --no-trunc --format '{{json .}}'`
  id: string;
  names: string;
  image: string;
  command: string;
  state: string; // running | exited | paused | created | restarting | dead
  status: string; // "Up 3 minutes"
  ports: string; // raw docker ports string
  portLinks: { hostPort: number; containerPort: number; protocol: string; url: string }[]; // parsed, tcp host-bound only, url = http://localhost:<hostPort>
  createdAt: string;
  runningFor: string;
  composeProject: string | null; // label com.docker.compose.project
  composeService: string | null; // label com.docker.compose.service
}

export interface ContainerStats {
  // `docker stats --no-stream --format '{{json .}}'`
  id: string;
  name: string;
  cpuPerc: string;
  memUsage: string;
  memPerc: string;
  netIO: string;
  blockIO: string;
  pids: string;
}

export interface Image {
  // `docker images --format '{{json .}}'`
  id: string;
  repository: string;
  tag: string;
  size: string;
  createdSince: string;
  createdAt: string;
  inUse: boolean; // true if any container (any state) uses this image id or repo:tag
}

export interface Volume {
  // `docker volume ls --format '{{json .}}'`
  name: string;
  driver: string;
  mountpoint: string;
  size: string | null;
}

export interface RunOptions {
  image: string;
  name?: string;
  ports?: string[]; // "8080:80", "127.0.0.1:5432:5432/tcp"
  env?: string[]; // "KEY=VALUE"
  volumes?: string[]; // "/host:/ctr[:ro]" or "vol:/ctr"
  command?: string; // split on whitespace honoring simple quotes (shell-words style)
  restart?: string; // no | always | unless-stopped | on-failure
  network?: string;
  autoRemove?: boolean; // --rm
}

export interface K8sPod {
  name: string;
  namespace: string;
  phase: string; // status.phase
  status: string; // display status à la `kubectl get pods`: waiting/terminated reason (CrashLoopBackOff, ImagePullBackOff, Completed...), "Terminating" if deletionTimestamp, else phase
  ready: string; // "1/2"
  restarts: number;
  createdAt: string; // ISO timestamp
  node: string | null;
  podIp: string | null;
  containers: string[];
}

export interface K8sDeployment {
  name: string;
  namespace: string;
  ready: string;
  upToDate: number;
  available: number;
  replicas: number;
  createdAt: string;
  images: string[];
}

export interface K8sService {
  name: string;
  namespace: string;
  type: string;
  clusterIp: string;
  externalIp: string | null;
  ports: string;
  createdAt: string;
}

export interface K8sNode {
  name: string;
  status: string;
  roles: string;
  version: string;
  internalIp: string | null;
  osImage: string;
  cpu: string;
  memory: string;
  createdAt: string;
}

export interface LogEvent {
  streamId: string;
  line: string;
  stream: "stdout" | "stderr";
}

export interface LogEnd {
  streamId: string;
  code: number | null;
}

export interface OpLog {
  profile: string;
  op: string;
  line: string;
}

export type ConfigSource = "profile" | "template" | "builtin";

export interface ProfileConfigRaw {
  content: string;
  source: ConfigSource;
  path: string;
  exists: boolean;
}

/** One problem found by `validate_profile_config_raw` / enforced by `save_profile_config_raw`.
 * `error` issues mean colima's own YAML unmarshal would fail on this field and colima would
 * silently ignore the whole file and start with defaults instead; `warning` issues are values
 * (typically enum-like fields) colima's unmarshal accepts as-is but doesn't recognize as documented. */
export type IssueSeverity = "error" | "warning";

export interface ConfigIssue {
  /** Dotted/bracketed path to the offending key, e.g. "network.dns[1]", or "" for the whole document. */
  path: string;
  message: string;
  severity: IssueSeverity;
}

export interface TerminalOutput {
  sessionId: string;
  data: string; // base64 of raw PTY bytes
}

export interface TerminalExit {
  sessionId: string;
  code: number | null;
}

// ---- Frontend-only helper union types (not part of the IPC boundary) ----

export type ContainerAction =
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "kill"
  | "remove";

export type KubernetesActionKind = "start" | "stop" | "reset" | "delete";

export type PruneTarget = "containers" | "images" | "volumes" | "system";

export type LogTarget =
  | { kind: "container"; id: string; tail: number }
  | { kind: "pod"; namespace: string; pod: string; container: string | null; tail: number };

export type TerminalTarget =
  | { kind: "host" }
  | { kind: "vm" }
  | { kind: "container"; id: string }
  | { kind: "pod"; namespace: string; pod: string; container: string | null };

export type K8sKind = "pod" | "deployment" | "service" | "node";

// ---- k3s version picker (§6.5) ----

export interface K3sVersion {
  version: string;
  minor: string; // "1.31"
  publishedAt: string | null;
  latestInMinor: boolean;
}

export type K3sVersionsSource = "github" | "cache" | "builtin";

export interface K3sVersionsResponse {
  versions: K3sVersion[];
  colimaDefault: string | null;
  source: K3sVersionsSource;
  fetchedAt: string | null;
  error: string | null;
}
