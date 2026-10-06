import { Loader2, TerminalSquare } from "lucide-react";
import type { ProfileStatus } from "../lib/types";
import { formatBytes } from "../lib/format";
import { opLabel, type ActiveOp } from "../lib/opPhase";

interface StatusBarProps {
  status: ProfileStatus | null | undefined;
  running: boolean;
  busy: boolean;
  /** Lifecycle operations in flight, one per profile (v0.2.3). */
  ops?: ActiveOp[];
  dockOpen: boolean;
  onToggleDock: () => void;
}

export function StatusBar({ status, running, busy, ops = [], dockOpen, onToggleDock }: StatusBarProps) {
  const text = !running
    ? "Engine stopped"
    : status
      ? `Engine running · ${status.runtime} · ${status.cpu} CPU · ${formatBytes(status.memory)} · k8s ${status.kubernetes ? "on" : "off"}`
      : "Engine running";

  return (
    <div
      className="flex h-7 flex-shrink-0 items-center gap-2 border-t px-4 text-[11.5px]"
      style={{ background: "var(--surface-1)", borderColor: "var(--border)", color: "var(--text-faint)" }}
    >
      {(busy || ops.length > 0) && <Loader2 size={11} className="spin" style={{ color: "var(--accent)" }} />}
      {ops.length > 0 ? (
        <span data-testid="status-activity" className="font-medium" style={{ color: "var(--accent)" }}>
          {ops.map(opLabel).join("  ·  ")}…
        </span>
      ) : (
        <span>{text}</span>
      )}
      {status?.ipAddress && (
        <span className="font-mono-app" style={{ color: "var(--text-faint)" }}>
          {status.ipAddress}
        </span>
      )}
      <button
        onClick={onToggleDock}
        title="Toggle terminal dock (Ctrl+`)"
        className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 -my-0.5"
        style={{ color: dockOpen ? "var(--accent)" : "var(--text-faint)" }}
      >
        <TerminalSquare size={12} /> Terminal
      </button>
    </div>
  );
}
