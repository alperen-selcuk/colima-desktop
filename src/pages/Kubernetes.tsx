import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightLeft,
  Boxes,
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  Rocket,
  RotateCw,
  ScrollText,
  Settings2,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import "../styles/k8s.css";
import * as api from "../lib/api";
import type {
  K8sConfigMap,
  K8sIngress,
  K8sKind,
  K8sNamespacedKind,
  K8sSecret,
  PortForward,
  ProfileStatus,
} from "../lib/types";
import type { CreatableKind } from "../lib/k8sManifests";
import { relativeAge } from "../lib/format";
import { ingressAllHosts, ingressHostUrl } from "../lib/k8sView";
import { Table, Thead, Th, Td, Tr, TableStatusRow } from "../components/Table";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StatusDot, statusTone } from "../components/StatusDot";
import { useToast } from "../components/Toasts";
import { K8sDetail } from "../components/K8sDetail";
import { K8sIcon, KIND_ACCENT_VAR, KIND_ACCENT_SOFT_VAR, KIND_LABEL } from "../components/k8s/K8sIcon";
import { UsageBar } from "../components/k8s/UsageBar";
import { K8sDeleteConfirm } from "../components/k8s/K8sDeleteConfirm";
import { KubeconfigConnectPanel } from "../components/KubeconfigConnectPanel";
import { KubeconfigHealthNotice } from "../components/KubeconfigHealthNotice";
import { QueryErrorBanner } from "../components/QueryErrorBanner";
import { ScaleDialog } from "../dialogs/ScaleDialog";
import { K8sEditDialog } from "../dialogs/K8sEditDialog";
import { K8sCreateDialog } from "../dialogs/K8sCreateDialog";
import { PortForwardDialog, type PortChoice } from "../dialogs/PortForwardDialog";
import { PortForwardsPanel } from "../components/k8s/PortForwardsPanel";
import { useDock } from "../lib/useDock";

type Tab = "pods" | "deployments" | "statefulsets" | "daemonsets" | "services" | "ingresses" | "configmaps" | "secrets" | "nodes";

const TABS: { id: Tab; label: string; kind: K8sKind }[] = [
  { id: "pods", label: "Pods", kind: "pod" },
  { id: "deployments", label: "Deployments", kind: "deployment" },
  { id: "statefulsets", label: "StatefulSets", kind: "statefulset" },
  { id: "daemonsets", label: "DaemonSets", kind: "daemonset" },
  { id: "services", label: "Services", kind: "service" },
  { id: "ingresses", label: "Ingresses", kind: "ingress" },
  { id: "configmaps", label: "ConfigMaps", kind: "configmap" },
  { id: "secrets", label: "Secrets", kind: "secret" },
  { id: "nodes", label: "Nodes", kind: "node" },
];

/** Tabs that have a "Create" form (§6.10). */
const CREATE_KIND: Partial<Record<Tab, CreatableKind>> = {
  pods: "pod",
  deployments: "deployment",
  statefulsets: "statefulset",
  daemonsets: "daemonset",
  services: "service",
  ingresses: "ingress",
};

interface PortForwardTarget {
  kind: "pod" | "service";
  namespace: string;
  name: string;
  ports: PortChoice[];
}

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
  configMap?: K8sConfigMap;
  secret?: K8sSecret;
  ingress?: K8sIngress;
}

interface EditTarget {
  kind: K8sNamespacedKind;
  namespace: string | null;
  name: string;
}

interface DeleteTarget {
  kind: K8sNamespacedKind;
  namespace: string | null;
  name: string;
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
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [scaleTarget, setScaleTarget] = useState<{
    kind: "deployment" | "statefulset";
    namespace: string;
    name: string;
    replicas: number;
  } | null>(null);
  const [createKind, setCreateKind] = useState<CreatableKind | null>(null);
  const [pfTarget, setPfTarget] = useState<PortForwardTarget | null>(null);
  const [pfOpen, setPfOpen] = useState(false);
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

