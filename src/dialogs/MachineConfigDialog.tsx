// "Start with configuration…" full-screen machine configuration editor
// (docs/SPEC.md §6.4). Replaces the need for `colima start --edit`: edits
// the profile's colima.yaml with typed controls for every documented key,
// preserving comments/ordering/unknown keys via colimaConfig.ts, with a raw
// YAML tab two-way synced to the form.
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Boxes,
  Code2,
  Cpu,
  FolderTree,
  KeyRound,
  ListTree,
  Network,
  Save,
  Ship,
  Wrench,
  X,
} from "lucide-react";
import { open as openFolderDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { isTauriRuntime } from "../lib/api";
import type { ConfigIssue } from "../lib/types";
import { Button } from "../components/Button";
import { useToast } from "../components/Toasts";
import { RecreateDialog } from "./RecreateDialog";
import { ReclaimDialog } from "./ReclaimDialog";
import { formatGiB, isDiskShrink, shrinkMessage } from "../lib/disk";
import { K3sVersionPicker } from "../components/K3sVersionPicker";
import {
  Banner,
  ChipList,
  FieldRow,
  IssuesPanel,
  KeyValueEditor,
  NumberStepper,
  Segmented,
  SectionHeading,
  Switch,
  TextArea,
  TextInput,
} from "./configFields";
import {
  cloneConfig,
  deleteIn,
  getDockerConfig,
  getFullConfig,
  getIn,
  parseConfig,
  setDockerConfig,
  setIn,
  setMounts,
  setProvision,
  setStringList,
  setStringMap,
  stringifyConfig,
  type ConfigDoc,
  type MountRow,
  type ProvisionRow,
} from "../lib/colimaConfig";

export type SectionId =
  | "resources"
  | "runtime"
  | "kubernetes"
  | "vm"
  | "network"
  | "mounts"
  | "ssh"
  | "environment"
  | "provision"
  | "yaml";

const SECTIONS: { id: SectionId; label: string; icon: typeof Cpu }[] = [
  { id: "resources", label: "Resources", icon: Cpu },
  { id: "runtime", label: "Runtime", icon: Ship },
  { id: "kubernetes", label: "Kubernetes", icon: Boxes },
  { id: "vm", label: "Virtual machine", icon: Wrench },
  { id: "network", label: "Network", icon: Network },
  { id: "mounts", label: "Mounts", icon: FolderTree },
  { id: "ssh", label: "SSH", icon: KeyRound },
  { id: "environment", label: "Environment", icon: ListTree },
  { id: "provision", label: "Provision", icon: Code2 },
  { id: "yaml", label: "YAML", icon: Code2 },
];

/** Maps a `ConfigIssue.path` (e.g. "network.dns[1]", "mounts[0].location",
 * "kubernetes.port") to the section that shows that key, so clicking an
 * issue can jump the user straight to it. Order matters: more specific
 * prefixes (checked via the leading path segment) are listed first. */
function sectionForIssuePath(path: string): SectionId {
  const head = path.split(/[.[]/)[0];
  switch (head) {
    case "network":
      return "network";
    case "kubernetes":
      return "kubernetes";
    case "mounts":
    case "mountType":
    case "mountInotify":
      return "mounts";
    case "provision":
      return "provision";
    case "env":
      return "environment";
    case "sshPort":
    case "sshConfig":
    case "forwardAgent":
      return "ssh";
    case "runtime":
    case "autoActivate":
    case "modelRunner":
    case "docker":
      return "runtime";
    case "vmType":
    case "rosetta":
    case "binfmt":
    case "nestedVirtualization":
    case "portForwarder":
    case "diskImage":
    case "diskImageMirror":
    case "forceDiskImage":
      return "vm";
    case "cpu":
    case "disk":
    case "rootDisk":
    case "memory":
    case "cpuType":
    case "arch":
    case "hostname":
      return "resources";
    default:
      return "yaml";
  }
}

const K3S_QUICK_TOGGLES = [
  { label: "traefik", value: "--disable=traefik" },
  { label: "servicelb", value: "--disable=servicelb" },
  { label: "metrics-server", value: "--disable=metrics-server" },
  { label: "coredns", value: "--disable=coredns" },
  { label: "local-storage", value: "--disable=local-storage" },
];

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const IPV4_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

function isValidIp(v: string): boolean {
  if (!v) return true;
  if (!IPV4_PATTERN.test(v)) return v.includes(":"); // loose allowance for IPv6
  return v.split(".").every((part) => Number(part) <= 255);
}

/** One `doc.setIn(path, value)` patch applied once on open, counted as an
 * unsaved change (§6.5) — e.g. jumping here from the Kubernetes page with
 * `kubernetes.enabled: true` pre-applied. */
export interface ConfigPatch {
  path: (string | number)[];
  value: unknown;
}

interface MachineConfigDialogProps {
  open: boolean;
  onClose: () => void;
  /** Existing profile name to edit, or null when creating a new machine. */
  profileName: string | null;
  /** Whether the target profile is currently running (affects footer action + banners). */
  isRunning: boolean;
  onSaved: (profileName: string) => void;
  /** Section to land on when the dialog opens (§6.5 entry points from the
   * Kubernetes page); defaults to "resources" when omitted. */
  initialSection?: SectionId;
  /** Patches applied once via `setIn` right after the config loads, counted
   * as unsaved changes (§6.5, e.g. `kubernetes.enabled: true`). */
  initialPatch?: ConfigPatch[];
  /** Navigate to the Volumes page (used by the Reclaim dialog's link). */
  onOpenVolumes?: (profile: string) => void;
}

export function MachineConfigDialog({
  open,
  onClose,
  profileName,
  isRunning,
  onSaved,
  initialSection,
  initialPatch,
  onOpenVolumes,
}: MachineConfigDialogProps) {
  const toast = useToast();
  const isNew = profileName === null;
  const [newName, setNewName] = useState("");
  const [section, setSection] = useState<SectionId>("resources");
  const [doc, setDoc] = useState<ConfigDoc | null>(null);
  const [initialDoc, setInitialDoc] = useState<ConfigDoc | null>(null);
  const [yamlText, setYamlText] = useState("");
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [dockerJsonError, setDockerJsonError] = useState<string | null>(null);
  const [dockerJsonText, setDockerJsonText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0); // bumps to force re-render after in-place doc mutation
  const [issues, setIssues] = useState<ConfigIssue[]>([]);
  const [recreateOpen, setRecreateOpen] = useState(false);
  const [reclaimOpen, setReclaimOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const validationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validationRequestId = useRef(0);

  const targetProfile = isNew ? newName.trim() : profileName ?? "";

  const envQuery = useQuery({ queryKey: ["envInfo"], queryFn: api.envInfo, enabled: open });
  const isLinux = envQuery.data?.platform === "linux";

  const rawQuery = useQuery({
    queryKey: ["profileConfigRaw", isNew ? null : profileName],
    queryFn: () => api.profileConfigRaw(profileName ?? "default"),
    enabled: open && !isNew && !!profileName,
  });

  const templateQuery = useQuery({
    queryKey: ["profileConfigRaw", "__template__"],
    queryFn: () => api.profileConfigRaw("default"),
    enabled: open && isNew,
  });

  // Real VM disk size (§6.4): a smaller `disk` than this can't be applied.
  const diskInfoQuery = useQuery({
    queryKey: ["profileDiskInfo", profileName],
    queryFn: () => api.profileDiskInfo(profileName ?? "default"),
    enabled: open && !isNew && !!profileName,
  });
  const currentDiskGiB = diskInfoQuery.data?.exists ? (diskInfoQuery.data.sizeGiB ?? null) : null;

  const k3sVersionsQuery = useQuery({
    queryKey: ["k3sVersions"],
    queryFn: () => api.k3sVersions(false),
    enabled: open,
    staleTime: 60 * 60 * 1000, // 1h
  });
  const colimaDefaultVersion = k3sVersionsQuery.data?.colimaDefault ?? null;

  // Running-cluster version-change warning (§6.5): only queried when this
  // profile's Kubernetes is actually running, so opening the dialog for a
  // stopped machine (or one with k8s off) never fires a k8s API call.
  // `doc`'s own `kubernetes.enabled` reflects the on-disk config, which is
  // the best signal we have for "the running machine currently has k8s on"
  // (the alternative, profile_status, only tells us the machine is running).
  const k8sEnabledOnDisk = doc ? getIn(doc, ["kubernetes", "enabled"], false) : false;
  const k8sNodesQuery = useQuery({
    queryKey: ["k8sNodes", profileName],
    queryFn: () => api.k8sNodes(profileName ?? ""),
    enabled: open && !isNew && isRunning && k8sEnabledOnDisk && !!profileName,
  });
  const runningK8sVersion = k8sNodesQuery.data?.[0]?.version ?? null;

  useEffect(() => {
    if (!open) return;
    setNewName("");
    setSection(initialSection ?? "resources");
    setYamlError(null);
    setDockerJsonError(null);
    setIssues([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Live typed validation (§6.4): mirrors the checks `save_profile_config_raw`
  // enforces server-side, debounced ~300ms so it doesn't fire on every
  // keystroke. Guarded by a request id so a slow response for a stale
  // `yamlText` can never clobber the result of a newer one.
  useEffect(() => {
    if (!open || !doc) return;
    if (validationTimer.current) clearTimeout(validationTimer.current);
    const requestId = ++validationRequestId.current;
    validationTimer.current = setTimeout(() => {
      api
        .validateProfileConfigRaw(yamlText)
        .then((result) => {
          if (validationRequestId.current === requestId) setIssues(result);
        })
        .catch(() => {
          // Best-effort: a validation-call failure shouldn't block editing;
          // the parse-error path (`yamlError`) already covers unparsable YAML.
        });
    }, 300);
    return () => {
      if (validationTimer.current) clearTimeout(validationTimer.current);
    };
  }, [open, doc, yamlText]);

  // Guards `initialPatch` so it's applied exactly once per dialog-open, not
  // re-applied every time `source` refetches (e.g. react-query background
  // refresh) while the dialog stays open.
  const initialPatchApplied = useRef(false);
  // Whether this open's initialPatch turned Kubernetes on, so the follow-up
  // effect below knows whether it still needs to prefill the version once
  // colima's default becomes known (it's usually not known yet on the very
  // first render, since it comes from its own async query).
  const pendingKubernetesVersionPrefill = useRef(false);
  useEffect(() => {
    if (!open) {
      initialPatchApplied.current = false;
      pendingKubernetesVersionPrefill.current = false;
    }
  }, [open]);

  useEffect(() => {
    const source = isNew ? templateQuery.data : rawQuery.data;
    if (!source) return;
    const parsed = parseConfig(source.content);
    // initialDoc snapshots the *unpatched* content, so an applied initialPatch
    // (e.g. kubernetes.enabled: true from the Kubernetes page) is itself
    // counted in the footer's "N changes", per §6.5.
    setInitialDoc(cloneConfig(parsed));
    if (initialPatch && initialPatch.length > 0 && !initialPatchApplied.current) {
      for (const patch of initialPatch) {
        parsed.setIn(patch.path, patch.value);
      }
      // Same prefill-if-empty rule as toggling the Enabled switch by hand
      // (§6.5): if this patch turned Kubernetes on and no version is set
      // yet, seed it with colima's own default. `colimaDefaultVersion` may
      // not have loaded yet, so remember to retry from the effect below.
      const enabledPatch = initialPatch.some(
        (p) => p.path.join(".") === "kubernetes.enabled" && p.value === true,
      );
      if (enabledPatch && !getIn(parsed, ["kubernetes", "version"], "")) {
        if (colimaDefaultVersion) {
          parsed.setIn(["kubernetes", "version"], colimaDefaultVersion);
        } else {
          pendingKubernetesVersionPrefill.current = true;
        }
      }
      initialPatchApplied.current = true;
    }
    setDoc(parsed);
    setYamlText(stringifyConfig(parsed));
    setDockerJsonText(JSON.stringify(getDockerConfig(parsed), null, 2));
    setVersion((v) => v + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNew, templateQuery.data, rawQuery.data]);

  // Retries the version prefill once colima's default becomes known, for the
  // common case where `k3sVersionsQuery` resolves after the doc has already
  // loaded and applied `initialPatch`.
  useEffect(() => {
    if (!doc || !colimaDefaultVersion || !pendingKubernetesVersionPrefill.current) return;
    if (getIn(doc, ["kubernetes", "version"], "")) {
      pendingKubernetesVersionPrefill.current = false;
      return;
    }
    mutate((d) => setIn(d, ["kubernetes", "version"], colimaDefaultVersion));
    pendingKubernetesVersionPrefill.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, colimaDefaultVersion]);

  const source = isNew ? templateQuery.data : rawQuery.data;

  // Re-derive form values from `doc` on every mutation (bumping `version`
  // forces this memo to refresh even though we mutate the Document in place
  // for simplicity, matching how yaml.Document is meant to be used).
  const full = useMemo(() => {
    if (!doc) return null;
    return getFullConfig(doc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version]);

  const changeCount = useMemo(() => {
    if (!doc || !initialDoc) return 0;
    const a = stringifyConfig(doc);
    const b = stringifyConfig(initialDoc);
    if (a === b) return 0;
    // Approximate a per-line change count; exact enough for a footer badge.
    const linesA = a.split("\n");
    const linesB = b.split("\n");
    const max = Math.max(linesA.length, linesB.length);
    let n = 0;
    for (let i = 0; i < max; i++) {
      if (linesA[i] !== linesB[i]) n++;
    }
    return n;
  }, [doc, initialDoc]);

  const mutate = (fn: (d: ConfigDoc) => void) => {
    if (!doc) return;
    fn(doc);
    setYamlText(stringifyConfig(doc));
    setVersion((v) => v + 1);
  };

  const applyYamlText = (text: string) => {
    setYamlText(text);
    try {
      const parsed = parseConfig(text);
      setYamlError(null);
      setDoc(parsed);
      setDockerJsonText(JSON.stringify(getDockerConfig(parsed), null, 2));
      setVersion((v) => v + 1);
    } catch (e) {
      setYamlError(String(e));
    }
  };

  const applyDockerJsonText = (text: string) => {
    setDockerJsonText(text);
    try {
      const value = JSON.parse(text || "{}");
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error("must be a JSON object");
      }
      setDockerJsonError(null);
      mutate((d) => setDockerConfig(d, value as Record<string, unknown>));
    } catch (e) {
      setDockerJsonError(e instanceof Error ? e.message : String(e));
    }
  };

  const architectureChanged =
    !isNew && full && initialDoc && getIn(initialDoc, ["arch"], "host") !== full.resources.arch;
  const runtimeChanged =
    !isNew && full && initialDoc && getIn(initialDoc, ["runtime"], "docker") !== full.runtime.runtime;
  const vmTypeChanged =
    !isNew && full && initialDoc && getIn(initialDoc, ["vmType"], "qemu") !== full.vm.vmType;
  const diskShrunk = !isNew && !!full && isDiskShrink(full.resources.disk, currentDiskGiB);

  const nameError =
    isNew && newName.length > 0 && !PROFILE_NAME_PATTERN.test(newName)
      ? "Must match ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$"
      : null;

  const errorIssues = useMemo(() => issues.filter((i) => i.severity === "error"), [issues]);
  const warningIssues = useMemo(() => issues.filter((i) => i.severity === "warning"), [issues]);

  /** First issue whose path exactly matches `path` (used to mark a single
   * field inline); the issues panel above the form shows the full list. */
  const issueForPath = (path: string): ConfigIssue | undefined => issues.find((i) => i.path === path);

  /** First issue whose path starts with `prefix` (used for list/map fields
   * like `network.dns` or `env`, where individual issues are reported per
   * element/key, e.g. `network.dns[1]` or `env.SOME_KEY`). */
  const issueForPrefix = (prefix: string): ConfigIssue | undefined =>
    issues.find((i) => i.path === prefix || i.path.startsWith(`${prefix}[`) || i.path.startsWith(`${prefix}.`));

  const jumpToIssue = (path: string) => setSection(sectionForIssuePath(path));

  const canSave =
    doc !== null &&
    !yamlError &&
    !diskShrunk &&
    errorIssues.length === 0 &&
    (!isNew || (newName.trim().length > 0 && !nameError));

  const handleSave = async (thenStart: boolean) => {
    if (!doc || !canSave) return;
    setBusy(true);
    try {
      const content = stringifyConfig(doc);
      await api.saveProfileConfigRaw(targetProfile, content);
      toast.success(`Saved configuration for ${targetProfile}`);
      if (thenStart) {
        if (isRunning) {
          await api.stopProfile(targetProfile, false);
        }
        await api.startProfile(targetProfile, {});
        toast.success(`${targetProfile} ${isRunning ? "restarted" : "started"}`);
      }
      onSaved(targetProfile);
      onClose();
    } catch (e) {
      toast.error(`Failed to save configuration for ${targetProfile}`, String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleResetToTemplate = () => {
    if (!source) return;
    const parsed = parseConfig(source.content);
    setDoc(parsed);
    setYamlText(stringifyConfig(parsed));
    setDockerJsonText(JSON.stringify(getDockerConfig(parsed), null, 2));
    setYamlError(null);
    setDockerJsonError(null);
    setVersion((v) => v + 1);
  };

  const pickMountFolder = async (index: number, rows: MountRow[]) => {
    if (!isTauriRuntime()) {
      toast.info("Folder picker is only available in the desktop app");
      return;
    }
    const selected = await openFolderDialog({ directory: true, multiple: false });
    if (typeof selected === "string") {
      const next = rows.map((r, i) => (i === index ? { ...r, location: selected } : r));
      mutate((d) => setMounts(d, next));
    }
  };

  if (!open) return null;

  const loading = isNew ? templateQuery.isLoading : rawQuery.isLoading;

  return (
    <div
      className="fixed inset-0 z-[160] flex flex-col fade-in"
      style={{ background: "var(--surface-0)" }}
      ref={containerRef}
    >
      <div
        className="flex h-12 flex-shrink-0 items-center gap-3 border-b px-4"
        style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
      >
        <h1 className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
          {isNew ? "New machine" : `Configure ${profileName}`}
        </h1>
        {source && (
          <span
            className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
            style={{ background: "var(--surface-3)", color: "var(--text-faint)" }}
          >
            source: {source.source}
          </span>
        )}
        <button onClick={onClose} className="ml-auto opacity-60 hover:opacity-100" aria-label="Close">
          <X size={18} style={{ color: "var(--text-dim)" }} />
        </button>
      </div>

      {loading || !doc || !full ? (
        <div className="flex flex-1 items-center justify-center text-[13px]" style={{ color: "var(--text-dim)" }}>
          Loading configuration…
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            className="flex w-[200px] flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r p-2"
            style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
          >
            {isNew && (
              <div className="mb-2 px-1">
                <FieldRow label="Name" yamlKey="profile" invalid={nameError ?? undefined}>
                  <TextInput
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="default"
                  />
                </FieldRow>
              </div>
            )}
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const active = section === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium"
                  style={{
                    background: active ? "var(--accent-soft)" : "transparent",
                    color: active ? "var(--accent-strong)" : "var(--text-dim)",
                  }}
                >
                  <Icon size={14} />
                  {s.label}
                </button>
              );
            })}
          </nav>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto flex max-w-[640px] flex-col gap-5">
              {!isNew && (architectureChanged || runtimeChanged || vmTypeChanged) && (
                <Banner tone="warn">
                  Changing architecture, runtime or VM type on an existing machine requires deleting and
                  recreating it — these settings only take effect for a brand-new machine.
                </Banner>
              )}
              {diskShrunk && currentDiskGiB != null && (
                <Banner tone="danger">
                  <div className="flex flex-col items-start gap-2">
                    <span>{shrinkMessage(currentDiskGiB)}</span>
                    <Button variant="danger" size="sm" onClick={() => setRecreateOpen(true)} disabled={busy}>
                      Recreate with smaller disk…
                    </Button>
                  </div>
                </Banner>
              )}

              <IssuesPanel issues={issues} onJumpTo={jumpToIssue} />

              {section === "resources" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Resources</SectionHeading>
                  <FieldRow
                    label="CPU"
                    yamlKey="cpu"
                    help="Number of CPUs allocated to the virtual machine."
                    invalid={issueForPath("cpu")?.message}
                  >
                    <NumberStepper value={full.resources.cpu} min={1} onChange={(v) => mutate((d) => setIn(d, ["cpu"], v))} />
                  </FieldRow>
                  <FieldRow
                    label="Memory (GiB)"
                    yamlKey="memory"
                    help="Size of the memory allocated to the virtual machine."
                    invalid={issueForPath("memory")?.message}
                  >
                    <NumberStepper
                      value={full.resources.memory}
                      min={1}
                      step={0.5}
                      onChange={(v) => mutate((d) => setIn(d, ["memory"], v))}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Disk (GiB)"
                    yamlKey="disk"
                    help={`Container data disk size. Can only be increased after the machine is created${currentDiskGiB != null ? ` (current size ${formatGiB(currentDiskGiB)})` : ""}.`}
                    invalid={(diskShrunk && currentDiskGiB != null && shrinkMessage(currentDiskGiB)) || issueForPath("disk")?.message}
                  >
                    <NumberStepper value={full.resources.disk} min={1} onChange={(v) => mutate((d) => setIn(d, ["disk"], v))} />
                  </FieldRow>
                  {!isNew && isRunning && (
                    <div>
                      <Button variant="secondary" size="sm" onClick={() => setReclaimOpen(true)} disabled={busy}>
                        Reclaim disk space…
                      </Button>
                      <span className="ml-2 text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                        Prune unused Docker data and trim the VM disk.
                      </span>
                    </div>
                  )}
                  <FieldRow
                    label="Root disk (GiB)"
                    yamlKey="rootDisk"
                    help="Root filesystem disk size (ignored for runtime none)."
                    invalid={issueForPath("rootDisk")?.message}
                  >
                    <NumberStepper value={full.resources.rootDisk} min={1} onChange={(v) => mutate((d) => setIn(d, ["rootDisk"], v))} />
                  </FieldRow>
                  <FieldRow label="CPU type" yamlKey="cpuType" help="CPU type for qemu VMs, e.g. host or host,+ssse3.">
                    <TextInput value={full.resources.cpuType} onChange={(e) => mutate((d) => setIn(d, ["cpuType"], e.target.value))} />
                  </FieldRow>
                  <FieldRow
                    label="Architecture"
                    yamlKey="arch"
                    help="Cannot be changed after the virtual machine is created."
                    invalid={
                      (architectureChanged && "Changing this requires deleting the machine") ||
                      issueForPath("arch")?.message
                    }
                  >
                    <Segmented
                      value={full.resources.arch as "host" | "aarch64" | "x86_64"}
                      options={[
                        { value: "host", label: "host" },
                        { value: "aarch64", label: "aarch64" },
                        { value: "x86_64", label: "x86_64" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["arch"], v))}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Hostname"
                    yamlKey="hostname"
                    help="Custom hostname; defaults to colima / colima-<profile>."
                    invalid={issueForPath("hostname")?.message}
                  >
                    <TextInput
                      value={full.resources.hostname}
                      onChange={(e) =>
                        mutate((d) => (e.target.value ? setIn(d, ["hostname"], e.target.value) : deleteIn(d, ["hostname"])))
                      }
                    />
                  </FieldRow>
                </div>
              )}

              {section === "runtime" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Runtime</SectionHeading>
                  <FieldRow
                    label="Runtime"
                    yamlKey="runtime"
                    help="Cannot be changed after the virtual machine is created."
                    invalid={
                      (runtimeChanged && "Changing this requires deleting the machine") ||
                      issueForPath("runtime")?.message
                    }
                  >
                    <Segmented
                      value={full.runtime.runtime as "docker" | "containerd" | "incus"}
                      options={[
                        { value: "docker", label: "docker" },
                        { value: "containerd", label: "containerd" },
                        { value: "incus", label: "incus" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["runtime"], v))}
                    />
                  </FieldRow>
                  <FieldRow label="Auto-activate" yamlKey="autoActivate" help="Set as active docker/kubernetes/incus context on startup.">
                    <Switch checked={full.runtime.autoActivate} onChange={(v) => mutate((d) => setIn(d, ["autoActivate"], v))} />
                  </FieldRow>
                  <FieldRow
                    label="Model runner"
                    yamlKey="modelRunner"
                    help="AI model runner; both require krunkit VM type for GPU access."
                    invalid={issueForPath("modelRunner")?.message}
                  >
                    <Segmented
                      value={full.runtime.modelRunner as "docker" | "ramalama"}
                      options={[
                        { value: "docker", label: "docker" },
                        { value: "ramalama", label: "ramalama" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["modelRunner"], v))}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Docker daemon config"
                    yamlKey="docker"
                    help='Maps directly to daemon.json, e.g. insecure-registries, registry-mirrors.'
                    invalid={dockerJsonError ?? undefined}
                  >
                    <TextArea rows={8} value={dockerJsonText} onChange={(e) => applyDockerJsonText(e.target.value)} />
                  </FieldRow>
                  <ChipList
                    values={((): string[] => {
                      const v = getIn(doc, ["docker", "insecure-registries"], [] as string[]);
                      return Array.isArray(v) ? v.map(String) : [];
                    })()}
                    onChange={(v) => {
                      const cfg = getDockerConfig(doc);
                      mutate((d) => setDockerConfig(d, { ...cfg, "insecure-registries": v }));
                      setDockerJsonText(JSON.stringify({ ...cfg, "insecure-registries": v }, null, 2));
                    }}
                    placeholder="myregistry.com:5000"
                  />
                </div>
              )}

              {section === "kubernetes" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Kubernetes</SectionHeading>
                  <FieldRow label="Enabled" yamlKey="kubernetes.enabled" help="Enable a single-node k3s Kubernetes cluster.">
                    <Switch
                      checked={full.kubernetes.enabled}
                      onChange={(v) =>
                        mutate((d) => {
                          setIn(d, ["kubernetes", "enabled"], v);
                          // §6.5: prefill colimaDefault when the user toggles k8s
                          // on and no version is set yet.
                          if (v && !getIn(d, ["kubernetes", "version"], "") && colimaDefaultVersion) {
                            setIn(d, ["kubernetes", "version"], colimaDefaultVersion);
                          }
                        })
                      }
                    />
                  </FieldRow>
                  <FieldRow
                    label="Version"
                    yamlKey="kubernetes.version"
                    help="Must exactly match a k3s release, e.g. v1.30.0+k3s1. Leave empty to use colima's own default."
                    invalid={issueForPath("kubernetes.version")?.message}
                  >
                    <K3sVersionPicker
                      value={full.kubernetes.version}
                      onChange={(v) => mutate((d) => setIn(d, ["kubernetes", "version"], v))}
                      runningVersion={runningK8sVersion}
                    />
                  </FieldRow>
                  <FieldRow
                    label="k3s args"
                    yamlKey="kubernetes.k3sArgs"
                    help="Additional args passed to k3s (https://docs.k3s.io/cli/server)."
                    invalid={issueForPath("kubernetes.k3sArgs")?.message}
                  >
                    <ChipList
                      values={full.kubernetes.k3sArgs}
                      onChange={(v) => mutate((d) => setStringList(d, ["kubernetes", "k3sArgs"], v))}
                      placeholder="--disable=traefik"
                      quickAdd={K3S_QUICK_TOGGLES}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Port"
                    yamlKey="kubernetes.port"
                    help="Kubernetes API port; 0 picks a random unbound port."
                    invalid={issueForPath("kubernetes.port")?.message}
                  >
                    <NumberStepper value={full.kubernetes.port} min={0} onChange={(v) => mutate((d) => setIn(d, ["kubernetes", "port"], v))} />
                  </FieldRow>
                </div>
              )}

              {section === "vm" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Virtual machine</SectionHeading>
                  <FieldRow
                    label="VM type"
                    yamlKey="vmType"
                    help="Cannot be changed after the virtual machine is created."
                    invalid={
                      (vmTypeChanged && "Changing this requires deleting the machine") ||
                      issueForPath("vmType")?.message
                    }
                  >
                    <Segmented
                      value={full.vm.vmType as "vz" | "qemu" | "krunkit"}
                      options={[
                        ...(isLinux ? [] : [{ value: "vz" as const, label: "vz" }]),
                        { value: "qemu", label: "qemu" },
                        { value: "krunkit", label: "krunkit" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["vmType"], v))}
                    />
                  </FieldRow>
                  {full.vm.vmType === "vz" && (
                    <FieldRow label="Rosetta" yamlKey="rosetta" help="Utilise Rosetta for amd64 emulation (requires Apple Silicon + vz).">
                      <Switch checked={full.vm.rosetta} onChange={(v) => mutate((d) => setIn(d, ["rosetta"], v))} />
                    </FieldRow>
                  )}
                  <FieldRow label="binfmt" yamlKey="binfmt" help="Enable foreign architecture emulation via binfmt.">
                    <Switch checked={full.vm.binfmt} onChange={(v) => mutate((d) => setIn(d, ["binfmt"], v))} />
                  </FieldRow>
                  <FieldRow label="Nested virtualization" yamlKey="nestedVirtualization" help="Requires M3 Mac and vmType vz.">
                    <Switch checked={full.vm.nestedVirtualization} onChange={(v) => mutate((d) => setIn(d, ["nestedVirtualization"], v))} />
                  </FieldRow>
                  <FieldRow
                    label="Port forwarder"
                    yamlKey="portForwarder"
                    help="ssh is stable/TCP-only; grpc supports TCP+UDP (experimental)."
                    invalid={issueForPath("portForwarder")?.message}
                  >
                    <Segmented
                      value={full.vm.portForwarder as "ssh" | "grpc" | "none"}
                      options={[
                        { value: "ssh", label: "ssh" },
                        { value: "grpc", label: "grpc" },
                        { value: "none", label: "none" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["portForwarder"], v))}
                    />
                  </FieldRow>
                  <FieldRow label="Disk image" yamlKey="diskImage" help="Custom disk image path, overriding the downloaded default.">
                    <TextInput value={full.vm.diskImage} onChange={(e) => mutate((d) => setIn(d, ["diskImage"], e.target.value))} />
                  </FieldRow>
                  <FieldRow label="Disk image mirror" yamlKey="diskImageMirror" help="Mirror replacing the https://github.com prefix for image downloads.">
                    <TextInput
                      value={full.vm.diskImageMirror}
                      onChange={(e) => mutate((d) => setIn(d, ["diskImageMirror"], e.target.value))}
                    />
                  </FieldRow>
                  <FieldRow label="Force disk image" yamlKey="forceDiskImage" help="WARNING: bypasses validation of the custom disk image.">
                    <Switch checked={full.vm.forceDiskImage} onChange={(v) => mutate((d) => setIn(d, ["forceDiskImage"], v))} />
                  </FieldRow>
                </div>
              )}

              {section === "network" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Network</SectionHeading>
                  <FieldRow label="Reachable address" yamlKey="network.address" help="Assign a reachable IP to the VM (macOS only).">
                    <Switch checked={full.network.address} onChange={(v) => mutate((d) => setIn(d, ["network", "address"], v))} />
                  </FieldRow>
                  <FieldRow
                    label="Mode"
                    yamlKey="network.mode"
                    help="Network mode for the virtual machine (macOS only)."
                    invalid={issueForPath("network.mode")?.message}
                  >
                    <Segmented
                      value={full.network.mode as "shared" | "bridged"}
                      options={[
                        { value: "shared", label: "shared" },
                        { value: "bridged", label: "bridged" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["network", "mode"], v))}
                    />
                  </FieldRow>
                  <FieldRow label="Bridge interface" yamlKey="network.interface" help="Used only in bridged mode (macOS only).">
                    <TextInput
                      value={full.network.bridgeInterface}
                      onChange={(e) => mutate((d) => setIn(d, ["network", "interface"], e.target.value))}
                    />
                  </FieldRow>
                  <FieldRow label="Subnet" yamlKey="network.subnet" help="Subnet for shared mode; not supported by vz.">
                    <TextInput value={full.network.subnet} onChange={(e) => mutate((d) => setIn(d, ["network", "subnet"], e.target.value))} />
                  </FieldRow>
                  <FieldRow label="Preferred route" yamlKey="network.preferredRoute" help="Use the assigned IP as the preferred route (requires address).">
                    <Switch
                      checked={full.network.preferredRoute}
                      onChange={(v) => mutate((d) => setIn(d, ["network", "preferredRoute"], v))}
                    />
                  </FieldRow>
                  <FieldRow label="Host addresses" yamlKey="network.hostAddresses" help="Replicate host IP addresses in the VM for targeted port forwarding.">
                    <Switch
                      checked={full.network.hostAddresses}
                      onChange={(v) => mutate((d) => setIn(d, ["network", "hostAddresses"], v))}
                    />
                  </FieldRow>
                  <FieldRow
                    label="Gateway address"
                    yamlKey="network.gatewayAddress"
                    help="Last octet must be 2."
                    invalid={
                      (!isValidIp(full.network.gatewayAddress) && "Invalid IP address") ||
                      issueForPath("network.gatewayAddress")?.message
                    }
                  >
                    <TextInput
                      value={full.network.gatewayAddress}
                      onChange={(e) => mutate((d) => setIn(d, ["network", "gatewayAddress"], e.target.value))}
                    />
                  </FieldRow>
                  <FieldRow
                    label="NAT66 prefix"
                    yamlKey="network.nat66Prefix"
                    help="IPv6 ULA prefix for NAT66 (shared mode only, not vz)."
                    invalid={issueForPath("network.nat66Prefix")?.message}
                  >
                    <TextInput
                      value={full.network.nat66Prefix}
                      onChange={(e) =>
                        mutate((d) =>
                          e.target.value ? setIn(d, ["network", "nat66Prefix"], e.target.value) : deleteIn(d, ["network", "nat66Prefix"]),
                        )
                      }
                    />
                  </FieldRow>
                  <FieldRow
                    label="DNS resolvers"
                    yamlKey="network.dns"
                    help="Custom DNS resolvers for the virtual machine, e.g. 8.8.8.8, 1.1.1.1."
                    invalid={
                      (full.network.dns.some((ip) => !isValidIp(ip)) && "Contains an invalid IP address") ||
                      issueForPrefix("network.dns")?.message
                    }
                  >
                    <ChipList
                      values={full.network.dns}
                      onChange={(v) => mutate((d) => setStringList(d, ["network", "dns"], v))}
                      placeholder="8.8.8.8"
                    />
                  </FieldRow>
                  <FieldRow
                    label="DNS hosts"
                    yamlKey="network.dnsHosts"
                    help="Custom hostname -> IP/host resolutions (ignored if DNS resolvers are set)."
                    invalid={issueForPrefix("network.dnsHosts")?.message}
                  >
                    <KeyValueEditor
                      entries={full.network.dnsHosts}
                      onChange={(v) => mutate((d) => setStringMap(d, ["network", "dnsHosts"], v))}
                      keyPlaceholder="example.com"
                      valuePlaceholder="1.2.3.4"
                    />
                  </FieldRow>
                </div>
              )}

              {section === "mounts" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Mounts</SectionHeading>
                  <FieldRow
                    label="Mount type"
                    yamlKey="mountType"
                    help="Cannot be changed after the virtual machine is created."
                    invalid={issueForPath("mountType")?.message}
                  >
                    <Segmented
                      value={full.mounts.mountType as "sshfs" | "9p" | "virtiofs"}
                      options={[
                        { value: "sshfs", label: "sshfs" },
                        { value: "9p", label: "9p" },
                        { value: "virtiofs", label: "virtiofs" },
                      ]}
                      onChange={(v) => mutate((d) => setIn(d, ["mountType"], v))}
                    />
                  </FieldRow>
                  <FieldRow label="Propagate inotify" yamlKey="mountInotify" help="Experimental: propagate inotify file events into the VM.">
                    <Switch checked={full.mounts.mountInotify} onChange={(v) => mutate((d) => setIn(d, ["mountInotify"], v))} />
                  </FieldRow>
                  <div className="flex flex-col gap-2">
                    <span className="text-[12px] font-medium" style={{ color: "var(--text)" }}>
                      Mounts <code className="ml-1 rounded px-1 py-0.5 font-mono-app text-[10px]" style={{ background: "var(--surface-3)", color: "var(--text-faint)" }}>mounts</code>
                    </span>
                    {full.mounts.mounts.length === 0 && (
                      <div className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                        No custom mounts — colima mounts $HOME as writable by default.
                      </div>
                    )}
                    {full.mounts.mounts.map((row, i) => {
                      const rowIssue = issueForPrefix(`mounts[${i}]`);
                      return (
                        <div key={i} className="flex flex-col gap-1">
                          <div
                            className="flex items-center gap-2 rounded border p-2"
                            style={{ borderColor: rowIssue ? "var(--danger)" : "var(--border)" }}
                          >
                            <TextInput
                              className="flex-1 font-mono-app"
                              value={row.location}
                              placeholder="~/projects"
                              onChange={(e) => {
                                const rows = full.mounts.mounts.map((r, idx) => (idx === i ? { ...r, location: e.target.value } : r));
                                mutate((d) => setMounts(d, rows));
                              }}
                            />
                            <Button variant="ghost" size="sm" onClick={() => pickMountFolder(i, full.mounts.mounts)}>
                              Browse…
                            </Button>
                            <TextInput
                              className="flex-1 font-mono-app"
                              value={row.mountPoint}
                              placeholder="(mountPoint, optional)"
                              onChange={(e) => {
                                const rows = full.mounts.mounts.map((r, idx) => (idx === i ? { ...r, mountPoint: e.target.value } : r));
                                mutate((d) => setMounts(d, rows));
                              }}
                            />
                            <Switch
                              checked={row.writable}
                              onChange={(v) => {
                                const rows = full.mounts.mounts.map((r, idx) => (idx === i ? { ...r, writable: v } : r));
                                mutate((d) => setMounts(d, rows));
                              }}
                              label="writable"
                            />
                            <button
                              onClick={() => {
                                const rows = full.mounts.mounts.filter((_, idx) => idx !== i);
                                mutate((d) => setMounts(d, rows));
                              }}
                              aria-label="Remove mount"
                            >
                              <X size={14} style={{ color: "var(--text-faint)" }} />
                            </button>
                          </div>
                          {rowIssue && (
                            <span className="text-[11px]" style={{ color: "var(--danger)" }}>
                              {rowIssue.path}: {rowIssue.message}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="self-start"
                      onClick={() => {
                        const rows: MountRow[] = [...full.mounts.mounts, { location: "", mountPoint: "", writable: true }];
                        mutate((d) => setMounts(d, rows));
                      }}
                    >
                      Add mount
                    </Button>
                  </div>
                </div>
              )}

              {section === "ssh" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>SSH</SectionHeading>
                  <FieldRow label="Manage ~/.ssh/config" yamlKey="sshConfig" help="Automatically add an SSH config entry for the virtual machine.">
                    <Switch checked={full.ssh.sshConfig} onChange={(v) => mutate((d) => setIn(d, ["sshConfig"], v))} />
                  </FieldRow>
                  <FieldRow
                    label="SSH port"
                    yamlKey="sshPort"
                    help="0 picks a random available port."
                    invalid={issueForPath("sshPort")?.message}
                  >
                    <NumberStepper value={full.ssh.sshPort} min={0} onChange={(v) => mutate((d) => setIn(d, ["sshPort"], v))} />
                  </FieldRow>
                  <FieldRow label="Forward agent" yamlKey="forwardAgent" help="Forward the host's SSH agent to the virtual machine.">
                    <Switch checked={full.ssh.forwardAgent} onChange={(v) => mutate((d) => setIn(d, ["forwardAgent"], v))} />
                  </FieldRow>
                </div>
              )}

              {section === "environment" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Environment</SectionHeading>
                  <FieldRow
                    label="Environment variables"
                    yamlKey="env"
                    help="Environment variables set inside the virtual machine."
                    invalid={issueForPrefix("env")?.message}
                  >
                    <KeyValueEditor entries={full.env} onChange={(v) => mutate((d) => setStringMap(d, ["env"], v))} />
                  </FieldRow>
                </div>
              )}

              {section === "provision" && (
                <div className="flex flex-col gap-4">
                  <SectionHeading>Provision</SectionHeading>
                  <span className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                    Custom provisioning scripts, run on startup. Must be idempotent.
                  </span>
                  {full.provision.map((row: ProvisionRow, i: number) => {
                    const modeIssue = issueForPath(`provision[${i}].mode`);
                    const scriptIssue = issueForPath(`provision[${i}].script`);
                    const rowBorder = scriptIssue ? "var(--danger)" : modeIssue ? "var(--warn)" : "var(--border)";
                    return (
                    <div key={i} className="flex flex-col gap-2 rounded border p-3" style={{ borderColor: rowBorder }}>
                      <div className="flex items-center justify-between">
                        <Segmented
                          value={row.mode}
                          options={[
                            { value: "system", label: "system" },
                            { value: "user", label: "user" },
                            { value: "after-boot", label: "after-boot" },
                            { value: "ready", label: "ready" },
                          ]}
                          onChange={(v) => {
                            const rows = full.provision.map((r, idx) => (idx === i ? { ...r, mode: v } : r));
                            mutate((d) => setProvision(d, rows));
                          }}
                        />
                        <button
                          onClick={() => {
                            const rows = full.provision.filter((_, idx) => idx !== i);
                            mutate((d) => setProvision(d, rows));
                          }}
                          aria-label="Remove provision script"
                        >
                          <X size={14} style={{ color: "var(--text-faint)" }} />
                        </button>
                      </div>
                      {modeIssue && (
                        <span className="text-[11px]" style={{ color: "var(--warn)" }}>
                          {modeIssue.message}
                        </span>
                      )}
                      <TextArea
                        rows={5}
                        value={row.script}
                        onChange={(e) => {
                          const rows = full.provision.map((r, idx) => (idx === i ? { ...r, script: e.target.value } : r));
                          mutate((d) => setProvision(d, rows));
                        }}
                      />
                      {scriptIssue && (
                        <span className="text-[11px]" style={{ color: "var(--danger)" }}>
                          {scriptIssue.message}
                        </span>
                      )}
                    </div>
                    );
                  })}
                  <Button
                    variant="secondary"
                    size="sm"
                    className="self-start"
                    onClick={() => {
                      const rows: ProvisionRow[] = [...full.provision, { mode: "system", script: "" }];
                      mutate((d) => setProvision(d, rows));
                    }}
                  >
                    Add script
                  </Button>
                </div>
              )}

              {section === "yaml" && (
                <div className="flex flex-col gap-3">
                  <SectionHeading>Raw YAML</SectionHeading>
                  <span className="text-[11.5px]" style={{ color: "var(--text-faint)" }}>
                    Two-way synced with the form above. Parse errors block saving.
                  </span>
                  <YamlEditor value={yamlText} onChange={applyYamlText} />
                  {yamlError && (
                    <div className="text-[12px]" style={{ color: "var(--danger)" }}>
                      {yamlError}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        className="flex h-14 flex-shrink-0 items-center gap-2 border-t px-4"
        style={{ borderColor: "var(--border)", background: "var(--surface-1)" }}
      >
        <span className="text-[12px]" style={{ color: "var(--text-faint)" }}>
          {changeCount > 0 ? `${changeCount} change${changeCount === 1 ? "" : "s"}` : "No changes"}
        </span>
        {errorIssues.length > 0 && (
          <span className="text-[12px] font-medium" style={{ color: "var(--danger)" }}>
            {errorIssues.length} error{errorIssues.length === 1 ? "" : "s"}
          </span>
        )}
        {warningIssues.length > 0 && (
          <span className="text-[12px]" style={{ color: "var(--warn)" }}>
            {warningIssues.length} warning{warningIssues.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={handleResetToTemplate} disabled={busy || !source}>
            Reset to template
          </Button>
          <Button variant="secondary" onClick={() => handleSave(false)} disabled={busy || !canSave}>
            <Save size={13} /> Save
          </Button>
          <Button variant="primary" onClick={() => handleSave(true)} disabled={busy || !canSave}>
            {busy ? "Working…" : isRunning ? "Save & Restart" : "Save & Start"}
          </Button>
        </div>
      </div>

      {!isNew && doc && full && currentDiskGiB != null && (
        <RecreateDialog
          open={recreateOpen}
          profile={targetProfile}
          configContent={stringifyConfig(doc)}
          currentGiB={currentDiskGiB}
          newGiB={full.resources.disk}
          onClose={() => setRecreateOpen(false)}
          onDone={() => {
            onSaved(targetProfile);
            onClose();
          }}
        />
      )}
      {!isNew && (
        <ReclaimDialog
          open={reclaimOpen}
          profile={targetProfile}
          onClose={() => setReclaimOpen(false)}
          onOpenVolumes={
            onOpenVolumes
              ? (p) => {
                  onClose();
                  onOpenVolumes(p);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}

/** Monospace textarea with a simple line-number gutter for the raw YAML tab. */
function YamlEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const lineCount = value.split("\n").length;
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const syncScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  return (
    <div
      className="flex overflow-hidden rounded border"
      style={{ borderColor: "var(--border)", background: "var(--surface-2)", height: 420 }}
    >
      <div
        ref={gutterRef}
        className="select-none overflow-hidden px-2 py-2 text-right font-mono-app text-[12px] leading-[1.5]"
        style={{ color: "var(--text-faint)", background: "var(--surface-3)" }}
      >
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        className="flex-1 resize-none px-2 py-2 font-mono-app text-[12px] leading-[1.5] outline-none"
        style={{ background: "transparent", color: "var(--text)" }}
      />
    </div>
  );
}
