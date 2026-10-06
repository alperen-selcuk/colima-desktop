import { TerminalSplitButton } from "../components/TerminalSplitButton";
import { useShellName } from "../lib/useShellName";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Database, Eraser, HardDrive, MoreHorizontal, Plus, RotateCw, Settings, Square, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { Profile } from "../lib/types";
import { formatBytes } from "../lib/format";
import { StatusDot, statusTone } from "../components/StatusDot";
import { Button } from "../components/Button";
import { ReclaimDialog } from "../dialogs/ReclaimDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { SplitStartButton } from "../components/SplitStartButton";
import { useToast } from "../components/Toasts";
import { useDock } from "../lib/useDock";
import { DepsBanner } from "../components/DepsBanner";
import type { ActiveOp } from "../lib/opPhase";

interface MachinesPageProps {
  profiles: Profile[];
  busyProfiles: string[];
  ops?: Record<string, ActiveOp>;
  selected: string | null;
  onSelect: (name: string) => void;
  onStartProfile: (name: string) => void;
  onConfigureProfile: (name: string) => void;
  onQuickStartOptions: (name: string) => void;
  onNewMachine: () => void;
  onOpenVolumes: (name: string) => void;
  onOpenSetup: () => void;
}

function MachineCard({
  profile,
  busy,
  phase,
  selected,
  onSelect,
  onStart,
  onConfigure,
  onQuickStartOptions,
  onStop,
  onRestart,
  onDelete,
  onTerminal,
  onTerminalVm,
  shell,
  onReclaim,
}: {
  profile: Profile;
  busy: boolean;
  /** Human phase of the running op ("Starting Docker"), when known. */
  phase?: string;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onConfigure: () => void;
  onQuickStartOptions: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onTerminal: () => void;
  onTerminalVm: () => void;
  shell: string;
  onReclaim: () => void;
}) {
  const running = profile.status === "Running";
  const statusQuery = useQuery({
    queryKey: ["profileStatus", profile.name],
    queryFn: () => api.profileStatus(profile.name),
    refetchInterval: 3000,
  });

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const pillStyle = {
    background: busy ? "var(--warn-soft)" : running ? "var(--accent-soft)" : "var(--surface-3)",
    color: busy ? "var(--warn)" : running ? "var(--accent-strong)" : "var(--text-dim)",
  };
  const stat = (icon: React.ReactNode, label: string, value: string) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1 text-[10.5px]" style={{ color: "var(--text-faint)" }}>
        {icon} {label}
      </span>
      <span className="truncate text-[13px] font-medium" style={{ color: "var(--text)" }}>
        {value}
      </span>
    </div>
  );

  return (
    <div
      onClick={onSelect}
      className="flex min-w-0 cursor-pointer flex-col gap-4 rounded-lg border p-4 transition-colors"
      style={{
        background: "var(--surface-1)",
        borderColor: selected ? "var(--accent)" : "var(--border)",
        boxShadow: selected ? "0 0 0 1px var(--accent)" : "0 1px 2px var(--shadow-color)",
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={statusTone(profile.status)} pulse={running} />
          <span className="truncate text-[15px] font-semibold" style={{ color: "var(--text)" }}>
            {profile.name}
          </span>
        </div>
        <span className="pill" style={pillStyle}>
          {busy ? (phase ? `${phase}…` : running ? "Stopping…" : "Starting…") : profile.status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {stat(<Cpu size={11} />, "CPU", `${profile.cpus} cores`)}
        {stat(<Database size={11} />, "Memory", formatBytes(profile.memory))}
        {stat(<HardDrive size={11} />, "Disk", formatBytes(profile.disk))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="badge font-mono-app" title="Architecture">{profile.arch}</span>
        {profile.runtime && (
          <span className="badge font-mono-app" title="Container runtime">{profile.runtime}</span>
        )}
        {statusQuery.data?.kubernetes && (
          <span
            className="badge font-medium"
            style={{ background: "var(--info-soft)", color: "var(--info)", borderColor: "transparent" }}
            title="Kubernetes enabled"
          >
            k8s
          </span>
        )}
        {profile.address && (
          <span className="font-mono-app text-[11px]" style={{ color: "var(--text-faint)" }}>
            {profile.address}
          </span>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-2 border-t pt-3"
        style={{ borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {running ? (
          <Button variant="secondary" size="sm" onClick={onStop} disabled={busy}>
            <Square size={12} /> Stop
          </Button>
        ) : (
          <SplitStartButton
            onQuickStart={onStart}
            onConfigure={onConfigure}
            onQuickStartOptions={onQuickStartOptions}
            disabled={busy}
          />
        )}
        <Button variant="secondary" size="sm" onClick={onConfigure} disabled={busy} title="Configure machine">
          <Settings size={12} /> Configure
        </Button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onRestart} disabled={busy || !running} title="Restart machine">
            <RotateCw size={13} />
          </Button>
          <TerminalSplitButton
            shell={shell}
            profile={profile.name}
            vmEnabled={running}
            onLocal={onTerminal}
            onVm={onTerminalVm}
          />
          <div className="relative" ref={menuRef}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMenuOpen((v) => !v)}
              title="More actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <MoreHorizontal size={14} />
            </Button>
            {menuOpen && (
              <div className="menu absolute right-0 top-full z-30 mt-1" role="menu">
                <button
                  className="menu-item"
                  role="menuitem"
                  disabled={busy || !running}
                  onClick={() => {
                    setMenuOpen(false);
                    onReclaim();
                  }}
                >
                  <Eraser size={13} /> Reclaim space…
                </button>
                <div className="menu-sep" />
                <button
                  className="menu-item menu-item-danger"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={13} /> Delete machine…
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MachinesPage({
  profiles,
  busyProfiles,
  ops = {},
  selected,
  onSelect,
  onStartProfile,
  onConfigureProfile,
  onQuickStartOptions,
  onNewMachine,
  onOpenVolumes,
  onOpenSetup,
}: MachinesPageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dock = useDock();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [reclaimProfile, setReclaimProfile] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["profiles"] });
    queryClient.invalidateQueries({ queryKey: ["busyProfiles"] });
  };

  const handleRestart = async (name: string) => {
    try {
      await api.restartProfile(name);
    } catch (e) {
      toast.error(`Failed to restart ${name}`, String(e));
    }
  };

  const shell = useShellName();
  const handleTerminal = (name: string) => {
    dock.openTerminalTab({ kind: "host" }, name, shell);
  };
  const handleTerminalVm = (name: string) => {
    dock.openTerminalTab({ kind: "vm" }, name);
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await api.deleteProfile(confirmDelete);
      toast.success(`${confirmDelete} deleted`);
      invalidate();
    } catch (e) {
      toast.error(`Failed to delete ${confirmDelete}`, String(e));
    }
  };

  const handleStop = async () => {
    if (!confirmStop) return;
    try {
      await api.stopProfile(confirmStop, false);
      toast.success(`${confirmStop} stopped`);
    } catch (e) {
      toast.error(`Failed to stop ${confirmStop}`, String(e));
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="flex items-center justify-between px-5 py-4">
        <h1 className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
          Machines
        </h1>
        <Button variant="primary" size="sm" onClick={onNewMachine}>
          <Plus size={13} /> New machine
        </Button>
      </div>

      <DepsBanner onOpenSetup={onOpenSetup} />

      <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
        {profiles.map((p) => (
          <MachineCard
            key={p.name}
            profile={p}
            busy={busyProfiles.includes(p.name)}
            phase={ops[p.name]?.phase}
            selected={p.name === selected}
            onSelect={() => onSelect(p.name)}
            onStart={() => onStartProfile(p.name)}
            onConfigure={() => onConfigureProfile(p.name)}
            onQuickStartOptions={() => onQuickStartOptions(p.name)}
            onStop={() => setConfirmStop(p.name)}
            onRestart={() => handleRestart(p.name)}
            onDelete={() => setConfirmDelete(p.name)}
            onTerminal={() => handleTerminal(p.name)}
            onTerminalVm={() => handleTerminalVm(p.name)}
            shell={shell}
            onReclaim={() => setReclaimProfile(p.name)}
          />
        ))}
        {profiles.length === 0 && (
          <div
            className="col-span-full rounded-lg border border-dashed p-10 text-center text-[13px]"
            style={{ borderColor: "var(--border)", color: "var(--text-dim)" }}
          >
            No machines yet. Create one to get started.
          </div>
        )}
      </div>

      <ReclaimDialog
        open={!!reclaimProfile}
        profile={reclaimProfile ?? ""}
        onClose={() => setReclaimProfile(null)}
        onOpenVolumes={onOpenVolumes}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title={`Delete ${confirmDelete ?? ""}`}
        message={`This permanently deletes the "${confirmDelete ?? ""}" machine and all its containers, images and volumes.`}
        requireTypedText={confirmDelete ?? undefined}
        confirmLabel="Delete"
      />

      <ConfirmDialog
        open={!!confirmStop}
        onClose={() => setConfirmStop(null)}
        onConfirm={handleStop}
        title={`Stop ${confirmStop ?? ""}`}
        message={`This will stop the "${confirmStop ?? ""}" machine and all its containers.`}
        confirmLabel="Stop"
        danger={false}
      />
    </div>
  );
}
