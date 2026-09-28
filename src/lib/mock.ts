// Dev-only mock backend used when running `npm run dev` in a plain browser
// (i.e. outside the Tauri webview, where `__TAURI_INTERNALS__` is absent).
// Lets every page render with representative sample data for visual QA.
import type {
  CatalogItem,
  CatalogResponse,
  ComposeInfo,
  ComposePreview,
  ComposeProject,
  ConfigIssue,
  Container,
  ContainerStats,
  EnvInfo,
  HostKubeconfigHealth,
  Image,
  InstalledApp,
  K3sVersionsResponse,
  K8sConfigMap,
  K8sDeployment,
  K8sIngress,
  K8sNode,
  K8sPod,
  K8sSecret,
  K8sService,
  MarketplacePrepareResult,
  NodeMetrics,
  PodMetrics,
  PreflightResult,
  Profile,
  ProfileConfig,
  ProfileConfigRaw,
  ProfileStatus,
  RepairResult,
  SecretValue,
  Volume,
} from "./types";
import { generatePassword, renderEndpoints } from "./marketplace";
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
    composeWorkingDir: "/Users/dev/projects/myapp",
    composeConfigFiles: ["/Users/dev/projects/myapp/docker-compose.yml"],
    kubernetes: null,
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
    composeWorkingDir: "/Users/dev/projects/myapp",
    composeConfigFiles: ["/Users/dev/projects/myapp/docker-compose.yml"],
    kubernetes: null,
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
    composeWorkingDir: "/Users/dev/projects/myapp",
    composeConfigFiles: ["/Users/dev/projects/myapp/docker-compose.yml"],
    kubernetes: null,
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
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: null,
  },
  // Standalone (non-compose) containers with mixed known/unknown images, to
  // exercise the brand-icon lookup and the generic hashed-tile fallback.
  {
    id: "e5f6a1b2c3d4",
    names: "metrics-grafana",
    image: "grafana/grafana:11.1.0",
    command: "\"/run.sh\"",
    state: "running",
    status: "Up 6 hours",
    ports: "0.0.0.0:3001->3000/tcp",
    portLinks: [{ hostPort: 3001, containerPort: 3000, protocol: "tcp", url: "http://localhost:3001" }],
    createdAt: isoAgo(6 * 3600_000),
    runningFor: "6 hours",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: null,
  },
  {
    id: "f6a1b2c3d4e5",
    names: "internal-billing-svc",
    image: "registry.internal.example.com/platform/billing-svc:2.3.0",
    command: "\"./billing-svc\"",
    state: "running",
    status: "Up 12 hours",
    ports: "0.0.0.0:9090->9090/tcp",
    portLinks: [{ hostPort: 9090, containerPort: 9090, protocol: "tcp", url: "http://localhost:9090" }],
    createdAt: isoAgo(12 * 3600_000),
    runningFor: "12 hours",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: null,
  },
  // Second compose project ("analytics"): mixes a well-known image (mongo)
  // with an unrecognized custom one, and is only partially running so the
  // group's aggregate status shows a mix (e.g. "running(1), exited(1)").
  {
    id: "a2b3c4d5e6f7",
    names: "analytics_worker_1",
    image: "ghcr.io/acme/analytics-worker:0.9.1",
    command: "\"python worker.py\"",
    state: "running",
    status: "Up 40 minutes",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(40 * 60_000),
    runningFor: "40 minutes",
    composeProject: "analytics",
    composeService: "worker",
    composeWorkingDir: "/Users/dev/projects/analytics",
    composeConfigFiles: ["/Users/dev/projects/analytics/docker-compose.yaml"],
    kubernetes: null,
  },
  {
    id: "b3c4d5e6f7a8",
    names: "analytics_mongo_1",
    image: "mongo:7",
    command: "\"docker-entrypoint.s…\"",
    state: "exited",
    status: "Exited (0) 3 hours ago",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(3 * 3600_000),
    runningFor: "",
    composeProject: "analytics",
    composeService: "mongo",
    composeWorkingDir: "/Users/dev/projects/analytics",
    composeConfigFiles: ["/Users/dev/projects/analytics/docker-compose.yaml"],
    kubernetes: null,
  },
  // Kubernetes-managed containers (§6.7): k3s runs every pod container (plus
  // `k8s_POD_...` sandboxes) as a plain docker container labelled
  // io.kubernetes.pod.*. These must be hidden from the Containers page by
  // default (and excluded from counts/tiles/compose grouping) — the filter
  // menu's "Show Kubernetes containers (N)" toggle reveals them.
  {
    id: "c4d5e6f7a8b9",
    names: "k8s_POD_api-6f8b9c7d-abcde_default_a1b2c3d4-0000-0000-0000-000000000001_0",
    image: "registry.k8s.io/pause:3.9",
    command: "\"/pause\"",
    state: "running",
    status: "Up 2 hours",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(2 * 3600_000),
    runningFor: "2 hours",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: { namespace: "default", pod: "api-6f8b9c7d-abcde", container: null },
  },
  {
    id: "d5e6f7a8b9c0",
    names: "k8s_api_api-6f8b9c7d-abcde_default_a1b2c3d4-0000-0000-0000-000000000001_0",
    image: "myapp/api:1.4.2",
    command: "\"node server.js\"",
    state: "running",
    status: "Up 2 hours",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(2 * 3600_000),
    runningFor: "2 hours",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: { namespace: "default", pod: "api-6f8b9c7d-abcde", container: "api" },
  },
  {
    id: "e6f7a8b9c0d1",
    names: "k8s_POD_coredns-6799fbcd5-klmno_kube-system_b2c3d4e5-0000-0000-0000-000000000002_0",
    image: "registry.k8s.io/pause:3.9",
    command: "\"/pause\"",
    state: "running",
    status: "Up 5 days",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(5 * 86400_000),
    runningFor: "5 days",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: { namespace: "kube-system", pod: "coredns-6799fbcd5-klmno", container: null },
  },
  {
    id: "f7a8b9c0d1e2",
    names: "k8s_coredns_coredns-6799fbcd5-klmno_kube-system_b2c3d4e5-0000-0000-0000-000000000002_0",
    image: "rancher/mirrored-coredns-coredns:1.11.1",
    command: "\"/coredns\"",
    state: "running",
    status: "Up 5 days",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(5 * 86400_000),
    runningFor: "5 days",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: { namespace: "kube-system", pod: "coredns-6799fbcd5-klmno", container: "coredns" },
  },
  // A leftover, exited k8s sandbox — the motivating bug report: these must
  // NOT show up as "stopped containers" when Kubernetes is off, and stay
  // hidden by default even when it's on.
  {
    id: "a8b9c0d1e2f3",
    names: "k8s_POD_worker-5d7c6b8f-fghij_default_c3d4e5f6-0000-0000-0000-000000000003_0",
    image: "registry.k8s.io/pause:3.9",
    command: "\"/pause\"",
    state: "exited",
    status: "Exited (0) 1 day ago",
    ports: "",
    portLinks: [],
    createdAt: isoAgo(1 * 86400_000),
    runningFor: "",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: { namespace: "default", pod: "worker-5d7c6b8f-fghij", container: null },
  },
];

