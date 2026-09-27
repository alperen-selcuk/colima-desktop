import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronDown, Rocket, RotateCw, ScrollText, Settings2, TerminalSquare, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { K8sKind, ProfileStatus } from "../lib/types";
import { relativeAge } from "../lib/format";
import { Table, Thead, Th, Td, Tr, TableStatusRow } from "../components/Table";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusDot, statusTone } from "../components/StatusDot";
import { useToast } from "../components/Toasts";
import { K8sDetail } from "../components/K8sDetail";
import { KubeconfigHealthNotice } from "../components/KubeconfigHealthNotice";
import { QueryErrorBanner } from "../components/QueryErrorBanner";
import { ScaleDialog } from "../dialogs/ScaleDialog";
import { useDock } from "../lib/useDock";

type Tab = "pods" | "deployments" | "services" | "nodes";

interface KubernetesPageProps {
  profile: string;
  status: ProfileStatus | null | undefined;
  /** Whether a lifecycle op (start/stop/…) is in flight for this profile. */
  busy: boolean;
  /** Plain "Start" (existing lifecycle), for the not-running empty state. */
  onStart: () => void;
  /** Opens the configuration editor on the Kubernetes section with
   * `kubernetes.enabled: true` pre-applied, for "Start with Kubernetes…"
   * (machine not running). */
  onStartWithKubernetes: () => void;
  /** Same configuration editor entry point, for "Enable permanently…"
   * (machine running, k8s off). */
  onEnablePermanently: () => void;
}

interface Selection {
  kind: K8sKind;
  namespace: string | null;
  name: string;
  containers?: string[];
}