  // Pod metrics refetch every 5s only while the Pods tab is visible (§6.6).
  const podMetricsQuery = useQuery({
    queryKey: ["k8sPodMetrics", profile, namespace],
    queryFn: () => api.k8sPodMetrics(profile, namespace),
    enabled: enabled && tab === "pods",
    refetchInterval: enabled && tab === "pods" ? 5000 : false,
  });

  const deploymentsQuery = useQuery({
    queryKey: ["k8sDeployments", profile, namespace],
    queryFn: () => api.k8sDeployments(profile, namespace),
    enabled: enabled && tab === "deployments",
    refetchInterval: enabled && tab === "deployments" ? 3000 : false,
  });

  const statefulSetsQuery = useQuery({
    queryKey: ["k8sStatefulSets", profile, namespace],
    queryFn: () => api.k8sStatefulSets(profile, namespace),
    enabled: enabled && tab === "statefulsets",
    refetchInterval: enabled && tab === "statefulsets" ? 3000 : false,
  });

  const daemonSetsQuery = useQuery({
    queryKey: ["k8sDaemonSets", profile, namespace],
    queryFn: () => api.k8sDaemonSets(profile, namespace),
    enabled: enabled && tab === "daemonsets",
    refetchInterval: enabled && tab === "daemonsets" ? 3000 : false,
  });

  // Active port-forwards (§6.10): global list from the backend, filtered to
  // this profile. Polled lightly; `port-forward-ended` also triggers a refetch.
  const forwardsQuery = useQuery({
    queryKey: ["k8sPortForwards"],
    queryFn: () => api.k8sPortForwardList(),
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });
  const forwards = (forwardsQuery.data ?? []).filter((f) => f.profile === profile);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void api
      .onPortForwardEnded((e) => {
        queryClient.invalidateQueries({ queryKey: ["k8sPortForwards"] });
        if (e.error) toast.error("Port-forward ended", e.error);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient, toast]);

  const servicesQuery = useQuery({
    queryKey: ["k8sServices", profile, namespace],
    queryFn: () => api.k8sServices(profile, namespace),
    enabled: enabled && tab === "services",
    refetchInterval: enabled && tab === "services" ? 3000 : false,
  });

  const ingressesQuery = useQuery({
    queryKey: ["k8sIngresses", profile, namespace],
    queryFn: () => api.k8sIngresses(profile, namespace),
    enabled: enabled && tab === "ingresses",
    refetchInterval: enabled && tab === "ingresses" ? 3000 : false,
  });

  const configMapsQuery = useQuery({
    queryKey: ["k8sConfigMaps", profile, namespace],
    queryFn: () => api.k8sConfigMaps(profile, namespace),
    enabled: enabled && tab === "configmaps",
    refetchInterval: enabled && tab === "configmaps" ? 3000 : false,
  });

  const secretsQuery = useQuery({
    queryKey: ["k8sSecrets", profile, namespace],
    queryFn: () => api.k8sSecrets(profile, namespace),
    enabled: enabled && tab === "secrets",
    refetchInterval: enabled && tab === "secrets" ? 3000 : false,
  });

  const nodesQuery = useQuery({
    queryKey: ["k8sNodes", profile],
    queryFn: () => api.k8sNodes(profile),
    enabled: enabled && tab === "nodes",
    refetchInterval: enabled && tab === "nodes" ? 3000 : false,
  });

  const nodeMetricsQuery = useQuery({
    queryKey: ["k8sNodeMetrics", profile],
    queryFn: () => api.k8sNodeMetrics(profile),
    enabled: enabled && tab === "nodes",
    refetchInterval: enabled && tab === "nodes" ? 5000 : false,
  });

