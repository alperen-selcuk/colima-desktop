import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyFilterChip,
  filterKubernetesContainers,
  parseCpuPercent,
  parseMemUsageBytes,
  readShowKubernetesContainers,
  summarizeContainers,
  writeShowKubernetesContainers,
} from "./containerSummary";
import type { Container, ContainerStats } from "./types";
import { installMemoryLocalStorage } from "./testUtils/memoryLocalStorage";

// See compose.test.ts for why this is needed: no jsdom/happy-dom environment
// is configured for this suite (plain Node), so `window.localStorage` must
// be stubbed for the tests that exercise the persisted toggle below.
beforeAll(() => {
  installMemoryLocalStorage();
});

function makeContainer(overrides: Partial<Container>): Container {
  return {
    id: "id",
    names: "name",
    image: "image",
    command: "cmd",
    state: "running",
    status: "Up",
    ports: "",
    portLinks: [],
    createdAt: "",
    runningFor: "",
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    composeConfigFiles: [],
    kubernetes: null,
    ...overrides,
  };
}

function makeStats(overrides: Partial<ContainerStats>): ContainerStats {
  return {
    id: "id",
    name: "name",
    cpuPerc: "0.00%",
    memUsage: "0B / 0B",
    memPerc: "0.00%",
    netIO: "0B / 0B",
    blockIO: "0B / 0B",
    pids: "1",
    ...overrides,
  };
}

describe("parseMemUsageBytes", () => {
  it("parses MiB", () => {
    expect(parseMemUsageBytes("12.4MiB / 3.83GiB")).toBeCloseTo(12.4 * 1024 * 1024, 0);
  });

  it("parses GiB", () => {
    expect(parseMemUsageBytes("1.5GiB / 3.83GiB")).toBeCloseTo(1.5 * 1024 ** 3, 0);
  });

  it("parses plain bytes", () => {
    expect(parseMemUsageBytes("512B / 3.83GiB")).toBe(512);
  });

  it("returns null for unparseable input", () => {
    expect(parseMemUsageBytes("")).toBeNull();
    expect(parseMemUsageBytes("garbage")).toBeNull();
  });
});

describe("parseCpuPercent", () => {
  it("parses a percentage string", () => {
    expect(parseCpuPercent("1.85%")).toBeCloseTo(1.85);
  });

  it("returns 0 for unparseable input", () => {
    expect(parseCpuPercent("")).toBe(0);
    expect(parseCpuPercent("n/a")).toBe(0);
  });
});

describe("summarizeContainers", () => {
  it("counts running vs stopped and distinct compose projects", () => {
    const containers = [
      makeContainer({ id: "1", state: "running", composeProject: "myapp" }),
      makeContainer({ id: "2", state: "running", composeProject: "myapp" }),
      makeContainer({ id: "3", state: "exited", composeProject: null }),
      makeContainer({ id: "4", state: "paused", composeProject: "other" }),
    ];
    const summary = summarizeContainers(containers, new Map());
    expect(summary.running).toBe(2);
    expect(summary.stopped).toBe(2);
    expect(summary.composeProjects).toBe(2);
  });

  it("sums CPU% and memory bytes across running containers only", () => {
    const containers = [
      makeContainer({ id: "1", state: "running" }),
      makeContainer({ id: "2", state: "exited" }),
    ];
    const statsById = new Map([
      ["1", makeStats({ id: "1", cpuPerc: "2.00%", memUsage: "10MiB / 1GiB" })],
      ["2", makeStats({ id: "2", cpuPerc: "99.00%", memUsage: "500MiB / 1GiB" })],
    ]);
    const summary = summarizeContainers(containers, statsById);
    expect(summary.totalCpuPercent).toBeCloseTo(2.0);
    expect(summary.totalMemBytes).toBeCloseTo(10 * 1024 * 1024, 0);
  });

  it("returns zeros for an empty container list", () => {
    const summary = summarizeContainers([], new Map());
    expect(summary).toEqual({ running: 0, stopped: 0, composeProjects: 0, totalCpuPercent: 0, totalMemBytes: 0 });
  });
});

describe("applyFilterChip", () => {
  const containers = [
    makeContainer({ id: "1", state: "running", composeProject: "myapp" }),
    makeContainer({ id: "2", state: "exited", composeProject: null }),
    makeContainer({ id: "3", state: "paused", composeProject: "other" }),
  ];

  it("'all' returns everything unchanged", () => {
    expect(applyFilterChip(containers, "all")).toEqual(containers);
  });

  it("'running' keeps only running containers", () => {
    expect(applyFilterChip(containers, "running").map((c) => c.id)).toEqual(["1"]);
  });

  it("'stopped' keeps everything not running", () => {
    expect(applyFilterChip(containers, "stopped").map((c) => c.id)).toEqual(["2", "3"]);
  });

  it("'compose' keeps only containers with a compose project", () => {
    expect(applyFilterChip(containers, "compose").map((c) => c.id)).toEqual(["1", "3"]);
  });
});

describe("filterKubernetesContainers", () => {
  const containers = [
    makeContainer({ id: "1", kubernetes: null }),
    makeContainer({ id: "2", kubernetes: { namespace: "default", pod: "api-abcde", container: "api" } }),
    makeContainer({ id: "3", kubernetes: { namespace: "kube-system", pod: "coredns-xyz", container: null } }),
  ];

  it("hides Kubernetes-managed containers by default (show=false)", () => {
    expect(filterKubernetesContainers(containers, false).map((c) => c.id)).toEqual(["1"]);
  });

  it("shows everything when show=true", () => {
    expect(filterKubernetesContainers(containers, true)).toEqual(containers);
  });
});

describe("readShowKubernetesContainers / writeShowKubernetesContainers", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to false when nothing is stored", () => {
    expect(readShowKubernetesContainers()).toBe(false);
  });

  it("round-trips true", () => {
    writeShowKubernetesContainers(true);
    expect(readShowKubernetesContainers()).toBe(true);
  });

  it("round-trips false after being set true", () => {
    writeShowKubernetesContainers(true);
    writeShowKubernetesContainers(false);
    expect(readShowKubernetesContainers()).toBe(false);
  });
});
