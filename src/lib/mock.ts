// Dev-only mock backend used when running `npm run dev` in a plain browser
// (i.e. outside the Tauri webview, where `__TAURI_INTERNALS__` is absent).
// Lets every page render with representative sample data for visual QA.
import type {
  ConfigIssue,
  Container,
  ContainerStats,
  EnvInfo,
  Image,
  K8sDeployment,
  K8sNode,
  K8sPod,
  K8sService,
  Profile,
  ProfileConfig,
  ProfileConfigRaw,
  ProfileStatus,
  Volume,
} from "./types";
// The real upstream Colima default template (see src-tauri/resources/colima-default.yaml
// for attribution), imported as raw text so `npm run dev` in a plain browser shows a
// fully populated machine configuration editor.
import upstreamDefaultYaml from "../../src-tauri/resources/colima-default.yaml?raw";

const now = Date.now();
const isoAgo = (ms: number) => new Date(now - ms).toISOString();

export const mockEnvInfo: EnvInfo = {
  platform: "macos",
  arch: "aarch64",
  colimaVersion: "colima version 0.8.1",
  dockerAvailable: true,
  kubectlAvailable: true,
  limactlAvailable: true,
  path: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
};

export const mockProfiles: Profile[] = [
  {
    name: "default",
    status: "Running",
    arch: "aarch64",
    cpus: 2,
    memory: 4 * 1024 * 1024 * 1024,
    disk: 100 * 1024 * 1024 * 1024,
    runtime: "docker",
    address: "192.168.106.2",
  },
  {
    name: "work",
    status: "Stopped",
    arch: "aarch64",
    cpus: 4,
    memory: 8 * 1024 * 1024 * 1024,
    disk: 200 * 1024 * 1024 * 1024,
    runtime: null,
    address: null,
  },
];

export const mockProfileStatus: Record<string, ProfileStatus | null> = {
  default: {
    displayName: "default",
    driver: "vz",
    arch: "aarch64",
    runtime: "docker",
    mountType: "virtiofs",
    ipAddress: "192.168.106.2",
    dockerSocket: "unix:///Users/dev/.colima/default/docker.sock",
    containerdSocket: null,
    kubernetes: true,
    cpu: 2,
    memory: 4 * 1024 * 1024 * 1024,
    disk: 100 * 1024 * 1024 * 1024,
  },
  work: null,
};

export const mockProfileConfig: Record<string, ProfileConfig> = {
  default: {
    cpu: 2,
    memory: 4,
    disk: 100,
    arch: "aarch64",
    runtime: "docker",
    vmType: "vz",
    mountType: "virtiofs",
    rosetta: true,
    networkAddress: true,
    kubernetesEnabled: true,
    kubernetesVersion: "v1.30.0",
    mounts: ["~:w", "/tmp/colima:w"],
  },
  work: {
    cpu: 4,
    memory: 8,
    disk: 200,
    arch: "aarch64",
    runtime: "docker",
    vmType: "vz",
    mountType: "virtiofs",
    rosetta: false,
    networkAddress: false,
    kubernetesEnabled: false,
    kubernetesVersion: "v1.30.0",
    mounts: ["~:w"],
  },
};

export const mockContainers: Container[] = [
  {
    id: "a1b2c3d4e5f6",
    names: "web_frontend_1",
    image: "nginx:latest",
    command: "\"nginx -g daemon of\"",
    state: "running",
    status: "Up 3 hours",
    ports: "0.0.0.0:8080->80/tcp",
    portLinks: [{ hostPort: 8080, containerPort: 80, protocol: "tcp", url: "http://localhost:8080" }],
    createdAt: isoAgo(3 * 3600_000),
    runningFor: "3 hours",
    composeProject: "myapp",
    composeService: "frontend",
  },
  {
    id: "b2c3d4e5f6a1",
    names: "web_api_1",
    image: "myapp/api:1.4.2",
    command: "\"node server.js\"",
    state: "running",
    status: "Up 3 hours",
    ports: "0.0.0.0:3000->3000/tcp",
    portLinks: [{ hostPort: 3000, containerPort: 3000, protocol: "tcp", url: "http://localhost:3000" }],
    createdAt: isoAgo(3 * 3600_000),
    runningFor: "3 hours",
    composeProject: "myapp",
    composeService: "api",
  },
  {
    id: "c3d4e5f6a1b2",
    names: "web_db_1",
    image: "postgres:16",
    command: "\"docker-entrypoint.s…\"",
    state: "running",
    status: "Up 3 hours",
    ports: "0.0.0.0:5432->5432/tcp",
    portLinks: [{ hostPort: 5432, containerPort: 5432, protocol: "tcp", url: "http://localhost:5432" }],
    createdAt: isoAgo(3 * 3600_000),
    runningFor: "3 hours",
    composeProject: "myapp",
    composeService: "db",
  },
  {
    id: "d4e5f6a1b2c3",
    names: "redis-cache",
    image: "redis:7-alpine",
    command: "\"redis-server\"",
    state: "exited",
    status: "Exited (0) 2 days ago",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(5 * 86400_000),
    runningFor: "",
    composeProject: null,
    composeService: null,
  },
];

