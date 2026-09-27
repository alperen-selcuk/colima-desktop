// Typed wrappers over Tauri's invoke()/listen(). MUST match docs/SPEC.md §4 exactly:
// command names, camelCase arg names, and event names (`colima-op-log`, `log-line`,
// `log-end`, `profiles-changed`).
import type {
  Container,
  ContainerStats,
  EnvInfo,
  Image,
  K8sDeployment,
  K8sKind,
  K8sNode,
  K8sPod,
  K8sService,
  LogEnd,
  LogEvent,
  LogTarget,
  OpLog,
  Profile,
  ProfileConfig,
  ConfigIssue,
  ProfileConfigRaw,
  ProfileStatus,
  PruneTarget,
  RunOptions,
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
    case "start_profile":
    case "stop_profile":
    case "restart_profile":
    case "delete_profile":
    case "kubernetes_action":
      return undefined as unknown as T;
    case "busy_profiles":
      return [] as unknown as T;
    case "list_containers":
      return mock.mockContainers as unknown as T;
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
      return "Total reclaimed space: 0B" as unknown as T;
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
    case "start_log_stream":
      return "mock-stream-id" as unknown as T;
    case "stop_log_stream":
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
// Public API — one function per IPC command in docs/SPEC.md §4
// ---------------------------------------------------------------------------

export function envInfo(): Promise<EnvInfo> {
  return invoke<EnvInfo>("env_info");
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

export function startLogStream(profile: string, target: LogTarget): Promise<string> {
  return invoke<string>("start_log_stream", { profile, target });
}

export function stopLogStream(streamId: string): Promise<void> {
  return invoke<void>("stop_log_stream", { streamId });
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