export const mockContainerStats: ContainerStats[] = [
  { id: "a1b2c3d4e5f6", name: "web_frontend_1", cpuPerc: "0.42%", memUsage: "12.4MiB / 3.83GiB", memPerc: "0.32%", netIO: "1.2kB / 0B", blockIO: "0B / 0B", pids: "3" },
  { id: "b2c3d4e5f6a1", name: "web_api_1", cpuPerc: "1.85%", memUsage: "84.1MiB / 3.83GiB", memPerc: "2.14%", netIO: "4.5kB / 2.1kB", blockIO: "0B / 4.1kB", pids: "11" },
  { id: "c3d4e5f6a1b2", name: "web_db_1", cpuPerc: "0.61%", memUsage: "45.2MiB / 3.83GiB", memPerc: "1.15%", netIO: "890B / 640B", blockIO: "12.3MB / 8.1MB", pids: "8" },
  { id: "e5f6a1b2c3d4", name: "metrics-grafana", cpuPerc: "2.10%", memUsage: "128MiB / 3.83GiB", memPerc: "3.26%", netIO: "8.4kB / 3.1kB", blockIO: "4.2MB / 0B", pids: "14" },
  { id: "f6a1b2c3d4e5", name: "internal-billing-svc", cpuPerc: "0.95%", memUsage: "56.3MiB / 3.83GiB", memPerc: "1.44%", netIO: "2.1kB / 1.4kB", blockIO: "0B / 0B", pids: "6" },
  { id: "a2b3c4d5e6f7", name: "analytics_worker_1", cpuPerc: "12.4%", memUsage: "210MiB / 3.83GiB", memPerc: "5.35%", netIO: "620B / 0B", blockIO: "0B / 0B", pids: "5" },
  { id: "c4d5e6f7a8b9", name: "k8s_POD_api-…", cpuPerc: "0.00%", memUsage: "0.4MiB / 3.83GiB", memPerc: "0.01%", netIO: "0B / 0B", blockIO: "0B / 0B", pids: "1" },
  { id: "d5e6f7a8b9c0", name: "k8s_api_api-…", cpuPerc: "0.55%", memUsage: "38.2MiB / 3.83GiB", memPerc: "0.97%", netIO: "1.1kB / 640B", blockIO: "0B / 0B", pids: "9" },
  { id: "e6f7a8b9c0d1", name: "k8s_POD_coredns-…", cpuPerc: "0.00%", memUsage: "0.4MiB / 3.83GiB", memPerc: "0.01%", netIO: "0B / 0B", blockIO: "0B / 0B", pids: "1" },
  { id: "f7a8b9c0d1e2", name: "k8s_coredns_coredns-…", cpuPerc: "0.31%", memUsage: "18.9MiB / 3.83GiB", memPerc: "0.48%", netIO: "540B / 320B", blockIO: "0B / 0B", pids: "5" },
];

