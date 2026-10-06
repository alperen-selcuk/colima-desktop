// Typed wrappers over Tauri's invoke()/listen(). MUST match docs/SPEC.md §4 exactly:
// command names, camelCase arg names, and event names (`colima-op-log`, `log-line`,
// `log-end`, `profiles-changed`).
import type {
  CatalogResponse,
  ComposeActionKind,
  ComposeInfo,
  Dep,
  ComposePreview,
  ComposeProject,
  ComposePullPolicy,
  Container,
  ContainerStats,
  EnvInfo,
  HostKubeconfigHealth,
  Image,
  InstalledApp,
  K3sVersionsResponse,
  KubeconfigInfo,
  OpEnd,
  K8sConfigMap,
  K8sDeployment,
  K8sIngress,
  K8sKind,
  K8sNamespacedKind,
  K8sNode,
  K8sPod,
  K8sSecret,
  K8sService,
  LogEnd,
  LogEvent,
  LogTarget,
  MarketplacePrepareResult,
  NodeMetrics,
  OpLog,
  PodMetrics,
  PreflightResult,
  Profile,
  ProfileConfig,
  ConfigIssue,
  DiskInfo,
  ProfileConfigRaw,
  ProfileStatus,
  PruneTarget,
  RepairResult,
  RunOptions,
  SecretValue,
  StartOptions,
  TerminalExit,
  TerminalOutput,
  TerminalTarget,
  Volume,
} from "./types";

// ---------------------------------------------------------------------------
// Tauri detection + lazy-loaded real invoke/listen, with a dev-only mock
// fallback so `npm run dev` renders in a plain browser too.
// ---------------------------------------------------------------------------

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
type UnlistenFn = () => void;
type ListenFn = <T>(event: string, handler: (event: { payload: T }) => void) => Promise<UnlistenFn>;

let realInvoke: InvokeFn | null = null;
let realListen: ListenFn | null = null;

async function getReal(): Promise<{ invoke: InvokeFn; listen: ListenFn }> {
  if (!realInvoke || !realListen) {
    const core = await import("@tauri-apps/api/core");
    const event = await import("@tauri-apps/api/event");
    realInvoke = core.invoke as InvokeFn;
    realListen = event.listen as unknown as ListenFn;
  }
  return { invoke: realInvoke, listen: realListen };
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauriRuntime()) {
    const { invoke: real } = await getReal();
    return real<T>(cmd, args);
  }
  const mock = await import("./mock");
  return mockInvoke<T>(cmd, args, mock);
}

// Mock-mode event bus: lets the dev-only mock backend (below) actually emit
// events (e.g. terminal echo) that mock `listen` subscribers receive.
const mockBus = new EventTarget();

function mockEmit<T>(event: string, payload: T): void {
  mockBus.dispatchEvent(new CustomEvent(event, { detail: payload }));
}

export async function listen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  if (isTauriRuntime()) {
    const { listen: real } = await getReal();
    return real<T>(event, (e) => handler(e.payload));
  }
  const wrapped = (e: Event) => handler((e as CustomEvent<T>).detail);
  mockBus.addEventListener(event, wrapped);
  return () => mockBus.removeEventListener(event, wrapped);
}

// ---------------------------------------------------------------------------
// Dev-mode mock invoke: minimal, representative responses per command so all
// pages render without the Rust backend.
// ---------------------------------------------------------------------------

