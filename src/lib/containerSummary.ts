// Pure helpers for the Containers page's stat tiles and filter chips (§6.7).
// Kept dependency-free and unit-testable.
import type { Container, ContainerStats } from "./types";

export interface ContainerSummary {
  running: number;
  stopped: number; // anything not "running" (exited, created, paused, dead, restarting)
  composeProjects: number;
  totalCpuPercent: number; // sum of docker stats CPU% across running containers
  totalMemBytes: number; // sum of docker stats mem usage across running containers
}

/** Parses docker's "12.4MiB / 3.83GiB" memUsage string into the used-bytes
 * (first) value, or null if unparseable. Kept permissive: docker's `stats`
 * formatter uses binary units (B/KiB/MiB/GiB/TiB) with no space before the
 * unit for the "used" side. */
export function parseMemUsageBytes(memUsage: string): number | null {
  const match = /^([\d.]+)\s*([A-Za-z]+)/.exec(memUsage.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  const mult = multipliers[unit];
  return mult == null ? null : value * mult;
}

/** Parses docker's "1.85%" cpuPerc string into a plain number (1.85), or 0
 * if unparseable. */
export function parseCpuPercent(cpuPerc: string): number {
  const value = Number(cpuPerc.replace("%", "").trim());
  return Number.isFinite(value) ? value : 0;
}

/** Summarizes the *visible* container list (caller must already have
 * applied the "hide Kubernetes containers" filter — §6.7: "Counts, stat
 * tiles and prune hints exclude them unless shown") for the stat tiles row.
 * Compose project count is computed straight from the containers' own
 * `composeProject` label so it stays in sync with what's actually visible,
 * rather than depending on a separate `compose_projects` call. */
export function summarizeContainers(containers: Container[], statsById: Map<string, ContainerStats>): ContainerSummary {
  let running = 0;
  let stopped = 0;
  let totalCpuPercent = 0;
  let totalMemBytes = 0;
  const projects = new Set<string>();

  for (const c of containers) {
    if (c.state === "running") running++;
    else stopped++;
    if (c.composeProject) projects.add(c.composeProject);

    const stats = statsById.get(c.id);
    if (stats && c.state === "running") {
      totalCpuPercent += parseCpuPercent(stats.cpuPerc);
      totalMemBytes += parseMemUsageBytes(stats.memUsage) ?? 0;
    }
  }

  return { running, stopped, composeProjects: projects.size, totalCpuPercent, totalMemBytes };
}

// ---------------------------------------------------------------------------
// "Show Kubernetes containers" persisted toggle (§6.7)
// ---------------------------------------------------------------------------

const SHOW_K8S_CONTAINERS_KEY = "colima-desktop.showKubernetesContainers";

/** Default off: k3s runs every pod container (and `k8s_POD_...` sandboxes)
 * as a plain docker container, which is overwhelming noise on the
 * Containers page and includes exited leftovers that persist even when
 * Kubernetes is disabled — the motivating bug this toggle fixes. */
export function readShowKubernetesContainers(): boolean {
  try {
    return window.localStorage.getItem(SHOW_K8S_CONTAINERS_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeShowKubernetesContainers(value: boolean): void {
  try {
    window.localStorage.setItem(SHOW_K8S_CONTAINERS_KEY, value ? "true" : "false");
  } catch {
    // ignore (private mode, quota, ...)
  }
}

/** Filters out Kubernetes-managed containers unless `show` is true. This is
 * the *only* gate the Containers page needs — Kubernetes pods/sandboxes
 * never have a legitimate reason to appear as ordinary containers when
 * Kubernetes is off, and when it's on they're still hidden by default. */
export function filterKubernetesContainers(containers: Container[], show: boolean): Container[] {
  if (show) return containers;
  return containers.filter((c) => c.kubernetes == null);
}

export type ContainerFilterChip = "all" | "running" | "stopped" | "compose";

/** Applies one of the Containers page's filter chips on top of the
 * "Kubernetes containers hidden/shown" + search filtering already done by
 * the caller. */
export function applyFilterChip(containers: Container[], chip: ContainerFilterChip): Container[] {
  switch (chip) {
    case "all":
      return containers;
    case "running":
      return containers.filter((c) => c.state === "running");
    case "stopped":
      return containers.filter((c) => c.state !== "running");
    case "compose":
      return containers.filter((c) => c.composeProject != null);
  }
}