export const mockContainerStats: ContainerStats[] = [
  { id: "a1b2c3d4e5f6", name: "web_frontend_1", cpuPerc: "0.42%", memUsage: "12.4MiB / 3.83GiB", memPerc: "0.32%", netIO: "1.2kB / 0B", blockIO: "0B / 0B", pids: "3" },
  { id: "b2c3d4e5f6a1", name: "web_api_1", cpuPerc: "1.85%", memUsage: "84.1MiB / 3.83GiB", memPerc: "2.14%", netIO: "4.5kB / 2.1kB", blockIO: "0B / 4.1kB", pids: "11" },
  { id: "c3d4e5f6a1b2", name: "web_db_1", cpuPerc: "0.61%", memUsage: "45.2MiB / 3.83GiB", memPerc: "1.15%", netIO: "890B / 640B", blockIO: "12.3MB / 8.1MB", pids: "8" },
];

export const mockImages: Image[] = [
  { id: "sha256:1a2b3c4d5e6f", repository: "nginx", tag: "latest", size: "187MB", createdSince: "2 weeks ago", createdAt: isoAgo(14 * 86400_000), inUse: true },
  { id: "sha256:2b3c4d5e6f7a", repository: "myapp/api", tag: "1.4.2", size: "342MB", createdSince: "3 days ago", createdAt: isoAgo(3 * 86400_000), inUse: true },
  { id: "sha256:3c4d5e6f7a8b", repository: "postgres", tag: "16", size: "438MB", createdSince: "1 month ago", createdAt: isoAgo(30 * 86400_000), inUse: true },
  { id: "sha256:4d5e6f7a8b9c", repository: "redis", tag: "7-alpine", size: "41MB", createdSince: "1 month ago", createdAt: isoAgo(30 * 86400_000), inUse: false },
  { id: "sha256:5e6f7a8b9c0d", repository: "<none>", tag: "<none>", size: "98MB", createdSince: "2 months ago", createdAt: isoAgo(60 * 86400_000), inUse: false },
];

export const mockVolumes: Volume[] = [
  { name: "myapp_pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/myapp_pgdata/_data", size: "1.2GB" },
  { name: "myapp_redis-data", driver: "local", mountpoint: "/var/lib/docker/volumes/myapp_redis-data/_data", size: "12MB" },
  { name: "orphan-vol-a1b2", driver: "local", mountpoint: "/var/lib/docker/volumes/orphan-vol-a1b2/_data", size: null },
];

export const mockK8sPods: K8sPod[] = [
  { name: "api-6f8b9c7d-abcde", namespace: "default", phase: "Running", status: "Running", ready: "1/1", restarts: 0, createdAt: isoAgo(2 * 3600_000), node: "colima", podIp: "10.42.0.12", containers: ["api"] },
  { name: "worker-5d7c6b8f-fghij", namespace: "default", phase: "Running", status: "CrashLoopBackOff", ready: "0/1", restarts: 14, createdAt: isoAgo(2 * 3600_000), node: "colima", podIp: "10.42.0.13", containers: ["worker"] },
  { name: "coredns-6799fbcd5-klmno", namespace: "kube-system", phase: "Running", status: "Running", ready: "1/1", restarts: 0, createdAt: isoAgo(5 * 86400_000), node: "colima", podIp: "10.42.0.4", containers: ["coredns"] },
];

export const mockK8sDeployments: K8sDeployment[] = [
  { name: "api", namespace: "default", ready: "1/1", upToDate: 1, available: 1, replicas: 1, createdAt: isoAgo(5 * 86400_000), images: ["myapp/api:1.4.2"] },
  { name: "worker", namespace: "default", ready: "0/1", upToDate: 1, available: 0, replicas: 1, createdAt: isoAgo(5 * 86400_000), images: ["myapp/worker:1.4.2"] },
];

export const mockK8sServices: K8sService[] = [
  { name: "api", namespace: "default", type: "ClusterIP", clusterIp: "10.43.0.55", externalIp: null, ports: "80/TCP", createdAt: isoAgo(5 * 86400_000) },
  { name: "kubernetes", namespace: "default", type: "ClusterIP", clusterIp: "10.43.0.1", externalIp: null, ports: "443/TCP", createdAt: isoAgo(10 * 86400_000) },
];

export const mockK8sNodes: K8sNode[] = [
  { name: "colima", status: "Ready", roles: "control-plane,master", version: "v1.30.0", internalIp: "192.168.106.2", osImage: "K3s v1.30.0", cpu: "2", memory: "4Gi", createdAt: isoAgo(10 * 86400_000) },
];

export function mockProfileConfigRaw(profile: string): ProfileConfigRaw {
  return {
    content: upstreamDefaultYaml,
    source: "builtin",
    path: `~/.colima/${profile}/colima.yaml`,
    exists: profile === "default",
  };
}

/** Dev-mode mock for `validate_profile_config_raw`: the real typed validation
 * (mirroring colima's `config.Config`) lives entirely in the Rust backend
 * (src-tauri/src/config_file.rs), so there's nothing meaningful to re-derive
 * here without duplicating it. Browser-mock mode has no backend to silently
 * fall back to defaults in the first place, so always reporting a clean
 * config keeps this mock honest about what it can check. */
export function mockValidateProfileConfigRaw(_content: string): ConfigIssue[] {
  return [];
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