async function mockInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: typeof import("./mock"),
): Promise<T> {
  const profile = (args?.profile as string) ?? "default";
  await new Promise((r) => setTimeout(r, 120));

  switch (cmd) {
    case "env_info":
      return mock.mockEnvInfo as unknown as T;
    case "deps_check":
      return mock.mockDeps as unknown as T;
    case "deps_fix":
      return mock.mockDeps as unknown as T;
    case "list_profiles":
      return mock.mockProfiles as unknown as T;
    case "profile_status":
      return (mock.mockProfileStatus[profile] ?? null) as unknown as T;
    case "profile_config":
      return (mock.mockProfileConfig[profile] ?? null) as unknown as T;
    case "profile_config_raw":
      return mock.mockProfileConfigRaw(profile) as unknown as T;
    case "save_profile_config_raw":
      return undefined as unknown as T;
    case "validate_profile_config_raw":
      return mock.mockValidateProfileConfigRaw(args?.content as string) as unknown as T;
    case "k3s_versions":
      return mock.mockK3sVersions as unknown as T;
    case "start_profile":
    case "stop_profile":
    case "restart_profile":
    case "delete_profile":
    case "kubernetes_action":
      return undefined as unknown as T;
    case "profile_disk_info":
      return { exists: true, sizeGiB: 40, usedOnHostBytes: 12 * 1024 ** 3 } as unknown as T;
    case "recreate_profile":
    case "reclaim_space":
      return undefined as unknown as T;
    case "busy_profiles":
      return [] as unknown as T;
    case "list_containers":
      return mock.mockContainers as unknown as T;
    case "compose_info":
      return mock.mockComposeInfo as unknown as T;
    case "compose_projects":
      return mock.mockComposeProjects as unknown as T;
    case "compose_preview":
      return mock.mockComposePreview(args?.files as string[], args?.projectName as string | null) as unknown as T;
    case "compose_up":
    case "compose_action":
      return undefined as unknown as T;
    case "container_action":
      return undefined as unknown as T;
    case "container_inspect":
      return { Id: args?.id, Config: {}, State: { Status: "running" }, NetworkSettings: {} } as unknown as T;
    case "container_stats":
      return mock.mockContainerStats as unknown as T;
    case "run_container":
      return "mock-container-id" as unknown as T;
    case "list_images":
      return mock.mockImages as unknown as T;
    case "remove_image":
    case "pull_image":
      return undefined as unknown as T;
    case "list_volumes":
      return mock.mockVolumes as unknown as T;
    case "remove_volume":
      return undefined as unknown as T;
    case "prune":
      return "Deleted Volumes:\nsetur-nuget\n\nTotal reclaimed space: 0B" as unknown as T;
    case "k8s_namespaces":
      return ["default", "kube-system"] as unknown as T;
    case "k8s_pods":
      return mock.mockK8sPods as unknown as T;
    case "k8s_deployments":
      return mock.mockK8sDeployments as unknown as T;
    case "k8s_services":
      return mock.mockK8sServices as unknown as T;
    case "k8s_nodes":
      return mock.mockK8sNodes as unknown as T;
    case "k8s_describe":
      return `Name: ${args?.name}\nNamespace: ${args?.namespace}\n(mock describe output)` as unknown as T;
    case "k8s_delete_pod":
    case "k8s_scale":
    case "k8s_restart_deployment":
      return undefined as unknown as T;
    case "k8s_yaml":
      return `apiVersion: v1\nkind: ${args?.kind}\nmetadata:\n  name: ${args?.name}\n` as unknown as T;
    case "k8s_configmaps":
      return mock.mockK8sConfigMaps as unknown as T;
    case "k8s_secrets":
      return mock.mockK8sSecrets as unknown as T;
    case "k8s_secret_value":
      return mock.mockK8sSecretValue(args?.name as string, args?.key as string) as unknown as T;
    case "k8s_ingresses":
      return mock.mockK8sIngresses as unknown as T;
    case "k8s_delete":
      return undefined as unknown as T;
    case "k8s_edit_yaml":
      return mock.mockK8sEditYaml(args?.kind as string, args?.namespace as string | null, args?.name as string) as unknown as T;
    case "k8s_apply_yaml":
      return mock.mockK8sApplyYaml(args?.dryRun as boolean) as unknown as T;
    case "k8s_pod_metrics":
      return mock.mockPodMetrics as unknown as T;
    case "k8s_node_metrics":
      return mock.mockNodeMetrics as unknown as T;
    case "host_kubeconfig_health":
      return mock.mockHostKubeconfigHealth(profile) as unknown as T;
    case "k8s_kubeconfig":
      return mock.mockKubeconfigInfo(profile) as unknown as T;
    case "k8s_export_kubeconfig":
      return (args?.path as string) as unknown as T;
    case "k8s_merge_kubeconfig":
    case "repair_host_kubeconfig":
      return mock.mockRepairHostKubeconfig() as unknown as T;
    case "start_log_stream":
      return mockStartLogStream(args?.target as LogTarget) as unknown as T;
    case "stop_log_stream":
      mockStopLogStream(args?.streamId as string);
      return undefined as unknown as T;
    case "terminal_open":
      return mockTerminalOpen(args?.target as TerminalTarget) as unknown as T;
    case "terminal_write":
      mockTerminalWrite(args?.sessionId as string, args?.data as string);
      return undefined as unknown as T;
    case "terminal_resize":
      return undefined as unknown as T;
    case "terminal_close":
      mockTerminalSessions.delete(args?.sessionId as string);
      return undefined as unknown as T;
    // ---- §6.8: Marketplace ----
    case "marketplace_catalog":
      return mock.mockMarketplaceCatalog() as unknown as T;
    case "marketplace_prepare":
      return mock.mockMarketplacePrepare(args?.itemId as string) as unknown as T;
    case "marketplace_preflight":
      return mock.mockMarketplacePreflight(args?.itemId as string) as unknown as T;
    case "marketplace_fix_preflight":
      mock.mockMarketplaceFixPreflight(args?.checkId as string);
      return undefined as unknown as T;
    case "marketplace_install":
      return mockMarketplaceInstall(
        args?.profile as string,
        args?.itemId as string,
        args?.projectName as string,
        args?.values as Record<string, string>,
      ) as unknown as T;
    case "marketplace_installed":
      return mock.mockMarketplaceInstalled() as unknown as T;
    case "marketplace_uninstall":
      mock.mockMarketplaceUninstall(args?.projectName as string);
      return undefined as unknown as T;
    default:
      throw new Error(`mock invoke: unhandled command "${cmd}"`);
  }
}

