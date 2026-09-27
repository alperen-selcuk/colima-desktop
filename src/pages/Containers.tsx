import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Container as ContainerIcon,
  ExternalLink,
  Pause,
  Play,
  RotateCw,
  Search,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import * as api from "../lib/api";
import type { Container, ContainerStats, ProfileStatus } from "../lib/types";
import { groupByComposeProject } from "../lib/format";
import { Table, Thead, Th, Td, Tr } from "../components/Table";
import { StatusDot, statusTone } from "../components/StatusDot";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { useDock } from "../lib/useDock";
import { ContainerDetail } from "../components/ContainerDetail";
import { RunContainerDialog } from "../dialogs/RunContainerDialog";

interface ContainersPageProps {
  profile: string;
  status: ProfileStatus | null | undefined;
}

async function openUrl(url: string) {
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}

export function ContainersPage({ profile, status }: ContainersPageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dock = useDock();
  const [search, setSearch] = useState("");
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Container | null>(null);
  const [runDialogOpen, setRunDialogOpen] = useState(false);
  const [pruneMenuOpen, setPruneMenuOpen] = useState(false);

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

  const containers = containersQuery.data ?? [];
  const filtered = containers.filter((c) => {
    if (onlyRunning && c.state !== "running") return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      c.names.toLowerCase().includes(q) ||
      c.image.toLowerCase().includes(q) ||
      c.id.toLowerCase().includes(q)
    );
  });
  const groups = groupByComposeProject(filtered);

  const toggleGroup = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  const handlePrune = async (what: "containers" | "images" | "volumes" | "system") => {
    setPruneMenuOpen(false);
    try {
      const output = await api.prune(profile, what);
      toast.success(`Pruned ${what}`, output);
      invalidate();
    } catch (e) {
      toast.error(`Failed to prune ${what}`, String(e));
    }
  };

  const handleTerminal = (c: Container) => {
    dock.openTerminalTab({ kind: "container", id: c.id }, profile);
  };

  const selected = containers.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3">
          <div className="relative flex-1 max-w-[320px]">
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
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--text-dim)" }}>
            <input type="checkbox" checked={onlyRunning} onChange={(e) => setOnlyRunning(e.target.checked)} />
            Only running
          </label>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Button variant="secondary" size="sm" onClick={() => setPruneMenuOpen((v) => !v)}>
                Prune <ChevronDown size={12} />
              </Button>
              {pruneMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setPruneMenuOpen(false)} />
                  <div
                    className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border py-1 shadow-lg"
                    style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
                  >
                    {(["containers", "images", "volumes", "system"] as const).map((w) => (
                      <button
                        key={w}
                        onClick={() => handlePrune(w)}
                        className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                        style={{ color: "var(--text)" }}
                      >
                        Prune {w}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <Button variant="primary" size="sm" onClick={() => setRunDialogOpen(true)}>
              Run container
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {groups.length === 0 ? (
            <EmptyState icon={ContainerIcon} title="No containers" message="Run a container to see it here." />
          ) : (
            <Table>
              <Thead>
                <Th style={{ width: 20 }} />
                <Th>Name</Th>
                <Th>Image</Th>
                <Th>Status</Th>
                <Th>Ports</Th>
                <Th>CPU</Th>
                <Th>Mem</Th>
                <Th style={{ width: 160 }}>Actions</Th>
              </Thead>
              <tbody>
                {groups.map((group) => {
                  const key = group.project ?? "__standalone__";
                  const isCollapsed = collapsed.has(key);
                  const showHeader = group.project !== null;
                  return (
                    <>
                      {showHeader && (
                        <tr
                          key={`header-${key}`}
                          className="cursor-pointer"
                          style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}
                          onClick={() => toggleGroup(key)}
                        >
                          <Td colSpan={8} className="py-1.5">
                            <div className="flex items-center gap-1.5 text-[11.5px] font-medium" style={{ color: "var(--text-dim)" }}>
                              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                              {group.project}
                              <span style={{ color: "var(--text-faint)" }}>({group.containers.length})</span>
                            </div>
                          </Td>
                        </tr>
                      )}
                      {!isCollapsed &&
                        group.containers.map((c) => {
                          const stats = statsById.get(c.id);
                          const running = c.state === "running";
                          return (
                            <Tr key={c.id} onClick={() => setSelectedId(c.id)} selected={c.id === selectedId}>
                              <Td>
                                <StatusDot tone={statusTone(c.state)} pulse={running} />
                              </Td>
                              <Td className="font-medium">{c.names}</Td>
                              <Td className="font-mono-app text-[11.5px]" style={{ color: "var(--text-dim)" }}>
                                {c.image}
                              </Td>
                              <Td style={{ color: "var(--text-dim)" }}>{c.status}</Td>
                              <Td>
                                <div className="flex flex-wrap gap-1">
                                  {c.portLinks.map((p, i) => (
                                    <button
                                      key={i}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        openUrl(p.url);
                                      }}
                                      className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono-app text-[11px] hover:underline"
                                      style={{ background: "var(--surface-2)", color: "var(--info)" }}
                                    >
                                      {p.hostPort}
                                      <ExternalLink size={9} />
                                    </button>
                                  ))}
                                </div>
                              </Td>
                              <Td className="font-mono-app" style={{ color: "var(--text-dim)" }}>
                                {stats?.cpuPerc ?? "—"}
                              </Td>
                              <Td className="font-mono-app" style={{ color: "var(--text-dim)" }}>
                                {stats?.memUsage ?? "—"}
                              </Td>
                              <Td>
                                <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                                  {running ? (
                                    <Button variant="ghost" size="sm" onClick={() => runAction(c, "stop")} title="Stop">
                                      <Square size={11} />
                                    </Button>
                                  ) : (
                                    <Button variant="ghost" size="sm" onClick={() => runAction(c, "start")} title="Start">
                                      <Play size={11} />
                                    </Button>
                                  )}
                                  <Button variant="ghost" size="sm" onClick={() => runAction(c, "restart")} title="Restart">
                                    <RotateCw size={11} />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => runAction(c, c.state === "paused" ? "unpause" : "pause")}
                                    title={c.state === "paused" ? "Unpause" : "Pause"}
                                  >
                                    <Pause size={11} />
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => handleTerminal(c)} title="Terminal" disabled={!running}>
                                    <TerminalSquare size={11} />
                                  </Button>
                                  <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(c)} title="Remove">
                                    <Trash2 size={11} style={{ color: "var(--danger)" }} />
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
    </div>
  );
}
