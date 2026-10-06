import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Container as ContainerIcon,
  Filter,
  Pause,
  Play,
  RotateCw,
  Search,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import "../styles/containers.css";
import * as api from "../lib/api";
import type { Container, ContainerStats, ProfileStatus } from "../lib/types";
import { groupByComposeProject } from "../lib/format";
import {
  applyFilterChip,
  filterKubernetesContainers,
  readShowKubernetesContainers,
  summarizeContainers,
  writeShowKubernetesContainers,
  type ContainerFilterChip,
} from "../lib/containerSummary";
import { Table, Thead, Th, Td, Tr } from "../components/Table";
import { StatusDot, statusTone } from "../components/StatusDot";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { useDock } from "../lib/useDock";
import { ContainerDetail } from "../components/ContainerDetail";
import { ImageIcon } from "../components/containers/ImageIcon";
import { PortChips } from "../components/containers/PortChips";
import { ComposeGroupRow } from "../components/containers/ComposeGroupRow";
import { ComposeProjectDetail, type ComposeProjectDetailTab } from "../components/containers/ComposeProjectDetail";
import { ComposeDownConfirm } from "../components/containers/ComposeDownConfirm";
import { ComposeInstallHint } from "../components/containers/ComposeInstallHint";
import { UsageBar } from "../components/UsageBar";
import { RunContainerDialog } from "../dialogs/RunContainerDialog";
import { ComposeUpDialog } from "../dialogs/ComposeUpDialog";

interface ContainersPageProps {
  profile: string;
  status: ProfileStatus | null | undefined;
}

const FILTER_CHIPS: { id: ContainerFilterChip; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "stopped", label: "Stopped" },
  { id: "compose", label: "Compose" },
];