// ---------------------------------------------------------------------------
// Dev-mode mock terminal: echoes typed input back so the dock is testable
// with `npm run dev` in a plain browser (no real PTY backend).
// ---------------------------------------------------------------------------

const mockTerminalSessions = new Set<string>();
let mockSessionCounter = 0;

function targetLabel(target: TerminalTarget): string {
  switch (target.kind) {
    case "host":
      return "local shell";
    case "vm":
      return "colima VM";
    case "container":
      return `container ${target.id.slice(0, 12)}`;
    case "pod":
      return `pod ${target.namespace}/${target.pod}`;
  }
}

function toBase64(text: string): string {
  return window.btoa(unescape(encodeURIComponent(text)));
}

function mockTerminalOpen(target: TerminalTarget): string {
  const sessionId = `mock-session-${++mockSessionCounter}`;
  mockTerminalSessions.add(sessionId);
  const banner = `Connected to ${targetLabel(target)} (mock terminal — no backend attached)\r\n$ `;
  // Emit asynchronously so a listener registered right after invoke() still catches it.
  setTimeout(() => {
    if (mockTerminalSessions.has(sessionId)) {
      mockEmit<TerminalOutput>("terminal-output", { sessionId, data: toBase64(banner) });
    }
  }, 30);
  return sessionId;
}

function mockTerminalWrite(sessionId: string, data: string): void {
  if (!mockTerminalSessions.has(sessionId)) return;
  // Echo each character back; turn CR into a fresh prompt line.
  let out = "";
  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      out += "\r\n$ ";
    } else {
      out += ch;
    }
  }
  setTimeout(() => {
    if (mockTerminalSessions.has(sessionId)) {
      mockEmit<TerminalOutput>("terminal-output", { sessionId, data: toBase64(out) });
    }
  }, 10);
}

