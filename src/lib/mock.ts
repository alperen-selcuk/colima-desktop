// Dev-only mock backend used when running `npm run dev` in a plain browser
// (i.e. outside the Tauri webview, where `__TAURI_INTERNALS__` is absent).
// Lets every page render with representative sample data for visual QA.
import type {
  ConfigIssue,
  Container,
  ContainerStats,
  EnvInfo,
  HostKubeconfigHealth,
  Image,
  K3sVersionsResponse,
  K8sConfigMap,
  K8sDeployment,
  K8sIngress,
  K8sNode,
  K8sPod,
  K8sSecret,
  K8sService,
  NodeMetrics,
  PodMetrics,
  Profile,
  ProfileConfig,
  ProfileConfigRaw,
  ProfileStatus,
  RepairResult,
  SecretValue,
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
  {
    name: "api-6f8b9c7d-abcde",
    namespace: "default",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    createdAt: isoAgo(2 * 3600_000),
    node: "colima",
    podIp: "10.42.0.12",
    containers: ["api"],
    cpuRequestMilli: 100,
    cpuLimitMilli: 500,
    memRequestBytes: 64 * 1024 * 1024,
    memLimitBytes: 256 * 1024 * 1024,
  },
  {
    name: "worker-5d7c6b8f-fghij",
    namespace: "default",
    phase: "Running",
    status: "CrashLoopBackOff",
    ready: "0/1",
    restarts: 14,
    createdAt: isoAgo(2 * 3600_000),
    node: "colima",
    podIp: "10.42.0.13",
    containers: ["worker"],
    cpuRequestMilli: 250,
    cpuLimitMilli: 1000,
    memRequestBytes: 128 * 1024 * 1024,
    memLimitBytes: 512 * 1024 * 1024,
  },
  {
    name: "web-7c9d8f6b-qrstu",
    namespace: "default",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    createdAt: isoAgo(6 * 3600_000),
    node: "colima",
    podIp: "10.42.0.15",
    containers: ["web"],
    cpuRequestMilli: 100,
    cpuLimitMilli: 200,
    memRequestBytes: 128 * 1024 * 1024,
    memLimitBytes: 256 * 1024 * 1024,
  },
  {
    name: "coredns-6799fbcd5-klmno",
    namespace: "kube-system",
    phase: "Running",
    status: "Running",
    ready: "1/1",
    restarts: 0,
    createdAt: isoAgo(5 * 86400_000),
    node: "colima",
    podIp: "10.42.0.4",
    containers: ["coredns"],
    cpuRequestMilli: null,
    cpuLimitMilli: null,
    memRequestBytes: null,
    memLimitBytes: 170 * 1024 * 1024,
  },
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
  {
    name: "colima",
    status: "Ready",
    roles: "control-plane,master",
    version: "v1.30.0",
    internalIp: "192.168.106.2",
    osImage: "K3s v1.30.0",
    cpu: "2",
    memory: "4Gi",
    createdAt: isoAgo(10 * 86400_000),
    cpuAllocatableMilli: 2000,
    memAllocatableBytes: 4 * 1024 * 1024 * 1024,
  },
];

export const mockK8sConfigMaps: K8sConfigMap[] = [
  { name: "api-config", namespace: "default", keys: ["APP_ENV", "LOG_LEVEL", "config.yaml"], createdAt: isoAgo(5 * 86400_000) },
  { name: "nginx-conf", namespace: "default", keys: ["nginx.conf"], createdAt: isoAgo(12 * 86400_000) },
  { name: "kube-root-ca.crt", namespace: "kube-system", keys: ["ca.crt"], createdAt: isoAgo(10 * 86400_000) },
];