  // Counts for tab badges: only the active tab polls; others show the last
  // known count (or nothing) rather than firing 7 extra queries per tick.
  const counts: Partial<Record<Tab, number>> = {
    pods: podsQuery.data?.length,
    deployments: deploymentsQuery.data?.length,
    statefulsets: statefulSetsQuery.data?.length,
    daemonsets: daemonSetsQuery.data?.length,
    services: servicesQuery.data?.length,
    ingresses: ingressesQuery.data?.length,
    configmaps: configMapsQuery.data?.length,
    secrets: secretsQuery.data?.length,
    nodes: nodesQuery.data?.length,
  };

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

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.k8sDelete(profile, deleteTarget.kind, deleteTarget.namespace, deleteTarget.name);
      toast.success(`Deleting ${deleteTarget.name}`);
      queryClient.invalidateQueries({ queryKey: [tabQueryKey(deleteTarget.kind), profile] });
      if (selection?.kind === deleteTarget.kind && selection.name === deleteTarget.name) setSelection(null);
    } catch (e) {
      toast.error(`Failed to delete ${deleteTarget.name}`, String(e));
    }
  };

  const handleRestart = async (kind: "deployment" | "statefulset" | "daemonset", ns: string, name: string) => {
    try {
      await api.k8sRestart(profile, kind, ns, name);
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

  const handleStopForward = async (pf: PortForward) => {
    try {
      await api.k8sPortForwardStop(pf.id);
      queryClient.invalidateQueries({ queryKey: ["k8sPortForwards"] });
    } catch (e) {
      toast.error("Failed to stop port-forward", String(e));
    }
  };

  const handleCopyForward = async (pf: PortForward) => {
    try {
      await navigator.clipboard.writeText(pf.url);
      toast.success("Copied URL", pf.url);
    } catch (e) {
      toast.error("Failed to copy", String(e));
    }
  };

  const podPortChoices = (ports: { name: string | null; containerPort: number; protocol: string }[]): PortChoice[] =>
    ports
      .filter((p) => p.protocol === "TCP")
      .map((p) => ({ port: p.containerPort, label: p.name ? `${p.containerPort} (${p.name})` : String(p.containerPort) }));

  const servicePortChoices = (ports: { name: string | null; port: number; protocol: string }[]): PortChoice[] =>
    ports.filter((p) => p.protocol === "TCP").map((p) => ({ port: p.port, label: p.name ? `${p.port} (${p.name})` : String(p.port) }));

  const contextName = profile === "default" ? "colima" : `colima-${profile}`;
  const namespaces = namespacesQuery.data ?? [];
  const k3sVersion = nodesQuery.data?.[0]?.version;

  const podMetricsByKey = new Map(
    (podMetricsQuery.data?.pods ?? []).map((m) => [`${m.namespace}/${m.name}`, m]),
  );
  const nodeMetricsByName = new Map((nodeMetricsQuery.data?.nodes ?? []).map((m) => [m.name, m]));
  const podMetricsAvailable = podMetricsQuery.data?.available ?? false;
  const nodeMetricsAvailable = nodeMetricsQuery.data?.available ?? false;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--border)" }}>
          <div
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
            style={{ background: "var(--k8s-blue-soft)" }}
          >
            <img src="/k8s-icons/wheel.svg" alt="" width={16} height={16} style={{ width: 16, height: 16 }} />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-mono-app text-[12.5px] font-medium" style={{ color: "var(--k8s-blue)" }}>
              {contextName}
            </span>
            {k3sVersion && (
              <span className="text-[10.5px]" style={{ color: "var(--text-faint)" }}>
                {k3sVersion}
              </span>
            )}
          </div>
          <select
            value={namespace ?? ""}
            onChange={(e) => setNamespace(e.target.value || null)}
            className="ml-2 rounded border px-2 py-1 text-[12px] outline-none"
            style={{ background: "var(--surface-2)", borderColor: "var(--border)", color: "var(--text)" }}
          >
            <option value="">All namespaces</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
          <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            title="Active port-forwards"
            onClick={() => setPfOpen((v) => !v)}
          >
            <ArrowRightLeft size={12} /> Port-forwards
            {forwards.length > 0 && <span className="k8s-pf-badge">{forwards.length}</span>}
          </Button>
          <div className="relative">
            <Button variant="secondary" size="sm" onClick={() => setMenuOpen((v) => !v)}>
              Manage <ChevronDown size={12} />
            </Button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                <div
                  className="menu absolute right-0 top-full z-20 mt-1 min-w-[160px]" role="menu"
                >
                  <button
                    onClick={() => setConfirmAction("reset")}
                    className="menu-item" role="menuitem"
                  >
                    Reset cluster
                  </button>
                  <button
                    onClick={() => setConfirmAction("delete")}
                    className="menu-item menu-item-danger" role="menuitem"
                  >
                    Disable Kubernetes
                  </button>
                </div>
              </>
            )}
          </div>
          </div>
        </div>

        {pfOpen && <PortForwardsPanel forwards={forwards} onStop={handleStopForward} onCopy={handleCopyForward} />}

        <div className="flex overflow-x-auto border-b px-2" style={{ borderColor: "var(--border)" }}>
          {TABS.map((t) => {
            const active = tab === t.id;
            const count = counts[t.id];
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className="k8s-tab"
                data-active={active}
                style={
                  active
                    ? ({
                        borderBottomColor: `var(${KIND_ACCENT_VAR[t.kind]})`,
                        ["--k8s-tab-accent" as string]: `var(${KIND_ACCENT_VAR[t.kind]})`,
                        ["--k8s-tab-accent-soft" as string]: `var(${KIND_ACCENT_SOFT_VAR[t.kind]})`,
                      } as React.CSSProperties)
                    : undefined
                }
              >
                <K8sIcon kind={t.kind} size={15} />
                {t.label}
                {count != null && <span className="k8s-tab-count">{count}</span>}
              </button>
            );
          })}
        </div>

        {enabled && <KubeconfigConnectPanel profile={profile} contextName={contextName} />}

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
          {CREATE_KIND[tab] && (
            <div className="mb-3 flex justify-end">
              <Button variant="primary" size="sm" onClick={() => setCreateKind(CREATE_KIND[tab] ?? null)}>
                <Plus size={12} /> Create {KIND_LABEL[CREATE_KIND[tab] as CreatableKind]}
              </Button>
            </div>
          )}
          {tab === "pods" && (
            <>
              {namespacesQuery.isError && (
                <div className="mb-3">
                  <QueryErrorBanner error={namespacesQuery.error} onRetry={() => namespacesQuery.refetch()} />
                </div>
              )}
              {!podMetricsAvailable && podMetricsQuery.data && (
                <div className="mb-2 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                  Metrics unavailable{podMetricsQuery.data.reason ? `: ${podMetricsQuery.data.reason}` : ""}
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
                    <Th style={{ width: 110 }}>CPU</Th>
                    <Th style={{ width: 110 }}>Memory</Th>
                    <Th>Age</Th>
                    <Th>Node</Th>
                    <Th style={{ width: 190 }}>Actions</Th>
                  </Thead>
                  <tbody>
                    {podsQuery.isLoading ? (
                      <TableStatusRow colSpan={11}>Loading pods…</TableStatusRow>
                    ) : (podsQuery.data ?? []).length === 0 ? (
                      <TableStatusRow colSpan={11}>No pods in {namespace ?? "any namespace"}</TableStatusRow>
                    ) : (
                      (podsQuery.data ?? []).map((p) => {
                        const metrics = podMetricsByKey.get(`${p.namespace}/${p.name}`);
                        return (
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
                            <Td>
                              <UsageBar
                                kind="cpu"
                                usedValue={metrics?.cpuMilli ?? null}
                                limit={p.cpuLimitMilli}
                                request={p.cpuRequestMilli}
                                allocatable={null}
                                metricsAvailable={podMetricsAvailable}
                              />
                            </Td>
                            <Td>
                              <UsageBar
                                kind="memory"
                                usedValue={metrics?.memBytes ?? null}
                                limit={p.memLimitBytes}
                                request={p.memRequestBytes}
                                allocatable={null}
                                metricsAvailable={podMetricsAvailable}
                              />
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
                                  <ScrollText size={13} />
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
                                  <TerminalSquare size={13} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Port forward…"
                                  onClick={() =>
                                    setPfTarget({
                                      kind: "pod",
                                      namespace: p.namespace,
                                      name: p.name,
                                      ports: podPortChoices(p.ports),
                                    })
                                  }
                                >
                                  <ArrowRightLeft size={13} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Edit"
                                  onClick={() => setEditTarget({ kind: "pod", namespace: p.namespace, name: p.name })}
                                >
                                  <Pencil size={13} />
                                </Button>
                                <Button
                                  variant="danger-outline"
                                  size="sm"
                                  title="Delete"
                                  onClick={() => setDeleteTarget({ kind: "pod", namespace: p.namespace, name: p.name })}
                                >
                                  <Trash2 size={13} />
                                </Button>
                              </div>
                            </Td>
                          </Tr>
                        );
                      })
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
                  <Th style={{ width: 160 }}>Actions</Th>
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
                              onClick={() => setScaleTarget({ kind: "deployment", namespace: d.namespace, name: d.name, replicas: d.replicas })}
                            >
                              {d.replicas}x
                            </Button>
                            <Button variant="ghost" size="sm" title="Restart" onClick={() => handleRestart("deployment", d.namespace, d.name)}>
                              <RotateCw size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "deployment", namespace: d.namespace, name: d.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "deployment", namespace: d.namespace, name: d.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "statefulsets" &&
            (statefulSetsQuery.isError ? (
              <QueryErrorBanner error={statefulSetsQuery.error} onRetry={() => statefulSetsQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Ready</Th>
                  <Th>Service</Th>
                  <Th>Age</Th>
                  <Th>Images</Th>
                  <Th style={{ width: 160 }}>Actions</Th>
                </Thead>
                <tbody>
                  {statefulSetsQuery.isLoading ? (
                    <TableStatusRow colSpan={7}>Loading statefulsets…</TableStatusRow>
                  ) : (statefulSetsQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={7}>No statefulsets in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (statefulSetsQuery.data ?? []).map((d) => (
                      <Tr
                        key={`${d.namespace}/${d.name}`}
                        onClick={() => setSelection({ kind: "statefulset", namespace: d.namespace, name: d.name })}
                        selected={selection?.kind === "statefulset" && selection.name === d.name && selection.namespace === d.namespace}
                      >
                        <Td className="font-medium">{d.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{d.namespace}</Td>
                        <Td className="font-mono-app">{d.ready}</Td>
                        <Td className="font-mono-app text-[11px]" style={{ color: "var(--text-dim)" }}>
                          {d.serviceName || "—"}
                        </Td>
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
                              onClick={() => setScaleTarget({ kind: "statefulset", namespace: d.namespace, name: d.name, replicas: d.replicas })}
                            >
                              {d.replicas}x
                            </Button>
                            <Button variant="ghost" size="sm" title="Restart" onClick={() => handleRestart("statefulset", d.namespace, d.name)}>
                              <RotateCw size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "statefulset", namespace: d.namespace, name: d.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "statefulset", namespace: d.namespace, name: d.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "daemonsets" &&
            (daemonSetsQuery.isError ? (
              <QueryErrorBanner error={daemonSetsQuery.error} onRetry={() => daemonSetsQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Desired</Th>
                  <Th>Current</Th>
                  <Th>Ready</Th>
                  <Th>Available</Th>
                  <Th>Age</Th>
                  <Th>Images</Th>
                  <Th style={{ width: 130 }}>Actions</Th>
                </Thead>
                <tbody>
                  {daemonSetsQuery.isLoading ? (
                    <TableStatusRow colSpan={9}>Loading daemonsets…</TableStatusRow>
                  ) : (daemonSetsQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={9}>No daemonsets in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (daemonSetsQuery.data ?? []).map((d) => (
                      <Tr
                        key={`${d.namespace}/${d.name}`}
                        onClick={() => setSelection({ kind: "daemonset", namespace: d.namespace, name: d.name })}
                        selected={selection?.kind === "daemonset" && selection.name === d.name && selection.namespace === d.namespace}
                      >
                        <Td className="font-medium">{d.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{d.namespace}</Td>
                        <Td className="font-mono-app">{d.desired}</Td>
                        <Td className="font-mono-app">{d.current}</Td>
                        <Td className="font-mono-app">{d.ready}</Td>
                        <Td className="font-mono-app">{d.available}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(d.createdAt)}</Td>
                        <Td className="font-mono-app text-[11px] truncate max-w-[180px]" style={{ color: "var(--text-faint)" }}>
                          {d.images.join(", ")}
                        </Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="sm" title="Restart" onClick={() => handleRestart("daemonset", d.namespace, d.name)}>
                              <RotateCw size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "daemonset", namespace: d.namespace, name: d.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "daemonset", namespace: d.namespace, name: d.name })}
                            >
                              <Trash2 size={13} />
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
                  <Th style={{ width: 120 }}>Actions</Th>
                </Thead>
                <tbody>
                  {servicesQuery.isLoading ? (
                    <TableStatusRow colSpan={8}>Loading services…</TableStatusRow>
                  ) : (servicesQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={8}>No services in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (servicesQuery.data ?? []).map((s) => (
                      <Tr
                        key={`${s.namespace}/${s.name}`}
                        onClick={() => setSelection({ kind: "service", namespace: s.namespace, name: s.name })}
                        selected={selection?.kind === "service" && selection.name === s.name && selection.namespace === s.namespace}
                      >
                        <Td className="font-medium">{s.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{s.namespace}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{s.type}</Td>
                        <Td className="font-mono-app">{s.clusterIp}</Td>
                        <Td className="font-mono-app">{s.externalIp ?? "—"}</Td>
                        <Td className="font-mono-app text-[11px]">{s.ports}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(s.createdAt)}</Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Port forward…"
                              onClick={() =>
                                setPfTarget({
                                  kind: "service",
                                  namespace: s.namespace,
                                  name: s.name,
                                  ports: servicePortChoices(s.portList),
                                })
                              }
                            >
                              <ArrowRightLeft size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "service", namespace: s.namespace, name: s.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "service", namespace: s.namespace, name: s.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "ingresses" &&
            (ingressesQuery.isError ? (
              <QueryErrorBanner error={ingressesQuery.error} onRetry={() => ingressesQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Class</Th>
                  <Th>Hosts</Th>
                  <Th>Address</Th>
                  <Th>Ports</Th>
                  <Th>Age</Th>
                  <Th style={{ width: 90 }}>Actions</Th>
                </Thead>
                <tbody>
                  {ingressesQuery.isLoading ? (
                    <TableStatusRow colSpan={8}>Loading ingresses…</TableStatusRow>
                  ) : (ingressesQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={8}>No ingresses in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (ingressesQuery.data ?? []).map((ing) => (
                      <Tr
                        key={`${ing.namespace}/${ing.name}`}
                        onClick={() => setSelection({ kind: "ingress", namespace: ing.namespace, name: ing.name, ingress: ing })}
                        selected={selection?.kind === "ingress" && selection.name === ing.name && selection.namespace === ing.namespace}
                      >
                        <Td className="font-medium">{ing.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{ing.namespace}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{ing.className ?? "—"}</Td>
                        <Td>
                          <div className="flex flex-wrap gap-1" onClick={(e) => e.stopPropagation()}>
                            {ingressAllHosts(ing).length === 0 ? (
                              <span style={{ color: "var(--text-faint)" }}>—</span>
                            ) : (
                              ingressAllHosts(ing).map((h) => {
                                const url = ingressHostUrl(h, ing.tls);
                                return url ? (
                                  <a
                                    key={h}
                                    href={url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[11.5px] hover:underline"
                                    style={{ color: "var(--info)" }}
                                  >
                                    {h}
                                    <ExternalLink size={9} />
                                  </a>
                                ) : (
                                  <span key={h}>{h}</span>
                                );
                              })
                            )}
                          </div>
                        </Td>
                        <Td className="font-mono-app">{ing.address ?? "—"}</Td>
                        <Td className="font-mono-app text-[11px]">{ing.ports}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(ing.createdAt)}</Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "ingress", namespace: ing.namespace, name: ing.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "ingress", namespace: ing.namespace, name: ing.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "configmaps" &&
            (configMapsQuery.isError ? (
              <QueryErrorBanner error={configMapsQuery.error} onRetry={() => configMapsQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Keys</Th>
                  <Th>Age</Th>
                  <Th style={{ width: 90 }}>Actions</Th>
                </Thead>
                <tbody>
                  {configMapsQuery.isLoading ? (
                    <TableStatusRow colSpan={5}>Loading config maps…</TableStatusRow>
                  ) : (configMapsQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={5}>No config maps in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (configMapsQuery.data ?? []).map((cm) => (
                      <Tr
                        key={`${cm.namespace}/${cm.name}`}
                        onClick={() => setSelection({ kind: "configmap", namespace: cm.namespace, name: cm.name, configMap: cm })}
                        selected={selection?.kind === "configmap" && selection.name === cm.name && selection.namespace === cm.namespace}
                      >
                        <Td className="font-medium">{cm.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{cm.namespace}</Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {cm.keys.slice(0, 4).map((k) => (
                              <span key={k} className="k8s-chip">
                                {k}
                              </span>
                            ))}
                            {cm.keys.length > 4 && (
                              <span className="k8s-chip">+{cm.keys.length - 4}</span>
                            )}
                          </div>
                        </Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(cm.createdAt)}</Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "configmap", namespace: cm.namespace, name: cm.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "configmap", namespace: cm.namespace, name: cm.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
                      </Tr>
                    ))
                  )}
                </tbody>
              </Table>
            ))}

          {tab === "secrets" &&
            (secretsQuery.isError ? (
              <QueryErrorBanner error={secretsQuery.error} onRetry={() => secretsQuery.refetch()} />
            ) : (
              <Table>
                <Thead>
                  <Th>Name</Th>
                  <Th>Namespace</Th>
                  <Th>Type</Th>
                  <Th>Keys</Th>
                  <Th>Age</Th>
                  <Th style={{ width: 90 }}>Actions</Th>
                </Thead>
                <tbody>
                  {secretsQuery.isLoading ? (
                    <TableStatusRow colSpan={6}>Loading secrets…</TableStatusRow>
                  ) : (secretsQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={6}>No secrets in {namespace ?? "any namespace"}</TableStatusRow>
                  ) : (
                    (secretsQuery.data ?? []).map((s) => (
                      <Tr
                        key={`${s.namespace}/${s.name}`}
                        onClick={() => setSelection({ kind: "secret", namespace: s.namespace, name: s.name, secret: s })}
                        selected={selection?.kind === "secret" && selection.name === s.name && selection.namespace === s.namespace}
                      >
                        <Td className="font-medium">{s.name}</Td>
                        <Td style={{ color: "var(--text-dim)" }}>{s.namespace}</Td>
                        <Td className="font-mono-app text-[11px]" style={{ color: "var(--text-faint)" }}>
                          {s.type}
                        </Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {s.keys.slice(0, 4).map((k) => (
                              <span key={k} className="k8s-chip">
                                {k}
                              </span>
                            ))}
                            {s.keys.length > 4 && <span className="k8s-chip">+{s.keys.length - 4}</span>}
                          </div>
                        </Td>
                        <Td style={{ color: "var(--text-dim)" }}>{relativeAge(s.createdAt)}</Td>
                        <Td>
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edit"
                              onClick={() => setEditTarget({ kind: "secret", namespace: s.namespace, name: s.name })}
                            >
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="danger-outline"
                              size="sm"
                              title="Delete"
                              onClick={() => setDeleteTarget({ kind: "secret", namespace: s.namespace, name: s.name })}
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </Td>
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
                  <Th style={{ width: 110 }}>CPU</Th>
                  <Th style={{ width: 110 }}>Memory</Th>
                  <Th>Age</Th>
                </Thead>
                <tbody>
                  {nodesQuery.isLoading ? (
                    <TableStatusRow colSpan={9}>Loading nodes…</TableStatusRow>
                  ) : (nodesQuery.data ?? []).length === 0 ? (
                    <TableStatusRow colSpan={9}>No nodes found</TableStatusRow>
                  ) : (
                    (nodesQuery.data ?? []).map((n) => {
                      const metrics = nodeMetricsByName.get(n.name);
                      return (
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
                          <Td>
                            <UsageBar
                              kind="cpu"
                              usedValue={metrics?.cpuMilli ?? null}
                              limit={null}
                              request={null}
                              allocatable={n.cpuAllocatableMilli}
                              metricsAvailable={nodeMetricsAvailable}
                            />
                          </Td>
                          <Td>
                            <UsageBar
                              kind="memory"
                              usedValue={metrics?.memBytes ?? null}
                              limit={null}
                              request={null}
                              allocatable={n.memAllocatableBytes}
                              metricsAvailable={nodeMetricsAvailable}
                            />
                          </Td>
                          <Td style={{ color: "var(--text-dim)" }}>{relativeAge(n.createdAt)}</Td>
                        </Tr>
                      );
                    })
                  )}
                </tbody>
              </Table>
            ))}
          {tab === "nodes" && !nodeMetricsAvailable && nodeMetricsQuery.data && (
            <div className="mt-2 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
              Metrics unavailable{nodeMetricsQuery.data.reason ? `: ${nodeMetricsQuery.data.reason}` : ""}
            </div>
          )}
        </div>
      </div>

      {selection && (
        <K8sDetail
          profile={profile}
          kind={selection.kind}
          namespace={selection.namespace}
          name={selection.name}
          containers={selection.containers}
          configMap={selection.configMap}
          secret={selection.secret}
          ingress={selection.ingress}
          onClose={() => setSelection(null)}
        />
      )}

      <K8sDeleteConfirm
        open={!!deleteTarget}
        kind={deleteTarget?.kind ?? "pod"}
        namespace={deleteTarget?.namespace ?? null}
        name={deleteTarget?.name ?? ""}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
      />

      {editTarget && (
        <K8sEditDialog
          open={!!editTarget}
          profile={profile}
          kind={editTarget.kind}
          namespace={editTarget.namespace}
          name={editTarget.name}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: [tabQueryKey(editTarget.kind), profile] });
            setEditTarget(null);
          }}
        />
      )}

      {createKind && (
        <K8sCreateDialog
          open
          profile={profile}
          kind={createKind}
          currentNamespace={namespace}
          onClose={() => setCreateKind(null)}
          onCreated={(k) => {
            queryClient.invalidateQueries({ queryKey: [tabQueryKey(k), profile] });
            queryClient.invalidateQueries({ queryKey: ["k8sNamespaces", profile] });
          }}
        />
      )}

      {pfTarget && (
        <PortForwardDialog
          open
          profile={profile}
          kind={pfTarget.kind}
          namespace={pfTarget.namespace}
          name={pfTarget.name}
          ports={pfTarget.ports}
          onClose={() => setPfTarget(null)}
          onStarted={() => {
            queryClient.invalidateQueries({ queryKey: ["k8sPortForwards"] });
            setPfOpen(true);
          }}
        />
      )}

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
          kind={scaleTarget.kind}
          namespace={scaleTarget.namespace}
          name={scaleTarget.name}
          currentReplicas={scaleTarget.replicas}
          onClose={() => setScaleTarget(null)}
          onScaled={() => queryClient.invalidateQueries({ queryKey: [tabQueryKey(scaleTarget.kind), profile] })}
        />
      )}
    </div>
  );
}

function tabQueryKey(kind: K8sKind): string {
  switch (kind) {
    case "pod":
      return "k8sPods";
    case "deployment":
      return "k8sDeployments";
    case "statefulset":
      return "k8sStatefulSets";
    case "daemonset":
      return "k8sDaemonSets";
    case "service":
      return "k8sServices";
    case "ingress":
      return "k8sIngresses";
    case "configmap":
      return "k8sConfigMaps";
    case "secret":
      return "k8sSecrets";
    case "node":
      return "k8sNodes";
  }
}