// ---------------------------------------------------------------------------
// Dev-mode mock log streams: containers/pods emit nothing today (no backend
// process to tail), but a compose target (§6.7) gets a handful of fake
// interleaved "<service>-1 | ..." lines — real `compose logs -f` prefixes
// each line with its service/container name the same way — so the
// Containers page's compose "Logs" tab has something to show in `npm run dev`.
// ---------------------------------------------------------------------------

const mockLogStreams = new Set<string>();
let mockStreamCounter = 0;

const COMPOSE_MOCK_LINES: { service: string; line: string }[] = [
  { service: "web-1", line: "Listening on port 80" },
  { service: "db-1", line: "database system is ready to accept connections" },
  { service: "web-1", line: "GET / 200 12ms" },
  { service: "app-1", line: "Connected to db:5432" },
  { service: "db-1", line: "checkpoint starting: time" },
  { service: "web-1", line: "GET /health 200 1ms" },
  { service: "app-1", line: "Worker ready" },
];

function mockStartLogStream(target: LogTarget): string {
  const streamId = `mock-stream-${++mockStreamCounter}`;
  mockLogStreams.add(streamId);
  if (target.kind === "compose") {
    COMPOSE_MOCK_LINES.forEach((entry, i) => {
      setTimeout(
        () => {
          if (!mockLogStreams.has(streamId)) return;
          mockEmit<LogEvent>("log-line", {
            streamId,
            line: `${entry.service}  | ${entry.line}`,
            stream: "stdout",
          });
        },
        60 + i * 90,
      );
    });
  }
  return streamId;
}

function mockStopLogStream(streamId: string): void {
  mockLogStreams.delete(streamId);
}

// ---------------------------------------------------------------------------
// Dev-mode mock Marketplace install (§6.8): streams a handful of
// `colima-op-log` lines under op "marketplace-install" so the Install
// dialog's step indicator and the Output dock both have something to show in
// `npm run dev`, then resolves with a fabricated `InstalledApp` built from
// the chosen catalog item + submitted values (mirrors what the real backend
// would return from `compose up -d` + the ready check).
// ---------------------------------------------------------------------------

const MOCK_INSTALL_STEPS = ["Writing files…", "Starting containers…", "Waiting until ready…", "Ready"];

async function mockMarketplaceInstall(
  profile: string,
  itemId: string,
  projectName: string,
  values: Record<string, string>,
): Promise<InstalledApp> {
  const mock = await import("./mock");
  for (let i = 0; i < MOCK_INSTALL_STEPS.length; i++) {
    await new Promise((r) => setTimeout(r, 220));
    mockEmit<OpLog>("colima-op-log", { profile, op: "marketplace-install", line: MOCK_INSTALL_STEPS[i] });
  }
  return mock.mockMarketplaceInstallResult(itemId, projectName, values);
}

// ---------------------------------------------------------------------------
// Public API — one function per IPC command in docs/SPEC.md §4
// ---------------------------------------------------------------------------

export function envInfo(): Promise<EnvInfo> {
  return invoke<EnvInfo>("env_info");
}

/** Dependency doctor (§6.9). */
export function depsCheck(): Promise<Dep[]> {
  return invoke<Dep[]>("deps_check");
}

/** Runs the allowlisted fix for one dependency (streams op `deps` into the Output dock), then re-checks. */
export function depsFix(name: string): Promise<Dep[]> {
  return invoke<Dep[]>("deps_fix", { name });
}

export function listProfiles(): Promise<Profile[]> {
  return invoke<Profile[]>("list_profiles");
}

export function profileStatus(profile: string): Promise<ProfileStatus | null> {
  return invoke<ProfileStatus | null>("profile_status", { profile });
}

export function profileConfig(profile: string): Promise<ProfileConfig | null> {
  return invoke<ProfileConfig | null>("profile_config", { profile });
}