export function ContainersPage({ profile, status }: ContainersPageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dock = useDock();
  const [search, setSearch] = useState("");
  const [filterChip, setFilterChip] = useState<ContainerFilterChip>("all");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [showK8sContainers, setShowK8sContainers] = useState<boolean>(() => readShowKubernetesContainers());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [selectedProjectTab, setSelectedProjectTab] = useState<ComposeProjectDetailTab>("overview");
  const [confirmRemove, setConfirmRemove] = useState<Container | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [composeUpOpen, setComposeUpOpen] = useState(false);
  const [composeDownTarget, setComposeDownTarget] = useState<{ project: string; configFiles: string[] } | null>(null);

  const isDocker = status?.runtime === "docker";

  const containersQuery = useQuery({
    queryKey: ["containers", profile],
    queryFn: () => api.listContainers(profile),
    refetchInterval: isDocker ? 2000 : false,
    enabled: isDocker,
  });

  const statsQuery = useQuery({
    queryKey: ["containerStats", profile],
    queryFn: () => api.containerStats(profile),
    refetchInterval: isDocker ? 3000 : false,
    enabled: isDocker,
  });

  const composeInfoQuery = useQuery({
    queryKey: ["composeInfo", profile],
    queryFn: () => api.composeInfo(profile),
    enabled: isDocker,
    staleTime: 60_000,
  });

  const statsById = useMemo(() => {
    const map = new Map<string, ContainerStats>();
    for (const s of statsQuery.data ?? []) map.set(s.id, s);
    return map;
  }, [statsQuery.data]);

  if (!isDocker) {
    return (
      <EmptyState
        icon={ContainerIcon}
        title="Container view needs the docker runtime"
        message={`This machine is running the "${status?.runtime ?? "unknown"}" runtime. Switch the machine's runtime to docker (in its Start settings) to manage containers here.`}
      />
    );
  }

  const allContainers = containersQuery.data ?? [];
  const k8sCount = allContainers.filter((c) => c.kubernetes != null).length;
  const visibleContainers = filterKubernetesContainers(allContainers, showK8sContainers);
  const summary = summarizeContainers(visibleContainers, statsById);

  const chipFiltered = applyFilterChip(visibleContainers, filterChip);
  const searched = chipFiltered.filter((c) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.names.toLowerCase().includes(q) ||
      c.image.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    );
  });
  const groups = groupByComposeProject(searched);

  const composeInfo = composeInfoQuery.data;
  const composeAvailable = composeInfo?.available === true;

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleShowK8s = () => {
    setShowK8sContainers((prev) => {
      const next = !prev;
      writeShowKubernetesContainers(next);
      return next;
    });
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["containers", profile] });
    queryClient.invalidateQueries({ queryKey: ["containerStats", profile] });
  };

  const runAction = async (c: Container, action: Parameters<typeof api.containerAction>[2]) => {
    try {
      await api.containerAction(profile, c.id, action);
      invalidate();
    } catch (e) {
      toast.error(`Failed to ${action} ${c.names}`, String(e));
    }
  };

  const handleRemove = async () => {
    if (!confirmRemove) return;
    try {
      await api.containerAction(profile, confirmRemove.id, "remove");
      toast.success(`${confirmRemove.names} removed`);
      if (selectedId === confirmRemove.id) setSelectedId(null);
      invalidate();
    } catch (e) {
      toast.error(`Failed to remove ${confirmRemove.names}`, String(e));
    }
  };

  const handleTerminal = (c: Container) => {
    dock.openTerminalTab({ kind: "container", id: c.id }, profile);
  };

  /** Opens the compose project's detail panel (§6.7), closing the
   * container detail panel if one was open — the two are mutually
   * exclusive, same as selecting a different container closes the other. */
  const openProjectDetail = (project: string, tab: ComposeProjectDetailTab) => {
    setSelectedId(null);
    setSelectedProject(project);
    setSelectedProjectTab(tab);
  };

  const selectContainer = (id: string) => {
    setSelectedProject(null);
    setSelectedId(id);
  };

  const handleComposeAction = async (
    project: string,
    configFiles: string[],
    action: "stop" | "start" | "restart" | "pull",
  ) => {
    try {
      await api.composeAction(profile, project, action, configFiles, false);
      toast.success(`Compose ${project}: ${action}`);
      dock.openOutputTab();
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["composeInfo", profile] });
    } catch (e) {
      toast.error(`Failed to ${action} ${project}`, String(e));
    }
  };

  /** "Up" on an existing compose group row: re-runs `compose up -d` with the
   * project's already-known config files (no dialog — the file selection is
   * already known from the running containers' labels), unlike the "Compose
   * up…" toolbar button which is for starting a *new* project. */
  const handleComposeReUp = async (project: string, configFiles: string[]) => {
    try {
      await api.composeUp(profile, configFiles, project, false, "missing", false);
      toast.success(`Compose ${project} is coming up`);
      dock.openOutputTab();
      invalidate();
    } catch (e) {
      toast.error(`Failed to bring up ${project}`, String(e));
    }
  };

  const handleComposeDown = async (removeVolumes: boolean) => {
    if (!composeDownTarget) return;
    try {
      await api.composeAction(profile, composeDownTarget.project, "down", composeDownTarget.configFiles, removeVolumes);
      toast.success(`Compose ${composeDownTarget.project} is down`);
      dock.openOutputTab();
      invalidate();
    } catch (e) {
      toast.error(`Failed to bring down ${composeDownTarget.project}`, String(e));
    }
  };

  const selected = allContainers.find((c) => c.id === selectedId) ?? null;

  // Derived from `visibleContainers` (respects the "hide Kubernetes
  // containers" filter, not the search box / filter chips) so the panel
  // stays open and stable while the user types a search query or switches
  // filter chips — only closing the container list, not the panel, should
  // ever happen from those.
  const selectedProjectContainers = selectedProject
    ? visibleContainers.filter((c) => c.kubernetes == null && c.composeProject === selectedProject)
    : [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Header: whale mark + engine identity + compose status */}
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--docker-blue-soft)" }}
          >
            <DockerWhale size={16} color="var(--docker-blue)" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="text-[12.5px] font-medium" style={{ color: "var(--docker-blue)" }}>
              Docker Engine
            </span>
            <span className="font-mono-app text-[10.5px] truncate max-w-[380px]" style={{ color: "var(--text-faint)" }}>
              {profile} · {status?.dockerSocket ?? "unknown socket"}
            </span>
          </div>
          <div className="ml-2 flex items-center gap-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
            {composeInfoQuery.isLoading ? (
              <span>Checking Compose…</span>
            ) : composeAvailable ? (
              <span style={{ color: "var(--text-dim)" }}>Compose {composeInfo?.version ?? ""}</span>
            ) : (
              <span style={{ color: "var(--warn)" }}>Compose unavailable</span>
            )}
          </div>

          {/* Stat tiles */}
          <div className="ml-auto flex items-center gap-2">
            <StatTile value={summary.running} label="Running" />
            <StatTile value={summary.stopped} label="Stopped" />
            <StatTile value={summary.composeProjects} label="Compose projects" />
            <StatTile value={`${summary.totalCpuPercent.toFixed(1)}%`} label="CPU" />
            <StatTile value={formatMiB(summary.totalMemBytes)} label="Memory" />
          </div>
        </div>

        {/* Filter chips + search + actions */}
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="flex items-center gap-1.5">
            {FILTER_CHIPS.map((chip) => (
              <button
                key={chip.id}
                onClick={() => setFilterChip(chip.id)}
                className="ctr-chip"
                data-active={filterChip === chip.id}
              >
                {chip.label}
              </button>
            ))}
          </div>

          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setFilterMenuOpen((v) => !v)}>
              <Filter size={12} /> Filters <ChevronDown size={12} />
            </Button>
            {filterMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setFilterMenuOpen(false)} />
                <div
                  className="absolute left-0 top-full z-20 mt-1 min-w-[260px] rounded-md border py-1.5 px-1 shadow-lg"
                  style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
                >
                  <label
                    className="flex items-center gap-2 rounded px-2.5 py-1.5 text-[12px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--text)" }}
                  >
                    <input type="checkbox" checked={showK8sContainers} onChange={toggleShowK8s} />
                    Show Kubernetes containers ({k8sCount})
                  </label>
                </div>
              </>
            )}
          </div>

          <div className="relative flex-1 max-w-[280px]">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--text-faint)" }} />
            <input
              id="containers-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search containers…"
              className="w-full rounded-md border py-1.5 pl-8 pr-2.5 text-[12.5px] outline-none"
              style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {!composeInfoQuery.isLoading && !composeAvailable && (
              <div className="max-w-[280px]">
                <ComposeInstallHint hint={composeInfo?.hint ?? null} />
              </div>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setComposeUpOpen(true)}
              disabled={!composeAvailable}
              title={composeAvailable ? undefined : "Docker Compose isn't available for this machine"}
            >
              Compose up…
            </Button>
            <Button variant="primary" size="sm" onClick={() => setRunDialogOpen(true)}>
              Run container
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {groups.length === 0 ? (
            <EmptyState
              icon={ContainerIcon}
              title={allContainers.length === 0 ? "No containers" : "No containers match your filters"}
              message={
                allContainers.length === 0
                  ? "Run a container or start a Compose project to see it here."
                  : k8sCount > 0 && !showK8sContainers
                    ? `${k8sCount} Kubernetes-managed container${k8sCount === 1 ? " is" : "s are"} hidden. Use Filters to show them.`
                    : "Try a different search or filter."
              }
            />
          ) : (
            <Table>
              <Thead>
                <Th style={{ width: 20 }} />
                <Th>Name</Th>
                <Th>Image</Th>
                <Th>Status</Th>
                <Th>Ports</Th>
                <Th style={{ width: 110 }}>CPU</Th>
                <Th style={{ width: 110 }}>Mem</Th>
                <Th style={{ width: 170 }}>Actions</Th>
              </Thead>
              <tbody>
                {groups.map((group) => {
                  const key = group.project ?? "__standalone__";
                  const isCollapsed = collapsed.has(key);
                  const showHeader = group.project !== null;
                  const composeProjectMeta =
                    group.project != null
                      ? { project: group.project, configFiles: group.containers[0]?.composeConfigFiles ?? [] }
                      : null;
                  return (
                    <>
                      {showHeader && composeProjectMeta && (
                        <ComposeGroupRow
                          key={`header-${key}`}
                          project={composeProjectMeta.project}
                          status={aggregateStatus(group.containers)}
                          count={group.containers.length}
                          collapsed={isCollapsed}
                          selected={selectedProject === composeProjectMeta.project}
                          onToggle={() => toggleGroup(key)}
                          onOpenDetail={() => openProjectDetail(composeProjectMeta.project, "overview")}
                          colSpan={8}
                          onUp={() => handleComposeReUp(composeProjectMeta.project, composeProjectMeta.configFiles)}
                          onAction={(action) => {
                            if (action === "start" || action === "stop" || action === "restart" || action === "pull") {
                              handleComposeAction(composeProjectMeta.project, composeProjectMeta.configFiles, action);
                            }
                          }}
                          onDown={() => setComposeDownTarget(composeProjectMeta)}
                          onLogs={() => openProjectDetail(composeProjectMeta.project, "logs")}
                        />
                      )}
                      {!isCollapsed &&
                        group.containers.map((c) => {
                          const stats = statsById.get(c.id);
                          const running = c.state === "running";
                          return (
                            <Tr key={c.id} onClick={() => selectContainer(c.id)} selected={c.id === selectedId}>
                              <Td>
                                <StatusDot tone={statusTone(c.state)} pulse={running} />
                              </Td>
                              <Td>
                                <div className="flex items-center gap-2 min-w-0">
                                  <ImageIcon image={c.image} size={22} />
                                  <div className="min-w-0">
                                    <div className="truncate font-medium">{c.names}</div>
                                    {c.kubernetes && (
                                      <span className="ctr-k8s-badge mt-0.5">
                                        {c.kubernetes.namespace}/{c.kubernetes.pod}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </Td>
                              <Td className="font-mono-app text-[11.5px]" style={{ color: "var(--text-dim)" }}>
                                {c.image}
                              </Td>
                              <Td style={{ color: "var(--text-dim)" }}>{c.status}</Td>
                              <Td>
                                <PortChips portLinks={c.portLinks} />
                              </Td>
                              <Td>
                                <UsageBar
                                  kind="cpu"
                                  usedValue={stats ? parseCpuForBar(stats.cpuPerc) : null}
                                  limit={100}
                                  request={null}
                                  allocatable={null}
                                  metricsAvailable={!!stats}
                                />
                              </Td>
                              <Td>
                                <UsageBar
                                  kind="memory"
                                  usedValue={stats ? parseMemForBar(stats.memPerc) : null}
                                  limit={100}
                                  request={null}
                                  allocatable={null}
                                  metricsAvailable={!!stats}
                                />
                              </Td>
                              <Td>
                                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                  {running ? (
                                    <Button variant="ghost" size="sm" onClick={() => runAction(c, "stop")} title="Stop">
                                      <Square size={13} />
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="sm" onClick={() => runAction(c, "start")} title="Start">
                                      <Play size={13} />
                                    </Button>
                                  )}
                                  <Button variant="ghost" size="sm" onClick={() => runAction(c, "restart")} title="Restart">
                                    <RotateCw size={13} />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => runAction(c, c.state === "paused" ? "unpause" : "pause")}
                                    title={c.state === "paused" ? "Unpause" : "Pause"}
                                  >
                                    <Pause size={13} />
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => handleTerminal(c)} title="Terminal" disabled={!running}>
                                    <TerminalSquare size={13} />
                                  </Button>
                                  <Button variant="danger-outline" size="sm" onClick={() => setConfirmRemove(c)} title="Remove">
                                    <Trash2 size={13} />
                                  </Button>
                                </div>
                              </Td>
                            </Tr>
                          );
                        })}
                    </>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </div>

      {selected && (
        <ContainerDetail
          profile={profile}
          container={selected}
          stats={statsById.get(selected.id)}
          onClose={() => setSelectedId(null)}
        />
      )}

      {selectedProject && (
        <ComposeProjectDetail
          profile={profile}
          project={selectedProject}
          status={aggregateStatus(selectedProjectContainers)}
          configFiles={selectedProjectContainers[0]?.composeConfigFiles ?? []}
          containers={selectedProjectContainers}
          initialTab={selectedProjectTab}
          onClose={() => setSelectedProject(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={handleRemove}
        title={`Remove ${confirmRemove?.names ?? ""}`}
        message="This forcibly removes the container. Any data not in a volume will be lost."
        confirmLabel="Remove"
      />

      <RunContainerDialog
        open={runDialogOpen}
        profile={profile}
        onClose={() => setRunDialogOpen(false)}
        onRan={() => invalidate()}
        prefill={null}
      />

      <ComposeUpDialog
        open={composeUpOpen}
        profile={profile}
        onClose={() => setComposeUpOpen(false)}
        onStarted={() => {
          invalidate();
          queryClient.invalidateQueries({ queryKey: ["composeInfo", profile] });
        }}
      />

      <ComposeDownConfirm
        open={!!composeDownTarget}
        project={composeDownTarget?.project ?? null}
        onClose={() => setComposeDownTarget(null)}
        onConfirm={handleComposeDown}
      />
    </div>
  );
}

function StatTile({ value, label }: { value: string | number; label: string }) {
  return (
    <div className="ctr-stat-tile">
      <span className="ctr-stat-tile-value">{value}</span>
      <span className="ctr-stat-tile-label">{label}</span>
    </div>
  );
}

function formatMiB(bytes: number): string {
  if (bytes <= 0) return "0 MiB";
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${mib.toFixed(0)} MiB`;
}

/** docker's cpuPerc is already "usage / 100%" so it maps directly onto the
 * shared UsageBar's 0-100 "limit" convention. */
function parseCpuForBar(cpuPerc: string): number | null {
  const v = Number(cpuPerc.replace("%", "").trim());
  return Number.isFinite(v) ? v : null;
}

function parseMemForBar(memPerc: string): number | null {
  const v = Number(memPerc.replace("%", "").trim());
  return Number.isFinite(v) ? v : null;
}

/** Compact aggregate status text for a compose group header, e.g.
 * "running(2), exited(1)" — recomputed client-side from the visible
 * containers so it always matches what's actually shown (rather than
 * trusting the separate `compose_projects` snapshot, which can be stale
 * relative to the polled container list). */
function aggregateStatus(containers: Container[]): string {
  const counts = new Map<string, number>();
  for (const c of containers) counts.set(c.state, (counts.get(c.state) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([state, n]) => `${state}(${n})`)
    .join(", ");
}

/** Small Docker whale-and-containers glyph for the page header tile — drawn
 * in-house (not from simple-icons: Docker's own mark is trademarked and
 * reproducing its exact artwork isn't warranted for a small chrome icon;
 * this is a simplified silhouette in the app's own icon style). */
function DockerWhale({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" role="presentation" aria-hidden="true">
      <rect x="3" y="10.5" width="3" height="3" fill={color} />
      <rect x="6.6" y="10.5" width="3" height="3" fill={color} />
      <rect x="10.2" y="10.5" width="3" height="3" fill={color} />
      <rect x="6.6" y="6.8" width="3" height="3" fill={color} />
      <rect x="10.2" y="6.8" width="3" height="3" fill={color} />
      <path
        d="M21.5 12.2c-.55-.35-1.6-.45-2.35-.3-.05-.85-.55-1.55-1.35-2.15l-.3-.2-.25.3c-.35.5-.5 1.35-.2 2.1.15.35.4.7.7.9-.2.1-.55.25-1.05.25H2.5c-.15.75.05 2.9 1.55 4.4 1.1 1.1 2.65 1.5 4.5 1.5 4.4 0 7.7-2 9.3-5.65.05 0 .1 0 .15 0 1 0 1.9-.4 2.6-1.15l.15-.15-.25-.15Z"
        fill={color}
      />
    </svg>
  );
}