export const mockK8sSecrets: K8sSecret[] = [
  { name: "api-credentials", namespace: "default", type: "Opaque", keys: ["DATABASE_URL", "API_KEY"], createdAt: isoAgo(5 * 86400_000) },
  { name: "registry-pull-secret", namespace: "default", type: "kubernetes.io/dockerconfigjson", keys: [".dockerconfigjson"], createdAt: isoAgo(12 * 86400_000) },
  { name: "default-token-xyz12", namespace: "kube-system", type: "kubernetes.io/service-account-token", keys: ["ca.crt", "namespace", "token"], createdAt: isoAgo(10 * 86400_000) },
];

const mockSecretValues: Record<string, Record<string, string>> = {
  "api-credentials": {
    DATABASE_URL: "postgres://api:s3cr3t-p4ss@postgres.default.svc.cluster.local:5432/api",
    API_KEY: "sk_test_placeholder_1234567890abcdef",
  },
  "registry-pull-secret": {
    ".dockerconfigjson": '{"auths":{"registry.example.com":{"auth":"ZGVtbzpwYXNzd29yZA=="}}}',
  },
  "default-token-xyz12": {
    "ca.crt": "-----BEGIN CERTIFICATE-----\nMIIC...mock...\n-----END CERTIFICATE-----",
    namespace: "kube-system",
    token: "eyJhbGciOiJSUzI1NiIsImtpZCI6Im1vY2sifQ.mock.token",
  },
};

export function mockK8sSecretValue(name: string, key: string): SecretValue {
  const value = mockSecretValues[name]?.[key] ?? "";
  return { value, binary: false };
}

export const mockK8sIngresses: K8sIngress[] = [
  {
    name: "api-ingress",
    namespace: "default",
    className: "traefik",
    hosts: ["api.colima.local"],
    address: "192.168.106.2",
    ports: "80, 443",
    tls: true,
    rules: [
      { host: "api.colima.local", path: "/", pathType: "Prefix", backend: "api:80" },
    ],
    createdAt: isoAgo(5 * 86400_000),
  },
  {
    name: "web-ingress",
    namespace: "default",
    className: "traefik",
    hosts: ["app.colima.local"],
    address: "192.168.106.2",
    ports: "80",
    tls: false,
    rules: [
      { host: "app.colima.local", path: "/", pathType: "Prefix", backend: "web:8080" },
      { host: "app.colima.local", path: "/api", pathType: "Prefix", backend: "api:80" },
    ],
    createdAt: isoAgo(3 * 86400_000),
  },
];

// Pod metrics (§6.6): tuned so the four mock pods above land in all three
// usage-bar color tiers (green < 60%, amber < 85%, red >= 85%), against
// whichever denominator each pod resolves to (limit -> request -> node
// allocatable per `selectUsage`):
//   api    (limit 500m/256Mi):  120m/40%cpu(green), 150Mi/59%mem(green)
//   worker (limit 1000m/512Mi): 640m/64%cpu(amber), 460Mi/90%mem(red)
//   web    (limit 200m/256Mi):  190m/95%cpu(red),   80Mi/31%mem(green)
//   coredns(no cpu req/lim, mem limit 170Mi): cpu falls back to node
//     allocatable (2000m) -> 30m/1.5%(green); mem 145Mi/85%(red)
export const mockPodMetrics: PodMetrics = {
  available: true,
  reason: null,
  pods: [
    { namespace: "default", name: "api-6f8b9c7d-abcde", cpuMilli: 120, memBytes: 150 * 1024 * 1024 },
    { namespace: "default", name: "worker-5d7c6b8f-fghij", cpuMilli: 640, memBytes: 460 * 1024 * 1024 },
    { namespace: "default", name: "web-7c9d8f6b-qrstu", cpuMilli: 190, memBytes: 80 * 1024 * 1024 },
    { namespace: "kube-system", name: "coredns-6799fbcd5-klmno", cpuMilli: 30, memBytes: 145 * 1024 * 1024 },
  ],
};