export function startProfile(profile: string, options: StartOptions): Promise<void> {
  return invoke<void>("start_profile", { profile, options });
}

export function stopProfile(profile: string, force: boolean): Promise<void> {
  return invoke<void>("stop_profile", { profile, force });
}

export function restartProfile(profile: string): Promise<void> {
  return invoke<void>("restart_profile", { profile });
}

export function deleteProfile(profile: string): Promise<void> {
  return invoke<void>("delete_profile", { profile });
}

export function profileDiskInfo(profile: string): Promise<DiskInfo> {
  return invoke<DiskInfo>("profile_disk_info", { profile });
}

/** Delete + recreate the machine with `configContent` (the only way to shrink a disk). Streams as op "recreate". */
export function recreateProfile(profile: string, configContent: string): Promise<void> {
  return invoke<void>("recreate_profile", { profile, configContent });
}

/** `docker system prune -af` + `fstrim` inside the VM. Streams as op "reclaim". */
export function reclaimSpace(profile: string): Promise<void> {
  return invoke<void>("reclaim_space", { profile });
}

export function kubernetesAction(
  profile: string,
  action: "start" | "stop" | "reset" | "delete",
): Promise<void> {
  return invoke<void>("kubernetes_action", { profile, action });
}

export function busyProfiles(): Promise<string[]> {
  return invoke<string[]>("busy_profiles");
}

export function profileConfigRaw(profile: string): Promise<ProfileConfigRaw> {
  return invoke<ProfileConfigRaw>("profile_config_raw", { profile });
}

export function saveProfileConfigRaw(profile: string, content: string): Promise<void> {
  return invoke<void>("save_profile_config_raw", { profile, content });
}

/** Live validation for the raw YAML editor: mirrors the typed checks
 * `save_profile_config_raw` enforces server-side (§6.4), without writing
 * anything. Call this debounced as the user types. */
export function validateProfileConfigRaw(content: string): Promise<ConfigIssue[]> {
  return invoke<ConfigIssue[]>("validate_profile_config_raw", { content });
}

/** k3s version picker (§6.5): fetches the list of k3s releases (GitHub, on-disk
 * cache, or the embedded builtin list), plus colima's own parsed default. */
export function k3sVersions(forceRefresh: boolean): Promise<K3sVersionsResponse> {
  return invoke<K3sVersionsResponse>("k3s_versions", { forceRefresh });
}

export function listContainers(profile: string): Promise<Container[]> {
  return invoke<Container[]>("list_containers", { profile });
}

export function containerAction(
  profile: string,
  id: string,
  action: "start" | "stop" | "restart" | "pause" | "unpause" | "kill" | "remove",
): Promise<void> {
  return invoke<void>("container_action", { profile, id, action });
}

export function containerInspect(profile: string, id: string): Promise<unknown> {
  return invoke<unknown>("container_inspect", { profile, id });
}

export function containerStats(profile: string): Promise<ContainerStats[]> {
  return invoke<ContainerStats[]>("container_stats", { profile });
}

export function runContainer(profile: string, options: RunOptions): Promise<string> {
  return invoke<string>("run_container", { profile, options });
}

export function listImages(profile: string): Promise<Image[]> {
  return invoke<Image[]>("list_images", { profile });
}

export function removeImage(profile: string, id: string, force: boolean): Promise<void> {
  return invoke<void>("remove_image", { profile, id, force });
}

export function pullImage(profile: string, reference: string): Promise<void> {
  return invoke<void>("pull_image", { profile, reference });
}

export function listVolumes(profile: string): Promise<Volume[]> {
  return invoke<Volume[]>("list_volumes", { profile });
}

export function removeVolume(profile: string, name: string): Promise<void> {
  return invoke<void>("remove_volume", { profile, name });
}

export function prune(profile: string, what: PruneTarget): Promise<string> {
  return invoke<string>("prune", { profile, what });
}

export function k8sNamespaces(profile: string): Promise<string[]> {
  return invoke<string[]>("k8s_namespaces", { profile });
}

