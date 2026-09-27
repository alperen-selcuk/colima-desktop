import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Database, HardDrive, Plus, RotateCw, Square, TerminalSquare, Trash2 } from "lucide-react";
import * as api from "../lib/api";
import type { Profile } from "../lib/types";
import { formatBytes } from "../lib/format";
import { StatusDot, statusTone } from "../components/StatusDot";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toasts";
import { useDock } from "../lib/useDock";

interface MachinesPageProps {
  profiles: Profile[];
  busyProfiles: string[];
  selected: string | null;
  onSelect: (name: string) => void;
  onStartProfile: (name: string) => void;
  onNewMachine: () => void;
}

function MachineCard({
  profile,
  busy,
  selected,
  onSelect,
  onStart,
  onStop,
  onRestart,
  onDelete,
  onTerminal,
}: {
  profile: Profile;
  busy: boolean;
  selected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onDelete: () => void;
  onTerminal: () => void;
}) {
  const running = profile.status === "Running";
  const statusQuery = useQuery({
    queryKey: ["profileStatus", profile.name],
    queryFn: () => api.profileStatus(profile.name),
    refetchInterval: 3000,
  });

  return (
    <div
      onClick={onSelect}
      className="flex cursor-pointer flex-col gap-3 rounded-lg border p-4 transition-colors"
      style={{
        background: "var(--surface-1)",
        borderColor: selected ? "var(--accent)" : "var(--border)",
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <StatusDot tone={statusTone(profile.status)} pulse={running} />
          <span className="text-[14px] font-semibold" style={{ color: "var(--text)" }}>
            {profile.name}
          </span>
        </div>
        <span
          className="rounded px-1.5 py-0.5 text-[10.5px] font-medium"
          style={{
            background: busy ? "var(--warn-soft)" : running ? "var(--accent-soft)" : "var(--surface-3)",
            color: busy ? "var(--warn)" : running ? "var(--accent)" : "var(--text-faint)",
          }}
        >
          {busy ? (running ? "Stopping…" : "Starting…") : profile.status}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11.5px]" style={{ color: "var(--text-dim)" }}>
        <div className="flex items-center gap-1.5">
          <Cpu size={12} style={{ color: "var(--text-faint)" }} /> {profile.cpus} CPU
        </div>
        <div className="flex items-center gap-1.5">
          <Database size={12} style={{ color: "var(--text-faint)" }} /> {formatBytes(profile.memory)}
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive size={12} style={{ color: "var(--text-faint)" }} /> {formatBytes(profile.disk)}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: "var(--text-faint)" }}>
        <span
          className="rounded px-1.5 py-0.5 font-mono-app"
          style={{ background: "var(--surface-2)" }}
        >
          {profile.arch}
        </span>
        {profile.runtime && (
          <span className="rounded px-1.5 py-0.5 font-mono-app" style={{ background: "var(--surface-2)" }}>
            {profile.runtime}
          </span>
        )}
        {statusQuery.data?.kubernetes && (
          <span
            className="rounded px-1.5 py-0.5 font-medium"
            style={{ background: "var(--info-soft)", color: "var(--info)" }}
          >
            k8s
          </span>
        )}
        {profile.address && <span className="font-mono-app">{profile.address}</span>}
      </div>

      <div
        className="flex items-center gap-1.5 border-t pt-3"
        style={{ borderColor: "var(--border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {running ? (
          <Button variant="secondary" size="sm" onClick={onStop} disabled={busy}>
            <Square size={11} /> Stop
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={onStart} disabled={busy}>
            Start
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onRestart} disabled={busy || !running} title="Restart">
          <RotateCw size={11} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onTerminal} disabled={!running} title="Terminal">
          <TerminalSquare size={11} />
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} title="Delete" className="ml-auto">
          <Trash2 size={11} style={{ color: "var(--danger)" }} />
        </Button>
      </div>
    </div>
  );
}

export function MachinesPage({
  profiles,
  busyProfiles,
  selected,
  onSelect,
  onStartProfile,
  onNewMachine,
}: MachinesPageProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const dock = useDock();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["profiles"] });
    queryClient.invalidateQueries({ queryKey: ["busyProfiles"] });
  };

  const handleRestart = async (name: string) => {
    try {
      await api.restartProfile(name);
      toast.success(`${name} restarting`);
    } catch (e) {
      toast.error(`Failed to restart ${name}`, String(e));
    }
  };

  const handleTerminal = (name: string) => {
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

      <div className="grid grid-cols-1 gap-3 px-5 pb-5 sm:grid-cols-2 xl:grid-cols-3">
        {profiles.map((p) => (
          <MachineCard
            key={p.name}
            profile={p}
            busy={busyProfiles.includes(p.name)}
            selected={p.name === selected}
            onSelect={() => onSelect(p.name)}
            onStart={() => onStartProfile(p.name)}
            onStop={() => setConfirmStop(p.name)}
            onRestart={() => handleRestart(p.name)}
            onDelete={() => setConfirmDelete(p.name)}
            onTerminal={() => handleTerminal(p.name)}
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