export const mockNodeMetrics: NodeMetrics = {
  available: true,
  reason: null,
  nodes: [{ name: "colima", cpuMilli: 980, memBytes: 2.6 * 1024 * 1024 * 1024 }],
};

export function mockK8sEditYaml(kind: string, namespace: string | null, name: string): string {
  return `apiVersion: v1\nkind: ${kind}\nmetadata:\n  name: ${name}\n${namespace ? `  namespace: ${namespace}\n` : ""}  resourceVersion: "12345"\nspec: {}\n`;
}

export function mockK8sApplyYaml(dryRun: boolean): string {
  return dryRun ? "(dry run) configured\nno changes were made" : "configured";
}

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

// Realistic k3s_versions response (§6.5), mirroring the shape of a real
// fetch from https://api.github.com/repos/k3s-io/k3s/releases: newest-first,
// one row per patch, `latestInMinor` marking the newest patch per minor.
export const mockK3sVersions: K3sVersionsResponse = {
  versions: [
    { version: "v1.37.0+k3s1", minor: "1.37", publishedAt: "2026-09-14T15:50:04Z", latestInMinor: true },
    { version: "v1.36.4+k3s1", minor: "1.36", publishedAt: "2026-08-27T15:53:55Z", latestInMinor: true },
    { version: "v1.36.3+k3s1", minor: "1.36", publishedAt: "2026-08-04T19:42:34Z", latestInMinor: false },
    { version: "v1.35.8+k3s1", minor: "1.35", publishedAt: "2026-08-27T15:06:43Z", latestInMinor: true },
    { version: "v1.35.7+k3s1", minor: "1.35", publishedAt: "2026-07-29T12:11:02Z", latestInMinor: false },
    { version: "v1.34.11+k3s1", minor: "1.34", publishedAt: "2026-08-27T15:06:09Z", latestInMinor: true },
    { version: "v1.34.10+k3s1", minor: "1.34", publishedAt: "2026-07-29T11:40:55Z", latestInMinor: false },
    { version: "v1.33.13+k3s2", minor: "1.33", publishedAt: "2026-08-04T19:40:10Z", latestInMinor: true },
    { version: "v1.32.13+k3s1", minor: "1.32", publishedAt: "2026-03-04T18:38:59Z", latestInMinor: true },
    { version: "v1.31.14+k3s1", minor: "1.31", publishedAt: "2025-11-20T21:45:20Z", latestInMinor: true },
    { version: "v1.31.2+k3s1", minor: "1.31", publishedAt: "2024-11-14T18:22:10Z", latestInMinor: false },
    { version: "v1.30.14+k3s2", minor: "1.30", publishedAt: "2025-07-26T02:07:02Z", latestInMinor: true },
    { version: "v1.29.15+k3s1", minor: "1.29", publishedAt: "2025-03-25T22:09:59Z", latestInMinor: true },
    { version: "v1.28.15+k3s1", minor: "1.28", publishedAt: "2024-10-26T01:18:18Z", latestInMinor: true },
  ],
  colimaDefault: "v1.31.2+k3s1",
  source: "github",
  fetchedAt: isoAgo(5 * 60_000),
  error: null,
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Mock host kubeconfig health (§2.1a): clean by default so the dev-mode
// Kubernetes page doesn't show the stale-credentials notice unless a
// specific profile is exercising it (see `mockHostKubeconfigHealth` below).
export function mockHostKubeconfigHealth(profile: string): HostKubeconfigHealth {
  if (profile === "stale-kubeconfig") {
    return {
      contextExists: true,
      credentialsMatch: false,
      detail: "`colima` client credentials in your kubeconfig are stale (k3s rotated its certificate)",
    };
  }
  return {
    contextExists: true,
    credentialsMatch: true,
    detail: "`colima` credentials in your kubeconfig match the running cluster",
  };
}

export function mockRepairHostKubeconfig(): RepairResult {
  return { backupPath: "~/.kube/config.colima-desktop-bak-1758912345" };
}