export function k8sPods(profile: string, namespace: string | null): Promise<K8sPod[]> {
  return invoke<K8sPod[]>("k8s_pods", { profile, namespace });
}

export function k8sDeployments(profile: string, namespace: string | null): Promise<K8sDeployment[]> {
  return invoke<K8sDeployment[]>("k8s_deployments", { profile, namespace });
}

export function k8sServices(profile: string, namespace: string | null): Promise<K8sService[]> {
  return invoke<K8sService[]>("k8s_services", { profile, namespace });
}

export function k8sNodes(profile: string): Promise<K8sNode[]> {
  return invoke<K8sNode[]>("k8s_nodes", { profile });
}

export function k8sDescribe(
  profile: string,
  kind: K8sKind,
  namespace: string | null,
  name: string,
): Promise<string> {
  return invoke<string>("k8s_describe", { profile, kind, namespace, name });
}

export function k8sDeletePod(profile: string, namespace: string, name: string): Promise<void> {
  return invoke<void>("k8s_delete_pod", { profile, namespace, name });
}

export function k8sScale(
  profile: string,
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  return invoke<void>("k8s_scale", { profile, namespace, name, replicas });
}

export function k8sRestartDeployment(profile: string, namespace: string, name: string): Promise<void> {
  return invoke<void>("k8s_restart_deployment", { profile, namespace, name });
}

export function k8sYaml(
  profile: string,
  kind: K8sKind,
  namespace: string | null,
  name: string,
): Promise<string> {
  return invoke<string>("k8s_yaml", { profile, kind, namespace, name });
}

// ---- §6.6: ConfigMaps, Secrets, Ingresses, delete/edit, resource usage ----

export function k8sConfigMaps(profile: string, namespace: string | null): Promise<K8sConfigMap[]> {
  return invoke<K8sConfigMap[]>("k8s_configmaps", { profile, namespace });
}

export function k8sSecrets(profile: string, namespace: string | null): Promise<K8sSecret[]> {
  return invoke<K8sSecret[]>("k8s_secrets", { profile, namespace });
}

/** Explicit reveal of ONE secret key's value (never fetched in bulk). */
export function k8sSecretValue(
  profile: string,
  namespace: string,
  name: string,
  key: string,
): Promise<SecretValue> {
  return invoke<SecretValue>("k8s_secret_value", { profile, namespace, name, key });
}

export function k8sIngresses(profile: string, namespace: string | null): Promise<K8sIngress[]> {
  return invoke<K8sIngress[]>("k8s_ingresses", { profile, namespace });
}

/** Delete any namespaced object (pod/deployment/service/configmap/secret/
 * ingress). The backend rejects `kind: "node"` — nodes are read-only. */
export function k8sDelete(
  profile: string,
  kind: K8sNamespacedKind,
  namespace: string | null,
  name: string,
): Promise<void> {
  return invoke<void>("k8s_delete", { profile, kind, namespace, name });
}

/** Fetches the object's YAML for the Edit dialog: `managedFields`/`status`
 * stripped, `resourceVersion` kept so a conflicting concurrent edit can be
 * detected on save. */
export function k8sEditYaml(
  profile: string,
  kind: K8sNamespacedKind,
  namespace: string | null,
  name: string,
): Promise<string> {
  return invoke<string>("k8s_edit_yaml", { profile, kind, namespace, name });
}

/** "Validate" (dryRun: true) or "Save" (dryRun: false) in the Edit dialog.
 * Content is sent as-is (kubectl reads it on stdin server-side — never
 * written to a temp file, since it may contain secret values). Returns the
 * kubectl output shown inline on success. */
export function k8sApplyYaml(
  profile: string,
  kind: K8sNamespacedKind,
  namespace: string | null,
  name: string,
  content: string,
  dryRun: boolean,
): Promise<string> {
  return invoke<string>("k8s_apply_yaml", { profile, kind, namespace, name, content, dryRun });
}