export function KubernetesPage({
  profile,
  status,
  busy,
  onStart,
  onStartWithKubernetes,
  onEnablePermanently,
}: KubernetesPageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dock = useDock();
  const [tab, setTab] = useState<Tab>("pods");
  const [namespace, setNamespace] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [confirmDeletePod, setConfirmDeletePod] = useState<{ namespace: string; name: string } | null>(null);
  const [scaleTarget, setScaleTarget] = useState<{ namespace: string; name: string; replicas: number } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"reset" | "delete" | null>(null);
  const [healthNoticeDismissed, setHealthNoticeDismissed] = useState(false);

  // §6.5 state machine, based only on `status` (never guess from `Profile.status`
  // — `profile_status` returning null IS "not running", see §4).
  const machineRunning = status != null;
  const enabled = status?.kubernetes === true;

  const namespacesQuery = useQuery({
    queryKey: ["k8sNamespaces", profile],
    queryFn: () => api.k8sNamespaces(profile),
    enabled,
    refetchInterval: enabled ? 5000 : false,
  });

  const podsQuery = useQuery({
    queryKey: ["k8sPods", profile, namespace],
    queryFn: () => api.k8sPods(profile, namespace),
    enabled: enabled && tab === "pods",
    refetchInterval: enabled && tab === "pods" ? 3000 : false,
  });

  const deploymentsQuery = useQuery({
    queryKey: ["k8sDeployments", profile, namespace],
    queryFn: () => api.k8sDeployments(profile, namespace),
    enabled: enabled && tab === "deployments",
    refetchInterval: enabled && tab === "deployments" ? 3000 : false,
  });

  const servicesQuery = useQuery({
    queryKey: ["k8sServices", profile, namespace],
    queryFn: () => api.k8sServices(profile, namespace),
    enabled: enabled && tab === "services",
    refetchInterval: enabled && tab === "services" ? 3000 : false,
  });

  const nodesQuery = useQuery({
    queryKey: ["k8sNodes", profile],
    queryFn: () => api.k8sNodes(profile),
    enabled: enabled && tab === "nodes",
    refetchInterval: enabled && tab === "nodes" ? 3000 : false,
  });

  // Terminal kubectl health (§2.1a): whether the user's own `~/.kube/config`
  // would work for this context, independent of whether the app itself
  // (via the app-managed kubeconfig) can reach the cluster just fine.
  const healthQuery = useQuery({
    queryKey: ["hostKubeconfigHealth", profile],
    queryFn: () => api.hostKubeconfigHealth(profile),
    enabled,
    refetchInterval: enabled ? 30000 : false,
  });
  const showHealthNotice =
    enabled && !healthNoticeDismissed && healthQuery.data?.contextExists === true && healthQuery.data.credentialsMatch === false;

  // Quick "Enable Kubernetes" (§6.5): this-session-only, since it calls
  // `kubernetes_action` directly rather than persisting `kubernetes.enabled`
  // into colima.yaml. Only ever called while `machineRunning` (the button
  // that triggers it doesn't render otherwise), but the guard is repeated
  // here as defense-in-depth — and the backend itself now refuses the call
  // with a friendly error rather than colima's raw output either way (§6.5).
  const handleEnableQuick = async () => {
    if (!machineRunning) return;
    try {
      await api.kubernetesAction(profile, "start");
      toast.success("Enabling Kubernetes for this session");
      queryClient.invalidateQueries({ queryKey: ["profileStatus", profile] });
    } catch (e) {
      toast.error("Failed to enable Kubernetes", String(e));
    }
  };

  const handleMenuAction = async (action: "reset" | "delete") => {
    setMenuOpen(false);
    try {
      await api.kubernetesAction(profile, action);
      toast.success(`Kubernetes ${action} started`);
      queryClient.invalidateQueries({ queryKey: ["profileStatus", profile] });
    } catch (e) {
      toast.error(`Failed to ${action} Kubernetes`, String(e));
    }
  };

  const handleDeletePod = async () => {
    if (!confirmDeletePod) return;
    try {
      await api.k8sDeletePod(profile, confirmDeletePod.namespace, confirmDeletePod.name);
      toast.success(`Deleting pod ${confirmDeletePod.name}`);
      queryClient.invalidateQueries({ queryKey: ["k8sPods", profile] });
    } catch (e) {
      toast.error("Failed to delete pod", String(e));
    }
  };

  const handleRestartDeployment = async (ns: string, name: string) => {
    try {
      await api.k8sRestartDeployment(profile, ns, name);
      toast.success(`Restarting ${name}`);
    } catch (e) {
      toast.error(`Failed to restart ${name}`, String(e));
    }
  };

  // Machine not running (§6.5): no error toast, no `kubernetes_action` call —
  // just an empty state pointing at the two ways to get a running machine
  // with Kubernetes on.
  if (!machineRunning) {
    return (
      <EmptyState
        icon={Boxes}
        title="Kubernetes needs the machine to be running"
        message={`Start ${profile} with Kubernetes enabled?`}
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={onStartWithKubernetes} disabled={busy}>
              <Rocket size={12} /> {busy ? "Starting…" : "Start with Kubernetes…"}
            </Button>
            <Button variant="secondary" size="sm" onClick={onStart} disabled={busy}>
              {busy ? "Starting…" : "Start"}
            </Button>
          </div>
        }
      />
    );
  }

  // Running, Kubernetes off (§6.5): quick enable (this session only) vs.
  // enable permanently via the configuration editor.
  if (!enabled) {
    return (
      <EmptyState
        icon={Boxes}
        title="Kubernetes is not enabled for this machine"
        message="Enable Kubernetes to browse pods, deployments, services and nodes. Quick-enabling only lasts for this session; enabling permanently persists it to the machine's configuration."
        action={
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={handleEnableQuick}>
              Enable Kubernetes
            </Button>
            <Button variant="secondary" size="sm" onClick={onEnablePermanently}>
              <Settings2 size={12} /> Enable permanently…
            </Button>
          </div>
        }
      />
    );
  }

  const contextName = profile === "default" ? "colima" : `colima-${profile}`;
  const namespaces = namespacesQuery.data ?? [];

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="font-mono-app text-[12px]" style={{ color: "var(--text-faint)" }}>
            {contextName}
          </span>
          <select
            value={namespace ?? ""}
            onChange={(e) => setNamespace(e.target.value || null)}
            className="rounded border px-2 py-1 text-[12px] outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          >
            <option value="">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <div className="ml-auto relative">
            <Button variant="secondary" size="sm" onClick={() => setMenuOpen((v) => !v)}>
              Manage <ChevronDown size={12} />
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div
                  className="absolute right-0 top-full z-20 mt-1 min-w-[160px] rounded-md border py-1 shadow-lg"
                  style={{ background: "var(--surface-1)", borderColor: "var(--border)" }}
                >
                  <button
                    onClick={() => setConfirmAction("reset")}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--text)" }}
                  >
                    Reset cluster
                  </button>
                  <button
                    onClick={() => setConfirmAction("delete")}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                    style={{ color: "var(--danger)" }}
                  >
                    Disable Kubernetes
                  </button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex border-b px-4" style={{ borderColor: "var(--border)" }}>
          {(["pods", "deployments", "services", "nodes"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="px-3 py-2 text-[12.5px] font-medium capitalize"
              style={{
                color: tab === t ? "var(--accent)" : "var(--text-dim)",
                borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {showHealthNotice && (
          <div className="px-4 pt-3">
            <KubeconfigHealthNotice
              profile={profile}
              contextName={contextName}
              onDismiss={() => setHealthNoticeDismissed(true)}
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
          {tab === "pods" && (
            <>
              {namespacesQuery.isError && (
                <div className="mb-3">
                  <QueryErrorBanner error={namespacesQuery.error} onRetry={() => namespacesQuery.refetch()} />
                </div>
              )}
              {podsQuery.isError ? (
                <QueryErrorBanner error={podsQuery.error} onRetry={() => podsQuery.refetch()} />
              ) : (
                <Table>
                  <Thead>
                    <Th style={{ width: 20 }} />
                    <Th>Name</Th>
                    <Th>Namespace</Th>
                    <Th>Status</Th>
                    <Th>Ready</Th>
                    <Th>Restarts</Th>
                    <Th>Age</Th>
                    <Th>Node</Th>
                    <Th style={{ width: 140 }}>Actions</Th>
                  </Thead>
                  <tbody>
                    {podsQuery.isLoading ? (
                      <TableStatusRow colSpan={9}>Loading pods…</TableStatusRow>
                    ) : (podsQuery.data ?? []).length === 0 ? (
                      <TableStatusRow colSpan={9}>No pods in {namespace ?? "any namespace"}</TableStatusRow>
                    ) : (
                      (podsQuery.data ?? []).map((p) => (
                        <Tr
                          key={`${p.namespace}/${p.name}`}
                          onClick={() =>
                            setSelection({ kind: "pod", namespace: p.namespace, name: p.name, containers: p.containers })
                          }
                          selected={selection?.kind === "pod" && selection.name === p.name && selection.namespace === p.namespace}
                        >
                          <Td>
                            <StatusDot tone={statusTone(p.status)} pulse={statusTone(p.status) === "good"} />
                          </Td>
                          <Td className="font-medium">{p.name}</Td>
                          <Td style={{ color: "var(--text-dim)" }}>{p.namespace}</Td>
                          <Td style={{ color: statusTone(p.status) === "bad" ? "var(--danger)" : "var(--text-dim)" }}>
                            {p.status}
                          </Td>
                          <Td className="font-mono-app">{p.ready}</Td>
                          <Td className="font-mono-app" style={{ color: p.restarts > 0 ? "var(--warn)" : "var(--text-dim)" }}>
                            {p.restarts}
                          </Td>
                          <Td style={{ color: "var(--text-dim)" }}>{relativeAge(p.createdAt)}</Td>
                          <Td style={{ color: "var(--text-dim)" }}>{p.node ?? "—"}</Td>
                          <Td>
                            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Logs"
                                onClick={() => setSelection({ kind: "pod", namespace: p.namespace, name: p.name, containers: p.containers })}
                              >
                                <ScrollText size={11} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Shell"
                                onClick={() =>
                                  dock.openTerminalTab(
                                    { kind: "pod", namespace: p.namespace, pod: p.name, container: null },
                                    profile,
                                  )
                                }
                              >
                                <TerminalSquare size={11} />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Delete"
                                onClick={() => setConfirmDeletePod({ namespace: p.namespace, name: p.name })}
                              >
                                <Trash2 size={11} style={{ color: "var(--danger)" }} />
                              </Button>
                            </div>
                          </Td>
                        </Tr>
                      ))
                    )}
                  </tbody>
                </Table>
              )}
            </>
          )}

          {tab === "deployments" &&
            (deploymentsQuery.isError ? (
              <QueryErrorBanner error={deploymentsQuery.error} onRetry={() => deploymentsQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Ready</Th>
                  <Th>Up-to-date</Th>
                  <Th>Available</Th>
                  <Th>Age</Th>
                  <Th>Images</Th>
                  <Th style={{ width: 120 }}>Actions</Th>
                </Thead>
                <tbody>
                  {deploymentsQuery.isLoading ? (
                    <TableStatusRow colSpan={8}>Loading deployments…</TableStatusRow>
                  ) : (deploymentsQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={8}>No deployments in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (deploymentsQuery.data ?? []).map((d) => (
                      <Tr
                        key={`${d.namespace}/${d.name}`}
                        onClick={() => setSelection({ kind: "deployment", namespace: d.namespace, name: d.name })}
                        selected={selection?.kind === "deployment" && selection.name === d.name && selection.namespace === d.namespace}
                      >
                        <Td className="font-medium">{d.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{d.namespace}</Td>
                        <Td className="font-mono-app">{d.ready}</Td>
                        <Td className="font-mono-app">{d.upToDate}</Td>
                        <Td className="font-mono-app">{d.available}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(d.createdAt)}</Td>
                        <Td className="font-mono-app text-[11px] truncate max-w-[180px]" style={{ color: "var(--text-faint)" }}>
                          {d.images.join(", ")}
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Scale"
                              onClick={() => setScaleTarget({ namespace: d.namespace, name: d.name, replicas: d.replicas })}
                            >
                              {d.replicas}x
                            </Button>
                            <Button variant="ghost" size="sm" title="Restart" onClick={() => handleRestartDeployment(d.namespace, d.name)}>
                              <RotateCw size={11} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "services" &&
            (servicesQuery.isError ? (
              <QueryErrorBanner error={servicesQuery.error} onRetry={() => servicesQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Type</Th>
                  <Th>Cluster IP</Th>
                  <Th>External IP</Th>
                  <Th>Ports</Th>
                  <Th>Age</Th>
                </Thead>
                <tbody>
                  {servicesQuery.isLoading ? (
                    <TableStatusRow colSpan={7}>Loading services…</TableStatusRow>
                  ) : (servicesQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={7}>No services in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (servicesQuery.data ?? []).map((s) => (
                      <Tr key={`${s.namespace}/${s.name}`}>
                        <Td className="font-medium">{s.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{s.namespace}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{s.type}</Td>
                        <Td className="font-mono-app">{s.clusterIp}</Td>
                        <Td className="font-mono-app">{s.externalIp ?? "—"}</Td>
                        <Td className="font-mono-app text-[11px]">{s.ports}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(s.createdAt)}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "nodes" &&
            (nodesQuery.isError ? (
              <QueryErrorBanner error={nodesQuery.error} onRetry={() => nodesQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Roles</Th>
                  <Th>Version</Th>
                  <Th>Internal IP</Th>
                  <Th>OS</Th>
                  <Th>CPU</Th>
                  <Th>Memory</Th>
                  <Th>Age</Th>
                </Thead>
                <tbody>
                  {nodesQuery.isLoading ? (
                    <TableStatusRow colSpan={9}>Loading nodes…</TableStatusRow>
                  ) : (nodesQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={9}>No nodes found</TableStatusRow>
                  ) : (
                    (nodesQuery.data ?? []).map((n) => (
                      <Tr key={n.name}>
                        <Td className="font-medium">{n.name}</Td>
                        <Td>
                          <span className="flex items-center gap-1.5">
                            <StatusDot tone={statusTone(n.status)} /> {n.status}
                          </span>
                        </Td>
                        <Td style={{ color: "var(--text-dim)" }}>{n.roles}</Td>
                        <Td className="font-mono-app text-[11px]">{n.version}</Td>
                        <Td className="font-mono-app">{n.internalIp ?? "—"}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{n.osImage}</Td>
                        <Td className="font-mono-app">{n.cpu}</Td>
                        <Td className="font-mono-app">{n.memory}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(n.createdAt)}</Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}
        </div>
      </div>

      {selection && (
        <K8sDetail
          profile={profile}
          kind={selection.kind}
          namespace={selection.namespace}
          name={selection.name}
          containers={selection.containers}
          onClose={() => setSelection(null)}
        />
      )}

      <ConfirmDialog
        open={!!confirmDeletePod}
        onClose={() => setConfirmDeletePod(null)}
        onConfirm={handleDeletePod}
        title={`Delete pod ${confirmDeletePod?.name ?? ""}`}
        message="The pod will be deleted without waiting for graceful termination to complete in the UI."
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={confirmAction === "reset"}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => handleMenuAction("reset")}
        title="Reset Kubernetes cluster"
        message="This resets the Kubernetes cluster state. Workloads will be recreated from scratch."
        confirmLabel="Reset"
        danger={false}
      />

      <ConfirmDialog
        open={confirmAction === "delete"}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => handleMenuAction("delete")}
        title="Disable Kubernetes"
        message="This deletes the Kubernetes cluster for this machine. Workload definitions not stored elsewhere will be lost."
        confirmLabel="Disable"
      />

      {scaleTarget && (
        <ScaleDialog
          open={!!scaleTarget}
          profile={profile}
          namespace={scaleTarget.namespace}
          name={scaleTarget.name}
          currentReplicas={scaleTarget.replicas}
          onClose={() => setScaleTarget(null)}
          onScaled={() => queryClient.invalidateQueries({ queryKey: ["k8sDeployments", profile] })}
        />
      )}
    </div>
  );
}