export const mockImages: Image[] = [
  { id: "sha256:1a2b3c4d5e6f", repository: "nginx", tag: "latest", size: "187MB", createdSince: "2 weeks ago", createdAt: isoAgo(14 * 86400_000), inUse: true },
  { id: "sha256:2b3c4d5e6f7a", repository: "myapp/api", tag: "1.4.2", size: "342MB", createdSince: "3 days ago", createdAt: isoAgo(3 * 86400_000), inUse: true },
  { id: "sha256:3c4d5e6f7a8b", repository: "postgres", tag: "16", size: "438MB", createdSince: "1 month ago", createdAt: isoAgo(30 * 86400_000), inUse: true },
  { id: "sha256:4d5e6f7a8b9c", repository: "redis", tag: "7-alpine", size: "41MB", createdSince: "1 month ago", createdAt: isoAgo(30 * 86400_000), inUse: false },
  { id: "sha256:5e6f7a8b9c0d", repository: "<none>", tag: "<none>", size: "98MB", createdSince: "2 months ago", createdAt: isoAgo(60 * 86400_000), inUse: false },
];

// Mirrors a real bug report (7 unused named volumes, 5 leftover from
// `compose down` without `-v`, plus 2 plain named volumes with no compose
// project), captured live from a colima `default` docker socket (server
// 27.4.0), plus one anonymous and one in-use volume added for variety so
// the page's "named"/"anonymous" badges and "in use" column both have a
// non-empty case to render in `npm run dev`.
export const mockVolumes: Volume[] = [
  {
    name: "alperenselcuk_db_data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/alperenselcuk_db_data/_data",
    size: "136.5MB",
    sizeBytes: 136_500_000,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: "alperenselcuk",
    createdAt: isoAgo(340 * 86400_000),
  },
  {
    name: "devopschallenge_postgres_data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/devopschallenge_postgres_data/_data",
    size: "48.27MB",
    sizeBytes: 48_270_000,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: "devopschallenge",
    createdAt: isoAgo(114 * 86400_000),
  },
  {
    name: "logbat_postgres_data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/logbat_postgres_data/_data",
    size: "47.99MB",
    sizeBytes: 47_990_000,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: "logbat",
    createdAt: isoAgo(310 * 86400_000),
  },
  {
    name: "logbat_redis_data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/logbat_redis_data/_data",
    size: "1.831kB",
    sizeBytes: 1831,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: "logbat",
    createdAt: isoAgo(310 * 86400_000),
  },
  {
    name: "photo-peek-puzzle-challenge_postgres_data",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/photo-peek-puzzle-challenge_postgres_data/_data",
    size: "49.31MB",
    sizeBytes: 49_310_000,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: "photo-peek-puzzle-challenge",
    createdAt: isoAgo(115 * 86400_000),
  },
  // Plain named volumes (not compose-managed) — bug report's other two.
  {
    name: "laya-smoke-hf",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/laya-smoke-hf/_data",
    size: "678.3MB",
    sizeBytes: 678_300_000,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: null,
    createdAt: isoAgo(2 * 86400_000),
  },
  {
    name: "setur-nuget",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/setur-nuget/_data",
    size: "0B",
    sizeBytes: 0,
    containers: 0,
    inUse: false,
    anonymous: false,
    composeProject: null,
    createdAt: isoAgo(4 * 86400_000),
  },
  // In-use named volume, for variety (mounted by a container).
  {
    name: "myapp_pgdata",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/myapp_pgdata/_data",
    size: "1.2GB",
    sizeBytes: 1_200_000_000,
    containers: 1,
    inUse: true,
    anonymous: false,
    composeProject: "myapp",
    createdAt: isoAgo(20 * 86400_000),
  },
  // Anonymous volume (e.g. an unnamed `docker run -v /data` mount).
  {
    name: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    driver: "local",
    mountpoint: "/var/lib/docker/volumes/a1b2.../_data",
    size: "3.4MB",
    sizeBytes: 3_400_000,
    containers: 0,
    inUse: false,
    anonymous: true,
    composeProject: null,
    createdAt: isoAgo(9 * 86400_000),
  },
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

// ---- §6.7: Docker Compose ----

export const mockComposeInfo: ComposeInfo = {
  available: true,
  version: "v2.29.1",
  mode: "plugin",
  hint: null,
};

export const mockComposeProjects: ComposeProject[] = [
  { name: "myapp", status: "running(3)", configFiles: ["/Users/dev/projects/myapp/docker-compose.yml"] },
  { name: "analytics", status: "running(1), exited(1)", configFiles: ["/Users/dev/projects/analytics/docker-compose.yaml"] },
];

/** Mock for `compose_preview`: derives a plausible service list from the
 * chosen file's directory name so the Compose Up dialog's live preview has
 * something representative to show without a real compose file on disk. */
export function mockComposePreview(files: string[], projectName: string | null): ComposePreview {
  const file = files?.[0] ?? "/Users/dev/projects/myapp/docker-compose.yml";
  const dir = file.split("/").filter(Boolean).slice(-2, -1)[0] ?? "app";
  const project = projectName || dir.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "") || "app";
  return {
    projectName: project,
    services: [
      { name: "web", image: "nginx:latest", build: false, ports: ["8080:80"] },
      { name: "app", image: null, build: true, ports: ["3000:3000"] },
      { name: "db", image: "postgres:16", build: false, ports: ["5432:5432"] },
    ],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// §6.8: Marketplace
// ---------------------------------------------------------------------------

/** ~8 representative catalog items so `npm run dev` demos search, category
 * chips, the responsive card grid, the detail drawer's compose preview, and
 * both the "failing-but-fixable" and "clean" preflight paths. Compose text
 * is intentionally minimal but realistic (valid YAML the parseComposeServices
 * helper can actually read) — not the full production compose files that
 * belong in catalog/apps/<id>/compose.yml. */
export const mockCatalogItems: CatalogItem[] = [
  {
    id: "elasticsearch-kibana",
    name: "Elasticsearch + Kibana",
    description: "Search, analyze and visualize logs and application data.",
    category: "search",
    tags: ["elk", "logs", "search"],
    icon: "elasticsearch",
    website: "https://www.elastic.co",
    source: { name: "docker/awesome-compose", url: "https://github.com/docker/awesome-compose", license: "CC0-1.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 3072,
    variables: [
      { name: "ELASTIC_PASSWORD", type: "password", label: "elastic password", length: 24 },
      { name: "ES_PORT", type: "port", label: "Elasticsearch port", default: 9200 },
      { name: "KIBANA_PORT", type: "port", label: "Kibana port", default: 5601 },
      { name: "KIBANA_SYSTEM_PASSWORD", type: "password", label: "kibana_system password", length: 24, hidden: true },
    ],
    endpoints: [
      { name: "Kibana", url: "http://localhost:${KIBANA_PORT}", username: "elastic", password: "${ELASTIC_PASSWORD}", primary: true },
      { name: "Elasticsearch API", url: "http://localhost:${ES_PORT}", username: "elastic", password: "${ELASTIC_PASSWORD}" },
    ],
    preflight: [{ type: "sysctl", key: "vm.max_map_count", min: 262144 }],
    ready: { type: "http", url: "http://localhost:${KIBANA_PORT}/api/status", expectStatus: [200, 401], timeoutSec: 240 },
    notes: "Elasticsearch needs a few minutes to become ready on first start.",
    compose: `services:
  elasticsearch:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.15.0
    environment:
      - ELASTIC_PASSWORD=\${ELASTIC_PASSWORD}
      - discovery.type=single-node
      - xpack.security.enabled=true
    ports:
      - "127.0.0.1:\${ES_PORT}:9200"
    volumes:
      - es-data:/usr/share/elasticsearch/data
  kibana:
    image: docker.elastic.co/kibana/kibana:8.15.0
    environment:
      - ELASTICSEARCH_HOSTS=http://elasticsearch:9200
      - ELASTICSEARCH_USERNAME=kibana_system
      - ELASTICSEARCH_PASSWORD=\${KIBANA_SYSTEM_PASSWORD}
    ports:
      - "127.0.0.1:\${KIBANA_PORT}:5601"
    depends_on:
      - elasticsearch
volumes:
  es-data:
`,
  },
  {
    id: "postgres-pgadmin",
    name: "Postgres + pgAdmin",
    description: "Relational database with a web-based admin UI.",
    category: "database",
    tags: ["sql", "postgres", "admin"],
    icon: "postgresql",
    website: "https://www.postgresql.org",
    source: { name: "docker/awesome-compose", url: "https://github.com/docker/awesome-compose", license: "CC0-1.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 512,
    variables: [
      { name: "PG_USER", type: "string", label: "User", default: "app" },
      { name: "PG_PASSWORD", type: "password", label: "Postgres password", length: 20 },
      { name: "PG_PORT", type: "port", label: "Postgres port", default: 5432 },
      { name: "PGADMIN_PORT", type: "port", label: "pgAdmin port", default: 8081 },
      { name: "PGADMIN_PASSWORD", type: "password", label: "pgAdmin password", length: 20 },
    ],
    endpoints: [
      { name: "pgAdmin", url: "http://localhost:${PGADMIN_PORT}", username: "admin@example.com", password: "${PGADMIN_PASSWORD}", primary: true },
      { name: "Connection string", value: "postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/app" },
    ],
    preflight: [],
    ready: { type: "healthy", timeoutSec: 120 },
    notes: "Add a server in pgAdmin using the connection string's host/port and the Postgres password above.",
    compose: `services:
  postgres:
    image: postgres:16.4
    environment:
      - POSTGRES_USER=\${PG_USER}
      - POSTGRES_PASSWORD=\${PG_PASSWORD}
      - POSTGRES_DB=app
    ports:
      - "127.0.0.1:\${PG_PORT}:5432"
    volumes:
      - pg-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${PG_USER}"]
      interval: 5s
      timeout: 3s
      retries: 10
  pgadmin:
    image: dpage/pgadmin4:8.11
    environment:
      - PGADMIN_DEFAULT_EMAIL=admin@example.com
      - PGADMIN_DEFAULT_PASSWORD=\${PGADMIN_PASSWORD}
    ports:
      - "127.0.0.1:\${PGADMIN_PORT}:80"
    depends_on:
      - postgres
volumes:
  pg-data:
`,
  },
  {
    id: "redis",
    name: "Redis",
    description: "In-memory key-value store for caching and pub/sub.",
    category: "database",
    tags: ["cache", "kv", "pubsub"],
    icon: "redis",
    website: "https://redis.io",
    source: { name: "Official Redis image", url: "https://hub.docker.com/_/redis", license: "MIT" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 256,
    variables: [
      { name: "REDIS_PASSWORD", type: "password", label: "Redis password", length: 20 },
      { name: "REDIS_PORT", type: "port", label: "Redis port", default: 6379 },
    ],
    endpoints: [
      { name: "Connection string", value: "redis://:${REDIS_PASSWORD}@localhost:${REDIS_PORT}", primary: true },
    ],
    preflight: [],
    ready: { type: "running", timeoutSec: 30 },
    notes: null,
    compose: `services:
  redis:
    image: redis:7.2-alpine
    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}"]
    ports:
      - "127.0.0.1:\${REDIS_PORT}:6379"
    volumes:
      - redis-data:/data
volumes:
  redis-data:
`,
  },
  {
    id: "rabbitmq",
    name: "RabbitMQ",
    description: "Message broker with the management UI enabled.",
    category: "messaging",
    tags: ["amqp", "queue", "broker"],
    icon: "rabbitmq",
    website: "https://www.rabbitmq.com",
    source: { name: "Official RabbitMQ image", url: "https://hub.docker.com/_/rabbitmq", license: "MIT" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 512,
    variables: [
      { name: "RABBITMQ_USER", type: "string", label: "User", default: "app" },
      { name: "RABBITMQ_PASSWORD", type: "password", label: "Password", length: 20 },
      { name: "RABBITMQ_PORT", type: "port", label: "AMQP port", default: 5672 },
      { name: "RABBITMQ_UI_PORT", type: "port", label: "Management UI port", default: 15672 },
    ],
    endpoints: [
      { name: "Management UI", url: "http://localhost:${RABBITMQ_UI_PORT}", username: "${RABBITMQ_USER}", password: "${RABBITMQ_PASSWORD}", primary: true },
      { name: "AMQP URL", value: "amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@localhost:${RABBITMQ_PORT}" },
    ],
    preflight: [],
    ready: { type: "http", url: "http://localhost:${RABBITMQ_UI_PORT}", expectStatus: [200], timeoutSec: 90 },
    notes: null,
    compose: `services:
  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    environment:
      - RABBITMQ_DEFAULT_USER=\${RABBITMQ_USER}
      - RABBITMQ_DEFAULT_PASS=\${RABBITMQ_PASSWORD}
    ports:
      - "127.0.0.1:\${RABBITMQ_PORT}:5672"
      - "127.0.0.1:\${RABBITMQ_UI_PORT}:15672"
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
volumes:
  rabbitmq-data:
`,
  },
  {
    id: "grafana-prometheus",
    name: "Grafana + Prometheus",
    description: "Metrics collection and dashboards for local development.",
    category: "monitoring",
    tags: ["metrics", "dashboards", "observability"],
    icon: "grafana",
    website: "https://grafana.com",
    source: { name: "docker/awesome-compose", url: "https://github.com/docker/awesome-compose", license: "CC0-1.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 1024,
    variables: [
      { name: "GRAFANA_PORT", type: "port", label: "Grafana port", default: 3000 },
      { name: "GRAFANA_PASSWORD", type: "password", label: "Grafana admin password", length: 20 },
      { name: "PROMETHEUS_PORT", type: "port", label: "Prometheus port", default: 9090 },
    ],
    endpoints: [
      { name: "Grafana", url: "http://localhost:${GRAFANA_PORT}", username: "admin", password: "${GRAFANA_PASSWORD}", primary: true },
      { name: "Prometheus", url: "http://localhost:${PROMETHEUS_PORT}" },
    ],
    preflight: [],
    ready: { type: "http", url: "http://localhost:${GRAFANA_PORT}/api/health", expectStatus: [200], timeoutSec: 120 },
    notes: null,
    compose: `services:
  prometheus:
    image: prom/prometheus:v2.54.1
    ports:
      - "127.0.0.1:\${PROMETHEUS_PORT}:9090"
    volumes:
      - prom-data:/prometheus
  grafana:
    image: grafana/grafana:11.2.0
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=\${GRAFANA_PASSWORD}
    ports:
      - "127.0.0.1:\${GRAFANA_PORT}:3000"
    depends_on:
      - prometheus
    volumes:
      - grafana-data:/var/lib/grafana
volumes:
  prom-data:
  grafana-data:
`,
  },
  {
    id: "minio",
    name: "MinIO",
    description: "S3-compatible object storage with a web console.",
    category: "storage",
    tags: ["s3", "object-storage", "blob"],
    icon: "minio",
    website: "https://min.io",
    source: { name: "Official MinIO image", url: "https://hub.docker.com/r/minio/minio", license: "AGPL-3.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 512,
    variables: [
      { name: "MINIO_ROOT_USER", type: "string", label: "Root user", default: "minioadmin" },
      { name: "MINIO_ROOT_PASSWORD", type: "password", label: "Root password", length: 20 },
      { name: "MINIO_API_PORT", type: "port", label: "API port", default: 9000 },
      { name: "MINIO_CONSOLE_PORT", type: "port", label: "Console port", default: 9001 },
    ],
    endpoints: [
      { name: "Console", url: "http://localhost:${MINIO_CONSOLE_PORT}", username: "${MINIO_ROOT_USER}", password: "${MINIO_ROOT_PASSWORD}", primary: true },
      { name: "S3 API", url: "http://localhost:${MINIO_API_PORT}" },
    ],
    preflight: [],
    ready: { type: "http", url: "http://localhost:${MINIO_API_PORT}/minio/health/live", expectStatus: [200], timeoutSec: 60 },
    notes: null,
    compose: `services:
  minio:
    image: minio/minio:RELEASE.2024-09-13T20-26-02Z
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=\${MINIO_ROOT_USER}
      - MINIO_ROOT_PASSWORD=\${MINIO_ROOT_PASSWORD}
    ports:
      - "127.0.0.1:\${MINIO_API_PORT}:9000"
      - "127.0.0.1:\${MINIO_CONSOLE_PORT}:9001"
    volumes:
      - minio-data:/data
volumes:
  minio-data:
`,
  },
  {
    id: "keycloak",
    name: "Keycloak",
    description: "Identity and access management with OpenID Connect / SAML.",
    category: "auth",
    tags: ["oidc", "sso", "identity"],
    icon: "keycloak",
    website: "https://www.keycloak.org",
    source: { name: "Official Keycloak image", url: "https://quay.io/repository/keycloak/keycloak", license: "Apache-2.0" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 1024,
    variables: [
      { name: "KEYCLOAK_ADMIN", type: "string", label: "Admin user", default: "admin" },
      { name: "KEYCLOAK_ADMIN_PASSWORD", type: "password", label: "Admin password", length: 20 },
      { name: "KEYCLOAK_PORT", type: "port", label: "Port", default: 8080 },
    ],
    endpoints: [
      { name: "Admin console", url: "http://localhost:${KEYCLOAK_PORT}", username: "${KEYCLOAK_ADMIN}", password: "${KEYCLOAK_ADMIN_PASSWORD}", primary: true },
    ],
    preflight: [],
    ready: { type: "http", url: "http://localhost:${KEYCLOAK_PORT}", expectStatus: [200, 302], timeoutSec: 150 },
    notes: "Runs in development mode (start-dev) — not for production use.",
    compose: `services:
  keycloak:
    image: quay.io/keycloak/keycloak:25.0
    command: start-dev
    environment:
      - KEYCLOAK_ADMIN=\${KEYCLOAK_ADMIN}
      - KEYCLOAK_ADMIN_PASSWORD=\${KEYCLOAK_ADMIN_PASSWORD}
    ports:
      - "127.0.0.1:\${KEYCLOAK_PORT}:8080"
    volumes:
      - keycloak-data:/opt/keycloak/data
volumes:
  keycloak-data:
`,
  },
  {
    id: "n8n",
    name: "n8n",
    description: "Workflow automation with a visual editor.",
    category: "devtools",
    tags: ["automation", "workflow", "integration"],
    icon: "n8n",
    website: "https://n8n.io",
    source: { name: "Official n8n image", url: "https://hub.docker.com/r/n8nio/n8n", license: "Sustainable Use License" },
    architectures: ["amd64", "arm64"],
    minMemoryMB: 512,
    variables: [
      { name: "N8N_PORT", type: "port", label: "Port", default: 5678 },
      { name: "N8N_USER", type: "string", label: "Basic-auth user", default: "admin" },
      { name: "N8N_PASSWORD", type: "password", label: "Basic-auth password", length: 20 },
    ],
    endpoints: [
      { name: "n8n", url: "http://localhost:${N8N_PORT}", username: "${N8N_USER}", password: "${N8N_PASSWORD}", primary: true },
    ],
    preflight: [],
    ready: { type: "running", timeoutSec: 60 },
    notes: null,
    compose: `services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:1.58.2
    environment:
      - N8N_BASIC_AUTH_ACTIVE=true
      - N8N_BASIC_AUTH_USER=\${N8N_USER}
      - N8N_BASIC_AUTH_PASSWORD=\${N8N_PASSWORD}
    ports:
      - "127.0.0.1:\${N8N_PORT}:5678"
    volumes:
      - n8n-data:/home/node/.n8n
volumes:
  n8n-data:
`,
  },
];

const mockCatalogById = new Map(mockCatalogItems.map((i) => [i.id, i]));

/** `marketplace_catalog`: always "builtin" in mock mode — there's no real
 * network fetch to simulate meaningfully differently here. */
export function mockMarketplaceCatalog(): CatalogResponse {
  return {
    items: mockCatalogItems,
    source: "builtin",
    fetchedAt: isoAgo(0),
    error: null,
  };
}

/** Deterministic per-item default values (generated passwords use the real
 * `generatePassword` helper so they look and behave like the real thing;
 * ports use each variable's declared default — `marketplace_prepare`'s "next
 * free port" allocation isn't meaningfully mockable without a real host). */
function defaultValuesFor(item: CatalogItem): Record<string, string> {
  const values: Record<string, string> = {};
  for (const v of item.variables) {
    if (v.type === "password") values[v.name] = generatePassword(v.length ?? 24);
    else values[v.name] = String(v.default ?? "");
  }
  return values;
}

export function mockMarketplacePrepare(itemId: string): MarketplacePrepareResult {
  const item = mockCatalogById.get(itemId);
  if (!item) throw new Error(`Unknown marketplace item "${itemId}"`);
  const values = defaultValuesFor(item);
  const existingNames = new Set(mockInstalledApps.map((a) => a.projectName));
  let projectName = `cd-${item.id}`;
  let n = 2;
  while (existingNames.has(projectName)) projectName = `cd-${item.id}-${n++}`;
  return {
    projectName,
    variables: item.variables.map((v) => ({
      name: v.name,
      label: v.label,
      type: v.type,
      value: values[v.name],
      hidden: v.hidden ?? false,
    })),
    preflight: mockMarketplacePreflight(itemId),
  };
}

// Tracks which fixable preflight checks have been "fixed" this session, so
// the elasticsearch-kibana demo item goes from failing to passing after the
// user clicks Fix — reset would require a page reload, same as any other
// in-memory mock state in this file.
const mockFixedPreflightChecks = new Set<string>();

export function mockMarketplacePreflight(itemId: string): PreflightResult[] {
  const item = mockCatalogById.get(itemId);
  if (!item) return [];
  const results: PreflightResult[] = [
    { id: `${itemId}:arch`, ok: true, severity: "error", message: "VM architecture is supported", fixable: false },
    { id: `${itemId}:memory`, ok: true, severity: "warning", message: "VM memory is sufficient", fixable: false },
    { id: `${itemId}:compose`, ok: true, severity: "error", message: "Docker Compose is available", fixable: false },
  ];
  for (const check of item.preflight) {
    if (check.type === "sysctl") {
      const id = `${itemId}:sysctl:${check.key}`;
      const fixed = mockFixedPreflightChecks.has(id);
      results.push({
        id,
        ok: fixed,
        severity: "error",
        message: fixed
          ? `${check.key} is set to at least ${check.min}`
          : `${check.key} must be at least ${check.min} (currently below the minimum)`,
        fixable: true,
      });
    }
  }
  return results;
}

export function mockMarketplaceFixPreflight(checkId: string): void {
  mockFixedPreflightChecks.add(checkId);
}

/** Builds the `InstalledApp` returned by `marketplace_install`, rendering
 * the item's endpoint templates against the submitted values. */
export function mockMarketplaceInstallResult(
  itemId: string,
  projectName: string,
  values: Record<string, string>,
): InstalledApp {
  const item = mockCatalogById.get(itemId);
  if (!item) throw new Error(`Unknown marketplace item "${itemId}"`);
  const app: InstalledApp = {
    projectName,
    itemId: item.id,
    name: item.name,
    icon: item.icon,
    createdAt: new Date().toISOString(),
    status: `running(${(item.compose.match(/^\s{2}\S.*:\s*$/gm) ?? []).length || 1})`,
    endpoints: renderEndpoints(item.endpoints, values),
    notes: item.notes,
  };
  mockInstalledApps = [app, ...mockInstalledApps.filter((a) => a.projectName !== projectName)];
  return app;
}

/** Two installed apps (one healthy, one "missing" — its containers were
 * removed outside the app, e.g. `docker compose down` from a terminal, so
 * the instance directory still exists but nothing is running) so the
 * Installed tab and its Credentials/Stop/Uninstall actions have something
 * to demo without going through Install first. */
let mockInstalledApps: InstalledApp[] = [
  {
    projectName: "cd-redis",
    itemId: "redis",
    name: "Redis",
    icon: "redis",
    createdAt: isoAgo(2 * 24 * 3600 * 1000),
    status: "running(1)",
    endpoints: renderEndpoints(mockCatalogById.get("redis")!.endpoints, {
      REDIS_PASSWORD: "kX8mQ2pL9vN4wR7t",
      REDIS_PORT: "6379",
    }),
    notes: mockCatalogById.get("redis")!.notes,
  },
  {
    projectName: "cd-postgres-pgadmin",
    itemId: "postgres-pgadmin",
    name: "Postgres + pgAdmin",
    icon: "postgresql",
    createdAt: isoAgo(9 * 24 * 3600 * 1000),
    status: "running(2)",
    endpoints: renderEndpoints(mockCatalogById.get("postgres-pgadmin")!.endpoints, {
      PG_USER: "app",
      PG_PASSWORD: "aZ3fG8hJ2kL9mN4p",
      PG_PORT: "5432",
      PGADMIN_PORT: "8081",
      PGADMIN_PASSWORD: "qW7eR4tY1uI8oP2s",
    }),
    notes: mockCatalogById.get("postgres-pgadmin")!.notes,
  },
  {
    projectName: "cd-n8n",
    itemId: "n8n",
    name: "n8n",
    icon: "n8n",
    createdAt: isoAgo(30 * 24 * 3600 * 1000),
    status: "missing",
    endpoints: renderEndpoints(mockCatalogById.get("n8n")!.endpoints, {
      N8N_PORT: "5678",
      N8N_USER: "admin",
      N8N_PASSWORD: "vB6nM3cX0zL7kJ4h",
    }),
    notes: "Containers for this app were not found — they may have been removed outside Colima Desktop.",
  },
];

export function mockMarketplaceInstalled(): InstalledApp[] {
  return mockInstalledApps;
}

export function mockMarketplaceUninstall(projectName: string): void {
  mockInstalledApps = mockInstalledApps.filter((a) => a.projectName !== projectName);
}