/** `available: false` (with `reason`) when metrics-server isn't installed or
 * ready — callers should show a subtle note and render "—" in usage columns
 * rather than treating it as a hard error. */
export function k8sPodMetrics(profile: string, namespace: string | null): Promise<PodMetrics> {
  return invoke<PodMetrics>("k8s_pod_metrics", { profile, namespace });
}

export function k8sNodeMetrics(profile: string): Promise<NodeMetrics> {
  return invoke<NodeMetrics>("k8s_node_metrics", { profile });
}

/** Terminal kubectl health (§2.1a): compares the user's real `~/.kube/config`
 * (or `$KUBECONFIG`) colima entries against the app-managed kubeconfig. */
export function hostKubeconfigHealth(profile: string): Promise<HostKubeconfigHealth> {
  return invoke<HostKubeconfigHealth>("host_kubeconfig_health", { profile });
}

/** Repairs ONLY the `users.<ctx>`/`clusters.<ctx>` entries in the user's real
 * kubeconfig, after writing a timestamped backup (§2.1a). Only ever called
 * after an explicit user confirmation. */
export function repairHostKubeconfig(profile: string): Promise<RepairResult> {
  return invoke<RepairResult>("repair_host_kubeconfig", { profile });
}

/** App-managed kubeconfig content + context + API server (refreshed first). */
export function k8sKubeconfig(profile: string): Promise<KubeconfigInfo> {
  return invoke<KubeconfigInfo>("k8s_kubeconfig", { profile });
}

/** Writes the app-managed kubeconfig to `path` (mode 0600). Returns the path written. */
export function k8sExportKubeconfig(profile: string, path: string): Promise<string> {
  return invoke<string>("k8s_export_kubeconfig", { profile, path });
}

/** Merges the colima user/cluster/context entries into the user's kubeconfig (backup first). */
export function k8sMergeKubeconfig(profile: string): Promise<RepairResult> {
  return invoke<RepairResult>("k8s_merge_kubeconfig", { profile });
}

export function startLogStream(profile: string, target: LogTarget): Promise<string> {
  return invoke<string>("start_log_stream", { profile, target });
}

export function stopLogStream(streamId: string): Promise<void> {
  return invoke<void>("stop_log_stream", { streamId });
}

// ---- §6.7: Docker Compose ----

export function composeInfo(profile: string): Promise<ComposeInfo> {
  return invoke<ComposeInfo>("compose_info", { profile });
}

export function composeProjects(profile: string): Promise<ComposeProject[]> {
  return invoke<ComposeProject[]>("compose_projects", { profile });
}

/** Validates the given compose file(s) and returns the resolved service
 * list (image, whether it's built locally, published ports) without
 * starting anything. Errors from a malformed compose file are returned
 * verbatim (noise stripped) by the backend, not thrown, when possible;
 * callers should still be ready to catch a rejected promise for hard
 * failures (e.g. missing binary, files not found). */
export function composePreview(
  profile: string,
  files: string[],
  projectName: string | null,
): Promise<ComposePreview> {
  return invoke<ComposePreview>("compose_preview", { profile, files, projectName });
}

/** `compose up -d`; streams into `colima-op-log` with op `"compose-up"` —
 * same event the Output dock tab already renders. */
export function composeUp(
  profile: string,
  files: string[],
  projectName: string | null,
  build: boolean,
  pull: ComposePullPolicy,
  forceRecreate: boolean,
): Promise<void> {
  return invoke<void>("compose_up", { profile, files, projectName, build, pull, forceRecreate });
}

/** Stop / start / restart / down / pull an existing compose project.
 * `removeVolumes` only matters for `down` (adds `-v`). */
export function composeAction(
  profile: string,
  project: string,
  action: ComposeActionKind,
  configFiles: string[],
  removeVolumes: boolean,
): Promise<void> {
  return invoke<void>("compose_action", { profile, project, action, configFiles, removeVolumes });
}

// ---- §6.8: Marketplace ----

/** Fetches the catalog: remote (GitHub raw, 6h cache) with a stale-cache or
 * built-in fallback on error — see `CatalogResponse.source`/`error`. */
export function marketplaceCatalog(forceRefresh: boolean): Promise<CatalogResponse> {
  return invoke<CatalogResponse>("marketplace_catalog", { forceRefresh });
}

/** Prepares an install: generates passwords, allocates free ports (default
 * if free else next free), derives the default project name, and runs
 * preflight. Called when the Install dialog opens for a catalog item. */
export function marketplacePrepare(profile: string, itemId: string): Promise<MarketplacePrepareResult> {
  return invoke<MarketplacePrepareResult>("marketplace_prepare", { profile, itemId });
}

/** Re-runs preflight only (e.g. after "Fix" or after the user edits a port). */
export function marketplacePreflight(profile: string, itemId: string): Promise<PreflightResult[]> {
  return invoke<PreflightResult[]>("marketplace_preflight", { profile, itemId });
}

/** Applies the fix for one fixable preflight check (e.g. raises a sysctl in
 * the VM). Callers should re-run `marketplacePreflight` after this resolves. */
export function marketplaceFixPreflight(profile: string, checkId: string): Promise<void> {
  return invoke<void>("marketplace_fix_preflight", { profile, checkId });
}

/** Writes the instance files and runs `compose up -d`, streamed into
 * `colima-op-log` under op "marketplace-install" (same event the Output dock
 * already renders); waits for the item's `ready` check before resolving. */
export function marketplaceInstall(
  profile: string,
  itemId: string,
  projectName: string,
  values: Record<string, string>,
): Promise<InstalledApp> {
  return invoke<InstalledApp>("marketplace_install", { profile, itemId, projectName, values });
}

export function marketplaceInstalled(profile: string): Promise<InstalledApp[]> {
  return invoke<InstalledApp[]>("marketplace_installed", { profile });
}

/** `compose down [-v] --remove-orphans` then deletes the instance directory. */
export function marketplaceUninstall(profile: string, projectName: string, removeVolumes: boolean): Promise<void> {
  return invoke<void>("marketplace_uninstall", { profile, projectName, removeVolumes });
}

export function terminalOpen(
  profile: string | null,
  target: TerminalTarget,
  cols: number,
  rows: number,
): Promise<string> {
  return invoke<string>("terminal_open", { profile, target, cols, rows });
}

export function terminalWrite(sessionId: string, data: string): Promise<void> {
  return invoke<void>("terminal_write", { sessionId, data });
}

export function terminalResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke<void>("terminal_resize", { sessionId, cols, rows });
}

export function terminalClose(sessionId: string): Promise<void> {
  return invoke<void>("terminal_close", { sessionId });
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

export function onOpLog(handler: (payload: OpLog) => void): Promise<UnlistenFn> {
  return listen<OpLog>("colima-op-log", handler);
}

export function onOpEnd(handler: (payload: OpEnd) => void): Promise<UnlistenFn> {
  return listen<OpEnd>("colima-op-end", handler);
}

export function onLogLine(handler: (payload: LogEvent) => void): Promise<UnlistenFn> {
  return listen<LogEvent>("log-line", handler);
}

export function onLogEnd(handler: (payload: LogEnd) => void): Promise<UnlistenFn> {
  return listen<LogEnd>("log-end", handler);
}

export function onProfilesChanged(handler: () => void): Promise<UnlistenFn> {
  return listen<null>("profiles-changed", () => handler());
}

export function onTerminalOutput(handler: (payload: TerminalOutput) => void): Promise<UnlistenFn> {
  return listen<TerminalOutput>("terminal-output", handler);
}

export function onTerminalExit(handler: (payload: TerminalExit) => void): Promise<UnlistenFn> {
  return listen<TerminalExit>("terminal-exit", handler);
}

export { isTauriRuntime };
